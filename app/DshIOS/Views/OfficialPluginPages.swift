import SwiftUI

/// The staged form every official plugin page shares (`SettingsFormModel`, F-50):
/// edits stay local until 保存, which writes one `settings/mutate` fenced by the
/// revision read when the first edit was staged. A field shows the user's own value;
/// an inherited one is its placeholder, so grey means default.
@MainActor
@Observable
final class StagedForm {
    enum Kind { case number((Double) -> Bool), text }

    struct Spec {
        let key: String
        let kind: Kind
        /// The refusal shown for a value `kind` rejects.
        var invalid: String?
    }

    private struct Draft { var text: String; var clear: Bool }

    let ns: String
    private let specs: [Spec]
    private var drafts: [String: Draft] = [:]
    private var baseline: Int?
    private(set) var saving = false
    private(set) var failed = false
    /// The first field of a refused write, for the page to scroll to.
    private(set) var failedField: String?

    init(ns: String, specs: [Spec]) {
        self.ns = ns
        self.specs = specs
    }

    var dirty: Bool { !drafts.isEmpty }

    private func format(_ value: JSON?) -> String {
        guard let value, !value.isNull else { return "" }
        return value.compactText
    }

    func text(_ key: String, _ mirror: SettingsMirror) -> String {
        drafts[key]?.text ?? format(mirror.namespace(ns)?["value"][key])
    }

    /// The user layer's value, empty when the field inherits.
    private func stored(_ key: String, _ mirror: SettingsMirror) -> String {
        mirror.namespace(ns)?["user"].has([key]) == true ? format(mirror.namespace(ns)?["value"][key]) : ""
    }

    /// What the field shows: only what the user set.
    func display(_ key: String, _ mirror: SettingsMirror) -> String {
        if let draft = drafts[key] { return draft.clear ? "" : draft.text }
        return stored(key, mirror)
    }

    /// The value in force when the field is empty.
    func placeholder(_ key: String, _ mirror: SettingsMirror) -> String {
        let namespace = mirror.namespace(ns)
        let inherited = namespace?["base"][key].nonNull
            ?? (namespace?["user"].has([key]) == true ? nil : namespace?["value"][key].nonNull)
            ?? mirror.graph(ns)?.node(at: [key])?.defaultValue
        return inherited.map { format($0) } ?? String(localized: "默认")
    }

    func overridden(_ key: String, _ mirror: SettingsMirror) -> Bool {
        if let draft = drafts[key], draft.clear { return false }
        return mirror.namespace(ns)?["user"].has([key]) ?? false
    }

    private func stage(_ key: String, _ draft: Draft?, _ mirror: SettingsMirror) {
        if drafts.isEmpty { baseline = mirror.namespace(ns)?["revision"].int }
        drafts[key] = draft
        failed = false
        failedField = nil
    }

    /// Typing back what is stored leaves nothing to save.
    func edit(_ key: String, _ text: String, _ mirror: SettingsMirror) {
        stage(key, text == stored(key, mirror) ? nil : Draft(text: text, clear: false), mirror)
    }

    /// 恢复默认: shows the inherited value, unsets on save.
    func reset(_ key: String, _ mirror: SettingsMirror) {
        let set = mirror.namespace(ns)?["user"].has([key]) == true
        stage(key, set ? Draft(text: format(mirror.namespace(ns)?["base"][key]), clear: true) : nil, mirror)
    }

    func discard() {
        drafts = [:]
        failed = false
        failedField = nil
    }

    /// What `text` parses to: `.none` is invalid, `.some(nil)` clears, else the value.
    private func parse(_ spec: Spec, _ text: String) -> JSON?? {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return .some(nil) }
        switch spec.kind {
        case .text:
            return .some(.string(trimmed))
        case .number(let accepts):
            guard let value = Double(trimmed), value.isFinite, accepts(value) else { return .none }
            return .some(.number(value))
        }
    }

    func problem(_ key: String) -> String? {
        guard let draft = drafts[key], let spec = specs.first(where: { $0.key == key }), case .none = parse(spec, draft.text) else { return nil }
        return spec.invalid ?? String(localized: "请填数字；留空表示使用默认值。")
    }

    var invalid: Bool { drafts.keys.contains { problem($0) != nil } }

    private func ops(_ mirror: SettingsMirror) -> [SettingsOp] {
        let namespace = mirror.namespace(ns)
        var ops: [SettingsOp] = []
        for spec in specs {
            guard let draft = drafts[spec.key] else { continue }
            let stored = namespace?["user"].has([spec.key]) ?? false
            if draft.clear {
                if stored { ops.append(.unset([spec.key])) }
                continue
            }
            if draft.text == format(namespace?["value"][spec.key]) { continue }
            switch parse(spec, draft.text) {
            case .some(.some(let value)): ops.append(.set([spec.key], value))
            case .some(.none): if stored { ops.append(.unset([spec.key])) }
            case .none: break
            }
        }
        return ops
    }

    /// Write the staged fields; false keeps the drafts for correction.
    func save(_ mirror: SettingsMirror) async -> Bool {
        guard dirty, !invalid, !saving else { return !invalid }
        saving = true
        failed = false
        failedField = nil
        defer { saving = false }
        let edits = ops(mirror)
        guard !edits.isEmpty else { drafts = [:]; return true }
        do {
            try await mirror.mutate(ns, edits, expectedRevision: baseline)
            drafts = [:]
            return true
        } catch {
            failed = true
            failedField = specs.first { drafts[$0.key] != nil }?.key
            return false
        }
    }
}

/// A field of a staged form: a settings row with the value trailing, or, for an address too
/// long for that, stacked. Swipe or long-press resets it; clearing it does the same (F-50).
private struct StagedField: View {
    @Environment(AppModel.self) private var app
    let form: StagedForm
    let key: String
    let title: LocalizedStringKey
    var unit: LocalizedStringKey?
    var keyboard: UIKeyboardType = .numberPad

    var body: some View {
        let mirror = app.settings
        VStack(alignment: .leading, spacing: 4) {
            if keyboard == .URL {
                Text(title).font(.caption).foregroundStyle(Palette.secondary)
                field(mirror)
            } else {
                LabeledContent {
                    HStack(spacing: 6) {
                        field(mirror).multilineTextAlignment(.trailing)
                        if let unit { Text(unit).foregroundStyle(Palette.secondary) }
                    }
                } label: {
                    Text(title).foregroundStyle(Palette.ink)
                }
            }
            if let problem = form.problem(key) {
                Text(problem).font(.caption).foregroundStyle(Palette.removed)
            } else if form.failedField == key {
                Text("引擎没有接受这个值，请修改后再保存。").font(.caption).foregroundStyle(Palette.removed)
            }
        }
        .id(key)
        .resettable(form.overridden(key, mirror)) { form.reset(key, mirror) }
    }

    private func field(_ mirror: SettingsMirror) -> some View {
        TextField(form.placeholder(key, mirror), text: Binding(get: { form.display(key, mirror) }, set: { form.edit(key, $0, mirror) }))
            .keyboardType(keyboard)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .font(.callout)
    }
}

/// The frame of an official page: unavailable / read-only states, 保存 in the toolbar (it pops
/// the page), and a refused save scrolling to what went wrong.
private struct OfficialForm<Content: View>: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let title: LocalizedStringKey
    let available: Bool
    let dirty: Bool
    let invalid: Bool
    let saving: Bool
    let failed: Bool
    /// The row a failure belongs to; nil shows the page's own message.
    var failedField: String?
    let discard: () -> Void
    let save: () async -> Bool
    @ViewBuilder let content: Content

    private static var failure: String { "official-form-failure" }

    var body: some View {
        ScrollViewReader { proxy in
            Form {
                if app.settings.loaded && !available {
                    Section { Text("该插件当前未加载，暂时无法配置。").foregroundStyle(Palette.secondary) }.groupedRow()
                } else {
                    if app.settings.loaded && !app.settings.writable {
                        Section { Text("设置当前为只读。").foregroundStyle(Palette.secondary) }.groupedRow()
                    }
                    if failed && failedField == nil {
                        Section {
                            Text("引擎没有接受这些值，已保留供你修改。").font(.footnote).foregroundStyle(Palette.removed)
                                .id(Self.failure)
                        }
                        .groupedRow()
                    }
                    content.disabled(!app.settings.writable || saving)
                }
            }
            .onChange(of: failed) { _, failed in
                guard failed else { return }
                withAnimation { proxy.scrollTo(failedField ?? Self.failure, anchor: .center) }
            }
        }
        .tint(Palette.ink)
        .scrollContentBackground(.hidden)
        .background(Palette.background)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .keyboardDoneButton()
        .scrollDismissesKeyboard(.interactively)
        .editPage(dirty: dirty, canSave: !invalid && app.settings.writable && available, saving: saving, discard: discard) {
            Task {
                if await save() {
                    Haptics.success()
                    dismiss()
                } else {
                    Haptics.error()
                }
            }
        }
        .followSettings()
    }
}

/// PC-01…PC-04.
struct OfficialPluginPage: View {
    let page: OfficialPluginItem.Page

    var body: some View {
        switch page {
        case .subagent: SubagentSettingsPage()
        case .webSearch: WebSearchSettingsPage()
        case .agentLoop: AgentLoopSettingsPage()
        case .shell: ShellSettingsPage()
        }
    }
}

private func integerAtLeast(_ minimum: Double) -> (Double) -> Bool {
    { $0.rounded() == $0 && $0 >= minimum }
}

/// PC-03.
private struct AgentLoopSettingsPage: View {
    @Environment(AppModel.self) private var app
    @State private var form = StagedForm(ns: "agent-loop", specs: [.init(key: "maxParallelToolCalls", kind: .number { _ in true })])

    var body: some View {
        OfficialForm(title: "Agent 循环", available: app.settings.serves("agent-loop"), dirty: form.dirty, invalid: form.invalid, saving: form.saving, failed: form.failed, failedField: form.failedField, discard: form.discard, save: { await form.save(app.settings) }) {
            Section {
                StagedField(form: form, key: "maxParallelToolCalls", title: "并行工具调用数")
            } footer: {
                Text("同一步内最多同时运行多少个可并行的调用。")
            }
            .groupedRow()
        }
    }
}

/// PC-04: `pwsh-sandbox` where the Host serves it, else `bash-sandbox`.
private struct ShellSettingsPage: View {
    @Environment(AppModel.self) private var app
    @State private var bash = Self.form("bash-sandbox")
    @State private var pwsh = Self.form("pwsh-sandbox")

    private static func form(_ ns: String) -> StagedForm {
        StagedForm(ns: ns, specs: [.init(key: "timeoutMs", kind: .number { _ in true }), .init(key: "maxOutputBytes", kind: .number { _ in true })])
    }

    private var form: StagedForm { app.settings.serves("pwsh-sandbox") ? pwsh : bash }

    var body: some View {
        OfficialForm(title: "终端", available: app.settings.serves(form.ns), dirty: form.dirty, invalid: form.invalid, saving: form.saving, failed: form.failed, failedField: form.failedField, discard: form.discard, save: { await form.save(app.settings) }) {
            Section {
                StagedField(form: form, key: "timeoutMs", title: "命令超时", unit: "毫秒")
                StagedField(form: form, key: "maxOutputBytes", title: "输出上限", unit: "字节")
            } footer: {
                Text("命令超时即终止；超出上限的输出转存到临时文件。")
            }
            .groupedRow()
        }
    }
}

/// PC-01: limits, and which models the Agent may pick for subagents. One 保存 writes
/// both namespaces, each fenced by its own revision.
private struct SubagentSettingsPage: View {
    @Environment(AppModel.self) private var app
    @State private var limits = StagedForm(ns: "subagent", specs: [
        .init(key: "maxDepth", kind: .number(integerAtLeast(0)), invalid: String(localized: "请输入不小于 0 的整数。")),
        .init(key: "maxActiveSubagents", kind: .number(integerAtLeast(1)), invalid: String(localized: "请输入不小于 1 的整数。")),
    ])
    @State private var draftEnabled: Bool?
    @State private var draftRoutes: [String: JSON]?
    @State private var draftRevision: Int?
    @State private var catalog: JSON?
    @State private var catalogFailed = false
    @State private var saving = false
    @State private var failed = false
    @State private var conflicted = false

    private static let ns = "subagent-model-selection-settings"
    private var selection: JSON? { app.settings.namespace(Self.ns) }
    private var storedEnabled: Bool { selection?["value"]["enabled"].bool ?? false }
    private var storedRoutes: [String: JSON] {
        Dictionary((selection?["value"]["allowedModels"].array ?? []).map { (Self.key($0), $0) }, uniquingKeysWith: { $1 })
    }
    private var enabled: Bool { draftEnabled ?? storedEnabled }
    private var routes: [String: JSON] { draftRoutes ?? storedRoutes }
    private var modelsDirty: Bool { (draftEnabled != nil && draftEnabled != storedEnabled) || (draftRoutes != nil && Set(draftRoutes!.keys) != Set(storedRoutes.keys)) }
    private var needsModel: Bool { enabled && routes.isEmpty }

    private static var modelSelectionRow: String { "subagent-model-selection" }

    private static func key(_ route: JSON) -> String { "\(route["provider"].string ?? "")\u{0}\(route["model"].string ?? "")" }

    var body: some View {
        OfficialForm(title: "子智能体", available: app.settings.serves("subagent"), dirty: limits.dirty || modelsDirty, invalid: limits.invalid || needsModel, saving: saving || limits.saving, failed: failed || limits.failed || conflicted, failedField: limits.failedField ?? (conflicted ? Self.modelSelectionRow : nil), discard: discard, save: save) {
            Section {
                StagedField(form: limits, key: "maxDepth", title: "最大递归深度")
                StagedField(form: limits, key: "maxActiveSubagents", title: "并行数量上限")
            } header: {
                Text("运行限制")
            } footer: {
                Text("深度 0 禁用子智能体，1 只允许主 Agent 创建。达到数量上限时不再启动新的子智能体，主 Agent 不计入。")
            }
            .groupedRow()
            if selection != nil {
                Section {
                    Toggle("允许 Agent 为子智能体选择模型", isOn: Binding(get: { enabled }, set: { on in
                        beginDraft()
                        draftEnabled = on
                        conflicted = false
                        failed = false
                    }))
                    .toggleStyle(.mono)
                    .id(Self.modelSelectionRow)
                    if conflicted { Text("设置已在其他位置更新。请放弃修改后重试。").font(.caption).foregroundStyle(Palette.removed) }
                } header: {
                    Text("模型选择")
                } footer: {
                    Text(needsModel ? "至少选择一个模型才能保存。"
                         : enabled ? "Agent 可从下方模型中为子智能体选择。仅影响新会话。"
                         : "子智能体使用默认模型或继承父 Agent 的模型。")
                }
                .groupedRow()
                if enabled { modelSections }
            }
        }
        .task { await loadCatalog() }
    }

    @ViewBuilder
    private var modelSections: some View {
        if catalogFailed {
            Section {
                Text("无法加载模型。").font(.footnote).foregroundStyle(Palette.removed)
                Button("重试") { Task { await loadCatalog() } }
            }
            .groupedRow()
        } else if let catalog {
            let groups = catalog["groups"].array.filter { !$0["models"].array.isEmpty }
            if !catalog["failures"].array.isEmpty {
                Section { Text("部分模型提供商暂时无法加载；已保存的选择仍可移除。").font(.footnote).foregroundStyle(Palette.waiting) }.groupedRow()
            }
            if groups.isEmpty {
                Section { Text("当前没有可选的模型。").font(.footnote).foregroundStyle(Palette.secondary) }.groupedRow()
            }
            ForEach(groups, id: \.self) { group in
                Section(group["name"].string ?? group["id"].string ?? "") {
                    ForEach(group["models"].array, id: \.self) { model in
                        modelToggle(provider: group["id"].string ?? "", model: model["id"].string ?? "", title: model["name"].string ?? model["id"].string ?? "")
                    }
                }
                .groupedRow()
            }
            let offered = Set(groups.flatMap { group in group["models"].array.map { Self.key(["provider": group["id"], "model": $0["id"]]) } })
            let unavailable = routes.filter { !offered.contains($0.key) }.sorted { $0.key < $1.key }
            if !unavailable.isEmpty {
                Section("已保存但当前不可用") {
                    ForEach(unavailable, id: \.key) { _, route in
                        modelToggle(provider: route["provider"].string ?? "", model: route["model"].string ?? "", title: "\(route["provider"].string ?? "") / \(route["model"].string ?? "")")
                    }
                }
                .groupedRow()
            }
        } else {
            Section { HStack { ProgressView().controlSize(.small); Text("正在加载模型…").font(.footnote).foregroundStyle(Palette.secondary) } }.groupedRow()
        }
    }

    private func modelToggle(provider: String, model: String, title: String) -> some View {
        let route: JSON = ["provider": .string(provider), "model": .string(model)]
        let key = Self.key(route)
        return Toggle(title, isOn: Binding(get: { routes[key] != nil }, set: { on in
            beginDraft()
            draftRoutes?[key] = on ? route : nil
            conflicted = false
            failed = false
        }))
        .toggleStyle(.mono)
    }

    private func beginDraft() {
        guard draftRoutes == nil else { return }
        draftRoutes = storedRoutes
        draftEnabled = storedEnabled
        draftRevision = selection?["revision"].int
    }

    private func loadCatalog() async {
        catalogFailed = false
        do {
            catalog = try await app.client.call("session/modelCatalog")
        } catch {
            catalogFailed = true
        }
    }

    private func discard() {
        limits.discard()
        draftEnabled = nil
        draftRoutes = nil
        conflicted = false
        failed = false
    }

    private func save() async -> Bool {
        guard !saving else { return false }
        saving = true
        defer { saving = false }
        failed = false
        conflicted = false
        if limits.dirty, !(await limits.save(app.settings)) { return false }
        guard modelsDirty else { draftEnabled = nil; draftRoutes = nil; return true }
        if let draftRevision, selection?["revision"].int != draftRevision {
            conflicted = true
            return false
        }
        let desired = routes.keys.sorted().compactMap { routes[$0] }.map { route -> JSON in ["provider": route["provider"], "model": route["model"]] }
        do {
            try await app.settings.mutate(Self.ns, [.set(["enabled"], .bool(enabled)), .set(["allowedModels"], .array(desired))], expectedRevision: draftRevision)
            draftEnabled = nil
            draftRoutes = nil
            return true
        } catch {
            if isConflict(error) { conflicted = true } else { failed = true }
            return false
        }
    }
}

/// PC-02: the search provider selection, its two sections and the key.
private struct WebSearchSettingsPage: View {
    @Environment(AppModel.self) private var app
    @State private var messages = StagedForm(ns: "web-search-deepseek", specs: [
        .init(key: "baseURL", kind: .text),
        .init(key: "maxUses", kind: .number { _ in true }),
    ])
    @State private var api = StagedForm(ns: "web-deepseek-api", specs: [
        .init(key: "baseURL", kind: .text),
        .init(key: "count", kind: .number { $0.rounded() == $0 && (1...50).contains($0) }, invalid: String(localized: "请填 1–50 的整数；留空表示使用默认值。")),
    ])
    @State private var selection = StagedForm(ns: "web", specs: [.init(key: "searchProvider", kind: .text), .init(key: "fetchProvider", kind: .text)])
    @State private var keyDraft = ""
    @State private var credential: JSON?
    @State private var saving = false

    private static let providers = (
        search: (api: "deepseek-search-api", messages: "deepseek-official"),
        fetch: (api: "deepseek-fetch-api", messages: "http")
    )

    private var mirror: SettingsMirror { app.settings }
    private var switchAvailable: Bool { mirror.serves("web") && mirror.serves("web-deepseek-api") }
    private var searchApi: Bool { switchAvailable && selection.text("searchProvider", mirror) == Self.providers.search.api }
    /// The section a key is written for: the selected one's reference, or the default.
    private var ref: String {
        let ns = searchApi ? "web-deepseek-api" : "web-search-deepseek"
        return mirror.namespace(ns)?["value"]["apiKeyEnv"].string.flatMap { $0.isEmpty ? nil : $0 } ?? "DEEPSEEK_API_KEY"
    }
    private var available: Bool { mirror.serves("web-search-deepseek") || mirror.serves("web-deepseek-api") }
    private var dirty: Bool { messages.dirty || api.dirty || selection.dirty || !keyDraft.isEmpty }
    private var invalid: Bool { messages.invalid || api.invalid }

    var body: some View {
        OfficialForm(title: "网页搜索", available: available, dirty: dirty, invalid: invalid, saving: saving, failed: messages.failed || api.failed || selection.failed, discard: discard, save: save) {
            if switchAvailable {
                Section {
                    Toggle("新版 Web 搜索 API", isOn: Binding(get: { searchApi }, set: { select($0) }))
                        .toggleStyle(.mono)
                        .disabled(invalid)
                } footer: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("关闭时搜索通过 DeepSeek Messages 完成。")
                        if let url = URL(string: String(localized: "https://api-docs.deepseek.com/zh-cn/guides/search")) {
                            Link("功能与计费说明", destination: url)
                        }
                    }
                }
                .groupedRow()
            }
            Section {
                SecureField(credential?["configured"].bool == true ? String(localized: "已配置，留空不修改") : String(localized: "输入 API Key"), text: $keyDraft)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .disabled(credential?["writable"].bool == false)
            } header: {
                Text("API Key")
            } footer: {
                Text(credential?["configured"].bool == true ? "密钥只保存在本机。" : "未配置时，只有 DeepSeek 账号模型的对话可以搜索。")
            }
            .groupedRow()
            Section {
                NavigationLink("高级") { advanced }
            }
            .groupedRow()
        }
        .task(id: "\(ref)#\(app.settingsRevision)") { await readCredential() }
    }

    /// The endpoint and limits of the selected way of searching; staged with the page.
    private var advanced: some View {
        Form {
            Section {
                if searchApi {
                    StagedField(form: api, key: "baseURL", title: "API 地址", keyboard: .URL)
                    StagedField(form: api, key: "count", title: "每次搜索结果数")
                } else {
                    StagedField(form: messages, key: "baseURL", title: "API 地址", keyboard: .URL)
                    StagedField(form: messages, key: "maxUses", title: "单次请求最多搜索次数")
                }
            } footer: {
                Text(searchApi ? "地址含 API 前缀，留空用默认。结果数为 1–50 的整数。" : "地址含 API 前缀，留空用默认。")
            }
            .groupedRow()
        }
        .tint(Palette.ink)
        .scrollContentBackground(.hidden)
        .background(Palette.background)
        .navigationTitle("高级")
        .navigationBarTitleDisplayMode(.inline)
        .keyboardDoneButton()
    }

    private func discard() {
        messages.discard()
        api.discard()
        selection.discard()
        keyDraft = ""
    }

    /// Stage both selections; a target equal to the composed value clears the override.
    private func select(_ enabled: Bool) {
        let base = mirror.namespace("web")?["base"]
        for (field, target) in [("searchProvider", enabled ? Self.providers.search.api : Self.providers.search.messages),
                                ("fetchProvider", enabled ? Self.providers.fetch.api : Self.providers.fetch.messages)] {
            if base?[field].string == target { selection.reset(field, mirror) } else { selection.edit(field, target, mirror) }
        }
    }

    private func readCredential() async {
        credential = (try? await mirror.describeCredentials([ref]))?[ref]
    }

    /// Provider sections before the selection, so a switch applies only once its endpoint landed.
    private func save() async -> Bool {
        saving = true
        defer { saving = false }
        for form in [messages, api] where form.dirty {
            guard await form.save(mirror) else { return false }
        }
        if selection.dirty, !(await selection.save(mirror)) { return false }
        let key = keyDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        if !key.isEmpty {
            do {
                try await mirror.setCredential(ref, key)
                keyDraft = ""
                await readCredential()
            } catch {
                app.showToast(describeFailure(error), duration: 5)
                return false
            }
        }
        return true
    }
}
