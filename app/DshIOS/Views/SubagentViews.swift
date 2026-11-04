import SwiftUI

/// The top-bar title of a child session (`SubagentHeaderLineage`): its label, and a
/// menu of the ancestors, the siblings and its own children. The parent's catalog is
/// the sibling list; a child with no parent left in the list shows its title alone.
struct SubagentSwitcher: View {
    let sessionId: String
    @Environment(AppModel.self) private var app

    var body: some View {
        let chain = app.lineage(of: sessionId)
        let ancestors = chain.dropLast()
        let siblings = ancestors.last.map { app.subagentEntries(of: $0) } ?? []
        let children = app.subagentEntries(of: sessionId)
        Menu {
            if !ancestors.isEmpty {
                Section("上级") {
                    ForEach(Array(ancestors), id: \.self) { id in
                        Button(app.lineageTitle(of: id)) { app.open(session: id) }
                    }
                }
            }
            if siblings.count > 1 || siblings.first?["id"].string != sessionId {
                Section("同级子智能体") { entries(siblings) }
            }
            if !children.isEmpty {
                Section("下级子智能体") { entries(children) }
            }
        } label: {
            HStack(spacing: 6) {
                Text(app.lineageTitle(of: sessionId)).font(.callout.weight(.semibold)).foregroundStyle(Palette.ink).lineLimit(1)
                Image(systemName: "chevron.up.chevron.down").font(.caption2.weight(.bold)).foregroundStyle(Palette.secondary)
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            .contentShape(Capsule())
        }
        .accessibilityLabel(Text("切换子智能体：\(app.lineageTitle(of: sessionId))"))
        .task {
            for id in ancestors { await app.refreshProjections(of: id) }
        }
    }

    @ViewBuilder
    private func entries(_ entries: [JSON]) -> some View {
        ForEach(entries.filter { $0["mode"].string != "external" }, id: \.self) { entry in
            let id = entry["id"].string ?? ""
            Button { if id != sessionId { app.open(session: id) } } label: {
                let label = entry["label"].string ?? id
                if id == sessionId { Label(label, systemImage: "checkmark") } else { Text(label) }
            }
        }
    }
}

/// 「N 个子智能体」: the children of a session. A row pushes that child's page, with
/// its usage and the next level; opening the child's session is there or a swipe away.
struct SubagentCatalogSheet: View {
    let rootId: String
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var loading = true
    @State private var failed = false

    var body: some View {
        let entries = app.subagentEntries(of: rootId)
        NavigationStack {
            List {
                ForEach(entries, id: \.self) { entry in
                    SubagentRow(entry: entry, open: open)
                }
                .groupedRow()
            }
            .groupedList()
            .overlay {
                if entries.isEmpty {
                    if loading {
                        Text("正在加载子智能体…").font(.subheadline).foregroundStyle(Palette.secondary)
                    } else if failed {
                        VStack(spacing: 10) {
                            Text("无法加载子智能体").font(.subheadline).foregroundStyle(Palette.secondary)
                            Button("重试") { Task { await load() } }.font(.subheadline.weight(.semibold))
                        }
                    }
                }
            }
            .navigationTitle(Text("\(entries.count) 个子智能体"))
            .navigationBarTitleDisplayMode(.inline)
            .closeButton(dismiss)
            .task { await load() }
        }
        .presentationDetents([.medium, .large])
    }

    private func open(_ id: String) {
        dismiss()
        app.open(session: id)
    }

    private func load() async {
        loading = true
        failed = !(await app.refreshProjections(of: rootId))
        loading = false
    }
}

/// What one catalog entry says about its child, for its row and its page.
@MainActor
private struct SubagentFacts {
    let entry: JSON
    let summary: SessionSummary?
    let values: JSON

    init(entry: JSON, app: AppModel) {
        self.entry = entry
        let id = entry["id"].string ?? ""
        summary = app.sessions[id]
        values = app.projectionCache[id] ?? summary?.projections ?? .null
    }

    var id: String { entry["id"].string ?? "" }
    var label: String { entry["label"].string ?? id }
    var title: String? { summary?.title.flatMap { $0.isEmpty ? nil : $0 } }
    var external: Bool { entry["mode"].string == "external" }
    var migration: Bool { summary?.migrationRequired == true }
    var running: Bool { summary?.running == true }
    var completed: Bool { !external && !running && values["subagentTiming"]["lastTurnCompleted"].bool == true }

    var mode: String {
        switch entry["mode"].string {
        case "external": String(localized: "外部任务")
        case "one-shot": String(localized: "一次性")
        case "continuable": String(localized: "可继续")
        default: String(localized: "模式未知")
        }
    }

    /// The state in a word: 需要迁移 / 外部任务 or what the child is doing.
    var state: String {
        if migration { return String(localized: "需要迁移") }
        if external { return mode }
        return running ? String(localized: "正在运行") : completed ? String(localized: "已完成") : String(localized: "当前未运行")
    }

    var tokens: Int? {
        let usage = values["tokenUsage"]
        guard usage["outputTokens"].int != nil else { return nil }
        return ["uncachedInputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"].reduce(0) { $0 + (usage[$1].int ?? 0) }
    }

    var timed: Bool { values["subagentTiming"]["settledMs"].double != nil }

    func duration(now: Date) -> Double? {
        let timing = values["subagentTiming"]
        guard let settled = timing["settledMs"].double else { return nil }
        guard let since = timing["active"]["since"].double else { return settled }
        let end = running ? now.timeIntervalSince1970 * 1000 : timing["active"]["through"].double ?? since
        return settled + max(0, end - since)
    }

    static func formatTokens(_ value: Int) -> String {
        func scaled(_ next: Double) -> String {
            next >= 100 ? String(Int(next.rounded())) : String((next * 10).rounded() / 10).replacingOccurrences(of: ".0", with: "")
        }
        if value < 1_000 { return String(value) }
        if value < 1_000_000 { return scaled(Double(value) / 1_000) + "K" }
        return scaled(Double(value) / 1_000_000) + "M"
    }

    /// Decreasing precision at larger scales (`formatDuration`).
    static func formatDuration(_ ms: Double) -> String {
        let total = Int(max(0, ms) / 1000)
        let seconds = total % 60, minutes = (total / 60) % 60, totalMinutes = total / 60
        let totalHours = totalMinutes / 60, hours = totalHours % 24, days = totalHours / 24
        if days >= 365 {
            let years = days / 365, months = (days % 365) / 30
            return months == 0 ? String(localized: "约\(years)年") : String(localized: "约\(years)年\(months)个月")
        }
        if days >= 30 {
            let months = days / 30, rest = days % 30
            return rest == 0 ? String(localized: "约\(months)个月") : String(localized: "约\(months)个月\(rest)天")
        }
        if days > 0 { return hours == 0 ? String(localized: "\(days)天") : String(localized: "\(days)天\(hours)小时") }
        if totalHours > 0 { return String(localized: "\(totalHours)小时\(String(format: "%02d", minutes))分\(String(format: "%02d", seconds))秒") }
        if totalMinutes > 0 { return String(localized: "\(totalMinutes)分\(String(format: "%02d", seconds))秒") }
        return String(localized: "\(seconds)秒")
    }
}

private struct SubagentRow: View {
    let entry: JSON
    let open: (String) -> Void
    @Environment(AppModel.self) private var app

    var body: some View {
        let facts = SubagentFacts(entry: entry, app: app)
        NavigationLink {
            SubagentDetail(entry: entry, open: open)
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Group {
                    if facts.running { StatusDot(state: .running) }
                    else { Circle().fill(facts.completed ? Palette.ink : Palette.faint).frame(width: 7, height: 7) }
                }
                .frame(width: 14)
                VStack(alignment: .leading, spacing: 2) {
                    Text(facts.label).font(.subheadline).foregroundStyle(Palette.ink).lineLimit(1)
                    Text([facts.title, facts.state].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(Palette.secondary).lineLimit(2)
                }
            }
        }
        .swipeActions {
            if !facts.external {
                Button { open(facts.id) } label: { Label("打开会话", systemImage: "bubble.left") }
                    .tint(Palette.ink)
            }
        }
        .contextMenu {
            if !facts.external {
                Button { open(facts.id) } label: { Label("打开会话", systemImage: "bubble.left") }
            }
        }
    }
}

/// One child: its state and usage, 打开会话 under the thumb, and its own children.
private struct SubagentDetail: View {
    let entry: JSON
    let open: (String) -> Void
    @Environment(AppModel.self) private var app

    var body: some View {
        let facts = SubagentFacts(entry: entry, app: app)
        let children = app.subagentEntries(of: facts.id)
        List {
            Section {
                if let title = facts.title { Text(title).font(.callout) }
                LabeledContent("状态", value: facts.state)
                if !facts.external { LabeledContent("模式", value: facts.mode) }
                if let tokens = facts.tokens { LabeledContent("Tokens", value: SubagentFacts.formatTokens(tokens)) }
                if facts.timed {
                    // It ticks while the child runs.
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        LabeledContent("活跃时长", value: facts.duration(now: context.date).map(SubagentFacts.formatDuration) ?? "")
                    }
                }
            }
            .groupedRow()
            if !children.isEmpty {
                Section("下级子智能体") {
                    ForEach(children, id: \.self) { child in SubagentRow(entry: child, open: open) }
                }
                .groupedRow()
            }
        }
        .groupedList()
        .navigationTitle(facts.label)
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            if !facts.external {
                Button("打开会话") { open(facts.id) }
                    .buttonStyle(.capsule())
                    .padding(EdgeInsets(top: 8, leading: 20, bottom: 12, trailing: 20))
            }
        }
        .task { await app.refreshProjections(of: facts.id) }
    }
}

/// In place of the composer when a child cannot take messages (`SubagentReadOnlyComposer`).
struct SubagentReadOnlyNotice: View {
    let title: LocalizedStringKey
    let detail: LocalizedStringKey

    var body: some View {
        VStack(spacing: 4) {
            Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.secondary)
            Text(detail).font(.footnote).foregroundStyle(Palette.secondary).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, minHeight: 54)
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Palette.field, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

extension SessionModel {
    /// Why this child is read-only, if it is (`selectReadOnlySubagent`); nil for a root
    /// session and for a continuable child whose parent can carry a message.
    @MainActor
    func subagentReadOnly(parentAvailable: Bool) -> (title: LocalizedStringKey, detail: LocalizedStringKey)? {
        guard let address = subagentAddress else { return nil }
        switch subagentMode ?? address["mode"].string {
        case "one-shot":
            return ("一次性子智能体记录", "一次性任务不支持后续消息，可在这里查看完整执行记录。")
        case "continuable":
            return !parentAvailable && !running ? ("此子智能体暂时只读", "父会话当前不在线，重新打开父会话后即可继续发送消息。") : nil
        default:
            return ("此子智能体暂时只读", "读取子会话后才能确定是否可继续。")
        }
    }
}
