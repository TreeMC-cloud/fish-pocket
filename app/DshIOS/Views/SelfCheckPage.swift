import SwiftUI

/// 引擎自检：一条命令查「各闭环是否真的接上了」。
///
/// 为什么要在 App 里做：这些检查读的是**文件是否存在**，而引擎在后台写的
/// 就是这些文件。如果引擎没起来、或者 auto-guard 的 turn/end 钩子没触发，
/// 文件就不会出现——而这正是「能力地图永远是空的」的直接原因。
///
/// 为什么不用引擎里的 selfcheck.mjs：那个要 Node 进程活着才能跑。而最需要
/// 自检的时刻恰恰是「引擎可能没起来」。App 侧直接读文件，引擎挂了也能查。
struct SelfCheckPage: View {
    @State private var result: SelfCheckResult?
    @State private var running = false
    /// 引擎启动后自己跑的那一轮端到端自测（selftest.json）。
    @State private var selftest: SelfTestResult?

    var body: some View {
        Form {
            Section {
                if running {
                    HStack(spacing: 10) {
                        ProgressView().controlSize(.small)
                        Text("正在检查…").foregroundStyle(Palette.secondary)
                    }
                } else if let result {
                    ForEach(result.items) { item in
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: item.ok ? "checkmark.circle.fill" : "xmark.circle.fill")
                                .foregroundStyle(item.ok ? Palette.running : Palette.removed)
                                .font(.caption)
                                .padding(.top, 2)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.title).foregroundStyle(Palette.ink)
                                Text(item.detail)
                                    .font(.caption)
                                    .foregroundStyle(Palette.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                } else {
                    Text("点下面的按钮开始检查")
                        .foregroundStyle(Palette.secondary)
                }
            } header: {
                if let result {
                    Text(result.headline)
                } else {
                    Text("检查项")
                }
            } footer: {
                Text("检查的是引擎有没有真的把数据写出来。任务表、能力快照、经验记录这些文件不存在，说明对应的功能在真机上没有执行过——不是「还没用」，是「没生效」。")
            }
            .groupedRow()

            Section {
                if let selftest {
                    ForEach(selftest.items) { item in
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: item.ok ? "checkmark.circle.fill" : "xmark.circle.fill")
                                .foregroundStyle(item.ok ? Palette.running : Palette.removed)
                                .font(.caption)
                                .padding(.top, 2)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.title).foregroundStyle(Palette.ink)
                                Text(item.detail)
                                    .font(.caption)
                                    .foregroundStyle(Palette.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                } else {
                    Text("引擎还没跑完自测（启动后约 12 秒）")
                        .foregroundStyle(Palette.secondary)
                }
            } header: {
                if let selftest {
                    Text("链路自测 \(selftest.passed)/\(selftest.total)")
                } else {
                    Text("链路自测")
                }
            } footer: {
                Text("上面那组查「引擎这轮有没有真的干活」；这一组查「模块之间的接线通不通」——在临时目录里真跑一遍任务、候选技能、身份更新和通知准入，不碰你的数据。")
            }
            .groupedRow()

            Section {
                Button("开始检查") { run() }
                    .disabled(running)
            } footer: {
                if let result, result.failed > 0 {
                    Text("\(result.failed) 项未就绪。先看这些项对应的引擎逻辑是不是根本没被调用。")
                } else if let result {
                    Text("全部就绪。")
                }
            }
            .groupedRow()
        }
        .groupedList()
        .navigationTitle("引擎自检")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            if result == nil { run() }
            loadSelfTest()
        }
    }

    /// 读引擎写下的自测结果。没有文件就是还没跑（启动后约 12 秒才会写）。
    private func loadSelfTest() {
        let url = EnginePaths.real(EnginePaths.shared + "/selftest.json")
        guard let data = try? Data(contentsOf: url),
              let parsed = SelfTestResult(json: data) else { return }
        selftest = parsed
    }

    private func run() {
        running = true
        // 文件读取很快，但仍放到主线程之外：目录不存在时 FileManager 可能慢。
        Task {
            let checked = SelfCheck.run()
            await MainActor.run {
                result = checked
                running = false
            }
        }
    }
}

// MARK: - 检查逻辑

struct SelfCheckResult {
    struct Item: Identifiable {
        let id: String
        let title: String
        let detail: String
        let ok: Bool
    }
    let items: [Item]
    var passed: Int { items.filter(\.ok).count }
    var failed: Int { items.count - passed }
    var headline: String {
        failed == 0 ? "全部就绪（\(passed)/\(items.count)）" : "\(failed) 项未就绪（\(passed)/\(items.count)）"
    }
}

/// 引擎自测的结果（`selftest.json`）。
struct SelfTestResult {
    struct Item: Identifiable {
        let id: String
        let title: String
        let detail: String
        let ok: Bool
    }
    var items: [Item] = []
    var passed: Int = 0
    var total: Int = 0

    init?(json: Data) {
        guard let obj = try? JSONSerialization.jsonObject(with: json) as? [String: Any],
              let rows = obj["items"] as? [[String: Any]] else { return nil }
        items = rows.compactMap { row in
            guard let id = row["id"] as? String else { return nil }
            return Item(
                id: id,
                title: row["title"] as? String ?? id,
                detail: row["detail"] as? String ?? "",
                ok: row["ok"] as? Bool ?? false
            )
        }
        passed = obj["passed"] as? Int ?? items.filter(\.ok).count
        total = obj["total"] as? Int ?? items.count
    }
}

enum SelfCheck {
    /// 引擎写数据的目录（与 `EnginePaths.shared` 一致）。
    static var dataDir: URL { EnginePaths.real(EnginePaths.shared) }

    static func run() -> SelfCheckResult {
        var items: [SelfCheckResult.Item] = []
        let fm = FileManager.default

        // 1. 任务表：一轮对话一个任务，由 auto-guard 在 turn/end 写。
        items.append(checkFile(
            id: "tasks", title: "任务表", file: "tasks.json",
            missing: "不存在，说明 turn/end 钩子没触发过",
            validate: { data in
                guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let tasks = obj["tasks"] as? [String: Any] else { return "文件在，但读不出任务表结构" }
                return tasks.isEmpty ? "文件在，但一个任务都没有" : "\(tasks.count) 个任务"
            }
        ))

        // 2. 能力快照：App 每 3 秒读它，面板的数据源。
        items.append(checkFile(
            id: "capability", title: "能力快照", file: "capability.json",
            missing: "不存在，能力地图没有数据源",
            validate: { data in
                guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    return "文件在，但读不出 JSON"
                }
                let at = (obj["generatedAt"] as? Double ?? 0) / 1000
                let age = Date().timeIntervalSince1970 - at
                if at == 0 { return "文件在，但没有生成时间" }
                if age > 600 { return String(format: "陈旧：已 %.0f 分钟未更新", age / 60) }
                return String(format: "%.0f 秒前刚更新", age)
            }
        ))

        // 3. 定时任务观察：auto-guard 的调度循环写的。
        items.append(checkFile(
            id: "schedule", title: "定时任务", file: "schedule-view.json",
            missing: "不存在，调度循环没读到过定时任务",
            validate: { data in
                guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    return "文件在，但读不出 JSON"
                }
                let total = obj["total"] as? Int ?? 0
                return "\(total) 个定时任务"
            }
        ))

        // 4. 经验记录：每轮一条，进化闭环的原料。
        items.append(checkFile(
            id: "trace", title: "经验记录", file: ".trace.jsonl",
            missing: "不存在，一次经验都没记过",
            allowEmpty: true,
            validate: { data in
                let text = String(data: data, encoding: .utf8) ?? ""
                let n = text.split(separator: "\n").filter { !$0.isEmpty }.count
                return n == 0 ? "还没记录（刚开始用也算正常）" : "\(n) 条"
            }
        ))

        // 5. 轮次账本：成本守卫读它。
        items.append(checkFile(
            id: "turns", title: "轮次账本", file: ".turns.jsonl",
            missing: "不存在，轮次一次都没记过",
            allowEmpty: true,
            validate: { data in
                let text = String(data: data, encoding: .utf8) ?? ""
                let n = text.split(separator: "\n").filter { !$0.isEmpty }.count
                return n == 0 ? "还没记录（刚开始用也算正常）" : "\(n) 轮"
            }
        ))

        // 6. 记忆层提示词：打包时被剪枝删空过，是真实踩过的坑。
        items.append(checkMemoryPrompts())

        // 7. 数据目录可写。
        items.append(checkWritable())

        _ = fm
        return SelfCheckResult(items: items)
    }

    private static func checkFile(
        id: String, title: String, file: String, missing: String,
        allowEmpty: Bool = false,
        validate: (Data) -> String
    ) -> SelfCheckResult.Item {
        let url = dataDir.appendingPathComponent(file)
        guard FileManager.default.fileExists(atPath: url.path) else {
            return .init(id: id, title: title, detail: missing, ok: false)
        }
        guard let data = try? Data(contentsOf: url) else {
            return .init(id: id, title: title, detail: "文件在，但读不出来", ok: false)
        }
        if data.isEmpty && !allowEmpty {
            return .init(id: id, title: title, detail: "文件在，但是空的", ok: false)
        }
        return .init(id: id, title: title, detail: validate(data), ok: true)
    }

    /// 记忆层提示词。这个文件曾经因为打包脚本把 `*.md` 当文档删掉而整层未激活，
    /// 表现是「记忆功能配了但会话里没有 memory_* 工具」，只有启动日志里一行 ENOENT。
    private static func checkMemoryPrompts() -> SelfCheckResult.Item {
        // 提示词在 App 包的 nodejs-project 里，不在数据目录。
        let bundle = Bundle.main.bundleURL
            .appendingPathComponent("nodejs-project/node_modules/meow-memory/lib/prompts/zh/tools.md")
        let alt = EnginePaths.real("/opt/dsh/nodejs-project/node_modules/meow-memory/lib/prompts/zh/tools.md")
        for url in [alt, bundle] {
            if let data = try? Data(contentsOf: url), !data.isEmpty {
                return .init(id: "prompts", title: "记忆提示词",
                             detail: "就位（\(data.count) 字节）", ok: true)
            }
        }
        return .init(id: "prompts", title: "记忆提示词",
                     detail: "找不到 lib/prompts/zh/tools.md，记忆层不会激活", ok: false)
    }

    private static func checkWritable() -> SelfCheckResult.Item {
        let probe = dataDir.appendingPathComponent(".selfcheck-\(UUID().uuidString.prefix(8))")
        do {
            try FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)
            try Data("ok".utf8).write(to: probe)
            try? FileManager.default.removeItem(at: probe)
            return .init(id: "writable", title: "数据目录", detail: "可写", ok: true)
        } catch {
            try? FileManager.default.removeItem(at: probe)
            return .init(id: "writable", title: "数据目录",
                         detail: "不可写：\(error.localizedDescription)", ok: false)
        }
    }
}
