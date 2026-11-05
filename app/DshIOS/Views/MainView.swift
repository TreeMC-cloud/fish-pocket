import SwiftUI

/// The root: a conversation, always. On iPhone the session list is a drawer
/// that slides in from the left (edge swipe or the top-left button); in
/// regular width it is the split view's sidebar. With nothing selected — at
/// launch, after archiving — a blank session in the current workspace opens.
struct MainView: View {
    enum Sheet: String, Identifiable { case settings, plugins, schedules, signIn, cordis; var id: String { rawValue } }

    @Environment(AppModel.self) private var app
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL
    @Environment(\.openWindow) private var openWindow
    @Environment(\.supportsMultipleWindows) private var supportsMultipleWindows
    @AppStorage("dsh.currentWorkspace") private var workspaceId = ""
    @State private var selection: String?
    @State private var sheet: Sheet?
    /// The sidebar, in regular width.
    @State private var sidebar = NavigationSplitViewVisibility.all
    @State private var windowWidth: CGFloat = 0
    @State private var searchRequest = 0
    @State private var drawerOpen = false
    @State private var drag: CGFloat = 0
    /// The way a drag on the shell set off, fixed by its first move; nil between drags.
    @GestureState private var dragAxis: Axis?
    /// A plain reference filled by the drawer's rows.
    @State private var rowFrames = DrawerRowFrames()
    @State private var creating = false
    @State private var onboarding: Onboarding?
    /// 「添加 API Key」 was chosen in the sign-in sheet: its key editor follows once that sheet is gone.
    @State private var keyEditorRef: String?
    /// The ask for a Star or a share.
    @State private var supportDialog = false

    /// `session`: the one this window opened on, when it opened on one.
    init(session: String? = nil) {
        _selection = State(initialValue: session)
    }

    /// The credential sheets (`settings.onboarding`'s steps). Unlike the web they never open by
    /// themselves at launch: the interface comes first, and a message sent with nothing to answer
    /// it asks for them (`SessionModel`), as do the sign-in buttons.
    enum Onboarding: Identifiable {
        case signIn(ref: String, autoStart: Bool = false)
        case key(ref: String)
        var id: String {
            switch self {
            case .signIn: "sign-in"
            case .key: "key"
            }
        }
    }

    private var workspace: Workspace? {
        app.workspaces.first { $0.id == workspaceId } ?? app.workspaces.first
    }

    /// A button of the support dialog: the ask is answered for good.
    private func settleSupport(then action: () -> Void) {
        Haptics.tap()
        SupportPrompt.settle()
        supportDialog = false
        action()
    }

    /// Announcements are made once, so never under a sheet.
    private var canAnnounce: Bool {
        scenePhase == .active && onboarding == nil && sheet == nil
    }

    var body: some View {
        Group {
            if sizeClass == .regular { split } else { drawerLayout }
        }
        .tint(Palette.ink)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { windowWidth = $0 }
        .focusedSceneValue(\.windowCommands, windowCommands)
        // A `dsh://` link goes to a window that is already open. Only that: `openWindow` asks
        // through the same door, and a wider match would swallow every new window.
        .handlesExternalEvents(preferring: ["dsh://"], allowing: ["dsh://"])
        .task(id: app.workspaces.map(\.id)) { if selection == nil { newConversation(in: workspace) } }
        .task(id: canAnnounce) {
            guard canAnnounce else { return }
            await UpdateChecker.shared.checkIfDue()
            guard let update = UpdateChecker.shared.takeAnnouncement() else { return }
            app.showToast(String(localized: "发现新版本 \(update.version)"), action: String(localized: "更新")) { openURL(update.url) }
        }
        // After a pause, and only into a quiet app: otherwise the next finished turn asks instead.
        .task(id: app.supportMoment) {
            guard app.supportMoment > 0 else { return }
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled, canAnnounce, app.toast == nil, app.currentSession == selection,
                  !app.sessions.values.contains(where: \.running), SupportPrompt.take() else { return }
            supportDialog = true
        }
        // Windows take turns: what is read is the one in front.
        .onChange(of: scenePhase) { _, phase in if phase == .active { app.currentSession = selection } }
        .onChange(of: selection) { _, id in
            app.currentSession = id
            if let id {
                if let owner = app.workspace(of: id) { workspaceId = owner.id }
            } else {
                newConversation(in: workspace)
            }
        }
        // An archived current session leaves the main view (here, the drawer, a follow push).
        .onChange(of: app.archived) { _, archived in
            if let selection, archived.contains(selection) { self.selection = nil }
        }
        // `app.open(session:)`: toasts, the subagent catalog, schedules…
        .onChange(of: app.openRequest?.token) { _, token in
            guard token != nil, scenePhase != .background, let id = app.openRequest?.id else { return }
            app.openRequest = nil
            selection = id
            setDrawer(false)
        }
        .onChange(of: app.newSessionRequest?.token) { _, token in
            guard token != nil, scenePhase != .background, let request = app.newSessionRequest else { return }
            app.newSessionRequest = nil
            sheet = nil
            let target = request.workspaceId.flatMap { id in app.workspaces.first { $0.id == id } } ?? workspace
            if let target { workspaceId = target.id }
            newConversation(in: target, agentPreset: request.agentPreset, draft: request.draft)
            setDrawer(false)
        }
        .onChange(of: app.credentialRequest?.token) { _, token in
            guard token != nil, scenePhase != .background, let step = app.credentialRequest?.step else { return }
            app.credentialRequest = nil
            Task { await openCredentials(step) }
        }
        // dsh://session/<id>, from the Live Activity.
        .onOpenURL { url in
            guard url.scheme == "dsh", url.host() == "session", let id = url.pathComponents.dropFirst().first else { return }
            selection = id
            setDrawer(false)
        }
        #if DEBUG
        // Screenshots and UI checks: `simctl launch … -dshOpen drawer|workbench|approval|timeline|settings|plugins|schedules|signin|support`.
        .task {
            switch UserDefaults.standard.string(forKey: "dshOpen") {
            case "drawer": drawerOpen = true
            case "settings": sheet = .settings
            case "plugins": sheet = .plugins
            case "schedules": sheet = .schedules
            case "signin": sheet = .signIn
            case "support": supportDialog = true
            default: break
            }
        }
        #endif
        .sheet(item: $sheet) { sheet in
            Group {
                switch sheet {
                case .settings: SettingsView()
                case .plugins: SheetStack { PluginsView() }
                case .schedules: SheetStack { SchedulesView(openSession: open(session:)) }
                case .signIn: SignInSheet()
                case .cordis: CordisPanelView(currentSession: selection)
                }
            }
            .sheetNotices()
        }
        .sheet(item: $onboarding, onDismiss: onboardingDismissed) { step in
            switch step {
            case .signIn(let ref, let autoStart):
                SignInSheet(autoStart: autoStart, addAPIKey: { keyEditorRef = ref })
            case .key(let ref):
                OnboardingKeySheet(ref: ref) { onboarding = nil }
            }
        }
        .modifier(ShellDialogs())
        .overlay { ShellNotices() }
        .overlay {
            if supportDialog {
                SupportDialog(
                    star: { settleSupport { openURL(AppLinks.repository) } },
                    share: { settleSupport { AppLinks.share() } },
                    later: { supportDialog = false }
                )
                .transition(.opacity.combined(with: .scale(scale: 0.94)))
            }
        }
        .animation(.snappy, value: supportDialog)
        // A live turn ran out of account balance: offer Platform's top-up page, then re-read balances.
        .alert("当前无可用余额", isPresented: Binding(get: { app.account.quotaPrompt }, set: { app.account.quotaPrompt = $0 })) {
            Button("取消", role: .cancel) {}
            Button("去充值") {
                guard let url = app.account.topUpURL else { return }
                InAppSafari.open(url) { Task { await app.account.refreshDetails() } }
            }
        } message: {
            Text("充值后才能开始新会话，也可稍后在「设置 → 账号与余额」充值。")
        }
        .onChange(of: app.lastError) { _, error in if error != nil { Haptics.error() } }
        .alert("出错了", isPresented: Binding(get: { app.lastError != nil }, set: { if !$0 { app.lastError = nil } })) {
            Button("好", role: .cancel) {}
        } message: {
            Text(app.lastError ?? "")
        }
        .environment(\.openSession) { open(session: $0) }
    }

    // MARK: Credentials

    /// Without a reference (the official route is off) the key lives in settings, and signing in is all that is left.
    private func openCredentials(_ step: AppModel.CredentialStep) async {
        sheet = nil
        if case .settings = step { sheet = .settings; return }
        guard let ref = await app.officialKeyRef() else {
            if case .officialKey = step { sheet = .settings } else { sheet = .signIn }
            return
        }
        switch step {
        case .start, .signIn:
            if case .signIn = step { onboarding = .signIn(ref: ref, autoStart: true) } else { onboarding = .signIn(ref: ref) }
        case .officialKey:
            onboarding = .key(ref: ref)
        case .settings:
            break
        }
    }

    /// 「添加 API Key」 in the sign-in sheet hands over to the key editor once that sheet is gone.
    private func onboardingDismissed() {
        guard let ref = keyEditorRef else { return }
        keyEditorRef = nil
        onboarding = .key(ref: ref)
    }

    // MARK: Layouts

    private var split: some View {
        NavigationSplitView(columnVisibility: $sidebar) {
            drawer.navigationSplitViewColumnWidth(min: 280, ideal: 320, max: 360)
                .toolbar(.hidden, for: .navigationBar)
                .toolbar(removing: .sidebarToggle)
        } detail: {
            NavigationStack { conversation(openDrawer: toggleSidebar) }
        }
        // Side by side at any width: the sidebar never floats over the conversation.
        .navigationSplitViewStyle(.balanced)
    }

    private var windowCommands: WindowCommands {
        WindowCommands(
            newConversation: {
                sheet = nil
                newConversation(in: workspace)
                setDrawer(false)
            },
            newWindow: supportsMultipleWindows ? { openWindow(id: DshIOSApp.window) } : nil,
            search: {
                sheet = nil
                if sizeClass == .regular { withAnimation { sidebar = .all } } else { setDrawer(true) }
                searchRequest += 1
            },
            toggleSidebar: toggleSidebar,
            openSettings: { sheet = .settings }
        )
    }

    private func toggleSidebar() {
        if sizeClass == .regular {
            withAnimation { sidebar = sidebar == .detailOnly ? .all : .detailOnly }
        } else {
            setDrawer(!drawerOpen)
        }
    }

    /// The workbench takes about 420 pt: under this much, the conversation would be left too little.
    private func makeRoomForWorkbench() {
        if windowWidth < 1100 { withAnimation { sidebar = .detailOnly } }
    }

    private var drawerLayout: some View {
        GeometryReader { geometry in
            let width = min(326, geometry.size.width - 64)
            let progress = min(1, max(0, (drawerOpen ? 1 : 0) + drag / width))
            ZStack(alignment: .leading) {
                NavigationStack { conversation(openDrawer: { setDrawer(true) }) }
                    .accessibilityHidden(drawerOpen)
                Palette.scrim
                    .opacity(progress)
                    .ignoresSafeArea()
                    .allowsHitTesting(progress > 0)
                    .onTapGesture { setDrawer(false) }
                    .accessibilityLabel("关闭侧边栏")
                    .accessibilityAddTraits(.isButton)
                    .accessibilityHidden(!drawerOpen)
                drawer
                    .frame(width: width)
                    .offset(x: (progress - 1) * width)
                    .accessibilityHidden(!drawerOpen)
            }
            .coordinateSpace(.named(DrawerRowFrames.space))
            .background {
                DrawerEdgePan(enabled: !drawerOpen) { translation in
                    if drag == 0 { dismissKeyboard() }
                    drag = max(0, translation)
                } ended: { predicted in
                    settleDrawer(predicted: predicted, width: width)
                }
            }
            // Only over the open drawer: over the conversation it would run through every scroll.
            .simultaneousGesture(dragGesture(width: width), including: drawerOpen ? .all : .subviews)
            // A list that takes over the touch cancels the drag with no end to settle it
            // (looked at afterwards: a real end settles first).
            .onChange(of: dragAxis) { _, axis in
                guard axis == nil else { return }
                Task { @MainActor in
                    if drag != 0 { withAnimation(.snappy(duration: 0.25)) { drag = 0 } }
                }
            }
        }
    }

    /// A leftward swipe closes, from the dimmed side or anywhere in the drawer but a session
    /// row (there it reveals the row's actions). It follows the finger and settles by distance
    /// or speed; a drag that set off vertically stays a scroll. `DrawerEdgePan` opens.
    private func dragGesture(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 12, coordinateSpace: .named(DrawerRowFrames.space))
            .updating($dragAxis) { value, axis, _ in
                if axis == nil { axis = abs(value.translation.width) > abs(value.translation.height) ? .horizontal : .vertical }
            }
            .onChanged { value in
                guard dragAxis == .horizontal, value.startLocation.x > width || !rowFrames.hasRow(atY: value.startLocation.y) else { return }
                drag = min(0, value.translation.width)
            }
            .onEnded { value in
                settleDrawer(predicted: value.predictedEndTranslation.width, width: width)
            }
    }

    private func settleDrawer(predicted: CGFloat, width: CGFloat) {
        guard drag != 0 else { return }
        let open = drawerOpen ? predicted > -width / 2 : predicted > width / 2
        if open != drawerOpen { Haptics.select() }
        withAnimation(.snappy(duration: 0.25)) {
            drawerOpen = open
            drag = 0
        }
    }

    /// Show `id` from wherever it was asked for: over a sheet it closes first.
    private func open(session id: String) {
        sheet = nil
        selection = id
        setDrawer(false)
    }

    private func setDrawer(_ open: Bool) {
        if open { dismissKeyboard() }
        withAnimation(.snappy(duration: 0.25)) { drawerOpen = open }
    }

    private var drawer: some View {
        DrawerView(
            selection: selection,
            workspace: workspace,
            rowFrames: rowFrames,
            select: { id in selection = id; setDrawer(false) },
            newConversation: { workspace in workspaceId = workspace.id; newConversation(in: workspace); setDrawer(false) },
            openSettings: { sheet = .settings },
            openSchedules: { sheet = .schedules },
            openCordis: { sheet = .cordis },
            openSignIn: { sheet = .signIn },
            searchRequest: searchRequest,
            openInWindow: supportsMultipleWindows ? { openWindow(id: DshIOSApp.window, value: SessionWindow(session: $0)) } : nil
        )
    }

    @ViewBuilder
    private func conversation(openDrawer: (() -> Void)?) -> some View {
        if let selection {
            ConversationView(sessionId: selection, selection: $selection, openDrawer: openDrawer, switchWorkspace: { workspace in
                workspaceId = workspace.id
                newConversation(in: workspace)
            }, makeRoomForWorkbench: makeRoomForWorkbench)
            .id(selection)
        } else {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Palette.background)
                .toolbar { if let openDrawer { ToolbarItem(placement: .topBarLeading) { DrawerButton(action: openDrawer) } } }
        }
    }

    /// Open a blank conversation in `workspace` (the engine reuses a blank one there).
    private func newConversation(in workspace: Workspace?, agentPreset: String? = nil, draft: String? = nil) {
        guard let workspace, !creating else { return }
        creating = true
        Task {
            defer { creating = false }
            do {
                let id = try await app.createSession(in: workspace, agentPreset: agentPreset)
                if let draft { app.pendingDrafts[id] = draft }
                selection = id
            }
            catch { app.showToast(String(localized: "新建会话失败：\(error.localizedDescription)"), tone: .warning, duration: 6) }
        }
    }
}

/// A navigation stack with a close button, for a list presented on its own.
struct SheetStack<Content: View>: View {
    @ViewBuilder let content: Content
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack { content.closeButton(dismiss) }
    }
}

/// A swipe from the screen's left edge, reported as it follows the finger. On the root view:
/// sheets above it keep their own edges.
private struct DrawerEdgePan: UIViewRepresentable {
    let enabled: Bool
    let changed: (CGFloat) -> Void
    /// Where the swipe would come to rest; 0 when it was cancelled.
    let ended: (CGFloat) -> Void

    func makeUIView(context: Context) -> Catcher { Catcher() }

    func updateUIView(_ view: Catcher, context: Context) {
        view.enabled = enabled
        view.changed = changed
        view.ended = ended
    }

    final class Catcher: UIView, UIGestureRecognizerDelegate {
        var enabled = true
        var changed: (CGFloat) -> Void = { _ in }
        var ended: (CGFloat) -> Void = { _ in }
        private lazy var recognizer: UIScreenEdgePanGestureRecognizer = {
            let recognizer = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(panned))
            recognizer.edges = .left
            recognizer.delegate = self
            return recognizer
        }()

        override func didMoveToWindow() {
            recognizer.view?.removeGestureRecognizer(recognizer)
            window?.rootViewController?.view.addGestureRecognizer(recognizer)
        }

        override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool { enabled }

        @objc private func panned(_ recognizer: UIScreenEdgePanGestureRecognizer) {
            let translation = recognizer.translation(in: recognizer.view).x
            switch recognizer.state {
            case .began, .changed: changed(translation)
            case .ended: ended(translation + recognizer.velocity(in: recognizer.view).x * 0.2)
            default: ended(0)
            }
        }
    }
}
