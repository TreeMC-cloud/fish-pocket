import SwiftUI

/// 任务队列详情页。
///
/// 为什么需要：引擎现在把每一轮对话都记成一条任务（`tasks.json`），
/// 而 App 只在能力地图里显示一个总数和「等你确认」的短列表。
/// 用户看不到完整队列——有多少在跑、多少在排队、哪些失败过、失败原因是什么。
/// 一个「看不见的队列」等于没有队列：出问题时只能猜。
///
/// 数据来源是引擎写的文件，不是 RPC：引擎没起来时也要能看，
/// 而且这几条路径（重排/取消）本来就设计成走文件控制面（`task-control`）。
struct TaskListPage: View {
    @Environment(AppModel.self) private var app
    @State private var composing = false
    @State private var draft = ""
    @State private var snapshot: TaskSnapshot?
    @State private var loading = false

    var body: some View {
        Form {
            if loading && snapshot == nil {
                Section {
                    HStack(spacing: 10) {
                        ProgressView().controlSize(.small)
                        Text("正在读取任务表…").foregroundStyle(Palette.secondary)
                    }
                }
                .groupedRow()
            } else if let snapshot, !snapshot.tasks.isEmpty {
                if snapshot.attention.isEmpty && snapshot.running.isEmpty && snapshot.queued.isEmpty {
                    Section {
                        emptyRow(String(localized: "没有待处理的任务"))
                    } header: {
                        Text("待处理")
                    }
                    .groupedRow()
                }
                if !snapshot.attention.isEmpty {
                    Section {
                        ForEach(snapshot.attention) { row($0, actionable: true) }
                    } header: {
                        Text("等你确认（\(snapshot.attention.count)）")
                    } footer: {
                        Text("这些任务失败了。失败不自动重跑是有意的——有副作用的操作重来可能更糟。确认没问题再点重排。")
                    }
                    .groupedRow()
                }
                if !snapshot.running.isEmpty {
                    Section {
                        ForEach(snapshot.running) { row($0, actionable: false) }
                    } header: {
                        Text("正在跑（\(snapshot.running.count)）")
                    }
                    .groupedRow()
                }
                if !snapshot.queued.isEmpty {
                    Section {
                        ForEach(snapshot.queued) { row($0, actionable: false) }
                    } header: {
                        Text("排队中（\(snapshot.queued.count)）")
                    }
                    .groupedRow()
                }
                if !snapshot.done.isEmpty {
                    Section {
                        ForEach(snapshot.done.prefix(20)) { row($0, actionable: false) }
                    } header: {
                        Text("已完成（最近 20 条）")
                    } footer: {
                        Text("超过 24 小时的已完成任务会被自动清理，避免任务表无限增长拖慢重排。")
                    }
                    .groupedRow()
                }
            } else {
                Section {
                    emptyRow(String(localized: "还没有任务记录"))
                } footer: {
                    Text("任务表由引擎在每轮对话结束时写入。这里为空说明引擎还没记录过任何一轮——不是「一切正常」。")
                }
                .groupedRow()
            }
        }
        .groupedList()
        .navigationTitle("任务")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { draft = ""; composing = true } label: {
                    Image(systemName: "plus.circle")
                }
                .accessibilityLabel("投递新任务")
            }
        }
        .sheet(isPresented: $composing) { composeSheet }
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { if snapshot == nil { await load() } }
    }

    // MARK: - 行

    /// 投递新任务的表单。
    ///
    /// 引擎早就有 enqueue（建任务 → 排队 → 投进会话），但 App 里没有入口——
    /// 能力在，用户点不到。这个表单把它接出来。
    private var composeSheet: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("让它做什么（写清目标与边界）", text: $draft, axis: .vertical)
                        .lineLimit(3...8)
                } header: {
                    Text("任务内容")
                } footer: {
                    Text("引擎会把它排进队列，App 活着时约 15 秒内投进当前会话。写清「要什么结果」，而不是「去看看吧」。")
                }
                .groupedRow()
            }
            .groupedList()
            .navigationTitle("投递任务")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { composing = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("投递") {
                        guard let session = app.currentSession,
                              app.enqueueTask(text: draft, sessionId: session) else {
                            app.showToast(String(localized: "没有可投递的会话，先打开一个对话"), duration: 5)
                            return
                        }
                        Haptics.tap()
                        composing = false
                        app.showToast(String(localized: "已投递，约 15 秒内开始"), duration: 4)
                    }
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private func row(_ task: TaskSnapshot.Row, actionable: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Circle().fill(tint(task.status)).frame(width: 6, height: 6)
                Text(task.title.isEmpty ? String(localized: "（未命名任务）") : task.title)
                    .foregroundStyle(Palette.ink)
                    .lineLimit(2)
                Spacer(minLength: 8)
                Text(relative(task.updatedAt))
                    .font(.caption2)
                    .foregroundStyle(Palette.faint)
            }
            HStack(spacing: 8) {
                Text(statusText(task))
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(tint(task.status))
                if let err = task.lastError, !err.isEmpty {
                    Text(err)
                        .font(.caption2)
                        .foregroundStyle(Palette.removed)
                        .lineLimit(2)
                }
            }
            if actionable {
                HStack(spacing: 10) {
                    Button("重排") {
                        Haptics.tap()
                        app.controlTask("requeue", taskId: task.id)
                        // 控制面是文件式的：引擎每 15 秒扫一次，所以这里不立刻刷新，
                        // 稍等一下再读，让用户能马上看到状态变了。
                        Task { try? await Task.sleep(nanoseconds: 1_500_000_000); await load() }
                    }
                    Button("取消", role: .destructive) {
                        Haptics.tap()
                        app.controlTask("cancel", taskId: task.id)
                        Task { try? await Task.sleep(nanoseconds: 1_500_000_000); await load() }
                    }
                }
                .font(.caption.weight(.medium))
                .buttonStyle(.bordered)
                .controlSize(.mini)
            }
        }
        .padding(.vertical, 2)
    }

    private func emptyRow(_ text: String) -> some View {
        HStack {
            Text(text).foregroundStyle(Palette.secondary)
            Spacer()
        }
    }

    // MARK: - 读取

    private func load() async {
        loading = true
        let loaded = await Task.detached(priority: .userInitiated) { TaskSnapshot.load() }.value
        snapshot = loaded
        loading = false
    }

    /// 投递型任务的状态要说得更准：
    /// 「已投递」只是发出去了；知道后续结果时补上成败，不知道就老实说不知道。
    private func statusText(_ task: TaskSnapshot.Row) -> String {
        guard task.deliveredOnly, task.status == "succeeded" else { return label(task.status) }
        guard let outcome = task.turnOutcome else { return String(localized: "已投递 · 结果未知") }
        switch outcome {
        case "completed": return String(localized: "已投递 · 完成")
        case "error", "failed": return String(localized: "已投递 · 失败")
        case "aborted", "interrupted": return String(localized: "已投递 · 中断")
        case "max-tokens": return String(localized: "已投递 · 到输出上限")
        default: return String(localized: "已投递 · \(outcome)")
        }
    }

    private func label(_ status: String) -> String {
        switch status {
        case "needs_reconciliation": return String(localized: "待确认")
        case "running": return String(localized: "运行中")
        case "queued": return String(localized: "排队中")
        case "received": return String(localized: "已接收")
        case "awaiting_approval": return String(localized: "等授权")
        case "succeeded": return String(localized: "已完成（已投递）")
        case "failed": return String(localized: "失败")
        case "interrupted": return String(localized: "中断")
        case "cancelled": return String(localized: "已取消")
        default: return status
        }
    }

    private func tint(_ status: String) -> Color {
        switch status {
        case "running", "queued", "received": return Palette.running
        case "awaiting_approval": return Palette.waiting
        case "needs_reconciliation", "failed": return Palette.removed
        case "interrupted": return Palette.waiting
        default: return Palette.faint
        }
    }

    private func relative(_ ms: Double) -> String {
        guard ms > 0 else { return "" }
        let date = Date(timeIntervalSince1970: ms / 1000)
        let seconds = Date().timeIntervalSince(date)
        if seconds < 60 { return String(localized: "刚刚") }
        if seconds < 3600 { return String(localized: "\(Int(seconds / 60)) 分钟前") }
        if seconds < 86_400 { return String(localized: "\(Int(seconds / 3600)) 小时前") }
        return String(localized: "\(Int(seconds / 86_400)) 天前")
    }
}

// MARK: - 数据

/// `tasks.json` 的读取结果。
///
/// 用 `JSONSerialization` 而不是 `Codable`：任务记录里有 `history` 等数组字段，
/// 逐字段建模要几十行，而我们只用到六个字段。这里宁可少写代码也不要
/// 「模型比用途大」——模型大了，引擎加字段时这里就要跟着改，而它并不需要。
struct TaskSnapshot {
    struct Row: Identifiable {
        let id: String
        let title: String
        let status: String
        let updatedAt: Double
        let lastError: String?
        /// 只是「消息投进去了」，真正的成败在那一轮对话里。
        /// 不区分的话，一轮失败之后表里仍写着「已完成」，账本就不可信了。
        let deliveredOnly: Bool
        /// 投递之后那一轮的真实结果（`completed` / `error` / `aborted`…）。
        /// nil 表示「还没跑完」或「不是投递型任务」——不猜。
        let turnOutcome: String?
    }

    let tasks: [Row]
    var attention: [Row] { tasks.filter { $0.status == "needs_reconciliation" || $0.status == "failed" || $0.status == "awaiting_approval" } }
    var running: [Row] { tasks.filter { $0.status == "running" } }
    var queued: [Row] { tasks.filter { $0.status == "queued" || $0.status == "received" } }
    var done: [Row] {
        tasks.filter { ["succeeded", "cancelled", "ignored", "interrupted"].contains($0.status) }
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    static func load() -> TaskSnapshot {
        let url = EnginePaths.real(EnginePaths.shared).appendingPathComponent("tasks.json")
        guard let data = try? Data(contentsOf: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let raw = obj["tasks"] as? [String: [String: Any]] else {
            return TaskSnapshot(tasks: [])
        }
        let rows: [Row] = raw.values.compactMap { dict in
            guard let id = dict["taskId"] as? String else { return nil }
            return Row(
                id: id,
                title: (dict["title"] as? String) ?? "",
                status: (dict["status"] as? String) ?? "unknown",
                updatedAt: (dict["updatedAt"] as? Double) ?? (dict["createdAt"] as? Double) ?? 0,
                lastError: dict["lastError"] as? String,
                deliveredOnly: (dict["deliveredOnly"] as? Bool) ?? false,
                turnOutcome: dict["turnOutcome"] as? String
            )
        }
        // 新的排前面：用户关心的是「刚才发生了什么」，不是最早的记录。
        return TaskSnapshot(tasks: rows.sorted { $0.updatedAt > $1.updatedAt })
    }
}
