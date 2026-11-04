import ImageIO
import PDFKit
import QuickLook
import SwiftUI
import WebKit

/// One directory of the session workspace (the workbench 文件 tab): folders
/// push, files open their preview; files this session changed are marked. The
/// listing follows `workspaceFiles/changes` while on screen (S-75).
struct DirectoryView: View {
    @Environment(AppModel.self) private var app
    let sessionId: String
    let path: String
    let title: String
    let root: String?
    var modified: Set<String> = []
    @State private var entries: [(name: String, type: String, size: Int?)] = []
    @State private var truncated = false
    @State private var error: String?
    @State private var loading = true
    @State private var query = ""
    @State private var pendingReload: Task<Void, Never>?

    private var shown: [(name: String, type: String, size: Int?)] {
        let needle = query.trimmed.lowercased()
        return needle.isEmpty ? entries : entries.filter { $0.name.lowercased().contains(needle) }
    }

    var body: some View {
        List {
            Section {
                if let error { Text(error).foregroundStyle(Palette.removed) }
                ForEach(shown, id: \.name) { entry in
                    let child = path == "." ? entry.name : "\(path)/\(entry.name)"
                    if entry.type == "other" {
                        // Neither a file nor a directory: nothing to open.
                        row(entry, child)
                            .opacity(0.45)
                            .accessibilityHint("这不是文件或目录，没法打开。")
                    } else {
                        NavigationLink {
                            if entry.type == "directory" {
                                DirectoryView(sessionId: sessionId, path: child, title: entry.name, root: root, modified: modified)
                            } else {
                                FileContentView(sessionId: sessionId, path: child, root: root)
                            }
                        } label: {
                            row(entry, child)
                        }
                        .contextMenu {
                            Button { copyToPasteboard(absolute(child)) } label: { Label("复制路径", systemImage: "doc.on.doc") }
                            Button { copyToPasteboard(child) } label: { Label("复制相对路径", systemImage: "doc.on.clipboard") }
                        }
                    }
                }
                if truncated { Text("条目太多，只显示了一部分。").font(.footnote).foregroundStyle(Palette.secondary) }
            } header: {
                VStack(alignment: .leading, spacing: 10) {
                    if entries.count > 1 || !query.isEmpty { searchField }
                    Text(displayPath).font(.footnote).foregroundStyle(Palette.secondary).textCase(nil)
                        .lineLimit(1).truncationMode(.head)
                }
            }
            .groupedRow()
        }
        .groupedList()
        .overlay {
            if loading {
                ProgressView()
            } else if entries.isEmpty && error == nil {
                ContentUnavailableView("空文件夹", systemImage: "folder")
            } else if shown.isEmpty && error == nil {
                ContentUnavailableView.search(text: query)
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        // Lists, then follows; a reconnect drops the stream and may have missed changes.
        .task(id: app.generation) { await watch() }
        .onDisappear { pendingReload?.cancel() }
    }

    /// The workbench hides the navigation bar on its root, so the field sits in the list.
    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(Palette.faint)
            TextField("筛选此文件夹", text: $query)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            if !query.isEmpty {
                Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Palette.faint).contentShape(Rectangle().inset(by: -8)) }
                    .accessibilityLabel("清空搜索")
            }
        }
        .font(.subheadline)
        .textCase(nil)
        .padding(.horizontal, 12)
        .frame(minHeight: 36)
        .background(Palette.bubble, in: Capsule())
    }

    private func row(_ entry: (name: String, type: String, size: Int?), _ child: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: entry.type == "directory" ? "folder" : "doc").foregroundStyle(Palette.secondary).frame(width: 20)
            Text(entry.name).font(.callout).lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 8)
            Group {
                if modified.contains(child) || (entry.type == "directory" && modified.contains { $0.hasPrefix(child + "/") }) {
                    Text("已修改")
                } else if let size = entry.size, entry.type != "directory" {
                    Text(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))
                }
            }
            .font(.footnote)
            .foregroundStyle(Palette.secondary)
        }
        .frame(minHeight: 34)
    }

    /// `~/…`, as the design shows workspace paths.
    private var displayPath: String {
        let base = root.map { path == "." ? $0 : "\($0)/\(path)" } ?? path
        return base.hasPrefix(EnginePaths.home) ? "~" + base.dropFirst(EnginePaths.home.count) : base
    }

    private func absolute(_ child: String) -> String { root.map { "\($0)/\(child)" } ?? child }

    private func load() async {
        do {
            let value = try await app.client.call("workspaceFiles/list", ["workspaceFileScopeId": .string(sessionId), "path": .string(path)])
            entries = value["entries"].array.map { ($0["name"].string ?? "", $0["type"].string ?? "other", $0["size"].int) }
                .sorted { lhs, rhs in
                    if (lhs.type == "directory") != (rhs.type == "directory") { return lhs.type == "directory" }
                    return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
                }
            truncated = value["truncated"].bool ?? false
            error = nil
        } catch is CancellationError {
        } catch let failure as URLError where failure.code == .cancelled {
        } catch {
            self.error = Self.message(error)
        }
        loading = false
    }

    private static func message(_ error: Error) -> String {
        switch (error as? EngineError)?.code {
        case "workspace-file/not-found": return String(localized: "这个目录不在了。可能已被移动或删除。")
        case "workspace-file/outside-workspace": return String(localized: "这个目录在工作区之外，无法读取。")
        case "workspace-file/not-directory": return String(localized: "这不是一个目录。")
        default: return String(localized: "读取失败：\(error.localizedDescription)")
        }
    }

    /// Re-list on each change after `ready`, coalescing a burst. A backend that
    /// cannot watch fails this stream, and the page stays on manual refresh.
    private func watch() async {
        await load()
        do {
            for try await frame in app.mux.open("workspaceFiles/changes", ["workspaceFileScopeId": .string(sessionId), "path": .string(path)]) {
                guard frame["kind"].string == "change" else { continue }
                pendingReload?.cancel()
                pendingReload = Task {
                    try? await Task.sleep(for: .milliseconds(300))
                    if !Task.isCancelled { await load() }
                }
            }
        } catch {}
    }
}

/// A file link opened from a reply (C-23): the preview in its own sheet.
struct FilePreviewSheet: View {
    let sessionId: String
    let path: String
    let root: String?
    let lines: ClosedRange<Int>?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            FileContentView(sessionId: sessionId, path: path, root: root, lines: lines)
                .closeButton(dismiss)
        }
    }
}

/// One file (S-78): the renderer its name selects, 打开方式 where there are
/// alternatives, and a banner when the file changes under the open preview.
/// Workspace files live in the app's own container, so image and PDF bytes come
/// straight from disk; text goes through `workspaceFiles/read`, page by page.
/// `lines` (from a `#L24-L30` link) is highlighted and scrolled to.
struct FileContentView: View {
    @Environment(AppModel.self) private var app
    let sessionId: String
    let path: String
    let root: String?
    var lines: ClosedRange<Int>? = nil

    @State private var chosen: FileRenderer?
    @State private var firstLine = 1
    @State private var text: [String] = []
    @State private var eof = true
    @State private var loaded = false
    @State private var loadingMore = false
    @State private var failure: FileFailure?
    /// The tail page failed; what is on screen stays.
    @State private var moreFailed: String?
    @State private var absolutePath: String?
    @State private var version: String?
    /// The version `workspaceFiles/changes` last reported.
    @State private var observed: String?
    @State private var absent = false
    @State private var wrap = true
    @State private var preview: URL?
    /// Bumped by 重新读取: renderers that hold decoded bytes start over.
    @State private var revision = 0
    private let limit = 5000

    private var name: String { URL(fileURLWithPath: path).lastPathComponent }
    private var renderers: [FileRenderer] { FileRenderer.candidates(for: name) }
    /// A `#L` link needs line anchors, which rendered Markdown does not have.
    private var renderer: FileRenderer { chosen ?? (lines != nil && renderers.contains(.text) ? .text : renderers[0]) }

    var body: some View {
        Group {
            if let failure, !(renderer.pagesText && loaded) {
                failed(failure)
            } else if !loaded && renderer != .unsupported {
                VStack(spacing: 12) {
                    ProgressView()
                    Text("文档渲染中...").font(.footnote).foregroundStyle(Palette.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                switch renderer {
                case .text: plainText
                case .markdown: markdown
                case .image: if let localURL { ZoomableImage(url: localURL).id(revision) }
                case .webImage: if let localURL { InlineImageWebView(url: localURL).id(revision) }
                case .pdf: if let localURL { PDFPreview(url: localURL).id(revision) }
                case .unsupported: unsupported
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Palette.background)
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .top, spacing: 0) { banner }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { actions }
        }
        .quickLookPreview($preview)
        .task(id: LoadKey(renderer: renderer, revision: revision)) { await load() }
        .task(id: app.generation) { await watch() }
    }

    private struct LoadKey: Hashable { let renderer: FileRenderer; let revision: Int }

    /// Older content stays readable under a notice with one way to catch up.
    @ViewBuilder
    private var banner: some View {
        if absent || (observed != nil && version != nil && observed != version) {
            HStack(spacing: 12) {
                Text(absent ? "文件不存在，可能已被移动或删除" : "文件已更新，当前显示为旧内容")
                    .font(.footnote).foregroundStyle(Palette.ink)
                Spacer(minLength: 0)
                if !absent {
                    Button("重新载入") { reload() }.buttonStyle(.capsule(.secondary, height: 44, fill: false))
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 4)
            .background(Palette.grouped)
        }
    }

    private var actions: some View {
        Menu {
            if renderers.count > 1 {
                Picker("打开方式", selection: Binding(get: { renderer }, set: { chosen = $0; Haptics.select() })) {
                    ForEach(renderers, id: \.self) { Text($0.label).tag($0) }
                }
            }
            if renderer == .text {
                Toggle("自动换行", isOn: $wrap)
            }
            Button { reload() } label: { Label("重新读取文件", systemImage: "arrow.clockwise") }
            if let localURL {
                Button { copyToPasteboard(localURL.path) } label: { Label("复制路径", systemImage: "doc.on.doc") }
                Button { preview = localURL } label: { Label("快速查看", systemImage: "eye") }
                ShareLink(item: localURL)
            }
        } label: {
            Image(systemName: "ellipsis")
        }
        .accessibilityLabel("文件操作")
    }

    private func failed(_ failure: FileFailure) -> some View {
        ContentUnavailableView {
            Label("无法打开文件", systemImage: "doc.questionmark")
        } description: {
            Text(failure.message)
        } actions: {
            if failure.retry { Button("重试") { reload() } }
            if failure.external, let localURL { Button("用快速查看打开") { preview = localURL } }
        }
    }

    private var unsupported: some View {
        ContentUnavailableView {
            Label("该格式文件暂时无法预览", systemImage: "doc")
        } actions: {
            if let localURL {
                Button("用快速查看打开") { preview = localURL }
                ShareLink(item: localURL)
            }
        }
    }

    // MARK: Text

    private var plainText: some View {
        ScrollViewReader { proxy in
            ScrollView(wrap ? .vertical : [.vertical, .horizontal]) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if firstLine > 1 { note("从第 \(firstLine) 行开始显示") }
                    let digits = String(firstLine + text.count).count
                    ForEach(text.indices, id: \.self) { index in
                        row(firstLine + index, text[index], digits: digits)
                    }
                    moreRow.padding(.horizontal)
                }
                .padding(.vertical)
            }
            // Short files start at the top left instead of being centred.
            .defaultScrollAnchor(.topLeading)
            .refreshable { reload() }
            .onAppear { if let lines { proxy.scrollTo(lines.lowerBound, anchor: .center) } }
        }
    }

    private func row(_ number: Int, _ line: String, digits: Int) -> some View {
        let marked = lines?.contains(number) ?? false
        return HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(String(number))
                .foregroundStyle(marked ? AnyShapeStyle(Palette.ink) : AnyShapeStyle(.tertiary))
                .fixedSize()
                .frame(minWidth: CGFloat(digits) * 9, alignment: .trailing)
            // Without wrapping, long lines scroll sideways.
            Group {
                if wrap {
                    Text(line.isEmpty ? " " : line).frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Text(line.isEmpty ? " " : line).fixedSize()
                }
            }
            .textSelection(.enabled)
        }
        .font(.system(.footnote, design: .monospaced))
        .padding(.horizontal)
        .padding(.vertical, 1)
        .background(marked ? Palette.ink.opacity(0.12) : .clear)
        .id(number)
    }

    private func note(_ text: LocalizedStringKey) -> some View {
        Text(text).font(.caption).foregroundStyle(.secondary).padding(.horizontal).padding(.vertical, 6)
    }

    /// The tail of a paged file: reaching it reads the next page.
    @ViewBuilder
    private var moreRow: some View {
        if let moreFailed {
            HStack {
                Text(moreFailed).font(.footnote).foregroundStyle(Palette.removed)
                Spacer()
                Button("重试") { Task { await loadMore() } }.font(.footnote)
            }
            .padding(.vertical, 8)
        } else if !eof {
            Button { Task { await loadMore() } } label: {
                HStack(spacing: 6) {
                    if loadingMore { ProgressView().controlSize(.small) }
                    Text("加载更多")
                }
                .font(.footnote)
                .frame(maxWidth: .infinity, minHeight: 36)
            }
            .disabled(loadingMore)
            .onAppear { Task { await loadMore() } }
        }
    }

    // MARK: Markdown

    private var markdown: some View {
        let document = MarkdownDocument(text.joined(separator: "\n"))
        return ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if !document.fields.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(document.fields, id: \.key) { field in
                            HStack(alignment: .firstTextBaseline, spacing: 12) {
                                Text(field.key).foregroundStyle(Palette.secondary)
                                Text(field.value).textSelection(.enabled)
                            }
                        }
                    }
                    .font(.footnote)
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Palette.grouped, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                } else if let raw = document.rawFrontmatter {
                    Text(raw).font(.footnote.monospaced()).foregroundStyle(Palette.secondary)
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Palette.grouped, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
                MarkdownView(text: document.body)
                moreRow
            }
            .padding(20)
        }
        .refreshable { reload() }
    }

    // MARK: Loading

    private func reload() {
        revision += 1
    }

    private func load() async {
        failure = nil
        moreFailed = nil
        guard renderer != .unsupported else {
            // Binary formats are not read; 快速查看 only needs the path.
            await stat()
            return
        }
        if renderer.pagesText { await loadText() } else { await loadBytes() }
    }

    /// Fresh metadata; the renderers read the bytes from disk themselves.
    private func stat() async {
        do {
            let value = try await app.client.call("workspaceFiles/stat", ["workspaceFileScopeId": .string(sessionId), "path": .string(path)])
            absolutePath = value["absolutePath"].string
            version = value["version"].string
            observed = version
            absent = false
            loaded = true
        } catch {
            consume(error)
        }
    }

    private func loadBytes() async {
        await stat()
        if failure == nil, localURL == nil { failure = FileFailure(message: String(localized: "文件不存在，可能已被移动或删除"), retry: true, external: false) }
    }

    private func loadText() async {
        // Pages hold at most `limit` lines; start early enough to show the
        // linked lines with some context before them.
        let offset = lines.map { $0.lowerBound > limit - 500 ? $0.lowerBound - 500 : 1 } ?? 1
        do {
            let value = try await read(offset)
            firstLine = offset
            text = Self.split(value)
            eof = value["eof"].bool ?? true
            absolutePath = value["absolutePath"].string
            version = value["version"].string
            observed = version
            absent = false
            loaded = true
        } catch {
            consume(error)
        }
    }

    private func read(_ offset: Int) async throws -> JSON {
        try await app.client.call("workspaceFiles/read", ["workspaceFileScopeId": .string(sessionId), "path": .string(path), "range": ["offset": .number(Double(offset)), "limit": .number(Double(limit))]])
    }

    private static func split(_ page: JSON) -> [String] {
        (page["lines"].int ?? 0) == 0 ? [] : (page["text"].string ?? "").components(separatedBy: "\n")
    }

    private func loadMore() async {
        guard !eof, !loadingMore else { return }
        loadingMore = true
        moreFailed = nil
        defer { loadingMore = false }
        do {
            let value = try await read(firstLine + text.count)
            // The file changed between pages: its lines no longer line up, start over.
            if value["version"].string != version {
                revision += 1
                return
            }
            text += Self.split(value)
            eof = value["eof"].bool ?? true
        } catch {
            if !Self.isCancellation(error) { moreFailed = FileFailure(error).message }
        }
    }

    private func consume(_ error: Error) {
        guard !Self.isCancellation(error) else { return }
        let failure = FileFailure(error)
        if renderer.pagesText, loaded {
            // A re-read failed: what is on screen stays.
            app.showToast(failure.message)
        } else if renderer.pagesText, (error as? EngineError)?.code == "workspace-file/not-text" {
            chosen = .unsupported
        } else {
            self.failure = failure
        }
    }

    private static func isCancellation(_ error: Error) -> Bool {
        error is CancellationError || (error as? URLError)?.code == .cancelled
    }

    /// `workspaceFiles/changes` for this file; a backend that cannot watch just never reports.
    private func watch() async {
        do {
            for try await frame in app.mux.open("workspaceFiles/changes", ["workspaceFileScopeId": .string(sessionId), "path": .string(path)]) {
                guard frame["kind"].string == "change" else { continue }
                let change = frame["change"]
                absent = change["absent"].bool ?? false
                if let version = change["version"].string { observed = version }
            }
        } catch {}
    }

    /// Workspace files are on this device; Quick Look and sharing read them directly.
    private var localURL: URL? {
        let url: URL
        if let absolutePath { url = EnginePaths.real(absolutePath) }
        else if path.hasPrefix("/") { url = EnginePaths.real(path) }
        else if let root { url = EnginePaths.real(root).appendingPathComponent(path) }
        else { return nil }
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }
}

/// How a file can be shown, picked by name as the web's preview registry does.
enum FileRenderer: Hashable {
    case text, markdown, image, webImage, pdf, unsupported

    var pagesText: Bool { self == .text || self == .markdown }

    var label: LocalizedStringKey {
        switch self {
        case .text: "纯文本"
        case .markdown: "Markdown"
        case .image, .webImage: "图片"
        case .pdf: "PDF"
        case .unsupported: "快速查看"
        }
    }

    private static let images: Set<String> = ["png", "jpg", "jpeg", "webp", "bmp", "ico", "heic", "heif", "tiff", "tif", "avif"]
    /// Known binary formats: reading them as text only ends in a failure.
    private static let binary: Set<String> = [
        "mp4", "mov", "avi", "mkv", "webm", "flv", "wmv", "m4v", "mp3", "wav", "flac", "ogg", "m4a", "aac", "wma", "opus",
        "zip", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar", "tar", "jar",
        "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "pages", "numbers",
        "exe", "dll", "so", "dylib", "bin", "o", "class", "pyc", "wasm", "ttf", "otf", "woff", "woff2", "eot",
        "dmg", "iso", "img", "sqlite", "db", "psd", "ai", "sketch",
    ]

    /// Renderers in 打开方式 order; the first is the default.
    static func candidates(for name: String) -> [FileRenderer] {
        let ext = (name as NSString).pathExtension.lowercased()
        if ext == "md" || ext == "markdown" { return [.markdown, .text] }
        if ext == "svg" { return [.webImage, .text] }
        if ext == "gif" { return [.webImage] }
        if images.contains(ext) { return [.image] }
        if ext == "pdf" { return [.pdf] }
        if binary.contains(ext) { return [.unsupported] }
        return [.text]
    }
}

/// A failed read in the preview's words, with the ways out it allows.
struct FileFailure: Equatable {
    var message: String
    /// Worth reading again.
    var retry = true
    /// Quick Look may still open what the text reader refused.
    var external = false

    init(message: String, retry: Bool, external: Bool) {
        self.message = message
        self.retry = retry
        self.external = external
    }

    init(_ error: Error) {
        let failure = error as? EngineError
        switch failure?.code {
        case "workspace-file/not-found":
            self.init(message: String(localized: "文件不存在，可能已被移动或删除"), retry: false, external: false)
        case "workspace-file/not-regular-file":
            self.init(message: String(localized: "该路径不是普通文件，没有可显示的内容"), retry: false, external: false)
        case "workspace-file/not-text":
            self.init(message: String(localized: "该格式文件暂时无法预览"), retry: false, external: true)
        case "workspace-file/too-large":
            let limit = failure?.detail["details"]["limit"].int ?? 0
            let size = ByteCountFormatter.string(fromByteCount: Int64(limit), countStyle: .binary)
            self.init(message: String(localized: "单页内容超过 \(size) 上限，无法读取"), retry: false, external: true)
        default:
            self.init(message: String(localized: "读取失败：\(error.localizedDescription)"), retry: true, external: false)
        }
    }
}

/// A Markdown file split into its frontmatter and body. Flat `key: value`
/// frontmatter shows as fields; anything richer stays as written.
struct MarkdownDocument {
    var fields: [(key: String, value: String)] = []
    var rawFrontmatter: String?
    var body: String

    init(_ text: String) {
        body = text
        let lines = text.components(separatedBy: "\n")
        guard lines.first == "---", let end = lines.dropFirst().firstIndex(where: { $0 == "---" || $0 == "..." }) else { return }
        let front = lines[1..<end].filter { !$0.trimmed.isEmpty }
        body = lines[(end + 1)...].joined(separator: "\n")
        let pairs = front.compactMap { line -> (key: String, value: String)? in
            guard !line.hasPrefix(" "), !line.hasPrefix("-"), let colon = line.firstIndex(of: ":") else { return nil }
            return (String(line[..<colon]).trimmed, String(line[line.index(after: colon)...]).trimmed)
        }
        if pairs.count == front.count, Set(pairs.map(\.key)).count == pairs.count { fields = pairs } else { rawFrontmatter = front.joined(separator: "\n") }
    }
}

// MARK: Renderers

/// An image fit to the width (small ones stay at their size), pinch to zoom, double tap to toggle.
struct ZoomableImage: View {
    let url: URL
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        Group {
            if let image {
                ZoomingImageView(image: image).ignoresSafeArea(edges: .bottom)
            } else if failed {
                ContentUnavailableView("无法显示这张图片", systemImage: "photo")
            } else {
                ProgressView()
            }
        }
        .task {
            let url = url
            let decoded = await Task.detached(priority: .userInitiated) { Self.decode(url) }.value
            image = decoded
            failed = decoded == nil
        }
    }

    /// Downsampled: a camera photo decoded whole costs hundreds of megabytes on a phone.
    private nonisolated static func decode(_ url: URL) -> UIImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: 4096,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary).map { UIImage(cgImage: $0) }
    }
}

private struct ZoomingImageView: UIViewRepresentable {
    let image: UIImage

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> FittingScrollView {
        let view = FittingScrollView()
        view.delegate = context.coordinator
        view.maximumZoomScale = 8
        view.showsVerticalScrollIndicator = false
        view.showsHorizontalScrollIndicator = false
        view.contentInsetAdjustmentBehavior = .never
        view.imageView.image = image
        view.imageView.sizeToFit()
        view.addSubview(view.imageView)
        view.contentSize = image.size
        context.coordinator.view = view
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.toggleZoom(_:)))
        tap.numberOfTapsRequired = 2
        view.addGestureRecognizer(tap)
        return view
    }

    func updateUIView(_ view: FittingScrollView, context: Context) {}

    final class Coordinator: NSObject, UIScrollViewDelegate {
        weak var view: FittingScrollView?

        func viewForZooming(in scrollView: UIScrollView) -> UIView? { view?.imageView }
        func scrollViewDidZoom(_ scrollView: UIScrollView) { view?.center() }

        @objc func toggleZoom(_ gesture: UITapGestureRecognizer) {
            guard let view else { return }
            view.setZoomScale(view.zoomScale > view.minimumZoomScale ? view.minimumZoomScale : min(view.minimumZoomScale * 2.5, view.maximumZoomScale), animated: true)
        }
    }

    final class FittingScrollView: UIScrollView {
        let imageView = UIImageView()
        private var fittedWidth: CGFloat = 0

        override func layoutSubviews() {
            super.layoutSubviews()
            if bounds.width > 0, bounds.width != fittedWidth, let image = imageView.image, image.size.width > 0 {
                fittedWidth = bounds.width
                // Fit the width, but never enlarge a small image.
                let fit = min(1, bounds.width / image.size.width)
                minimumZoomScale = fit
                zoomScale = fit
            }
            center()
        }

        func center() {
            let frame = imageView.frame
            imageView.frame.origin = CGPoint(x: max(0, (bounds.width - frame.width) / 2), y: max(0, (bounds.height - frame.height) / 2))
        }
    }
}

/// SVG and animated GIF: an `<img>` in a web view with scripts off, so an SVG's own script never runs.
struct InlineImageWebView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        if let data = try? Data(contentsOf: url) {
            let type = url.pathExtension.lowercased() == "svg" ? "image/svg+xml" : "image/gif"
            view.loadHTMLString("""
            <!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
            <body style="margin:12px;display:flex;justify-content:center"><img style="max-width:100%;height:auto" src="data:\(type);base64,\(data.base64EncodedString())">
            """, baseURL: nil)
        }
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}
}

/// PDFKit: selectable text, pinch zoom, continuous pages.
struct PDFPreview: View {
    let url: URL
    @State private var document: PDFDocument?
    @State private var failed = false

    var body: some View {
        Group {
            if let document {
                if document.isLocked {
                    ContentUnavailableView("此 PDF 需要密码，暂不支持预览", systemImage: "lock.doc")
                } else {
                    PDFKitView(document: document).ignoresSafeArea(edges: .bottom)
                }
            } else if failed {
                ContentUnavailableView("无法显示 PDF", systemImage: "doc.richtext")
            } else {
                ProgressView()
            }
        }
        .task {
            let url = url
            let opened = await Task.detached(priority: .userInitiated) { PDFDocument(url: url) }.value
            document = opened
            failed = opened == nil
        }
    }
}

private struct PDFKitView: UIViewRepresentable {
    let document: PDFDocument

    func makeUIView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.displayDirection = .vertical
        view.backgroundColor = UIColor(named: "Background") ?? .systemBackground
        view.document = document
        return view
    }

    func updateUIView(_ view: PDFView, context: Context) {}
}
