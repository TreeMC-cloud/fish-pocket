import Foundation
import Observation
import UIKit
import UniformTypeIdentifiers

/// A message sent but not yet seen in the session (C-20): it shows as 「发送中…」
/// until the durable message, or the queue row, carrying its request id arrives.
struct PendingSubmission: Identifiable, Equatable {
    enum Placement { case transcript, queued, steering }
    /// The request id (`source.rpcId` on the durable message).
    let id: String
    var text: String
    var attachments: [String]
    /// Where the web shows the echo: idle → the transcript, busy → the queue or a steering bubble.
    var placement: Placement
}

/// One attachment waiting in the composer (C-104…C-106). Images ride the prompt
/// as base64; other files upload as soon as they are added and send their receipt.
struct DraftAttachment: Identifiable {
    enum Kind {
        case image(mediaType: String, data: String, preview: UIImage)
        case file(url: URL)
    }
    enum Upload: Equatable {
        case uploading(loaded: Int64, total: Int64?)
        case ready(receiptId: String)
        case failed(String)
    }
    let id = UUID()
    var name: String
    var bytes: Int
    var kind: Kind
    var upload: Upload?

    var isImage: Bool { if case .image = kind { true } else { false } }
}

/// One `/` command of the session's catalog (`commands/list`).
struct CommandDescriptor: Identifiable, Hashable {
    var name: String
    var description: String
    var definitionId: String?
    /// `input.hint`: the command takes arguments (a leading claim), shown while they are empty.
    var hint: String?
    var acceptsAttachments: Bool
    var id: String { name }

    /// First-party commands by definition, whose face and localized alias the client owns.
    static let builtins: [String: String] = [
        "goal": "@deepseek-ai/dsh-command-goal",
        "plan": "@deepseek-ai/dsh-plan-mode",
        "compact": "@deepseek-ai/dsh-command-compact",
        "permission": "@deepseek-ai/dsh-permission-presets",
        "export": "@deepseek-ai/dsh-session-log-export",
    ]
    /// `/目标`, `/计划`…: both locales' tokens reach the built-in definition.
    static let aliases: [String: String] = [
        "目标": "goal", "计划": "plan", "压缩": "compact", "权限": "permission", "导出": "export",
        "goal": "goal", "plan": "plan", "compact": "compact", "permission": "permission", "export": "export",
    ]

    var builtinName: String? { Self.builtins.first { $0.value == definitionId }?.key }
}

/// Image limits from the `imageLimits` projection, with the web's defaults.
struct ImageLimits {
    var mediaTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"]
    var maxImagesPerMessage = 20
    var maxImageBytes = 20 * 1024 * 1024
    var maxMessageImageBytes = 200 * 1024 * 1024
    var maxImagePixels = 64_000_000
    var maxImageDimension = 8192

    init(_ json: JSON) {
        if !json["mediaTypes"].array.isEmpty { mediaTypes = json["mediaTypes"].array.compactMap(\.string) }
        maxImagesPerMessage = json["maxImagesPerMessage"].int ?? maxImagesPerMessage
        maxImageBytes = json["maxImageBytes"].int ?? maxImageBytes
        maxMessageImageBytes = json["maxMessageImageBytes"].int ?? maxMessageImageBytes
        maxImagePixels = json["maxImagePixels"].int ?? maxImagePixels
        maxImageDimension = json["maxImageDimension"].int ?? maxImageDimension
    }

    /// `10MB`, `2.5MB` as the web writes sizes in its limit copy.
    static func sizeText(_ bytes: Int) -> String {
        let mb = Double(bytes) / 1_048_576
        return mb.rounded() == mb ? "\(Int(mb))MB" : String(format: "%.1fMB", mb)
    }
}

/// A row of the queue dock: one `inbox['next-turn']` message.
struct QueueRow: Identifiable, Equatable {
    let id: String
    /// Text-only rows can be edited; nil when the row carries attachments.
    var editableText: String?
    var preview: String
    var attachments: [String]
}

/// The session's goal (`goal` projection, C-121).
struct GoalInfo: Equatable {
    var id: String
    var revision: Int
    var objective: String
    var phase: String
    var blockedReason: String?
}

/// The composer of one conversation: the draft (persisted per session, C-92),
/// attachments and their uploads, the optimistic send with local echoes and
/// failure restore (C-20, C-91), commands, the queue and the goal actions.
@MainActor
@Observable
final class ComposerModel {
    /// Weak: sends and uploads outlive the conversation that started them (the session owns this model).
    @ObservationIgnored private weak var session: SessionModel?
    @ObservationIgnored let sessionId: String
    @ObservationIgnored let app: AppModel

    var text: String { didSet { if text != oldValue { persistDraft() } } }
    private(set) var attachments: [DraftAttachment] = []
    private(set) var pending: [PendingSubmission] = []
    /// A command line being executed: sending waits for it (C-87).
    private(set) var executing = false
    /// The live goal activation (`goals/get`): whether the goal will continue on its own.
    private(set) var goalActivation: (id: String, revision: Int, armed: Bool)?
    /// `/plan` or `/plan off` on its way.
    private(set) var planSwitching = false
    /// `/compact` on its way.
    private(set) var compacting = false
    /// A queued message loaded into the input to edit, and the draft it set aside.
    private(set) var editingQueue: (id: String, setAside: String)?
    private(set) var savingQueueEdit = false
    /// Bumped to ask the input for the keyboard (from outside it, or after a sheet).
    private(set) var focusRequest = 0
    /// Cleared here; hidden until the projection catches up.
    private var clearedGoalId: String?

    @ObservationIgnored private var failedDrafts: [(seq: Int, text: String)] = []
    @ObservationIgnored private var restoredText: String?
    @ObservationIgnored private var sendSeq = 0
    @ObservationIgnored private var uploadTasks: [UUID: Task<Void, Never>] = [:]
    @ObservationIgnored private var uploadQueue: [UUID] = []
    @ObservationIgnored private var activeUploads = 0
    /// `ui-conversation.maxConcurrentFileUploads` (C-150): the web's default, a client config the phone does not receive.
    static let maxConcurrentFileUploads = 2

    init(session: SessionModel, app: AppModel) {
        self.session = session
        sessionId = session.sessionId
        self.app = app
        text = Self.loadDraft(session.sessionId)
        mentions = Self.loadMentions(session.sessionId)
    }

    // MARK: Projections

    /// The live value from `session/control`, else the session's latest snapshot.
    func projection(_ key: String) -> JSON {
        if let live = app.control[sessionId]?[key] { return live }
        return session?.projectionValues[key] ?? .null
    }

    var imageLimits: ImageLimits { ImageLimits(projection("imageLimits")) }

    /// Plan mode is the effective target: a pending toggle flips the active value.
    var planActive: Bool {
        let plan = projection("plan")
        let active = plan["active"].bool ?? false
        return (plan["pending"].bool ?? false) ? !active : active
    }

    var goal: GoalInfo? {
        let goal = projection("goal")["goal"]
        guard let id = goal["id"].string else { return nil }
        return GoalInfo(id: id, revision: goal["revision"].int ?? 0, objective: goal["objective"].string ?? "",
                        phase: goal["phase"].string ?? "active", blockedReason: goal["blockedReason"]["message"].string)
    }

    /// The goal to show: not complete, not just cleared.
    var visibleGoal: GoalInfo? {
        guard let goal, goal.phase != "complete", goal.id != clearedGoalId else { return nil }
        return goal
    }

    /// Whether this goal will continue on its own, once `goals/get` has answered for this revision.
    func armed(_ goal: GoalInfo) -> Bool? {
        goalActivation.flatMap { $0.id == goal.id && $0.revision == goal.revision ? $0.armed : nil }
    }

    func goalPaused(_ goal: GoalInfo) -> Bool {
        goal.phase == "paused" || (goal.phase != "blocked" && armed(goal) == false)
    }

    func goalPhaseName(_ goal: GoalInfo) -> String {
        if goal.phase == "blocked" { return String(localized: "受阻的目标") }
        return goalPaused(goal) ? String(localized: "已暂停的目标") : String(localized: "进行中的目标")
    }

    /// `contextPressure`: used = projected ?? pressure tokens, over the route's window.
    var contextOccupancy: (percent: Int, used: Int, window: Int)? {
        let pressure = projection("contextPressure")
        guard let used = pressure["projectedTokens"].int ?? pressure["pressureTokens"].int,
              let window = pressure["contextWindow"].int, window > 0 else { return nil }
        return (min(100, Int((Double(used) / Double(window) * 100).rounded())), used, window)
    }

    /// From here on the status bar offers `/compact`; below it the figure stays in the workbench.
    var contextNearlyFull: Bool { (contextOccupancy?.percent ?? 0) >= 80 }

    var contextBreakdown: (system: Int, tools: Int, messages: Int)? {
        let value = projection("contextBreakdown")
        guard let system = value["systemTokens"].int, let tools = value["toolsTokens"].int, let messages = value["messageTokens"].int else { return nil }
        return (system, tools, messages)
    }

    var todos: [TodoItem] {
        projection("todos").array.map { TodoItem(content: $0["content"].string ?? "", status: $0["status"].string ?? "pending") }
    }

    /// Queued messages, without the ones still showing as this client's transcript echo.
    var queueRows: [QueueRow] {
        let inTranscript = Set(pending.filter { $0.placement == .transcript }.map(\.id))
        return projection("inbox")["next-turn"].array.compactMap { item in
            if let rpc = item["source"]["rpcId"].string, inTranscript.contains(rpc) { return nil }
            let content = item["content"].array
            let texts = content.filter { $0["type"].string == "text" }.compactMap { $0["text"].string }
            let attachments = content.filter { $0["type"].string != "text" }.map { block in
                block["attachment"]["name"].string ?? block["name"].string ?? (block["type"].string == "image" ? String(localized: "图片") : String(localized: "文件"))
            }
            let joined = texts.joined()
            return QueueRow(
                id: item["id"].string ?? item["itemId"].string ?? UUID().uuidString,
                editableText: attachments.isEmpty ? joined : nil,
                preview: joined.split(whereSeparator: \.isWhitespace).joined(separator: " "),
                attachments: attachments
            )
        }
    }

    /// Local echoes still waiting: queued ones until the queue row arrives, the others until their message.
    var visiblePending: [PendingSubmission] {
        let queued = Set(projection("inbox")["next-turn"].array.compactMap { $0["source"]["rpcId"].string })
        return pending.filter { !queued.contains($0.id) || $0.placement == .transcript }
    }

    var uploadsPending: Bool { attachments.contains { if case .ready = $0.upload { false } else { $0.upload != nil } } }
    var isEmpty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty }
    /// Nothing the main button could send, or save: a queued message is text only.
    var nothingToSend: Bool { editingQueue != nil ? text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty : isEmpty }

    func requestFocus() { focusRequest += 1 }

    // MARK: Draft (C-92)

    /// Same key and shape as the web's `dsh.conversation.<sid>` store: `{draft: {text, references}}`.
    private static func storageKey(_ sessionId: String) -> String { "dsh.conversation.\(sessionId)" }

    /// What a reference shows in the field, against what the engine reads: `@标题`, not `@[标题](dsh-session:…)`.
    private var mentions: [String: String] = [:]

    func addMention(title: String, raw: String) -> String {
        let token = "@\(title)"
        mentions[token] = raw
        return token
    }

    private func expandMentions(_ text: String) -> String {
        mentions.keys.sorted { $0.count > $1.count }.reduce(text) { $0.replacingOccurrences(of: $1, with: mentions[$1] ?? $1) }
    }

    private static func loadMentions(_ sessionId: String) -> [String: String] {
        guard let raw = UserDefaults.standard.string(forKey: storageKey(sessionId)),
              let stored = try? JSONDecoder().decode(JSON.self, from: Data(raw.utf8)) else { return [:] }
        return stored["draft"]["mentions"].object.compactMapValues(\.string)
    }

    private static func loadDraft(_ sessionId: String) -> String {
        guard let raw = UserDefaults.standard.string(forKey: storageKey(sessionId)),
              let stored = try? JSONDecoder().decode(JSON.self, from: Data(raw.utf8)) else { return "" }
        return stored["draft"]["text"].string ?? stored["draft"].string ?? ""
    }

    private func persistDraft() {
        // A queued message in the input is not the draft: the draft waits in `setAside`.
        guard editingQueue == nil else { return }
        let key = Self.storageKey(sessionId)
        guard !text.isEmpty else { UserDefaults.standard.removeObject(forKey: key); return }
        let stored: JSON = ["draft": ["text": .string(text), "references": [], "mentions": .object(mentions.mapValues { .string($0) })]]
        if let data = try? JSONEncoder().encode(stored) { UserDefaults.standard.set(String(decoding: data, as: UTF8.self), forKey: key) }
    }

    // MARK: Sending (C-20, C-91, C-94)

    enum Gesture { case preferred, queue, steer }

    /// Send the draft: a known `/command` line executes, everything else is an
    /// optimistic prompt (cleared at once, restored if the engine refuses it).
    /// `clearField` empties the text view at the moment the draft really goes
    /// (`clearFocusedTextInput`); a refused send must leave it alone.
    func submit(_ gesture: Gesture, context: ComposerContext, clearField: @escaping @MainActor () -> Void) {
        guard !executing, !isEmpty else { return }
        if uploadsPending {
            let failed = attachments.contains { if case .failed = $0.upload { true } else { false } }
            app.showToast(failed ? String(localized: "文件尚未上传成功，请重新添加后再试") : String(localized: "文件还在上传，请等待上传完成后发送"))
            return
        }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("/"), let (descriptor, line) = context.resolve(line: trimmed) {
            let bare = !trimmed.contains(where: \.isWhitespace)
            // A bare command or one taking arguments executes; arguments after an argument-less command make a message.
            if bare || descriptor.hint != nil {
                if !attachments.isEmpty && !descriptor.acceptsAttachments {
                    app.showToast(String(localized: "/\(String(trimmed.dropFirst().prefix { !$0.isWhitespace })) 不接受附件，请先移除附件"))
                    return
                }
                execute(expandMentions(line), draft: text, clearField: clearField)
                return
            }
        }
        let running = session?.running ?? false
        let steer: Bool = switch gesture {
        case .queue: false
        case .steer: running
        case .preferred: running && context.busyEnter == "steer"
        }
        clearField()
        sendMessage(text, steer: steer, running: running)
    }

    private func sendMessage(_ draft: String, steer: Bool, running: Bool) {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let sent = attachments
        let requestId = UUID().uuidString.lowercased()
        pending.append(PendingSubmission(
            id: requestId, text: trimmed, attachments: sent.map(\.name),
            placement: running ? (steer ? .steering : .queued) : .transcript
        ))
        // Sending the restored text consumes the failures it held.
        if restoredText != nil { failedDrafts.removeAll(); restoredText = nil }
        sendSeq += 1
        let seq = sendSeq
        text = ""
        attachments = []
        Task {
            do {
                guard let session else { throw CancellationError() }
                var content = try Self.content(for: sent)
                if !trimmed.isEmpty { content.append(["type": "text", "text": .string(expandMentions(trimmed))]) }
                try await session.prompt(content: content, steer: steer, requestId: requestId)
                mentions = [:]
                // Receipts now stand for the files: the private copies are done with.
                for attachment in sent { if case .file(let url) = attachment.kind { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) } }
                // A safety net: the message or its queue row normally retires the echo first.
                try? await Task.sleep(for: .seconds(30))
                retire(requestId)
            } catch {
                retire(requestId)
                restoreFailed(seq: seq, draft: draft, attachments: sent)
                Haptics.error()
                app.showToast(errorText(error))
            }
        }
    }

    /// Failed drafts come back in send order, joined by blank lines, only into an
    /// empty input (or one still holding the last restore); attachments always return.
    private func restoreFailed(seq: Int, draft: String, attachments sent: [DraftAttachment]) {
        attachments = sent + attachments
        failedDrafts.append((seq, draft))
        guard text.isEmpty || text == restoredText else { return }
        let joined = failedDrafts.sorted { $0.seq < $1.seq }.map(\.text).joined(separator: "\n\n")
        text = joined
        restoredText = joined
    }

    /// Execute a command line (C-100). The draft stays until it is accepted, and comes
    /// back with a notice when the engine refuses it (C-91).
    private func execute(_ line: String, draft: String, clearField: @escaping @MainActor () -> Void) {
        let sent = attachments
        executing = true
        Task {
            defer { executing = false }
            do {
                guard let session else { return }
                let value = try await session.executeCommand(line, attachments: Self.content(for: sent))
                if value.isNull {
                    app.showToast(String(localized: "未知或格式不对的指令：\(line)"))
                    return
                }
                if !sent.isEmpty, value["result"]["kind"].string == "error" {
                    app.showToast(value["result"]["text"].string ?? String(localized: "指令执行失败"))
                    return
                }
                // The outcome renders as a command node in the timeline; the composer only clears.
                if text == draft { clearField(); text = "" } else if text.hasPrefix(draft) { text = String(text.dropFirst(draft.count)) }
                let sentIds = Set(sent.map(\.id))
                attachments.removeAll { sentIds.contains($0.id) }
            } catch {
                Haptics.error()
                app.showToast(errorText(error))
            }
        }
    }

    /// C-112: `/plan` enters plan mode (it toggles nothing: with no argument it only turns it on), `/plan off` leaves.
    func setPlan(_ on: Bool) {
        guard !planSwitching, let session else { return }
        planSwitching = true
        Task {
            defer { planSwitching = false }
            let failure = on ? String(localized: "进入计划模式失败") : String(localized: "退出计划模式失败")
            do {
                if try await session.executeCommand(on ? "/plan" : "/plan off").isNull { app.showToast(failure) }
                session.refreshProjections()
            } catch {
                app.showToast(failure + "：" + errorText(error))
            }
        }
    }

    /// `/compact`: its outcome renders as a command node in the timeline (the workbench's 压缩上下文 does the same).
    func compact() {
        guard !compacting, let session else { return }
        compacting = true
        Task {
            defer { compacting = false }
            do {
                if try await session.executeCommand("/compact").isNull { app.showToast(String(localized: "未知或格式不对的指令：/compact")) }
                session.refreshProjections()
            } catch {
                app.showToast(errorText(error))
            }
        }
    }

    /// Run a bare command picked from the menu, in the background (the token is already consumed).
    func runDetached(_ line: String) {
        Task {
            do {
                guard let value = try await session?.executeCommand(line) else { return }
                if value.isNull { app.showToast(String(localized: "未知或格式不对的指令：\(line)")) }
            } catch {
                app.showToast(errorText(error))
            }
        }
    }

    private static func content(for attachments: [DraftAttachment]) throws -> [JSON] {
        try attachments.map { attachment in
            switch attachment.kind {
            case .image(let mediaType, let data, _):
                return ["type": "image", "mediaType": .string(mediaType), "data": .string(data), "name": .string(attachment.name)]
            case .file:
                guard case .ready(let receipt) = attachment.upload else {
                    throw EngineError(code: "session/attachment-invalid", message: String(localized: "文件尚未上传成功，请重新添加后再试"), detail: ["details": ["reason": "FILE_NOT_STAGED"]])
                }
                return ["type": "file", "receiptId": .string(receipt)]
            }
        }
    }

    /// The durable message (or a queue row, for the dock) arrived: drop the echo.
    func observe(_ event: JSON) {
        guard event["type"].string == "user/message" else { return }
        let source = event["data"]["source"]
        guard source["kind"].string == "user", let rpc = source["rpcId"].string ?? source["requestId"].string else { return }
        retire(rpc)
    }

    private func retire(_ requestId: String) {
        pending.removeAll { $0.id == requestId }
    }

    // MARK: Errors (C-85)

    /// The web's composer copy: a busy writer, an attachment the engine refused, else `message (code)`.
    func errorText(_ error: Error) -> String {
        guard let error = error as? EngineError, let code = error.code else { return error.localizedDescription }
        switch code {
        case "session/writer-held":
            return String(localized: "当前会话已被占用，可能是其他正在运行的 DSH 导致的（如其他 dsh web、桌面端），请退出其他正在运行的 DSH 后重试。")
        case "session/attachment-invalid", "subagent/attachment-invalid":
            return attachmentErrorText(reason: error.detail["details"]["reason"].string ?? "")
        case "session/agent-busy":
            // The engine's catch-all for prompts: the cause is only in `details.reason`.
            guard let reason = error.detail["details"]["reason"].string?.split(separator: "\n").first else { fallthrough }
            return "\(error.message): \(reason) (\(code))"
        default:
            return "\(error.message) (\(code))"
        }
    }

    func attachmentErrorText(reason: String) -> String {
        let limits = imageLimits
        switch reason {
        case "MODEL_DOES_NOT_SUPPORT_IMAGES": return String(localized: "当前模型不支持图片，请切换支持图片的模型")
        case "FILE_NOT_STAGED": return String(localized: "文件尚未上传成功，请重新添加后再试")
        case "IMAGE_TOO_MANY_PIXELS": return String(localized: "图片分辨率过大，请压缩后重试")
        case "IMAGE_DIMENSION_TOO_LARGE": return String(localized: "图片宽高不能超过 \(limits.maxImageDimension)px，请缩小后重试")
        case "INVALID_IMAGE", "IMAGE_TYPE_MISMATCH": return String(localized: "仅支持 PNG、JPG、WebP、GIF 格式的图片")
        case "TOO_MANY_IMAGES": return String(localized: "一条消息最多添加 \(limits.maxImagesPerMessage) 张图片")
        case "IMAGE_TOO_LARGE": return String(localized: "单张图片不能超过 \(ImageLimits.sizeText(limits.maxImageBytes))")
        case "IMAGES_TOO_LARGE": return String(localized: "图片总大小超过 \(ImageLimits.sizeText(limits.maxMessageImageBytes))，请移除部分图片")
        default: return String(localized: "图片发送失败（\(reason)），请重新添加图片后再试")
        }
    }

    // MARK: Queue (C-95)

    enum QueueAction { case edit(String), remove, steer }

    /// One queue operation; returns false (after a toast) when it failed. A steer the
    /// agent could no longer take (stopped, or already picked the row up) is silent.
    @discardableResult
    func updateQueue(_ id: String, _ action: QueueAction) async -> Bool {
        let wire: JSON = switch action {
        case .edit(let text): ["kind": "edit", "content": [["type": "text", "text": .string(text)]]]
        case .remove: ["kind": "remove"]
        case .steer: ["kind": "steer"]
        }
        do {
            try await session?.updateQueue(id, action: wire)
            return true
        } catch {
            let code = (error as? EngineError)?.code
            if case .steer = action, code == "session/steer-unavailable" || code == "session/queue-item-not-found" { return true }
            switch action {
            case .edit: app.showToast(String(localized: "编辑失败：这条消息可能已经开始发送。"))
            case .remove: app.showToast(String(localized: "删除失败：这条消息可能已经开始发送。"))
            case .steer: app.showToast(String(localized: "插话发送失败，请重试。"))
            }
            return false
        }
    }

    /// Put a queued message in the input to edit. The row keeps its place in the queue, and
    /// the draft steps aside until the edit ends; attachments wait too (a queued edit is text only).
    func beginQueueEdit(_ row: QueueRow) {
        guard let editable = row.editableText else { return }
        let setAside = editingQueue?.setAside ?? text
        editingQueue = (row.id, setAside)
        text = editable
    }

    func cancelQueueEdit() {
        guard let editing = editingQueue else { return }
        editingQueue = nil
        text = editing.setAside
    }

    /// Save the edit into the queue row, and the draft returns. If the row has already gone
    /// (the agent took it) the toast says so and the text stays, to send as a new message.
    func saveQueueEdit(clearField: @escaping @MainActor () -> Void) {
        guard let editing = editingQueue, !savingQueueEdit, !nothingToSend else { return }
        savingQueueEdit = true
        Task {
            let saved = await updateQueue(editing.id, .edit(text))
            savingQueueEdit = false
            guard editingQueue?.id == editing.id else { return }
            editingQueue = nil
            if saved {
                clearField()
                text = editing.setAside
            } else {
                text = editing.setAside.isEmpty ? text : text + "\n\n" + editing.setAside
            }
        }
    }

    /// 「全部插话」: steer every queued message in order, stopping quietly once the agent can take no more.
    func steerAll() async {
        for row in queueRows {
            do {
                try await session?.updateQueue(row.id, action: ["kind": "steer"])
            } catch {
                let code = (error as? EngineError)?.code
                if code != "session/steer-unavailable" && code != "session/queue-item-not-found" {
                    app.showToast(String(localized: "插话发送失败，请重试。"))
                }
                return
            }
        }
    }

    // MARK: Goal (C-121)

    /// Re-read whether the goal is armed (after projection changes, a run edge, `goal/activation-changed`).
    func refreshGoalActivation() async {
        guard let goal, goal.phase == "active" else { goalActivation = nil; return }
        guard let value = try? await app.client.call("goals/get", ["agentId": .string(sessionId)]),
              let id = value["id"].string else { return }
        goalActivation = (id, value["revision"].int ?? 0, value["activation"].string != "disarmed")
    }

    enum GoalAction { case pause, resume, clear, edit(String) }

    /// Run one goal action against the current goal; returns the error line on failure.
    func goalAction(_ action: GoalAction) async -> String? {
        guard let goal else { return String(localized: "no current goal to mutate (no-current-goal)") }
        let ref: JSON = ["id": .string(goal.id), "revision": .number(Double(goal.revision))]
        var args: [String: JSON] = ["agentId": .string(sessionId), "ref": ref]
        let method: String
        switch action {
        case .pause: method = "goals/pause"
        case .resume: method = "goals/resume"
        case .clear: method = "goals/clear"
        case .edit(let objective):
            method = "goals/edit"
            args["request"] = ["objective": .string(objective)]
        }
        do {
            let value = try await app.client.call(method, .object(args))
            if let id = value["id"].string, let activation = value["activation"].string {
                goalActivation = (id, value["revision"].int ?? 0, activation != "disarmed")
            }
            if case .clear = action { clearedGoalId = goal.id }
            session?.refreshProjections()
            return nil
        } catch {
            if let error = error as? EngineError { return "\(error.message) (\(error.code ?? ""))" }
            return error.localizedDescription
        }
    }

    // MARK: Attachments (C-104, C-105)

    /// Add a picked or captured image: re-encoded as JPEG within the session's limits
    /// (HEIC is not accepted). Returns the refusal to show, if any.
    @discardableResult
    func addImage(_ image: UIImage, name: String? = nil) -> String? {
        let limits = imageLimits
        let images = attachments.filter(\.isImage)
        if images.count + 1 > limits.maxImagesPerMessage {
            return String(localized: "一条消息最多添加 \(limits.maxImagesPerMessage) 张图片")
        }
        guard limits.mediaTypes.contains("image/jpeg") else { return String(localized: "仅支持 PNG、JPG、WebP、GIF 格式的图片") }
        let side = CGFloat(min(2048, limits.maxImageDimension))
        let scale = min(1, side / max(image.size.width, image.size.height))
        let size = CGSize(width: (image.size.width * scale).rounded(), height: (image.size.height * scale).rounded())
        let scaled = image.preparingThumbnail(of: size) ?? image
        guard let jpeg = scaled.jpegData(compressionQuality: 0.85) else { return String(localized: "仅支持 PNG、JPG、WebP、GIF 格式的图片") }
        if jpeg.count > limits.maxImageBytes {
            return String(localized: "单张图片不能超过 \(ImageLimits.sizeText(limits.maxImageBytes))")
        }
        if images.reduce(0, { $0 + $1.bytes }) + jpeg.count > limits.maxMessageImageBytes {
            return String(localized: "图片总大小超过 \(ImageLimits.sizeText(limits.maxMessageImageBytes))，请移除部分图片")
        }
        let base = name.map { ($0 as NSString).deletingPathExtension } ?? "image-\(images.count + 1)"
        attachments.append(DraftAttachment(name: base + ".jpg", bytes: jpeg.count, kind: .image(mediaType: "image/jpeg", data: jpeg.base64EncodedString(), preview: scaled)))
        return nil
    }

    var remainingImageSlots: Int { max(0, imageLimits.maxImagesPerMessage - attachments.filter(\.isImage).count) }

    /// Files from the Files app: images join as images, everything else uploads now.
    func addFiles(_ urls: [URL]) {
        var refusal: String?
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let type = UTType(filenameExtension: url.pathExtension)
            if type?.conforms(to: .image) == true, let data = try? Data(contentsOf: url), let image = UIImage(data: data) {
                if let reason = addImage(image, name: url.lastPathComponent) { refusal = reason }
                continue
            }
            // A private copy: the security-scoped URL may not outlive the picker, and retries reread it.
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent("uploads/\(UUID().uuidString)", isDirectory: true)
            let copy = folder.appendingPathComponent(url.lastPathComponent)
            do {
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                try FileManager.default.copyItem(at: url, to: copy)
            } catch {
                refusal = error.localizedDescription
                continue
            }
            let bytes = (try? copy.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            let attachment = DraftAttachment(name: url.lastPathComponent, bytes: bytes, kind: .file(url: copy), upload: .uploading(loaded: 0, total: Int64(bytes)))
            attachments.append(attachment)
            enqueueUpload(attachment.id)
        }
        if let refusal { app.showToast(refusal) }
    }

    func removeAttachment(_ id: UUID) {
        uploadTasks[id]?.cancel()
        uploadTasks[id] = nil
        uploadQueue.removeAll { $0 == id }
        if let attachment = attachments.first(where: { $0.id == id }), case .file(let url) = attachment.kind {
            try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
        }
        attachments.removeAll { $0.id == id }
    }

    func retryUpload(_ id: UUID) {
        guard let index = attachments.firstIndex(where: { $0.id == id }), case .failed = attachments[index].upload else { return }
        attachments[index].upload = .uploading(loaded: 0, total: Int64(attachments[index].bytes))
        enqueueUpload(id)
    }

    private func enqueueUpload(_ id: UUID) {
        uploadQueue.append(id)
        pumpUploads()
    }

    /// Start queued uploads until the concurrency limit is used (FIFO).
    private func pumpUploads() {
        while activeUploads < Self.maxConcurrentFileUploads, !uploadQueue.isEmpty {
            let id = uploadQueue.removeFirst()
            guard let attachment = attachments.first(where: { $0.id == id }), case .file(let url) = attachment.kind else { continue }
            activeUploads += 1
            uploadTasks[id] = Task {
                let outcome: DraftAttachment.Upload
                do {
                    let receipt = try await upload(url, name: attachment.name) { [weak self] sent, total in
                        Task { @MainActor in
                            guard let self, let index = self.attachments.firstIndex(where: { $0.id == id }),
                                  case .uploading = self.attachments[index].upload else { return }
                            self.attachments[index].upload = .uploading(loaded: sent, total: total > 0 ? total : nil)
                        }
                    }
                    outcome = .ready(receiptId: receipt)
                } catch {
                    outcome = .failed(error.localizedDescription)
                }
                if !Task.isCancelled, let index = attachments.firstIndex(where: { $0.id == id }) {
                    attachments[index].upload = outcome
                }
                uploadTasks[id] = nil
                activeUploads -= 1
                pumpUploads()
            }
        }
    }

    /// `POST /api/session/uploadFileBinary?sessionId=&name=` with the raw bytes (the web's
    /// primary upload path); the reply is a bare `{ok, value: {receiptId, file}}` without the RPC envelope.
    private func upload(_ file: URL, name: String, progress: @escaping @Sendable (Int64, Int64) -> Void) async throws -> String {
        let client = app.client
        var components = URLComponents(url: client.origin.appendingPathComponent("api/session/uploadFileBinary"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "sessionId", value: sessionId), URLQueryItem(name: "name", value: name)]
        // URLSearchParams reads `+` as a space.
        components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        var request = client.request(components.url!)
        request.httpMethod = "POST"
        request.setValue("application/octet-stream", forHTTPHeaderField: "content-type")
        let (data, response) = try await client.session.upload(for: request, fromFile: file, delegate: UploadProgress(progress))
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200, let reply = try? JSONDecoder().decode(JSON.self, from: data) else {
            throw EngineError(code: "HTTP_\(status)", message: String(localized: "上传失败（HTTP \(status)）"), detail: .null)
        }
        if reply["ok"].bool == true, let receipt = reply["value"]["receiptId"].string { return receipt }
        throw EngineError(code: reply["error"]["code"].string, message: reply["error"]["message"].string ?? String(localized: "上传失败"), detail: reply["error"])
    }
}

/// Upload progress for one task (the engine client's session delegate handles redirects only).
private final class UploadProgress: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    let handler: @Sendable (Int64, Int64) -> Void
    init(_ handler: @escaping @Sendable (Int64, Int64) -> Void) { self.handler = handler }

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        handler(totalBytesSent, totalBytesExpectedToSend)
    }
}
