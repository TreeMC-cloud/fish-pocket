import Foundation
import Observation

/// One provider's models in the catalog.
struct ModelGroup: Identifiable {
    let id: String
    var name: String
    var models: [ModelChoice]
}

/// A row of the `/` menu: a host command or a client one (`/file`, `/model`).
struct CommandRow: Identifiable, Hashable {
    enum Kind: Hashable { case host(CommandDescriptor), file, model }
    var kind: Kind
    var name: String
    var label: String?
    var description: String
    var icon: String
    var section: String?
    var id: String { name }
}

/// What the composer and the model picker read from the engine for one
/// conversation: the `/` catalog, the model catalog, permission presets and
/// the busy-Enter preference. Each reloads on its engine event.
@MainActor
@Observable
final class ComposerContext {
    private(set) var commands: [CommandDescriptor] = []
    /// Providers in the web's order: DeepSeek account, DeepSeek official, then the rest.
    private(set) var catalog: [ModelGroup] = []
    /// Providers whose model list failed to load (`failures`), shown with a retry.
    private(set) var catalogFailures: [(id: String, name: String, message: String)] = []
    private(set) var catalogDefault: (provider: String, model: String, effort: String?)?
    private(set) var catalogLoaded = false
    private(set) var catalogLoading = false
    private(set) var permissionOptions: [(value: String, name: String)] = []
    /// `ui-conversation.busyEnter` (C-141): what Send does while the agent runs.
    private(set) var busyEnter = "queue"

    func load(_ model: SessionModel) async {
        async let commands: Void = loadCommands(model)
        async let catalog: Void = loadCatalog(model)
        async let permissions: Void = loadPermissions(model)
        async let settings: Void = loadSettings(model)
        _ = await (commands, catalog, permissions, settings)
    }

    func loadCommands(_ model: SessionModel) async {
        guard let value = try? await model.client.call("commands/list", ["agentId": .string(model.sessionId)]) else { return }
        commands = value.array.map {
            CommandDescriptor(
                name: $0["name"].string ?? "",
                description: $0["description"].string ?? "",
                definitionId: $0["definitionId"].string,
                hint: $0["input"].isNull ? nil : ($0["input"]["hint"].string ?? ""),
                acceptsAttachments: $0["input"]["attachments"].bool ?? false
            )
        }
    }

    func loadCatalog(_ model: SessionModel) async {
        catalogLoading = true
        defer { catalogLoading = false }
        guard let value = try? await model.client.call("session/modelCatalog") else { return }
        catalogLoaded = true
        if let provider = value["default"]["provider"].string, let id = value["default"]["model"].string {
            catalogDefault = (provider, id, value["default"]["reasoningEffort"].string)
        }
        let groups = value["groups"].array.map { group in
            let id = group["id"].string ?? ""
            return ModelGroup(id: id, name: Self.providerName(id, group["name"].string), models: group["models"].array.map { m in
                ModelChoice(
                    provider: id,
                    model: m["id"].string ?? "",
                    name: m["name"].string ?? m["id"].string ?? "",
                    reasoningEfforts: m["reasoning"]["efforts"].array.map { ($0["id"].string ?? "", $0["name"].string ?? "") },
                    defaultEffort: m["reasoning"]["defaultEffort"].string
                )
            })
        }
        catalog = Self.ordered(groups)
        catalogFailures = value["failures"].array.map {
            let id = $0["id"].string ?? ""
            return (id, Self.providerName(id, $0["name"].string), $0["message"].string ?? "")
        }
    }

    func loadPermissions(_ model: SessionModel) async {
        if let value = try? await model.client.call("permissionPresets/catalog") {
            permissionOptions = value["options"].array.map { ($0["value"].string ?? "", $0["name"].string ?? "") }
        }
    }

    func loadSettings(_ model: SessionModel) async {
        guard let value = try? await model.client.call("settings/describe") else { return }
        let section = value["namespaces"].array.first { $0["ns"].string == "ui-conversation" }
        busyEnter = section?["value"]["busyEnter"].string == "steer" ? "steer" : "queue"
    }

    static func providerName(_ id: String, _ name: String?) -> String {
        id == "deepseek-account" ? String(localized: "DeepSeek 账号") : (name ?? id)
    }

    /// The account and official providers first; the others keep their catalog order.
    static func ordered(_ groups: [ModelGroup]) -> [ModelGroup] {
        func rank(_ id: String) -> Int { id == "deepseek-account" ? 0 : id == "deepseek-official" ? 1 : 2 }
        return groups.enumerated().sorted { (rank($0.element.id), $0.offset) < (rank($1.element.id), $1.offset) }.map(\.element)
    }

    // MARK: Model selection

    /// The session's choice, or the catalog default a fresh session will use.
    func selection(_ model: SessionModel) -> (provider: String, model: String, effort: String?)? {
        model.modelSelection ?? catalogDefault.map { ($0.provider, $0.model, nil) }
    }

    private func choice(_ provider: String, _ model: String) -> ModelChoice? {
        catalog.flatMap(\.models).first { $0.provider == provider && $0.model == model }
    }

    /// Move a conversation whose recorded model no longer routes to one that does,
    /// before its next message. The case this is for: the first message went out with
    /// no key and no account, so its turn ran (and failed) on DeepSeek official and the
    /// session recorded that model; signing in moves the default to the account, but
    /// the session keeps the model its last request used and every later turn fails the
    /// same way, while a new session starts on the new default and works.
    /// The target is the catalog default, else the first offered model (the account's
    /// first, as `session/initializeDefaultModel` picks it, when that call has not landed yet).
    func adoptRoutableModel(_ model: SessionModel) async {
        guard model.subagentAddress == nil, let recorded = model.modelSelection,
              choice(recorded.provider, recorded.model) == nil else { return }
        // The catalog in hand may predate the sign-in or the key: read it again before deciding.
        await loadCatalog(model)
        // A provider whose list failed to load this time is not known to be gone: leave it be.
        guard catalogLoaded, let current = model.modelSelection, choice(current.provider, current.model) == nil,
              !catalogFailures.contains(where: { $0.id == current.provider }) else { return }
        let next: ModelChoice
        var effort: String?
        if let fallback = catalogDefault, let found = choice(fallback.provider, fallback.model) {
            next = found
            effort = fallback.effort
        } else if let first = catalog.first?.models.first {
            next = first
        } else {
            return
        }
        do {
            try await model.applyModel(provider: next.provider, model: next.model, effort: effort)
            // Worth saying only if this conversation has answered on the old model. Before that it was
            // just the default of a route with no credential, and signing in replaced it as expected.
            if model.hasReply { model.toast(String(localized: "\(current.model) 当前不可用，已切换到 \(next.name)")) }
        } catch {
            // The prompt goes out as before and its turn reports why.
        }
    }

    func currentChoice(_ model: SessionModel) -> ModelChoice? {
        guard let selection = selection(model) else { return nil }
        return catalog.flatMap(\.models).first { $0.provider == selection.provider && $0.model == selection.model }
    }

    func modelName(_ model: SessionModel) -> String {
        guard let selection = selection(model) else {
            return catalogLoaded ? String(localized: "请选择模型") : String(localized: "正在加载模型…")
        }
        return currentChoice(model)?.name ?? selection.model
    }

    /// The reasoning level in force, named as the catalog names it; nil when the model has none.
    func effortName(_ model: SessionModel) -> String? {
        guard let choice = currentChoice(model), !choice.reasoningEfforts.isEmpty,
              let current = selection(model)?.effort ?? choice.defaultEffort else { return nil }
        return choice.reasoningEfforts.first { $0.id == current }?.name
    }

    /// 「思考」maps to the adapter's `off` level and the model's default level.
    func thinking(_ model: SessionModel) -> (choice: ModelChoice, on: String, off: String, isOn: Bool)? {
        guard let choice = currentChoice(model) else { return nil }
        let ids = choice.reasoningEfforts.map(\.id)
        guard let off = ids.first(where: { ["off", "none", "disabled"].contains($0) }),
              let on = choice.defaultEffort.flatMap({ $0 == off ? nil : $0 }) ?? ids.last(where: { $0 != off }) else { return nil }
        let current = selection(model)?.effort ?? choice.defaultEffort
        return (choice, on, off, current != off)
    }

    // MARK: Commands (C-99, C-100)

    /// The plan-mode plugin is in this session's catalog.
    var hasPlanMode: Bool { commands.contains { $0.builtinName == "plan" } }

    /// A typed line's command: exact name first, then a built-in's localized token.
    /// Returns the descriptor and the line spelled with the catalog name.
    func resolve(line: String) -> (CommandDescriptor, String)? {
        guard line.hasPrefix("/") else { return nil }
        let token = String(line.dropFirst().prefix { !$0.isWhitespace })
        guard !token.isEmpty else { return nil }
        let descriptor = commands.first { $0.name == token }
            ?? CommandDescriptor.aliases[token].flatMap { name in commands.first { $0.definitionId == CommandDescriptor.builtins[name] } }
        guard let descriptor else { return nil }
        return (descriptor, "/" + descriptor.name + line.dropFirst(token.count + 1))
    }

    /// The `/` menu: host commands (built-ins with their localized face) and the
    /// client's `/file` and `/model`. Commands taking arguments only open a draft.
    /// An empty query lists the 添加 and 指令 sections in usage order; a typed one ranks.
    func commandRows(query: String, leading: Bool) -> [CommandRow] {
        var rows: [CommandRow] = commands.map { descriptor in
            let face = Self.builtinFace(descriptor.builtinName)
            return CommandRow(kind: .host(descriptor), name: descriptor.name, label: face?.label,
                              description: face?.description ?? descriptor.description, icon: face?.icon ?? "command", section: nil)
        }
        let names = Set(rows.map(\.name))
        if !names.contains("file") {
            rows.append(CommandRow(kind: .file, name: "file", label: String(localized: "文件"), description: String(localized: "添加文件或图片"), icon: "paperclip", section: nil))
        }
        if !names.contains("model") {
            rows.append(CommandRow(kind: .model, name: "model", label: String(localized: "模型"), description: String(localized: "选择本会话使用的模型"), icon: "cpu", section: nil))
        }
        let visible = rows.filter { row in
            guard case .host(let descriptor) = row.kind else { return true }
            return leading || descriptor.hint == nil
        }
        guard query.isEmpty else { return FuzzyRank.rank(visible, query: query) { [$0.name] + ($0.label.map { [$0] } ?? []) } }
        let add = ["file", "goal", "plan"], listed = ["compact", "permission", "model", "export"]
        func pick(_ names: [String], _ section: String) -> [CommandRow] {
            names.compactMap { name in visible.first { $0.name == name } }.map { var row = $0; row.section = section; return row }
        }
        let rest = visible.filter { !add.contains($0.name) && !listed.contains($0.name) }.map { var row = $0; row.section = String(localized: "指令"); return row }
        return pick(add, String(localized: "添加")) + pick(listed, String(localized: "指令")) + rest
    }

    static func builtinFace(_ name: String?) -> (label: String, description: String, icon: String)? {
        switch name {
        case "goal": (String(localized: "目标"), String(localized: "设置或查看长期任务目标"), "scope")
        case "plan": (String(localized: "计划"), String(localized: "进入或退出计划模式"), "list.bullet.clipboard")
        case "compact": (String(localized: "压缩"), String(localized: "压缩以上对话内容"), "arrow.down.right.and.arrow.up.left")
        case "permission": (String(localized: "权限"), String(localized: "切换权限预设（沙箱模式与审批策略）"), "lock.shield")
        case "export": (String(localized: "导出日志"), String(localized: "将当前会话内容导出为 ZIP"), "square.and.arrow.down")
        default: nil
        }
    }

    /// The command-argument hint (C-84): the web's translation for built-ins, else the catalog's.
    func hint(for descriptor: CommandDescriptor, hasGoal: Bool) -> String? {
        guard let raw = descriptor.hint else { return nil }
        switch descriptor.builtinName {
        case "goal": return hasGoal ? String(localized: "当前目标进行中。可输入 edit 修改 / pause 暂停 / resume 继续 / clear 清除") : String(localized: "输入目标，智能体将持续执行")
        case "plan": return String(localized: "描述你的任务以生成计划")
        default: return raw.isEmpty ? nil : raw
        }
    }
}
