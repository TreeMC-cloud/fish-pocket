import SwiftUI

/// The shell's dialogs, attached to the root view. Renaming a session is the system
/// text alert (the title only has to be non-empty) and archiving busy work the system
/// action sheet; both close at once, so a failure shows as a toast.
struct ShellDialogs: ViewModifier {
    @Environment(AppModel.self) private var app
    @State private var renaming = false
    @State private var title = ""

    private var trimmed: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var workspaceRename: Binding<RenameRequest?> {
        Binding(
            get: {
                guard case .workspace? = app.renameRequest?.target else { return nil }
                return app.renameRequest
            },
            set: { app.renameRequest = $0 }
        )
    }

    private var archiving: Binding<Bool> {
        Binding(get: { app.archiveRequest != nil }, set: { if !$0 { app.archiveRequest = nil } })
    }

    func body(content: Content) -> some View {
        content
            // The text is in place before the alert reads it.
            .onChange(of: app.renameRequest?.id) {
                guard let request = app.renameRequest, case .session = request.target else { return }
                title = request.initial
                renaming = true
            }
            .alert("重命名会话", isPresented: $renaming) {
                TextField("会话名称", text: $title)
                Button("取消", role: .cancel) { app.renameRequest = nil }
                Button("重命名", action: saveTitle).disabled(trimmed.isEmpty)
            }
            .sheet(item: workspaceRename) { RenameWorkspaceSheet(request: $0) }
            .confirmationDialog(Text("停止并归档「\(app.archiveRequest?.title ?? "")」？"), isPresented: archiving, titleVisibility: .visible, presenting: app.archiveRequest) { request in
                Button("停止并归档", role: .destructive) { stopAndArchive(request) }
                Button("取消", role: .cancel) {}
            } message: { request in
                Text(request.summary)
            }
    }

    private func saveTitle() {
        guard case .session(let id)? = app.renameRequest?.target else { return }
        let title = trimmed
        app.renameRequest = nil
        Task {
            do {
                try await app.rename(session: id, to: title)
                Haptics.success()
            } catch {
                Haptics.error()
                app.showToast(error.localizedDescription, tone: .warning)
            }
        }
    }

    private func stopAndArchive(_ request: ArchiveRequest) {
        Task {
            do {
                try await app.stopAndArchive(request.sessionId)
            } catch {
                Haptics.error()
                app.showToast(error.localizedDescription, tone: .warning)
            }
        }
    }
}

/// 「重命名工作区」: the name must change and not repeat another workspace's, which
/// takes a line of text under the field, so this stays a sheet (`workspace` rename modal).
/// While the request runs it stays open; a failure shows the engine's message.
private struct RenameWorkspaceSheet: View {
    let request: RenameRequest
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var busy = false
    @State private var failure: String?
    @FocusState private var focused: Bool

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var workspace: Workspace? {
        guard case .workspace(let id) = request.target else { return nil }
        return app.workspaces.first { $0.id == id }
    }

    /// Another workspace already shows this name.
    private var conflict: Bool {
        guard let workspace, !trimmed.isEmpty else { return false }
        return app.workspaces.contains { $0.id != workspace.id && $0.displayTitle == trimmed }
    }

    private var canSave: Bool {
        guard let workspace, !trimmed.isEmpty, !busy else { return false }
        return trimmed != workspace.title && !conflict
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    TextField("工作区名称", text: $text)
                        .focused($focused)
                        .submitLabel(.done)
                        .onSubmit { if canSave { Task { await save() } } }
                        .groupedRow()
                } footer: {
                    if conflict {
                        Text("已有同名工作区")
                    } else if let failure {
                        Text(failure).foregroundStyle(Palette.removed)
                    }
                }
            }
            .groupedList()
            .navigationTitle("重命名工作区")
            .navigationBarTitleDisplayMode(.inline)
            .saveToolbar(canSave: canSave, saving: busy, cancel: { dismiss() }, save: { Task { await save() } })
        }
        .tint(Palette.ink)
        .presentationDetents([.medium])
        .interactiveDismissDisabled(busy)
        .onAppear {
            text = request.initial
            focused = true
        }
    }

    private func save() async {
        guard let workspace else { return }
        busy = true
        failure = nil
        defer { busy = false }
        do {
            try await app.renameWorkspace(workspace.id, to: trimmed)
            Haptics.success()
            dismiss()
        } catch {
            Haptics.error()
            failure = error.localizedDescription
        }
    }
}

extension ArchiveRequest {
    /// 「停止并归档」's message: what stops, one line per activity kind, then what happens after.
    fileprivate var summary: String {
        let lines = activity.map { activity -> String in
            let items = activity["items"].array
            let names = items.map { $0["label"].string ?? $0["id"].string ?? "" }.joined(separator: String(localized: "、"))
            let count = items.count
            switch activity["kind"].string {
            case "turn": return String(localized: "进行中的回合")
            case "subagent": return String(localized: "\(count) 个运行中的子智能体：\(names)")
            case "job": return String(localized: "\(count) 个后台任务：\(names)")
            case "schedule": return String(localized: "\(count) 条定时提醒：\(names)")
            default: return String(localized: "\(max(count, 1)) 项其他工作（\(activity["kind"].string ?? "")）")
            }
        }
        let after = String(localized: "可在「已归档」恢复会话，已停止的工作不会继续。")
        return lines.isEmpty ? after : String(localized: "将停止：") + lines.joined(separator: String(localized: "；")) + "\n" + after
    }
}
