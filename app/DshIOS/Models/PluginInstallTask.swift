import Foundation
import Observation
import SwiftUI

/// Which npm registry an install asks: one the Host offers (nil = pnpm's own
/// configuration), or an address the person typed.
enum RegistryChoice: Equatable {
    case offered(String?)
    case custom(String)

    var registry: String? {
        switch self {
        case .offered(let registry): registry
        case .custom(let url): url.trimmingCharacters(in: .whitespaces)
        }
    }

    /// The memory the web client keeps in `localStorage["dsh.plugin-manager.install-registry"]`.
    static let memoryKey = "dsh.plugin-manager.install-registry"

    var json: JSON {
        switch self {
        case .offered(let registry): ["kind": "offered", "registry": registry.map(JSON.string) ?? .null]
        case .custom(let url): ["kind": "custom", "url": .string(url)]
        }
    }

    init?(json: JSON) {
        switch json["kind"].string {
        case "offered": self = .offered(json["registry"].string)
        case "custom": self = .custom(json["url"].string ?? "")
        default: return nil
        }
    }
}

/// One pnpm command of an install, folded from `plugin-manager/install-log` chunks.
struct InstallRun: Identifiable, Equatable {
    let jobId: String
    let command: String
    let cwd: String
    var output: String
    var exitCode: Int?
    var settled: Bool
    var id: String { jobId }
}

/// Why an install did not finish: the Host's code and diagnostic, the run's classified failure.
struct InstallFailure: Equatable {
    var reason: String = ""
    var code: String?
    var incompatible: [JSON] = []
    var kind: String?
    var failedAt: String?
    var pendingBuilds: [String] = []
    /// What a lost answer left unknown: `result`, `cancellation` or `acceptance`.
    var uncertainty: String?
}

/// The plugin install dialog's state machine (P-10), kept outside the sheet so a
/// hidden install keeps running and reports its result in a toast (P-15):
/// `idle → checking → starting → running → done | failed`, plus `cancelling`,
/// `applying` (past the point of cancelling), `unconfirmed` (an answer was lost)
/// and `unknown` (the Host has no such request).
@MainActor
@Observable
final class PluginInstallTask {
    enum Phase: Equatable { case idle, checking, starting, running, cancelling, applying, unconfirmed, unknown, done, failed }

    static let npmmirror = "https://registry.npmmirror.com/"
    static let npmjs = "https://registry.npmjs.org/"

    @ObservationIgnored unowned let app: AppModel

    /// The sheet is on screen.
    private(set) var open = false
    var spec = ""
    private(set) var registries: JSON?
    var registry: RegistryChoice = .offered(nil)
    var registryOpen = false
    private(set) var registryError = false
    private(set) var phase: Phase = .idle
    /// A refused spec: `{problem, reason, registries?}`.
    private(set) var inputError: JSON?
    /// What the Host read the spec as (the inspect answer) plus `spec`, `selection`, `saveExact`.
    private(set) var subject: JSON?
    /// A market entry's title and version, shown instead of the form (MK-08).
    private(set) var confirmed: (title: String, version: String)?
    private(set) var runs: [InstallRun] = []
    private(set) var attempts: (registries: [String?], total: Int)?
    private(set) var installed: String?
    private(set) var installedVersion: String?
    /// False when the install added no dependency.
    private(set) var changed = true
    private(set) var restartRequired = false
    private(set) var restartReason: String?
    private(set) var failure: InstallFailure?
    private(set) var approvedBuilds: [String] = []
    private(set) var enabling = false
    var detailsOpen = false
    /// The GitHub-mirror recovery cleared the spec; the guide says why.
    private(set) var mirrorRecovery = false

    @ObservationIgnored private(set) var requestId: String?
    @ObservationIgnored private var acknowledged = false
    @ObservationIgnored private var replyLost = false
    @ObservationIgnored private var recovering = false
    @ObservationIgnored private var cancellation: (waitingForStart: Bool, active: Bool)?
    @ObservationIgnored private var inspectTask: Task<Void, Never>?
    @ObservationIgnored private var registryRead: Task<Void, Never>?
    /// A market entry chose the registry: this dialog only, never remembered.
    @ObservationIgnored private var transientRegistry = false
    @ObservationIgnored private var listener: UUID?

    init(app: AppModel) {
        self.app = app
        listener = app.addListener { [weak self] event, args in
            guard let self, let payload = args.first else { return }
            switch event {
            case "plugin-manager/install-log": self.appendLog(payload)
            case "plugin-manager/install-state": self.progress(payload)
            default: break
            }
        }
    }

    /// Still owned by the Host: a result or a check for an active request is outstanding.
    var pending: Bool { [.starting, .running, .cancelling, .applying, .unconfirmed].contains(phase) }
    var busy: Bool { phase == .checking || pending }
    var resolved: String? { registries?["resolved"].string }

    // MARK: Opening

    /// 添加插件: a new dialog starts from the registry last used; a hidden install reopens as it is.
    func openDialog() {
        if requestId == nil && !busy {
            reset()
            transientRegistry = false
            registry = Self.remembered ?? .offered(nil)
            readRegistries()
        }
        show()
        Task { await reconcile() }
    }

    /// MK-08: install a market version straight from the check, without the form.
    func installFrom(spec: String, registry: String?, title: String, version: String) {
        guard requestId == nil && !busy else { show(); return }
        reset()
        show()
        self.spec = spec
        confirmed = (title, version)
        transientRegistry = registry != nil
        self.registry = registry.map { .custom($0) } ?? Self.remembered ?? .offered(nil)
        readRegistries()
        run()
    }

    /// P-05 / P-11: install an official catalog target with an explicit selection, skipping the check.
    func openCatalogInstall(_ package: PluginPackage, target: JSON, enabled: Bool) {
        if busy { show(); return }
        let spec = target["spec"].string ?? ""
        let local = spec.hasPrefix("link:")
        reset()
        show()
        self.spec = spec
        registry = Self.remembered ?? .offered(nil)
        var subject: [String: JSON] = [
            "status": "accepted",
            "kind": .string(local ? "path" : "registry"),
            "name": .string(package.name),
            "version": target["version"],
            "bundle": true,
            "spec": .string(spec),
            "selection": .bool(enabled),
        ]
        if !local { subject["saveExact"] = true }
        self.subject = .object(subject)
        readRegistries()
        run()
    }

    /// Hide the sheet. An install keeps running and reports in a toast; a check or a
    /// finished screen is dropped.
    func close() {
        hide()
        guard !pending else { return }
        inspectTask?.cancel()
        inspectTask = nil
        reset()
    }

    /// The sheet was swiped away by the system.
    func sheetDismissed() {
        guard open else { return }
        close()
    }

    func show() {
        open = true
        PluginInstallPresenter.show(app)
    }

    private func hide() {
        open = false
        PluginInstallPresenter.hide()
    }

    private func reset() {
        spec = ""
        registryOpen = false
        registryError = false
        phase = .idle
        inputError = nil
        subject = nil
        confirmed = nil
        runs = []
        attempts = nil
        installed = nil
        installedVersion = nil
        changed = true
        restartRequired = false
        restartReason = nil
        failure = nil
        approvedBuilds = []
        enabling = false
        detailsOpen = false
        mirrorRecovery = false
        requestId = nil
    }

    /// Back at the spec, the run forgotten, the spec and registry kept.
    private func specAgain() {
        let keepSpec = spec, keepRegistry = registry, keepSubject = subject?["selection"].isNull == false ? subject : nil
        let keepConfirmed = confirmed, keepRecovery = mirrorRecovery
        reset()
        spec = keepSpec
        registry = keepRegistry
        subject = keepSubject
        confirmed = keepConfirmed
        mirrorRecovery = keepRecovery
    }

    /// After a confirmed cancel: back at the form, or, for a market entry that has
    /// none, out of the sheet.
    private func backToSpec() {
        specAgain()
        guard confirmed != nil else { return }
        hide()
        reset()
    }

    // MARK: Registries

    static var remembered: RegistryChoice? {
        guard let data = UserDefaults.standard.data(forKey: RegistryChoice.memoryKey),
              let json = try? JSONDecoder().decode(JSON.self, from: data) else { return nil }
        return RegistryChoice(json: json)
    }

    private func remember(_ choice: RegistryChoice) {
        guard !transientRegistry, let data = try? JSONEncoder().encode(choice.json) else { return }
        UserDefaults.standard.set(data, forKey: RegistryChoice.memoryKey)
    }

    /// The registries the dialog offers: the Host's first, its fallbacks, then pnpm's own, each once.
    var offeredRegistries: [String?] {
        var offered: [String?] = []
        var keys: [String] = []
        let configured: [String?] = registries.map { [$0["registry"].string] + $0["fallbackRegistries"].array.map(\.string) } ?? []
        for candidate in configured + [nil] {
            let key = Self.registryKey(candidate, resolved: resolved)
            if keys.contains(key) { continue }
            offered.append(candidate)
            keys.append(key)
        }
        return offered
    }

    static func normalize(_ url: String) -> String? {
        guard var components = URLComponents(string: url), let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return nil }
        components.host = components.host?.lowercased()
        if !components.path.hasSuffix("/") { components.path += "/" }
        return components.string
    }

    static func registryKey(_ registry: String?, resolved: String?) -> String {
        guard let url = registry ?? resolved else { return "" }
        return normalize(url) ?? url
    }

    /// What a registry reads as: npm's own and npmmirror by name, any other by host.
    static func registryName(_ registry: String?, resolved: String?) -> (name: String, host: String) {
        guard let url = registry ?? resolved else { return (String(localized: "默认安装源"), "registry.npmjs.org") }
        let host = URLComponents(string: url)?.host ?? url
        switch host {
        case "registry.npmjs.org": return (String(localized: "npm 官方源"), host)
        case "registry.npmmirror.com": return (String(localized: "中国大陆镜像源"), host)
        default: return (host, host)
        }
    }

    func registryList(_ list: [String?]) -> String {
        list.map { Self.registryName($0, resolved: resolved).name }.joined(separator: String(localized: "、"))
    }

    /// Read what the Host offers; a dialog nobody touched yet adopts the remembered choice
    /// or, with nothing remembered and the unconfigured official npm, the faster of it and npmmirror.
    private func readRegistries() {
        let initial = registry
        registryRead = Task {
            guard let answer = try? await app.client.call("pluginManager/registries") else { return }
            registries = answer
            let untouched = registry == initial && (phase == .idle || phase == .checking)
            let remembered = Self.remembered
            if untouched { registry = reconciled(remembered, answer) }
            guard untouched, remembered == nil, answer["registry"].isNull,
                  let resolved = answer["resolved"].string, Self.normalize(resolved) == Self.npmjs,
                  answer["fallbackRegistries"].array.contains(.string(Self.npmmirror)) else { return }
            let chosen = registry
            if let fastest = try? await app.client.call("pluginRegistryProbe/fastest"), fastest.string == Self.npmmirror,
               registry == chosen, phase == .idle || phase == .checking {
                registry = .offered(Self.npmmirror)
            }
        }
    }

    private func reconciled(_ remembered: RegistryChoice?, _ answer: JSON) -> RegistryChoice {
        guard let remembered else { return .offered(answer["registry"].string) }
        guard case .offered(let registry?) = remembered else { return remembered }
        let key = Self.registryKey(registry, resolved: answer["resolved"].string)
        if let offered = offeredRegistries.first(where: { Self.registryKey($0, resolved: answer["resolved"].string) == key }) { return .offered(offered) }
        return .custom(registry)
    }

    /// The spec was edited: the last refusal no longer applies.
    func clearInputError() { inputError = nil }

    func choose(_ choice: RegistryChoice) {
        guard phase == .idle else { return }
        transientRegistry = false
        registry = choice
        registryError = false
    }

    // MARK: Running

    /// 安装: check the spec, then install it.
    func run() {
        let trimmed = spec.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !busy, !trimmed.isEmpty else { return }
        let catalog = subject.flatMap { $0["selection"].isNull || $0["spec"].string != trimmed ? nil : $0 }
        if catalog == nil, let listed = app.plugins.package(trimmed), listed.availability != "missing" {
            inputError = ["problem": .string(listed.availability == "installation" ? "shipped" : "already-installed"), "reason": .string(trimmed)]
            return
        }
        if case .custom(let url) = registry, url.trimmingCharacters(in: .whitespaces).range(of: #"^https?://\S+$"#, options: .regularExpression) == nil {
            registryError = true
            registryOpen = true
            return
        }
        inspectTask?.cancel()
        phase = .checking
        inputError = nil
        subject = catalog
        runs = []
        detailsOpen = false
        attempts = nil
        registryOpen = false
        installed = nil
        installedVersion = nil
        restartRequired = false
        failure = nil
        approvedBuilds = []
        inspectTask = Task {
            await registryRead?.value
            guard !Task.isCancelled, phase == .checking else { return }
            let choice = registry
            remember(choice)
            let chosen = choice.registry
            if var catalog {
                catalog = catalog.setting(["registry"], chosen.map(JSON.string) ?? .null)
                await startInstall(catalog)
                return
            }
            do {
                let answer = try await app.client.call("pluginManager/inspect", ["spec": .string(trimmed), "options": ["registry": chosen.map(JSON.string) ?? .null]])
                guard !Task.isCancelled, phase == .checking else { return }
                if answer["status"].string == "refused" {
                    phase = .idle
                    inputError = answer
                    return
                }
                await startInstall(answer.setting(["spec"], .string(trimmed)))
            } catch {
                guard !Task.isCancelled, phase == .checking else { return }
                phase = .idle
                inputError = ["problem": "unknown", "reason": .string(describeFailure(error))]
            }
        }
    }

    /// Hand the checked spec to the Host (`enabled:false` unless a catalog selection says
    /// otherwise; enabling is the 立即启用 step) and settle from its answer.
    private func startInstall(_ subject: JSON, approved: [String]? = nil) async {
        let id = UUID().uuidString.lowercased()
        requestId = id
        acknowledged = false
        replyLost = false
        recovering = false
        cancellation = nil
        phase = .starting
        self.subject = subject
        runs = []
        attempts = nil
        failure = nil
        installed = nil
        installedVersion = nil
        approvedBuilds = []
        var options: [String: JSON] = [
            "enabled": .bool(subject["selection"].bool ?? false),
            "requestId": .string(id),
            "registry": subject["registry"],
        ]
        if let exact = subject["saveExact"].bool { options["saveExact"] = .bool(exact) }
        if let approved { options["approvedBuilds"] = .array(approved.map(JSON.string)) }
        do {
            let result = try await app.client.call("pluginManager/installBundle", ["spec": subject["spec"], "options": .object(options)])
            guard requestId == id else { return }
            settle(result)
        } catch {
            guard requestId == id else { return }
            replyLost = true
            uncertain("result", describeFailure(error))
            await reconcile()
        }
    }

    /// 核对安装状态 (and on every reconnect): the Host's active result, or explicitly unknown.
    func reconcile() async {
        guard let id = requestId, replyLost, !recovering else { return }
        recovering = true
        defer { recovering = false }
        do {
            let result = try await app.client.call("pluginManager/waitForInstall", ["requestId": .string(id)])
            guard requestId == id else { return }
            if !result.isNull { settle(result); return }
            requestId = nil
            phase = .unknown
            failure = nil
            settleRuns(nil)
            notifyHidden(String(localized: "未能获取安装结果，请检查插件列表。"))
            await app.plugins.load()
        } catch {
            guard requestId == id else { return }
            uncertain("result", describeFailure(error))
        }
    }

    private func settle(_ result: JSON) {
        requestId = nil
        if let asked = result["registries"].array.nilIfEmpty {
            attempts = (asked.map(\.string), max(attempts?.total ?? 0, asked.count))
        }
        switch result["application"].string {
        case "cancelled":
            backToSpec()
            app.showToast(String(localized: "已取消安装，插件未启用，下载的文件可能保留"))
        case "failed":
            let package = result["packageResult"]
            settleRuns(package["exitCode"].int)
            phase = .failed
            failure = InstallFailure(
                reason: result["error"]["diagnostic"].string ?? "",
                code: result["error"]["code"].string,
                incompatible: result["error"]["incompatible"].array,
                kind: package["kind"].string,
                failedAt: result["failedAt"].string,
                pendingBuilds: result["pendingBuilds"].array.compactMap(\.string)
            )
            Haptics.error()
            notifyHidden(String(localized: "插件安装失败，可查看安装详情。"))
        default:
            settleRuns(0)
            phase = .done
            failure = nil
            installed = result["bundle"].string
            installedVersion = result["version"].string
            changed = result["changed"].bool ?? true
            restartRequired = result["application"].string == "restart-required"
            restartReason = result["restartReason"].string
            approvedBuilds = result["approvedBuilds"].array.compactMap(\.string)
            Haptics.success()
            if subject?["selection"].bool != nil, let bundle = installed {
                try? app.plugins.applied(result, packageName: bundle)
                app.plugins.highlight = bundle
            }
            notifyHidden(String(localized: "插件安装已完成，可查看安装结果。"))
        }
        Task { await app.plugins.load() }
    }

    private func settleRuns(_ exitCode: Int?) {
        runs = runs.map { run in
            var run = run
            if !run.settled { run.settled = true; run.exitCode = run.exitCode ?? exitCode }
            return run
        }
    }

    private func uncertain(_ what: String, _ reason: String) {
        if phase != .applying { phase = .unconfirmed }
        failure = InstallFailure(reason: reason, uncertainty: what)
        notifyHidden(String(localized: "安装状态暂未确认，请查看安装任务了解详情。"))
    }

    /// A hidden install says how it ended, with a way back to its screen.
    private func notifyHidden(_ text: String) {
        guard !open else { return }
        app.showToast(text, action: String(localized: "查看安装任务"), duration: 8) { [weak self] in self?.show() }
    }

    // MARK: Cancelling

    /// 取消安装 (before the applying stage), or leave a check / failed screen for the spec.
    func cancel() async {
        if phase == .checking || phase == .failed || phase == .unknown {
            inspectTask?.cancel()
            inspectTask = nil
            backToSpec()
            return
        }
        guard [.starting, .running, .unconfirmed].contains(phase), let id = requestId else { return }
        if let cancellation, cancellation.active, !cancellation.waitingForStart { return }
        cancellation = (false, true)
        await sendCancellation(id)
    }

    private func sendCancellation(_ id: String) async {
        let wasAcknowledged = acknowledged
        cancellation = (false, true)
        phase = .cancelling
        failure = nil
        do {
            let answer = try await app.client.call("pluginManager/cancelInstall", ["requestId": .string(id)])
            guard requestId == id else { return }
            switch answer["status"].string {
            case "cancelled":
                backToSpec()
                app.showToast(String(localized: "已取消安装，插件未启用，下载的文件可能保留"))
                await app.plugins.load()
            case "too-late":
                acknowledged = true
                cancellation = nil
                phase = .applying
                notifyHidden(String(localized: "安装已进入收尾阶段，无法取消，可查看安装进度。"))
                // The install call still answers; only a lost reply needs asking for.
                await reconcile()
            default: // not-running
                if replyLost {
                    cancellation = nil
                    uncertain("result", "")
                    await reconcile()
                } else if !wasAcknowledged && phase != .applying {
                    if acknowledged {
                        await sendCancellation(id)
                    } else {
                        // The cancel overtook the install; retry once the Host acknowledges it.
                        cancellation = (true, true)
                        uncertain("acceptance", "")
                    }
                } else {
                    cancellation = nil
                    uncertain("cancellation", "")
                }
            }
        } catch {
            guard requestId == id else { return }
            if acknowledged { cancellation = nil } else { cancellation = (true, true) }
            uncertain(replyLost ? "result" : "cancellation", describeFailure(error))
        }
    }

    // MARK: Host events

    /// `plugin-manager/install-state`: the Host's phase for this request.
    private func progress(_ progress: JSON) {
        guard progress["requestId"].string == requestId, let id = requestId, pending else { return }
        acknowledged = true
        if phase == .applying { return }
        let next = progress["phase"].string
        if next == "installing", let cancellation, cancellation.active {
            if cancellation.waitingForStart { Task { await sendCancellation(id) } }
            return
        }
        if let attempt = progress["attempt"].object.nilIfEmpty {
            attempts = ((attempts?.registries ?? []) + [attempt["registry"]?.string], attempt["total"]?.int ?? attempts?.total ?? 1)
        }
        switch next {
        case "installing": phase = .running
        case "cancelling": phase = .cancelling
        case "applying": phase = .applying
        default: break
        }
    }

    /// `plugin-manager/install-log`: fold a chunk into its pnpm command. A final
    /// chunk may land after the answer; it still updates a run already listed.
    private func appendLog(_ chunk: JSON) {
        guard let jobId = chunk["jobId"].string else { return }
        let index = runs.firstIndex { $0.jobId == jobId }
        let mine = requestId != nil && chunk["requestId"].string == requestId
        guard mine || index != nil else { return }
        if mine, let requestId, [.starting, .cancelling, .unconfirmed].contains(phase) {
            progress(["requestId": .string(requestId), "phase": "installing"])
        }
        let text = chunk["text"].string ?? ""
        if let index {
            runs[index].output += text
            if let code = chunk["exitCode"].int { runs[index].exitCode = code; runs[index].settled = true }
        } else if pending {
            runs.append(InstallRun(
                jobId: jobId,
                command: chunk["argv"].array.compactMap(\.string).joined(separator: " "),
                cwd: chunk["cwd"].string ?? "",
                output: text,
                exitCode: chunk["exitCode"].int,
                settled: !chunk["exitCode"].isNull
            ))
        }
    }

    // MARK: After the run

    /// 允许这些脚本并重试: run the same spec again with the pending install scripts allowed.
    func approveBuildsAndRetry() async {
        guard phase == .failed, let subject, let pending = failure?.pendingBuilds, !pending.isEmpty else { return }
        await startInstall(subject, approved: pending)
    }

    /// The build scripts 跳过脚本并继续 turns off: those waiting for a decision, else those that ran and failed.
    var skippableBuilds: [String] {
        guard phase == .failed, let failure else { return [] }
        if !failure.pendingBuilds.isEmpty { return failure.pendingBuilds }
        return Self.failedBuilds(in: runs.map(\.output).joined(separator: "\n"))
    }

    /// The packages pnpm reports as `node_modules/<name> postinstall: Failed`.
    static func failedBuilds(in output: String) -> [String] {
        let line = /^\S*node_modules\/((?:@[^\/\s]+\/)?[^\/\s]+) (?:preinstall|install|postinstall|prepare): Failed\s*$/.anchorsMatchLineEndings()
        var names: [String] = []
        for match in output.matches(of: line) where !names.contains(String(match.1)) { names.append(String(match.1)) }
        return names
    }

    /// 跳过脚本并继续: install again with these scripts off. The plugin manager can only allow
    /// a script; `ios-host` reads a `!` as refusing it, which the profile then remembers.
    func skipBuildsAndRetry() async {
        let skipped = skippableBuilds
        guard let subject, !skipped.isEmpty else { return }
        await startInstall(subject, approved: skipped.map { "!\($0)" })
    }

    /// 重试 from the failed screen.
    func retry() {
        guard phase == .failed else { return }
        specAgain()
        run()
    }

    /// 更换安装源: back at the form with the registry choices open.
    func changeRegistry() {
        guard phase == .failed else { return }
        specAgain()
        registryOpen = true
    }

    /// The configured mainland mirror offered after GitHub could not be reached (or nil when it does not apply).
    var githubRecovery: String?? {
        guard confirmed == nil, phase == .failed, failure?.failedAt == "spec-host",
              failure?.kind == "network" || failure?.kind == "timeout" else { return nil }
        let host = subject?["host"].string?.lowercased().split(separator: ":").first.map(String.init) ?? ""
        guard host == "github.com" || host.hasSuffix(".github.com") else { return nil }
        guard let mirror = offeredRegistries.first(where: { Self.registryKey($0, resolved: resolved) == Self.npmmirror }) else { return nil }
        return .some(mirror)
    }

    var asksMirror: Bool { Self.registryKey(registry.registry, resolved: resolved) == Self.npmmirror }

    /// 改用国内镜像: clear the spec and remember the mirror (no automatic reinstall).
    func useGithubMirror() {
        guard case .some(let mirror) = githubRecovery else { return }
        let alreadyMirror = asksMirror
        specAgain()
        spec = ""
        mirrorRecovery = true
        if !alreadyMirror {
            registry = .offered(mirror)
            remember(registry)
        }
    }

    /// 立即启用: enable what the install added, close, and mark it in the list.
    func enableInstalled() async {
        guard phase == .done, !enabling else { return }
        enabling = true
        if let name = installed {
            do {
                let result = try await app.client.call("pluginManager/setBundleEnabled", ["name": .string(name), "enabled": true])
                try app.plugins.appliedEnable(result, name: name, packageName: app.plugins.package(name)?.title ?? name)
            } catch let failure as PluginManagerModel.ChangeFailure {
                app.showToast(PluginAction.enable.failed(failure.text), duration: 6)
            } catch {
                app.showToast(PluginAction.enable.failed(describeFailure(error)), duration: 6)
            }
            app.plugins.highlight = name
        }
        hide()
        reset()
        await app.plugins.load()
    }

    // MARK: Copy

    /// The refused spec's sentence under the field.
    var inputProblemText: String? {
        guard let inputError else { return nil }
        let reason = inputError["reason"].string ?? ""
        let asked = inputError["registries"].array
        switch inputError["problem"].string {
        case "invalid-spec": return String(localized: "无法识别这个包名或地址：\(reason)")
        case "already-installed": return String(localized: "该插件已安装。如需升级，请卸载后重新安装")
        case "shipped": return String(localized: "该插件随 DSH 提供，升级 DSH 即可获得新版本")
        case "not-found": return String(localized: "未找到相关插件")
        case "not-a-package": return String(localized: "这不是有效的插件包")
        case "not-a-bundle": return String(localized: "这个包没有声明组合包，无法作为插件安装：\(reason)")
        case "network":
            if asked.count > 1 { return String(localized: "所有安装源都无法连接（已尝试：\(registryList(asked.map(\.string)))），请检查网络或代理设置，或更换安装源") }
            return String(localized: "无法连接插件源，请检查网络后重试")
        default: return String(localized: "无法获取插件信息：\(reason)")
        }
    }

    /// The failed screen's one line: a pnpm failure by kind, a refusal by code, else the Host's words.
    var failureText: String {
        guard let failure else { return String(localized: "安装过程中出错，原因见安装详情") }
        if failure.code == "incompatible-version" { return managementText(code: failure.code, incompatible: failure.incompatible, installing: true) }
        if failure.kind == "build-blocked" && failure.pendingBuilds.isEmpty {
            return String(localized: "有依赖的安装脚本被 pnpm 拦下，请在 profile 的 pnpm-workspace.yaml 的 allowBuilds 中放行后重试")
        }
        if failure.failedAt == "spec-host", let host = subject?["host"].string {
            return String(localized: "无法连接 \(host)。GitHub 地址和 .tgz 直链不经过安装源，需要本机能直接访问它或配置代理；如果这个插件也发布到了 npm，请改填包名。")
        }
        let asked = attempts?.registries ?? []
        if failure.failedAt == "registry", failure.kind == "network" || failure.kind == "timeout", asked.count > 1 {
            return String(localized: "所有安装源都无法连接（已尝试：\(registryList(asked))）。请检查网络或代理设置，或更换安装源后重试。")
        }
        switch failure.kind {
        case "pnpm-missing": return String(localized: "没有找到 pnpm，无法安装")
        case "timeout": return String(localized: "安装超时")
        case "not-found": return String(localized: "未找到相关插件")
        case "no-matching-version": return String(localized: "没有匹配的版本")
        case "network": return String(localized: "网络连接失败")
        case "disk-full": return String(localized: "磁盘空间不足，安装已停止")
        case "permission": return String(localized: "没有写入权限，无法安装")
        case "build-blocked": return String(localized: "有依赖的安装脚本需要你允许后才能继续")
        case "integrity": return String(localized: "下载的安装包校验失败")
        case "unknown": return String(localized: "安装过程中出错，原因见安装详情")
        default: break
        }
        if let code = failure.code { return managementText(code: code, diagnostic: failure.reason) }
        return failure.reason.isEmpty ? String(localized: "安装过程中出错，原因见安装详情") : failure.reason
    }
}

extension Array {
    var nilIfEmpty: Self? { isEmpty ? nil : self }
}

extension Dictionary {
    var nilIfEmpty: Self? { isEmpty ? nil : self }
}
