import SwiftUI
import WebKit

/// Tells a nested `PluginsView` that an enclosing sheet already shows the shell notices.
private struct NoticesHostedKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var noticesHosted: Bool {
        get { self[NoticesHostedKey.self] }
        set { self[NoticesHostedKey.self] = newValue }
    }

    /// Open a session in the conversation area; the shell sets it. `让 Agent 创建插件`
    /// and the Agent presets' creator entry use it.
    var openSession: ((String) -> Void)? {
        get { self[OpenSessionKey.self] }
        set { self[OpenSessionKey.self] = newValue }
    }
}

private struct OpenSessionKey: EnvironmentKey {
    static let defaultValue: ((String) -> Void)? = nil
}

extension View {
    /// Toasts and the connection banner over a sheet: the shell's own sit behind it.
    func sheetNotices() -> some View {
        environment(\.noticesHosted, true).overlay(alignment: .top) { ShellNotices() }
    }
}

/// A plugin's artwork: PNG/JPEG data URLs decode directly, SVG (what manifests
/// ship) goes through a tiny web view, anything else keeps the default glyph.
struct PluginIcon: View {
    let source: String?
    var size: CGFloat = 36
    var glyph = "puzzlepiece.extension"

    var body: some View {
        Group {
            if let source, source.hasPrefix("data:image/svg") || source.lowercased().hasSuffix(".svg") {
                SVGIconView(source: source)
            } else if let source, let image = Self.decode(source) {
                Image(uiImage: image).resizable().scaledToFit()
            } else if let source, source.hasPrefix("http"), let url = URL(string: source) {
                AsyncImage(url: url) { image in image.resizable().scaledToFit() } placeholder: { fallback }
            } else {
                fallback
            }
        }
        .frame(width: size, height: size)
        .padding(6)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Palette.stroke))
        .accessibilityHidden(true)
    }

    private var fallback: some View {
        Image(systemName: glyph).font(.system(size: size * 0.55)).foregroundStyle(Palette.secondary)
    }

    private static func decode(_ source: String) -> UIImage? {
        guard source.hasPrefix("data:image/"), let comma = source.firstIndex(of: ","), source[..<comma].hasSuffix(";base64"),
              let data = Data(base64Encoded: String(source[source.index(after: comma)...])) else { return nil }
        return UIImage(data: data)
    }
}

private struct SVGIconView: UIViewRepresentable {
    let source: String

    private static let store = WKWebsiteDataStore.nonPersistent()

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.suppressesIncrementalRendering = true
        // One store: a store per icon would mean a web content process per icon.
        configuration.websiteDataStore = Self.store
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        view.scrollView.isScrollEnabled = false
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        guard context.coordinator.loaded != source else { return }
        context.coordinator.loaded = source
        let escaped = source.replacingOccurrences(of: "\"", with: "%22")
        view.loadHTMLString(
            "<html><head><meta name='viewport' content='width=device-width,initial-scale=1'><meta name='referrer' content='no-referrer'></head><body style='margin:0;background:transparent'><img src=\"\(escaped)\" style='width:100%;height:100%;object-fit:contain'></body></html>",
            baseURL: nil
        )
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator { var loaded: String? }
}

/// A small status tag on a card.
struct PluginTag: View {
    let text: String
    var tone: Color = Palette.secondary

    var body: some View {
        Text(text)
            .font(.caption2.weight(.medium))
            .foregroundStyle(tone)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(tone.opacity(0.12), in: Capsule())
    }
}

/// The official plugins' configuration cards (`plugins.item`), each while its namespace is served.
struct OfficialPluginItem: Identifiable {
    enum Page { case subagent, webSearch, agentLoop, shell }
    let page: Page
    let title: String
    let summary: String
    let glyph: String
    var id: String { title }

    @MainActor static func available(_ mirror: SettingsMirror) -> [OfficialPluginItem] {
        var items: [OfficialPluginItem] = []
        if mirror.serves("subagent") {
            items.append(.init(page: .subagent, title: String(localized: "子智能体"), summary: String(localized: "设置子智能体的递归层级、数量和模型。"), glyph: "person.2"))
        }
        if mirror.serves("web") || mirror.serves("web-search-deepseek") {
            items.append(.init(page: .webSearch, title: String(localized: "网页搜索"), summary: String(localized: "设置 DeepSeek 的搜索提供方。"), glyph: "magnifyingglass"))
        }
        if mirror.serves("agent-loop") {
            items.append(.init(page: .agentLoop, title: String(localized: "Agent 循环"), summary: String(localized: "控制 Agent 派发工具调用的方式。"), glyph: "arrow.triangle.2.circlepath"))
        }
        if mirror.serves("pwsh-sandbox") || mirror.serves("bash-sandbox") {
            items.append(.init(page: .shell, title: String(localized: "终端"), summary: String(localized: "限制每条命令最多能跑多久、最多输出多少内容。"), glyph: "terminal"))
        }
        return items
    }
}

/// 插件: built-in configuration, experimental and installed plugins, the 发现 tab
/// while the market bundle is enabled, and the add menu.
struct PluginsView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.noticesHosted) private var noticesHosted
    @Environment(\.openSession) private var openSession
    @AppStorage("dsh.plugins.tab") private var tab = "installed"
    @State private var creating = false

    private var manager: PluginManagerModel { app.plugins }
    private var showingMarket: Bool { tab == "discover" && manager.marketEnabled }

    var body: some View {
        content
            .navigationTitle("插件")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if !showingMarket {
                    ToolbarItemGroup(placement: .primaryAction) {
                        addMenu
                    }
                }
            }
            .task(id: app.revision("plugin-manager/changed")) { await manager.refresh(revision: app.revision("plugin-manager/changed")) }
            .followSettings()
            .modifier(HostNotices(hosted: noticesHosted))
    }

    @ViewBuilder
    private var content: some View {
        if manager.status == .unavailable {
            ContentUnavailableView("无法管理插件", systemImage: "puzzlepiece.extension", description: Text("当前无法安装或启停插件。"))
                .background(Palette.background)
        } else if manager.marketEnabled {
            VStack(spacing: 0) {
                Picker("插件视图", selection: $tab) {
                    Text("已安装").tag("installed")
                    Text("发现").tag("discover")
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                if showingMarket { PluginMarketPage() } else { installedList }
            }
            .background(Palette.background)
        } else {
            installedList
        }
    }

    private struct HostNotices: ViewModifier {
        let hosted: Bool
        func body(content: Content) -> some View {
            if hosted { content } else { content.sheetNotices() }
        }
    }

    private var addMenu: some View {
        Menu {
            Button {
                app.pluginInstall.openDialog()
            } label: {
                Label {
                    Text("安装第三方插件")
                    Text("支持 npm 包、Git 仓库和文件夹")
                } icon: {
                    Image(systemName: "shippingbox")
                }
            }
            // 创造模式 is held back on iOS (`CreatorMode`), and with it the entry that starts one.
            if !CreatorMode.hidden {
                Button {
                    Task { await createWithAgent() }
                } label: {
                    Label {
                        Text("让 Agent 创建插件")
                        Text("进入创造模式，制作属于你的 DSH 插件")
                    } icon: {
                        Image(systemName: "sparkles")
                    }
                }
                .disabled(creating)
            }
        } label: {
            Image(systemName: "plus")
        }
        .accessibilityLabel("添加插件")
    }

    private var installedList: some View {
        List {
            switch manager.status {
            case .idle, .loading where manager.packages.isEmpty:
                skeleton
            case .error where manager.packages.isEmpty:
                Section {
                    VStack(spacing: 10) {
                        Text("可能由于网络问题，无法读取全部插件").font(.subheadline).foregroundStyle(Palette.secondary)
                        Button("重试") { Task { await manager.manualRefresh() } }.buttonStyle(.capsule(.outline, height: 44, fill: false))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                }
                .groupedRow()
            default:
                officialSection
                extensionsSection
                installedSection
                Section {} footer: {
                    Text("在这里配置和管理插件。带原生模块的插件在 iOS 上无法加载。")
                }
            }
        }
        .groupedList()
        .refreshable { await manager.manualRefresh() }
    }

    private var skeleton: some View {
        Section {
            ForEach(0..<4, id: \.self) { _ in
                HStack(spacing: 14) {
                    RoundedRectangle(cornerRadius: 10).fill(Palette.control).frame(width: 48, height: 48)
                    VStack(alignment: .leading, spacing: 8) {
                        RoundedRectangle(cornerRadius: 4).fill(Palette.control).frame(width: 140, height: 12)
                        RoundedRectangle(cornerRadius: 4).fill(Palette.control).frame(width: 220, height: 10)
                    }
                }
                .padding(.vertical, 4)
            }
        }
        .groupedRow()
        .accessibilityLabel("正在读取插件…")
    }

    @ViewBuilder
    private var officialSection: some View {
        let items = OfficialPluginItem.available(app.settings)
        if !items.isEmpty {
            Section("内置功能") {
                ForEach(items) { item in
                    NavigationLink {
                        OfficialPluginPage(page: item.page)
                    } label: {
                        HStack(spacing: 14) {
                            PluginIcon(source: nil, glyph: item.glyph)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(item.title).font(.callout).foregroundStyle(Palette.ink)
                                Text(item.summary).font(.footnote).foregroundStyle(Palette.secondary).lineLimit(2)
                            }
                        }
                        .padding(.vertical, 3)
                    }
                }
            }
            .groupedRow()
        }
    }

    @ViewBuilder
    private var extensionsSection: some View {
        if !manager.extensions.isEmpty {
            Section("实验性插件") {
                ForEach(manager.extensions) { PluginCard(package: $0) }
                if manager.hasMore {
                    NavigationLink("查看全部") { MoreExtensionsView() }
                }
            }
            .groupedRow()
        }
    }

    @ViewBuilder
    private var installedSection: some View {
        Section("已安装插件") {
            if manager.installedPackages.isEmpty {
                Text("还没有安装任何插件。").font(.footnote).foregroundStyle(Palette.secondary)
            }
            ForEach(manager.installedPackages) { PluginCard(package: $0) }
        }
        .groupedRow()
    }

    /// 让 Agent 创建插件: a new session in Creator mode.
    private func createWithAgent() async {
        guard let workspace = app.workspaces.first else {
            app.showToast(String(localized: "暂时不可用，请重新打开菜单重试"))
            return
        }
        creating = true
        defer { creating = false }
        do {
            let presets = try await app.client.call("agentPresets/list")
            guard presets["presets"].array.contains(where: { $0["id"].string == "cordis" }) else {
                app.showToast(String(localized: "当前配置未提供创造模式"))
                return
            }
            let session = try await app.createSession(in: workspace)
            try await app.client.call("agentPresets/select", ["agentId": .string(session), "agentPreset": "cordis"])
            if let openSession { openSession(session) }
            else { app.showToast(String(localized: "已新建创造模式会话，可在会话列表中打开")) }
        } catch {
            app.showToast(describeFailure(error), duration: 5)
        }
    }
}

/// 实验性插件 → 更多.
private struct MoreExtensionsView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        List {
            Section { ForEach(app.plugins.allExtensions) { PluginCard(package: $0) } }.groupedRow()
        }
        .groupedList()
        .navigationTitle("实验性插件")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// P-04: artwork, name, tags, one-liner and the state; the switch is on the detail page it opens.
private struct PluginCard: View {
    @Environment(AppModel.self) private var app
    let package: PluginPackage
    @State private var confirmingUninstall = false

    private var manager: PluginManagerModel { app.plugins }

    var body: some View {
        NavigationLink {
            PluginDetailView(name: package.name)
        } label: {
            HStack(spacing: 14) {
                PluginIcon(source: package.icon)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(package.title).font(.callout).foregroundStyle(Palette.ink).lineLimit(1)
                        PluginTags(package: package, version: false)
                    }
                    if let summary = package.summary {
                        Text(summary).font(.footnote).foregroundStyle(Palette.secondary).lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                if manager.isBusy(package) {
                    ProgressView()
                } else if package.availability != "missing" {
                    Text(package.stalled ? "未运行" : package.enabled ? "已启用" : "已停用")
                        .font(.footnote)
                        .foregroundStyle(package.stalled ? Palette.removed : Palette.secondary)
                }
            }
            .padding(.vertical, 3)
        }
        .listRowBackground(manager.highlight == package.name ? Palette.control : Palette.grouped)
        .swipeActions {
            if package.removable && package.readOnlyReason == nil {
                Button("卸载", role: .destructive) { confirmingUninstall = true }
            }
        }
        .confirmUninstall(package, isPresented: $confirmingUninstall)
        .task(id: manager.highlight) {
            guard manager.highlight == package.name else { return }
            try? await Task.sleep(for: .seconds(2.4))
            if manager.highlight == package.name { manager.highlight = nil }
        }
    }
}

/// The status tags: version, 实验性, 异常, 未安装 / 包不可用, 可更新.
private struct PluginTags: View {
    let package: PluginPackage
    let version: Bool

    var body: some View {
        if version, let number = package.version { PluginTag(text: "v\(number)") }
        if package.beta { PluginTag(text: String(localized: "实验性")) }
        if package.problem { PluginTag(text: String(localized: "异常"), tone: Palette.removed) }
        if package.availability == "missing" {
            PluginTag(text: package.installed ? String(localized: "包不可用") : String(localized: "未安装"))
        }
        if package.updateAvailable { PluginTag(text: String(localized: "可更新"), tone: Palette.running) }
    }
}

private extension View {
    /// P-09: 卸载「{name}」？
    func confirmUninstall(_ package: PluginPackage, isPresented: Binding<Bool>, then: (() -> Void)? = nil) -> some View {
        modifier(ConfirmUninstall(package: package, isPresented: isPresented, then: then))
    }
}

private struct ConfirmUninstall: ViewModifier {
    @Environment(AppModel.self) private var app
    let package: PluginPackage
    @Binding var isPresented: Bool
    let then: (() -> Void)?

    func body(content: Content) -> some View {
        content.alert("卸载「\(package.title)」？", isPresented: $isPresented) {
            Button("取消", role: .cancel) {}
            Button("卸载", role: .destructive) {
                Task {
                    await app.plugins.uninstall(package)
                    then?()
                }
            }
        } message: {
            Text("卸载后它提供的功能会消失。")
        }
    }
}

/// P-07: one package: the switch first, 更新 under it, its problem, configuration (the
/// generic form) and components (P-08); names and sources under 高级, 卸载 last.
struct PluginDetailView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let name: String
    @State private var confirmingUninstall = false
    @State private var filter = ""

    private var manager: PluginManagerModel { app.plugins }

    var body: some View {
        Group {
            if let package = manager.package(name) {
                detail(package).confirmUninstall(package, isPresented: $confirmingUninstall) { dismiss() }
            } else {
                ContentUnavailableView("插件已移除", systemImage: "puzzlepiece.extension")
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .followSettings()
    }

    private func detail(_ package: PluginPackage) -> some View {
        List {
            header(package).groupedRow()
            problems(package)
            configuration(package)
            if package.availability != "missing" { components(package) }
            advanced(package)
            uninstall(package)
        }
        .groupedList()
        .navigationTitle(package.title)
    }

    private func header(_ package: PluginPackage) -> some View {
        Section {
            HStack(spacing: 14) {
                PluginIcon(source: package.icon)
                VStack(alignment: .leading, spacing: 4) {
                    Text(package.title).font(.callout.weight(.medium)).foregroundStyle(Palette.ink)
                    FlowTags(package: package)
                }
                Spacer(minLength: 0)
                if manager.isBusy(package) {
                    ProgressView()
                } else if !package.switchLocked {
                    MonoSwitch(isOn: Binding(get: { package.enabled }, set: { on in Task { await manager.setEnabled(package, on) } }), label: Text("启用 \(package.title)"))
                }
            }
            .padding(.vertical, 3)
            if let summary = package.summary {
                Text(summary).font(.subheadline).foregroundStyle(Palette.secondary)
            }
            if package.updateAvailable {
                Button { Task { await manager.update(package) } } label: {
                    LabeledContent("更新", value: package.installTarget?["version"].string ?? "")
                        .foregroundStyle(Palette.ink)
                }
                .disabled(manager.isBusy(package))
            }
        }
    }

    @ViewBuilder
    private func problems(_ package: PluginPackage) -> some View {
        let lines: [String] = [
            package.metaError.map { String(localized: "包元信息错误：\($0)") },
            package.error.map { String(localized: "原因：\(managementText($0))") },
            package.stalled ? manager.enableFailures[package.name].map { String(localized: "原因：\($0)") } : nil,
            package.readOnlyReason.map { managementText(code: $0) },
        ].compactMap { $0 }
        if !lines.isEmpty {
            Section {
                ForEach(lines, id: \.self) { Text($0).font(.footnote).foregroundStyle(Palette.removed) }
            }
            .groupedRow()
        }
    }

    /// The generic form stands in for a bundle's React configuration page.
    @ViewBuilder
    private func configuration(_ package: PluginPackage) -> some View {
        let ids = Set(package.rows.flatMap { [$0.entryId, $0.rowId].compactMap { $0 } } + [package.name, package.name.components(separatedBy: "/").last ?? ""])
        let forms = app.settings.namespaces.filter { ids.contains($0["ns"].string ?? "") }
        if !forms.isEmpty {
            Section("配置") {
                ForEach(forms, id: \.self) { form in
                    let ns = form["ns"].string ?? ""
                    NavigationLink(forms.count == 1 ? String(localized: "插件设置") : namespaceTitle(ns, app)) {
                        NamespaceFormView(title: package.title, ns: ns)
                    }
                }
            }
            .groupedRow()
        }
    }

    @ViewBuilder
    private func components(_ package: PluginPackage) -> some View {
        let rows = package.rows
        let needle = filter.trimmingCharacters(in: .whitespaces).lowercased()
        let visible = needle.isEmpty ? rows : rows.filter { row in
            [row.title, row.summary ?? "", row.rowId, row.moduleName].contains { $0.lowercased().contains(needle) }
        }
        Section {
            if rows.isEmpty {
                Text("这个插件包不包含任何组件。").font(.footnote).foregroundStyle(Palette.secondary)
            }
            if rows.count > 10 {
                TextField("筛选组件", text: $filter)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            if !rows.isEmpty && visible.isEmpty {
                Text("没有匹配的组件。").font(.footnote).foregroundStyle(Palette.secondary)
            }
            ForEach(visible) { row in PluginRowView(row: row, showSwitch: package.enabled) }
        } header: {
            Text("包含的组件")
        } footer: {
            if !rows.isEmpty { Text(partsSummary(rows)) }
        }
        .groupedRow()
    }

    /// `共 {n} 个 · {n} 运行中 · {n} 已停用 · {n} 异常`: only the states that occur.
    private func partsSummary(_ rows: [PluginRow]) -> String {
        let failed = rows.filter(\.stalled).count
        let off = rows.filter { !$0.enabled }.count
        let running = rows.filter { $0.enabled && $0.phase == "active" }.count
        var parts = [String(localized: "共 \(rows.count) 个")]
        if running > 0 { parts.append(String(localized: "\(running) 运行中")) }
        if off > 0 { parts.append(String(localized: "\(off) 已停用")) }
        if failed > 0 { parts.append(String(localized: "\(failed) 异常")) }
        return parts.joined(separator: " · ")
    }

    /// For people chasing a problem: the package and module names, and where the code came from.
    private func advanced(_ package: PluginPackage) -> some View {
        Section("高级") {
            detailValue("包名", package.name)
            if !(package.source == nil && !package.installed && package.availability == "installation" && !package.optional) {
                detailValue("代码来源", package.source ?? (package.availability == "missing" ? (package.installed ? String(localized: "包不可用") : String(localized: "未安装")) : String(localized: "内置")))
                if let version = package.version { detailValue("当前版本", version) }
                if let target = package.installTarget {
                    detailValue("当前 DSH 对应来源", target["spec"].string ?? "")
                    detailValue("当前 DSH 对应版本", target["version"].string ?? "")
                }
            }
            if !package.rows.isEmpty {
                NavigationLink("组件模块") {
                    List {
                        Section {
                            ForEach(package.rows) { row in
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(row.title).font(.subheadline).foregroundStyle(Palette.ink)
                                    Text(row.moduleName).font(.caption.monospaced()).foregroundStyle(Palette.secondary).textSelection(.enabled)
                                }
                            }
                        }
                        .groupedRow()
                    }
                    .groupedList()
                    .navigationTitle("组件模块")
                    .navigationBarTitleDisplayMode(.inline)
                }
            }
        }
        .groupedRow()
    }

    private func detailValue(_ title: LocalizedStringKey, _ value: String) -> some View {
        LabeledContent(title) {
            Text(value).font(.footnote).multilineTextAlignment(.trailing).textSelection(.enabled)
        }
    }

    @ViewBuilder
    private func uninstall(_ package: PluginPackage) -> some View {
        if package.installed || package.removable {
            Section {
                Button("卸载", role: .destructive) { confirmingUninstall = true }
                    .foregroundStyle(Palette.removed)
                    .disabled(manager.isBusy(package) || !package.removable || package.readOnlyReason != nil)
            }
            .groupedRow()
        }
    }
}

/// Tags that may wrap under a title.
private struct FlowTags: View {
    let package: PluginPackage

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 6) { PluginTags(package: package, version: true) }
            VStack(alignment: .leading, spacing: 4) { PluginTags(package: package, version: true) }
        }
    }
}

/// P-08: one component: its state dot, name, description and switch. The switch
/// shows only while the bundle is on; a locked row says why.
private struct PluginRowView: View {
    @Environment(AppModel.self) private var app
    let row: PluginRow
    let showSwitch: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title).font(.subheadline.weight(.medium)).foregroundStyle(row.enabled ? Palette.ink : Palette.secondary)
                    if let summary = row.summary {
                        Text(summary).font(.footnote).foregroundStyle(Palette.secondary).lineLimit(2)
                    }
                    HStack(spacing: 5) {
                        Circle().fill(dotColor).frame(width: 6, height: 6)
                        Text(row.stateText).font(.caption).foregroundStyle(row.stalled ? Palette.removed : Palette.secondary)
                    }
                }
                Spacer(minLength: 0)
                if showSwitch {
                    if app.plugins.isBusy(row) {
                        ProgressView().controlSize(.small)
                    } else {
                        MonoSwitch(isOn: Binding(get: { row.enabled }, set: { on in Task { await app.plugins.setRowEnabled(row, on) } }), label: Text("启用组件 \(row.title)"))
                            .disabled(row.locked)
                            .opacity(row.locked ? 0.4 : 1)
                    }
                }
            }
            if showSwitch, let reason = row.readOnlyReason {
                Text(managementText(code: reason)).font(.caption).foregroundStyle(Palette.secondary)
            }
        }
        .padding(.vertical, 2)
    }

    private var dotColor: Color {
        guard row.enabled, let phase = row.phase else { return Palette.faint }
        switch phase {
        case "active": return Palette.running
        case "failed": return Palette.removed
        case "loading", "unloading": return Palette.waiting
        default: return Palette.faint
        }
    }
}
