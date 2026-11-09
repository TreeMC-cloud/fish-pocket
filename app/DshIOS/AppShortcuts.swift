import AppIntents

/// What Siri and the Shortcuts app offer without any setup. The phrases are
/// translated in AppShortcuts.xcstrings; each must name the app.
struct DshShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: NewConversationIntent(),
            phrases: [
                "用 \(.applicationName) 新建对话",
                "在 \(.applicationName) 里开始新对话",
                "\(.applicationName) 新对话",
            ],
            shortTitle: "新对话",
            systemImageName: "square.and.pencil"
        )
    }
}
