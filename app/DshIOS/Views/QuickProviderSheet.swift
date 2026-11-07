import SwiftUI

/// 从主界面直接开「添加第三方 API」：自己拿一个模型目录对象，保存后整页关掉。
///
/// 只为了填名称时不与既有提供商撞号——`ModelProvidersModel.rows` 是那条推断要用
/// 的全部信息，不必等目录页把凭据状态也读回来。
struct ThirdPartyAPISheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var model = ModelProvidersModel()

    var body: some View {
        QuickProviderSheet(model: model, onAdded: { dismiss() })
            .task { await model.loadRoutes(app) }
    }
}

/// 一页填完的第三方 API 接入：地址、密钥，自动识别协议并取回模型列表。
///
/// 与「添加模型提供商 → 自定义 API」的分工：那一条是目录提供商的两步流程（先填
/// 地址和密钥，再 push 一页手工勾选模型，协议要自己判断）；这一条把协议判断、
/// 模型拉取和默认模型设置都收进一次点击——协议留空即自动，依次试 OpenAI
/// Chat Completions、Anthropic Messages、OpenAI Responses，谁先列出模型就是谁。
///
/// 端点不提供模型列表（不少 DeepSeek 的 Anthropic 兼容口就没有）时不算失败：
/// 手动填模型 ID 一样能存。
struct QuickProviderSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let model: ModelProvidersModel
    /// 由「添加模型提供商」推入时给出：保存后关掉整张表，而不是只回退一页。
    let onAdded: (() -> Void)?
    /// 作为导航页推入时不自己开 `NavigationStack`。
    let embedded: Bool

    /// 显式实现：两个 `@Environment` 是 private，自动合成的成员初始化器不可见。
    init(model: ModelProvidersModel, onAdded: (() -> Void)? = nil, embedded: Bool = false) {
        self.model = model
        self.onAdded = onAdded
        self.embedded = embedded
    }

    @State private var baseURL = ""
    @State private var keyDraft = ""
    /// 空串 = 自动探测。
    @State private var api = ""
    @State private var displayName = ""
    @State private var probe: QuickProbe?
    @State private var manualIDs = ""
    @State private var useManual = false
    @State private var probing = false
    @State private var saving = false
    @State private var failure: String?
    @State private var attempts: [String] = []
    @State private var reveal = false

    // MARK: Inputs

    /// 没写协议就补 https://，省掉最常见的格式错误。
    private var normalizedURL: String {
        let raw = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return "" }
        return raw.contains("://") ? raw : "https://\(raw)"
    }

    private var urlInvalid: Bool {
        guard !baseURL.isEmpty else { return false }
        guard let parts = URLComponents(string: normalizedURL),
              let host = parts.host, !host.isEmpty,
              let scheme = parts.scheme?.lowercased() else { return true }
        return scheme != "http" && scheme != "https"
    }

    private var trimmedKey: String { keyDraft.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var trimmedName: String { displayName.trimmingCharacters(in: .whitespaces) }

    /// 粘贴成 `NAME=value`、带引号或含非 ASCII 的密钥：引擎会拒绝，这里先拦住。
    private var keyFailure: String? {
        guard !trimmedKey.isEmpty else { return nil }
        let illegal = String(localized: "该 API 密钥格式错误，请检查。")
        if trimmedKey.range(of: "^[A-Z][A-Z0-9_]*=[^=]", options: .regularExpression) != nil { return illegal }
        if let first = trimmedKey.first, "\"'`".contains(first), trimmedKey.count > 1, trimmedKey.last == first { return illegal }
        if trimmedKey.range(of: #"^[\x21-\x7E]+$"#, options: .regularExpression) == nil { return illegal }
        return nil
    }

    /// 手动模式：一行一个模型 ID，逗号也行。
    private var manualModels: [JSON] {
        var seen = Set<String>()
        return manualIDs
            .split(whereSeparator: { $0 == "," || $0 == "\n" || $0 == " " || $0 == "，" })
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
            .map { JSON.object(["id": .string($0)]) }
    }

    private var chosenModels: [JSON] { useManual ? manualModels : (probe?.models.map(quickSettingsModel) ?? []) }

    private var canSubmit: Bool {
        !urlInvalid && !normalizedURL.isEmpty && keyFailure == nil && !probing && !saving
            && (useManual ? !manualModels.isEmpty : true)
    }

    // MARK: Body

    var body: some View {
        if embedded {
            formContent
        } else {
            NavigationStack { formContent }
        }
    }

    private var formContent: some View {
        Form {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("API 地址").font(.caption).foregroundStyle(Palette.secondary)
                        TextField("https://api.example.com/v1", text: $baseURL)
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .font(.callout.monospaced())
                            .disabled(probing || saving)
                    }
                    if urlInvalid {
                        Text("请输入有效的 HTTP 或 HTTPS 地址。").font(.caption).foregroundStyle(Palette.removed)
                    }
                    Picker("协议", selection: $api) {
                        Text("自动识别").tag("")
                        ForEach(QuickProtocol.all, id: \.self) { Text(quickProtocolLabel($0)).tag($0) }
                    }
                    .disabled(probing || saving)
                } header: {
                    Text("接口")
                } footer: {
                    Text(api.isEmpty
                         ? "自动依次试 OpenAI Chat Completions、Anthropic Messages、OpenAI Responses，第一个能列出模型的就是它。"
                         : "已指定协议；连不上时改回「自动识别」。")
                }
                .groupedRow()

                Section {
                    HStack(spacing: 8) {
                        Group {
                            if reveal {
                                TextField("sk-…", text: $keyDraft)
                            } else {
                                SecureField("sk-…", text: $keyDraft)
                            }
                        }
                        .textContentType(nil)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.callout)
                        .disabled(probing || saving)
                        if !keyDraft.isEmpty {
                            Button { reveal.toggle() } label: {
                                Image(systemName: reveal ? "eye.slash" : "eye")
                                    .foregroundStyle(Palette.secondary)
                                    .hitTarget()
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(reveal ? "隐藏密钥" : "显示密钥")
                        }
                    }
                    if let keyFailure { Text(keyFailure).font(.caption).foregroundStyle(Palette.removed) }
                } header: {
                    Text("API 密钥")
                } footer: {
                    Text("留空表示该接口不需要认证。密钥只存在本机。")
                }
                .groupedRow()

                modelsSection

                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("显示名称").font(.caption).foregroundStyle(Palette.secondary)
                        TextField(URLComponents(string: normalizedURL)?.host ?? "可留空", text: $displayName)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .font(.callout)
                            .disabled(probing || saving)
                    }
                } header: {
                    Text("名称")
                } footer: {
                    Text("留空时用地址的域名。之后在模型页可以改。")
                }
                .groupedRow()

                if let failure {
                    Section {
                        Text(failure).font(.footnote).foregroundStyle(Palette.removed)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .groupedRow()
                }
            }
            .tint(Palette.ink)
            .scrollContentBackground(.hidden)
            .background(Palette.background)
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("添加第三方 API")
            .navigationBarTitleDisplayMode(.inline)
            .keyboardDoneButton()
            .toolbar {
                if !embedded {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("取消") { dismiss() }.disabled(saving)
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "保存中…" : "保存") { Task { await submit() } }
                        .disabled(!canSubmit)
                }
            }
    }

    // MARK: Models

    @ViewBuilder
    private var modelsSection: some View {
        Section {
            Button { Task { await runProbe() } } label: {
                HStack(spacing: 8) {
                    if probing { ProgressView().controlSize(.small) }
                    Text(probing ? "正在测试…" : (probe == nil ? "测试连接并获取模型" : "重新测试"))
                        .foregroundStyle(Palette.ink)
                }
            }
            .disabled(probing || saving || normalizedURL.isEmpty || urlInvalid || keyFailure != nil)

            if let probe {
                LabeledContent("协议", value: quickProtocolLabel(probe.api))
                LabeledContent("模型", value: String(localized: "\(probe.models.count) 个"))
                ForEach(Array(probe.models.prefix(6).enumerated()), id: \.offset) { _, entry in
                    Text(entry["id"].string ?? "")
                        .font(.caption.monospaced())
                        .foregroundStyle(Palette.secondary)
                        .lineLimit(1)
                }
                if probe.models.count > 6 {
                    Text("还有 \(probe.models.count - 6) 个…")
                        .font(.caption).foregroundStyle(Palette.faint)
                }
            }

            if !attempts.isEmpty, probe == nil {
                DisclosureGroup {
                    ForEach(Array(attempts.enumerated()), id: \.offset) { _, line in
                        Text(line).font(.caption).foregroundStyle(Palette.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                } label: {
                    Text("试过的协议").font(.footnote).foregroundStyle(Palette.waiting)
                }
            }

            Toggle("手动填写模型", isOn: $useManual)
                .toggleStyle(.mono)
                .disabled(probing || saving)
            if useManual {
                TextField("模型 ID，一行一个", text: $manualIDs, axis: .vertical)
                    .font(.callout.monospaced())
                    .lineLimit(3...8)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .disabled(probing || saving)
                if manualModels.isEmpty, !manualIDs.isEmpty {
                    Text("至少填一个模型 ID。").font(.caption).foregroundStyle(Palette.removed)
                }
            }
        } header: {
            Text("模型")
        } footer: {
            if useManual {
                Text("接口不提供模型列表时用它。保存后这些 ID 会写进模型目录。")
            } else if probe == nil {
                Text("先测试连接；也可以打开「手动填写模型」跳过。")
            } else {
                Text("保存后这些模型会写进模型目录，第一个同时被设为默认模型。")
            }
        }
        .groupedRow()
    }

    // MARK: Probing

    /// 依次试候选协议；第一个列出模型的胜出。全部失败时留下逐条原因。
    private func runProbe() async {
        probing = true
        failure = nil
        attempts = []
        defer { probing = false }
        let candidates = api.isEmpty ? QuickProtocol.all : [api]
        for candidate in candidates {
            var request: [String: JSON] = [
                "baseURL": .string(normalizedURL),
                "api": .string(candidate),
            ]
            if !trimmedKey.isEmpty { request["apiKey"] = .string(trimmedKey) }
            do {
                let found = try await app.client.call("llm/discoverModels", [
                    "settingsNs": "llm-pi-ai",
                    "request": .object(request),
                ]).array
                if found.isEmpty {
                    attempts.append(String(localized: "\(quickProtocolLabel(candidate))：该地址没有列出任何模型。"))
                    continue
                }
                probe = QuickProbe(api: candidate, models: found)
                Haptics.success()
                return
            } catch {
                attempts.append(String(localized: "\(quickProtocolLabel(candidate))：\(quickProbeFailure(error))"))
            }
        }
        probe = nil
        useManual = true
        failure = String(localized: "这个地址没有列出模型。打开「手动填写模型」把模型 ID 填进去，照样能用。")
        Haptics.error()
    }

    // MARK: Saving

    /// 保存时若还没探测过，先探测一次；探不通就转手动模式，不打断用户。
    private func submit() async {
        if probe == nil, !useManual {
            await runProbe()
            guard probe != nil else { return }
        }
        let models = chosenModels
        guard !models.isEmpty else {
            failure = String(localized: "至少添加一个模型。")
            return
        }
        saving = true
        failure = nil
        defer { saving = false }

        let route = quickDerivedRoute(name: trimmedName, baseURL: normalizedURL, taken: Set(model.rows.map(\.provider)))
        let keyRef = deriveKeyRef(route)
        do {
            var profile: [String: JSON] = [
                "api": .string(probe?.api ?? (api.isEmpty ? QuickProtocol.all[0] : api)),
                "baseURL": .string(normalizedURL),
                "models": .array(models),
            ]
            if !trimmedName.isEmpty { profile["displayName"] = .string(trimmedName) }
            if !trimmedKey.isEmpty { profile["apiKeyEnv"] = .string(keyRef) }

            try await app.settings.mutate(
                "llm-pi-ai",
                [.set(["providers", route], .object(profile))],
                expectedRevision: app.settings.namespace("llm-pi-ai")?["revision"].int
            )
            // 设置落盘后再写密钥：两步分开，第一步成功但第二步失败时重试只补密钥。
            if !trimmedKey.isEmpty {
                try await app.settings.setCredential(keyRef, trimmedKey)
            }
            // 新会话默认用它，省掉保存完还要去挑模型这一步。
            var defaulted = false
            if app.settings.serves("agent-default-model"), let first = models.first?["id"].string {
                var ops: [SettingsOp] = [
                    .set(["provider"], .string(route)),
                    .set(["model"], .string(first)),
                ]
                // 换了提供商，原来的推理等级多半不适用：一并清掉，交给新适配器的默认值。
                var clearsEffort = false
                if let user = app.settings.namespace("agent-default-model")?["user"], !user.isNull {
                    clearsEffort = user.value(at: ["reasoningEffort"]) != nil
                }
                if clearsEffort { ops.append(.unset(["reasoningEffort"])) }
                do {
                    _ = try await app.settings.mutate(
                        "agent-default-model",
                        ops,
                        expectedRevision: app.settings.namespace("agent-default-model")?["revision"].int
                    )
                    defaulted = true
                } catch {
                    // 默认模型设不上不影响这条提供商可用，提示里不提它就是了。
                    defaulted = false
                }
            }
            Haptics.success()
            await model.load(app)
            let shown = trimmedName.isEmpty ? route : trimmedName
            app.showToast(defaulted
                          ? String(localized: "已添加 \(shown)，默认模型 \(models.first?["id"].string ?? "")。")
                          : String(localized: "已添加 \(shown)。"))
            if let onAdded { onAdded() } else { dismiss() }
        } catch {
            Haptics.error()
            failure = isConflict(error)
                ? String(localized: "这些设置已在别处改动，请关闭后重试。")
                : describeFailure(error)
        }
    }
}

/// 探测结果：匹配到的协议与该端点列出的模型。
private struct QuickProbe: Equatable {
    let api: String
    let models: [JSON]
}

/// pi-ai 支持的三种线协议，按最可能匹配的顺序排列。
private enum QuickProtocol {
    /// `dsh-llm-pi-ai` 的 `PROTOCOLS` 全集。OpenAI Responses 与 Chat Completions
    /// 探测同一个 `/models`，放最后只是补全。
    static let all = ["openai-completions", "anthropic-messages", "openai-responses"]
}

private func quickProtocolLabel(_ value: String) -> String {
    switch value {
    case "openai-completions": String(localized: "OpenAI Chat Completions")
    case "openai-responses": String(localized: "OpenAI Responses")
    case "anthropic-messages": String(localized: "Anthropic Messages")
    default: value
    }
}

/// 探测回来的模型行改写成设置里的形状：pi-ai 这一族的输入类型字段叫 `input`，
/// 而 `llm/discoverModels` 返回的是 `inputModalities`。
private func quickSettingsModel(_ candidate: JSON) -> JSON {
    let modelID = candidate["id"].string ?? ""
    var row: [String: JSON] = [:]
    if !modelID.isEmpty { row["id"] = .string(modelID) }
    if let name = candidate["name"].string, !name.isEmpty, name != modelID { row["name"] = .string(name) }
    if let window = candidate["contextWindow"].double, window > 0 { row["contextWindow"] = .number(window) }
    if let maxTokens = candidate["maxTokens"].double, maxTokens > 0 { row["maxTokens"] = .number(maxTokens) }
    let input = candidate["inputModalities"].array.compactMap(\.string)
    if !input.isEmpty { row["input"] = .array(input.map { .string($0) }) }
    return .object(row)
}

/// 探测失败对用户说什么：引擎的原文最有用（它是「这个地址答 404」「检查 API 密钥」
/// 这类具体诊断），只是把裸露的错误码放前面当前缀。
private func quickProbeFailure(_ error: Error) -> String {
    guard let engine = error as? EngineError else { return describeFailure(error) }
    let text = engine.message.trimmingCharacters(in: .whitespacesAndNewlines)
    if text.isEmpty, let code = engine.code { return code }
    if let code = engine.code, !text.localizedCaseInsensitiveContains(code) {
        return "\(text)（\(code)）"
    }
    return text
}

/// 从名称或地址推一个不与既有路由冲突的提供商 ID，规则与「自定义 API」一致。
private func quickDerivedRoute(name: String, baseURL: String, taken: Set<String>) -> String {
    func slug(_ text: String) -> String {
        text.lowercased()
            .replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }
    let host = URLComponents(string: baseURL)?.host?
        .replacingOccurrences(of: #"^(api|www)\."#, with: "", options: .regularExpression)
    var base = slug(name)
    if base.isEmpty { base = slug(host?.split(separator: ".").first.map(String.init) ?? "") }
    if base.first?.isLetter != true { base = base.isEmpty ? "custom" : "custom-\(base)" }
    var candidate = base
    var suffix = 2
    while taken.contains(candidate) {
        candidate = "\(base)-\(suffix)"
        suffix += 1
    }
    return candidate
}
