import SwiftUI

/// Add a workspace (`directory-browser`): browse folders under the engine's `~/Documents` level
/// by level, or make one, and open the current level. The folders are the engine's to
/// read: a system folder picker returns paths outside the sandbox it cannot reach, and
/// the engine's own home is not somewhere users keep projects.
struct NewWorkspaceView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var stack: [String] = []
    @State private var showHidden = false
    @State private var busy = false
    /// A `workspace/create` refusal, in the web's words: 「无法打开文件夹」.
    @State private var failure: String?
    @State private var creating = false
    @State private var folderName = ""
    /// The level on screen; its listing's canonical path replaces this once read.
    @State private var levels: [String: DirectoryListing] = [:]
    @State private var reload = 0

    private let documents = EnginePaths.documents

    private var current: String { stack.last ?? documents }
    private var listing: DirectoryListing? { levels[current] }

    var body: some View {
        NavigationStack(path: $stack) {
            level(documents, title: String(localized: "文稿"))
                .navigationDestination(for: String.self) { path in
                    level(path, title: (path as NSString).lastPathComponent)
                }
        }
        .tint(Palette.ink)
        .interactiveDismissDisabled(busy)
        .sheetNotices()
        .alert("新建文件夹", isPresented: $creating) {
            TextField("未命名文件夹", text: $folderName)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("取消", role: .cancel) {}
            Button("创建") { Task { await createFolder() } }
                .disabled(folderName.trimmingCharacters(in: .whitespaces).isEmpty)
        } message: {
            Text(verbatim: String(localized: "在\"\(listing?.name ?? "")\"中新建文件夹"))
        }
        .alert("无法打开文件夹", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("取消", role: .cancel) { dismiss() }
            Button("重新选择") {}
        } message: {
            Text(failure ?? "")
        }
    }

    private func level(_ path: String, title: String) -> some View {
        DirectoryLevelView(path: path, showHidden: showHidden, reload: reload) { listing in
            levels[path] = listing
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("取消") { dismiss() }.disabled(busy)
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("打开") { Task { await open() } }
                    .disabled(busy || levels[path] == nil)
            }
            ToolbarItemGroup(placement: .bottomBar) {
                Button { folderName = ""; creating = true } label: { Label("新建文件夹", systemImage: "folder.badge.plus").labelStyle(.titleAndIcon) }
                    .disabled(busy || levels[path] == nil)
                Spacer()
                Button { showHidden.toggle() } label: {
                    Label("显示隐藏文件", systemImage: showHidden ? "checkmark" : "eye.slash").labelStyle(.titleAndIcon)
                }
                .accessibilityAddTraits(showHidden ? .isSelected : [])
            }
        }
    }

    private func createFolder() async {
        guard let parent = listing?.path else { return }
        let name = folderName.trimmingCharacters(in: .whitespaces)
        do {
            let created = try await app.client.call("directoryPicker/createDirectory", ["path": .string(parent), "name": .string(name)])
            Haptics.success()
            reload += 1
            if let path = created.string { stack.append(path) }
        } catch {
            Haptics.error()
            app.showToast(error.localizedDescription, tone: .warning)
        }
    }

    /// Register the level on screen, then start a conversation in it.
    private func open() async {
        guard let path = listing?.path else { return }
        busy = true
        defer { busy = false }
        do {
            let value = try await app.client.call("workspace/create", ["request": ["path": .string(path)]])
            Haptics.success()
            dismiss()
            app.newSessionRequest = NewSessionRequest(workspaceId: value["workspace"]["workspaceId"].string)
        } catch {
            Haptics.error()
            failure = error.localizedDescription
        }
    }
}

/// One `directoryPicker/list` answer.
struct DirectoryListing {
    let path: String
    let name: String
    let entries: [(name: String, path: String, hidden: Bool)]
    let truncated: Bool

    init(_ json: JSON) {
        path = json["path"].string ?? ""
        name = (path as NSString).lastPathComponent
        entries = json["entries"].array.map { ($0["name"].string ?? "", $0["path"].string ?? "", $0["hidden"].bool ?? false) }
        truncated = json["truncated"].bool ?? false
    }
}

/// The folders of one level; 「加载中…」 only when the read takes longer than 300 ms.
private struct DirectoryLevelView: View {
    let path: String
    let showHidden: Bool
    let reload: Int
    let loaded: (DirectoryListing) -> Void
    @Environment(AppModel.self) private var app
    @State private var listing: DirectoryListing?
    @State private var failure: String?
    @State private var slow = false

    var body: some View {
        List {
            if let failure {
                Text(failure).font(.footnote).foregroundStyle(Palette.removed).groupedRow()
            }
            if let listing {
                let rows = listing.entries.filter { showHidden || !$0.hidden }
                Section {
                    ForEach(rows, id: \.path) { entry in
                        NavigationLink(value: entry.path) {
                            Label {
                                Text(entry.name).lineLimit(1).opacity(entry.hidden ? 0.6 : 1)
                            } icon: {
                                Image(systemName: "folder").foregroundStyle(Palette.secondary)
                            }
                            .font(.subheadline)
                        }
                    }
                } footer: {
                    if listing.truncated { Text("文件夹过多，仅显示开头部分。") }
                }
                .groupedRow()
            }
        }
        .groupedList()
        .overlay {
            if slow && listing == nil && failure == nil {
                Text("加载中…").font(.subheadline).foregroundStyle(Palette.secondary)
            } else if let listing, listing.entries.isEmpty {
                Text("这个文件夹里没有子文件夹").font(.subheadline).foregroundStyle(Palette.secondary)
            }
        }
        .task(id: "\(path)-\(reload)") { await load() }
    }

    private func load() async {
        failure = nil
        let hint = Task { try? await Task.sleep(for: .milliseconds(300)); if !Task.isCancelled { slow = true } }
        defer { hint.cancel(); slow = false }
        do {
            let value = try await app.client.call("directoryPicker/list", ["path": .string(path)])
            let result = DirectoryListing(value)
            listing = result
            loaded(result)
        } catch {
            if !Task.isCancelled { failure = error.localizedDescription }
        }
    }
}
