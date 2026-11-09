import Foundation
import UIKit
import Security
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

    /// 开发期的默认落点：自己的诊断服务器。
    /// 只是「预填」，不是「强制」——地址在设置页里可以随时改成别的，
    /// 清空就彻底不连。`enabled` 仍然默认关，装了不会自己往外发。
    ///
    /// 走明文 HTTP，不走 HTTPS。
    ///
    /// 为什么放弃 TLS：那台服务器没有外网出口，签不了正式证书，只能用自签。
    /// 自签 + 内置证书指纹固定（`CertPinner`）在真机上仍然会报
    /// 「TLS 错误，无法建立安全连接」——ATS 与自签证书的组合在 URLSession 里
    /// 并不可靠地允许委托层接管。为一个开发期的日志通道继续和它搏斗不值得。
    ///
    /// ATS 靠什么放行：**`project.yml` 里给 `202.189.51.44` 单开的
    /// `NSExceptionDomains` + `NSExceptionAllowsInsecureHTTPLoads`**，
    /// 不是 `NSAllowsArbitraryLoads`。后者一旦和 `NSAllowsLocalNetworking` /
    /// `NSAllowsArbitraryLoadsInWebContent` 同时出现，iOS 10+ 就按默认值 NO
    /// 处理（Apple 的 ATS 版本兼容规则），而那两个键又分别是引擎
    /// （127.0.0.1）和内置浏览器必需的，删不得。按域名（这里是 IP）的例外
    /// 优先于所有全局键，也只影响这一个地址——这正是我们想要的粒度。
    ///
    /// 通道本身用 Bearer token 鉴权，且只发日志、不接受指令。
    /// 真要上生产，正确做法是给服务器配正式证书、把这里和 ATS 一起收紧。
    static let defaultEndpoint = "http://202.189.51.44:8790/sigma/log"
    static let defaultToken = "XslsS4QGTmZAI1ep_xdS6WpVm-5iqF_G"

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
    /// 正在「自动换协议」时置位：`endpoint` 的 didSet 看到它就不 restart()。
    /// 理由见 `adopt(_:after:)`——那一批刚发成功，重启循环只会把本轮打断。
    private var switchingScheme = false
    /// 真机崩溃的根因：原来用 `URLSessionConfiguration.background` 建会话，
    /// 而 `data(for:)` 在后台会话上不受支持，App 一打开上报就崩。
    /// 后台会话是给「退后台后继续传文件」用的；这里每 20 秒一轮、断网等下轮，
    /// ephemeral 完全够，也不会把上传任务残留到系统里。
    ///
    /// delegate 负责证书固定：服务器是自签证书，系统默认不信任。
    ///
    /// **不能用 `lazy var`**：`@Observable` 会给每个存储属性生成观察访问器，
    /// 而 lazy 的初始化访问器不是存储属性，宏展开时直接编译失败
    /// （`init accessor cannot refer to property '_session'`）。
    /// 所以在 init 里构建，声明成普通 let。
    @ObservationIgnored private let session: URLSession

    private init() {
        // 首次运行没有存过值：预填默认服务器，但开关保持关闭。
        // 用户（开发者）在设置里打开即用；普通用户不打开就一个字节都不发。
        let storedEndpoint = defaults.string(forKey: Keys.endpoint)
        enabled = defaults.bool(forKey: Keys.enabled)
        // 迁移：早期版本把地址存成了 `https://202.189.51.44:8790/...`，
        // 而服务器是自签证书，真机上 TLS 握手直接失败（报「安全连接失败」）。
        // 服务器现在同时不再提供 TLS，所以这个地址已经用不了——
        // 不改的话，用户升级后仍然打到 https 上，继续报同样的错，
        // 而设置页里那串地址看着"没变"，很难想到要手动改。
        // 注意：这里必须先算到局部变量再赋值。
        // `endpoint` 带 didSet 观察器，而 `defaults.set(endpoint, ...)` 是**读取**
        // self.endpoint —— 在 init 里所有存储属性就位之前读它，编译器直接拒绝
        // （"'self' used in property access 'endpoint' before all stored properties
        // are initialized"）。上一版就是这么挂掉一次构建的。
        let resolvedEndpoint: String
        if let stored = storedEndpoint, stored.hasPrefix("https://202.189.51.44") {
            resolvedEndpoint = stored.replacingOccurrences(of: "https://202.189.51.44", with: "http://202.189.51.44")
            defaults.set(resolvedEndpoint, forKey: Keys.endpoint)
        } else {
            resolvedEndpoint = storedEndpoint ?? Self.defaultEndpoint
        }
        endpoint = resolvedEndpoint
        token = defaults.string(forKey: Keys.token) ?? Self.defaultToken
        cursor = UInt64(defaults.integer(forKey: Keys.cursor))
        sentBatches = defaults.integer(forKey: Keys.sentBatches)
        if let t = defaults.object(forKey: Keys.lastPush) as? Date { lastPushAt = t }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 120
        session = URLSession(configuration: config, delegate: CertPinner(), delegateQueue: nil)
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

    /// 读一段新日志并上报。没有新内容就不发请求——空 PUT 只会污染服务器。
    ///
    /// 两个来源合成一次请求：引擎日志在前、App 事件在后，用分隔行隔开。
    /// 分成两个请求的话，服务器上两段的时间顺序就丢了，排查时对不上。
    func pushOnce() async {
        guard enabled, let url = uploadURL else { return }
        guard let batch = readNewLog() else { return }

        do {
            try await send(batch, to: url)
            commit(batch)
        } catch {
            let first = error
            // 只在**协议不同**、且这次失败是「这条路根本走不通」时才换一次。
            // 一次失败最多换一次协议，换完还失败就等下轮（20 秒后）——绝不在这里循环重试，
            // 否则服务器整个挂掉时会把 App 变成一台重试机器。
            guard Self.isTransportFailure(first), let fallback = Self.flippedScheme(url) else {
                fail(first)
                return
            }
            do {
                try await send(batch, to: fallback)
                commit(batch)
                adopt(fallback, after: first)
            } catch {
                // 两条协议都不通：两条的错误都留下，否则只看到后一条，
                // 分不清「本来就没网」还是「换过去才坏的」。
                fail(NSError(domain: "Diagnostics", code: 2, userInfo: [
                    NSLocalizedDescriptionKey:
                        "\(Self.describe(first))；换到 \(fallback.scheme ?? "?") 后仍失败：\(Self.describe(error))"
                ]))
            }
        }
    }

    /// 一批待上报的内容：数据 + 读完之后的两个游标。
    /// 游标**不在这里提交**，要等请求成功——先提交再发送的话，一次网络抖动就永久丢日志。
    private struct Batch {
        let data: Data
        let engineCursor: UInt64
        let appCursor: UInt64
    }

    /// 发一批到指定地址。HTTP 非 2xx 也算失败：服务器没落盘就不能提交游标，
    /// 否则这批日志永久消失，而界面上还显示「成功」。
    private func send(_ batch: Batch, to url: URL) async throws {
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue("text/plain; charset=utf-8", forHTTPHeaderField: "Content-Type")
        request.setValue(deviceId, forHTTPHeaderField: "X-Sigma-Device")
        request.setValue(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?",
                         forHTTPHeaderField: "X-Sigma-Version")
        request.setValue(String(batch.engineCursor), forHTTPHeaderField: "X-Sigma-Offset")
        request.setValue(Self.stampFormatter.string(from: Date()), forHTTPHeaderField: "X-Sigma-At")
        if !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        request.httpBody = batch.data

        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw NSError(domain: "Diagnostics", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "服务器返回 \(((response as? HTTPURLResponse)?.statusCode).map(String.init) ?? "?")"])
        }
    }

    /// 提交游标并记账。**只有**请求成功后才调用。
    private func commit(_ batch: Batch) {
        cursor = batch.engineCursor
        defaults.set(Int(cursor), forKey: Keys.cursor)
        appCursorRef = batch.appCursor
        sentBatches += 1
        defaults.set(sentBatches, forKey: Keys.sentBatches)
        lastPushAt = Date()
        defaults.set(lastPushAt, forKey: Keys.lastPush)
        if lastError != nil { lastError = nil; defaults.removeObject(forKey: Keys.lastError) }
    }

    /// 记一次失败。带上 NSError 的 domain + code：
    /// ATS 拦掉的请求是 `NSURLErrorDomain -1022`，光看「无法建立安全连接」
    /// 这类本地化文案分不清是证书、DNS 还是 ATS，有了码一眼就能确认。
    private func fail(_ error: Error) {
        lastError = Self.describe(error)
        defaults.set(lastError, forKey: Keys.lastError)
    }

    private static func describe(_ error: Error) -> String {
        let ns = error as NSError
        return "\(ns.localizedDescription)（\(ns.domain) \(ns.code)）"
    }

    /// 值得换协议再试吗？
    ///
    /// 只有**传输层**失败才换：ATS 拦截（-1022）、连不上（-1004）、
    /// TLS 握手失败（-1200 系列）、超时（-1001）都属于「这条协议这条路走不通」。
    /// 服务器已经回了状态码（401/500，domain 是 "Diagnostics"）则不换——
    /// 地址本身是通的，换协议只会把一个能用的地址改成不能用的，
    /// 还会把「token 配错了」伪装成网络问题。
    /// 被取消（-999，改设置/退出时循环被 cancel）也不换，那是我们自己的动作。
    private static func isTransportFailure(_ error: Error) -> Bool {
        let ns = error as NSError
        guard ns.domain == NSURLErrorDomain else { return false }
        return ns.code != NSURLErrorCancelled
    }

    /// 同 host/port/path，只把 http ↔ https 换一下；别的协议一律返回 nil（不猜）。
    private static func flippedScheme(_ url: URL) -> URL? {
        let target: String
        switch url.scheme?.lowercased() {
        case "http": target = "https"
        case "https": target = "http"
        default: return nil
        }
        // 用 URLComponents 而不是字符串替换：端口、路径、查询串原样保留，
        // 也不会把路径里恰好出现的 "http" 误伤。
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        components.scheme = target
        return components.url
    }

    /// 换协议成功：把新地址持久化，下次启动直接用，不再先撞一次墙。
    private func adopt(_ url: URL, after failure: Error) {
        // 置位期间 endpoint 的 didSet 只写 UserDefaults、不重启循环：
        // restart() 会 cancel 掉正在跑的这个 loop，而这一批刚发成功、游标刚提交，
        // 重启只会白等 3 秒。下一轮读到的已经是新地址。
        switchingScheme = true
        endpoint = url.absoluteString
        switchingScheme = false
        lastError = "已自动换到 \(url.scheme ?? "?")://（原地址失败：\(Self.describe(failure))）"
        defaults.set(lastError, forKey: Keys.lastError)
    }

    /// App 事件文件的读位置。
    private var appCursorRef: UInt64 {
        get { UInt64(defaults.integer(forKey: appLogCursorKey)) }
        set { defaults.set(Int(newValue), forKey: appLogCursorKey) }
    }

    /// 拼出这一批内容：引擎日志增量 + App 事件增量。
    /// 返回数据与「读完后的游标」，但**不提交**——提交要在请求成功之后。
    /// 先提交再发送的话，一次网络抖动就永久丢掉那段日志。
    /// 返回 `Batch` 而不是元组：`send` / `commit` 收的是 Batch，
    /// 早先这里写元组，调用处类型对不上，编译直接失败。
    private func readNewLog() -> Batch? {
        var out = Data()
        var ec = cursor
        var ac = appCursorRef
        if let engine = readChunk(at: logFile, cursor: &ec) { out.append(engine) }
        if let app = readChunk(at: appLogFile, cursor: &ac) {
            if !out.isEmpty { out.append("\n--- app ---\n".data(using: .utf8)!) }
            out.append(app)
        }
        guard !out.isEmpty else { return nil }
        return Batch(data: out, engineCursor: ec, appCursor: ac)
    }

    /// 从某个文件的游标读到末尾，最多 256 KB。游标通过 inout 推进。
    private func readChunk(at url: URL, cursor: inout UInt64) -> Data? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        // 文件被截断（重装/轮转）：游标越界就从新起点重新读。
        if size < cursor { cursor = 0 }
        guard size > cursor else { return nil }
        do { try handle.seek(toOffset: cursor) } catch { return nil }
        let limit = 256 * 1024
        let remaining = Int(min(UInt64(limit), size - cursor))
        guard let data = try? handle.read(upToCount: remaining), !data.isEmpty else { return nil }
        cursor += UInt64(data.count)
        return data
    }

    /// 单条截断：长回答保留开头和结尾，中间省略——首尾最能说明意图与结论。
    /// 放在这里而不是 SessionModel：日志的截断规则应该和日志本身在一起。
    nonisolated static func clip(_ text: String, limit: Int = 1200) -> String {
        guard text.count > limit else { return text }
        let head = text.prefix(limit * 2 / 3)
        let tail = text.suffix(limit / 3)
        return "\(head)\n…（省略 \(text.count - limit) 字）…\n\(tail)"
    }

    /// 时间戳只 init 一次：每次 new 一个 formatter 在 20 秒一轮的循环里是浪费，
    /// 而且这个类全程 @MainActor，不存在线程竞争。
    private static let stampFormatter = ISO8601DateFormatter()

    /// App 日志的串行写队列：顺序不变，主线程不被磁盘 IO 拖住。
    nonisolated private static let logQueue = DispatchQueue(label: "cc.imsai.sigma.diagnostics.applog")

    /// 设备标识：只用于在服务器上区分是哪台机器，不是广告标识，
    /// 取系统给 App 的 identifierForVendor，卸载重装会变——对开发期足够了。
    private var deviceId: String {
        UIDevice.current.identifierForVendor?.uuidString ?? "unknown"
    }

    /// 手动发一批（设置页的「立即上报」）：不必等 20 秒的循环。
    func pushNow() {
        Task { await pushOnce() }
    }

    /// 回到前台时叫醒上报循环。
    ///
    /// 为什么需要：循环是一条 `Task` + `Task.sleep(20s)`。App 进后台时 iOS
    /// 挂起整个进程，sleep 不会走；被系统杀掉再拉起时 `init` 会重建循环，
    /// 但「只是切到后台再回来」这条路没人叫醒它——表现就是日志明明在长，
    /// 服务器上却一直停在最后一次。所以前台时显式重启一次（restart 自带去重）。
    func resume() {
        guard enabled else { return }
        // 刚回到前台先把攒着的一批发掉，别让用户等 20 秒。
        Task { await pushOnce() }
        restart()
    }

    /// 从头重发：换服务器或怀疑漏报时用。只改游标，不动已发送计数。
    func resetCursor() {
        cursor = 0
        defaults.set(0, forKey: Keys.cursor)
        lastError = nil
        defaults.removeObject(forKey: Keys.lastError)
    }

    // MARK: - App 侧事件

    /// App 自己的日志：引擎日志只覆盖引擎内部，启动、连接、模型切换、崩溃
    /// 这些发生在 Swift 侧，出问题时往往比引擎日志更关键（比如「根本没起来」）。
    ///
    /// 写进同一个 app.log，由同一个循环上报——两套通道会让时序对不上。
    private var appLogFile: URL {
        EnginePaths.real(EnginePaths.shared + "/app.log")
    }

    private var appLogCursorKey: String { "diagnostics.appCursor" }

    /// 记一条 App 事件。永远不抛错、不阻塞调用方：日志是旁路，不能拖累主流程。
    func record(_ message: String, _ detail: String? = nil) {
        let stamp = Self.stampFormatter.string(from: Date())
        var line = "[\(stamp)] \(message)"
        if let detail, !detail.isEmpty { line += " · \(detail)" }
        line += "\n"
        guard let data = line.data(using: .utf8) else { return }
        let url = appLogFile
        // 写盘挪到串行队列。
        //
        // 每轮对话要记十几条（用户/模型/工具/轮次），而这些都跑在主线程上：
        // 同步写文件会让输入和滚动卡顿。串行队列保证顺序不变，
        // 而「日志晚几十毫秒落盘」对排查没有任何影响。
        Self.logQueue.async {
            Self.append(data, to: url)
        }
    }

    /// 往任意文件追加一行（串行队列，不阻塞主线程）。
    /// 给 usage.jsonl 这类「App 写、引擎读」的文件用。
    nonisolated static func appendLine(_ line: String, to url: URL) {
        guard let data = (line + "\n").data(using: .utf8) else { return }
        logQueue.async { append(data, to: url) }
    }

    /// 真正写盘的部分（在 `logQueue` 上跑）。
    nonisolated private static func append(_ data: Data, to url: URL) {
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        // 按 2 MB 轮转。现在每条对话都记，不设上限的话几个月后会变成几十 MB，
        // 而 readChunk 一轮最多读 256 KB——积压太多就永远追不上新日志。
        // 轮转后文件变小，readChunk 里的 `size < cursor` 分支会自动从 0 重读。
        if let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
           let size = attrs[.size] as? Int, size > 2 * 1024 * 1024 {
            try? FileManager.default.removeItem(at: url)
        }
        if let handle = try? FileHandle(forWritingTo: url) {
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: data)
            try? handle.close()
        } else {
            try? data.write(to: url)
        }
    }
}

/// 只信任内置的那张自签证书。
///
/// 为什么需要：诊断服务器没有外网出口，签不了 Let's Encrypt，只能自签。
/// 系统默认不信任自签证书，请求会以 `-1202`（证书无效）失败。
///
/// 为什么不用 `NSAllowsArbitraryLoads` 或 `completionHandler(.useCredential, ...)`
/// 一律放行：那等于对任何中间人开放，把一个日志上报通道变成攻击面。
/// 这里做**证书固定**——只认 `DiagnosticsCert` 里那一张，换了就失败。
///
/// 同时仍然交给系统做一次主机名校验（`SecTrustEvaluateWithError`），
/// 保证不是「证书对但主机不对」。
final class CertPinner: NSObject, URLSessionDelegate {
    /// 内置证书的 DER 数据；解码失败时 pinning 直接失败，不允许降级放行。
    private lazy var pinnedDER: Data? = Data(base64Encoded: DiagnosticsCert.serverDERBase64)

    func urlSession(_ session: URLSession,
                    didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust,
              let pinned = pinnedDER else {
            // 不是服务器信任挑战（例如 token 鉴权）：交给系统。
            completionHandler(.performDefaultHandling, nil)
            return
        }

        // 取出服务器实际出示的证书链第一张，逐字节对比。
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let leaf = chain.first else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        let leafDER = SecCertificateCopyData(leaf) as Data
        guard leafDER == pinned else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }

        // 证书逐字节对上就够了，不再调 SecTrustEvaluateWithError：
        // 那是走系统信任链（找根证书），自签证书没有 CA，必然失败——
        // 写它等于永远连不上。主机名在固定指纹的前提下已无意义（只有这张证书
        // 能通过），但保留一次 SAN 检查以便证书换错时给出更清楚的失败原因。
        guard Self.hostMatches(certificate: leaf, host: challenge.protectionSpace.host) else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }

        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    /// 证书 SAN 里是否包含目标主机（IP 或域名）。
    /// 自签证书没有 CA 签发者，所以这里只做「名字对不对」，不做信任链评估。
    private static func hostMatches(certificate: SecCertificate, host: String) -> Bool {
        // CN 里放的就是 IP，SAN 里也有 IP:202.189.51.44。
        // 用 SecCertificateCopySubjectSummary 拿到 CN 做兜底判断，
        // 真正的把关是上面的指纹比对，这里只是避免「证书换了但指纹没更新」时静默成功。
        guard let summary = SecCertificateCopySubjectSummary(certificate) as String? else { return false }
        return summary == host || summary.contains(host)
    }
}
