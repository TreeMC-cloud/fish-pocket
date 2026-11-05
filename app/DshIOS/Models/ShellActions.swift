import Foundation

/// Session and workspace actions the shell offers (drawer rows, the top bar,
/// toasts), with the official client's follow-ups: fork titles, the archive
/// toast and its stop-and-archive confirmation, the toasts for small failures
/// (`dsh-client-ui-workspace`).
extension AppModel {
    // MARK: Reading

    /// The session's durable title, if it has one (no 「新会话」 fallback).
    func durableTitle(of id: String) -> String? {
        if let title = control[id]?["title"]?.string, !title.isEmpty { return title }
        if let title = sessions[id]?.title, !title.isEmpty { return title }
        return nil
    }

    /// The Agent preset the session is bound to (projection `agentPreset`).
    func presetId(of id: String) -> String? {
        let value = control[id]?["agentPreset"] ?? sessions[id]?.projections["agentPreset"] ?? .null
        return value.string ?? value["id"].string ?? value["agentPreset"].string
    }

    /// The compact waiting label of a row: 待审批 / 计划待审 / 待回答.
    func pendingLabel(of id: String) -> String? {
        if !(approvals[id] ?? []).isEmpty { return String(localized: "待审批") }
        let active = control[id]?["userQuestions"]?["active"].array ?? []
        guard !active.isEmpty else { return nil }
        let planReview = active.contains { call in call["questions"].array.contains { $0["intent"]["kind"].string == "plan-review" } }
        return planReview ? String(localized: "计划待审") : String(localized: "待回答")
    }

    /// Active scheduled tasks created by this session (`schedule/catalog`, `status == active`).
    func activeSchedules(of id: String) -> [JSON] {
        scheduleCatalog.filter { $0["target"]["sessionId"].string == id && $0["status"].string == "active" }
    }

    // MARK: Subagents

    /// Direct children from the parent's `subagentCatalog` projection
    /// (`[{id, createdAt, mode, label?}]`), else from the session list.
    func subagentEntries(of parent: String) -> [JSON] {
        for source in [control[parent]?["subagentCatalog"], projectionCache[parent]?["subagentCatalog"], sessions[parent]?.projections["subagentCatalog"]] {
            if let entries = source?.array, !entries.isEmpty { return entries }
        }
        return (childSessions[parent] ?? []).compactMap { sessions[$0] }.map { child in
            ["id": .string(child.id), "mode": child.projections["subagent"]["mode"].isNull ? "unknown" : child.projections["subagent"]["mode"],
             "label": child.projections["subagent"]["label"]]
        }
    }

    /// Children running now (the row's 「N 个子智能体运行中」).
    func runningSubagentCount(of parent: String) -> Int {
        subagentEntries(of: parent).filter { sessions[$0["id"].string ?? ""]?.running == true }.count
    }

    /// A subagent's own label (its catalog entry, else its identity projection).
    func subagentLabel(of id: String) -> String? {
        if let parent = sessions[id]?.parentId,
           let label = subagentEntries(of: parent).first(where: { $0["id"].string == id })?["label"].string { return label }
        return sessions[id]?.projections["subagent"]["label"].string
    }

    /// The parent-scoped address a child session is opened with: the Host refuses
    /// a plain session address for a subagent. Nil for a root session.
    func subagentAddress(for id: String) -> JSON? {
        guard let summary = sessions[id], summary.isSubagent, let parent = summary.parentId else { return nil }
        let entry = subagentEntries(of: parent).first { $0["id"].string == id }
        let mode = entry?["mode"].string ?? summary.projections["subagent"]["mode"].string ?? "unknown"
        return ["kind": "subagent", "parentSessionId": .string(parent), "childSessionId": .string(id),
                "mode": .string(["one-shot", "continuable"].contains(mode) ? mode : "unknown")]
    }

    /// Root first, the session itself last (the breadcrumb `a / b / c`).
    func lineage(of id: String) -> [String] {
        var chain = [id]
        var cursor = id
        while let summary = sessions[cursor], summary.isSubagent, let parent = summary.parentId, !chain.contains(parent) {
            chain.insert(parent, at: 0)
            cursor = parent
        }
        return chain
    }

    /// A breadcrumb title: a subagent by its label, a root by its title.
    func lineageTitle(of id: String) -> String {
        if sessions[id]?.isSubagent == true { return subagentLabel(of: id) ?? durableTitle(of: id) ?? id }
        return title(of: id)
    }

    // MARK: Navigation

    /// Open a session in the main view; an archived one cannot be viewed (as on the web).
    func open(session id: String) {
        if isArchived(id) {
            showToast(String(localized: "取消归档后才能查看"), tone: .warning, actions: [
                Toast.Action(label: String(localized: "取消归档")) { [weak self] in Task { await self?.unarchive(id) } },
            ])
            return
        }
        openRequest = (id, UUID())
    }

    // MARK: Session actions

    /// `session/rename`; throws so the dialog can show the engine's message.
    func rename(session id: String, to title: String) async throws {
        try await client.call("session/rename", ["request": ["sessionId": .string(id), "title": .string(title)]])
        await refreshSessions()
    }

    func renameWorkspace(_ id: String, to title: String) async throws {
        try await client.call("workspace/rename", ["request": ["workspaceId": .string(id), "title": .string(title)]])
    }

    func setPinned(_ id: String, _ pin: Bool) async {
        do {
            try await client.call(pin ? "workspace/pinSession" : "workspace/unpinSession", ["request": ["sessionId": .string(id)]])
        } catch {
            showToast(pin ? String(localized: "置顶失败，请稍后重试") : String(localized: "取消置顶失败，请稍后重试"), tone: .warning)
        }
    }

    /// Archive; success offers 撤销.
    /// A session with work in progress asks first (`workspace/session-active`).
    func archive(_ id: String) async {
        do {
            try await client.call("workspace/archiveSession", ["request": ["sessionId": .string(id)]])
            Haptics.tap()
            announceArchived(id, stopped: false)
        } catch let error as EngineError where error.code == "workspace/session-active" {
            archiveRequest = ArchiveRequest(sessionId: id, title: title(of: id), activity: error.detail["details"]["activity"].array)
        } catch {
            showToast(error.localizedDescription, tone: .warning)
        }
    }

    /// The confirmed path: stop the listed work, then archive. Throws for the dialog.
    func stopAndArchive(_ id: String) async throws {
        try await client.call("workspace/archiveSession", ["request": ["sessionId": .string(id), "stopActivity": true]])
        announceArchived(id, stopped: true)
    }

    func unarchive(_ id: String) async {
        do {
            try await client.call("workspace/unarchiveSession", ["request": ["sessionId": .string(id)]])
        } catch {
            showToast(error.localizedDescription, tone: .warning)
        }
    }

    private func announceArchived(_ id: String, stopped: Bool) {
        showToast(stopped ? String(localized: "已停止并归档") : String(localized: "已归档"), tone: .success, actions: [
            Toast.Action(label: String(localized: "撤销")) { [weak self] in Task { await self?.unarchive(id) } },
        ])
    }

    func copySessionId(_ id: String) {
        copyToPasteboard(id)
        showToast(String(localized: "已复制会话 ID"), tone: .success)
    }

    enum ForkOrigin {
        /// A row's menu: the child appears beside its source; the current session stays.
        case menu
        /// 「从这里分叉」 under a reply: the child opens.
        case turn
        /// The open session's own menu (the web's shortcut): stays, with a toast to open it.
        case current
    }

    /// `session/fork`, then the child's title `X` → `X (1)` (`X(2)` → `X(3)`, `X（2）` → `X（3）`);
    /// `atSeq` cuts at that event (inclusive), nil at the latest completed turn.
    @discardableResult
    func fork(session id: String, atSeq: Int? = nil, from origin: ForkOrigin) async -> String? {
        let sourceTitle = durableTitle(of: id)
        var request: [String: JSON] = ["sessionId": .string(id)]
        if let atSeq { request["atSeq"] = .number(Double(atSeq)) }
        if origin == .menu { request["allowMigration"] = false }
        let child: String
        do {
            let value = try await client.call("session/fork", ["request": .object(request)])
            guard let id = value["sessionId"].string else { return nil }
            child = id
        } catch let error as EngineError where error.code == "session/migration-required" {
            showToast(String(localized: "需先迁移原会话"), tone: .warning, actions: [
                Toast.Action(label: String(localized: "打开")) { [weak self] in self?.open(session: id) },
            ])
            return nil
        } catch let error as EngineError where error.code == "session/fork-unavailable" {
            showToast(String(localized: "还没有可分叉的轮次"))
            return nil
        } catch {
            showToast(String(localized: "分叉失败，请重试"), tone: .warning)
            return nil
        }
        if let sourceTitle {
            _ = try? await client.call("session/rename", ["request": ["sessionId": .string(child), "title": .string(Self.increasedForkTitle(sourceTitle))]])
        }
        await refreshSessions()
        switch origin {
        case .menu: break
        case .turn: open(session: child)
        case .current:
            // On a phone the list with the new row is out of sight: say where it went.
            showToast(String(localized: "已分叉"), tone: .success, actions: [
                Toast.Action(label: String(localized: "打开")) { [weak self] in self?.open(session: child) },
            ])
        }
        return child
    }

    /// `increasedForkTitle` of `dsh-api-session-controller`.
    nonisolated static func increasedForkTitle(_ title: String) -> String {
        for (open, close) in [("(", ")"), ("（", "）")] {
            guard title.hasSuffix(close), let start = title.range(of: open, options: .backwards) else { continue }
            let digits = title[start.upperBound..<title.index(title.endIndex, offsetBy: -close.count)]
            if !digits.isEmpty, digits.allSatisfy(\.isASCII), digits.allSatisfy(\.isNumber), let number = Decimal(string: String(digits)) {
                return title[..<start.lowerBound] + open + "\(number + 1)" + close
            }
        }
        return "\(title) (1)"
    }
}
