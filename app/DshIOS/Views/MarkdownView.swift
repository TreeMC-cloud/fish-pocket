import SwiftUI

/// Block-level Markdown for assistant replies: headings, paragraphs, lists,
/// quotes, fenced code, tables and rules. Inline styling (bold, code, links)
/// comes from Foundation's Markdown parser.
struct MarkdownView: View {
    let text: String
    /// Streaming text changes every frame; caching each version would only evict finished replies.
    var cached = true
    /// A closing message: inline code naming a file the turn produced links to it (C-24).
    var linksFiles = false
    /// Off in the timeline: there a long press is the reply's menu, which has 「选择文本」.
    var selectable = true
    @Environment(\.fileMentions) private var fileMentions

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array((cached ? MarkdownCache.blocks(text) : MarkdownBlock.parse(text)).enumerated()), id: \.offset) { _, block in
                view(for: block)
            }
        }
        .font(.callout)
        .lineSpacing(4)
        .foregroundStyle(Palette.ink)
        .modifier(TextSelecting(enabled: selectable))
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func view(for block: MarkdownBlock) -> some View {
        switch block {
        case .heading(let level, let text):
            Text(inline(text))
                .font(level == 1 ? .title2.bold() : level == 2 ? .title3.bold() : .headline)
                .padding(.top, 4)
        case .paragraph(let text):
            Text(inline(text))
        case .list(let items, let ordered):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(item.checked.map { $0 ? "☑︎" : "☐" } ?? (ordered ? "\(item.number ?? index + 1)." : "•"))
                            .foregroundStyle(Palette.secondary)
                            .monospacedDigit()
                        Text(inline(item.text))
                    }
                    .padding(.leading, CGFloat(item.indent) * 14)
                }
            }
        case .quote(let text):
            HStack(spacing: 8) {
                RoundedRectangle(cornerRadius: 1.5).fill(Palette.stroke).frame(width: 3)
                Text(inline(text)).foregroundStyle(Palette.secondary)
            }
        case .code(let language, let code):
            if language == "schemaJson", let node = GenUIView.parse(code) {
                GenUIView(node: node)
            } else {
                CodeBlockView(language: language, code: code)
            }
        case .table(let rows):
            ScrollView(.horizontal, showsIndicators: false) {
                Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                        GridRow {
                            ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                                Text(inline(cell)).font(index == 0 ? .subheadline.bold() : .subheadline)
                            }
                        }
                        if index == 0 { Divider() }
                    }
                }
                .padding(10)
                .background(Palette.field, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
        case .rule:
            Divider()
        }
    }

    private func inline(_ text: String) -> AttributedString {
        let string = cached ? MarkdownCache.inline(text) : MarkdownCache.render(text)
        return linksFiles && !fileMentions.isEmpty ? Self.linkMentions(string, fileMentions) : string
    }

    /// Links code spans that exactly name a path or its unique basename.
    private static func linkMentions(_ source: AttributedString, _ mentions: [String: String]) -> AttributedString {
        var string = source
        for run in source.runs where run.inlinePresentationIntent?.contains(.code) == true && run.link == nil {
            let value = String(source[run.range].characters).replacingOccurrences(of: "\n", with: " ")
            if let path = mentions[value] { string[run.range].link = LinkTarget.fileURL(path) }
        }
        return string
    }
}

private struct TextSelecting: ViewModifier {
    let enabled: Bool

    func body(content: Content) -> some View {
        if enabled { content.textSelection(.enabled) } else { content.textSelection(.disabled) }
    }
}

/// Produced paths and their basenames, for the closing message; an ambiguous name stays plain text.
enum FileMentions {
    static func make(_ paths: [String]) -> [String: String] {
        var mentions: [String: String] = [:]
        var ambiguous: Set<String> = []
        for path in Set(paths) {
            mentions[path] = path
            let name = URL(fileURLWithPath: path).lastPathComponent
            if name == path { continue }
            if mentions[name] != nil { ambiguous.insert(name) } else { mentions[name] = path }
        }
        ambiguous.forEach { mentions[$0] = nil }
        return mentions
    }
}

/// Parsed Markdown by source text. Lazy rows are rebuilt whenever they scroll back
/// into view, and parsing (above all `AttributedString(markdown:)`) is the costly part.
@MainActor
enum MarkdownCache {
    private final class Box<Value>: NSObject {
        let value: Value
        init(_ value: Value) { self.value = value }
    }

    private static let blockCache: NSCache<NSString, Box<[MarkdownBlock]>> = {
        let cache = NSCache<NSString, Box<[MarkdownBlock]>>()
        cache.countLimit = 500
        return cache
    }()

    private static let inlineCache: NSCache<NSString, Box<AttributedString>> = {
        let cache = NSCache<NSString, Box<AttributedString>>()
        cache.countLimit = 4000
        return cache
    }()

    static func blocks(_ text: String) -> [MarkdownBlock] {
        let key = text as NSString
        if let hit = blockCache.object(forKey: key) { return hit.value }
        let blocks = MarkdownBlock.parse(text)
        blockCache.setObject(Box(blocks), forKey: key)
        return blocks
    }

    static func inline(_ text: String) -> AttributedString {
        let key = text as NSString
        if let hit = inlineCache.object(forKey: key) { return hit.value }
        let value = render(text)
        inlineCache.setObject(Box(value), forKey: key)
        return value
    }

    static func render(_ text: String) -> AttributedString {
        var string = (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
        // Inline code: a shade behind it, as in the design's `spawn` chip.
        for run in string.runs where run.inlinePresentationIntent?.contains(.code) == true {
            string[run.range].backgroundColor = Palette.bubble
            string[run.range].font = .system(.subheadline, design: .monospaced)
        }
        linkify(&string)
        return string
    }

    private static let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

    /// Foundation's parser only links `[text](url)` and `<url>`; replies
    /// usually print bare addresses (`http://localhost:5173`, often in inline
    /// code), so http(s) URLs not already linked become links too.
    private static func linkify(_ string: inout AttributedString) {
        let plain = String(string.characters)
        guard let detector else { return }
        for match in detector.matches(in: plain, range: NSRange(plain.startIndex..., in: plain)) {
            guard let url = match.url, let range = Range(match.range, in: plain),
                  plain[range].lowercased().hasPrefix("http://") || plain[range].lowercased().hasPrefix("https://") else { continue }
            let lower = string.characters.index(string.startIndex, offsetBy: plain.distance(from: plain.startIndex, to: range.lowerBound))
            let upper = string.characters.index(lower, offsetBy: plain[range].count)
            guard !string[lower..<upper].runs.contains(where: { $0.link != nil }) else { continue }
            string[lower..<upper].link = url
        }
    }
}

/// The session whose files relative links in a reply resolve against.
struct FileLinkScope: Equatable {
    let sessionId: String
    let root: String?
}

extension EnvironmentValues {
    @Entry var fileLinkScope: FileLinkScope?
    @Entry var fileMentions: [String: String] = [:]
}

/// Opens links tapped in replies the way the Web UI's chat does (C-23). Web
/// links open in an in-app Safari sheet instead of the system browser: the
/// app stays in the foreground, so servers started in the engine on
/// 127.0.0.1 keep answering (switching to Safari suspends the app and them).
/// File links open the file preview at their `#L24` / `#L24-L30` lines.
struct LinkOpening: ViewModifier {
    @Environment(\.fileLinkScope) private var scope
    @State private var target: LinkTarget?

    func body(content: Content) -> some View {
        content
            .environment(\.openURL, OpenURLAction { url in
                guard let target = LinkTarget(url, scope: scope) else { return .systemAction }
                if case .web(let url) = target { InAppSafari.open(url) } else { self.target = target }
                return .handled
            })
            .sheet(item: $target) { target in
                switch target {
                case .web:
                    EmptyView()
                case .file(let path, let lines, let scope):
                    FilePreviewSheet(sessionId: scope.sessionId, path: path, root: scope.root, lines: lines)
                }
            }
    }
}

enum LinkTarget: Identifiable {
    case web(URL)
    case file(path: String, lines: ClosedRange<Int>?, scope: FileLinkScope)

    var id: String {
        switch self {
        case .web(let url): url.absoluteString
        case .file(let path, let lines, _): "\(path)#\(lines.map { "\($0)" } ?? "")"
        }
    }

    /// http(s) is a web page; a link without a scheme (the model writes paths
    /// relative to the working directory or absolute) or a file URL is a file.
    init?(_ url: URL, scope: FileLinkScope?) {
        switch url.scheme?.lowercased() {
        case "http", "https":
            self = .web(url)
        case nil, "file":
            let path = url.path(percentEncoded: false)
            guard let scope, !path.isEmpty else { return nil }
            self = .file(path: path, lines: Self.lines(url.fragment(percentEncoded: false)), scope: scope)
        default:
            return nil
        }
    }

    /// A link to a file; `path` may be relative to the session's working directory.
    static func fileURL(_ path: String, line: Int? = nil) -> URL? {
        var components = URLComponents()
        components.scheme = "file"
        components.path = path
        components.fragment = line.map { "L\($0)" }
        return components.url
    }

    /// `L24` or `L24-L30`; anything else opens the file at the top.
    static func lines(_ fragment: String?) -> ClosedRange<Int>? {
        guard let fragment, fragment.hasPrefix("L") else { return nil }
        let bounds = fragment.split(separator: "-").map { Int($0.drop(while: { $0 == "L" })) }
        guard let start = bounds.first ?? nil, start > 0 else { return nil }
        let end = bounds.count > 1 ? bounds[1] ?? start : start
        return start...max(start, end)
    }
}

struct CodeBlockView: View {
    let language: String?
    let code: String
    @State private var copied = false
    @State private var expanded = false
    private let cap = 24

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language?.isEmpty == false ? language! : "code").font(.caption).foregroundStyle(Palette.secondary)
                Spacer()
                Button {
                    copyToPasteboard(code)
                    copied = true
                    Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc").font(.caption).foregroundStyle(Palette.secondary).hitTarget()
                }
                .buttonStyle(.plain)
                .accessibilityLabel("复制代码")
            }
            .padding(.leading, 14)
            .padding(.trailing, 2)
            let lines = code.components(separatedBy: "\n")
            ScrollView(.horizontal, showsIndicators: false) {
                Text(expanded || lines.count <= cap ? code : lines.prefix(cap).joined(separator: "\n"))
                    .font(.system(.footnote, design: .monospaced))
                    .lineSpacing(2)
                    .padding(.horizontal, 14)
                    .padding(.bottom, lines.count > cap ? 4 : 12)
            }
            if lines.count > cap {
                Button { expanded.toggle() } label: {
                    Text(expanded ? "收起" : "展开全部（\(lines.count) 行）").font(.caption).foregroundStyle(Palette.secondary).hitTarget()
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 14)
            }
        }
        .background(Palette.field, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

enum MarkdownBlock {
    struct Item { var text: String; var indent: Int; var checked: Bool?; var number: Int? }
    case heading(Int, String)
    case paragraph(String)
    case list([Item], ordered: Bool)
    case quote(String)
    case code(String?, String)
    case table([[String]])
    case rule

    static func parse(_ source: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var lines = source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")[...]
        var paragraph: [String] = []

        func flush() {
            if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))) }
            paragraph = []
        }

        while let line = lines.first {
            lines = lines.dropFirst()
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flush()
                let fence = String(trimmed.prefix(3))
                let language = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                var code: [String] = []
                while let next = lines.first {
                    lines = lines.dropFirst()
                    if next.trimmingCharacters(in: .whitespaces).hasPrefix(fence) { break }
                    code.append(next)
                }
                blocks.append(.code(language.isEmpty ? nil : language, code.joined(separator: "\n")))
            } else if trimmed.isEmpty {
                flush()
            } else if let hashes = trimmed.firstIndex(where: { $0 != "#" }), trimmed.hasPrefix("#"), trimmed[hashes] == " ", trimmed.distance(from: trimmed.startIndex, to: hashes) <= 6 {
                flush()
                blocks.append(.heading(trimmed.distance(from: trimmed.startIndex, to: hashes), String(trimmed[hashes...]).trimmingCharacters(in: .whitespaces)))
            } else if ["---", "***", "___"].contains(trimmed) {
                flush()
                blocks.append(.rule)
            } else if trimmed.hasPrefix(">") {
                flush()
                var quote = [String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces)]
                while let next = lines.first, next.trimmingCharacters(in: .whitespaces).hasPrefix(">") {
                    lines = lines.dropFirst()
                    quote.append(String(next.trimmingCharacters(in: .whitespaces).dropFirst()).trimmingCharacters(in: .whitespaces))
                }
                blocks.append(.quote(quote.joined(separator: "\n")))
            } else if trimmed.hasPrefix("|"), let next = lines.first, next.contains("---") && next.contains("|") {
                flush()
                lines = lines.dropFirst()
                var rows = [cells(trimmed)]
                while let row = lines.first, row.trimmingCharacters(in: .whitespaces).hasPrefix("|") {
                    lines = lines.dropFirst()
                    rows.append(cells(row))
                }
                blocks.append(.table(rows))
            } else if let item = listItem(line) {
                flush()
                var items = [item.item]
                let ordered = item.ordered
                while let next = lines.first, let more = listItem(next) {
                    lines = lines.dropFirst()
                    items.append(more.item)
                }
                blocks.append(.list(items, ordered: ordered))
            } else {
                paragraph.append(line)
            }
        }
        flush()
        return blocks
    }

    private static func cells(_ row: String) -> [String] {
        var parts = row.trimmingCharacters(in: .whitespaces).split(separator: "|", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
        if parts.first == "" { parts.removeFirst() }
        if parts.last == "" { parts.removeLast() }
        return parts
    }

    private static func listItem(_ line: String) -> (item: Item, ordered: Bool)? {
        let indent = line.prefix(while: { $0 == " " }).count / 2
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        var rest: Substring
        var ordered = false
        var number: Int?
        if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") || trimmed.hasPrefix("+ ") {
            rest = trimmed.dropFirst(2)
        } else if let dot = trimmed.firstIndex(of: "."), trimmed[..<dot].allSatisfy(\.isNumber), !trimmed[..<dot].isEmpty,
                  trimmed.index(after: dot) < trimmed.endIndex, trimmed[trimmed.index(after: dot)] == " " {
            rest = trimmed[trimmed.index(dot, offsetBy: 2)...]
            ordered = true
            number = Int(trimmed[..<dot])
        } else {
            return nil
        }
        var checked: Bool?
        if rest.hasPrefix("[ ] ") { checked = false; rest = rest.dropFirst(4) }
        else if rest.hasPrefix("[x] ") || rest.hasPrefix("[X] ") { checked = true; rest = rest.dropFirst(4) }
        return (Item(text: String(rest), indent: indent, checked: checked, number: number), ordered)
    }
}
