import SwiftUI

/// A tool call row: icon and one line of what it did, 44 pt tall. Tap for the sheet with its
/// command, output and card, built from `tool/result.meta` (C-56…C-79); press for the copies.
struct ToolCallView: View {
    let call: ToolCall
    let live: Bool
    @Environment(\.fileLinkScope) private var scope
    @Environment(\.sessionModel) private var model
    @Environment(\.conversationActions) private var actions
    @Environment(\.openURL) private var openURL

    var body: some View {
        let row = ToolPresentation(call: call, live: live, cwd: scope?.root)
        let ask = call.displayName == "ask_user_question" ? AskStatus(call: call, model: model) : nil
        let state = ask?.state ?? row.state
        let outcome = row.outcome(state)
        HStack(spacing: 8) {
            Button {
                actions.present(.tool(call))
            } label: {
                WorkRowLabel(
                    systemImage: ToolStyle.icon(for: call.name),
                    text: line(row, ask: ask, outcome: outcome),
                    truncation: row.showsPath ? .middle : .tail,
                    tint: state == .error ? Palette.removed : state == .stopped ? Palette.waiting : Palette.secondary,
                    outcome: outcome,
                    busy: state == .preparing || state == .running
                )
            }
            .buttonStyle(.plain)
            .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: 12, style: .continuous))
            .contextMenu { menu(row) }
            if ask?.answerable == true {
                Button { actions.revealQuestion(call.id) } label: {
                    Text("回答")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Palette.ink)
                        .padding(.horizontal, 12)
                        .frame(minHeight: 30)
                        .overlay(Capsule().strokeBorder(Palette.stroke))
                        .hitTarget()
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func line(_ row: ToolPresentation, ask: AskStatus?, outcome: String?) -> String {
        guard let ask else { return outcome == nil ? row.line : row.subjectOrTitle }
        return outcome == nil ? "\(row.title) \(ask.summary)" : row.title
    }

    @ViewBuilder
    private func menu(_ row: ToolPresentation) -> some View {
        ForEach(row.copies) { copy in
            Button { copyToPasteboard(copy.text) } label: { Label(copy.title, systemImage: copy.systemImage) }
        }
        if let path = row.filePath, scope != nil, let url = LinkTarget.fileURL(path, line: call.arguments["offset"].int) {
            Button { openURL(url) } label: { Label("打开文件", systemImage: "doc.text.magnifyingglass") }
        }
    }
}

/// A line of the turn's work: icon, one line of words, how it ended, and the chevron of
/// something that opens. Tool calls and reasoning look the same.
struct WorkRowLabel: View {
    let systemImage: String
    let text: String
    var truncation: Text.TruncationMode = .tail
    var tint: Color = Palette.secondary
    var outcome: String?
    var busy = false

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: systemImage).frame(width: 20).foregroundStyle(tint)
            Text(text).foregroundStyle(Palette.secondary).lineLimit(1).truncationMode(truncation)
            Spacer(minLength: 0)
            if let outcome { Text(outcome).font(.footnote.weight(.medium)).foregroundStyle(tint).fixedSize() }
            if busy { ProgressView().controlSize(.mini) }
            Image(systemName: "chevron.right")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(Palette.faint)
        }
        .font(.subheadline)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }
}

enum ToolStyle {
    static func icon(for name: String) -> String {
        let tool = name.components(separatedBy: "__").last ?? name
        switch tool {
        case "bash", "pwsh", "terminal", "bash_output", "terminal_send", "terminal_open", "terminal_read", "terminal_list", "terminal_signal", "terminal_close": return "terminal"
        case "read", "read_file", "view": return "doc.text"
        case "read_image": return "photo"
        case "write", "write_file", "create": return "doc.badge.plus"
        case "edit", "str_replace", "str_replace_editor", "multi_edit", "apply_patch": return "pencil.line"
        case "glob", "ls", "list": return "folder"
        case "grep", "search": return "magnifyingglass"
        case "web_search", "search_web", "domain_search", "advanced_search": return "globe"
        case "web_fetch", "fetch": return "arrow.down.doc"
        case "todo_write", "todo", "todos": return "checklist"
        case "subagent", "subagent_fork", "task", "list_agents", "send_message", "interrupt_agent", "wait_agent": return "person.2"
        case "ask_user_question": return "questionmark.bubble"
        case "skill", "create_skill": return "sparkles"
        case "create_goal", "get_goal", "update_goal": return "flag"
        case "exit_plan_mode": return "list.bullet.clipboard"
        case "present", "present_files": return "shippingbox"
        case "schedule", "create_schedule", "schedule_create", "schedule_list", "schedule_delete", "schedule_update": return "clock"
        case "job_list", "job_output", "job_kill": return "gearshape.2"
        case "run_code", "workflow", "ralph": return "chevron.left.forwardslash.chevron.right"
        default: return name.hasPrefix("mcp__") ? "server.rack" : "wrench.and.screwdriver"
        }
    }

    /// The web's row titles; they stay the same while running and once done.
    private static let titles: [String: String] = [
        "bash": "运行命令", "pwsh": "运行命令", "read": "读取", "read_file": "读取", "read_image": "读取图片",
        "write": "写入", "write_file": "写入", "edit": "编辑", "str_replace": "编辑", "str_replace_editor": "编辑", "multi_edit": "编辑",
        "glob": "查找文件", "grep": "搜索文件内容", "web_search": "网页搜索", "web_fetch": "网页获取",
        "todo_write": "更新任务清单", "ask_user_question": "提问", "skill": "加载技能",
        "exit_plan_mode": "计划", "present": "交付文件", "run_code": "代码",
        "subagent": "创建子智能体", "list_subagent_models": "查看可用模型", "list_agents": "查看子智能体", "send_message": "发送消息",
        "interrupt_agent": "中断智能体", "wait_agent": "等待子智能体", "spawn_teammate": "创建队友",
        "team_task_create": "创建团队任务", "team_task_get": "读取团队任务", "team_task_update": "更新团队任务", "team_task_list": "查看团队任务",
        "job_list": "查看后台任务", "job_output": "读取任务输出", "job_kill": "取消后台任务",
        "create_goal": "创建目标", "get_goal": "查看目标", "update_goal": "更新目标",
        "schedule_create": "创建定时任务", "schedule_list": "查看定时任务", "schedule_delete": "删除定时任务", "schedule_update": "修改定时任务",
        "workflow": "运行工作流", "ralph": "运行循环工作流", "lsp": "查询代码符号",
        "session_event_read": "读取事件", "session_event_search": "搜索事件", "session_event_trace": "追踪事件",
        "session_search": "搜索会话", "session_trace": "追踪会话",
        "terminal_open": "创建终端", "terminal_read": "读取终端", "terminal_list": "查看终端", "terminal_signal": "发送终端信号", "terminal_close": "关闭终端",
    ]

    static func title(for call: ToolCall) -> String { titles[call.displayName] ?? String(localized: "工具调用") }
    static func hasOwnTitle(_ call: ToolCall) -> Bool { titles[call.displayName] != nil }
    /// For sentences: the title, or the tool's own name when it has none.
    static func name(of call: ToolCall) -> String { titles[call.displayName] ?? call.displayName }
}

extension View {
    /// A timeline detail: half the screen, pulled up for the rest.
    func detailSheet() -> some View {
        presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
            .presentationCornerRadius(36)
            .presentationBackground(Palette.background)
    }
}

/// One call in full, at the full width of the screen. Follows the call while it runs;
/// `call` is what the row knew, for a call the timeline no longer holds.
struct ToolDetailSheet: View {
    let call: ToolCall
    let model: SessionModel
    @Environment(\.fileLinkScope) private var scope
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let call = model.toolCall(call.id) ?? call
        let row = ToolPresentation(call: call, live: false, cwd: scope?.root)
        let ask = call.displayName == "ask_user_question" ? AskStatus(call: call, model: model) : nil
        NavigationStack {
            ScrollView {
                ToolDetail(call: call, row: row, ask: ask)
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .modifier(LinkOpening())
            }
            .background(Palette.background)
            .navigationTitle(ToolStyle.name(of: call))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { copyButton(row.copies) }
            }
            .closeButton(dismiss)
        }
        .detailSheet()
    }

    @ViewBuilder
    private func copyButton(_ copies: [ToolPresentation.Copy]) -> some View {
        if copies.count == 1, let only = copies.first {
            Button { copyToPasteboard(only.text) } label: { Image(systemName: "doc.on.doc") }
                .accessibilityLabel(only.title)
        } else if !copies.isEmpty {
            Menu {
                ForEach(copies) { copy in
                    Button { copyToPasteboard(copy.text) } label: { Label(copy.title, systemImage: copy.systemImage) }
                }
            } label: {
                Image(systemName: "doc.on.doc")
            }
            .accessibilityLabel("复制")
        }
    }
}

/// The body of the sheet: the card of its tool, or its arguments and result.
private struct ToolDetail: View {
    let call: ToolCall
    let row: ToolPresentation
    let ask: AskStatus?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if call.autoReviewDenied {
                // The call never ran: only why, not its arguments.
                Text("工具未执行。原因：\(call.autoReviewReason ?? String(localized: "Auto review 未授权此次操作"))")
                    .font(.footnote)
                    .foregroundStyle(Palette.removed)
            } else {
                card
            }
        }
    }

    @ViewBuilder
    private var card: some View {
        switch call.displayName {
        case "bash", "pwsh":
            TerminalCard(call: call, status: row.exit, state: row.state, cwd: row.cwd)
        case "read":
            if row.state == .ok, let read = ReadMeta(call.meta) { ReadCard(call: call, read: read) } else { generic }
        case "read_image":
            ReadImageCard(call: call)
            if row.state != .ok { generic }
        case "write", "write_file", "edit", "str_replace", "str_replace_editor", "multi_edit", "create":
            if let lines = row.diff, row.state != .error, row.state != .stopped {
                DiffCard(call: call, lines: lines)
            } else {
                generic
            }
        case "grep", "glob":
            if row.state == .ok, let search = SearchMeta(call.meta) { SearchCard(search: search, recovery: call.result ?? "") } else { generic }
        case "web_search":
            if row.state == .ok, !call.meta.isNull { WebSearchCard(meta: call.meta) } else { generic }
        case "web_fetch":
            if row.state == .ok, !call.meta.isNull { WebFetchCard(meta: call.meta) } else { generic }
        case "todo_write":
            if row.state == .error || row.state == .stopped { generic } else { TodoDiffCard(diff: TodoDiff(call: call)) }
        case "ask_user_question":
            if let ask { AskCard(call: call, status: ask) }
        case "skill":
            if let result = call.result, !result.isEmpty {
                OutputBlock(title: call.isError ? "错误" : "说明", text: result, tint: call.isError ? Palette.removed : nil)
            }
        default:
            generic
        }
    }

    @ViewBuilder
    private var generic: some View {
        if !row.argumentsText.isEmpty { OutputBlock(title: "参数", text: row.argumentsText) }
        if let result = call.result, !result.isEmpty {
            OutputBlock(title: call.isError ? "错误" : "结果", text: result, tint: call.isError ? Palette.removed : nil)
        }
    }
}

/// A titled block of output.
struct OutputBlock: View {
    let title: LocalizedStringKey
    let text: String
    var tint: Color?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.caption).foregroundStyle(tint ?? Palette.secondary)
            WrappedOutput(text: text, tint: tint)
        }
    }
}

/// Monospaced output on the page's full width: lines wrap instead of scrolling sideways
/// inside a sheet that scrolls down. A very long one opens on request.
struct WrappedOutput: View {
    let text: String
    var tint: Color?
    @State private var full = false
    private let cap = 200

    var body: some View {
        let lines = text.components(separatedBy: "\n")
        VStack(alignment: .leading, spacing: 4) {
            Text(full || lines.count <= cap ? text : lines.prefix(cap).joined(separator: "\n"))
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(tint ?? Palette.ink)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            if lines.count > cap {
                Button { full.toggle() } label: {
                    Text(full ? "收起" : "展开全部（\(lines.count) 行）").font(.caption).foregroundStyle(Palette.secondary).hitTarget()
                }
                .buttonStyle(.plain)
            }
        }
        .padding(12)
        .background(Palette.field, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

struct TodoRow: View {
    let item: TodoItem

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: item.status == "completed" ? "checkmark.circle.fill" : item.status == "in_progress" ? "circle.dotted.circle" : "circle")
                .foregroundStyle(item.status == "completed" ? Palette.running : item.status == "in_progress" ? Palette.ink : Palette.faint)
            Text(item.content)
                .strikethrough(item.status == "completed")
                .foregroundStyle(item.status == "completed" ? Palette.secondary : Palette.ink)
        }
        .font(.subheadline)
    }
}
