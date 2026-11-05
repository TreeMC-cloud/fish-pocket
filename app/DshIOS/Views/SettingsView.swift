import SafariServices
import SwiftUI

/// Settings: only what people come here for (账号, 模型, 访问模式, 外观, 插件, 自动化,
/// 后台运行: 静音音频, 任务续跑). Developer pages sit behind 高级, versions and engine status behind 关于,
/// and the star, source, feedback and author links close the list; the engine card shows here only while
/// the engine is not running. Every page reads the shared settings mirror, so a write
/// anywhere shows everywhere.
struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @EnvironmentObject private var engine: NodeEngine
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openSession) private var openSession
    @State private var defaultModel: String?
    @State private var pluginCount: Int?
    @State private var engineVersion: String?
    @State private var permissionOptions: [JSON] = []
    /// What new sessions start with until the user picks: the setting's value is empty then.
    @State private var catalogDefaultPermission = ""
    @State private var confirmingFullAccess = false
    @AppStorage(BackgroundKeeper.enabledKey) private var keepAlive = true
    @State private var confirmingKeepAliveOff = false
    @AppStorage(BackgroundKeeper.continuedKey) private var continuedProcessing = false

    private var mirror: SettingsMirror { app.settings }

    private var engineRunning: Bool {
        if case .running = engine.phase { return true }
        return false
    }

    var body: some View {
        NavigationStack {
            List {
                if !engineRunning {
                    Section { EngineCard() }
                        .listRowBackground(Palette.grouped)
                        .listRowInsets(EdgeInsets(top: 18, leading: 18, bottom: 18, trailing: 18))
                }

                Section {
                    NavigationLink { AccountPage() } label: {
                        valueRow("账号", app.account.signedIn ? (app.account.displayName ?? String(localized: "已登录")) : String(localized: "未登录"))
                    }
                    NavigationLink { ModelProvidersPage() } label: { valueRow("模型", defaultModel ?? "") }
                    if mirror.serves("permission") { permissionPicker }
                    if let theme = mirror.namespace("ui-theme") {
                        Picker("外观", selection: Binding(get: { theme["value"]["preference"].string ?? "system" }, set: { value in
                            Task { await write("ui-theme", ["preference"], .string(value)) }
                        })) {
                            Text("跟随系统").tag("system")
                            Text("浅色").tag("light")
                            Text("深色").tag("dark")
                        }
                    }
                }
                .groupedRow()

                Section {
                    NavigationLink { PluginsView() } label: { valueRow("插件", pluginCount.map { String(localized: "\($0) 个") } ?? "") }
                    NavigationLink { SchedulesView(openSession: openSession) } label: { valueRow("自动化", app.scheduleCount.map { String(localized: "\($0) 个") } ?? "") }
                }
                .groupedRow()

                Section {
                    // Turning it off asks first: without it the system may end the engine in the background.
                    Toggle("静音音频", isOn: Binding(get: { keepAlive }, set: { on in
                        if on { keepAlive = true } else { confirmingKeepAliveOff = true }
                    }))
                    .toggleStyle(.mono)
                    // The system's continued-processing task exists from iOS 26 only.
                    if #available(iOS 26.0, *) {
                        Toggle("任务续跑", isOn: $continuedProcessing)
                            .toggleStyle(.mono)
                    }
                } header: {
                    Text("后台运行")
                } footer: {
                    Text(backgroundFooter)
                }
                .groupedRow()
                .onChange(of: keepAlive) { BackgroundKeeper.shared.settingsChanged() }
                .onChange(of: continuedProcessing) { BackgroundKeeper.shared.settingsChanged() }
                .alert("关闭静音音频？", isPresented: $confirmingKeepAliveOff) {
                    Button("取消", role: .cancel) {}
                    Button("关闭", role: .destructive) { keepAlive = false }
                } message: {
                    Text("离开 App 时\(turnsOffScreen)，之后引擎可能被系统暂停，自动化和开发服务器会中断。")
                }

                Section {
                    NavigationLink("高级") { AdvancedSettingsPage() }
                    NavigationLink { AboutPage(engineVersion: engineVersion) } label: { valueRow("关于", aboutValue) }
                }
                .groupedRow()

                Section {
                    linkRow("给个 Star", "GitHub", Self.repositoryURL)
                        .environment(\.openURL, OpenURLAction { _ in SupportPrompt.settle(); return .systemAction })
                    ShareLink(item: AppLinks.shareText) {
                        HStack {
                            Text("分享给朋友").foregroundStyle(Palette.ink)
                            Spacer()
                            Image(systemName: "square.and.arrow.up").font(.caption).foregroundStyle(Palette.faint)
                        }
                    }
                    linkRow("开源仓库", UpdateChecker.repository, Self.repositoryURL)
                    linkRow("问题反馈", "GitHub Issues", Self.issuesURL)
                    linkRow("作者", "sai · imsai.cc", Self.authorURL)
                } footer: {
                    Text("觉得好用的话，去 GitHub 仓库页点一下 Star ⭐️，这是对项目最大的支持。")
                }
                .groupedRow()
            }
            .groupedList()
            .tint(Palette.ink)
            .navigationTitle("设置")
            .navigationBarTitleDisplayMode(.large)
            .closeButton(dismiss)
            .alert("启用完全权限？", isPresented: $confirmingFullAccess) {
                Button("取消", role: .cancel) {}
                Button("启用", role: .destructive) { Task { await write("permission", ["defaultPreset"], "danger-full-access") } }
            } message: {
                Text("新会话将减少确认步骤，可以直接改文件、跑命令。仅在信任后续任务时使用。")
            }
            .followSettings()
            .task { await load() }
            .task(id: app.settingsRevision) { await loadDerived() }
            .task(id: app.revision("permission-presets/catalog-changed")) { await loadPermissions() }
        }
    }

    private var aboutValue: String {
        if case .available = UpdateChecker.shared.status { return String(localized: "有新版本") }
        return ""
    }

    private static let repositoryURL = AppLinks.repository
    private static let issuesURL = repositoryURL.appending(path: "issues")
    private static let authorURL = URL(string: "https://imsai.cc")!

    /// Opens in the browser; the arrow says it leaves the app.
    private func linkRow(_ title: LocalizedStringKey, _ value: String, _ url: URL) -> some View {
        Link(destination: url) {
            HStack {
                Text(title).foregroundStyle(Palette.ink)
                Spacer()
                Text(value).foregroundStyle(Palette.secondary).lineLimit(1)
                Image(systemName: "arrow.up.right").font(.caption).foregroundStyle(Palette.faint)
            }
        }
    }

    private func valueRow(_ title: LocalizedStringKey, _ value: String) -> some View {
        HStack {
            Text(title).foregroundStyle(Palette.ink)
            Spacer()
            Text(value).foregroundStyle(Palette.secondary).lineLimit(1)
        }
    }

    /// G-01: the permission new sessions start with; full access asks first.
    private var permissionPicker: some View {
        let current = mirror.namespace("permission")?["value"]["defaultPreset"].string ?? catalogDefaultPermission
        return Picker("默认访问模式", selection: Binding(get: { current }, set: { value in
            if value == "danger-full-access" { confirmingFullAccess = true }
            else { Task { await write("permission", ["defaultPreset"], .string(value)) } }
        })) {
            ForEach(permissionOptions, id: \.self) { option in
                Text(Self.permissionName(option)).tag(option["value"].string ?? "")
            }
            if !permissionOptions.contains(where: { $0["value"].string == current }) {
                Text(current).tag(current)
            }
        }
    }

    /// 任务续跑 is on and available (BackgroundKeeper's continued task needs iOS 26).
    private var continuesTurns: Bool {
        guard #available(iOS 26.0, *) else { return false }
        return continuedProcessing
    }

    /// What happens to in-flight turns without silent audio.
    private var turnsOffScreen: String {
        continuesTurns
            ? String(localized: "进行中的任务会继续跑完（系统显示进度，可随时停止）")
            : String(localized: "进行中的任务最多再跑约 30 秒")
    }

    private var backgroundFooter: String {
        guard keepAlive else { return String(localized: "离开 App 后，\(turnsOffScreen)，之后引擎可能被系统暂停。") }
        return continuesTurns
            ? String(localized: "离开 App 后播放无声音频，任务、自动化和开发服务器都不停，会多耗一些电。音频被来电等打断时，进行中的任务仍会继续跑完。")
            : String(localized: "离开 App 后播放无声音频，任务、自动化和开发服务器都不停。会多耗一些电。")
    }

    private static func permissionName(_ option: JSON) -> String {
        switch option["value"].string {
        case "read-only": String(localized: "仅可查看")
        case "workspace-write": String(localized: "工作区内修改")
        case "danger-full-access": String(localized: "完全权限")
        case "auto": String(localized: "自动审查")
        default: localized(option["name"]) ?? option["value"].string ?? ""
        }
    }

    private func load() async {
        if let value = try? await app.client.call("pluginManager/listBundles") {
            let bundles = value.array
            pluginCount = bundles.filter { $0["enabled"].bool == true && !PluginManagerModel.builtInProfileBundles.contains($0["name"].string ?? "") }.count
            engineVersion = bundles.first { $0["name"].string == "@deepseek-ai/dsh-base" }?["version"].string
        }
        await app.account.refresh()
    }

    /// What the rows show that depends on settings.
    private func loadDerived() async {
        if let value = try? await app.client.call("session/modelCatalog") {
            let provider = value["default"]["provider"].string, model = value["default"]["model"].string
            let group = value["groups"].array.first { $0["id"].string == provider }
            defaultModel = group?["models"].array.first { $0["id"].string == model }?["name"].string ?? model
        }
    }

    private func loadPermissions() async {
        if let value = try? await app.client.call("permissionPresets/catalog") {
            permissionOptions = value["defaultOptions"].array.isEmpty ? value["options"].array : value["defaultOptions"].array
            catalogDefaultPermission = value["defaultPreset"].string ?? ""
        }
    }

    private func write(_ ns: String, _ path: [String], _ value: JSON) async {
        do {
            try await mirror.set(ns, path, value)
            if ns == "ui-theme" { await app.reloadTheme() }
        } catch {
            Haptics.error()
            app.showToast(describeFailure(error), duration: 5)
        }
    }
}

/// 设置 → 高级: the pages for people who look under the hood.
private struct AdvancedSettingsPage: View {
    @Environment(AppModel.self) private var app
    @EnvironmentObject private var engine: NodeEngine
    @State private var showWeb = false
    @State private var showCordis = false

    var body: some View {
        List {
            Section {
                NavigationLink("内置插件") { PluginInventoryPage() }
                if !app.cordis.rows.isEmpty {
                    Button("Cordis 插件") { showCordis = true }.foregroundStyle(Palette.ink)
                }
                NavigationLink("Agent 预设") { AgentPresetsPage() }
                NavigationLink("全部设置") { AllSettingsPage() }
            }
            .groupedRow()

            Section {
                if app.settings.hasDocument {
                    NavigationLink("配置文件") { ConfigDocumentView() }
                }
                NavigationLink("引擎日志") { EngineLogView(file: engine.logFile) }
                Button { showWeb = true } label: { Text("网页版").foregroundStyle(Palette.ink) }
            } footer: {
                Text("网页版用于只有网页界面的插件，设置与这里共用同一份配置。")
            }
            .groupedRow()
        }
        .groupedList()
        .sheet(isPresented: $showCordis) { CordisPanelView(currentSession: nil) }
        .navigationTitle("高级")
        .navigationBarTitleDisplayMode(.inline)
        .fullScreenCover(isPresented: $showWeb) { WebFallbackView() }
    }
}

/// 设置 → 关于: the way to a newer version, or a manual check for one.
private struct UpdateRow: View {
    @Environment(\.openURL) private var openURL
    private let checker = UpdateChecker.shared

    var body: some View {
        switch checker.status {
        case .available(let update):
            Button("更新到 \(update.version)") { openURL(update.url) }
        case .checking:
            LabeledContent("检查更新") { ProgressView() }
        case .idle, .upToDate, .failed:
            Button { Task { await checker.check() } } label: {
                LabeledContent("检查更新", value: note)
            }
        }
    }

    private var note: String {
        switch checker.status {
        case .upToDate: String(localized: "已是最新版本")
        case .failed: String(localized: "检查失败")
        default: ""
        }
    }
}

/// 设置 → 关于: versions, storage and how the engine is doing.
private struct AboutPage: View {
    @Environment(AppModel.self) private var app
    @EnvironmentObject private var engine: NodeEngine
    let engineVersion: String?
    @State private var storage: Int64?

    var body: some View {
        List {
            Section { EngineCard() }
                .listRowBackground(Palette.grouped)
            Section {
                LabeledContent("引擎", value: "DeepSeek Harness")
                if let engineVersion { LabeledContent("引擎版本", value: engineVersion) }
                LabeledContent("App 版本", value: Self.appVersion)
                UpdateRow()
                LabeledContent("系统", value: ProcessInfo.processInfo.operatingSystemVersionString)
            }
            .groupedRow()
            Section {
                LabeledContent("连接状态", value: app.connected ? String(localized: "已连接") : String(localized: "重新连接中"))
                LabeledContent("存储", value: storage.map { ByteCountFormatter.string(fromByteCount: $0, countStyle: .file) } ?? "…")
            }
            .groupedRow()
        }
        .groupedList()
        .navigationTitle("关于")
        .navigationBarTitleDisplayMode(.inline)
        .task { storage = await Self.storageSize() }
    }

    private static var appVersion: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "—"
        let build = info?["CFBundleVersion"] as? String
        return build.map { "\(version) (\($0))" } ?? version
    }

    /// The engine's data and its workspaces.
    nonisolated private static func storageSize() async -> Int64 {
        await Task.detached(priority: .utility) {
            var total: Int64 = 0
            guard let walker = FileManager.default.enumerator(at: EnginePaths.data, includingPropertiesForKeys: [.totalFileAllocatedSizeKey]) else { return 0 }
            while let url = walker.nextObject() as? URL {
                total += Int64((try? url.resourceValues(forKeys: [.totalFileAllocatedSizeKey]))?.totalFileAllocatedSize ?? 0)
            }
            return total
        }.value
    }
}

/// 全部设置: every settings namespace, by topic.
private struct AllSettingsPage: View {
    @Environment(AppModel.self) private var app

    private var mirror: SettingsMirror { app.settings }

    var body: some View {
        List {
            Section {
                ForEach(grouped, id: \.title) { group in
                    NavigationLink(group.title) {
                        List {
                            Section {
                                ForEach(group.items, id: \.self) { ns in
                                    let name = ns["ns"].string ?? ""
                                    let title = namespaceTitle(name, app)
                                    NavigationLink(title) { NamespaceFormView(title: title, ns: name) }
                                }
                            }
                            .groupedRow()
                        }
                        .groupedList()
                        .navigationTitle(group.title)
                    }
                }
            } footer: {
                Text("这些设置和网页版、桌面版共用同一份配置。")
            }
            .groupedRow()
        }
        .groupedList()
        .navigationTitle("全部设置")
        .navigationBarTitleDisplayMode(.inline)
        // The plugin titles the rows of unnamed namespaces fall back to.
        .task(id: app.revision("plugin-manager/changed")) { await app.plugins.refresh(revision: app.revision("plugin-manager/changed")) }
    }

    private var grouped: [(title: String, items: [JSON])] {
        let groups: [(String, (String) -> Bool)] = [
            (String(localized: "通用"), { ["ui-settings-general", "locale", "ui-theme", "ui-conversation", "ui-chat", "permission", "ui-settings", "ui-settings-account"].contains($0) }),
            (String(localized: "模型"), { $0.hasPrefix("llm-") || $0.contains("model") }),
            (String(localized: "智能体与工具"), { ["agent-loop", "subagent", "bash-sandbox", "web", "agent-preset-registry", "session-log-deepseek"].contains($0) || $0.hasPrefix("web-") }),
        ]
        var used = Set<String>()
        var result: [(String, [JSON])] = []
        for (title, match) in groups {
            let items = mirror.namespaces.filter { match($0["ns"].string ?? "") && !used.contains($0["ns"].string ?? "") }
            items.forEach { used.insert($0["ns"].string ?? "") }
            if !items.isEmpty { result.append((title, items)) }
        }
        let rest = mirror.namespaces.filter { !used.contains($0["ns"].string ?? "") }
        if !rest.isEmpty { result.append((String(localized: "插件"), rest)) }
        return result
    }
}

/// What a settings namespace reads as: its known name, the plugin that owns it, its schema's
/// short description, and last its key humanized; the raw namespace never shows.
@MainActor
func namespaceTitle(_ ns: String, _ app: AppModel) -> String {
    let names = [
        "ui-settings-general": String(localized: "通用"), "ui-settings": String(localized: "代码工具"), "ui-settings-account": String(localized: "账号"),
        "locale": String(localized: "语言"), "ui-theme": String(localized: "外观"), "ui-conversation": String(localized: "对话"), "ui-chat": String(localized: "输入框"),
        "permission": String(localized: "权限"), "agent-default-model": String(localized: "默认模型"), "agent-loop": String(localized: "Agent 循环"),
        "subagent": String(localized: "子智能体"), "subagent-model-selection-settings": String(localized: "子智能体模型"),
        "bash-sandbox": String(localized: "终端"), "web": String(localized: "网页工具"), "agent-preset-registry": String(localized: "Agent 预设"),
        "llm-deepseek": String(localized: "DeepSeek API"), "llm-deepseek-account": String(localized: "DeepSeek 账号模型"), "llm-pi-ai": String(localized: "其他模型服务"),
        "web-search-deepseek": String(localized: "DeepSeek 搜索"), "web-deepseek-api": String(localized: "DeepSeek 搜索 API"),
    ]
    if let name = names[ns] { return name }
    let owner = app.plugins.packages.first { package in
        package.name == ns || package.name.components(separatedBy: "/").last == ns || package.rows.contains { $0.entryId == ns || $0.rowId == ns }
    }
    if let owner { return owner.title }
    if let root = app.settings.graph(ns)?.root, let text = schemaText(root.meta["description"]), text.count <= 20, !text.contains("\n") { return text }
    return humanize(ns.replacingOccurrences(of: #"^(dsh-|ui-settings-|ui-)"#, with: "", options: .regularExpression))
}

/// Web pages in an in-app Safari, presented from UIKit over whatever is on
/// screen. Not a SwiftUI sheet: Safari's Done dismisses the controller itself,
/// and a sheet binding reset after that dismisses the sheet underneath instead.
@MainActor
enum InAppSafari {
    private final class Delegate: NSObject, SFSafariViewControllerDelegate {
        let onFinish: (() -> Void)?
        init(onFinish: (() -> Void)?) { self.onFinish = onFinish }
        func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
            MainActor.assumeIsolated {
                InAppSafari.delegates[ObjectIdentifier(controller)] = nil
                onFinish?()
            }
        }
    }

    /// The controller's delegate is weak; keep each one until its page closes.
    private static var delegates: [ObjectIdentifier: Delegate] = [:]

    /// Open `url`; `onFinish` runs when the user closes it with Done.
    @discardableResult
    static func open(_ url: URL, onFinish: (() -> Void)? = nil) -> SFSafariViewController? {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
            ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        guard var top = scene?.keyWindow?.rootViewController else { return nil }
        while let presented = top.presentedViewController, !presented.isBeingDismissed { top = presented }
        let controller = SFSafariViewController(url: url)
        // A card, as a SwiftUI sheet would be: what is under it stays on screen.
        controller.modalPresentationStyle = .pageSheet
        let delegate = Delegate(onFinish: onFinish)
        delegates[ObjectIdentifier(controller)] = delegate
        controller.delegate = delegate
        top.present(controller, animated: true)
        return controller
    }

    /// Close a page from code (sign-in settled); no `onFinish` for it.
    static func close(_ controller: SFSafariViewController?) {
        guard let controller else { return }
        delegates[ObjectIdentifier(controller)] = nil
        if controller.presentingViewController != nil, !controller.isBeingDismissed { controller.dismiss(animated: true) }
    }
}

/// Status dot, uptime and memory of the in-process engine.
private struct EngineCard: View {
    @EnvironmentObject private var engine: NodeEngine

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            HStack(spacing: 14) {
                if case .running = engine.phase { StatusDot(state: .running, size: 8, halo: true) }
                else { Circle().fill(Palette.faint).frame(width: 8, height: 8) }
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.callout.weight(.semibold))
                    Text(detail(now: context.date)).font(.footnote).foregroundStyle(Palette.secondary)
                }
                Spacer(minLength: 0)
            }
            .accessibilityElement(children: .combine)
        }
    }

    private var title: String {
        switch engine.phase {
        case .starting: String(localized: "引擎启动中")
        case .running: String(localized: "引擎运行中")
        case .exited(let code): String(localized: "引擎已退出（\(code)）")
        }
    }

    private func detail(now: Date) -> String {
        var parts: [String] = []
        if case .running = engine.phase, let since = engine.runningSince {
            let uptime = Duration.seconds(max(60, now.timeIntervalSince(since)))
            parts.append(String(localized: "已运行 \(uptime.formatted(.units(allowed: [.days, .hours, .minutes], width: .narrow, maximumUnitCount: 2)))"))
        }
        if let memory = Self.memoryFootprint() {
            parts.append(String(localized: "内存 \(ByteCountFormatter.string(fromByteCount: Int64(memory), countStyle: .memory))"))
        }
        return parts.joined(separator: " · ")
    }

    /// The app's physical footprint: Node runs in this process.
    private static func memoryFootprint() -> UInt64? {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
        }
        return result == KERN_SUCCESS ? info.phys_footprint : nil
    }
}

/// The tail of the engine's console log.
private struct EngineLogView: View {
    let file: URL
    @State private var text = ""

    var body: some View {
        ScrollView {
            Text(text.isEmpty ? String(localized: "（日志为空）") : text)
                .font(.caption2.monospaced())
                .foregroundStyle(Palette.ink)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
        }
        .defaultScrollAnchor(.bottom)
        .background(Palette.grouped)
        .navigationTitle("引擎日志")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button { load() } label: { Image(systemName: "arrow.clockwise") }.accessibilityLabel("刷新")
                ShareLink(item: file)
            }
        }
        .onAppear { load() }
    }

    private func load() {
        guard let handle = try? FileHandle(forReadingFrom: file) else { return }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        try? handle.seek(toOffset: size > 96_000 ? size - 96_000 : 0)
        text = String(decoding: handle.readDataToEndOfFile(), as: UTF8.self)
    }
}
