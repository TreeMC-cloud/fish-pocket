import AppIntents
import SwiftUI
import WidgetKit

/// 新对话 in Control Center, and in place of the lock screen's flashlight or camera
/// button, or on the Action button (iOS 18). It opens the app on a new conversation.
@available(iOS 18.0, *)
struct NewConversationControl: ControlWidget {
    static let kind = "DshNewConversationControl"

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: Self.kind) {
            ControlWidgetButton(action: NewConversationIntent()) {
                Label("新对话", systemImage: "square.and.pencil")
            }
        }
        .displayName("新对话")
        .description("打开 Fish Pocket，开始一个新对话。")
    }
}
