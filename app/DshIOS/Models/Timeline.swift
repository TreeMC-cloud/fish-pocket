import Foundation

/// One tool invocation as the conversation shows it: the call, then its result.
struct ToolCall: Identifiable, Hashable {
    let id: String
    var name: String
    var arguments: JSON
    var rawArguments: String
    var result: String?
    var resultImages: [Attachment] = []
    var isError = false
    /// `tool/result.data.error`: `{name, code, reason?}` (no message); `interrupted` is
    /// written here when the turn closed before the call had a result, as the web does.
    var errorCode: String?
    var errorName: String?
    var errorReason: String?
    /// `tool/result.data.meta`: the tool's `presentationMeta(args, value)`, present only on success.
    var meta: JSON = .null
    /// For `todo_write`: the list recorded before this call; nil when there was none in the loaded window.
    var previousTodos: [TodoItem]?
    /// The loaded events reach the start of the session, so no earlier list can exist.
    var historyComplete = true
    var finished: Bool { result != nil }

    /// The one-line summary without a working directory to shorten paths against.
    var summary: String { rowSummary(cwd: nil) }

    /// `mcp__server__tool` shows as `tool`.
    var displayName: String { name.components(separatedBy: "__").last ?? name }
}

enum AssistantBlock: Identifiable, Hashable {
    case reasoning(id: String, text: String)
    case text(id: String, text: String)
    case tool(ToolCall)
    case image(id: String, attachment: Attachment)

    var id: String {
        switch self {
        case .reasoning(let id, _), .text(let id, _), .image(let id, _): return id
        case .tool(let call): return "tool-\(call.id)"
        }
    }
}

/// An image or file block: `{type, attachment: {attachmentId, mediaType, bytes, width, height, name?, originalDimensions?}}`.
struct Attachment: Hashable {
    var attachmentId: String?
    var name: String?
    var mediaType: String?
    var width: Int?
    var height: Int?
    var bytes: Int?
    /// Size before the attachment service scaled it down, when it did.
    var originalWidth: Int?
    var originalHeight: Int?

    init(attachmentId: String?, name: String? = nil, mediaType: String? = nil) {
        self.attachmentId = attachmentId
        self.name = name
        self.mediaType = mediaType
    }

    /// The ref sits under `attachment`; older logs carried its fields on the block itself.
    init(block: JSON) {
        let ref = block["attachment"].isNull ? block : block["attachment"]
        attachmentId = ref["attachmentId"].string
        name = ref["name"].string ?? block["name"].string
        mediaType = ref["mediaType"].string ?? block["mediaType"].string
        width = ref["width"].int
        height = ref["height"].int
        bytes = ref["bytes"].int
        originalWidth = ref["originalDimensions"]["width"].int
        originalHeight = ref["originalDimensions"]["height"].int
    }

    /// The stored ref `session/attachment` reads since 0.2.2 (it takes the whole
    /// ref, not just its id), rebuilt from the parsed fields so an older flat
    /// block still resolves.
    var ref: JSON? {
        guard let attachmentId, let mediaType, let bytes, let width, let height else { return nil }
        var value: [String: JSON] = [
            "attachmentId": .string(attachmentId),
            "mediaType": .string(mediaType),
            "bytes": .number(Double(bytes)),
            "width": .number(Double(width)),
            "height": .number(Double(height)),
        ]
        if let name { value["name"] = .string(name) }
        if let originalWidth, let originalHeight {
            value["originalDimensions"] = ["width": .number(Double(originalWidth)), "height": .number(Double(originalHeight))]
        }
        return .object(value)
    }

    /// Image blocks render inline; file blocks show as a name.
    var isImage: Bool { mediaType?.hasPrefix("image/") ?? true }
}

enum TimelineItem: Identifiable, Hashable {
    case user(seq: Int, text: String, attachments: [Attachment], requestId: String?)
    case assistant(turn: Int, blocks: [AssistantBlock], startedAt: Date?, endedAt: Date?)
    case notice(seq: Int, text: String, isError: Bool)
    /// The turn stopped at the output token limit; its text stays, the user can ask to go on.
    case maxTokens(seq: Int)
    /// The turn had no working credential: what to do about it, in place of the engine's error.
    case credential(seq: Int, problem: TurnFailure.CredentialProblem)
    case questionReply(QuestionReply)
    case trigger(TurnTrigger)
    case command(CommandRun)
    case compaction(CompactionCard)
    case retry(RetryState)

    var id: String {
        switch self {
        case .user(let seq, _, _, _): return "u\(seq)"
        // A turn interrupted by a retry or a steering message continues in a second item.
        case .assistant(let turn, _, let started, _): return "a\(turn)-\(started?.timeIntervalSince1970 ?? 0)"
        case .notice(let seq, _, _): return "n\(seq)"
        case .maxTokens(let seq): return "m\(seq)"
        case .credential(let seq, _): return "k\(seq)"
        case .questionReply(let reply): return "q\(reply.seq)"
        case .trigger(let trigger): return "t\(trigger.seq)"
        case .command(let command): return "c\(command.id)"
        case .compaction(let card): return "k\(card.seq)"
        case .retry(let retry): return "r\(retry.id)"
        }
    }
}

/// The answer to a question that had already continued (C-118): a `user/message` whose text
/// is `{kind:"answer_to_pending_question", questions, answers}`.
struct QuestionReply: Hashable {
    struct Entry: Hashable {
        var header: String?
        var question: String
        var detail: String?
        var options: [String]
        var values: [String]
    }
    let seq: Int
    let time: Date
    let entries: [Entry]
    /// The message text, shown when it is not the expected JSON.
    let raw: String

    init(seq: Int, time: Date, text: String) {
        self.seq = seq
        self.time = time
        raw = text
        let value = (try? JSONDecoder().decode(JSON.self, from: Data(text.utf8))) ?? .null
        let answers = value["answers"].array
        entries = value["questions"].array.map { question in
            let answer = answers.first { $0["id"].string == question["id"].string } ?? .null
            let custom = answer["custom"].string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return Entry(
                header: question["header"].string,
                question: question["question"].string ?? "",
                detail: question["detail"].string,
                options: question["options"].array.map { option in
                    [option["label"].string, option["description"].string].compactMap { $0 }.joined(separator: " — ")
                },
                values: answer["selected"].array.compactMap(\.string) + (custom.isEmpty ? [] : [custom])
            )
        }
    }

    var summary: String {
        let values = entries.flatMap(\.values)
        return values.isEmpty ? String(localized: "已跳过") : values.joined(separator: ", ")
    }

    var copyText: String {
        guard !entries.isEmpty else { return raw }
        return entries.map { entry in
            let title = [entry.header, entry.question].compactMap { $0 }.joined(separator: " — ")
            let answer = entry.values.isEmpty ? String(localized: "已跳过") : entry.values.joined(separator: ", ")
            return title + "\n" + String(localized: "回答：") + answer
        }.joined(separator: "\n\n")
    }
}

/// A message from something other than the user that started a turn (C-52).
struct TurnTrigger: Hashable {
    let seq: Int
    let time: Date
    let title: String
    let symbol: String
    let body: String

    init(seq: Int, time: Date, source: JSON, body: String) {
        self.seq = seq
        self.time = time
        self.body = body
        switch source["kind"].string {
        case "goal": title = String(localized: "继续执行目标"); symbol = "flag"
        case "agent-message": title = String(localized: "收到任务消息"); symbol = "person"
        case "team-message": title = String(localized: "收到团队消息"); symbol = "person.2"
        case "subagent-settled": title = String(localized: "子任务状态更新"); symbol = "person.2.circle"
        case "webhook" where source["provider"].string == "github": title = String(localized: "收到 GitHub 事件"); symbol = "chevron.left.forwardslash.chevron.right"
        case "webhook": title = String(localized: "收到外部事件"); symbol = "link"
        case "schedule": title = String(localized: "自动化任务"); symbol = "clock"
        case "tool-jobs": title = String(localized: "后台任务状态更新"); symbol = "gearshape.2"
        case "cordis-host-runner": title = String(localized: "插件状态更新"); symbol = "puzzlepiece.extension"
        default: title = String(localized: "收到执行请求"); symbol = "bell"
        }
    }

    /// Kinds that are notifications rather than harness context, for a claim whose ids fall before the window.
    static let wakingKinds: Set<String> = ["goal", "agent-message", "team-message", "subagent-settled", "webhook", "schedule", "tool-jobs", "cordis-host-runner"]
}

/// A slash command in the conversation (C-48).
struct CommandRun: Hashable {
    let id: String
    var name: String
    var done = false
    var failed = false
    var text: String?

    /// The one line: 「执行中…」, the outcome's text, or how it ended.
    var summary: String {
        guard done else { return name == "compact" ? String(localized: "正在压缩…") : String(localized: "执行中…") }
        if let text, !text.isEmpty { return text.components(separatedBy: "\n").first ?? text }
        return failed ? String(localized: "指令失败") : String(localized: "已完成")
    }
}

/// 「上下文已压缩」 (C-50).
struct CompactionCard: Hashable {
    let seq: Int
    var items: Int?
    var tokens: Int?
    var summary: String?
    /// `/compact`'s own outcome text, when the summary has none.
    var outcome: String?
}

/// One chain of model request retries, showing its latest attempt (C-44).
struct RetryState: Hashable {
    enum Phase: Hashable { case scheduled, started, cancelled }
    let id: String
    var retry: Int
    var maximum: Int?
    var delayMs: Int
    var failure: String
    var scheduledAt: Date
    var phase = Phase.scheduled
    var turn: Int?

    static func failureText(_ failure: JSON) -> String {
        switch failure["code"].string {
        case "AUTH": return String(localized: "API 密钥无效")
        case "QUOTA", "ACCOUNT_QUOTA": return String(localized: "当前请求的额度已用尽")
        default: return failure["message"].string ?? ""
        }
    }
}

/// One line of the `turnOutline` projection, for 跳转到轮次 (C-14).
struct TurnOutline: Identifiable, Hashable {
    let turn: Int
    /// The turn's `turn/start`: paging back through it loads the whole turn.
    let seq: Int
    let prompt: String
    let response: String
    var id: Int { turn }

    init?(_ json: JSON) {
        guard let turn = json["turn"].int, let seq = json["seq"].int else { return nil }
        self.turn = turn
        self.seq = seq
        prompt = json["prompt"].string ?? ""
        response = json["response"].string ?? ""
    }
}

/// Exact token accounting of a closed turn (C-41).
struct TurnUsage: Hashable {
    var uncachedInput = 0
    var output = 0
    var total = 0
    var cacheRead: Int? = 0
    var cacheWrite: Int? = 0
    var reasoning: Int? = 0
    var routes: [String] = []

    mutating func add(_ usage: JSON, route: String?) {
        let input = usage["inputTokens"].int ?? 0
        let out = usage["outputTokens"].int ?? 0
        let read = usage["cacheReadTokens"].int
        let write = usage["cacheWriteTokens"].int
        uncachedInput += input
        output += out
        total += usage["totalTokens"].int ?? input + out + (read ?? 0) + (write ?? 0)
        cacheRead = read.flatMap { value in cacheRead.map { $0 + value } }
        cacheWrite = write.flatMap { value in cacheWrite.map { $0 + value } }
        reasoning = usage["reasoningTokens"].int.flatMap { value in reasoning.map { $0 + value } }
        if let route, !routes.contains(route) { routes.append(route) }
    }
}

struct Deliverable: Hashable {
    var path: String
    var description: String?
}

/// What the end of a turn shows besides its blocks.
struct TurnInfo: Hashable {
    var startedAt: Date?
    var closedKind: String?
    /// The last assistant message with text: what is copied and rated (C-35, C-129).
    var closingTime: Date?
    var closingText = ""
    var usage: TurnUsage?
    var usageBroken = false
    var deliverables: [Deliverable] = []
    /// The user steered during this turn, so its work stays open (C-32).
    var steered = false
    /// Paths written or edited, by the name a closing message may use for them (C-24).
    var producedPaths: [String] = []
}

/// A question the agent is waiting on (ask_user_question, plan review…).
struct PendingQuestion: Identifiable, Hashable {
    struct Question: Hashable {
        var id: String
        var question: String
        var detail: String?
        var header: String?
        var options: [(label: String, description: String?)]
        var multiSelect: Bool
        var isPlanReview: Bool
        var approveLabel: String?

        init(_ json: JSON) {
            id = json["id"].string ?? ""
            question = json["question"].string ?? ""
            detail = json["detail"].string
            header = json["header"].string
            options = json["options"].array.map { ($0["label"].string ?? "", $0["description"].string) }
            multiSelect = json["multiSelect"].bool ?? json["multi_select"].bool ?? false
            isPlanReview = json["intent"]["kind"].string == "plan-review"
            approveLabel = json["intent"]["approve"].string
        }

        static func == (lhs: Question, rhs: Question) -> Bool { lhs.id == rhs.id && lhs.question == rhs.question }
        func hash(into hasher: inout Hasher) { hasher.combine(id) }
    }
    /// The tool call, or the waterfall event for a request that names no call (plan review).
    let id: String
    var callId: String?
    /// The held waterfall that answers it; nil once it has continued (answered over RPC).
    var eventId: String?
    /// Answers may be read by the model only for this long; see `QuestionWait`.
    var timed = false
    var questions: [Question]

    init(_ request: QuestionRequest) {
        id = request.callId ?? request.eventId
        callId = request.callId
        eventId = request.eventId
        timed = request.timed
        questions = request.questions
    }

    /// A row of the `userQuestions` projection: it continued without an answer.
    init(continued row: JSON) {
        let call = row["callId"].string ?? ""
        id = call
        callId = call
        questions = row["questions"].array.map(Question.init)
    }

    /// C-119: one single-choice question with the plan as `detail` and an approve option.
    var planReview: PlanReview? {
        guard questions.count == 1, let question = questions.first, question.isPlanReview,
              let plan = question.detail, !question.multiSelect, question.options.count <= 2,
              let approve = question.options.first(where: { $0.label == question.approveLabel }) else { return nil }
        return PlanReview(questionId: question.id, plan: plan, approveLabel: approve.label, approveDescription: approve.description)
    }
}

struct PlanReview {
    var questionId: String
    var plan: String
    var approveLabel: String
    var approveDescription: String?
}

/// The `$events` request behind a question that is still open.
struct QuestionRequest: Hashable {
    let eventId: String
    let callId: String?
    let timed: Bool
    let questions: [PendingQuestion.Question]

    init(eventId: String, request: JSON) {
        self.eventId = eventId
        callId = request["wait"]["callId"].string
        timed = request["wait"]["timed"].bool ?? false
        questions = request["questions"].array.map(PendingQuestion.Question.init)
    }
}

/// How a timed question stands. While the client holds `userQuestions/attachWait` the
/// host runs no timer: the countdown is ours, and at zero we reject with `ASK_TIMED_OUT`.
/// Nothing here goes on the wire except that rejection. 「慢慢回答」 and a first edit simply
/// stop the countdown for good, and the held claim keeps the host waiting.
enum QuestionWait: Equatable {
    case counting(deadline: Date)
    /// The answer field has focus: the countdown is frozen with this much left.
    case focused(remaining: TimeInterval)
    case editing
    /// 「慢慢回答」.
    case held
}

/// The user's unfinished answers to a question; kept on the model so they survive
/// swiping the sheet away.
struct QuestionDraft: Hashable {
    var index = 0
    var answers: [String: Answer] = [:]

    struct Answer: Hashable {
        var selected: Set<String> = []
        var custom = ""
        var skipped = false
    }
}

/// A tool call waiting for the user's permission (`approval/request`).
struct PendingApproval: Identifiable, Hashable {
    let id: String // eventId
    var toolName: String
    var callId: String?
    var reason: String?
}

struct ModelChoice: Hashable, Identifiable {
    var provider: String
    var model: String
    var name: String
    var reasoningEfforts: [(id: String, name: String)]
    var defaultEffort: String?
    var id: String { "\(provider)/\(model)" }

    static func == (lhs: ModelChoice, rhs: ModelChoice) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

struct TodoItem: Hashable {
    var content: String
    var status: String
}

/// One agent inbox, replayed from `agent/inbox/spliced`: a claim removes messages and enters
/// them into the agent, other splices edit the list. Says who the last claim took (C-52).
private struct InboxState {
    private var pending: [(id: String, human: Bool)] = []
    private(set) var claimed: Set<String> = []
    private(set) var claimSeq = -1
    private(set) var claimedHuman = false
    /// A claim of messages from before the loaded window: their ids are unknown.
    private(set) var claimUnknown = false

    mutating func apply(_ splice: JSON, seq: Int) {
        let start = splice["start"].int ?? 0
        let removed = splice["removedCount"].int ?? 0
        let inserted = splice["inserted"].array.compactMap { item in
            item["id"].string.map { (id: $0, human: item["source"]["kind"].string == "user") }
        }
        let at = min(start, pending.count)
        let end = min(at + removed, pending.count)
        let taken = Array(pending[at..<end])
        pending.replaceSubrange(at..<end, with: inserted)
        if removed > 0, splice["outcome"].string != "canceled" {
            claimed = Set(taken.map(\.id))
            claimSeq = seq
            claimedHuman = taken.contains(where: \.human)
            claimUnknown = taken.count < removed
        } else {
            claimed.subtract(inserted.map(\.id))
        }
    }
}

/// Folds durable events into timeline items one at a time, so a new event costs
/// one step instead of re-walking (and re-decoding) the whole history.
struct TimelineBuilder {
    private(set) var items: [TimelineItem] = []
    /// Set before folding when the turn's start may lie before the loaded window; `turn/end` clears it.
    var running = false
    private(set) var title: String?
    /// Seq of each turn's `turn/end`: the inclusive boundary for forking after that turn.
    private(set) var turnEndSeq: [Int: Int] = [:]
    private(set) var turnInfo: [Int: TurnInfo] = [:]
    /// When the open turn started, for the running timer.
    var runningSince: Date? { running ? currentTurn.flatMap { turnInfo[$0]?.startedAt } : nil }
    /// Older pages exist, so a `todo_write` without a recorded list has an unknown baseline.
    var historyComplete = true
    private var toolIndex: [String: (item: Int, block: Int)] = [:]
    private var currentTurn: Int?
    private var turnStartSeq: Int?
    /// Last recorded `todo/write` list.
    private var lastTodos: [TodoItem]?
    /// Summaries by compaction, until its end adds the card.
    private var compactions: [String: (items: Int?, tokens: Int?, summary: String?)] = [:]
    /// `/compact` runs replaced by their compaction card; their `command/done` adds nothing.
    private var replacedCommands: Set<String> = []
    private var commandOutcomes: [String: String] = [:]
    private var nextTurnInbox = InboxState()
    private var nextStepInbox = InboxState()
    private var currentStep: Int?

    /// Apply one event; returns whether `items` changed.
    @discardableResult
    mutating func apply(_ event: JSON) -> Bool {
        let data = event["data"]
        let seq = event["seq"].int ?? 0
        let time = Date(timeIntervalSince1970: (event["time"].double ?? 0) / 1000)
        switch event["type"].string {
        case "user/message":
            return applyUserMessage(data, seq: seq, time: time, surfaceOp: event["surfaceOp"])
        case "agent/inbox/spliced":
            switch data["target"].string {
            case "next-turn": nextTurnInbox.apply(data, seq: seq)
            case "next-step": nextStepInbox.apply(data, seq: seq)
            default: break
            }
            return false
        case "step/start":
            currentStep = data["step"].int
            return false
        case "turn/start":
            let turn = data["turn"].int ?? currentTurn.map { $0 + 1 } ?? 0
            currentTurn = turn
            running = true
            turnInfo[turn, default: TurnInfo()].startedAt = time
            turnStartSeq = seq
            currentStep = nil
            return false
        case "turn/end":
            return applyTurnEnd(data, seq: seq, time: time)
        case "assistant/message":
            return applyAssistantMessage(data, seq: seq, time: time)
        case "assistant/attempt":
            // An attempt that never became a message has usage this fold does not add up.
            if let turn = data["turn"].int { turnInfo[turn, default: TurnInfo()].usageBroken = true }
            return false
        case "tool/result":
            // Pruning rewrites old results for the model under the same call id; the card keeps the original.
            if !event["surfaceOp"].isNull, event["surfaceOp"].string != "append" { return false }
            return applyToolResult(data)
        case "todo/write":
            lastTodos = data["todos"].array.map { TodoItem(content: $0["content"].string ?? "", status: $0["status"].string ?? "pending") }
            return false
        case "deliverables/presented":
            let turn = data["turn"].int ?? currentTurn ?? 0
            var info = turnInfo[turn] ?? TurnInfo()
            for file in data["files"].array {
                guard let path = file["path"].string else { continue }
                info.deliverables.removeAll { $0.path == path }
                info.deliverables.append(Deliverable(path: path, description: file["description"].string))
            }
            turnInfo[turn] = info
            return true
        case "compaction/summary":
            let id = data["compactionId"].string ?? ""
            let text = data["summary"].array.compactMap { $0["type"].string == "text" ? $0["text"].string : nil }.joined()
            compactions[id] = (data["shadowedSeqs"].isNull ? nil : data["shadowedSeqs"].array.count, data["shadowedTokenCount"].int, text.isEmpty ? nil : text)
            return false
        case "compaction/end":
            guard data["error"].isNull else { return false }
            let summary = compactions.removeValue(forKey: data["compactionId"].string ?? "")
            var card = CompactionCard(seq: seq, items: summary?.items, tokens: summary?.tokens, summary: summary?.summary)
            if let command = data["sourceCommandId"].string {
                replacedCommands.insert(command)
                card.outcome = commandOutcomes[command]
                // The card takes the place of `/compact`'s running line.
                if let index = items.lastIndex(where: { if case .command(let run) = $0 { return run.id == command }; return false }) {
                    items[index] = .compaction(card)
                    return true
                }
            }
            items.append(.compaction(card))
            return true
        case "llm/retry":
            return applyRetry(data, time: time)
        case "llm/retry-started":
            return updateRetry(data["retryId"].string) { $0.phase = .started }
        case "step/end":
            return settleRetries(turn: data["turn"].int)
        case "command/run":
            let id = data["commandId"].string ?? "\(seq)"
            items.append(.command(CommandRun(id: id, name: data["name"].string ?? String(localized: "指令"))))
            return true
        case "command/done":
            return applyCommandDone(data, seq: seq)
        case "session/title":
            title = data["title"].string ?? title
            return false
        default:
            return false
        }
    }

    private mutating func applyUserMessage(_ data: JSON, seq: Int, time: Date, surfaceOp: JSON) -> Bool {
        let content = data["content"].array
        let text = content.filter { $0["type"].string == "text" }.compactMap { $0["text"].string }.joined(separator: "\n")
        let source = data["source"]
        let kind = source["kind"].string
        let id = data["id"].string
        if kind == "compact-checkpoint" { return false }
        // Replacements rewrite earlier history for the model; they are not new input.
        if !surfaceOp.isNull, surfaceOp.string != "append" { return false }
        if kind == "user-question-reply" {
            items.append(.questionReply(QuestionReply(seq: seq, time: time, text: text)))
            return true
        }
        // Only what the user typed is a user turn: harness injections (time context,
        // reminders) have other source kinds and stay hidden, except what woke this turn.
        if let kind, kind != "user" {
            let claimed = id.map { nextTurnInbox.claimed.contains($0) } ?? false
            guard claimed || idleSteer(id) || (nextTurnInbox.claimUnknown && TurnTrigger.wakingKinds.contains(kind)) else { return false }
            items.append(.trigger(TurnTrigger(seq: seq, time: time, source: source, body: text)))
            return true
        }
        // Taken from the next-step inbox: it joined a running turn.
        if let turn = currentTurn, let id, nextStepInbox.claimed.contains(id) { turnInfo[turn, default: TurnInfo()].steered = true }
        let attachments = content.filter { $0["type"].string != "text" }.map(Attachment.init(block:))
        items.append(.user(seq: seq, text: text, attachments: attachments, requestId: source["rpcId"].string))
        return true
    }

    /// A notification that reached an idle session through the next-step inbox wakes its turn too.
    private func idleSteer(_ id: String?) -> Bool {
        guard let id, currentStep == 1, let turnStartSeq else { return false }
        return nextStepInbox.claimSeq > turnStartSeq && nextTurnInbox.claimSeq < turnStartSeq
            && !nextStepInbox.claimedHuman && nextStepInbox.claimed.contains(id)
    }

    private mutating func applyTurnEnd(_ data: JSON, seq: Int, time: Date) -> Bool {
        running = false
        let turn = data["turn"].int ?? currentTurn ?? 0
        turnEndSeq[turn] = seq
        var changed = settleRetries(turn: turn)
        turnInfo[turn, default: TurnInfo()].closedKind = data["reason"]["kind"].string ?? "completed"
        // The last item of the turn closes it, even when a retry or notice came after it.
        if let index = items.lastIndex(where: { if case .assistant(let t, _, _, _) = $0 { return t == turn }; return false }),
           case .assistant(let t, var blocks, let started, _) = items[index] {
            // A call with no result when its turn closed never finished; the web closes it the same way.
            for (position, block) in blocks.enumerated() {
                if case .tool(var call) = block, !call.finished {
                    call.result = ""
                    call.isError = true
                    call.errorCode = "interrupted"
                    call.errorName = "Interrupted"
                    blocks[position] = .tool(call)
                }
            }
            items[index] = .assistant(turn: t, blocks: blocks, startedAt: started, endedAt: time)
            changed = true
        }
        if let failure = TurnFailure(reason: data["reason"]) {
            if let problem = failure.credentialProblem {
                items.append(.credential(seq: seq, problem: problem))
            } else {
                items.append(.notice(seq: seq, text: failure.message, isError: true))
            }
            changed = true
        } else if data["reason"]["kind"].string == "max-tokens" {
            items.append(.maxTokens(seq: seq))
            changed = true
        } else if data["reason"]["kind"].string == "aborted" || data["reason"].string == "cancelled" || data["outcome"].string == "cancelled" {
            items.append(.notice(seq: seq, text: String(localized: "已中断"), isError: false))
            changed = true
        }
        return changed
    }

    private mutating func applyAssistantMessage(_ data: JSON, seq: Int, time: Date) -> Bool {
        let turn = data["turn"].int ?? currentTurn ?? 0
        var blocks: [AssistantBlock] = []
        var texts: [String] = []
        for (index, part) in data["message"]["content"].array.enumerated() {
            let id = "\(seq)-\(index)"
            switch part["type"].string {
            case "reasoning":
                if let text = part["text"].string, !text.isEmpty { blocks.append(.reasoning(id: id, text: text)) }
            case "text":
                if let text = part["text"].string, !text.isEmpty {
                    blocks.append(.text(id: id, text: text))
                    texts.append(text)
                }
            case "image":
                blocks.append(.image(id: id, attachment: Attachment(block: part)))
            case "tool-call":
                let raw = part["arguments"].string ?? ""
                let args = (try? JSONDecoder().decode(JSON.self, from: Data(raw.utf8))) ?? part["arguments"]
                var call = ToolCall(id: part["id"].string ?? id, name: part["name"].string ?? "tool", arguments: args, rawArguments: raw)
                if call.displayName == "todo_write" {
                    call.previousTodos = lastTodos
                    call.historyComplete = historyComplete
                }
                blocks.append(.tool(call))
            default:
                break
            }
        }
        var info = turnInfo[turn] ?? TurnInfo()
        let closing = texts.joined()
        if !closing.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            info.closingTime = time
            info.closingText = closing
        }
        let exact = !data["usage"]["totalTokens"].isNull || (!data["usage"]["cacheReadTokens"].isNull && !data["usage"]["cacheWriteTokens"].isNull)
        // Without the turn's start or an exact count the sum would be a guess; the capsule hides.
        if info.startedAt == nil || !exact { info.usageBroken = true }
        if !data["usage"].isNull {
            var usage = info.usage ?? TurnUsage()
            let source = data["message"]["source"]
            usage.add(data["usage"], route: source["provider"].string.flatMap { provider in source["model"].string.map { "\(provider) / \($0)" } })
            info.usage = usage
        } else {
            info.usageBroken = true
        }
        turnInfo[turn] = info
        let offset: Int
        if case .assistant(let t, var existing, let started, _) = items.last, t == turn {
            offset = existing.count
            existing.append(contentsOf: blocks)
            items[items.count - 1] = .assistant(turn: t, blocks: existing, startedAt: started, endedAt: nil)
        } else {
            offset = 0
            items.append(.assistant(turn: turn, blocks: blocks, startedAt: time, endedAt: nil))
        }
        for (index, block) in blocks.enumerated() {
            if case .tool(let call) = block { toolIndex[call.id] = (items.count - 1, offset + index) }
        }
        return true
    }

    private mutating func applyToolResult(_ data: JSON) -> Bool {
        let message = data["message"]
        guard let callId = message["toolCallId"].string ?? message["source"]["callId"].string ?? data["callId"].string,
              let location = toolIndex[callId],
              case .assistant(let t, var blocks, let started, let ended) = items[location.item],
              case .tool(var call) = blocks[location.block] else { return false }
        let content = message["content"].array
        call.result = content.compactMap { $0["type"].string == "text" ? $0["text"].string : nil }.joined(separator: "\n")
        call.resultImages = content.filter { $0["type"].string == "image" }.map(Attachment.init(block:))
        call.isError = message["isError"].bool ?? data["isError"].bool ?? false
        call.errorCode = data["error"]["code"].string
        call.errorName = data["error"]["name"].string
        call.errorReason = data["error"]["reason"].string
        call.meta = data["meta"]
        blocks[location.block] = .tool(call)
        items[location.item] = .assistant(turn: t, blocks: blocks, startedAt: started, endedAt: ended)
        // What a closing message may refer to by name (C-24).
        if !call.isError, ["write", "edit", "str_replace_editor"].contains(call.displayName),
           let path = call.arguments["file_path"].string ?? call.arguments["path"].string {
            var info = turnInfo[t] ?? TurnInfo()
            if !info.producedPaths.contains(path) { info.producedPaths.append(path) }
            turnInfo[t] = info
        }
        return true
    }

    private mutating func applyRetry(_ data: JSON, time: Date) -> Bool {
        let id = data["retryId"].string ?? ""
        let turn = data["turn"].int
        if let turn { turnInfo[turn, default: TurnInfo()].usageBroken = true }
        let maximum = data["mode"].string == "normal" ? data["maxRetries"].int : nil
        let state = RetryState(
            id: id, retry: data["retry"].int ?? 1, maximum: maximum, delayMs: data["delayMs"].int ?? 0,
            failure: RetryState.failureText(data["failure"]), scheduledAt: time, turn: turn
        )
        if updateRetry(id, { $0 = state }) { return true }
        items.append(.retry(state))
        return true
    }

    private mutating func updateRetry(_ id: String?, _ change: (inout RetryState) -> Void) -> Bool {
        guard let id, let index = items.lastIndex(where: { if case .retry(let state) = $0 { return state.id == id }; return false }),
              case .retry(var state) = items[index] else { return false }
        change(&state)
        items[index] = .retry(state)
        return true
    }

    /// A step or turn that closes with a retry still scheduled cancelled it.
    private mutating func settleRetries(turn: Int?) -> Bool {
        var changed = false
        for (index, item) in items.enumerated() {
            if case .retry(var state) = item, state.phase == .scheduled, state.turn == turn {
                state.phase = .cancelled
                items[index] = .retry(state)
                changed = true
            }
        }
        return changed
    }

    private mutating func applyCommandDone(_ data: JSON, seq: Int) -> Bool {
        let id = data["commandId"].string ?? ""
        let failed = data["kind"].string == "error"
        let text = data["text"].string
        if let text { commandOutcomes[id] = text }
        if replacedCommands.contains(id) {
            guard let index = items.lastIndex(where: { if case .compaction = $0 { return true }; return false }),
                  case .compaction(var card) = items[index], card.outcome == nil, let text else { return false }
            card.outcome = text
            items[index] = .compaction(card)
            return true
        }
        if let index = items.lastIndex(where: { if case .command(let run) = $0 { return run.id == id }; return false }),
           case .command(var run) = items[index] {
            run.done = true
            run.failed = failed
            run.text = text
            items[index] = .command(run)
            return true
        }
        // Its run lies before the loaded window.
        guard let text, !text.isEmpty else { return false }
        items.append(.notice(seq: seq, text: text, isError: failed))
        return true
    }
}
