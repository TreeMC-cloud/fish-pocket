import SwiftUI

/// What the window in front can do. Its menu bar and keyboard shortcuts (iPad, or
/// any hardware keyboard) reach it through the focused scene.
struct WindowCommands {
    var newConversation: () -> Void
    /// Nil where the system has one window.
    var newWindow: (() -> Void)?
    var search: () -> Void
    var toggleSidebar: () -> Void
    var openSettings: () -> Void
}

/// The conversation in that window. A blank one has no workbench.
struct WorkbenchCommands {
    var available: Bool
    var toggle: () -> Void
    var open: (WorkbenchTab) -> Void
}

extension FocusedValues {
    @Entry var windowCommands: WindowCommands?
    @Entry var workbenchCommands: WorkbenchCommands?
}

/// The keys follow macOS habits (⌘N, ⌘,) and the desktop client's where it has one.
struct ShellCommands: Commands {
    @FocusedValue(\.windowCommands) private var window
    @FocusedValue(\.workbenchCommands) private var conversation

    private var workbench: WorkbenchCommands? { conversation?.available == true ? conversation : nil }

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("新对话") { window?.newConversation() }
                .keyboardShortcut("n")
                .disabled(window == nil)
            if let newWindow = window?.newWindow {
                Button("新窗口", action: newWindow)
                    .keyboardShortcut("n", modifiers: [.command, .shift])
            }
        }
        CommandGroup(replacing: .appSettings) {
            Button("设置…") { window?.openSettings() }
                .keyboardShortcut(",")
                .disabled(window == nil)
        }
        CommandMenu("会话") {
            Button("搜索会话") { window?.search() }
                .keyboardShortcut("k")
                .disabled(window == nil)
            Button("显示或隐藏侧边栏") { window?.toggleSidebar() }
                .keyboardShortcut("b")
                .disabled(window == nil)
        }
        CommandMenu("工作台") {
            Button("显示或隐藏工作台") { workbench?.toggle() }
                .keyboardShortcut("b", modifiers: [.command, .option])
                .disabled(workbench == nil)
            Divider()
            tab(.terminal).keyboardShortcut("`", modifiers: .control)
            tab(.files).keyboardShortcut("p")
            tab(.browser).keyboardShortcut("t")
            tab(.changes).keyboardShortcut("d", modifiers: [.command, .shift])
            tab(.context)
        }
    }

    private func tab(_ tab: WorkbenchTab) -> some View {
        Button(tab.title) { workbench?.open(tab) }.disabled(workbench == nil)
    }
}
