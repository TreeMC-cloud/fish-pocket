import AppIntents
import Foundation

/// Siri / 快捷指令 / 控制中心按钮触发的「新对话」。
///
/// 为什么需要这条桥：Intent 由系统在**主 App 进程**里执行（`openAppWhenRun = true`），
/// 但它拿不到 SwiftUI 的环境对象（`AppModel`）。所以约定一个静态闭包：
/// App 启动时把「怎么处理」装进去，Intent 执行时就调它。
///
/// 这与上游的做法一致，只是我们的分支没有 `DshLink` 那套 URL 分发层，
/// 所以直接借用已有的 `AppModel.newSessionRequest`（它本来就支持 draft），
/// 不必再造一个 LinkInbox。
@MainActor
enum DshIntentBridge {
    /// App 启动时赋值；扩展里为 nil（Intent 不会在那里跑）。
    static var newConversation: ((_ draft: String?) -> Void)?
}

struct NewConversationIntent: AppIntent {
    static var title: LocalizedStringResource = "新对话"
    static var description = IntentDescription("打开 Sigma，开始一个新对话。")
    static var openAppWhenRun = true

    @Parameter(title: "草稿", description: "放进输入框，不会自动发送。")
    var draft: String?

    init() {}

    init(draft: String?) {
        self.draft = draft
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        DshIntentBridge.newConversation?(draft?.isEmpty == false ? draft : nil)
        return .result()
    }
}
