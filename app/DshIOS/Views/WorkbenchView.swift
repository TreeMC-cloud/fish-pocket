import SwiftUI

enum WorkbenchTab: String, CaseIterable, Identifiable {
    case terminal, files, browser, changes, context
    var id: String { rawValue }

    var title: LocalizedStringKey {
        switch self {
        case .terminal: "终端"
        case .files: "文件"
        case .browser: "浏览器"
        case .changes: "改动"
        case .context: "上下文"
        }
    }
}

/// The session's tools in one place: terminal, files, a browser, the changes this
/// session made, and context / usage. A sheet on a phone, a side column on iPad.
struct WorkbenchView: View {
    let model: SessionModel
    /// Kept by the conversation, which can also ask for a tab while this is open.
    @Binding var tab: WorkbenchTab
    /// Kept by the conversation, so the page outlives this view.
    @Binding var browser: BrowserModel?
    let close: () -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.horizontalSizeClass) private var sizeClass
    /// A page is created on its first visit (the terminal only attaches then) and
    /// stays, so switching tabs leaves it where it was.
    @State private var visited: Set<WorkbenchTab> = []

    var body: some View {
        Group {
            // Beside the conversation, its toolbar button opens and closes this.
            if sizeClass == .regular {
                content
            } else {
                NavigationStack {
                    content
                        .navigationTitle("工作台")
                        .navigationBarTitleDisplayMode(.inline)
                        // Stated, as in the conversation: the files and changes pages hide the bar
                        // of their own stacks, and that would take this one, with ✕, along.
                        .toolbar(.visible, for: .navigationBar)
                        .closeButton(action: close)
                }
            }
        }
        .onChange(of: tab, initial: true) { _, selected in
            // A keyboard belongs to the tab that raised it.
            dismissKeyboard()
            visited.insert(selected)
            if selected == .browser, browser == nil { browser = BrowserModel(sessionId: model.sessionId, origin: app.client.origin) }
        }
    }

    private var content: some View {
        VStack(spacing: 0) {
            tabs
            ZStack {
                page(.terminal) { WorkbenchTerminal(sessionId: model.sessionId) }
                page(.files) { WorkbenchFiles(model: model) }
                page(.browser) { if let browser { WorkbenchBrowser(model: browser) } }
                page(.changes) { WorkbenchChanges(model: model) }
                page(.context) { WorkbenchContext(model: model, close: close) }
            }
        }
        .background(Palette.background)
    }

    private var tabs: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 2) {
                    ForEach(WorkbenchTab.allCases) { item in
                        Button { if tab != item { Haptics.select() }; tab = item } label: {
                            Text(item.title)
                                .font(.subheadline.weight(tab == item ? .semibold : .medium))
                                .foregroundStyle(tab == item ? Palette.onInk : Palette.secondary)
                                .padding(.horizontal, 12)
                                .frame(minHeight: 36)
                                .background { if tab == item { Capsule().fill(Palette.ink) } }
                                .hitTarget()
                        }
                        .buttonStyle(.plain)
                        .id(item)
                        .accessibilityAddTraits(tab == item ? [.isSelected, .isButton] : .isButton)
                    }
                }
                .padding(.horizontal, 16)
            }
            .onChange(of: tab) { _, item in withAnimation(.snappy) { proxy.scrollTo(item) } }
        }
        .padding(.vertical, 8)
    }

    @ViewBuilder
    private func page<Content: View>(_ item: WorkbenchTab, @ViewBuilder content: () -> Content) -> some View {
        if tab == item || visited.contains(item) {
            content()
                .opacity(tab == item ? 1 : 0)
                .allowsHitTesting(tab == item)
                .accessibilityHidden(tab != item)
        }
    }
}

// MARK: Terminal

private struct WorkbenchTerminal: View {
    let sessionId: String
    @Environment(AppModel.self) private var app
    @State private var connection: TerminalConnection?
    @State private var terminals: [(id: String, title: String, exited: Bool)] = []
    @State private var error: String?
    @State private var renaming = false
    @State private var newTitle = ""
    @State private var fontSize: CGFloat = 13

    private var current: String? { connection?.terminalId }

    var body: some View {
        VStack(spacing: 0) {
            statusLine
            Group {
                if let connection, connection.phase != .missing {
                    // A new view per terminal: the emulator keeps one screen.
                    GeometryReader { geometry in
                        TerminalHost(connection: connection, width: geometry.size.width, fontSize: fontSize)
                    }
                    .id(connection.id)
                    .padding(.horizontal, 6)
                    .padding(.top, 6)
                } else if connection != nil {
                    ContentUnavailableView {
                        Label("此终端已不存在，请新建终端。", systemImage: "apple.terminal")
                    } actions: {
                        Button("新建终端") { Task { await replace() } }
                    }
                } else if let error {
                    ContentUnavailableView {
                        Label("终端不可用", systemImage: "apple.terminal")
                    } description: {
                        Text(error)
                    } actions: {
                        Button("重试") { retry() }
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            TerminalKeyBar(control: connection?.controlActive == true) {
                connection?.press($0)
            } paste: {
                connection?.paste($0)
            } focus: {
                connection?.focus()
            } menu: {
                terminalMenu
            }
        }
        // Edge to edge: every column of a phone's width goes to the terminal.
        .background(Palette.grouped.ignoresSafeArea())
        .task { await reload() }
        .task(id: app.revision("settings/document-updated")) { await loadFontSize() }
        // The attachment does not survive a dropped connection; the new one brings a fresh screen.
        .onChange(of: app.generation) { _, _ in if connection?.phase == .disconnected { connection?.connect() } }
        .onDisappear { connection?.close() }
        .alert("终端名称", isPresented: $renaming) {
            TextField("终端名称", text: $newTitle)
            Button("取消", role: .cancel) {}
            Button("保存") { Task { await rename() } }
                .disabled(newTitle.trimmed.isEmpty || newTitle.trimmed.count > 120)
        }
    }

    /// S-95 / S-94: what the attachment is doing when it is not simply connected.
    @ViewBuilder
    private var statusLine: some View {
        if let connection, connection.phase != .missing {
            if connection.exited {
                status("进程已退出（\(connection.info["exitCode"].int.map(String.init) ?? "—")）", "新建终端") { Task { await replace() } }
            } else if connection.info["state"].string == "failed" {
                status("终端错误：\(connection.info["error"].string ?? String(localized: "不可用"))", "新建终端") { Task { await replace() } }
            } else {
                switch connection.phase {
                case .connecting:
                    status("正在连接…", nil) {}
                case .disconnected:
                    status("连接已断开。", "重新连接") { connection.connect() }
                case .failed(let message):
                    status("终端错误：\(message)", "重试") { connection.connect() }
                case .connected where !connection.writable:
                    status("此终端当前只读。", "接管输入") { connection.connect() }
                default:
                    EmptyView()
                }
            }
        }
    }

    private func status(_ text: String, _ action: LocalizedStringKey?, perform: @escaping () -> Void) -> some View {
        HStack(spacing: 12) {
            Text(text).font(.footnote).foregroundStyle(Palette.secondary).lineLimit(2)
            Spacer(minLength: 0)
            if let action {
                Button(action, action: perform).buttonStyle(.capsule(.secondary, height: 44, fill: false))
            }
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 44)
    }

    private var terminalMenu: some View {
        Menu {
            ForEach(terminals, id: \.id) { terminal in
                Button { attach(terminal.id) } label: {
                    let title = terminal.exited ? "\(terminal.title)（已退出）" : terminal.title
                    if terminal.id == current { Label(title, systemImage: "checkmark") } else { Text(title) }
                }
            }
            Divider()
            Button { Task { await create() } } label: { Label("新建终端", systemImage: "plus") }
            if let current {
                Button {
                    newTitle = terminals.first { $0.id == current }?.title ?? ""
                    renaming = true
                } label: { Label("重命名", systemImage: "pencil") }
                Button(role: .destructive) {
                    Task {
                        await closeCurrent()
                        await reload()
                    }
                } label: { Label("关闭此终端", systemImage: "xmark") }
            }
        } label: {
            Image(systemName: "rectangle.stack").font(.subheadline).foregroundStyle(Palette.ink)
                .frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .accessibilityLabel("终端列表")
    }

    private func retry() {
        error = nil
        Task { await reload() }
    }

    private func loadTerminals() async -> [JSON] {
        let list = (try? await app.client.call("terminal/list", ["sessionId": .string(sessionId)]))?.array ?? []
        terminals = list.map { ($0["id"].string ?? "", $0["title"].string ?? "bash", $0["state"].string != "running") }
        return list
    }

    private func reload() async {
        let list = await loadTerminals()
        if let running = list.first(where: { $0["state"].string == "running" })?["id"].string { attach(running) } else { await create() }
    }

    private func create() async {
        do {
            let id = UUID().uuidString.lowercased()
            _ = try await app.client.call("terminal/create", ["agentId": .string(sessionId), "request": ["id": .string(id), "cols": 80, "rows": 24]])
            error = nil
            _ = await loadTerminals()
            attach(id)
        } catch let failure as EngineError where failure.code == "terminal/limit-reached" {
            // S-90: exited terminals count, and the menu is how to close them.
            _ = await loadTerminals()
            let message = String(localized: "终端数量已达上限，请关闭不用的终端后重试。已退出的终端也计入数量。")
            if connection == nil, let first = terminals.first { attach(first.id) }
            if connection == nil { error = message } else { app.showToast(message) }
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func closeCurrent() async {
        guard let current else { return }
        connection?.close()
        connection = nil
        _ = try? await app.client.call("terminal/close", ["agentId": .string(sessionId), "id": .string(current)])
    }

    /// A new terminal in place of an ended one, which would otherwise keep counting toward the limit.
    private func replace() async {
        await closeCurrent()
        await create()
    }

    private func attach(_ id: String) {
        guard id != current || connection?.phase == .missing else { return }
        connection?.close()
        connection = TerminalConnection(mux: app.mux, client: app.client, sessionId: sessionId, terminalId: id)
    }

    /// S-96.
    private func rename() async {
        guard let current else { return }
        let title = newTitle.trimmed
        do {
            _ = try await app.client.call("terminal/rename", ["agentId": .string(sessionId), "id": .string(current), "title": .string(title)])
            _ = await loadTerminals()
        } catch {
            app.showToast(error.localizedDescription)
        }
    }

    /// S-98: `ui-theme.terminalFontSize` (10–20, default 13).
    private func loadFontSize() async {
        guard let value = try? await app.client.call("settings/describe") else { return }
        let theme = value["namespaces"].array.first { $0["ns"].string == "ui-theme" }
        if let size = theme?["value"]["terminalFontSize"].double { fontSize = CGFloat(min(20, max(10, size))) }
    }
}

/// The key strip under the terminal: keys the keyboard lacks scroll sideways, the
/// terminal list and the keyboard switch stay in reach.
private struct TerminalKeyBar<Menu: View>: View {
    let control: Bool
    let press: (TerminalKey) -> Void
    let paste: (String) -> Void
    let focus: () -> Void
    @ViewBuilder let menu: Menu
    @State private var keyboardUp = false

    var body: some View {
        HStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(TerminalKey.allCases, id: \.self) { key in
                        let held = key == .control && control
                        Button { Haptics.soft(); press(key) } label: {
                            Text(key.label)
                                .font(.footnote.monospaced())
                                .foregroundStyle(held ? Palette.onInk : Palette.ink)
                                .padding(.horizontal, 8)
                                .frame(minWidth: 44, minHeight: 44)
                                .background(held ? Palette.ink : Palette.bubble, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(key.accessibilityLabel)
                        .accessibilityAddTraits(held ? [.isButton, .isSelected] : .isButton)
                    }
                    // The system control: a button of our own would raise the paste prompt on every press.
                    PasteButton(payloadType: String.self) { items in
                        if let text = items.first { paste(text) }
                    }
                    .labelStyle(.titleOnly)
                    .buttonBorderShape(.capsule)
                    .controlSize(.large)
                    .tint(Palette.ink)
                }
                .padding(.horizontal, 10)
            }
            menu
            Button {
                Haptics.soft()
                if keyboardUp { dismissKeyboard() } else { focus() }
            } label: {
                Image(systemName: keyboardUp ? "keyboard.chevron.compact.down" : "keyboard")
                    .font(.subheadline)
                    .foregroundStyle(Palette.ink)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(keyboardUp ? "收起键盘" : "打开键盘")
        }
        .padding(.top, 6)
        .padding(.bottom, 8)
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in keyboardUp = true }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in keyboardUp = false }
    }
}

// MARK: Files

private struct WorkbenchFiles: View {
    let model: SessionModel

    var body: some View {
        NavigationStack {
            DirectoryView(
                sessionId: model.sessionId,
                path: ".",
                // This title reaches the sheet's bar; the folder is named by the path under the tabs.
                title: String(localized: "工作台"),
                root: model.workingDirectory,
                modified: Set(FileChange.collect(model.items.allBlocks, root: model.workingDirectory).map(\.path))
            )
            .toolbar(.hidden, for: .navigationBar)
        }
    }
}

// MARK: Changes

/// S-57: the files this session edited; a row pushes that file's diff, and the
/// whole file is one step further. Built from the tool calls in the timeline.
private struct WorkbenchChanges: View {
    let model: SessionModel

    var body: some View {
        let changes = FileChange.collect(model.items.allBlocks, root: model.workingDirectory)
        NavigationStack {
            Group {
                if changes.isEmpty {
                    ContentUnavailableView("还没有改动", systemImage: "doc.text.magnifyingglass", description: Text("智能体改过的文件会显示在这里。"))
                } else {
                    List {
                        Section {
                            ForEach(changes) { change in
                                NavigationLink(value: change.path) { ChangedFileRow(change: change) }
                                    .contextMenu {
                                        Button { copyToPasteboard(change.path) } label: { Label("复制路径", systemImage: "doc.on.doc") }
                                    }
                            }
                        } header: {
                            HStack(spacing: 8) {
                                Text("\(changes.count) 个文件")
                                ChangeCounts(added: changes.reduce(0) { $0 + $1.added }, removed: changes.reduce(0) { $0 + $1.removed })
                            }
                            .font(.footnote)
                            .textCase(nil)
                        }
                        .groupedRow()
                    }
                    .groupedList()
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: String.self) { path in FileDiffPage(model: model, path: path) }
        }
    }
}

private struct ChangedFileRow: View {
    let change: FileChange

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(change.name).font(.callout).foregroundStyle(Palette.ink).lineLimit(1).truncationMode(.middle)
                if !change.directory.isEmpty {
                    Text(change.directory).font(.caption).foregroundStyle(Palette.secondary).lineLimit(1).truncationMode(.head)
                }
            }
            Spacer(minLength: 8)
            ChangeCounts(added: change.added, removed: change.removed).font(.footnote)
        }
        .frame(minHeight: 34)
    }
}

/// `+a −b` in the diff tokens; a side with nothing to report stays out.
private struct ChangeCounts: View {
    let added: Int
    let removed: Int

    var body: some View {
        HStack(spacing: 6) {
            if added > 0 { Text("+\(added)").foregroundStyle(Palette.added) }
            if removed > 0 { Text("−\(removed)").foregroundStyle(Palette.removed) }
        }
        .monospacedDigit()
    }
}

/// One file's diff, full width. The bottom bar walks the session's other changed
/// files in place, so going through them does not stack up pages.
private struct FileDiffPage: View {
    let model: SessionModel
    @State var path: String
    @AppStorage("dsh.diff.wrap") private var wrap = true

    var body: some View {
        let changes = FileChange.collect(model.items.allBlocks, root: model.workingDirectory)
        let index = changes.firstIndex { $0.path == path }
        Group {
            if let index {
                ScrollView {
                    DiffLinesView(lines: changes[index].lines, cornerRadius: 0, wrap: wrap)
                }
                // Each file starts at its top.
                .id(path)
            } else {
                ContentUnavailableView("这个文件不在改动里了", systemImage: "doc.text.magnifyingglass")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Palette.grouped)
        .navigationTitle(URL(fileURLWithPath: path).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let index {
                ToolbarItem(placement: .principal) { title(changes[index], at: index, of: changes.count) }
                ToolbarItemGroup(placement: .bottomBar) {
                    if changes.count > 1 {
                        step("chevron.up", "上一个文件", to: index > 0 ? changes[index - 1].path : nil)
                        step("chevron.down", "下一个文件", to: index + 1 < changes.count ? changes[index + 1].path : nil)
                    }
                    Spacer()
                    NavigationLink("查看完整文件") {
                        FileContentView(sessionId: model.sessionId, path: path, root: model.workingDirectory)
                    }
                    Spacer()
                    Toggle(isOn: $wrap) { Label("自动换行", systemImage: "arrow.turn.down.left") }
                        .toggleStyle(.button)
                        .tint(Palette.ink)
                }
            }
        }
    }

    private func title(_ change: FileChange, at index: Int, of count: Int) -> some View {
        VStack(spacing: 0) {
            Text(change.name).font(.subheadline.weight(.semibold)).lineLimit(1).truncationMode(.middle)
            HStack(spacing: 6) {
                if count > 1 { Text("\(index + 1)/\(count)").foregroundStyle(Palette.secondary) }
                ChangeCounts(added: change.added, removed: change.removed)
            }
            .font(.caption2)
        }
        .accessibilityElement(children: .combine)
    }

    private func step(_ icon: String, _ label: LocalizedStringKey, to target: String?) -> some View {
        Button {
            Haptics.select()
            if let target { path = target }
        } label: {
            Image(systemName: icon)
        }
        .disabled(target == nil)
        .accessibilityLabel(label)
    }
}

/// Diff rows on the grouped background; added / removed lines use the diff tokens.
struct DiffLinesView: View {
    let lines: [DiffLine]
    var cornerRadius: CGFloat = 22
    /// Long lines wrap instead of scrolling sideways.
    var wrap = false
    @State private var width: CGFloat = 0

    var body: some View {
        Group {
            if wrap {
                LazyVStack(alignment: .leading, spacing: 0) { rows }
                    .padding(.vertical, 14)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 0) { rows }
                        // Row fills reach the right edge even when every line is short.
                        .frame(minWidth: width, alignment: .leading)
                        .padding(.vertical, 14)
                }
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
            }
        }
        .font(.caption.monospaced())
        .lineSpacing(4)
        .background(Palette.grouped, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
    }

    private var rows: some View {
        ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
            if line.kind == .gap {
                Text("⋯").foregroundStyle(Palette.faint).padding(.horizontal, 16).padding(.vertical, 2)
            } else {
                Text(line.text.isEmpty ? " " : line.text)
                    .foregroundStyle(line.kind == .added ? Palette.added : line.kind == .removed ? Palette.removed : Palette.secondary)
                    .fixedSize(horizontal: !wrap, vertical: true)
                    .padding(.horizontal, 16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(line.kind == .added ? Palette.addedBackground : line.kind == .removed ? Palette.removedBackground : .clear)
            }
        }
    }
}

// MARK: Context

private struct WorkbenchContext: View {
    let model: SessionModel
    let close: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                if let window = model.contextWindow, let used = model.contextTokens {
                    let ratio = min(1, Double(used) / Double(max(window, 1)))
                    VStack(alignment: .leading, spacing: 14) {
                        Text(ratio, format: .percent.precision(.fractionLength(0)))
                            .font(.system(size: 48, weight: .semibold)).monospacedDigit().kerning(-1)
                        ProgressView(value: ratio).tint(Palette.ink)
                        Text("上下文已用 \(Self.compact(used)) / \(Self.compact(window)) tokens").font(.subheadline).foregroundStyle(Palette.secondary)
                    }
                    .accessibilityElement(children: .combine)
                }
                VStack(spacing: 0) {
                    row("缓存命中", model.tokens.input > 0 ? (Double(model.tokens.cacheRead) / Double(model.tokens.input)).formatted(.percent.precision(.fractionLength(0))) : "—")
                    row("本会话输入", Self.compact(model.tokens.input))
                    row("输出", Self.compact(model.tokens.output))
                    if let breakdown = model.composer.contextBreakdown {
                        row("系统提示词", Self.compact(breakdown.system))
                        row("工具定义", Self.compact(breakdown.tools))
                        row("对话消息", Self.compact(breakdown.messages))
                    }
                    if let dir = model.workingDirectory { row("工作目录", URL(fileURLWithPath: dir).lastPathComponent) }
                }
                Button("压缩上下文") {
                    Task { await model.runCommand("/compact") }
                    close()
                }
                .buttonStyle(.capsule(.secondary))
                .disabled(model.running)
                if !model.todos.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("任务清单").font(.footnote).foregroundStyle(Palette.secondary)
                        ForEach(Array(model.todos.enumerated()), id: \.offset) { _, todo in TodoRow(item: todo) }
                    }
                }
            }
            .padding(EdgeInsets(top: 32, leading: 24, bottom: 24, trailing: 24))
        }
    }

    private func row(_ title: LocalizedStringKey, _ value: String) -> some View {
        HStack {
            Text(title)
            Spacer()
            Text(value).foregroundStyle(Palette.secondary).lineLimit(1)
        }
        .font(.callout)
        .frame(minHeight: 48)
    }

    static func compact(_ value: Int) -> String {
        value.formatted(.number.notation(.compactName).precision(.significantDigits(1...3)))
    }
}

// MARK: Changes model

struct DiffLine: Hashable {
    enum Kind { case context, added, removed, gap }
    var kind: Kind
    var text: String

    /// A whole new file: every line added.
    static func added(_ content: String) -> [DiffLine] {
        var lines = content.components(separatedBy: "\n")
        if lines.count > 1, lines.last == "" { lines.removeLast() }
        return lines.map { DiffLine(kind: .added, text: "+" + $0) }
    }

    /// Line diff of one replacement.
    static func lines(old: String, new: String) -> [DiffLine] {
        let oldLines = old.components(separatedBy: "\n")
        let newLines = new.components(separatedBy: "\n")
        var removed: [Int: String] = [:]
        var inserted: [Int: String] = [:]
        for change in newLines.difference(from: oldLines) {
            switch change {
            case .remove(let offset, let element, _): removed[offset] = element
            case .insert(let offset, let element, _): inserted[offset] = element
            }
        }
        var result: [DiffLine] = []
        var i = 0, j = 0
        while i < oldLines.count || j < newLines.count {
            if let line = removed[i] { result.append(DiffLine(kind: .removed, text: "-" + line)); i += 1; continue }
            if let line = inserted[j] { result.append(DiffLine(kind: .added, text: "+" + line)); j += 1; continue }
            if i < oldLines.count { result.append(DiffLine(kind: .context, text: " " + oldLines[i])) }
            i += 1; j += 1
        }
        return result
    }
}

/// Files a session changed, derived from its edit / write / patch tool calls
/// (successful ones), with their line diffs.
struct FileChange: Identifiable, Hashable {
    var path: String
    var lines: [DiffLine] = []
    var id: String { path }
    var name: String { (path as NSString).lastPathComponent }
    /// The folder the path names, empty for a file at the root.
    var directory: String { (path as NSString).deletingLastPathComponent }
    var added: Int { lines.filter { $0.kind == .added }.count }
    var removed: Int { lines.filter { $0.kind == .removed }.count }

    static func collect(_ blocks: [AssistantBlock], root: String? = nil) -> [FileChange] {
        var order: [String] = []
        var byPath: [String: FileChange] = [:]
        func add(_ rawPath: String?, _ lines: [DiffLine]) {
            guard let rawPath, !rawPath.isEmpty, !lines.isEmpty else { return }
            var path = rawPath
            if let root, path.hasPrefix(root + "/") { path = String(path.dropFirst(root.count + 1)) }
            if byPath[path] == nil { order.append(path); byPath[path] = FileChange(path: path) }
            if !(byPath[path]!.lines.isEmpty) { byPath[path]!.lines.append(DiffLine(kind: .gap, text: "")) }
            byPath[path]!.lines += lines
        }
        for block in blocks {
            guard case .tool(let call) = block, call.finished, !call.isError else { continue }
            let args = call.arguments
            let path = args["file_path"].string ?? args["path"].string
            switch call.displayName {
            case "edit", "str_replace", "str_replace_editor":
                if let old = args["old_string"].string ?? args["old_str"].string, let new = args["new_string"].string ?? args["new_str"].string {
                    add(path, DiffLine.lines(old: old, new: new))
                } else if let content = args["file_text"].string {
                    // `str_replace_editor` with `command: create`.
                    add(path, DiffLine.added(content))
                }
            case "multi_edit":
                for edit in args["edits"].array {
                    if let old = edit["old_string"].string, let new = edit["new_string"].string { add(path, DiffLine.lines(old: old, new: new)) }
                }
            case "write", "write_file", "create":
                if let content = args["content"].string ?? args["file_text"].string {
                    add(path, DiffLine.added(content))
                }
            case "apply_patch":
                for (file, lines) in parsePatch(args["patch"].string ?? args["input"].string ?? call.rawArguments) { add(file, lines) }
            default:
                break
            }
        }
        return order.compactMap { byPath[$0] }
    }

    /// `*** Update File:` (apply_patch) and unified `+++ b/` headers, then +/- lines.
    private static func parsePatch(_ patch: String) -> [(String, [DiffLine])] {
        var result: [(String, [DiffLine])] = []
        var file: String?
        var lines: [DiffLine] = []
        func flush() { if let file, !lines.isEmpty { result.append((file, lines)) }; lines = [] }
        for line in patch.components(separatedBy: "\n") {
            if let name = ["*** Update File: ", "*** Add File: ", "*** Delete File: ", "+++ b/", "+++ "].lazy.compactMap({ line.hasPrefix($0) ? String(line.dropFirst($0.count)) : nil }).first {
                flush()
                file = name.trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("--- ") || line.hasPrefix("*** ") {
                continue
            } else if line.hasPrefix("@@") {
                if !lines.isEmpty { lines.append(DiffLine(kind: .gap, text: "")) }
            } else if line.hasPrefix("+") {
                lines.append(DiffLine(kind: .added, text: line))
            } else if line.hasPrefix("-") {
                lines.append(DiffLine(kind: .removed, text: line))
            } else if line.hasPrefix(" ") {
                lines.append(DiffLine(kind: .context, text: line))
            }
        }
        flush()
        return result
    }
}

extension Array where Element == TimelineItem {
    var allBlocks: [AssistantBlock] {
        flatMap { item -> [AssistantBlock] in
            if case .assistant(_, let blocks, _, _) = item { return blocks }
            return []
        }
    }
}
