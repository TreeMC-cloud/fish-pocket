import Foundation
import UIKit
import os

/// 诊断上报：把引擎日志和 App 侧事件实时推到开发者自己的服务器。
///
/// 为什么要有：开发期真机上一出问题，用户（也就是开发者自己）只能打开
/// 「引擎日志」手动复制，或者用分享面板把文件发出去。崩溃/卡死的时候连这些都做不了。
/// 这个模块让 App 自己把日志送出去，服务器上随时能看。
///
/// 边界（重要）：
/// - **默认关闭**，地址为空就不启动，普通用户完全本地、零流量。
/// - 只有填了地址才会跑；开关和地址都在 UserDefaults 里，不经过引擎。
/// - 上报是 best-effort：断网/服务器挂掉只记一笔本地失败次数，**绝不阻塞 UI 或重试到发疯**。
///
/// 传输：HTTP PUT，一个请求一段增量。服务器侧只要把 body 追加到文件即可，
/// 不需要解析协议——出问题时越简单越好排查。请求头带元数据，能区分设备与批次。
@MainActor
@Observable
final class Diagnostics {
    static let shared = Diagnostics()

    private enum Keys {
        static let enabled = "diagnostics.enabled"
        static let endpoint = "diagnostics.endpoint"
        static let token = "diagnostics.token"
        static let cursor = "diagnostics.cursor"
        static let lastPush = "diagnostics.lastPush"
        static let lastError = "diagnostics.lastError"
        static let sentBatches = "diagnostics.sentBatches"
    }

    /// 上报走 UserDefaults 而不是引擎配置：引擎没起来的时候也要能上报，
    /// 而引擎配置要引擎活着才读得到。
    private let defaults = UserDefaults.standard

    var enabled: Bool {
        didSet {
            guard enabled != oldValue else { return }
            defaults.set(enabled, forKey: Keys.enabled)
            restart()
        }
    }
    var endpoint: String {
        didSet {
            guard endpoint != oldValue else { return }
            defaults.set(endpoint, forKey: Keys.endpoint)
            restart()
        }
    }
    /// 可选：服务器要求鉴权时填，作为 `Authorization: Bearer <token>` 发出。
    var token: String {
        didSet {
            guard token != oldValue else { return }
            defaults.set(token, forKey: Keys.token)
        }
    }

    private(set) var lastPushAt: Date?
    private(set) var lastError: String?
    private(set) var sentBatches: Int = 0
    /// 已经读到的日志字节偏移。App 重启后从这里接着读，不重复上报。
    private(set) var cursor: UInt64 = 0

    /// 一个后台循环就够了：读增量 → 发 → 睡。并发发送没有必要，
    /// 反而会让服务器上的行序错乱（追加写的顺序就是到达顺序）。
    private var loop: Task<Void, Never>?
    private let session: URLSession

    private init() {
        enabled = defaults.bool(forKey: Keys.enabled)
        endpoint = defaults.string(forKey: Keys.endpoint) ?? ""
        token = defaults.string(forKey: Keys.token) ?? ""
        cursor = UInt64(defaults.integer(forKey: Keys.cursor))
        sentBatches = defaults.integer(forKey: Keys.sentBatches)
        if let t = defaults.object(forKey: Keys.lastPush) as? Date { lastPushAt = t }
        let config = URLSessionConfiguration.background(withIdentifier: "cc.imsai.sigma.diagnostics")
        config.isDiscretionary = false
        config.sessionSendsLaunchEvents = true
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 120
        session = URLSession(configuration: config)
        // init 里不能直接 restart()（读 self 的存储属性还没完成），
        // 推到下一个 runloop：那时对象已经可用，且不会卡住启动。
        Task { @MainActor [weak self] in self?.restart() }
    }

    /// 配置变化就重开循环：地址换了要立刻用新地址，关了要立刻停。
    private func restart() {
        loop?.cancel()
        loop = nil
        guard enabled, let url = uploadURL else { return }
        _ = url
        loop = Task { [weak self] in
            // 启动后先等 3 秒：引擎启动日志是最值得看的一段，别和启动抢资源。
            try? await Task.sleep(for: .seconds(3))
            while !Task.isCancelled {
                await self?.pushOnce()
                try? await Task.sleep(for: .seconds(20))
            }
        }
    }

    private var uploadURL: URL? {
        let raw = endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty, let url = URL(string: raw), url.scheme != nil, url.host != nil else { return nil }
        return url
    }

    /// 日志文件位置和引擎用的是同一个（`EnginePaths`），但这里不依赖引擎活着。
    private var logFile: URL { EnginePaths.real(EnginePaths.shared + "/engine.log") }

    /// 读一段新日志并上报。没有新内容就不发请求——空 POST 只会污染服务器。
    func pushOnce() async {
        guard enabled, let url = uploadURL else { return }
        guard let chunk = readNewLog() else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue("text/plain; charset=utf-8", forHTTPHeaderField: "Content-Type")
        request.setValue(deviceId, forHTTPHeaderField: "X-Sigma-Device")
        request.setValue(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?",
                         forHTTPHeaderField: "X-Sigma-Version")
        request.setValue(String(cursor), forHTTPHeaderField: "X-Sigma-Offset")
        request.setValue(ISO8601DateFormatter().string(from: Date()), forHTTPHeaderField: "X-Sigma-At")
        if !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        request.httpBody = chunk

        do {
            let (_, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                throw NSError(domain: "Diagnostics", code: 1,
                              userInfo: [NSLocalizedDescriptionKey: "服务器返回 \(((response as? HTTPURLResponse)?.statusCode).map(String.init) ?? "?")"])
            }
            // 只有发成功才推进游标：否则下次启动会漏掉这段日志。
            defaults.set(Int(cursor), forKey: Keys.cursor)
            sentBatches += 1
            defaults.set(sentBatches, forKey: Keys.sentBatches)
            lastPushAt = Date()
            defaults.set(lastPushAt, forKey: Keys.lastPush)
            if lastError != nil { lastError = nil; defaults.removeObject(forKey: Keys.lastError) }
        } catch {
            lastError = error.localizedDescription
            defaults.set(lastError, forKey: Keys.lastError)
        }
    }

    /// 从游标读到文件尾，最多 256 KB（一次请求太大在弱网下容易断，
    /// 剩下的下一轮继续，反正 20 秒一次）。
    private func readNewLog() -> Data? {
        let path = logFile.path
        guard let handle = try? FileHandle(forReadingFrom: URL(fileURLWithPath: path)) else { return nil }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        // 文件被截断（重新装/日志轮转）：游标越界就从新的起点重新读。
        if size < cursor { cursor = 0 }
        guard size > cursor else { return nil }
        do { try handle.seek(toOffset: cursor) } catch { return nil }
        let limit = 256 * 1024
        let remaining = Int(min(UInt64(limit), size - cursor))
        guard let data = try? handle.read(upToCount: remaining), !data.isEmpty else { return nil }
        cursor += UInt64(data.count)
        return data
    }

    /// 设备标识：只用于在服务器上区分是哪台机器，不是广告标识，
    /// 取系统给 App 的 identifierForVendor，卸载重装会变——对开发期足够了。
    private var deviceId: String {
        UIDevice.current.identifierForVendor?.uuidString ?? "unknown"
    }

    /// 手动发一批（设置页的「立即上报」）：不必等 20 秒的循环。
    func pushNow() {
        Task { await pushOnce() }
    }

    /// 从头重发：换服务器或怀疑漏报时用。只改游标，不动已发送计数。
    func resetCursor() {
        cursor = 0
        defaults.set(0, forKey: Keys.cursor)
        lastError = nil
        defaults.removeObject(forKey: Keys.lastError)
    }
}
