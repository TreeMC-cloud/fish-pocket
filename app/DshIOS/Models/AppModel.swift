import Foundation
import Observation
import SwiftUI

struct Workspace: Identifiable, Hashable {
    let id: String
    var path: String
    var title: String
    var sessionIds: [String]

    init(_ json: JSON) {
        id = json["workspaceId"].string ?? ""
        path = json["path"].string ?? ""
        title = json["title"].string ?? ""
        sessionIds = json["sessionIds"].array.compactMap(\.string)
    }

    /// The first-use workspace keeps its fixed directory name as title; show it in the reader's language.
    var displayTitle: String { title == "default-workspace" ? String(localized: "默认工作区") : title }
}

struct SessionSummary: Identifiable, Hashable {
    let id: String
    var updatedAt: Date
    var running: Bool
    var blank: Bool
    var title: String?
    var cwd: String?
    var isSubagent: Bool
    /// A subagent's direct parent.
    var parentId: String?
    /// The parent's Agent is live (a continuable child can take messages through it).
    var agentAvailable: Bool
    var migrationRequired: Bool
    /// The cached projections the list carries (`subagent`, `agentPreset`…).
    var projections: JSON

    init(_ json: JSON) {
        id = json["sessionId"].string ?? ""
        updatedAt = Date(timeIntervalSince1970: (json["updatedAt"].double ?? 0) / 1000)
        running = json["running"].bool ?? false
        blank = json["blank"].bool ?? false
        title = json["projections"]["values"]["title"]["title"].string ?? json["projections"]["values"]["title"].string
        cwd = json["cwd"].string
        isSubagent = json["origin"].string == "subagent"
        parentId = json["parentSessionId"].string
        agentAvailable = json["agentAvailable"].bool ?? false
        migrationRequired = json["formatStatus"].string == "migration-required"
        projections = json["projections"]["values"]
    }

    var displayTitle: String { title?.isEmpty == false ? title! : String(localized: "新会话") }
}

/// A shell toast: short text, an optional tone icon and a button on the right (「已归档」「撤销」).
struct Toast: Identifiable, Equatable {
    enum Tone { case plain, success, warning }
    struct Action {
        let label: String
        let perform: () -> Void
    }

    let id = UUID()
    let text: String
    var tone: Tone = .plain
    var actions: [Action] = []
    let duration: Double

    static func == (lhs: Toast, rhs: Toast) -> Bool { lhs.id == rhs.id }
}

/// `workspace/session-active`: archiving waits for the user to stop the listed work.
struct ArchiveRequest: Identifiable {
    let sessionId: String
    let title: String
    /// `[{kind, items?:[{id, label?}]}]` as the Host reported it.
    let activity: [JSON]
    var id: String { sessionId }
}

/// Start a conversation in the main view: after adding a workspace, 创建你的插件…
struct NewSessionRequest: Equatable {
    let token = UUID()
    var workspaceId: String?
    var agentPreset: String?
    /// Placed in the composer, not sent.
    var draft: String?
}

/// A rename dialog for a session (the system alert) or a workspace (a sheet).
struct RenameRequest: Identifiable {
    enum Target: Hashable { case session(String), workspace(String) }
    let target: Target
    let initial: String
    var id: Target { target }
}

/// Everything above one conversation: the engine connection, workspaces and
/// their sessions. Views read it from the environment.
@MainActor
@Observable
final class AppModel {
    let client: EngineClient
    let mux: StreamMux
    let account: AccountModel
    let cordis = CordisModel()

    private(set) var workspaces: [Workspace] = []
    private(set) var pinned: [String] = []
    private(set) var archived: Set<String> = []
    private(set) var sessions: [String: SessionSummary] = [:]
    /// Live per-session projections from `session/control` (title, todos, inbox…).
    private(set) var control: [String: [String: JSON]] = [:]
    /// Tool calls waiting for permission, by session (agent) id.
    private(set) var approvals: [String: [PendingApproval]] = [:]
    /// `user-questions/request` waterfalls this client holds, by session id: while one
    /// is open the answer goes back through `$events` (`userQuestions/answer` only takes
    /// a question that has already continued; plan review only ever arrives here).
    private(set) var questionRequests: [String: [QuestionRequest]] = [:]
    var lastError: String?
    /// The single shell toast (S-128): a newer one replaces the current one.
    private(set) var toast: Toast?
    /// Raised each time an ask for a Star or a share is due.
    private(set) var supportMoment = 0
    /// Shell dialogs the root view presents.
    var archiveRequest: ArchiveRequest?
    var renameRequest: RenameRequest?
    var newSessionRequest: NewSessionRequest?
    /// Height of the composer area on screen; the toast sits just above it.
    var composerHeight: CGFloat = 0
    /// Composer text waiting for a session to show it (appended to any draft there).
    var pendingDrafts: [String: String] = [:]
    /// A session to open in the main view (set through `open(session:)`; the root view consumes it).
    var openRequest: (id: String, token: UUID)?
    /// A credential step to open (set through `requestCredentials`; the root view consumes it).
    var credentialRequest: (step: CredentialStep, token: UUID)?
    /// The session in the main view, kept by the root view (unread completions skip it).
    var currentSession: String? { didSet { if let currentSession { completionUnread.remove(currentSession) } } }
    /// Sessions whose turn finished while they were not open (the web's completion reminder).
    private(set) var completionUnread: Set<String> = []
    /// Projections read on demand, for sessions `session/control` does not carry (nested subagents).
    private(set) var projectionCache: [String: JSON] = [:]
    /// `schedule/catalog`: every Session's tasks, re-read on `schedule/changed` and each connection.
    private(set) var scheduleCatalog: [JSON] = []
    /// How many tasks the automation page lists, ended ones included; nil before the first read.
    private(set) var scheduleCount: Int?
    /// `$events` is up (a `ready` arrived and the stream has not ended).
    private(set) var connected = false
    /// Bumped on every `ready`: a new connection generation, after which every
    /// view re-reads its baseline (emits missed while offline are not replayed).
    private(set) var generation = 0
    /// Count of `emit`s seen per event name; read through `revision(_:)`.
    private(set) var eventCounts: [String: Int] = [:]

    @ObservationIgnored private var workspaceTask: Task<Void, Never>?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var eventsTask: Task<Void, Never>?
    @ObservationIgnored private var controlTask: Task<Void, Never>?
    @ObservationIgnored private var scheduleTask: Task<Void, Never>?
    @ObservationIgnored private var eventsClientId: String?
    /// `api-session/status` from `$events`: the live running flag, which wins over
    /// `session/list` (that one can read idle while a tool call runs).
    @ObservationIgnored private var runningStatus: [String: Bool] = [:]
    @ObservationIgnored private var listeners: [UUID: (String, [JSON]) -> Void] = [:]
    /// Subagent children by parent, rebuilt with the list; rows ask per redraw.
    @ObservationIgnored private(set) var childSessions: [String: [String]] = [:]

    init(launchURL: URL) {
        client = EngineClient(launchURL: launchURL)
        mux = StreamMux(client: client)
        account = AccountModel(client: client, mux: mux)
        cordis.attach(self)
    }

    func connect() async {
        do {
            try await client.authenticate()
            _ = try? await client.call("workspace/initializeDefault")
            await refreshSessions()
            await reloadTheme()
            followWorkspaces()
            followControl()
            followRemoteEvents()
            followScheduleCatalog()
            account.follow()
            BackgroundKeeper.shared.attach { [weak self] in await self?.refreshSessions() }
            LiveActivityController.shared.attach(self)
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// Sessions of one workspace (nil: those in no workspace), as the web sidebar
    /// derives them: subagents and blank ones never, archived only
    /// when asked; pinned first, then most recently updated.
    func sessions(in workspace: Workspace?, includeArchived: Bool = false) -> [SessionSummary] {
        let members: [SessionSummary]
        if let workspace {
            members = workspace.sessionIds.compactMap { sessions[$0] }
        } else {
            let grouped = Set(workspaces.flatMap(\.sessionIds))
            members = sessions.values.filter { !grouped.contains($0.id) }
        }
        return members
            .filter { includeArchived || !archived.contains($0.id) }
            .filter { !$0.isSubagent && !$0.blank }
            .sorted { lhs, rhs in
                let lp = pinned.firstIndex(of: lhs.id), rp = pinned.firstIndex(of: rhs.id)
                if (lp != nil) != (rp != nil) { return lp != nil }
                if let lp, let rp { return lp < rp }
                return lhs.updatedAt > rhs.updatedAt
            }
    }

    func title(of id: String) -> String {
        if let title = control[id]?["title"]?.string, !title.isEmpty { return title }
        return sessions[id]?.displayTitle ?? String(localized: "新会话")
    }

    func isPinned(_ id: String) -> Bool { pinned.contains(id) }

    /// Waiting on the user: a tool approval or an open question.
    func isWaiting(_ id: String) -> Bool {
        !(approvals[id] ?? []).isEmpty || !(questionRequests[id] ?? []).isEmpty || control[id]?["userQuestions"]?["active"].array.isEmpty == false
    }

    /// Changes whenever any of `events` is emitted or the connection is re-established:
    /// `.task(id: app.revision("schedule/changed")) { reload() }` re-reads on both.
    func revision(_ events: String...) -> Int {
        events.reduce(generation * 100_000) { $0 + (eventCounts[$1] ?? 0) }
    }

    /// Every `emit` from `$events`, for views that need the arguments (install logs…).
    /// Keep the token and pass it to `removeListener` when done.
    func addListener(_ handler: @escaping (String, [JSON]) -> Void) -> UUID {
        let id = UUID()
        listeners[id] = handler
        return id
    }

    func removeListener(_ id: UUID) { listeners[id] = nil }

    /// Show a toast; `action` adds a button (Undo…) that runs and dismisses it.
    func showToast(_ text: String, action: String? = nil, duration: Double? = nil, perform: (() -> Void)? = nil) {
        let actions = action.map { [Toast.Action(label: $0, perform: perform ?? {})] } ?? []
        showToast(text, tone: .plain, actions: actions, duration: duration)
    }

    /// 4 s, 6 s with a button; a button always gets at least 5 s to be reached.
    func showToast(_ text: String, tone: Toast.Tone, actions: [Toast.Action] = [], duration: Double? = nil) {
        let hold = duration ?? (actions.isEmpty ? 4 : 6)
        toast = Toast(text: text, tone: tone, actions: actions, duration: actions.isEmpty ? hold : max(hold, 5))
    }

    func dismissToast(_ id: UUID) { if toast?.id == id { toast = nil } }

    /// A turn finished well; `MainView` decides whether this is the moment to ask (`SupportPrompt`).
    func noteCompletedTurn() {
        if SupportPrompt.noteCompletedTurn() { supportMoment += 1 }
    }

    func workspace(of sessionId: String) -> Workspace? { workspaces.first { $0.sessionIds.contains(sessionId) } }
    func isArchived(_ id: String) -> Bool { archived.contains(id) }

    func reloadTheme() async {
        guard let value = try? await client.call("settings/describe") else { return }
        let theme = value["namespaces"].array.first { $0["ns"].string == "ui-theme" }
        UserDefaults.standard.set(theme?["value"]["preference"].string ?? "system", forKey: ThemePreference.key)
    }

    func refreshSessions() async {
        do {
            let value = try await client.call("session/list", ["_request": [:]])
            var next: [String: SessionSummary] = [:]
            for item in value["items"].array {
                var summary = SessionSummary(item)
                if let running = runningStatus[summary.id] { summary.running = running }
                if let old = sessions[summary.id] { observeRunning(summary.id, from: old.running, to: summary.running) }
                next[summary.id] = summary
            }
            completionUnread.formIntersection(next.keys)
            sessions = next
            childSessions = Dictionary(grouping: next.values.filter { $0.isSubagent && $0.parentId != nil }, by: { $0.parentId ?? "" })
                .mapValues { $0.sorted { $0.updatedAt < $1.updatedAt }.map(\.id) }
            reportRunning()
        } catch is CancellationError {
            // Superseded by a newer refresh.
        } catch let error as URLError where error.code == .cancelled {
        } catch {
            showToast(error.localizedDescription, tone: .warning)
        }
        await loadMissingTitles()
    }

    /// Read one session's projections; no Agent is resumed.
    @discardableResult
    func refreshProjections(of id: String) async -> Bool {
        guard let value = try? await client.call("session/projections", ["request": ["sessionId": .string(id)]]) else { return false }
        projectionCache[id] = value["values"]
        return true
    }

    /// A turn that ends while its session is not open leaves a completion reminder (`ui-session`).
    private func observeRunning(_ id: String, from old: Bool, to running: Bool) {
        if running { completionUnread.remove(id) }
        else if old && id != currentSession { completionUnread.insert(id) }
    }

    /// One shared `schedule/catalog` read for the drawer and settings counts, the row clock
    /// marks and the header reminder button; re-read on `schedule/changed` and on every connection.
    private func followScheduleCatalog() {
        scheduleTask?.cancel()
        scheduleTask = Task {
            var seen = -1
            while !Task.isCancelled {
                let revision = revision("schedule/changed")
                if revision != seen {
                    if let value = try? await client.call("schedule/catalog") {
                        seen = revision
                        scheduleCatalog = value.array
                        scheduleCount = value.array.count
                    } else {
                        try? await Task.sleep(for: .seconds(5))
                    }
                }
                try? await Task.sleep(for: .milliseconds(500))
            }
        }
    }

    private func reportRunning() {
        let running = sessions.values.filter(\.running)
        BackgroundKeeper.shared.update(running: running.map { $0.isSubagent ? String(localized: "子智能体") : title(of: $0.id) })
    }

    /// Rows without cached projections carry no title; read them once (no agent is resumed).
    private func loadMissingTitles() async {
        let missing = sessions.values.filter { $0.title == nil && !$0.blank && !$0.isSubagent && control[$0.id]?["title"] == nil }.map(\.id)
        guard !missing.isEmpty else { return }
        let client = self.client
        let titles = await withTaskGroup(of: (String, String?).self) { group in
            for id in missing {
                group.addTask {
                    let value = try? await client.call("session/projections", ["request": ["sessionId": .string(id)]])
                    return (id, value?["values"]["title"].string)
                }
            }
            var result: [String: String] = [:]
            for await (id, title) in group { if let title { result[id] = title } }
            return result
        }
        for (id, title) in titles { sessions[id]?.title = title }
    }

    /// Session rows change with every turn; coalesce refreshes requested in bursts.
    func scheduleRefresh() {
        refreshTask?.cancel()
        refreshTask = Task {
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            await refreshSessions()
        }
    }

    private func followWorkspaces() {
        workspaceTask?.cancel()
        workspaceTask = Task {
            while !Task.isCancelled {
                do {
                    for try await frame in mux.open("workspace/follow", [:]) {
                        apply(frame)
                    }
                } catch {
                    if Task.isCancelled { return }
                }
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    private func apply(_ frame: JSON) {
        switch frame["type"].string {
        case "baseline", "replace":
            workspaces = frame["value"]["items"].array.map(Workspace.init)
            archived = Set(frame["value"]["archivedSessionIds"].array.compactMap(\.string))
            pinned = frame["value"]["pinnedSessionIds"].array.compactMap(\.string)
        case "upsert":
            let workspace = Workspace(frame["workspace"])
            if let index = workspaces.firstIndex(where: { $0.id == workspace.id }) { workspaces[index] = workspace }
            else { workspaces.append(workspace) }
        case "remove":
            workspaces.removeAll { $0.id == frame["workspaceId"].string }
        case "order":
            let order = frame["workspaceIds"].array.compactMap(\.string)
            workspaces.sort { (order.firstIndex(of: $0.id) ?? .max) < (order.firstIndex(of: $1.id) ?? .max) }
        case "archived":
            archived = Set(frame["archivedSessionIds"].array.compactMap(\.string))
        case "pinned":
            pinned = frame["pinnedSessionIds"].array.compactMap(\.string)
        default:
            break
        }
        scheduleRefresh()
    }

    /// Per-session projections for every visible session: a baseline, then single-key replacements.
    private func followControl() {
        controlTask?.cancel()
        controlTask = Task {
            while !Task.isCancelled {
                do {
                    for try await frame in mux.open("session/control", [:]) {
                        switch frame["type"].string {
                        case "baseline":
                            var next: [String: [String: JSON]] = [:]
                            for (id, projection) in frame["value"]["projections"].object { next[id] = projection["values"].object }
                            control = next
                        case "projection":
                            if let id = frame["sessionId"].string, let key = frame["key"].string {
                                control[id, default: [:]][key] = frame["value"]
                            }
                        default:
                            break
                        }
                    }
                } catch {
                    if Task.isCancelled { return }
                }
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    // MARK: Host → client interactions

    /// The engine asks connected clients to answer interactions (tool approval…)
    /// over `$events`; an interaction this client does not handle is passed on.
    private func followRemoteEvents() {
        eventsTask?.cancel()
        eventsTask = Task {
            var attempt = 0
            while !Task.isCancelled {
                do {
                    for try await frame in mux.open("$events", [:]) {
                        if frame["type"].string == "ready" { attempt = 0 }
                        await handleRemoteEvent(frame)
                    }
                } catch {
                    if Task.isCancelled { return }
                }
                eventsClientId = nil
                connected = false
                approvals = [:]
                questionRequests = [:]
                runningStatus = [:]
                // The web client's backoff: caps 0.5, 1, 2, 4, 8, 10 s, 50–100 % jitter.
                let cap = min(10, 0.5 * pow(2, Double(attempt)))
                attempt += 1
                try? await Task.sleep(for: .seconds(cap * Double.random(in: 0.5...1)))
            }
        }
    }

    private func handleRemoteEvent(_ frame: JSON) async {
        switch frame["type"].string {
        case "ready":
            let reconnect = eventsClientId == nil && generation > 0
            eventsClientId = frame["clientId"].string
            connected = true
            generation += 1
            if reconnect { await refreshSessions() }
            await cordis.refresh(app: self)
        case "waterfall":
            guard let eventId = frame["eventId"].string else { return }
            let agentId = frame["agentId"].string ?? ""
            if frame["event"].string == "approval/request" {
                let request = frame["request"]
                let pending = PendingApproval(
                    id: eventId,
                    toolName: request["toolName"].string ?? "tool",
                    callId: request["callId"].string,
                    reason: localized(request["displayReason"]) ?? request["reason"].string
                )
                approvals[agentId, default: []].append(pending)
            } else if frame["event"].string == "user-questions/request" {
                questionRequests[agentId, default: []].append(QuestionRequest(eventId: eventId, request: frame["request"]))
            } else {
                await respond(eventId, outcome: ["kind": "next"])
            }
        case "emit" where frame["event"].string == "api-session/status":
            eventCounts["api-session/status", default: 0] += 1
            let args = frame["args"].array
            guard let id = args.first?.string, let running = args.dropFirst().first?.bool else { return }
            runningStatus[id] = running
            if let old = sessions[id]?.running, old != running {
                observeRunning(id, from: old, to: running)
                sessions[id]?.running = running
                reportRunning()
            }
            if sessions[id] == nil { scheduleRefresh() }
        case "emit" where frame["event"].string?.hasPrefix("deepseek-account/") == true:
            account.handle(event: frame["event"].string ?? "")
        case "emit":
            let event = frame["event"].string ?? ""
            eventCounts[event, default: 0] += 1
            let args = frame["args"].array
            for listener in listeners.values { listener(event, args) }
        case "cancel":
            let eventId = frame["eventId"].string
            for key in approvals.keys { approvals[key]?.removeAll { $0.id == eventId } }
            for key in questionRequests.keys { questionRequests[key]?.removeAll { $0.eventId == eventId } }
        default:
            break
        }
    }

    /// Answer a tool approval: `allowed-once` or `rejected`.
    func answerApproval(_ approval: PendingApproval, session: String, allow: Bool) async {
        approvals[session]?.removeAll { $0.id == approval.id }
        await respond(approval.id, outcome: ["kind": "result", "value": .string(allow ? "allowed-once" : "rejected")])
    }

    /// Settle a held question: `{kind:"result", value}`, `{kind:"rejected", error}` or `{kind:"next"}`.
    /// False when it did not arrive: the request stays held, so the answer can be sent again.
    @discardableResult
    func settleQuestion(_ eventId: String, session: String, outcome: JSON) async -> Bool {
        guard await respond(eventId, outcome: outcome, reportFailure: false) else { return false }
        questionRequests[session]?.removeAll { $0.eventId == eventId }
        return true
    }

    @discardableResult
    private func respond(_ eventId: String, outcome: JSON, reportFailure: Bool = true) async -> Bool {
        guard let clientId = eventsClientId else { return false }
        do {
            try await client.call("$events/result", ["clientId": .string(clientId), "eventId": .string(eventId), "outcome": outcome])
            return true
        } catch {
            if reportFailure { showToast(error.localizedDescription, tone: .warning) }
            return false
        }
    }

    // MARK: Session and workspace actions

    /// A new conversation in `workspace`; a blank session already there is reused
    /// (the engine hands it back while it is still blank), so opening "new" twice adds nothing.
    /// `agentPreset` binds the new session to a preset; only a blank session already on it is reused.
    func createSession(in workspace: Workspace, agentPreset: String? = nil) async throws -> String {
        var request: [String: JSON] = ["workspaceId": .string(workspace.id)]
        let reusable = workspace.sessionIds.first { id in
            guard let summary = sessions[id], summary.blank, !archived.contains(id) else { return false }
            return agentPreset == nil || presetId(of: id) == agentPreset
        }
        if let reusable { request["sessionId"] = .string(reusable) }
        if let agentPreset { request["agentPreset"] = .string(agentPreset) }
        let value = try await client.call("session/create", ["request": .object(request)])
        await refreshSessions()
        return value["sessionId"].string ?? ""
    }

    /// A `{en, zh?…}` display string in the reader's language (plain strings pass through).
    func localized(_ value: JSON) -> String? {
        if let string = value.string { return string }
        let object = value.object
        guard !object.isEmpty else { return nil }
        let preferred = Locale.preferredLanguages.first?.lowercased() ?? "zh"
        if preferred.hasPrefix("zh"), let zh = object.first(where: { $0.key.lowercased().hasPrefix("zh") })?.value.string { return zh }
        return object[String(preferred.prefix(2))]?.string ?? object["en"]?.string ?? object[""]?.string ?? object.values.first?.string
    }

    /// Run a small action; a failure is a warning toast with the engine's message
    /// (`lastError`, the alert, is for failures that leave the app unusable).
    @discardableResult
    func perform(_ action: @escaping () async throws -> JSON) async -> Bool {
        do { _ = try await action(); return true } catch {
            showToast(error.localizedDescription, tone: .warning)
            return false
        }
    }
}
