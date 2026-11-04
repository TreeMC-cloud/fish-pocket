import SwiftUI

/// A finished reply's actions: a long press anywhere on the turn, no row of icons under every
/// reply. The preview is the start of the reply, not a snapshot of a turn taller than the screen.
struct TurnMenu: ViewModifier {
    let enabled: Bool
    let turn: Int?
    let info: TurnInfo?
    let fallbackText: String
    var regeneratePrompt: String?
    @Environment(\.conversationActions) private var actions

    private var closing: String { info?.closingText.isEmpty == false ? info?.closingText ?? "" : fallbackText }
    private var usage: TurnUsage? { info?.usageBroken == true ? nil : info?.usage }

    func body(content: Content) -> some View {
        if enabled {
            content.contextMenu { items } preview: { preview }
        } else {
            content
        }
    }

    @ViewBuilder
    private var items: some View {
        if !closing.isEmpty {
            Button { copyToPasteboard(closing) } label: { Label("复制", systemImage: "doc.on.doc") }
            Button { actions.present(.text(closing)) } label: { Label("选择文本", systemImage: "selection.pin.in.out") }
        }
        if let regeneratePrompt {
            Button { actions.regenerate(regeneratePrompt) } label: { Label("重新生成", systemImage: "arrow.clockwise") }
        }
        if let turn {
            Button { actions.fork(turn) } label: { Label("从这里分叉", systemImage: "arrow.triangle.branch") }
        }
        if let usage {
            Section(info?.closingTime.map { TimelineFormat.clock($0) } ?? "") {
                Button { actions.present(.usage(usage)) } label: {
                    Label("用量 \(TimelineFormat.compact(usage.total))", systemImage: "chart.bar")
                }
            }
        }
    }

    private var preview: some View {
        Group {
            if closing.isEmpty {
                Text("这一轮没有文字回复").font(.callout).foregroundStyle(Palette.secondary)
            } else {
                MarkdownView(text: String(closing.prefix(500)), selectable: false)
            }
        }
        .padding(16)
        .frame(width: 340, alignment: .topLeading)
        .frame(maxHeight: 420, alignment: .topLeading)
        .clipped()
        .background(Palette.background)
    }
}

/// Text to pick from: a real text view, as SwiftUI's selection only takes a `Text` whole.
struct SelectTextSheet: View {
    let text: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            SelectableTextView(text: text)
                .background(Palette.background)
                .navigationTitle("选择文本")
                .navigationBarTitleDisplayMode(.inline)
                .closeButton(dismiss)
        }
        .detailSheet()
    }
}

private struct SelectableTextView: UIViewRepresentable {
    let text: String

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.backgroundColor = .clear
        view.font = .preferredFont(forTextStyle: .body)
        view.adjustsFontForContentSizeCategory = true
        view.textColor = UIColor(Palette.ink)
        view.textContainerInset = UIEdgeInsets(top: 16, left: 12, bottom: 16, right: 12)
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        if view.text != text { view.text = text }
    }
}

/// 「本轮用量」 (C-41).
struct TurnUsageSheet: View {
    let usage: TurnUsage

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("本轮用量").font(.title3.weight(.semibold)).accessibilityAddTraits(.isHeader)
            Text("\(TimelineFormat.exact(usage.total)) tok").font(.title2.monospacedDigit())
            VStack(spacing: 8) {
                if !usage.routes.isEmpty { row("提供方 / 模型", usage.routes.joined(separator: ", ")) }
                if let hit = cacheHit { row("缓存命中", hit) }
                row("未缓存输入", count(usage.uncachedInput))
                if let read = usage.cacheRead { row("缓存读取", count(read)) }
                if let write = usage.cacheWrite { row("缓存写入", count(write)) }
                row("输出", count(usage.output) + (usage.reasoning.map { "（其中推理 \(TimelineFormat.exact($0))）" } ?? ""))
            }
        }
        .padding(EdgeInsets(top: 28, leading: 22, bottom: 22, trailing: 22))
        .frame(maxWidth: .infinity, alignment: .leading)
        .fittedSheet()
    }

    private func count(_ value: Int) -> String { "\(TimelineFormat.exact(value)) tok" }

    private func row(_ label: LocalizedStringKey, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).foregroundStyle(Palette.secondary)
            Spacer(minLength: 12)
            Text(value).multilineTextAlignment(.trailing).monospacedDigit()
        }
        .font(.subheadline)
    }

    /// One decimal; a partial hit never reads as 100 %.
    private var cacheHit: String? {
        guard let read = usage.cacheRead, usage.total > usage.output else { return nil }
        let share = Double(read) / Double(usage.total - usage.output) * 100
        let rounded = (share * 10).rounded() / 10
        let shown = rounded >= 100 && read < usage.total - usage.output ? 99.9 : rounded
        return String(format: "%.1f%%", shown)
    }
}

/// The plan an `exit_plan_mode` call submitted, at the end of its turn (C-130).
struct PlanCard: View {
    let title: String
    let plan: String
    @State private var open = false

    /// Title from the plan's `# H1`; a plan without one has no card.
    static func title(of plan: String) -> String? {
        plan.trimmingCharacters(in: .whitespacesAndNewlines).firstMatch(of: #/^#\s+(\S[^\r\n]*)/#).map { String($0.output.1) }
    }

    var body: some View {
        Button { open = true } label: {
            HStack(spacing: 12) {
                Image(systemName: "list.bullet.clipboard").font(.body).foregroundStyle(Palette.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.subheadline.weight(.medium)).foregroundStyle(Palette.ink).lineLimit(1)
                    Text("计划 · Markdown").font(.caption).foregroundStyle(Palette.secondary)
                }
                Spacer(minLength: 8)
                Text("打开").font(.subheadline).foregroundStyle(Palette.ink)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Palette.stroke))
            .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text("打开计划：\(title)"))
        .sheet(isPresented: $open) { PlanSheet(markdown: plan) }
    }
}

/// Files the agent presented (C-127). Tapping opens the preview, whose toolbar has QuickLook
/// and sharing: the Host's "open with default app" would need a process the phone cannot start.
struct DeliverableCards: View {
    let files: [Deliverable]
    @Environment(\.fileLinkScope) private var scope
    @State private var showAll = false
    @State private var preview: Deliverable?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(showAll ? files : Array(files.prefix(4)), id: \.path) { file in
                Button { preview = file } label: { row(file) }
                    .buttonStyle(.plain)
                    .disabled(scope == nil)
            }
            if files.count > 4 {
                Button(showAll ? "收起" : "全部 \(files.count) 个文件") { showAll.toggle() }
                    .font(.footnote)
            }
        }
        .sheet(item: $preview) { file in
            if let scope { FilePreviewSheet(sessionId: scope.sessionId, path: file.path, root: scope.root, lines: nil) }
        }
    }

    private func row(_ file: Deliverable) -> some View {
        let name = URL(fileURLWithPath: file.path).lastPathComponent
        return HStack(spacing: 12) {
            Image(systemName: "doc.richtext").font(.body).foregroundStyle(Palette.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(name).font(.subheadline.weight(.medium)).foregroundStyle(Palette.ink).lineLimit(1).truncationMode(.middle)
                Text(Self.caption(file)).font(.caption).foregroundStyle(Palette.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Palette.stroke))
        .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityLabel(Text("在侧边栏预览 \(name)"))
    }

    /// The description without its trailing `(…)`, else the extension.
    private static func caption(_ file: Deliverable) -> String {
        let description = (file.description ?? "").replacing(#/\s*[（(][^（）()]*[）)]\s*$/#, with: "").trimmingCharacters(in: .whitespaces)
        if !description.isEmpty { return description }
        let ext = URL(fileURLWithPath: file.path).pathExtension.uppercased()
        return ext.isEmpty ? String(localized: "文件") : ext
    }
}

extension Deliverable: Identifiable {
    var id: String { path }
}

/// Which step a tool call is, as the web groups them for its titles (C-29).
enum StepKind: String {
    case thinking, read, readImage, write, search, edit, commands, code, webSearch, webFetch, subagents, plan, questions, tools

    init(tool name: String) {
        switch name.components(separatedBy: "__").last ?? name {
        case "read": self = .read
        case "read_image": self = .readImage
        case "grep", "glob": self = .search
        case "write": self = .write
        case "edit", "apply_patch": self = .edit
        case "bash", "pwsh", "exec_command", "write_stdin": self = .commands
        case "run_code": self = .code
        case "web_search": self = .webSearch
        case "web_fetch": self = .webFetch
        case "todo_write", "create_goal", "update_goal", "get_goal": self = .plan
        case "ask_user_question", "request_user_input": self = .questions
        case let tool where tool.hasPrefix("subagent") || tool == "subagent": self = .subagents
        case let tool where tool.hasPrefix("terminal_"): self = .commands
        case let tool where tool.hasSuffix("_inspect"): self = .search
        default: self = .tools
        }
    }

    var running: String {
        switch self {
        case .thinking: String(localized: "正在分析请求")
        case .read: String(localized: "正在读取文件")
        case .readImage: String(localized: "正在读取图片")
        case .write: String(localized: "正在写入文件")
        case .search: String(localized: "正在搜索代码")
        case .edit: String(localized: "正在编辑文件")
        case .commands: String(localized: "正在运行命令")
        case .code: String(localized: "正在运行代码")
        case .webSearch: String(localized: "正在搜索网页")
        case .webFetch: String(localized: "正在访问网页")
        case .subagents: String(localized: "正在协调子智能体")
        case .plan: String(localized: "正在更新计划")
        case .questions: String(localized: "等待你的操作")
        case .tools: String(localized: "正在调用工具")
        }
    }

    var preparing: String {
        switch self {
        case .thinking, .tools: String(localized: "准备调用工具")
        case .read: String(localized: "准备读取文件")
        case .readImage: String(localized: "准备读取图片")
        case .write: String(localized: "准备写入文件")
        case .search: String(localized: "准备搜索代码")
        case .edit: String(localized: "准备编辑文件")
        case .commands: String(localized: "准备运行命令")
        case .code: String(localized: "准备运行代码")
        case .webSearch: String(localized: "准备搜索网页")
        case .webFetch: String(localized: "准备访问网页")
        case .subagents: String(localized: "准备协调子智能体")
        case .plan: String(localized: "准备更新计划")
        case .questions: String(localized: "准备提问")
        }
    }

    var done: String {
        switch self {
        case .thinking: String(localized: "已完成分析")
        case .read: String(localized: "已读取文件")
        case .readImage: String(localized: "已读取图片")
        case .write: String(localized: "已写入文件")
        case .search: String(localized: "已搜索代码")
        case .edit: String(localized: "修改了文件")
        case .commands: String(localized: "执行了命令")
        case .code: String(localized: "运行了代码")
        case .webSearch: String(localized: "已搜索网页")
        case .webFetch: String(localized: "已访问网页")
        case .subagents: String(localized: "已协调子智能体")
        case .plan: String(localized: "更新了计划")
        case .questions: String(localized: "向用户提出了问题")
        case .tools: String(localized: "已调用工具")
        }
    }

    /// A closed group's title: the three commonest kinds, 「已读取文件并搜索代码」 style.
    static func title(calls: [ToolCall]) -> String {
        var counts: [StepKind: Int] = [:]
        var order: [StepKind] = []
        for call in calls {
            let kind = StepKind(tool: call.name)
            if counts[kind] == nil { order.append(kind) }
            counts[kind, default: 0] += 1
        }
        // Stable: ties keep the order they first appeared in.
        let ranked = order.enumerated().sorted { lhs, rhs in
            let (l, r) = (counts[lhs.element] ?? 0, counts[rhs.element] ?? 0)
            return l == r ? lhs.offset < rhs.offset : l > r
        }.map(\.element)
        let labels = ranked.prefix(3).map(\.done)
        var title: String
        switch labels.count {
        case 0: return StepKind.thinking.done
        case 1: title = labels[0]
        case 2:
            let shared = String(localized: "已")
            let second = labels[0].hasPrefix(shared) && labels[1].hasPrefix(shared) ? String(labels[1].dropFirst(shared.count)) : labels[1]
            title = String(localized: "\(labels[0])并\(second)")
        default:
            title = labels.joined(separator: String(localized: "，"))
        }
        if ranked.count > 3 { title = String(localized: "\(title)等") }
        return title
    }
}

/// The line a reasoning block folds to (C-25).
enum ReasoningSummary {
    /// Finished: the first line. Streaming: the first line of the latest paragraph whose first line has ended.
    static func make(_ text: String, live: Bool) -> String {
        let line: String
        if live {
            let paragraphs = text.split(separator: #/\r?\n(?:[\t ]*\r?\n)+/#, omittingEmptySubsequences: true)
            line = paragraphs.last { paragraph in
                guard let end = paragraph.firstIndex(of: "\n") else { return false }
                return !paragraph[..<end].trimmingCharacters(in: .whitespaces).isEmpty
            }.flatMap { paragraph in
                paragraph.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).first.map { $0.trimmingCharacters(in: .whitespaces) }
            } ?? ""
        } else {
            line = text.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
        }
        return line.replacingOccurrences(of: "**", with: "")
    }
}

/// Credentials in a user's text are drawn masked (C-132): only what is shown changes,
/// the copy menu and the message itself keep the original.
enum SecretMask {
    private struct Format {
        let regex: NSRegularExpression
        /// The capture to mask entirely; nil for prefixed tokens, which keep their first 8 characters.
        var group: Int? = nil
        var digitRequired = false
    }

    private static func format(_ pattern: String, group: Int? = nil, digit: Bool = false, caseless: Bool = false) -> Format? {
        (try? NSRegularExpression(pattern: pattern, options: caseless ? [.caseInsensitive] : [])).map { Format(regex: $0, group: group, digitRequired: digit) }
    }

    private static let formats: [Format] = [
        format(#"\b[a-z][a-z0-9+.-]{1,15}://[^\s/:@?#]{0,256}:([^\s/@?#]+)@"#, group: 1, caseless: true),
        format(#"(?<!\w)sk-[A-Za-z0-9_-]{20,}"#, digit: true),
        format(#"(?<!\w)AIza[A-Za-z0-9_-]{35}"#),
        format(#"(?<!\w)gh[pousr]_[A-Za-z0-9]{36,}"#),
        format(#"(?<!\w)github_pat_\w{22,}"#),
        format(#"(?<!\w)glpat-[A-Za-z0-9_-]{20,}"#),
        format(#"(?<!\w)npm_[A-Za-z0-9]{36,}"#),
        format(#"(?<!\w)hf_[A-Za-z0-9]{30,}"#),
        format(#"(?<!\w)(?:AKIA|ASIA)[A-Z0-9]{16}\b"#),
        format(#"(?<!\w)LTAI[A-Za-z0-9]{12,20}\b"#),
        format(#"(?<!\w)AKID[A-Za-z0-9]{28,36}\b"#),
        format(#"(?<!\w)xox[abprs]-[A-Za-z0-9-]{10,}"#),
        format(#"(?<!\w)(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}"#),
        format(#"(?<!\w)whsec_[A-Za-z0-9]{24,}"#),
        format(#"(?<!\w)eyJ[A-Za-z0-9_-]{8,2048}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"#),
    ].compactMap { $0 }

    private static let privateKey = try? NSRegularExpression(pattern: #"-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----([\s\S]*?)(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|\z)"#)

    /// The text with secrets drawn as dots; nil when it has none.
    static func masked(_ text: String) -> String? {
        var ranges: [NSRange] = []
        let source = text as NSString
        let whole = NSRange(location: 0, length: source.length)
        for match in privateKey?.matches(in: text, range: whole) ?? [] { ranges.append(match.range(at: 1)) }
        for format in formats {
            for match in format.regex.matches(in: text, range: whole) {
                if let group = format.group {
                    ranges.append(match.range(at: group))
                } else {
                    if format.digitRequired, !source.substring(with: match.range).dropFirst(3).prefix(256).contains(where: \.isNumber) { continue }
                    let kept = min(8, match.range.length)
                    ranges.append(NSRange(location: match.range.location + kept, length: match.range.length - kept))
                }
            }
        }
        guard !ranges.isEmpty else { return nil }
        var result = ""
        var position = 0
        // Overlapping candidates merge into the earliest.
        for range in ranges.sorted(by: { $0.location < $1.location }) where range.location + range.length > position {
            let start = max(range.location, position)
            result += source.substring(with: NSRange(location: position, length: start - position))
            let secret = source.substring(with: NSRange(location: start, length: range.location + range.length - start))
            // Line breaks stay, so a key keeps its shape.
            result += String(secret.map { $0.isNewline ? $0 : "•" })
            position = range.location + range.length
        }
        return result + source.substring(from: position)
    }
}
