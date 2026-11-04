import SwiftUI

/// 设置 S-05, in the app: `settings/openSettingsDocument` opens the file with the Host's
/// native editor, which iOS does not have, and the engine has no RPC to read or write it.
/// It lives in this app's own container, so it is edited here directly; the engine's
/// config HMR picks up the saved file.
///
/// A file that does not parse, or is not a YAML array, stops the engine from booting at
/// all, and with it this page: the next restart loops for good. So every save is
/// probed at once (`settings/describe` parses the file on each call) and put back
/// unless the engine confirms it; the text stays here to be corrected.
struct ConfigDocumentView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var original: String?
    @State private var failure: String?
    @State private var confirmingDiscard = false
    @State private var saving = false
    @State private var rejection: String?
    @FocusState private var editing: Bool

    /// `$DSH_HOME/profiles/<profile>/cordis.patch.yml`; the app runs the `web` profile.
    private var file: URL {
        EnginePaths.dshHome.appendingPathComponent("profiles/web/cordis.patch.yml")
    }

    private var dirty: Bool { original != nil && text != original }

    var body: some View {
        Group {
            if let failure {
                ContentUnavailableView("无法打开配置文件", systemImage: "doc.badge.ellipsis", description: Text(failure))
            } else {
                TextEditor(text: $text)
                    .font(.footnote.monospaced())
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .focused($editing)
                    .scrollContentBackground(.hidden)
                    .padding(.horizontal, 12)
            }
        }
        .background(Palette.grouped)
        .navigationTitle("配置文件")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(dirty)
        .toolbar {
            if dirty {
                ToolbarItem(placement: .cancellationAction) {
                    Button("放弃") { confirmingDiscard = true }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { Task { await save() } }.fontWeight(.semibold).disabled(saving)
                }
            } else {
                ToolbarItem(placement: .topBarTrailing) {
                    ShareLink(item: file)
                }
            }
        }
        .alert("放弃修改？", isPresented: $confirmingDiscard) {
            Button("继续编辑", role: .cancel) {}
            Button("放弃", role: .destructive) { dismiss() }
        }
        .alert("配置文件有误，未保存", isPresented: Binding(get: { rejection != nil }, set: { if !$0 { rejection = nil } })) {
            Button("好", role: .cancel) {}
        } message: {
            Text("已恢复原内容，你的修改还在编辑器里。\n\n\(rejection ?? "")")
        }
        .safeAreaInset(edge: .bottom) {
            if original != nil {
                Text("保存后自动生效。内容无法解析时会恢复原内容。")
                    .font(.caption)
                    .foregroundStyle(Palette.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .background(Palette.background)
            }
        }
        .task { load() }
    }

    private func load() {
        do {
            let value = try String(contentsOf: file, encoding: .utf8)
            text = value
            original = value
        } catch {
            failure = error.localizedDescription
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            // The engine writes this file too (every settings change lands here).
            if let onDisk = try? String(contentsOf: file, encoding: .utf8), onDisk != original {
                Haptics.warning()
                app.showToast(String(localized: "配置文件已被引擎改动，请退出后重新打开，再编辑。"), duration: 6)
                return
            }
            let attributes = try? FileManager.default.attributesOfItem(atPath: file.path)
            try text.write(to: file, atomically: true, encoding: .utf8)
            // The atomic replace is a new file; keep the original's owner-only mode.
            if let mode = attributes?[.posixPermissions] {
                try? FileManager.default.setAttributes([.posixPermissions: mode], ofItemAtPath: file.path)
            }
            do {
                _ = try await app.client.call("settings/describe")
            } catch {
                // Not proven good: a file left like this could stop the engine booting.
                try original?.write(to: file, atomically: true, encoding: .utf8)
                if let mode = attributes?[.posixPermissions] {
                    try? FileManager.default.setAttributes([.posixPermissions: mode], ofItemAtPath: file.path)
                }
                Haptics.error()
                rejection = describeFailure(error)
                return
            }
            original = text
            editing = false
            Haptics.success()
            app.showToast(String(localized: "配置文件已保存"))
            await app.settings.reload()
        } catch {
            Haptics.error()
            app.showToast(String(localized: "无法保存配置文件：\(error.localizedDescription)"), duration: 6)
        }
    }
}
