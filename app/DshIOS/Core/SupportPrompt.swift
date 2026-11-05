import UIKit

/// When to ask for a Star or a share, after Orca's star nag: only right after a turn went
/// well, a few turns in, and rarely. An ignored ask waits three days and twice the turns; the
/// third is the last. GitHub can't say from here who has starred, so the first tap settles it.
@MainActor
enum SupportPrompt {
    private static let turnsKey = "dsh.support.turns"
    private static let asksKey = "dsh.support.asks"
    private static let notBeforeKey = "dsh.support.notBefore"
    private static let settledKey = "dsh.support.settled"

    private static let firstAsk = 5
    private static let lastAsk = 3
    private static let cooldown: TimeInterval = 3 * 24 * 60 * 60

    /// Counts a turn that finished well; true when an ask is due.
    static func noteCompletedTurn() -> Bool {
        let defaults = UserDefaults.standard
        guard !defaults.bool(forKey: settledKey) else { return false }
        let turns = defaults.integer(forKey: turnsKey) + 1
        defaults.set(turns, forKey: turnsKey)
        return isDue
    }

    /// The ask to make now: each is spent here, whatever becomes of it.
    static func take() -> Bool {
        guard isDue else { return false }
        let defaults = UserDefaults.standard
        defaults.set(defaults.integer(forKey: asksKey) + 1, forKey: asksKey)
        defaults.set(0, forKey: turnsKey)
        defaults.set(Date.now.addingTimeInterval(cooldown).timeIntervalSince1970, forKey: notBeforeKey)
        return true
    }

    /// They went to the repository or the share sheet: never ask again.
    static func settle() { UserDefaults.standard.set(true, forKey: settledKey) }

    private static var isDue: Bool {
        let defaults = UserDefaults.standard
        let asks = defaults.integer(forKey: asksKey)
        return !defaults.bool(forKey: settledKey) && asks < lastAsk
            && defaults.integer(forKey: turnsKey) >= firstAsk << asks
            && Date.now.timeIntervalSince1970 >= defaults.double(forKey: notBeforeKey)
    }
}

/// The app's links, and the message that passes them on.
@MainActor
enum AppLinks {
    static let repository = URL(string: "https://github.com/\(UpdateChecker.repository)")!
    private static let testFlight = URL(string: "https://testflight.apple.com/join/2SCftb2M")!

    /// The App Store once it answers for the app, the public beta until then.
    static var shareText: String {
        let download = UpdateChecker.shared.storePage ?? testFlight
        return String(localized: "Fish Pocket：在 iPhone 和 iPad 上本机运行 DeepSeek Harness，不连电脑，不连服务器。\n下载：\(download.absoluteString)\nGitHub：\(repository.absoluteString)")
    }

    /// The share sheet, from where SwiftUI can't start one (`ShareLink` needs its own tap).
    static func share() {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
        guard let window = scene?.keyWindow, var top = window.rootViewController else { return }
        while let presented = top.presentedViewController, !presented.isBeingDismissed { top = presented }
        let controller = UIActivityViewController(activityItems: [shareText], applicationActivities: nil)
        // iPad shows it as a popover, which needs an anchor: the toast's place, at the bottom.
        controller.popoverPresentationController?.sourceView = window
        controller.popoverPresentationController?.sourceRect = CGRect(x: window.bounds.midX, y: window.bounds.maxY - 80, width: 0, height: 0)
        top.present(controller, animated: true)
    }
}
