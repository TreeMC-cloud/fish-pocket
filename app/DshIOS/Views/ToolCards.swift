import SwiftUI

/// How a call stands and what its row says, derived from nothing but the call and its result.
struct ToolPresentation {
    enum State { case preparing, running, ok, error, stopped }

    let call: ToolCall
    let live: Bool
    var cwd: String?

    private var base: State {
        guard call.finished else { return live ? .preparing : .running }
        if call.errorCode == "interrupted" { return .stopped }
        return call.isError ? .error : .ok
    }

    /// A shell that ran but exited badly is a failed call even though the tool succeeded.
    var state: State {
        if base == .ok, let exit, exit.failed { return .error }
        return base
    }

    var title: String { ToolStyle.title(for: call) }

    var exit: ExitStatus? {
        guard ["bash", "pwsh"].contains(call.displayName), base == .ok, let text = call.result,
              let description = call.arguments["description"].string, !description.isEmpty,
              call.arguments["run_in_background"].bool != true else { return nil }
        return ExitStatus(text)
    }

    /// What the call acted on: a path, a command's description, a query. Never its output.
    private var subject: String {
        if call.displayName == "present" {
            return call.arguments["files"].array.compactMap { $0["path"].string }.map { ($0 as NSString).lastPathComponent }.joined(separator: " · ")
        }
        let base = call.rowSummary(cwd: cwd)
        if ToolStyle.hasOwnTitle(call) { return base }
        return base.isEmpty ? call.displayName : "\(call.displayName) · \(base)"
    }

    /// For a call that failed or stopped: just what it acted on, next to `outcome`.
    var subjectOrTitle: String { subject.isEmpty ? title : subject }

    /// The row's sentence: 「读取 src/a.swift」, a command's own description, 「工具 · 参数」.
    var line: String {
        switch call.displayName {
        case "todo_write":
            return TodoDiff(call: call).rowSummary
        case "skill" where state == .preparing:
            return String(localized: "准备加载技能")
        case "present":
            let status: String = switch state {
            case .preparing: String(localized: "准备交付")
            case .running: String(localized: "正在交付")
            case .ok: String(localized: "已交付")
            case .error: String(localized: "交付失败")
            case .stopped: String(localized: "已中断")
            }
            return subject.isEmpty ? status : "\(status) · \(subject)"
        case "bash" where hasDescription, "pwsh" where hasDescription:
            return subject
        default:
            guard ToolStyle.hasOwnTitle(call) else { return subject }
            return subject.isEmpty ? title : "\(title) \(subject)"
        }
    }

    private var hasDescription: Bool { call.arguments["description"].string?.isEmpty == false }

    /// How the call ended when that is news; the raw error waits in the sheet.
    func outcome(_ state: State) -> String? {
        if call.autoReviewDenied { return String(localized: "已拒绝") }
        switch state {
        case .error: return String(localized: "失败")
        case .stopped: return String(localized: "已停止")
        default: return nil
        }
    }

    /// The line names a path, whose start and end say more than its middle.
    var showsPath: Bool { ["read", "read_image", "write", "edit"].contains(call.displayName) }

    /// The change a file tool made: its recorded hunks once settled, what it was asked to do before.
    var diff: [DiffLine]? {
        let args = call.arguments
        var hunks: [(old: String?, new: String)] = []
        if base == .ok { hunks = call.meta["diffs"].array.compactMap { hunk in hunk["newText"].string.map { (hunk["oldText"].string, $0) } } }
        if hunks.isEmpty {
            switch call.displayName {
            case "write", "write_file", "create":
                if let content = args["content"].string { hunks = [(nil, content)] }
            case "edit", "str_replace", "multi_edit":
                if let new = args["new_string"].string { hunks = [(args["old_string"].string, new)] }
            case "str_replace_editor":
                if args["command"].string == "create", let text = args["file_text"].string {
                    hunks = [(nil, text)]
                } else if let new = args["new_str"].string {
                    hunks = [(args["old_str"].string, new)]
                }
            default:
                break
            }
        }
        guard !hunks.isEmpty else { return nil }
        var lines: [DiffLine] = []
        for hunk in hunks {
            if !lines.isEmpty { lines.append(DiffLine(kind: .gap, text: "")) }
            lines += Self.lines(old: hunk.old, new: hunk.new)
        }
        return lines
    }

    private static func lines(old: String?, new: String) -> [DiffLine] {
        func split(_ text: String) -> [String] {
            var lines = text.components(separatedBy: "\n")
            if lines.last == "" { lines.removeLast() }
            return lines
        }
        let before = old ?? ""
        if before.isEmpty { return split(new).map { DiffLine(kind: .added, text: "+" + $0) } }
        if new.isEmpty { return split(before).map { DiffLine(kind: .removed, text: "-" + $0) } }
        return DiffLine.lines(old: before, new: new)
    }
}

extension ToolPresentation {
    /// Where a shell ran: the recorded absolute cwd, else its workdir against the session's.
    var terminalCwd: String? {
        if let recorded = call.meta["cwd"].string, recorded.hasPrefix("/") { return recorded }
        guard let workdir = call.arguments["workdir"].string, !workdir.isEmpty else { return cwd }
        if workdir.hasPrefix("/") { return workdir }
        return cwd.map { ($0 as NSString).appendingPathComponent(workdir) } ?? workdir
    }
}

extension ToolPresentation {
    /// Something the row's long press and the sheet's toolbar can copy.
    struct Copy: Identifiable {
        let title: LocalizedStringKey
        let systemImage: String
        let text: String
        var id: String { systemImage }
    }

    /// The file a file tool worked on.
    var filePath: String? {
        guard ["read", "read_image", "write", "write_file", "edit", "str_replace", "str_replace_editor", "multi_edit", "create"].contains(call.displayName) else { return nil }
        let path = call.arguments["file_path"].string ?? call.arguments["path"].string
        return path?.isEmpty == false ? path : nil
    }

    /// The arguments as text; blank when there are none.
    var argumentsText: String {
        let args = call.arguments
        guard !args.object.isEmpty || !call.rawArguments.isEmpty else { return "" }
        guard !args.isNull else { return call.rawArguments }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .withoutEscapingSlashes, .sortedKeys]
        return (try? encoder.encode(args)).map { String(decoding: $0, as: UTF8.self) } ?? ""
    }

    var copies: [Copy] {
        var items: [Copy] = []
        if ["bash", "pwsh"].contains(call.displayName) {
            let command = call.arguments["command"].string ?? call.rawArguments
            if !command.isEmpty { items.append(Copy(title: "复制命令", systemImage: "terminal", text: command)) }
        } else if let filePath {
            items.append(Copy(title: "复制路径", systemImage: "link", text: filePath))
        } else if !argumentsText.isEmpty {
            items.append(Copy(title: "复制参数", systemImage: "curlybraces", text: argumentsText))
        }
        let output = exit?.output ?? call.result ?? ""
        if !output.isEmpty { items.append(Copy(title: "复制输出", systemImage: "doc.on.doc", text: output)) }
        return items
    }
}

/// The trailing marker `dsh-shell` writes after a command's output.
struct ExitStatus {
    var output: String
    var exitCode: Int?
    var signal: String?
    /// `[exit code: null]`: no status at all.
    var noCode = false

    init(_ text: String) {
        if let match = text.firstMatch(of: #/\n\[killed by signal: ([^\]\n]+)\]$/#) {
            output = String(text[..<match.range.lowerBound])
            signal = String(match.output.1)
        } else if let match = text.firstMatch(of: #/\n\[exit code: (-?\d+|null)\]$/#) {
            output = String(text[..<match.range.lowerBound])
            exitCode = Int(match.output.1)
            noCode = exitCode == nil
        } else {
            output = text
            exitCode = 0
        }
    }

    var failed: Bool { signal != nil || noCode || (exitCode ?? 0) != 0 }

    var badge: String? {
        guard failed else { return nil }
        if let signal { return String(localized: "信号 \(signal)") }
        if let exitCode { return String(localized: "退出码 \(exitCode)") }
        return String(localized: "未正常退出")
    }
}

extension ToolCall {
    var autoReviewDenied: Bool { isError && errorName == "AutoReviewDeniedError" && errorCode == "AUTO_REVIEW_DENIED" }

    /// Trimmed and on one line; nil when blank.
    var autoReviewReason: String? {
        let reason = errorReason?.split(whereSeparator: \.isNewline).joined(separator: " ").trimmingCharacters(in: .whitespaces)
        return reason?.isEmpty == false ? reason : nil
    }

    /// UTF-16 length of the text being written, rounded up to KB, as the web's row.
    var kilobytes: Int? {
        let parts = ["content", "old_string", "new_string"].compactMap { arguments[$0].string }
        guard !parts.isEmpty else { return nil }
        return Int((Double(parts.reduce(0) { $0 + $1.utf16.count }) / 1024).rounded(.up))
    }

    /// C-58. File tools show the path, relative to the working directory or `~`; others their
    /// description; then the keys of their kind, the first string argument, the raw arguments.
    func rowSummary(cwd: String?) -> String {
        switch displayName {
        case "read", "read_image", "write", "edit":
            if let path = arguments["file_path"].string ?? arguments["path"].string, !path.isEmpty {
                return Self.abbreviate(Self.firstLine(path), cwd: cwd)
            }
        default:
            if let description = arguments["description"].string, !description.isEmpty { return Self.firstLine(description) }
        }
        return derivedSummary
    }

    private var derivedSummary: String {
        if displayName == "web_search" || displayName == "grep" || displayName == "glob" {
            let queries = arguments["queries"].array.compactMap(\.string).filter { !$0.isEmpty }.map(Self.firstLine)
            if !queries.isEmpty { return queries.joined(separator: ", ") }
        }
        let keys: [String] = switch displayName {
        case "bash", "pwsh": ["description", "command"]
        case "read", "read_image", "web_fetch": ["path", "file_path", "url"]
        case "web_search", "grep", "glob": ["query", "pattern", "url"]
        case "write", "edit": ["path", "file_path"]
        case "run_code": ["description"]
        default: []
        }
        for key in keys { if let value = arguments[key].string, !value.isEmpty { return Self.firstLine(value) } }
        if let value = arguments.object.keys.sorted().compactMap({ arguments[$0].string }).first(where: { !$0.isEmpty }) { return Self.firstLine(value) }
        // Arguments still streaming, or nothing readable in them: JSON is no summary.
        return rawArguments.trimmingCharacters(in: .whitespaces).first.map { "{[".contains($0) } == true ? "" : Self.firstLine(rawArguments)
    }

    static func firstLine(_ text: String) -> String {
        text.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: true).first.map(String.init) ?? ""
    }

    /// Relative to the working directory, else home as `~`.
    static func abbreviate(_ path: String, cwd: String?) -> String {
        var path = path
        if let cwd {
            let root = cwd.hasSuffix("/") ? String(cwd.dropLast()) : cwd
            if path.hasPrefix(root + "/") { path = String(path.dropFirst(root.count + 1)) }
        }
        if path == EnginePaths.home { return "~" }
        if path.hasPrefix(EnginePaths.home + "/") { return "~" + path.dropFirst(EnginePaths.home.count) }
        return path
    }
}

/// Lines folded to a screenful, with 「… 其余 N 行」; lazy, as a file can run to thousands.
private struct FoldedLines<Line, Row: View>: View {
    let lines: [Line]
    let cap: Int
    @ViewBuilder let row: (Line) -> Row
    @State private var open = false

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(Array((open ? lines : Array(lines.prefix(cap))).enumerated()), id: \.offset) { _, line in row(line) }
            if lines.count > cap {
                FoldButton(open: open, hidden: lines.count - cap) { withAnimation(.snappy) { open.toggle() } }
            }
        }
    }
}

/// 「… 其余 N 行」 / 「收起」.
private struct FoldButton: View {
    let open: Bool
    let hidden: Int
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(open ? "收起" : "… 其余 \(hidden) 行")
                .font(.caption)
                .foregroundStyle(Palette.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .hitTarget()
        }
        .buttonStyle(.plain)
    }
}

/// Cards sit straight on the sheet: no box in a box, the text gets the width.
private struct ToolCardBox: ViewModifier {
    func body(content: Content) -> some View {
        content.frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A path that opens the file preview, at `line` when given; plain text when it cannot open.
private struct FilePathLink: View {
    let path: String
    var display: String?
    var line: Int?
    var enabled = true
    @Environment(\.openURL) private var openURL

    var body: some View {
        let label = Text(display ?? path).font(.caption.monospaced()).lineLimit(1).truncationMode(.middle)
        if enabled {
            Button {
                if let url = LinkTarget.fileURL(path, line: line) { openURL(url) }
            } label: {
                label.foregroundStyle(Palette.ink).underline().frame(maxWidth: .infinity, alignment: .leading).hitTarget()
            }
            .buttonStyle(.plain)
        } else {
            label.foregroundStyle(Palette.secondary)
        }
    }
}

/// bash (C-61): where it ran, the command, its output, and how it ended.
struct TerminalCard: View {
    let call: ToolCall
    let status: ExitStatus?
    let state: ToolPresentation.State
    let cwd: String?

    private var row: ToolPresentation { ToolPresentation(call: call, live: false, cwd: cwd) }
    private var command: String { call.arguments["command"].string ?? call.rawArguments }
    private var output: String { status?.output ?? call.result ?? "" }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let path = row.terminalCwd {
                Text(ToolCall.abbreviate(path, cwd: nil)).font(.caption.monospaced()).foregroundStyle(Palette.secondary).lineLimit(1).truncationMode(.head)
            }
            Text("$ " + command)
                .font(.caption.monospaced())
                .foregroundStyle(Palette.ink)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .background(Palette.field, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            if state == .running || state == .preparing {
                Text("运行中").font(.caption).foregroundStyle(Palette.secondary)
            } else if call.arguments["run_in_background"].bool == true, state == .ok {
                EmptyView()
            } else if output.isEmpty {
                Text("无输出").font(.caption).foregroundStyle(Palette.secondary)
            } else {
                WrappedOutput(text: output, tint: state == .error ? Palette.removed : nil)
            }
            if let badge = status?.badge { Text(badge).font(.caption.weight(.medium)).foregroundStyle(Palette.removed) }
        }
        .modifier(ToolCardBox())
    }
}

/// `read`'s meta: the window of lines it returned.
struct ReadMeta {
    var path: String
    var lines: [(number: Int, text: String)]
    var total: Int

    init?(_ meta: JSON) {
        guard let path = meta["path"].string, let total = meta["totalLines"].int else { return nil }
        self.path = path
        self.total = total
        lines = meta["lines"].array.compactMap { line in line["number"].int.map { ($0, line["text"].string ?? "") } }
    }
}

/// read (C-64): numbered lines, the path opening the file at the same place.
struct ReadCard: View {
    let call: ToolCall
    let read: ReadMeta
    @Environment(\.fileLinkScope) private var scope

    var body: some View {
        let digits = String(read.lines.last?.number ?? 0).count
        VStack(alignment: .leading, spacing: 6) {
            FilePathLink(
                path: call.arguments["file_path"].string ?? read.path,
                display: ToolCall.abbreviate(read.path, cwd: scope?.root),
                line: call.arguments["offset"].int
            )
            FoldedLines(lines: read.lines, cap: 60) { line in
                HStack(alignment: .top, spacing: 10) {
                    Text(String(line.number).leftPadded(digits)).foregroundStyle(Palette.faint)
                    Text(line.text.isEmpty ? " " : line.text).foregroundStyle(Palette.ink)
                }
                .font(.caption.monospaced())
            }
            if read.lines.count < read.total {
                Text("显示 \(read.lines.count) / \(read.total) 行").font(.caption).foregroundStyle(Palette.secondary)
            }
        }
        .modifier(ToolCardBox())
    }
}

private extension String {
    func leftPadded(_ width: Int) -> String { String(repeating: " ", count: max(0, width - count)) + self }
}

/// write, edit (C-66): the path, how much changed, and the change, wrapped to the sheet's width.
struct DiffCard: View {
    let call: ToolCall
    let lines: [DiffLine]
    @Environment(\.fileLinkScope) private var scope

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let path = call.arguments["file_path"].string ?? call.arguments["path"].string {
                FilePathLink(path: path, display: ToolCall.abbreviate(path, cwd: scope?.root))
            }
            Text(size).font(.caption.monospacedDigit()).foregroundStyle(Palette.secondary)
            FoldedLines(lines: lines, cap: 60) { line in
                if line.kind == .gap {
                    Text(verbatim: "⋯").foregroundStyle(Palette.faint).padding(.horizontal, 12).padding(.vertical, 2)
                } else {
                    Text(line.text.isEmpty ? " " : line.text)
                        .foregroundStyle(line.kind == .added ? Palette.added : line.kind == .removed ? Palette.removed : Palette.secondary)
                        .padding(.horizontal, 12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(line.kind == .added ? Palette.addedBackground : line.kind == .removed ? Palette.removedBackground : .clear)
                }
            }
            .font(.caption.monospaced())
            .textSelection(.enabled)
        }
        .modifier(ToolCardBox())
    }

    /// 「12KB +3 −1」: what the row used to carry.
    private var size: String {
        let counts = "+\(lines.filter { $0.kind == .added }.count) −\(lines.filter { $0.kind == .removed }.count)"
        return call.kilobytes.map { "\($0)KB \(counts)" } ?? counts
    }
}

/// grep and glob's meta.
struct SearchMeta {
    enum Line { case path(String), match(Int, String) }
    var lines: [Line] = []
    var shown = 0
    var files = 0
    var total: Int
    var truncated: Bool
    var paths: Bool

    init?(_ meta: JSON) {
        guard let truncated = meta["truncated"].bool, let total = meta["total"].int, total >= 0 else { return nil }
        self.truncated = truncated
        self.total = total
        switch meta["shape"].string {
        case "matches":
            paths = false
            for file in meta["files"].array {
                lines.append(.path(file["path"].string ?? ""))
                files += 1
                for match in file["matches"].array {
                    lines.append(.match(match["lineNumber"].int ?? 0, match["line"].string ?? ""))
                    shown += 1
                }
            }
        case "paths":
            paths = true
            lines = meta["paths"].array.compactMap(\.string).map(Line.path)
            shown = lines.count
        default:
            return nil
        }
    }

    var header: String {
        switch (paths, truncated) {
        case (true, false): String(localized: "\(shown) 个路径")
        case (true, true): String(localized: "显示 \(shown) / 共 \(total) 个路径")
        case (false, false): String(localized: "\(shown) 处匹配 · \(files) 个文件")
        case (false, true): String(localized: "显示 \(shown) / 共 \(total) 处匹配 · \(files) 个文件")
        }
    }
}

/// grep, glob (C-68): matches by file, or paths.
struct SearchCard: View {
    let search: SearchMeta
    let recovery: String
    @Environment(\.fileLinkScope) private var scope

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if search.total == 0 {
                Text("无结果").font(.caption).foregroundStyle(Palette.secondary)
            } else {
                Text(search.header).font(.caption).foregroundStyle(Palette.secondary)
                FoldedLines(lines: search.lines, cap: 60) { line in
                    switch line {
                    case .path(let path):
                        FilePathLink(path: path, display: ToolCall.abbreviate(path, cwd: scope?.root))
                    case .match(let number, let text):
                        Text(verbatim: "\(number): \(text)").font(.caption.monospaced()).foregroundStyle(Palette.secondary).textSelection(.enabled)
                    }
                }
                if search.truncated {
                    Text(recovery).font(.caption).foregroundStyle(Palette.secondary).lineLimit(6).textSelection(.enabled)
                }
            }
        }
        .modifier(ToolCardBox())
    }
}

/// web_search (C-69): the answer, when the provider gave one, and the numbered sources.
struct WebSearchCard: View {
    let meta: JSON

    var body: some View {
        let sources = meta["sources"].array
        let answer = meta["answer"].string ?? ""
        VStack(alignment: .leading, spacing: 10) {
            if answer.isEmpty && sources.isEmpty { Text("未找到结果").font(.caption).foregroundStyle(Palette.secondary) }
            if !answer.isEmpty { MarkdownView(text: answer) }
            ForEach(Array(sources.enumerated()), id: \.offset) { index, source in
                VStack(alignment: .leading, spacing: 2) {
                    let url = source["url"].string ?? ""
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("\(index + 1).").font(.caption.monospacedDigit()).foregroundStyle(Palette.faint)
                        if let link = URL(string: url), link.scheme?.hasPrefix("http") == true {
                            Link(destination: link) {
                                Text(source["title"].string ?? url).font(.footnote).foregroundStyle(Palette.ink).underline().lineLimit(2)
                            }
                        } else {
                            Text(source["title"].string ?? url).font(.footnote).lineLimit(2)
                        }
                    }
                    if let snippet = source["snippet"].string { Text(snippet).font(.caption).foregroundStyle(Palette.secondary).lineLimit(3) }
                    if let date = source["publishedAt"].string { Text(date).font(.caption2).foregroundStyle(Palette.faint) }
                }
            }
            if meta["truncated"].bool == true { Text("来源列表已截断").font(.caption).foregroundStyle(Palette.secondary) }
        }
        .modifier(ToolCardBox())
    }
}

/// web_fetch (C-69).
struct WebFetchCard: View {
    let meta: JSON

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let url = meta["url"].string {
                if let link = URL(string: url), link.scheme?.hasPrefix("http") == true {
                    Link(destination: link) { Text(url).font(.footnote).foregroundStyle(Palette.ink).underline().lineLimit(2) }
                } else {
                    Text(url).font(.footnote).lineLimit(2)
                }
            }
            if let status = meta["statusCode"].int { Text(verbatim: "HTTP \(status)").font(.caption.monospaced()).foregroundStyle(Palette.secondary) }
            if meta["truncated"].bool == true { Text("内容已截断").font(.caption).foregroundStyle(Palette.secondary) }
        }
        .modifier(ToolCardBox())
    }
}

/// todo_write against the list before it (C-70).
struct TodoDiff {
    enum Mark { case added, removed, status(String) }
    struct Row {
        var mark: Mark
        var title: String
        /// 「旧状态 → 新状态」 or 「顺序调整」.
        var change: String?
    }

    var caption: String
    var rows: [Row] = []
    var unchanged: [Row] = []
    var counts: String?
    private var done = 0
    private var total = 0
    private var inProgress: [String] = []

    init(call: ToolCall) {
        let current = call.arguments["todos"].array.map { TodoItem(content: $0["content"].string ?? "", status: $0["status"].string ?? "pending") }
        total = current.count
        done = current.filter { $0.status == "completed" }.count
        inProgress = current.filter { $0.status == "in_progress" }.map(\.content)
        guard call.previousTodos != nil || call.historyComplete else {
            caption = String(localized: "旧清单不可用")
            rows = current.map { Row(mark: .status($0.status), title: $0.content) }
            return
        }
        let previous = call.previousTodos ?? []
        caption = call.previousTodos == nil ? String(localized: "首次记录") : String(localized: "与上次清单相比")
        var old: [String: String] = [:]
        for item in previous { old[Self.key(item)] = item.status }
        let keptOld = previous.map(Self.key).filter { key in current.contains { Self.key($0) == key } }
        let keptNew = current.map(Self.key).filter { old[$0] != nil }
        var added = 0, updated = 0
        var position = 0
        for item in current {
            let key = Self.key(item)
            guard let before = old[key] else {
                added += 1
                rows.append(Row(mark: .added, title: item.content, change: String(localized: "新增")))
                continue
            }
            let moved = position < keptOld.count && position < keptNew.count && keptOld[position] != keptNew[position]
            position += 1
            if before != item.status {
                updated += 1
                rows.append(Row(mark: .status(item.status), title: item.content, change: "\(Self.label(before)) → \(Self.label(item.status))"))
            } else if moved {
                updated += 1
                rows.append(Row(mark: .status(item.status), title: item.content, change: String(localized: "顺序调整")))
            } else {
                unchanged.append(Row(mark: .status(item.status), title: item.content))
            }
        }
        let removed = previous.filter { item in !current.contains { Self.key($0) == Self.key(item) } }
        rows += removed.map { Row(mark: .removed, title: $0.content, change: String(localized: "移除")) }
        let parts = [
            added > 0 ? String(localized: "新增 \(added)") : nil,
            updated > 0 ? String(localized: "更新 \(updated)") : nil,
            !removed.isEmpty ? String(localized: "移除 \(removed.count)") : nil,
        ].compactMap { $0 }
        counts = parts.isEmpty ? String(localized: "清单没有变化") : parts.joined(separator: " · ")
    }

    private static func key(_ item: TodoItem) -> String { item.content.trimmingCharacters(in: .whitespacesAndNewlines) }

    static func label(_ status: String) -> String {
        switch status {
        case "completed": String(localized: "已完成")
        case "in_progress": String(localized: "进行中")
        default: String(localized: "待处理")
        }
    }

    var rowSummary: String {
        ([String(localized: "\(done)/\(total) 已完成")] + inProgress.prefix(1)).joined(separator: " · ")
    }
}

struct TodoDiffCard: View {
    let diff: TodoDiff
    @State private var showUnchanged = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(([diff.caption] + [diff.counts].compactMap { $0 }).joined(separator: " · ")).font(.caption).foregroundStyle(Palette.secondary)
            if diff.rows.isEmpty && diff.unchanged.isEmpty { Text("任务清单为空").font(.footnote).foregroundStyle(Palette.secondary) }
            ForEach(Array(diff.rows.enumerated()), id: \.offset) { _, row in rowView(row) }
            if !diff.unchanged.isEmpty {
                Button { withAnimation(.snappy) { showUnchanged.toggle() } } label: {
                    Text("\(diff.unchanged.count) 项未变化").font(.caption).foregroundStyle(Palette.secondary).hitTarget()
                }
                .buttonStyle(.plain)
                if showUnchanged { ForEach(Array(diff.unchanged.enumerated()), id: \.offset) { _, row in rowView(row) } }
            }
        }
        .modifier(ToolCardBox())
    }

    private func rowView(_ row: TodoDiff.Row) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            icon(row.mark).font(.footnote)
            Text(row.title).font(.footnote).foregroundStyle(Palette.ink)
            if let change = row.change { Text(change).font(.caption).foregroundStyle(Palette.secondary) }
        }
    }

    @ViewBuilder
    private func icon(_ mark: TodoDiff.Mark) -> some View {
        switch mark {
        case .added: Image(systemName: "plus").foregroundStyle(Palette.added)
        case .removed: Text(verbatim: "−").foregroundStyle(Palette.removed)
        case .status("completed"): Image(systemName: "checkmark").foregroundStyle(Palette.running)
        case .status("in_progress"): Image(systemName: "play.fill").foregroundStyle(Palette.ink)
        case .status: Image(systemName: "square").foregroundStyle(Palette.faint)
        }
    }
}

/// ask_user_question's row (C-71): what became of the question, and whether it can still be answered.
@MainActor
struct AskStatus {
    var state: ToolPresentation.State
    var summary: String
    var answerable = false
    /// 「本轮已取消，未提交回答」 and the like, for the card.
    var verdict: String?
    var answers: [JSON] = []

    init(call: ToolCall, model: SessionModel?) {
        let open = model?.questions.contains { $0.id == call.id } ?? false
        let isSettled = model?.settledAnswers[call.id] != nil
        let settled = model?.settledAnswers[call.id]?.array ?? []
        let value = (call.result.flatMap { try? JSONDecoder().decode(JSON.self, from: Data($0.utf8)) }) ?? .null
        switch call.errorCode {
        case "ASK_CANCELLED":
            state = .ok
            summary = String(localized: "已取消")
            verdict = String(localized: "本轮已取消，未提交回答")
            return
        case "ASK_ABORTED":
            state = .stopped
            summary = String(localized: "已中断")
            verdict = String(localized: "本轮已中断，未提交回答")
            return
        default:
            break
        }
        if call.errorCode == "interrupted" {
            state = .stopped
            summary = String(localized: "已中断")
            return
        }
        if !call.finished {
            state = .running
            summary = String(localized: "等待回答")
            answerable = open
            return
        }
        answers = value["answers"].array
        let unknown = call.errorCode == "TOOL_OUTCOME_UNKNOWN"
        var recovered = false
        if unknown || value["pending"].bool == true {
            if open {
                state = .ok
                summary = String(localized: "已继续工作，仍可回答")
                verdict = String(localized: "等待中的问题仍可在输入框中回答")
                answerable = true
                return
            }
            // A crash loses the tool's outcome; the projection may still know how it ended.
            recovered = isSettled
            answers = settled
            if settled.isEmpty, recovered || !unknown {
                state = .ok
                summary = String(localized: "已结束")
                verdict = String(localized: "该问题已结束，结果见下方对话")
                return
            }
        }
        if call.isError, !recovered {
            state = .error
            summary = ""
            // The row only says it failed; the card says why.
            verdict = call.result.flatMap { $0.isEmpty ? nil : $0 }
            return
        }
        state = .ok
        let total = call.arguments["questions"].array.count
        let answered = answers.filter { !$0["selected"].array.isEmpty || !($0["custom"].string ?? "").isEmpty }.count
        summary = String(localized: "\(answered)/\(total) 已回答")
    }
}

/// The questions and their answers (C-71, the read-only review of C-117).
struct AskCard: View {
    let call: ToolCall
    let status: AskStatus

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let verdict = status.verdict { Text(verdict).font(.footnote).foregroundStyle(Palette.secondary) }
            ForEach(Array(call.arguments["questions"].array.enumerated()), id: \.offset) { _, question in
                VStack(alignment: .leading, spacing: 3) {
                    Text(question["question"].string ?? "").font(.footnote.weight(.medium))
                    if status.verdict == nil || !status.answers.isEmpty { Text(answer(question)).font(.footnote).foregroundStyle(Palette.secondary) }
                }
            }
        }
        .modifier(ToolCardBox())
    }

    private func answer(_ question: JSON) -> String {
        guard let answer = status.answers.first(where: { $0["id"].string == question["id"].string }) else { return String(localized: "未回答") }
        let values = answer["selected"].array.compactMap(\.string) + [answer["custom"].string].compactMap { $0 }.filter { !$0.isEmpty }
        return values.isEmpty ? String(localized: "未回答") : values.joined(separator: ", ")
    }
}

/// `read_image`: the images it read, the path, and each image's size (C-65).
struct ReadImageCard: View {
    let call: ToolCall

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let path = call.meta["path"].string ?? call.arguments["file_path"].string {
                Text(path).font(.caption.monospaced()).foregroundStyle(Palette.secondary).textSelection(.enabled)
            }
            if !call.resultImages.isEmpty {
                ImageGroup(attachments: call.resultImages)
                ForEach(Array(call.resultImages.enumerated()), id: \.offset) { _, image in
                    if let size = Self.sizeLine(image) { Text(size).font(.caption).foregroundStyle(Palette.secondary) }
                }
            }
        }
    }

    static func sizeLine(_ image: Attachment) -> String? {
        guard let width = image.width, let height = image.height, let bytes = image.bytes else { return nil }
        if let ow = image.originalWidth, let oh = image.originalHeight {
            return String(localized: "\(width)x\(height)px（由 \(ow)x\(oh)px 缩小），\(bytes) 字节")
        }
        return String(localized: "\(width)x\(height)px，\(bytes) 字节")
    }
}
