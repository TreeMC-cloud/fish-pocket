import SwiftUI

/// The ＋ tray, one for the new-conversation and the conversation layouts: three
/// large buttons for what goes into a message, then references, commands, the
/// model and the session's modes. Everything typing `/` or `@` reaches is here,
/// for keyboards where those characters sit a page away.
struct ComposerTray: View {
    let model: SessionModel
    let context: ComposerContext
    let camera: () -> Void
    let photos: () -> Void
    let files: () -> Void
    let pick: (Candidate) -> Void
    let setPermission: (String) -> Void
    @State private var confirmingPermission: String?

    private var composer: ComposerModel { model.composer }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 10) {
                        TrayTile(title: "相机", systemImage: "camera", action: camera)
                            .disabled(!UIImagePickerController.isSourceTypeAvailable(.camera))
                        TrayTile(title: "照片", systemImage: "photo.on.rectangle", action: photos)
                        TrayTile(title: "文件", systemImage: "folder", action: files)
                    }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                }
                Section {
                    NavigationLink {
                        CandidateList(model: model, context: context, trigger: "@", pick: pick)
                    } label: {
                        Label("引用文件或对话", systemImage: "at")
                    }
                    NavigationLink {
                        CandidateList(model: model, context: context, trigger: "/", leading: composer.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, pick: pick)
                    } label: {
                        Label("指令", systemImage: "command")
                    }
                    NavigationLink {
                        ModelSearchList(model: model, context: context)
                    } label: {
                        LabeledContent {
                            Text(context.modelName(model)).lineLimit(1)
                        } label: {
                            Label("模型", systemImage: "cpu")
                        }
                    }
                }
                .groupedRow()
                Section {
                    if context.hasPlanMode || composer.planActive {
                        Toggle(isOn: Binding(get: { composer.planActive }, set: { on in Haptics.select(); composer.setPlan(on) })) {
                            Label("计划模式", systemImage: "list.bullet.clipboard")
                        }
                        .toggleStyle(.mono)
                        .disabled(composer.planSwitching)
                    }
                    if let thinking = context.thinking(model) {
                        Toggle(isOn: Binding(get: { thinking.isOn }, set: { on in
                            Haptics.select()
                            Task { await model.selectModel(thinking.choice, effort: on ? thinking.on : thinking.off) }
                        })) {
                            Label("思考", systemImage: "lightbulb")
                        }
                        .toggleStyle(.mono)
                    }
                    if !context.permissionOptions.isEmpty, model.permission != nil {
                        Picker(selection: Binding(get: { model.permission ?? "" }, set: { choosePermission($0) })) {
                            ForEach(context.permissionOptions, id: \.value) { option in
                                Label(ComposerView.permissionTitle(option), systemImage: ComposerView.permissionIcon(option.value)).tag(option.value)
                            }
                        } label: {
                            Label("访问模式", systemImage: ComposerView.permissionIcon(model.permission ?? ""))
                        }
                        .pickerStyle(.menu)
                    }
                }
                .groupedRow()
            }
            .groupedList()
            .toolbar(.hidden, for: .navigationBar)
        }
        .tint(Palette.ink)
        .permissionConfirmation($confirmingPermission, confirm: setPermission)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .sheetNotices()
    }

    private func choosePermission(_ value: String) {
        guard value != model.permission else { return }
        Haptics.select()
        if ComposerView.needsConfirmation(value) {
            confirmingPermission = value
        } else {
            setPermission(value)
        }
    }
}

/// A large button in the tray's first row.
private struct TrayTile: View {
    let title: LocalizedStringKey
    let systemImage: String
    let action: () -> Void
    @Environment(\.isEnabled) private var enabled

    var body: some View {
        Button(action: action) {
            VStack(spacing: 6) {
                Image(systemName: systemImage).font(.system(size: 22))
                Text(title).font(.footnote)
            }
            .foregroundStyle(enabled ? Palette.ink : Palette.faint)
            .frame(maxWidth: .infinity, minHeight: 76)
            .background(Palette.grouped, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}
