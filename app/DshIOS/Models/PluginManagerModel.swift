import Foundation
import Observation
import SwiftUI

// MARK: - Plugin packages

/// One component (row) of a bundle, joined with the live entry it runs as.
struct PluginRow: Identifiable, Hashable {
    let rowId: String
    let moduleName: String
    let meta: JSON
    let entryId: String?
    let enabled: Bool
    /// `pending` / `loading` / `active` / `failed` / `unloading`, nil when not running.
    let phase: String?
    /// Why the profile patch cannot switch this row (a management code).
    let readOnlyReason: String?
    var id: String { rowId }

    var title: String { localized(meta["title"]) ?? moduleName }
    var summary: String? { localized(meta["description"]).flatMap { $0.isEmpty ? nil : $0 } }
    var locked: Bool { readOnlyReason != nil || entryId == nil }
    /// Switched on and not running: it failed, or never got a fiber (a module that cannot be imported has none).
    var stalled: Bool { enabled && (phase == "failed" || phase == nil) }

    /// The state line: off, or the phase its fiber is in.
    var stateText: String {
        if !enabled { return String(localized: "已关闭") }
        switch phase {
        case "pending": return String(localized: "等待依赖")
        case "loading": return String(localized: "加载中")
        case "active": return String(localized: "运行中")
        case "failed": return String(localized: "异常")
        case "unloading": return String(localized: "卸载中")
        default: return String(localized: "未运行")
        }
    }
}

/// One bundle as the plugin page shows it (`packageView` in the web manager).
struct PluginPackage: Identifiable, Hashable {
    let json: JSON
    let rows: [PluginRow]
    var id: String { name }

    var name: String { json["name"].string ?? "" }
    var title: String { json["meta"]["title"].isNull ? name : (localized(json["meta"]["title"]) ?? name) }
    var summary: String? { (localized(json["meta"]["description"]) ?? json["description"].string).flatMap { $0.isEmpty ? nil : $0 } }
    var icon: String? { json["meta"]["icon"].string }
    var metaError: String? { json["meta"]["error"].string }
    var version: String? { json["version"].string }
    var source: String? { json["source"].string }
    var availability: String { json["availability"].string ?? "profile" }
    var installTarget: JSON? { json["installTarget"].nonNull }
    var installed: Bool { json["installed"].bool ?? false }
    var optional: Bool { json["optional"].bool ?? false }
    var official: Bool { json["official"].bool ?? false }
    var removable: Bool { json["removable"].bool ?? false }
    var enabled: Bool { json["enabled"].bool ?? false }
    var readOnlyReason: String? { json["readOnlyReason"].string }
    var error: JSON? { json["error"].nonNull }
    var beta: Bool { name.hasPrefix("@deepseek-ai/dsh-experimental-") }
    /// Switched on, yet a component of it is not running.
    var stalled: Bool { enabled && rows.contains(where: \.stalled) }
    var problem: Bool { error != nil || stalled }

    /// An on-demand official package whose installed version or source differs from what this DSH ships.
    var updateAvailable: Bool {
        guard installed, removable, availability != "installation", let target = installTarget,
              let targetVersion = target["version"].string, let targetSpec = target["spec"].string else { return false }
        return version != targetVersion || ((targetSpec.hasPrefix("link:") || source?.hasPrefix("link:") == true) && source != targetSpec)
    }

    /// The switch is off and locked for a package the Host protects, and for one it cannot read
    /// (except a missing catalog entry, whose switch installs it).
    var switchLocked: Bool {
        readOnlyReason != nil || (!enabled && error != nil && !(availability == "missing" && installTarget != nil))
    }

    init(bundle: JSON, plugins: [JSON]) {
        json = bundle
        rows = bundle["rows"].array.map { row in
            let entryId = row["entryId"].string
            let live = entryId.flatMap { id in plugins.first { $0["entryId"].string == id } }
            return PluginRow(
                rowId: row["rowId"].string ?? row["moduleName"].string ?? "",
                moduleName: row["moduleName"].string ?? "",
                meta: row["meta"],
                entryId: entryId,
                enabled: live?["enabled"].bool ?? false,
                phase: live?["fiberPhase"].string,
                readOnlyReason: live?["readOnlyReason"].string
            )
        }
    }
}

/// A `{en, zh?…}` plugin text (or a plain string) in the reader's language.
func localized(_ json: JSON) -> String? {
    if let text = json.string { return text }
    let object = json.object
    guard !object.isEmpty else { return nil }
    let zh = Locale.preferredLanguages.first?.hasPrefix("zh") == true
    if zh, let text = object.first(where: { $0.key.lowercased().hasPrefix("zh") })?.value.string { return text }
    return object["en"]?.string ?? object["zh"]?.string ?? object.values.compactMap(\.string).first
}

// MARK: - Management copy (P-12 / P-13)

/// The sentence for a Host management error (`ManagementError`): the code's sentence; for an
/// incompatibility one sentence per package, then the remedy; for an operation error the diagnostic.
func managementText(code: String?, diagnostic: String? = nil, incompatible: [JSON] = [], installing: Bool = false) -> String {
    switch code {
    case "management-required": return String(localized: "插件管理所需，不能停用或卸载")
    case "unaddressable": return String(localized: "当前 profile 的 patch 无法唯一定位这一项")
    case "unknown-plugin": return String(localized: "找不到该插件")
    case "invalid-spec": return String(localized: "请输入有效的包名或地址")
    case "already-installed": return String(localized: "这个包已经安装；要安装其他版本，请先卸载它")
    case "ambiguous-install": return String(localized: "无法从依赖变更中确定安装了哪一个包")
    case "not-bundle": return String(localized: "这个包没有声明组合包，不能作为插件管理")
    case "not-removable": return String(localized: "这个包不属于当前 profile，或者是插件管理所需的组件")
    case "stop-profile": return String(localized: "这个 profile 没有启用 HMR，正在使用的包要停止后用 dsh plugin 卸载")
    case "bundle-in-use": return String(localized: "其他配置仍在使用这个组合包的组件，请先停用它们")
    case "stale-approval": return String(localized: "待允许的安装脚本列表已变化，请重新安装以刷新")
    case "incompatible-version":
        let named = incompatible.isEmpty
            ? [String(localized: "这个插件与当前 DSH 版本不兼容，运行它可能导致崩溃或数据丢失。")]
            : incompatible.map { plugin in
                let requirements = plugin["requirements"].object.map { "\($0.key) \($0.value.string ?? "")" }.sorted().joined(separator: ", ")
                return String(localized: "\(plugin["name"].string ?? "")@\(plugin["version"].string ?? "") 与 DSH \(plugin["runtimeVersion"].string ?? "") 不兼容（要求 \(requirements)），运行它可能导致崩溃或数据丢失。")
            }
        return (named + [installing ? String(localized: "请安装与当前 DSH 兼容的插件版本。") : String(localized: "请卸载后重新安装与当前 DSH 兼容的版本。")]).joined()
    default:
        if let diagnostic, !diagnostic.isEmpty { return diagnostic }
        return String(localized: "Host 报告了一个错误")
    }
}

func managementText(_ error: JSON, installing: Bool = false) -> String {
    managementText(code: error["code"].string, diagnostic: error["diagnostic"].string, incompatible: error["incompatible"].array, installing: installing)
}

/// Why a change waits for a restart.
func restartReasonText(_ reason: String?) -> String {
    switch reason {
    case "no-hmr": String(localized: "这个 profile 只在启动时应用更改。")
    case "package-moved": String(localized: "已安装的插件包解析到了另一个目录，或者更改替换了 DSH 安装自带的包。从其他位置安装前请先卸载。")
    case "host-module": String(localized: "更改涉及 DSH 自身已加载的模块。")
    case "unmanaged-plugin": String(localized: "更改涉及一个不受插件列表管理的插件。")
    case "module-comparison": String(localized: "DSH 无法将已加载的插件与磁盘上的文件进行比较。")
    default: ""
    }
}

/// The restart notice; on iOS the engine restarts itself (ios-host) once no turn is running.
func restartNotice(_ reason: String?) -> String {
    let because = restartReasonText(reason)
    return String(localized: "请重启 DSH 使更改生效。\(because)").trimmingCharacters(in: .whitespaces) + String(localized: "没有对话在运行时会自动重启引擎。")
}

/// What a failed action reads as, by what was being done.
enum PluginAction {
    case enable, disable, uninstall, rowEnable, rowDisable

    func failed(_ reason: String) -> String {
        let text = reason.isEmpty ? String(localized: "Host 报告了一个错误") : reason
        switch self {
        case .enable: return String(localized: "启用失败：\(text)")
        case .disable: return String(localized: "停用失败：\(text)")
        case .uninstall: return String(localized: "卸载失败：\(text)")
        case .rowEnable: return String(localized: "组件启用失败：\(text)")
        case .rowDisable: return String(localized: "组件停用失败：\(text)")
        }
    }
}

// MARK: - The manager

/// The plugin page's state (`PluginManagerController` in the web client): the
/// managed profile's bundles joined with the entries their rows run as, and the
/// actions on them. One per connection, shared by the page, its detail pages and the
/// install task.
@MainActor
@Observable
final class PluginManagerModel {
    enum Status { case idle, loading, ready, error, unavailable }

    /// Built-in profile bundles stay out of the page even when the profile declares them.
    static let builtInProfileBundles: Set<String> = [
        "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@deepseek-ai/dsh-headless",
        "@deepseek-ai/dsh-sdk-app", "@deepseek-ai/dsh-acp-app", "@deepseek-ai/dsh-sdk-minimal",
    ]
    /// Optional bundles the main list always holds, in this order.
    static let extensionBundles = [
        "@deepseek-ai/dsh-experimental-agent-team-profile",
        "@deepseek-ai/dsh-experimental-voice-input-bundle",
        "@deepseek-ai/dsh-experimental-auto-review",
        "@deepseek-ai/dsh-experimental-inspector-profile",
    ]
    /// Optional bundles the main list holds back until the profile enables them.
    static let moreBundles = [
        "@deepseek-ai/dsh-experimental-tool-worktree",
        "@deepseek-ai/dsh-experimental-cot-translation-bundle",
        "@deepseek-ai/dsh-experimental-terminal-bundle",
        "@deepseek-ai/dsh-experimental-session-search",
        "@deepseek-ai/dsh-experimental-session-titles-bundle",
        "@deepseek-ai/dsh-experimental-badge-skill-bundle",
        "@deepseek-ai/dsh-experimental-ralph-bundle",
        "@deepseek-ai/dsh-experimental-plugin-market-bundle",
        "@deepseek-ai/dsh-subagent-codex",
        "@deepseek-ai/dsh-subagent-claude-code",
    ]
    static let marketBundle = "@deepseek-ai/dsh-experimental-plugin-market-bundle"

    @ObservationIgnored unowned let app: AppModel

    private(set) var status: Status = .idle
    private(set) var refreshing = false
    private(set) var packages: [PluginPackage] = []
    /// Package names and `row:<entryId>` keys with an action in flight.
    private(set) var busy: Set<String> = []
    /// A package an install just enabled, marked in the list for a moment.
    var highlight: String?

    @ObservationIgnored private var inflight: Task<Void, Never>?
    @ObservationIgnored private var rerun = false
    @ObservationIgnored private var loadedRevision: Int?

    init(app: AppModel) {
        self.app = app
    }

    // MARK: Derived lists

    /// What the page lists: no built-in profile bundles; installed, official or broken ones.
    var listed: [PluginPackage] {
        packages.filter { !Self.builtInProfileBundles.contains($0.name) && ($0.installed || $0.official || $0.problem) }
    }

    /// 实验性插件 (main list): the always-held optional bundles and any held-back one the profile enabled.
    var extensions: [PluginPackage] { Self.ordered(listed.filter { $0.official && (!Self.moreBundles.contains($0.name) || $0.enabled) }) }
    /// 实验性插件 → 更多: every official optional bundle.
    var allExtensions: [PluginPackage] { Self.ordered(listed.filter(\.official)) }
    /// 已安装插件: everything else the profile holds.
    var installedPackages: [PluginPackage] { listed.filter { !$0.official } }
    var hasMore: Bool { allExtensions.count > extensions.count }

    func package(_ name: String) -> PluginPackage? { packages.first { $0.name == name } }

    /// The plugin market's 发现 tab exists while its experimental bundle is enabled.
    var marketEnabled: Bool { package(Self.marketBundle)?.enabled == true }

    private static func rank(_ name: String) -> Int {
        if let index = extensionBundles.firstIndex(of: name) { return index }
        if let index = moreBundles.firstIndex(of: name) { return extensionBundles.count + 1 + index }
        return extensionBundles.count
    }

    private static func ordered(_ packages: [PluginPackage]) -> [PluginPackage] {
        packages.enumerated().sorted { lhs, rhs in
            let (l, r) = (rank(lhs.element.name), rank(rhs.element.name))
            return l == r ? lhs.offset < rhs.offset : l < r
        }.map(\.element)
    }

    private static func shortName(_ name: String) -> String {
        let bare = name.hasPrefix("@") ? String(name[name.index(after: name.firstIndex(of: "/") ?? name.startIndex)...]) : name
        return bare.replacingOccurrences(of: #"^dsh-(?:host-|client-)?"#, with: "", options: .regularExpression)
    }

    // MARK: Reading

    /// Re-read when `revision` (connection + `plugin-manager/changed`) moved.
    func refresh(revision: Int) async {
        if loadedRevision == revision, status == .ready || status == .unavailable { return }
        loadedRevision = revision
        await load()
    }

    /// Read the bundles; a call during a read marks one rerun after it.
    func load() async {
        if let inflight {
            rerun = true
            await inflight.value
            return
        }
        let task = Task { await read() }
        inflight = task
        await task.value
        inflight = nil
    }

    /// 刷新: keeps the cards; the spinner holds at least 400 ms; a failure with a list toasts.
    func manualRefresh() async {
        guard !refreshing else { return }
        refreshing = true
        let started = Date()
        let hadList = status == .ready
        await load()
        let remaining = 0.4 - Date().timeIntervalSince(started)
        if remaining > 0 { try? await Task.sleep(for: .seconds(remaining)) }
        refreshing = false
        if status == .error && hadList {
            status = .ready
            app.showToast(String(localized: "刷新失败，请重试"))
        }
    }

    private func read() async {
        repeat {
            rerun = false
            if status == .idle { status = .loading }
            do {
                let inventory = try await app.client.call("pluginInventory/list")
                guard inventory["managementAvailable"].bool == true else {
                    packages = []
                    status = .unavailable
                    continue
                }
                async let bundles = app.client.call("pluginManager/listBundles")
                async let plugins = app.client.call("pluginManager/listPlugins")
                let (bundleList, pluginList) = try await (bundles, plugins)
                packages = bundleList.array
                    .map { PluginPackage(bundle: $0, plugins: pluginList.array) }
                    .sorted { Self.shortName($0.name).localizedCompare(Self.shortName($1.name)) == .orderedAscending }
                status = .ready
            } catch is CancellationError {
                return
            } catch {
                status = .error
            }
        } while rerun
    }

    // MARK: Actions

    /// Run one action under a busy key; a failure toasts; the list is re-read afterwards.
    private func run(_ key: String, _ action: PluginAction, _ body: () async throws -> Void) async {
        guard !busy.contains(key) else { return }
        busy.insert(key)
        do {
            try await body()
        } catch let failure as ChangeFailure {
            Haptics.error()
            app.showToast(action.failed(failure.text), duration: Self.toastHold(action.failed(failure.text)))
        } catch {
            Haptics.error()
            app.showToast(action.failed(describeFailure(error)), duration: 5)
        }
        busy.remove(key)
        await load()
    }

    /// Long enough to read a failure that names what broke.
    static func toastHold(_ text: String) -> Double { min(8, max(3, Double(text.count) * 0.08)) }

    /// A change the Host refused or could not apply.
    struct ChangeFailure: Error { let text: String }

    /// Why enabling a package last failed. The Host says so only in the answer to the switch:
    /// the list has nothing for a plugin that could not be imported, and it is gone after a restart.
    private(set) var enableFailures: [String: String] = [:]

    /// `applied` for a switch turned on: what it failed with stays for the detail page.
    func appliedEnable(_ result: JSON, name: String, packageName: String) throws {
        enableFailures[name] = nil
        do {
            try applied(result, packageName: packageName)
        } catch let failure as ChangeFailure {
            enableFailures[name] = failure.text
            throw failure
        }
    }

    /// Publish a `ChangeResult`: a refusal throws; restart / overridden / cancelled toast.
    func applied(_ result: JSON, packageName: String) throws {
        switch result["application"].string {
        case "failed":
            throw ChangeFailure(text: result["error"].isNull ? "" : managementText(result["error"]))
        case "cancelled":
            app.showToast(String(localized: "已取消安装，插件未启用，下载的文件可能保留"))
        case "restart-required":
            app.showToast(restartNotice(result["restartReason"].string), duration: 6)
        case "overridden":
            app.showToast(String(localized: "\(packageName) 已保存，但被更高优先级的配置覆盖，当前未生效"), duration: 6)
        default:
            break
        }
    }

    /// P-05: switch a bundle. A missing catalog entry is installed (and selected) instead.
    func setEnabled(_ package: PluginPackage, _ enabled: Bool) async {
        if enabled, package.availability == "missing", let target = package.installTarget {
            app.pluginInstall.openCatalogInstall(package, target: target, enabled: true)
            return
        }
        await run(package.name, enabled ? .enable : .disable) {
            let result = try await app.client.call("pluginManager/setBundleEnabled", ["name": .string(package.name), "enabled": .bool(enabled)])
            if enabled {
                try appliedEnable(result, name: package.name, packageName: package.title)
            } else {
                enableFailures[package.name] = nil
                try applied(result, packageName: package.title)
            }
        }
    }

    /// P-08: switch one component (writes the profile patch; HMR applies it at once).
    func setRowEnabled(_ row: PluginRow, _ enabled: Bool) async {
        guard let entryId = row.entryId else { return }
        await run("row:\(entryId)", enabled ? .rowEnable : .rowDisable) {
            let result = try await app.client.call("pluginManager/setPluginEnabled", ["id": .string(entryId), "enabled": .bool(enabled)])
            try applied(result, packageName: row.title)
        }
    }

    /// P-09: uninstall (after the page's confirmation).
    func uninstall(_ package: PluginPackage) async {
        await run(package.name, .uninstall) {
            let result = try await app.client.call("pluginManager/removeBundle", ["name": .string(package.name)])
            enableFailures[package.name] = nil
            try applied(result, packageName: package.title)
        }
    }

    /// P-11: update an on-demand official package: remove it, then install this DSH's
    /// target with the same selection. A failed install leaves it removed.
    func update(_ package: PluginPackage) async {
        guard let target = package.installTarget, package.availability != "installation" else { return }
        guard package.installed else {
            app.pluginInstall.openCatalogInstall(package, target: target, enabled: package.enabled)
            return
        }
        await run(package.name, .uninstall) {
            let removed = try await app.client.call("pluginManager/removeBundle", ["name": .string(package.name)])
            if removed["error"]["code"].string != "stop-profile" { try applied(removed, packageName: package.title) }
            app.pluginInstall.openCatalogInstall(package, target: target, enabled: package.enabled)
        }
    }

    func isBusy(_ package: PluginPackage) -> Bool { busy.contains(package.name) }
    func isBusy(_ row: PluginRow) -> Bool { row.entryId.map { busy.contains("row:\($0)") } ?? false }
}

extension AppModel {
    /// The connection's plugin manager.
    var plugins: PluginManagerModel { sharedModel(&SharedModelKey.plugins) { PluginManagerModel(app: self) } }

    /// The connection's one install task (P-10 / P-15).
    var pluginInstall: PluginInstallTask { sharedModel(&SharedModelKey.install) { PluginInstallTask(app: self) } }
}
