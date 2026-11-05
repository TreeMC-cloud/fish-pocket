import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// The model picker in a blank conversation's top bar (a started one shows its
/// title there: `SessionTitleMenu`). Catalogs above four models add a search
/// sheet; providers that failed to load show with a retry.
struct ModelPicker: View {
    let model: SessionModel
    let context: ComposerContext
    @Environment(AppModel.self) private var app
    @State private var searching = false

    var body: some View {
        Menu {
            if context.catalog.flatMap(\.models).count > 4 {
                Button { searching = true } label: { Label("搜索模型…", systemImage: "magnifyingglass") }
            }
            ForEach(context.catalog) { group in
                Section(group.name) {
                    ForEach(group.models) { choice in modelItem(choice) }
                }
            }
            if context.catalogLoaded && context.catalog.allSatisfy(\.models.isEmpty) {
                Text("暂无可用模型")
            }
            if !context.catalogFailures.isEmpty {
                Section {
                    ForEach(context.catalogFailures, id: \.id) { failure in
                        Label("\(failure.name) 加载失败：\(failure.message)", systemImage: "exclamationmark.triangle")
                    }
                    Button { Task { await context.loadCatalog(model) } } label: { Label("重新加载", systemImage: "arrow.clockwise") }
                }
            }
        } label: {
            // The full name the catalog publishes (`DeepSeek-V4.1-Flash`), with the
            // reasoning level under it: the bar says exactly what the next turn runs on.
            VStack(spacing: 0) {
                HStack(spacing: 6) {
                    Text(context.modelName(model)).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.ink)
                        .lineLimit(1).minimumScaleFactor(0.85).truncationMode(.middle)
                    Image(systemName: "chevron.down").font(.caption2.weight(.bold)).foregroundStyle(Palette.secondary)
                }
                if let effort = context.effortName(model) {
                    Text(effort).font(.caption2).foregroundStyle(Palette.secondary).lineLimit(1)
                }
            }
            .padding(.horizontal, 12)
            .frame(maxWidth: 260)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .accessibilityLabel(context.effortName(model).map { Text("模型：\(context.modelName(model))，推理档位 \($0)") } ?? Text("模型：\(context.modelName(model))"))
        .sheet(isPresented: $searching) { ModelSearchSheet(model: model, context: context) }
        // MS-03: a provider's key or adapter changed; the catalog the menu shows follows.
        .onChange(of: app.revision("llm/adapters-updated", "settings/document-updated", "credentials/record-updated", "credentials/reference-updated")) {
            Task { await context.loadCatalog(model) }
        }
    }

    @ViewBuilder
    private func modelItem(_ choice: ModelChoice) -> some View {
        let title = Self.title(choice)
        if choice.reasoningEfforts.isEmpty {
            Button { Haptics.select(); Task { await model.selectModel(choice, effort: nil) } } label: {
                if isCurrent(choice) { Label(title, systemImage: "checkmark") } else { Text(title) }
            }
        } else {
            Menu {
                ForEach(choice.reasoningEfforts, id: \.id) { effort in
                    Button { Haptics.select(); Task { await model.selectModel(choice, effort: effort.id) } } label: {
                        if isCurrent(choice) && (context.selection(model)?.effort ?? choice.defaultEffort) == effort.id { Label(effort.name, systemImage: "checkmark") } else { Text(effort.name) }
                    }
                }
            } label: {
                if isCurrent(choice) { Label(title, systemImage: "checkmark") } else { Text(title) }
            }
        }
    }

    private func isCurrent(_ choice: ModelChoice) -> Bool {
        let selection = context.selection(model)
        return selection?.provider == choice.provider && selection?.model == choice.model
    }

    /// C-109: DeepSeek's `deepseek-flash` served as DeepSeek-V4.1-Flash carries the 「1017」 tag.
    static func is1017(_ choice: ModelChoice) -> Bool {
        ["deepseek-account", "deepseek-official"].contains(choice.provider) && choice.model == "deepseek-flash" && choice.name == "DeepSeek-V4.1-Flash"
    }

    /// Menu rows are plain text: the tag follows the name.
    static func title(_ choice: ModelChoice) -> String { is1017(choice) ? "\(choice.name)  1017" : choice.name }
}

/// The 「1017」 info tag after the model name.
struct Badge1017: View {
    var body: some View {
        Text("1017").font(.caption2.weight(.semibold)).foregroundStyle(Color.accentColor)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background(Color.accentColor.opacity(0.12), in: Capsule())
    }
}

/// The model list with search (MS-01): provider sections, ranked by the fuzzy
/// subsequence match within each provider, under the current model's level.
/// It is a page of the ＋ tray and, wrapped in `ModelSearchSheet`, a sheet of its own.
struct ModelSearchList: View {
    let model: SessionModel
    let context: ComposerContext
    @State private var query = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List {
            if query.isEmpty, let choice = context.currentChoice(model), !choice.reasoningEfforts.isEmpty {
                Section("档位") { levels(choice) }
            }
            if context.catalogLoading { Text("正在刷新模型列表…").foregroundStyle(Palette.secondary) }
            ForEach(context.catalogFailures, id: \.id) { failure in
                HStack {
                    Label("\(failure.name) 加载失败：\(failure.message)", systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(Palette.secondary)
                    Spacer()
                    Button("重新加载") { Task { await context.loadCatalog(model) } }.font(.footnote)
                }
            }
            let groups = filtered
            if groups.isEmpty {
                Text(query.isEmpty ? "暂无可用模型" : "没有匹配的模型。").foregroundStyle(Palette.secondary)
            }
            ForEach(groups) { group in
                Section(group.name) {
                    ForEach(group.models) { choice in
                        Button {
                            Haptics.select()
                            let selection = context.selection(model)
                            // The same model keeps its level; another starts at its default.
                            let effort = selection?.provider == choice.provider && selection?.model == choice.model ? selection?.effort : choice.defaultEffort
                            Task { await model.selectModel(choice, effort: effort) }
                            dismiss()
                        } label: {
                            HStack(spacing: 6) {
                                Text(choice.name).foregroundStyle(Palette.ink)
                                if ModelPicker.is1017(choice) { Badge1017() }
                                Spacer()
                                if isCurrent(choice) { Image(systemName: "checkmark").foregroundStyle(Palette.ink) }
                            }
                        }
                    }
                }
            }
        }
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "搜索模型…")
        .navigationTitle("模型")
        .navigationBarTitleDisplayMode(.inline)
    }

    /// The level stays in the list: picking one keeps the model and the page.
    /// Segments hold a handful of short names; an unusually long list falls back to a menu.
    @ViewBuilder
    private func levels(_ choice: ModelChoice) -> some View {
        let picker = Picker("档位", selection: Binding(
            get: { context.selection(model)?.effort ?? choice.defaultEffort ?? "" },
            set: { effort in
                Haptics.select()
                Task { await model.selectModel(choice, effort: effort) }
            }
        )) {
            ForEach(choice.reasoningEfforts, id: \.id) { effort in Text(effort.name).tag(effort.id) }
        }
        if choice.reasoningEfforts.count <= 5 {
            picker.pickerStyle(.segmented).labelsHidden()
        } else {
            picker.pickerStyle(.menu)
        }
    }

    private var filtered: [ModelGroup] {
        let needle = query.trimmingCharacters(in: .whitespaces)
        return context.catalog.map { group in
            var group = group
            group.models = FuzzyRank.rank(group.models, query: needle) { [$0.name] }
            return group
        }.filter { !$0.models.isEmpty }
    }

    private func isCurrent(_ choice: ModelChoice) -> Bool {
        let selection = context.selection(model)
        return selection?.provider == choice.provider && selection?.model == choice.model
    }
}

/// The model list as a sheet.
struct ModelSearchSheet: View {
    let model: SessionModel
    let context: ComposerContext
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ModelSearchList(model: model, context: context).closeButton(dismiss)
        }
        .presentationDetents([.medium, .large])
    }
}

/// The message input: one rounded bar, the same in a new conversation and an
/// ongoing one. ＋ opens the tray (attachments, references, commands, model and
/// modes). The main button is send / queue or steer (long press: the other) /
/// stop. Typing `/` or `@` opens the candidate panel above it.
struct ComposerView: View {
    let model: SessionModel
    let context: ComposerContext
    /// Text the shell put here (创建你的插件…): added to the draft, not sent.
    var pendingDraft: String?
    var consumeDraft: () -> Void = {}
    /// `/export`: the web downloads the ZIP itself, so this opens the log sheet instead of executing.
    var openLogExport: () -> Void = {}
    /// The input took or lost focus (the new-conversation page makes room around it).
    var focusChanged: (Bool) -> Void = { _ in }
    /// On from opening one of the composer's sheets until it is gone; the conversation's own sheets wait for it.
    var sheetUp: Binding<Bool> = .constant(false)
    @Environment(AppModel.self) private var app
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var photos: [PhotosPickerItem] = []
    @State private var showPhotos = false
    @State private var showCamera = false
    @State private var showFiles = false
    @State private var showModels = false
    @State private var showPermissions = false
    @State private var showTray = false
    @State private var showEditor = false
    /// The draft runs past three lines: long text moves to the full editor.
    @State private var tall = false
    @State private var confirmingPermission: String?
    /// The token whose 「全部」 sheet is open.
    @State private var browsing: TriggerHit?
    /// Runs once the open sheet is gone: the next picker can only present then.
    @State private var afterSheet: (() -> Void)?
    /// The keyboard comes back when the open sheet or picker closes: it was up when ＋ opened
    /// the tray, the tray's choice put text in the draft, or the sheet is one for typing.
    /// Dismissing the tray with nothing chosen leaves the keyboard down.
    @State private var refocus = false
    @FocusState private var focused: Bool

    private var composer: ComposerModel { model.composer }

    var body: some View {
        let trigger = activeTrigger
        VStack(alignment: .leading, spacing: 8) {
            if let trigger {
                CandidatePanel(model: model, context: context, hit: trigger, pick: { pick($0, over: trigger) }, showAll: { refocus = true; browsing = trigger })
            }
            field
                .background(Palette.field, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
        }
        .task(id: pendingDraft) {
            guard let pendingDraft else { return }
            composer.text = composer.text.isEmpty ? pendingDraft : composer.text + "\n" + pendingDraft
            consumeDraft()
        }
        .photosPicker(isPresented: $showPhotos, selection: $photos, maxSelectionCount: max(1, composer.remainingImageSlots), matching: .images)
        .onChange(of: photos) { _, items in
            Task { await loadPhotos(items) }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { image in
                if let refusal = composer.addImage(image) { app.showToast(refusal) }
            }
            .ignoresSafeArea()
        }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            let folders = urls.filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
            if !folders.isEmpty { app.showToast(String(localized: "只有桌面端支持添加文件夹，请添加单个文件")) }
            composer.addFiles(urls.filter { !folders.contains($0) })
        }
        .sheet(isPresented: $showModels) { ModelSearchSheet(model: model, context: context) }
        .sheet(isPresented: trayShown(sizeClass != .regular), onDismiss: sheetClosed) { tray }
        .sheet(isPresented: $showEditor, onDismiss: sheetClosed) {
            DraftEditor(composer: composer) {
                afterSheet = { send(.preferred) }
                showEditor = false
            }
        }
        .sheet(item: $browsing, onDismiss: sheetClosed) { hit in
            CandidateSheet(model: model, context: context, hit: hit) { candidate in
                afterSheet = { pick(candidate, over: hit) }
                browsing = nil
            }
        }
        .confirmationDialog("访问模式", isPresented: $showPermissions, titleVisibility: .visible) {
            ForEach(context.permissionOptions, id: \.value) { option in
                Button(Self.permissionTitle(option)) { choosePermission(option.value) }
            }
        }
        .permissionConfirmation($confirmingPermission, confirm: applyPermission)
        // A popover has no `onDismiss`. A picker presented before its dismissal ends never shows.
        .onChange(of: showTray) { _, open in
            guard !open, sizeClass == .regular else { return }
            Task {
                try? await Task.sleep(for: .milliseconds(450))
                sheetClosed()
            }
        }
        .onChange(of: showTray || showEditor || browsing != nil) { _, open in
            if open { sheetUp.wrappedValue = true }
        }
        .onChange(of: composer.focusRequest) { focused = true }
        .onChange(of: focused) { _, now in focusChanged(now) }
        // A picker closing gives the keyboard back when it was up before: typed into
        // (`/model`, `/file`) or reached from the tray while it was up.
        .onChange(of: pickerUp) { _, open in
            if open {
                refocus = refocus || focused
            } else {
                if refocus { focused = true }
                refocus = false
            }
        }
        // C-99 / C-110 / C-141: catalogs and the preference follow their engine events.
        .onChange(of: app.revision("commands/change", "agent-preset/selected")) { Task { await context.loadCommands(model) } }
        .onChange(of: app.revision("permission-presets/catalog-changed")) { Task { await context.loadPermissions(model) } }
        .onChange(of: app.revision("settings/document-updated")) { Task { await context.loadSettings(model) } }
    }

    /// The `/` or `@` token being typed. It needs the keyboard: hiding it folds the panel.
    private var activeTrigger: TriggerHit? {
        guard focused, let hit = TriggerHit.detect(in: composer.text) else { return nil }
        // Once a command claims the draft, a later `/` is text (`@` stays live).
        if hit.trigger == "/", !hit.leading, context.resolve(line: composer.text)?.0.hint != nil { return nil }
        return hit
    }

    /// One compact bar for a new conversation and an ongoing one: ＋, the text, the main button.
    private var field: some View {
        VStack(alignment: .leading, spacing: 8) {
            if composer.editingQueue != nil {
                queueEditBanner
            } else {
                AttachmentRail(composer: composer)
                    .padding(.horizontal, 13)
                    .padding(.top, composer.attachments.isEmpty ? 0 : 6)
            }
            if let hint = commandHint {
                Text(hint).font(.footnote).foregroundStyle(Palette.secondary)
                    .padding(.horizontal, 17)
                    .padding(.top, 4)
            }
            HStack(alignment: .bottom, spacing: 6) {
                plusButton
                input
                    .padding(.vertical, 11)
                mainButton
            }
        }
        // The buttons' 44 pt areas stand 3 pt past their circles: the insets make up for it, so the bar stays 54 pt.
        .padding(5)
    }

    /// Five lines at most: above the keyboard every line comes out of the timeline, and past
    /// three the expand button leads to a page with the room.
    private var input: some View {
        // Between three lines and four, whatever the text size.
        let threeLines = UIFont.preferredFont(forTextStyle: .callout).lineHeight * 3.5
        return TextField(placeholder, text: Bindable(composer).text, axis: .vertical)
            .font(.callout)
            .lineLimit(1...5)
            .focused($focused)
            .tint(Palette.ink)
            .padding(.trailing, tall ? 30 : 0)
            .onGeometryChange(for: Bool.self) { $0.size.height > threeLines } action: { tall = $0 }
            .overlay(alignment: .topTrailing) {
                if tall {
                    Button { refocus = true; showEditor = true } label: {
                        Image(systemName: "arrow.up.left.and.arrow.down.right").font(.footnote.weight(.medium)).foregroundStyle(Palette.secondary)
                            .hitTarget()
                    }
                    .padding(.top, -12)
                    .padding(.trailing, -8)
                    .accessibilityLabel("全屏编辑")
                }
            }
    }

    /// C-83, shortened: the keyboard's `/` and `@` have the ＋ tray, the queue has its own bar.
    private var placeholder: LocalizedStringKey {
        composer.planActive ? "描述任务" : "发消息"
    }

    /// C-84: a leading command taking arguments with none typed yet shows what to write.
    private var commandHint: String? {
        let text = composer.text
        guard text.hasPrefix("/"), let space = text.firstIndex(where: \.isWhitespace),
              text[space...].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let (descriptor, _) = context.resolve(line: String(text[..<space])) else { return nil }
        return context.hint(for: descriptor, hasGoal: composer.goal != nil)
    }

    /// A queued message is in the input: the main button saves it back into its place.
    private var queueEditBanner: some View {
        HStack(spacing: 6) {
            Image(systemName: "pencil")
            Text("编辑排队消息")
            Spacer(minLength: 8)
            Button("取消") {
                if focused { clearFocusedTextInput() }
                composer.cancelQueueEdit()
            }
            .foregroundStyle(Palette.ink)
            .hitTarget()
        }
        .font(.footnote)
        .foregroundStyle(Palette.secondary)
        .padding(.leading, 13)
        .padding(.trailing, 6)
    }

    // MARK: Controls

    private var plusButton: some View {
        Button {
            refocus = focused
            showTray = true
        } label: {
            Image(systemName: "plus").font(.system(size: 19, weight: .regular)).foregroundStyle(Palette.ink)
                .hitTarget()
        }
        .accessibilityLabel("添加附件、调用指令、切换模式")
        // A bottom sheet on a phone; with room to spare, a popover at the button.
        .popover(isPresented: trayShown(sizeClass == .regular), arrowEdge: .bottom) {
            // A list has no height of its own to give a popover.
            tray.frame(width: 380, height: 520)
        }
    }

    /// One state, shown in whichever form the width calls for.
    private func trayShown(_ here: Bool) -> Binding<Bool> {
        Binding(get: { here && showTray }, set: { if !$0 { showTray = false } })
    }

    private var tray: some View {
        ComposerTray(
            model: model, context: context,
            camera: { leaveTray { showCamera = true } },
            photos: { leaveTray { showPhotos = true } },
            files: { leaveTray { showFiles = true } },
            pick: { candidate in leaveTray { pick(candidate, over: nil) } },
            setPermission: applyPermission
        )
    }

    /// Leave the tray for a picker, which can only present once the tray is gone.
    private func leaveTray(then next: @escaping () -> Void) {
        afterSheet = next
        showTray = false
    }

    /// While the agent runs, stop stays one tap away: alone with an empty draft (the main
    /// button), and beside send once there is text, in the quieter fill.
    @ViewBuilder
    private var mainButton: some View {
        let empty = composer.nothingToSend
        let editing = composer.editingQueue != nil
        HStack(spacing: 0) {
            if model.running { stopButton(prominent: empty && !editing) }
            if !model.running || !empty || editing { sendButton(empty: empty) }
        }
    }

    private func stopButton(prominent: Bool) -> some View {
        Button { Haptics.firm(); Task { await model.cancel() } } label: {
            Image(systemName: "stop.fill").font(.system(size: 13)).foregroundStyle(prominent ? Palette.onInk : Palette.ink)
                .frame(width: 38, height: 38).background(prominent ? Palette.ink : Palette.control, in: Circle())
                .hitTarget()
        }
        .keyboardShortcut(".", modifiers: .command)
        .accessibilityLabel("停止生成")
    }

    private func sendButton(empty: Bool) -> some View {
        let editing = composer.editingQueue != nil
        let working = composer.executing || composer.savingQueueEdit
        let ready = !empty && !working && (editing || !composer.uploadsPending)
        return Button { send(.preferred) } label: {
            Group {
                if working { ProgressView().controlSize(.small).tint(Palette.onInk) }
                else { Image(systemName: sendIcon).font(.system(size: 17, weight: .semibold)) }
            }
            .foregroundStyle(ready || working ? Palette.onInk : Palette.faint)
            .frame(width: 38, height: 38)
            .background(ready || working ? Palette.ink : Palette.control, in: Circle())
            .hitTarget()
        }
        // Pending uploads still answer a tap, with the reason (C-87).
        .disabled(empty || working)
        // Not plain Return: on a hardware keyboard that also ends a pinyin composition.
        .keyboardShortcut(.return, modifiers: .command)
        .contextMenu {
            if model.running && !editing {
                Button { send(.queue) } label: { Label("排队发送", systemImage: "clock") }
                Button { send(.steer) } label: { Label("插话发送", systemImage: "bolt") }
            }
        }
        .accessibilityLabel(sendLabel)
        .accessibilityHint(model.running ? (context.busyEnter == "steer" ? "长按可排队发送" : "长按可插话发送") : "")
    }

    /// A plain message while the agent runs goes by the busy-Enter preference; commands run at once.
    private var goesToBusyAgent: Bool {
        model.running && !composer.text.trimmingCharacters(in: .whitespaces).hasPrefix("/")
    }

    private var sendLabel: LocalizedStringKey {
        if composer.editingQueue != nil { return "保存排队消息" }
        guard goesToBusyAgent else { return "发送消息" }
        return context.busyEnter == "steer" ? "插话发送" : "排队发送"
    }

    private var sendIcon: String {
        if composer.editingQueue != nil { return "checkmark" }
        guard goesToBusyAgent else { return "arrow.up" }
        return context.busyEnter == "steer" ? "bolt.fill" : "clock"
    }

    // MARK: Sending

    private func send(_ gesture: ComposerModel.Gesture) {
        if composer.editingQueue != nil {
            Haptics.tap()
            composer.saveQueueEdit { if focused { clearFocusedTextInput() } }
            return
        }
        let trimmed = composer.text.trimmingCharacters(in: .whitespacesAndNewlines)
        // The client's own commands, typed bare.
        if composer.attachments.isEmpty, trimmed == "/model" || trimmed == "/file" {
            composer.text = ""
            if trimmed == "/model" { showModels = true } else { showFiles = true }
            return
        }
        // Bare `/permission` picks from the list, as the web's popup does (with an argument it executes).
        if composer.attachments.isEmpty, !context.permissionOptions.isEmpty, !trimmed.contains(where: \.isWhitespace),
           context.resolve(line: trimmed)?.0.builtinName == "permission" {
            composer.text = ""
            showPermissions = true
            return
        }
        if composer.attachments.isEmpty, context.resolve(line: trimmed)?.0.builtinName == "export" {
            composer.text = ""
            openLogExport()
            return
        }
        Haptics.tap()
        composer.submit(gesture, context: context) { if focused { clearFocusedTextInput() } }
    }

    // MARK: Candidates (C-98…C-103)

    /// `hit`: the token the choice replaces; nil (the ＋ tray) adds to the draft.
    private func pick(_ candidate: Candidate, over hit: TriggerHit?) {
        Haptics.select()
        // Mid-composition, a binding change alone would leave the old text on screen.
        if focused { clearFocusedTextInput() }
        func fill(_ replacement: String) {
            let text = composer.text
            if let hit {
                composer.text = hit.replacing(in: text, with: replacement)
            } else if !replacement.isEmpty {
                composer.text = text.isEmpty || text.last?.isWhitespace == true ? text + replacement : text + " " + replacement
                // From the tray: the draft has new text to carry on typing after.
                refocus = true
            }
        }
        switch candidate {
        case .command(let row):
            switch row.kind {
            case .file:
                fill("")
                showFiles = true
            case .model:
                fill("")
                showModels = true
            case .host(let descriptor):
                if descriptor.builtinName == "permission", !context.permissionOptions.isEmpty {
                    fill("")
                    showPermissions = true
                } else if descriptor.builtinName == "export" {
                    fill("")
                    openLogExport()
                } else if descriptor.hint != nil {
                    // A command taking arguments: its token opens the draft, the hint says what follows.
                    fill("/\(descriptor.name) ")
                } else {
                    fill("")
                    composer.runDetached("/\(descriptor.name)")
                }
            }
        case .insert(let text, let keepOpen):
            fill(keepOpen ? text : text + " ")
        case .reference(let title, let mention):
            fill(composer.addMention(title: title, raw: mention) + " ")
        }
    }

    /// A sheet is gone: run what it left behind; the keyboard returns if `refocus` says so and no picker took over.
    private func sheetClosed() {
        sheetUp.wrappedValue = false
        afterSheet?()
        afterSheet = nil
        // A picker that took over decides when it closes.
        guard !pickerUp else { return }
        if refocus && !showPermissions { focused = true }
        refocus = false
    }

    private var pickerUp: Bool { showPhotos || showCamera || showFiles || showModels }

    // MARK: Permission (C-110)

    private func choosePermission(_ value: String) {
        guard value != model.permission else { return }
        Haptics.select()
        if Self.needsConfirmation(value) {
            confirmingPermission = value
        } else {
            applyPermission(value)
        }
    }

    /// The modes that ask the user less: entering one takes a second, deliberate tap.
    static func needsConfirmation(_ value: String) -> Bool {
        value == "danger-full-access" || value == "auto"
    }

    private func applyPermission(_ value: String) {
        Task {
            do {
                try await model.executeCommand("/permission \(value)")
                // A command raises no timeline event that would re-read the mode.
                model.refreshProjections()
            } catch { app.showToast(composer.errorText(error)) }
        }
    }

    /// Menu rows: `auto` is experimental (the web's EXP badge).
    static func permissionTitle(_ option: (value: String, name: String)) -> String {
        option.value == "auto" ? permissionName(option) + "  EXP" : permissionName(option)
    }

    static func permissionName(_ option: (value: String, name: String)) -> String {
        switch option.value {
        case "read-only": String(localized: "仅可查看")
        case "workspace-write": String(localized: "工作区内修改")
        case "danger-full-access": String(localized: "完全权限")
        case "auto": String(localized: "自动审查")
        default: option.name
        }
    }

    static func permissionIcon(_ value: String) -> String {
        switch value {
        case "read-only": "eye"
        case "workspace-write": "pencil"
        case "danger-full-access": "exclamationmark.shield"
        case "auto": "wand.and.stars"
        default: "lock.shield"
        }
    }

    // MARK: Attachments

    private func loadPhotos(_ items: [PhotosPickerItem]) async {
        var refusal: String?
        for item in items {
            guard let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data) else { continue }
            if let reason = composer.addImage(image) { refusal = reason }
        }
        photos = []
        if let refusal { app.showToast(refusal) }
    }
}

/// The camera, for a photo straight into the draft (C-104).
struct CameraPicker: UIViewControllerRepresentable {
    let captured: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage { parent.captured(image) }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
    }
}

/// The draft on a page of its own, for text too long for the input.
private struct DraftEditor: View {
    @Bindable var composer: ComposerModel
    let send: () -> Void
    @FocusState private var focused: Bool
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let editingQueue = composer.editingQueue != nil
        NavigationStack {
            TextEditor(text: $composer.text)
                .font(.body)
                .tint(Palette.ink)
                .focused($focused)
                .padding(.horizontal, 12)
                .scrollContentBackground(.hidden)
                .background(Palette.background)
                .navigationTitle(editingQueue ? "编辑排队消息" : "编辑消息")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("收起") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(editingQueue ? "保存" : "发送", action: send).disabled(composer.nothingToSend)
                    }
                }
                .onAppear { focused = true }
        }
        .presentationDetents([.large])
    }
}

extension View {
    /// The alert before entering a mode that asks the user less (C-110). `pending` is the
    /// mode waiting for the answer; a presented view keeps its own, an alert can't reach across a sheet.
    func permissionConfirmation(_ pending: Binding<String?>, confirm: @escaping (String) -> Void) -> some View {
        let auto = pending.wrappedValue == "auto"
        return alert(
            auto ? "确认启用自动审查（实验）？" : "确认启用完全权限？",
            isPresented: Binding(get: { pending.wrappedValue != nil }, set: { if !$0 { pending.wrappedValue = nil } }),
            presenting: pending.wrappedValue
        ) { value in
            Button("取消", role: .cancel) {}
            Button(auto ? "启用自动审查" : "启用完全权限", role: .destructive) { confirm(value) }
        } message: { _ in
            Text("启用后，智能体将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任当前任务时使用。")
        }
    }
}

/// A bottom sheet as tall as its content (approval, question, confirmation):
/// large corner radius, page background; content taller than the screen scrolls.
struct FittedSheet: ViewModifier {
    @State private var height: CGFloat = 320

    func body(content: Content) -> some View {
        ScrollView {
            content.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
        }
        .scrollBounceBehavior(.basedOnSize)
        .presentationDetents([.height(height)])
        .presentationCornerRadius(36)
        .presentationDragIndicator(.hidden)
        .presentationBackground(Palette.background)
    }
}

extension View {
    func fittedSheet() -> some View { modifier(FittedSheet()) }
}
