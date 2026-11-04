import SwiftUI

// MARK: - Provider rows

/// One provider as the 模型 page shows it: the configurable directory entry joined
/// with its settings namespace and credential states (`ModelsSettingsStore` in the web client).
struct ProviderRow: Identifiable, Hashable {
    let entry: JSON
    let active: Bool
    let configured: Bool
    let removable: Bool
    let apiKeyEnv: String?
    var credential: JSON?
    var derivedCredential: JSON?
    var credentialChecks: [String: JSON]?
    var accountAvailable: Bool?

    var id: String { provider }
    var provider: String { entry["provider"].string ?? "" }
    var settingsNs: String { entry["settingsNs"].string ?? "" }
    var settingsPath: [String] { entry["settingsPath"].array.compactMap(\.string) }
    var declared: Bool { entry["declared"].bool == true }
    var defaultBaseURL: String? { entry["defaultBaseURL"].string }
    var baseURLEnv: [String] { entry["baseURLEnv"].array.compactMap(\.string) }
    var nativeAuth: JSON? { entry["nativeAuth"].nonNull }
    var error: String? { entry["error"].string }
    var isAccount: Bool { provider == "deepseek-account" }

    var displayName: String {
        isAccount ? String(localized: "DeepSeek 账号") : (entry["displayName"].string ?? provider)
    }

    /// `显示名 (route)`, or the route alone when they are the same.
    var targetLabel: String { provider == displayName ? provider : "\(displayName) (\(provider))" }

    var credentialConfigured: Bool { credential?["configured"].bool == true }
    var credentialMissing: Bool { !credentialConfigured && apiKeyEnv != nil && credential?["configured"].bool == false }

    /// The page-managed credential a deletion removes with the provider.
    var managedCredential: String? {
        let managed = deriveKeyRef(provider)
        return apiKeyEnv == managed && credentialConfigured && credential?["writable"].bool == true ? managed : nil
    }

    /// Whether the row can serve requests as it stands (`providerUsable`).
    var usable: Bool {
        guard active else { return false }
        if isAccount { return accountAvailable == true }
        return apiKeyEnv == nil || credentialConfigured
    }
}

/// The conventional credential reference of a route: `moonshotai` → `MOONSHOTAI_API_KEY`.
func deriveKeyRef(_ provider: String) -> String {
    provider.uppercased().replacingOccurrences(of: "[^A-Z0-9]+", with: "_", options: .regularExpression) + "_API_KEY"
}

/// The joined provider rows, re-read whenever settings, credentials or adapters change.
@MainActor
@Observable
final class ModelProvidersModel {
    private(set) var rows: [ProviderRow] = []
    private(set) var loading = false
    private(set) var ready = false
    private(set) var error: String?
    private(set) var credentialError: String?

    func load(_ app: AppModel) async {
        loading = true
        defer { loading = false }
        do {
            async let registeredRead = app.client.call("llm/listProviders")
            async let directoryRead = app.client.call("llm/listConfigurableProviders")
            await app.settings.refresh(revision: app.settingsRevision)
            let (registered, directory) = try await (registeredRead, directoryRead)
            guard app.settings.loaded else {
                error = app.settings.error ?? String(localized: "加载提供商目录失败")
                return
            }
            let active = Set(registered.array.compactMap { $0["id"].string })
            let declared = Set(directory.array.compactMap { $0["provider"].string })
            var entries = directory.array.map { $0.setting(["active"], .bool(active.contains($0["provider"].string ?? ""))) }
            for provider in registered.array where !declared.contains(provider["id"].string ?? "") {
                entries.append(["provider": provider["id"], "displayName": provider["name"], "settingsNs": "", "settingsPath": [], "active": true])
            }
            func rank(_ entry: JSON) -> Int { entry["provider"].string == "deepseek-account" ? 0 : entry["provider"].string == "deepseek-official" ? 1 : 2 }
            entries = entries.enumerated().sorted { (rank($0.element), $0.offset) < (rank($1.element), $1.offset) }.map(\.element)

            var next = entries.map { entry -> ProviderRow in
                let namespace = app.settings.namespace(entry["settingsNs"].string ?? "")
                let path = entry["settingsPath"].array.compactMap(\.string)
                let profile = namespace?["value"].value(at: path)
                let isAccount = entry["provider"].string == "deepseek-account"
                let ref = profile?["apiKeyEnv"].string
                return ProviderRow(
                    entry: entry,
                    active: entry["active"].bool ?? false,
                    configured: namespace != nil && (path.isEmpty || profile != nil),
                    removable: namespace != nil && !path.isEmpty && namespace!["user"].has(path) && !namespace!["base"].has(path),
                    apiKeyEnv: isAccount ? nil : (ref?.isEmpty == false ? ref : nil)
                )
            }
            if next.contains(where: \.isAccount) {
                let catalog = try? await app.client.call("session/modelCatalog")
                let available = catalog?["groups"].array.contains { $0["id"].string == "deepseek-account" && !$0["models"].array.isEmpty } ?? false
                for index in next.indices where next[index].isAccount { next[index].accountAvailable = available }
            }
            let refs = next.filter { !$0.isAccount }.flatMap { row in
                row.apiKeyEnv.map { [$0] } ?? ([deriveKeyRef(row.provider)] + (row.nativeAuth?["env"].array.compactMap(\.string) ?? []))
            }
            var credentials: [String: JSON] = [:]
            credentialError = nil
            do {
                credentials = try await app.settings.describeCredentials(refs)
            } catch {
                credentialError = describeFailure(error)
            }
            rows = next.filter { !$0.isAccount || $0.accountAvailable == true }.map { row in
                guard !row.isAccount else { return row }
                var row = row
                if let ref = row.apiKeyEnv { row.credential = credentials[ref] } else { row.derivedCredential = credentials[deriveKeyRef(row.provider)] }
                if credentialError == nil {
                    let checked = row.apiKeyEnv.map { [$0] } ?? (row.nativeAuth?["env"].array.compactMap(\.string) ?? [])
                    row.credentialChecks = Dictionary(uniqueKeysWithValues: checked.compactMap { ref in credentials[ref].map { (ref, $0) } })
                }
                return row
            }
            error = nil
            ready = true
        } catch is CancellationError {
        } catch {
            self.error = describeFailure(error)
        }
    }
}

// MARK: - 模型 page

/// 设置 → 模型 (M-01…M-13): the default model, one row per configured provider with its
/// key state, an editor page per provider, and the add flow in a sheet of its own.
struct ModelProvidersPage: View {
    @Environment(AppModel.self) private var app
    @State private var model = ModelProvidersModel()
    @State private var deleteTarget: ProviderRow?
    @State private var deleting = false
    @State private var adding = false
    @State private var defaultModel: String?

    var body: some View {
        List {
            if app.settings.loaded, !app.settings.writable {
                Section { Text("设置当前为只读。").font(.footnote).foregroundStyle(Palette.waiting) }.groupedRow()
            }
            if let error = model.error, !model.ready {
                Section {
                    Text("加载提供商目录失败：\(error)").font(.footnote).foregroundStyle(Palette.removed)
                    Button("重试") { Task { await model.load(app) } }
                }
                .groupedRow()
            } else if !model.ready {
                Section { HStack { Spacer(); ProgressView(); Spacer() } }.groupedRow()
            } else {
                if app.settings.serves("agent-default-model") {
                    Section {
                        NavigationLink {
                            NamespaceFormView(title: String(localized: "默认模型"), ns: "agent-default-model")
                        } label: {
                            LabeledContent("默认模型", value: defaultModel ?? "")
                        }
                    }
                    .groupedRow()
                }
                Section {
                    ForEach(configured) { row in providerRow(row) }
                } footer: {
                    Text("填入提供商的 API 密钥即可使用其模型。")
                }
                .groupedRow()
                Section {
                    Button { adding = true } label: {
                        Label("添加模型提供商", systemImage: "plus").foregroundStyle(Palette.ink)
                    }
                    .disabled(!app.settings.writable)
                }
                .groupedRow()
            }
        }
        .groupedList()
        .navigationTitle("模型")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $adding) { AddProviderSheet(model: model) }
        .task(id: app.settingsRevision) {
            await model.load(app)
            await loadDefaultModel()
        }
        .refreshable { await app.settings.reload(); await model.load(app) }
        .alert(deleteTarget.map { String(localized: "删除 \($0.targetLabel)？") } ?? "", isPresented: Binding(get: { deleteTarget != nil }, set: { if !$0 { deleteTarget = nil } }), presenting: deleteTarget) { target in
            Button("取消", role: .cancel) {}
            Button(String(localized: "删除 \(target.targetLabel)"), role: .destructive) { Task { await delete(target) } }
        } message: { target in
            Text(target.managedCredential != nil
                 ? "删除 \(target.targetLabel) 会移除其配置和存储的 API 密钥。"
                 : "删除 \(target.targetLabel) 会移除其配置。")
        }
    }

    private func loadDefaultModel() async {
        guard let value = try? await app.client.call("session/modelCatalog") else { return }
        let provider = value["default"]["provider"].string, id = value["default"]["model"].string
        let group = value["groups"].array.first { $0["id"].string == provider }
        defaultModel = group?["models"].array.first { $0["id"].string == id }?["name"].string ?? id
    }

    private var configured: [ProviderRow] { model.rows.filter(\.configured) }

    @ViewBuilder
    private func providerRow(_ row: ProviderRow) -> some View {
        let label = VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                Text(row.displayName).foregroundStyle(Palette.ink)
                if row.declared { PluginTag(text: String(localized: "自定义")) }
                Spacer(minLength: 8)
                if row.isAccount {
                    Text("已登录").font(.footnote).foregroundStyle(Palette.running)
                } else if row.credentialConfigured {
                    Text("已配置").font(.footnote).foregroundStyle(Palette.secondary)
                } else if row.credentialMissing {
                    Text("缺少密钥").font(.footnote).foregroundStyle(Palette.removed)
                }
            }
            if let error = row.error {
                Text(error).font(.caption).foregroundStyle(Palette.removed)
            }
        }
        if row.isAccount {
            label
        } else if let namespace = app.settings.namespace(row.settingsNs) {
            NavigationLink {
                ProviderEditorPage(model: model, row: row, namespace: namespace)
            } label: {
                label
            }
            .swipeActions {
                if row.removable, app.settings.writable {
                    Button("删除", role: .destructive) { deleteTarget = row }
                }
            }
        } else {
            label
        }
    }

    /// M-10: the managed credential first, so a failed second step stays retryable.
    private func delete(_ target: ProviderRow) async {
        guard !deleting else { return }
        deleting = true
        defer { deleting = false }
        do {
            if let ref = target.managedCredential { try await app.settings.unsetCredential(ref) }
            try await app.settings.mutate(target.settingsNs, [.unset(target.settingsPath)], expectedRevision: nil)
            await model.load(app)
        } catch {
            Haptics.error()
            app.showToast(describeFailure(error), duration: 5)
        }
    }
}

// MARK: - Validation

/// The first refused row of a `models` draft, as `模型 {n}: {reason}`.
private func modelFailure(_ value: JSON?, checkReasoning: Bool) -> String? {
    guard let value else { return nil }
    let models = value.array
    var seen = Set<String>()
    func failed(_ index: Int, _ reason: String) -> String { String(localized: "模型 \(index + 1): \(reason)") }
    for (index, model) in models.enumerated() {
        guard let id = model["id"].string?.trimmingCharacters(in: .whitespaces), !id.isEmpty else { return failed(index, String(localized: "模型 ID 不能为空。")) }
        if !seen.insert(id).inserted { return failed(index, String(localized: "模型 ID 不能重复。")) }
        if model.has(["name"]), (model["name"].string ?? "").isEmpty { return failed(index, String(localized: "显示名称不能为空。")) }
        if model.has(["contextWindow"]), !positiveInteger(model["contextWindow"]) { return failed(index, String(localized: "上下文窗口必须是正数，例如 131072、256K 或 1M。")) }
        if model.has(["maxTokens"]), !positiveInteger(model["maxTokens"]) { return failed(index, String(localized: "最大输出 token 数必须是正数，例如 8192、64K 或 1M。")) }
    }
    guard checkReasoning else { return nil }
    for (index, model) in models.enumerated() {
        guard model.has(["reasoningEfforts"]), model["reasoningEfforts"].bool != false else { continue }
        let entries = model["reasoningEfforts"].object
        let accepted = entries.allSatisfy { level, wire in
            if let text = wire.string { return !text.isEmpty }
            return wire.isNull && level == "off"
        }
        if !accepted { return failed(index, String(localized: "Off 以外的档位都需要填写 API 参数值，且参数值不能为空字符串。")) }
        if !entries.keys.contains(where: { $0 != "off" }) { return failed(index, String(localized: "至少添加一个 Off 以外的档位；不需要思考请关闭推理等级。")) }
    }
    return nil
}

private func positiveInteger(_ value: JSON) -> Bool {
    guard let number = value.double else { return false }
    return number.rounded() == number && number > 0
}

/// `256K`, `1M`, `131072`: nil when blank; a non-number stays in the draft as text, which validation refuses.
private func parseCapacity(_ text: String) -> JSON? {
    let trimmed = text.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty else { return nil }
    guard let match = trimmed.range(of: #"^\d+(\.\d+)?[kKmM]?$"#, options: .regularExpression), match == trimmed.startIndex..<trimmed.endIndex else { return .string(trimmed) }
    let suffix = trimmed.last?.lowercased()
    let digits = suffix == "k" || suffix == "m" ? String(trimmed.dropLast()) : trimmed
    let scaled = (Double(digits) ?? 0) * (suffix == "k" ? 1000 : suffix == "m" ? 1_000_000 : 1)
    let rounded = scaled.rounded()
    return .number(abs(scaled - rounded) < 1e-6 ? rounded : scaled)
}

/// A stored count in the shortest form that reads back the same.
private func formatCapacity(_ value: Double) -> String {
    guard value.rounded() == value, value > 0 else { return String(value) }
    let count = Int(value)
    if count % 1_000_000 == 0 { return "\(count / 1_000_000)M" }
    if count % 1000 == 0 { return "\(count / 1000)K" }
    return String(count)
}

/// `validate`'s text for a typed key; nil allows submit (empty means keep the stored key).
private func apiKeyFailure(_ draft: String) -> String? {
    guard !draft.isEmpty else { return nil }
    let value = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    if value.isEmpty { return String(localized: "请输入 API 密钥；留空则保持已存储的密钥。") }
    let illegal = String(localized: "该 API 密钥格式错误，请检查。")
    if value.range(of: "^[A-Z][A-Z0-9_]*=[^=]", options: .regularExpression) != nil { return illegal }
    if let first = value.first, "\"'`".contains(first), value.count > 1, value.last == first { return illegal }
    if value.range(of: #"^[\x21-\x7E]+$"#, options: .regularExpression) == nil { return illegal }
    return nil
}

// MARK: - Fields

/// The API key input: never reads a stored key back; an eye reveals what is typed
/// here, and any edit masks it again.
private struct APIKeyField: View {
    let placeholder: String
    @Binding var text: String
    @State private var revealed = false

    var body: some View {
        HStack(spacing: 8) {
            Group {
                if revealed {
                    TextField(placeholder, text: $text)
                } else {
                    SecureField(placeholder, text: $text)
                }
            }
            .textContentType(nil)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .font(.callout)
            if !text.isEmpty {
                Button { revealed.toggle() } label: {
                    Image(systemName: revealed ? "eye.slash" : "eye").foregroundStyle(Palette.secondary).hitTarget()
                }
                .buttonStyle(.plain)
                .accessibilityLabel(revealed ? "隐藏密钥" : "显示密钥")
            }
        }
        .onChange(of: text) { _, _ in revealed = false }
    }
}

private struct DraftTextField: View {
    let title: LocalizedStringKey
    let placeholder: String
    let text: Binding<String>
    var keyboard: UIKeyboardType = .default

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption).foregroundStyle(Palette.secondary)
            TextField(placeholder, text: text, axis: .vertical)
                .keyboardType(keyboard)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(.callout)
        }
    }
}

// MARK: - Provider editor

/// The curated fields of one adapter family.
private enum ProviderLayout {
    case deepseek, piAi, unknown

    init(_ ns: String) {
        switch ns {
        case "llm-deepseek": self = .deepseek
        case "llm-pi-ai": self = .piAi
        default: self = .unknown
        }
    }
}

/// A provider's editor pushed from its row (or from the add sheet's list).
private struct ProviderEditorPage: View {
    let model: ModelProvidersModel
    let row: ProviderRow
    let namespace: JSON
    var onAdded: (() -> Void)?

    var body: some View {
        ProviderEditor(model: model, row: row, namespace: namespace, onAdded: onAdded)
            .navigationTitle(row.displayName)
            .navigationBarTitleDisplayMode(.inline)
            .keyboardDoneButton()
    }
}

/// One provider (M-03…M-09): the key, the model catalog and, behind 高级, address and identity.
/// Edits stay local until 保存, which writes minimal path ops first and the key second; a
/// failure in the key step retries only that step. Adding splits the same card in two:
/// the key here, then 下一步 to the models, which saves.
private struct ProviderEditor: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let model: ModelProvidersModel
    let row: ProviderRow
    let namespace: JSON
    /// In the add flow: closes it after a save, instead of popping this page.
    var onAdded: (() -> Void)?

    private enum Failed { case settings, key }
    private static var failureAnchor: String { "provider-failure" }
    private static var keyAnchor: String { "provider-key" }

    @State private var draft: JSON = [:]
    @State private var original: JSON = [:]
    @State private var committed: JSON?
    @State private var expectedRevision: Int?
    @State private var keyDraft = ""
    @State private var busy = false
    @State private var failure: String?
    @State private var failedAt = Failed.settings
    @State private var attempts = 0
    @State private var prepared = false
    @State private var choosingModels = false

    private var adding: Bool { onAdded != nil }
    private var graph: SchemaGraph? { app.settings.graph(namespace["ns"].string ?? "") }
    private var path: [String] { row.settingsPath }
    private var layout: ProviderLayout { ProviderLayout(row.settingsNs) }
    private var fallback: JSON? { namespace["value"].value(at: path) }
    private var keyRef: String {
        if let named = fallback?["apiKeyEnv"].string, !named.isEmpty { return named }
        return deriveKeyRef(row.provider)
    }
    private var ownsIdentity: Bool { layout == .piAi && row.declared }
    private var reasoningLevels: [String] {
        guard ownsIdentity, let graph else { return [] }
        return reasoningLevelChoices(graph)
    }
    private var protocols: [String] { graph.map(protocolChoices) ?? [] }
    private var keyValue: String { keyDraft.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var keyFailure: String? { apiKeyFailure(keyDraft) }
    private var modelProblem: String? { modelFailure(draft["models"].nonNull, checkReasoning: !reasoningLevels.isEmpty) }
    private var disabled: Bool { busy || !app.settings.writable }
    private var dirty: Bool { prepared && (!keyDraft.isEmpty || draft != original) }
    private var canSave: Bool { !disabled && layout != .unknown && modelProblem == nil && keyFailure == nil }

    private func stringAt(_ source: JSON?, _ key: String) -> String? {
        guard let value = source?[key].string, !value.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        return value
    }

    var body: some View {
        ScrollViewReader { proxy in
            Form {
                if layout == .unknown {
                    Section { Text("这个提供商不能在这里配置，可到「高级 → 配置文件」修改。").font(.footnote).foregroundStyle(Palette.secondary) }
                        .groupedRow()
                } else if graph?.node(at: path) == nil && !path.isEmpty {
                    Section { Text("\(row.displayName)：无法读取设置").font(.footnote).foregroundStyle(Palette.removed) }
                        .groupedRow()
                } else {
                    if failedAt == .settings { failureSection }
                    if !keylessNativeAuth { keySection }
                    if !adding {
                        catalogSection(autoFetch: false)
                        modelProblemSection
                    }
                    Section { NavigationLink("高级") { advancedPage } }.groupedRow()
                }
            }
            .onChange(of: attempts) { _, _ in
                withAnimation { proxy.scrollTo(failedAt == .key ? Self.keyAnchor : Self.failureAnchor, anchor: .center) }
            }
        }
        .tint(Palette.ink)
        .scrollContentBackground(.hidden)
        .background(Palette.background)
        .scrollDismissesKeyboard(.interactively)
        .modifier(EditorChrome(adding: adding, dirty: dirty, canSave: canSave, canContinue: canContinue, busy: busy, next: { choosingModels = true }, save: { Task { await apply() } }))
        .navigationDestination(isPresented: $choosingModels) { modelsStep }
        .task(id: row.provider) { prepare() }
    }

    /// 下一步 or 保存, by where the card is.
    private struct EditorChrome: ViewModifier {
        let adding: Bool
        let dirty: Bool
        let canSave: Bool
        let canContinue: Bool
        let busy: Bool
        let next: () -> Void
        let save: () -> Void

        func body(content: Content) -> some View {
            if adding {
                content
                    .interactiveDismissDisabled(dirty)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) { Button("下一步", action: next).disabled(!canContinue) }
                    }
            } else {
                content.editPage(dirty: dirty, canSave: canSave, saving: busy, save: save)
            }
        }
    }

    /// Adding, second step: the provider's models; 保存 ends the flow.
    private var modelsStep: some View {
        Form {
            failureSection
            catalogSection(autoFetch: true)
            modelProblemSection
        }
        .tint(Palette.ink)
        .scrollContentBackground(.hidden)
        .background(Palette.background)
        .navigationTitle("选择模型")
        .navigationBarTitleDisplayMode(.inline)
        .keyboardDoneButton()
        .interactiveDismissDisabled(true)
        .saveToolbar(canSave: canSave, saving: busy) { Task { await apply() } }
    }

    @ViewBuilder
    private var failureSection: some View {
        if let failure {
            Section { Text(failure).font(.footnote).foregroundStyle(Palette.removed).id(Self.failureAnchor) }
                .groupedRow()
        }
    }

    @ViewBuilder
    private var modelProblemSection: some View {
        if let modelProblem {
            Section { Text(modelProblem).font(.footnote).foregroundStyle(Palette.waiting) }
                .groupedRow()
        }
    }

    /// The draft starts from the user layer: the card only names what it can see.
    private func prepare() {
        guard !prepared else { return }
        prepared = true
        let stored = namespace["user"].value(at: path)
        if case .object? = stored { draft = stored! } else { draft = [:] }
        original = draft
        committed = stored
        expectedRevision = namespace["revision"].int
    }

    // MARK: Credential

    private var namedRef: String? { stringAt(fallback, "apiKeyEnv") }
    private var nativeAuth: JSON? { namedRef == nil ? row.nativeAuth : nil }
    private var authRefs: [String] {
        if let namedRef { return [namedRef] }
        let env = nativeAuth?["env"].array.compactMap(\.string) ?? []
        return env.filter { !row.baseURLEnv.contains($0) }
    }
    /// A native route authenticated by OAuth alone has nothing to type.
    private var keylessNativeAuth: Bool {
        guard let nativeAuth else { return false }
        return nativeAuth["env"].array.isEmpty && nativeAuth["oauth"].bool == true
    }
    private var checked: [(ref: String, info: JSON?)] {
        authRefs.map { ref in (ref, row.credentialChecks?[ref] ?? (ref == namedRef ? row.credential : nil)) }
    }
    private var detected: (ref: String, info: JSON?)? { checked.first { $0.info?["configured"].bool == true } }
    private var keyPlaceholder: String {
        detected != nil ? String(localized: "已配置，留空不修改") : String(localized: "输入 API 密钥")
    }

    /// Adding: on to the models once the provider can authenticate (OAuth routes need no key).
    private var keyNeeded: Bool {
        !keylessNativeAuth && !authRefs.isEmpty && detected == nil && keyValue.isEmpty && nativeAuth?["oauth"].bool != true
    }
    private var canContinue: Bool { !disabled && layout != .unknown && keyFailure == nil && !keyNeeded }

    private var keySection: some View {
        Section {
            APIKeyField(placeholder: keyPlaceholder, text: $keyDraft).disabled(disabled).id(Self.keyAnchor)
            if let keyFailure { Text(keyFailure).font(.caption).foregroundStyle(Palette.removed) }
            if failedAt == .key, let failure { Text(failure).font(.caption).foregroundStyle(Palette.removed) }
        } header: {
            Text("API 密钥")
        } footer: {
            if adding && keyNeeded { Text("填入 API 密钥后继续。") }
        }
        .groupedRow()
    }

    // MARK: Customized

    private func setField(_ key: String, _ text: String) {
        let value = text.trimmingCharacters(in: .whitespaces)
        draft = draft.setting([key], value.isEmpty ? nil : .string(text))
    }

    private func textBinding(_ key: String) -> Binding<String> {
        Binding(get: { stringAt(draft, key) ?? draft[key].string ?? "" }, set: { setField(key, $0) })
    }

    private var baseURLPlaceholder: String {
        if layout == .deepseek { return "https://api.deepseek.com/anthropic" }
        return stringAt(fallback, "baseURL") ?? row.defaultBaseURL ?? String(localized: "填写 API 地址")
    }

    /// 高级: what a provider rarely needs changed; staged with the card.
    private var advancedPage: some View {
        Form {
            Section {
                if ownsIdentity {
                    DraftTextField(title: "显示名称", placeholder: row.provider, text: textBinding("displayName")).disabled(disabled)
                }
                DraftTextField(title: "API 地址", placeholder: baseURLPlaceholder, text: textBinding("baseURL"), keyboard: .URL).disabled(disabled)
                if ownsIdentity {
                    let current = stringAt(draft, "api") ?? stringAt(fallback, "api")
                    Picker("API 协议", selection: Binding(get: { current ?? "" }, set: { setField("api", $0) })) {
                        if current == nil { Text("未选择").tag("") }
                        ForEach(protocols, id: \.self) { Text(protocolLabel($0)).tag($0) }
                    }
                    .disabled(disabled)
                }
            } footer: {
                if layout == .deepseek { Text("需兼容 Anthropic Messages 协议。") }
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

    // MARK: Catalog

    private var modelsOverridden: Bool { draft.has(["models"]) }

    /// The catalog beneath the user layer: what the composition pinned, or the schema default.
    private var inheritedModels: [JSON] {
        namespace["base"].value(at: path + ["models"])?.array ?? graph?.node(at: path + ["models"])?.defaultValue?.array ?? []
    }

    private var models: [JSON] { modelsOverridden ? draft["models"].array : inheritedModels }

    private func catalogSection(autoFetch: Bool) -> some View {
        ModelCatalogSection(
            models: models,
            overridden: modelsOverridden,
            autoFetch: autoFetch,
            family: layout == .deepseek ? .deepseek : .piAi,
            defaultContextWindow: fallback?["defaultContextWindow"].double,
            defaultMaxTokens: fallback?["maxTokens"].double,
            defaultInput: fallback?["defaultInput"].array.compactMap(\.string),
            reasoningLevels: reasoningLevels,
            disabled: disabled,
            probe: layout == .piAi ? ModelProbe(
                settingsNs: row.settingsNs,
                provider: row.provider,
                baseURL: stringAt(draft, "baseURL") ?? stringAt(fallback, "baseURL"),
                api: stringAt(draft, "api") ?? stringAt(fallback, "api"),
                apiKey: keyValue.isEmpty ? nil : keyValue,
                blocked: keyFailure
            ) : nil,
            loadCatalog: layout == .piAi && !row.declared,
            onChange: { draft = draft.setting(["models"], .array($0)) },
            onReset: { draft = draft.setting(["models"], nil) }
        )
    }

    // MARK: Saving

    private func apply() async {
        busy = true
        failure = nil
        defer { busy = false }
        if let problem = await applyOnce() {
            failure = problem.text
            failedAt = problem.at
            // The add flow's key is a step back.
            if problem.at == .key { choosingModels = false }
            attempts += 1
            Haptics.error()
            return
        }
        Haptics.success()
        // Close first: a fresh list drops this provider from what can be added.
        if let onAdded { onAdded() } else { dismiss() }
        await model.load(app)
        app.showToast(String(localized: "已保存 \(row.targetLabel)。"))
    }

    /// Settings first (minimal path ops, fenced by the card's revision), then the key.
    private func applyOnce() async -> (text: String, at: Failed)? {
        let ns = row.settingsNs
        var next = draft
        if layout == .piAi, stringAt(draft, "apiKeyEnv") == nil, stringAt(fallback, "apiKeyEnv") == nil, !keyValue.isEmpty {
            next = next.setting(["apiKeyEnv"], .string(keyRef))
        }
        if let problem = modelFailure(next["models"].nonNull, checkReasoning: !reasoningLevels.isEmpty) { return (problem, .settings) }
        let materializes = layout == .piAi && fallback == nil && committed == nil && next.object.isEmpty
        let ops: [SettingsOp] = materializes ? [.set(path, [:])] : pathOps(base: path, before: committed, after: next)
        if !ops.isEmpty {
            do {
                let written = try await app.settings.mutate(ns, ops, expectedRevision: expectedRevision)
                committed = written["user"].value(at: path)
                expectedRevision = written["revision"].int
                draft = next
                original = next
            } catch {
                return (isConflict(error)
                    ? String(localized: "这些设置已在别处改动。请返回后重新打开，在当前值上编辑。")
                    : describeFailure(error), .settings)
            }
        }
        if !keyValue.isEmpty {
            do {
                try await app.settings.setCredential(keyRef, keyValue)
            } catch {
                return (describeFailure(error), .key)
            }
            keyDraft = ""
        }
        return nil
    }
}

/// The minimal ops carrying `after` over `before`: only keys the card observed are named.
private func pathOps(base: [String], before: JSON?, after: JSON) -> [SettingsOp] {
    let previous = before?.object ?? [:]
    var ops: [SettingsOp] = []
    for (key, value) in after.object.sorted(by: { $0.key < $1.key }) where previous[key] != value {
        ops.append(.set(base + [key], value))
    }
    for key in previous.keys.sorted() where after.object[key] == nil {
        ops.append(.unset(base + [key]))
    }
    return ops
}

/// The wire protocols a hand-declared route may name, read from the namespace's own schema.
private func protocolChoices(_ graph: SchemaGraph) -> [String] {
    guard let node = graph.node(at: ["providers", "\0probe", "api"]), node.type == "union" else { return [] }
    return graph.list(node).compactMap { $0.json["value"].string }
}

/// The reasoning levels a hand-declared model may declare, in the schema's escalation order.
private func reasoningLevelChoices(_ graph: SchemaGraph) -> [String] {
    guard let node = graph.node(at: ["providers", "\0probe", "models", "0", "reasoningEfforts"]) else { return [] }
    let dict = graph.list(node).first { $0.type == "dict" }
    guard let key = dict.map({ graph.node($0.json["sKey"]) }) else { return [] }
    return graph.list(key).compactMap { $0.json["value"].string }
}

private func protocolLabel(_ value: String) -> String {
    switch value {
    case "openai-completions": "OpenAI Chat Completions"
    case "openai-responses": "OpenAI Responses"
    case "anthropic-messages": "Anthropic Messages"
    default: value
    }
}

// MARK: - Model catalog

/// What the 获取可用模型 call asks: the endpoint the form currently shows, a key typed but
/// unsaved included, so adding a provider is one pass.
struct ModelProbe {
    let settingsNs: String
    var provider: String?
    var baseURL: String?
    var api: String?
    var apiKey: String?
    /// The form's failure that blocks asking.
    var blocked: String?

    var request: JSON {
        var object: [String: JSON] = [:]
        if let provider { object["provider"] = .string(provider) }
        if let baseURL, !baseURL.isEmpty { object["baseURL"] = .string(baseURL) }
        if let api { object["api"] = .string(api) }
        if let apiKey { object["apiKey"] = .string(apiKey) }
        return .object(object)
    }

    var askable: Bool { provider != nil || (baseURL?.isEmpty == false) }
}

private enum CatalogFamily { case deepseek, piAi }

/// M-07: the model rows, their reset, add and fetch actions (M-13).
private struct ModelCatalogSection: View {
    @Environment(AppModel.self) private var app
    let models: [JSON]
    /// nil: a new custom API, which has no inherited catalog to speak of.
    let overridden: Bool?
    /// Adding: an empty list asks the provider as soon as it shows.
    var autoFetch = false
    let family: CatalogFamily
    let defaultContextWindow: Double?
    let defaultMaxTokens: Double?
    let defaultInput: [String]?
    let reasoningLevels: [String]
    let disabled: Bool
    let probe: ModelProbe?
    let loadCatalog: Bool
    let onChange: ([JSON]) -> Void
    let onReset: () -> Void

    @State private var fetching = false
    @State private var failure: String?
    @State private var candidates: [JSON]?
    @State private var inputDefaults: [String: [String]] = [:]
    @State private var autoFetched = false

    private var inputField: String { family == .deepseek ? "inputModalities" : "input" }

    var body: some View {
        Section {
            if let overridden {
                LabeledContent("模型列表", value: overridden ? String(localized: "已自定义") : String(localized: "默认"))
                    .resettable(overridden && !disabled, title: "恢复默认模型", reset: onReset)
            }
            if models.isEmpty {
                Text("还没有模型。").font(.footnote).foregroundStyle(Palette.secondary)
            }
            ForEach(Array(models.enumerated()), id: \.offset) { index, model in
                NavigationLink {
                    ModelRowEditor(
                        model: model,
                        position: index + 1,
                        inputField: inputField,
                        inputFallback: inputDefaults[model["id"].string ?? ""] ?? defaultInput,
                        contextHint: family == .deepseek ? defaultContextWindow.map(formatCapacity) ?? String(localized: "使用提供商默认值") : "256K",
                        tokensHint: family == .deepseek ? defaultMaxTokens.map(formatCapacity) ?? String(localized: "使用提供商默认值") : "32K",
                        reasoningLevels: reasoningLevels,
                        disabled: disabled,
                        update: { next in onChange(models.enumerated().map { $0.offset == index ? next : $0.element }) },
                        remove: { onChange(models.enumerated().filter { $0.offset != index }.map(\.element)) }
                    )
                } label: {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(model["id"].string.flatMap { $0.isEmpty ? nil : $0 } ?? String(localized: "未填写模型 ID"))
                            .font(.callout.monospaced()).foregroundStyle(Palette.ink).lineLimit(1)
                        if let name = model["name"].string, !name.isEmpty {
                            Text(name).font(.caption).foregroundStyle(Palette.secondary).lineLimit(1)
                        }
                    }
                }
                .swipeActions {
                    Button("删除模型", role: .destructive) { onChange(models.enumerated().filter { $0.offset != index }.map(\.element)) }
                }
            }
            Button {
                onChange(models + [["id": ""]])
            } label: {
                Label("添加模型", systemImage: "plus").foregroundStyle(Palette.ink)
            }
            .disabled(disabled)
            .sheet(isPresented: Binding(get: { candidates != nil }, set: { if !$0 { candidates = nil } })) {
                ModelPickerSheet(candidates: candidates ?? [], known: Set(models.compactMap { $0["id"].string }), adopt: adopt)
            }
            .task(id: loadCatalog ? probe?.provider : nil) { await readInputDefaults() }
            if let probe {
                Button {
                    Task { await fetch(probe) }
                } label: {
                    HStack(spacing: 8) {
                        if fetching { ProgressView().controlSize(.small) }
                        Text(fetching ? "正在获取…" : "获取可用模型").foregroundStyle(Palette.ink)
                    }
                }
                .disabled(disabled || fetching || !probe.askable || probe.blocked != nil)
                if !probe.askable {
                    Text("请先填写 API 地址，再获取。").font(.caption).foregroundStyle(Palette.secondary)
                } else if let blocked = probe.blocked {
                    Text(blocked).font(.caption).foregroundStyle(Palette.waiting)
                }
            }
            if let failure { Text(failure).font(.caption).foregroundStyle(Palette.removed) }
        } header: {
            Text("模型")
        } footer: {
            if overridden == true { Text("在「模型列表」上左滑可恢复默认。") }
            else if overridden == nil && models.isEmpty { Text("至少添加一个模型才能保存。") }
        }
        .groupedRow()
        .task {
            guard autoFetch, !autoFetched, models.isEmpty, let probe, probe.askable, probe.blocked == nil else { return }
            autoFetched = true
            await fetch(probe)
        }
    }

    /// A catalog route's input types: what its own listing says, shown as each row's default.
    private func readInputDefaults() async {
        guard loadCatalog, let probe, let provider = probe.provider else { return }
        do {
            let found = try await app.client.call("llm/discoverModels", ["settingsNs": .string(probe.settingsNs), "request": ["provider": .string(provider)]])
            remember(found.array)
        } catch {
            failure = describeFailure(error)
        }
    }

    private func remember(_ found: [JSON]) {
        for candidate in found {
            if let id = candidate["id"].string, !candidate["inputModalities"].isNull {
                inputDefaults[id] = candidate["inputModalities"].array.compactMap(\.string)
            }
        }
    }

    private func fetch(_ probe: ModelProbe) async {
        fetching = true
        failure = nil
        defer { fetching = false }
        do {
            let found = try await app.client.call("llm/discoverModels", ["settingsNs": .string(probe.settingsNs), "request": probe.request]).array
            if loadCatalog { remember(found) }
            if found.isEmpty {
                failure = String(localized: "该提供商没有列出任何模型，请手动添加。")
            } else {
                candidates = found
            }
        } catch {
            failure = describeFailure(error)
        }
    }

    /// Picked ids join the rows; a row already there keeps the user's values.
    private func adopt(_ picked: [JSON]) {
        var rows = models
        for candidate in picked {
            guard let id = candidate["id"].string, !rows.contains(where: { $0["id"].string == id }) else { continue }
            var row: [String: JSON] = ["id": .string(id)]
            if let name = candidate["name"].string { row["name"] = .string(name) }
            if !candidate["contextWindow"].isNull { row["contextWindow"] = candidate["contextWindow"] }
            if !candidate["maxTokens"].isNull { row["maxTokens"] = candidate["maxTokens"] }
            if !candidate["inputModalities"].isNull { row["input"] = candidate["inputModalities"] }
            rows.append(.object(row))
        }
        onChange(rows)
        candidates = nil
    }
}

/// One model of the catalog: id, name, capacities, input types and, on hand-declared
/// routes, its reasoning levels. Fields it does not show stay in the row.
private struct ModelRowEditor: View {
    @Environment(\.dismiss) private var dismiss
    @State var model: JSON
    let position: Int
    let inputField: String
    let inputFallback: [String]?
    let contextHint: String
    let tokensHint: String
    let reasoningLevels: [String]
    let disabled: Bool
    let update: (JSON) -> Void
    let remove: () -> Void

    @State private var contextText = ""
    @State private var tokensText = ""

    private func write(_ next: JSON) {
        model = next
        update(next)
    }

    private func field(_ key: String) -> Binding<String> {
        Binding(get: { model[key].string ?? "" }, set: { write(model.setting([key], $0.isEmpty ? (key == "id" ? .string("") : nil) : .string($0))) })
    }

    var body: some View {
        Form {
            Section {
                DraftTextField(title: "模型 ID", placeholder: "", text: field("id"))
                DraftTextField(title: "显示名称", placeholder: String(localized: "留空时使用模型 ID"), text: field("name"))
            }
            .groupedRow()
            Section("模型选项") {
                DraftTextField(title: "上下文窗口", placeholder: contextHint, text: Binding(get: { contextText }, set: { contextText = $0; write(model.setting(["contextWindow"], parseCapacity($0))) }))
                DraftTextField(title: "最大输出 token 数", placeholder: tokensHint, text: Binding(get: { tokensText }, set: { tokensText = $0; write(model.setting(["maxTokens"], parseCapacity($0))) }))
                inputTypes
            }
            .groupedRow()
            if !reasoningLevels.isEmpty { ReasoningEditor(model: model, levels: reasoningLevels, write: write) }
            Section {
                Button("删除模型", role: .destructive) { remove(); dismiss() }
            }
            .groupedRow()
        }
        .tint(Palette.ink)
        .scrollContentBackground(.hidden)
        .background(Palette.background)
        .disabled(disabled)
        .navigationTitle(String(localized: "模型 \(position)"))
        .navigationBarTitleDisplayMode(.inline)
        .keyboardDoneButton()
        .onAppear {
            contextText = model["contextWindow"].double.map(formatCapacity) ?? model["contextWindow"].string ?? ""
            tokensText = model["maxTokens"].double.map(formatCapacity) ?? model["maxTokens"].string ?? ""
        }
        .onDisappear {
            let id = model["id"].string ?? ""
            let trimmed = id.trimmingCharacters(in: .whitespaces)
            if trimmed != id { write(model.setting(["id"], .string(trimmed))) }
        }
    }

    private var selected: [String] {
        let list = model[inputField].array.compactMap(\.string)
        return list.isEmpty ? (inputFallback ?? ["text"]) : list
    }

    private var inputTypes: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("输入类型").font(.caption).foregroundStyle(Palette.secondary)
            ForEach(["text", "image"], id: \.self) { modality in
                let isOn = selected.contains(modality)
                Toggle(modality == "text" ? "文本" : "图片", isOn: Binding(get: { isOn }, set: { on in
                    let next = ["text", "image"].filter { $0 == modality ? on : selected.contains($0) }
                    var row = model.setting([inputField], .array(next.map(JSON.string)))
                    if inputField == "inputModalities" && !next.contains("image") {
                        row = row.setting(["imagePixelBudget"], nil).setting(["imageMaxBytes"], nil)
                    }
                    write(row)
                }))
                .toggleStyle(.mono)
                .disabled(selected.count == 1 && isOn)
            }
        }
    }
}

/// M-08: the levels a hand-declared model offers, each with the wire value it sends.
private struct ReasoningEditor: View {
    let model: JSON
    let levels: [String]
    let write: (JSON) -> Void

    private var entries: [String: JSON]? {
        guard model.has(["reasoningEfforts"]), model["reasoningEfforts"].bool != false else { return nil }
        return model["reasoningEfforts"].object
    }

    private func order(_ level: String) -> Int { levels.firstIndex(of: level) ?? levels.count }
    private func defaultValue(_ level: String) -> JSON { level == "off" ? .null : .string(level) }

    private func set(_ next: [String: JSON]?) {
        write(model.setting(["reasoningEfforts"], next.map(JSON.object)))
    }

    var body: some View {
        Section {
            Toggle("推理等级", isOn: Binding(get: { entries != nil }, set: { on in
                let initial = ["off", "low", "medium", "high"].filter(levels.contains)
                set(on ? Dictionary(uniqueKeysWithValues: initial.map { ($0, defaultValue($0)) }) : nil)
            }))
            .toggleStyle(.mono)
            if let entries {
                let used = entries.keys.sorted { order($0) < order($1) }
                ForEach(used, id: \.self) { level in
                    HStack(spacing: 8) {
                        Picker("档位", selection: Binding(get: { level }, set: { to in
                            var next = entries
                            let wire = next.removeValue(forKey: level)
                            let keeps = wire?.string.map { !$0.isEmpty && $0 != level } == true && level != "off" && to != "off"
                            next[to] = keeps ? wire : defaultValue(to)
                            set(next)
                        })) {
                            ForEach(levels.filter { $0 == level || !used.contains($0) }, id: \.self) { Text($0).tag($0) }
                        }
                        .labelsHidden()
                        TextField(level == "off" ? String(localized: "关闭思考") : String(localized: "API 参数值"), text: Binding(
                            get: { entries[level]?.string ?? "" },
                            set: { text in
                                var next = entries
                                let trimmed = text.trimmingCharacters(in: .whitespaces)
                                next[level] = trimmed.isEmpty ? defaultValue(level) : .string(trimmed)
                                set(next)
                            }
                        ))
                        .font(.callout.monospaced())
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .disabled(level == "off")
                        Button {
                            var next = entries
                            next[level] = nil
                            set(next)
                        } label: {
                            Image(systemName: "minus.circle").foregroundStyle(Palette.secondary).hitTarget()
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("删除档位")
                    }
                }
                if used.count < levels.count {
                    Button {
                        let highest = used.map(order).max() ?? -1
                        let level = levels.enumerated().first { $0.offset > highest && !used.contains($0.element) }?.element ?? levels.first { !used.contains($0) }
                        if let level {
                            var next = entries
                            next[level] = defaultValue(level)
                            set(next)
                        }
                    } label: {
                        Label("添加档位", systemImage: "plus").foregroundStyle(Palette.ink)
                    }
                }
            }
        } footer: {
            Text("参数值写入请求的推理强度字段，默认与档位名相同。Off 表示关闭思考。")
        }
        .groupedRow()
    }
}

/// M-13: pick from what the provider lists: 全选 takes the visible rows, 取消全选 clears all.
private struct ModelPickerSheet: View {
    @Environment(\.dismiss) private var dismiss
    let candidates: [JSON]
    let known: Set<String>
    let adopt: ([JSON]) -> Void
    @State private var query = ""
    @State private var picked: Set<String> = []
    @State private var prepared = false

    private var visible: [JSON] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !needle.isEmpty else { return candidates }
        return candidates.filter { candidate in
            (candidate["id"].string ?? "").lowercased().contains(needle) || (candidate["name"].string ?? "").lowercased().contains(needle)
        }
    }

    private var allVisiblePicked: Bool { !visible.isEmpty && visible.allSatisfy { picked.contains($0["id"].string ?? "") } }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if visible.isEmpty { Text("没有匹配的模型。").foregroundStyle(Palette.secondary) }
                    ForEach(visible, id: \.self) { candidate in
                        let id = candidate["id"].string ?? ""
                        Button {
                            if !picked.insert(id).inserted { picked.remove(id) }
                            Haptics.select()
                        } label: {
                            HStack(spacing: 10) {
                                Image(systemName: picked.contains(id) ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(picked.contains(id) ? Palette.ink : Palette.faint)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(id).font(.footnote.monospaced()).foregroundStyle(Palette.ink).lineLimit(1)
                                    if let name = candidate["name"].string, name != id {
                                        Text(name).font(.caption).foregroundStyle(Palette.secondary).lineLimit(1)
                                    }
                                }
                            }
                        }
                    }
                } header: {
                    Text("以下是模型提供商的可用模型，勾选要添加的模型。").textCase(nil)
                }
                .groupedRow()
            }
            .groupedList()
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "搜索模型")
            .navigationTitle("选择要添加的模型")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("添加") { adopt(candidates.filter { picked.contains($0["id"].string ?? "") }) }
                        .disabled(picked.isEmpty)
                }
                ToolbarItem(placement: .bottomBar) {
                    Button(allVisiblePicked ? "取消全选" : "全选") {
                        if allVisiblePicked { picked = [] } else { picked.formUnion(visible.map { $0["id"].string ?? "" }) }
                    }
                }
            }
            .onAppear {
                guard !prepared else { return }
                prepared = true
                picked = Set(candidates.compactMap { $0["id"].string }.filter { !known.contains($0) })
            }
        }
        .tint(Palette.ink)
    }
}

// MARK: - Adding

/// M-11: pick a provider from the catalog or declare a custom API; either way the key
/// comes first, then the models. The list is read once: saving moves a provider out of
/// what can be added, and the page it pushed must survive a failed key step.
private struct AddProviderSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let model: ModelProvidersModel
    @State private var addable: [ProviderRow]?

    private var piAi: JSON? { app.settings.namespace("llm-pi-ai") }
    private var protocols: [String] { app.settings.graph("llm-pi-ai").map(protocolChoices) ?? [] }

    var body: some View {
        NavigationStack {
            List {
                if let addable {
                    Section("选择提供商") {
                        if addable.isEmpty {
                            Text("目录中的提供商都已添加。").font(.footnote).foregroundStyle(Palette.secondary)
                        }
                        ForEach(addable) { row in
                            if let namespace = app.settings.namespace(row.settingsNs) {
                                NavigationLink(row.displayName) {
                                    ProviderEditorPage(model: model, row: row, namespace: namespace, onAdded: { dismiss() })
                                }
                            }
                        }
                    }
                    .groupedRow()
                }
                if let piAi {
                    Section {
                        NavigationLink("自定义 API") {
                            CustomProviderForm(model: model, namespace: piAi, protocols: protocols, reasoningLevels: app.settings.graph("llm-pi-ai").map(reasoningLevelChoices) ?? [], onAdded: { dismiss() })
                                .navigationTitle("自定义 API")
                                .navigationBarTitleDisplayMode(.inline)
                                .keyboardDoneButton()
                        }
                    } footer: {
                        Text("中转站、自部署服务等兼容 OpenAI 或 Anthropic 协议的接口。")
                    }
                    .groupedRow()
                }
            }
            .groupedList()
            .navigationTitle("添加模型提供商")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
            }
        }
        .tint(Palette.ink)
        .sheetNotices()
        .onAppear {
            if addable == nil { addable = model.rows.filter { !$0.configured && app.settings.serves($0.settingsNs) } }
        }
    }
}

/// M-12: declare a custom model API (writes `llm-pi-ai`, then the key). First the address
/// and key, then the models it lists. The provider ID is derived from the name or the
/// address; 高级 can name it.
private struct CustomProviderForm: View {
    @Environment(AppModel.self) private var app
    let model: ModelProvidersModel
    let namespace: JSON
    let protocols: [String]
    let reasoningLevels: [String]
    let onAdded: () -> Void

    @State private var routeDraft = ""
    @State private var displayName = ""
    @State private var baseURL = ""
    @State private var api = ""
    @State private var keyDraft = ""
    @State private var models: [JSON] = []
    @State private var busy = false
    @State private var failure: String?
    /// The profile write landed under this ID; only the key can still be outstanding.
    @State private var committedRoute: String?
    @State private var openedAt: Int?
    @State private var choosingModels = false

    private var route: String { committedRoute ?? (routeDraft.isEmpty ? derivedRoute : routeDraft) }
    private var derivedRoute: String {
        func slug(_ text: String) -> String {
            text.lowercased().replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        }
        let host = URLComponents(string: normalizedURL)?.host?.replacingOccurrences(of: #"^(api|www)\."#, with: "", options: .regularExpression)
        var base = slug(displayName)
        if base.isEmpty { base = slug(host?.split(separator: ".").first.map(String.init) ?? "") }
        if base.first?.isLetter != true { base = base.isEmpty ? "custom" : "custom-\(base)" }
        let taken = Set(model.rows.map(\.provider))
        var candidate = base, suffix = 2
        while taken.contains(candidate) {
            candidate = "\(base)-\(suffix)"
            suffix += 1
        }
        return candidate
    }
    private var routeValid: Bool { route.range(of: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$", options: .regularExpression) != nil }
    private var routeTaken: Bool { committedRoute == nil && model.rows.contains { $0.provider == route } }
    private var normalizedURL: String { baseURL.trimmingCharacters(in: .whitespaces) }
    private var urlInvalid: Bool {
        guard !baseURL.isEmpty else { return false }
        guard let scheme = URLComponents(string: normalizedURL)?.scheme?.lowercased(), URLComponents(string: normalizedURL)?.host?.isEmpty == false else { return true }
        return scheme != "http" && scheme != "https"
    }
    private var keyFailure: String? { apiKeyFailure(keyDraft) }
    private var keyValue: String { keyDraft.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var modelProblem: String? { modelFailure(.array(models), checkReasoning: true) }
    private var canContinue: Bool { routeValid && !routeTaken && !normalizedURL.isEmpty && !urlInvalid && keyFailure == nil }
    private var ready: Bool { canContinue && !models.isEmpty && modelProblem == nil }
    private var locked: Bool { busy || committedRoute != nil || !app.settings.writable }
    private var dirty: Bool { !baseURL.isEmpty || !keyDraft.isEmpty || !displayName.isEmpty || !routeDraft.isEmpty }

    var body: some View {
        Form {
            Section {
                DraftTextField(title: "API 地址", placeholder: api == "anthropic-messages" ? "https://gateway.example" : "https://gateway.example/v1", text: $baseURL, keyboard: .URL).disabled(locked)
                if urlInvalid { Text("请输入有效的 HTTP 或 HTTPS 地址。").font(.caption).foregroundStyle(Palette.removed) }
                Picker("API 协议", selection: $api) {
                    ForEach(protocols, id: \.self) { Text(protocolLabel($0)).tag($0) }
                }
                .disabled(locked)
            }
            .groupedRow()
            Section {
                APIKeyField(placeholder: String(localized: "输入 API 密钥"), text: $keyDraft).disabled(busy)
                if let keyFailure { Text(keyFailure).font(.caption).foregroundStyle(Palette.removed) }
            } header: {
                Text("API 密钥")
            } footer: {
                if normalizedURL.isEmpty { Text("填写 API 地址后继续。") }
            }
            .groupedRow()
            Section {
                NavigationLink {
                    advancedPage
                } label: {
                    LabeledContent("高级", value: displayName.isEmpty ? route : displayName)
                }
                if routeTaken { Text("已有提供商使用了这个 ID。").font(.caption).foregroundStyle(Palette.removed) }
            }
            .groupedRow()
        }
        .tint(Palette.ink)
        .scrollContentBackground(.hidden)
        .background(Palette.background)
        .scrollDismissesKeyboard(.interactively)
        .interactiveDismissDisabled(dirty)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) { Button("下一步") { choosingModels = true }.disabled(!canContinue) }
        }
        .navigationDestination(isPresented: $choosingModels) { modelsStep }
        .onAppear {
            if api.isEmpty { api = protocols.first ?? "" }
            if openedAt == nil { openedAt = namespace["revision"].int }
        }
    }

    private var advancedPage: some View {
        Form {
            Section {
                DraftTextField(title: "显示名称", placeholder: route, text: $displayName).disabled(locked)
                DraftTextField(title: "提供商 ID", placeholder: derivedRoute, text: $routeDraft).disabled(locked)
                if !routeDraft.isEmpty && !routeValid {
                    Text("以小写字母开头，可用小写字母、数字和短横线。").font(.caption).foregroundStyle(Palette.removed)
                } else if routeTaken {
                    Text("已有提供商使用了这个 ID。").font(.caption).foregroundStyle(Palette.removed)
                }
            } footer: {
                Text("留空时根据地址自动生成。")
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

    private var modelsStep: some View {
        Form {
            if let failure {
                Section { Text(failure).font(.footnote).foregroundStyle(Palette.removed) }.groupedRow()
            }
            ModelCatalogSection(
                models: models,
                overridden: nil,
                autoFetch: true,
                family: .piAi,
                defaultContextWindow: nil,
                defaultMaxTokens: nil,
                defaultInput: nil,
                reasoningLevels: reasoningLevels,
                disabled: locked,
                probe: ModelProbe(
                    settingsNs: "llm-pi-ai",
                    baseURL: normalizedURL.isEmpty ? nil : normalizedURL,
                    api: api.isEmpty ? nil : api,
                    apiKey: keyValue.isEmpty ? nil : keyValue,
                    blocked: urlInvalid ? String(localized: "请输入有效的 HTTP 或 HTTPS 地址。") : keyFailure
                ),
                loadCatalog: false,
                onChange: { models = $0 },
                onReset: {}
            )
            if !models.isEmpty, let modelProblem {
                Section { Text(modelProblem).font(.footnote).foregroundStyle(Palette.waiting) }.groupedRow()
            }
        }
        .tint(Palette.ink)
        .scrollContentBackground(.hidden)
        .background(Palette.background)
        .navigationTitle("选择模型")
        .navigationBarTitleDisplayMode(.inline)
        .keyboardDoneButton()
        .interactiveDismissDisabled(true)
        .saveToolbar(canSave: ready && !busy && app.settings.writable, saving: busy) { Task { await create() } }
    }

    private func create() async {
        busy = true
        failure = nil
        defer { busy = false }
        let target = route
        let keyRef = deriveKeyRef(target)
        if committedRoute == nil {
            var profile: [String: JSON] = ["api": .string(api), "baseURL": .string(normalizedURL), "models": .array(models)]
            if !displayName.isEmpty { profile["displayName"] = .string(displayName) }
            if !keyValue.isEmpty { profile["apiKeyEnv"] = .string(keyRef) }
            do {
                try await app.settings.mutate("llm-pi-ai", [.set(["providers", target], .object(profile))], expectedRevision: openedAt)
                committedRoute = target
            } catch {
                failure = isConflict(error)
                    ? String(localized: "这些设置已在别处改动。请返回后重新打开，在当前值上编辑。")
                    : describeFailure(error)
                Haptics.error()
                return
            }
        }
        if !keyValue.isEmpty {
            do {
                try await app.settings.setCredential(keyRef, keyValue)
            } catch {
                failure = describeFailure(error)
                Haptics.error()
                return
            }
        }
        Haptics.success()
        onAdded()
        await model.load(app)
        app.showToast(String(localized: "已保存 \(displayName.isEmpty ? target : displayName)。"))
    }
}
