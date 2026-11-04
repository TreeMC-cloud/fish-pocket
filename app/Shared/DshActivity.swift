import ActivityKit
import AppIntents
import Foundation

/// The Live Activity (lock screen and Dynamic Island) while agent work runs.
/// Compiled into the app and the widget extension; the app starts and updates
/// it (`LiveActivityController`), the extension draws it.
struct DshActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        enum Phase: String, Codable { case running, approval, question, done }

        var phase: Phase
        /// The session in focus: the one waiting on the user, else the latest running one.
        var sessionId: String
        var title: String
        /// Other sessions running or waiting besides the one in focus.
        var others: Int
        /// The approval reason or the open question.
        var detail: String?
        /// The approval the buttons answer.
        var approval: Approval?
        var startedAt: Date
        var endedAt: Date?

        struct Approval: Codable, Hashable {
            var eventId: String
            var agentId: String
        }

        var url: URL { URL(string: "dsh://session/\(sessionId)")! }
    }
}

/// 允许 / 拒绝 on the Live Activity. A `LiveActivityIntent` runs in the app's
/// process, where the engine connection answers the approval.
struct AnswerApprovalIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "答复工具审批"
    static var isDiscoverable = false

    @Parameter(title: "事件") var eventId: String
    @Parameter(title: "会话") var agentId: String
    @Parameter(title: "允许") var allow: Bool

    init() {}

    init(eventId: String, agentId: String, allow: Bool) {
        self.eventId = eventId
        self.agentId = agentId
        self.allow = allow
    }

    func perform() async throws -> some IntentResult {
        await DshActivityBridge.answer(eventId: eventId, agentId: agentId, allow: allow)
        return .result()
    }
}

/// Set by the app once connected; nil in the extension (intents never run there).
enum DshActivityBridge {
    @MainActor static var handler: ((_ eventId: String, _ agentId: String, _ allow: Bool) async -> Void)?

    @MainActor static func answer(eventId: String, agentId: String, allow: Bool) async {
        await handler?(eventId, agentId, allow)
    }
}
