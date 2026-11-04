import AVFoundation
import BackgroundTasks
import SwiftUI
import UIKit

/// Keeps the engine running while the app is off screen. iOS suspends the whole
/// process shortly after the app leaves the screen, and with it Node: agent
/// turns, automations and dev servers all freeze until the app comes back.
///
/// - Always: a UIKit background task gives in-flight turns the usual ~30 s
///   grace, ended early once nothing is running.
/// - The 设置 → 后台运行 →「静音音频」switch (on by default): silent, mixable audio keeps the
///   process alive for as long as it stays in the background (the `audio`
///   background mode), so automations and dev servers keep going too. It is an
///   indirect means, hence the user-facing switch.
/// - The 设置 → 后台运行 →「任务续跑」switch (iOS 26+, off by default): a
///   `BGContinuedProcessingTask` when the app leaves the screen with sessions
///   running, so a turn can finish off screen; the system shows its progress and
///   the user can stop it there. Not submitted for work the user watches to the end.
@MainActor
final class BackgroundKeeper {
    static let shared = BackgroundKeeper()
    static let enabledKey = "backgroundKeepAlive"
    static let continuedKey = "continuedProcessing"
    /// Matches `BGTaskSchedulerPermittedIdentifiers` in project.yml.
    private static let taskPrefix = (Bundle.main.bundleIdentifier ?? "com.wsw.dsh-ios") + ".task"

    /// Silent audio.
    var enabled: Bool { UserDefaults.standard.object(forKey: Self.enabledKey) as? Bool ?? true }
    /// Continued-processing tasks.
    var continuedEnabled: Bool { UserDefaults.standard.bool(forKey: Self.continuedKey) }

    private var inBackground = false
    /// Between losing focus and going to the background: the last moment a continued task can be submitted.
    private var leaving = false
    private var running: [String] = []
    /// Re-reads the session list; set by the current engine connection.
    private var refresh: (() async -> Void)?
    private var grace: UIBackgroundTaskIdentifier = .invalid
    private var pollTask: Task<Void, Never>?
    /// The live `BGContinuedProcessingTask` (typed loosely: the deployment target is iOS 17).
    private var continued: AnyObject?
    private var submitted: String?
    /// The scheduler refused this round, or the user stopped it: no new request
    /// until the sessions go idle.
    private var halted = false
    private let audio = SilentAudio()

    private init() {}

    func attach(refresh: @escaping () async -> Void) {
        self.refresh = refresh
    }

    /// The titles of running sessions, after every session-list refresh. Each
    /// refresh follows engine activity, so while busy it also counts as progress.
    func update(running titles: [String]) {
        running = titles
        if titles.isEmpty {
            finishContinued()
            if inBackground && !enabled { endGrace() }
            return
        }
        if leaving { startContinued() }
        tick()
    }

    /// A switch changed; while off screen it takes effect at once. Turning 任务续跑
    /// off ends a live or pending task; turning it on applies from the next time
    /// the app leaves the screen (requests can only be submitted in the foreground).
    func settingsChanged() {
        if !continuedEnabled { finishContinued() }
        guard inBackground else { return }
        if enabled { audio.start() } else { audio.stop() }
    }

    func scenePhaseChanged(to phase: ScenePhase) {
        switch phase {
        case .active:
            leaving = false
            inBackground = false
            pollTask?.cancel()
            audio.stop()
            endGrace()
        case .background:
            leaving = false
            guard !inBackground else { return }
            inBackground = true
            beginGrace()
            if enabled { audio.start() }
            poll()
        default:
            // Still in the foreground: submit for what is running, and refresh for
            // work the cached list missed (an automation, a session not on screen).
            leaving = !inBackground
            if leaving { startContinued() }
            Task { await refresh?() }
        }
    }

    // MARK: Grace period

    private func beginGrace() {
        guard grace == .invalid else { return }
        grace = UIApplication.shared.beginBackgroundTask(withName: "dsh-engine") { [weak self] in
            MainActor.assumeIsolated { self?.endGrace() }
        }
    }

    private func endGrace() {
        guard grace != .invalid else { return }
        UIApplication.shared.endBackgroundTask(grace)
        grace = .invalid
    }

    /// Off screen no view drives refreshes; ask the engine directly.
    private func poll() {
        pollTask?.cancel()
        pollTask = Task {
            while !Task.isCancelled {
                await refresh?()
                try? await Task.sleep(for: .seconds(10))
            }
        }
    }

    // MARK: Continued processing (iOS 26)

    private var subtitle: String {
        running.count == 1 ? running[0] : String(localized: "\(running.count) 个会话进行中")
    }

    private func startContinued() {
        guard #available(iOS 26.0, *), continuedEnabled, !running.isEmpty, continued == nil, submitted == nil, !halted else { return }
        // Info.plist permits `<prefix>.*`; handlers are registered per concrete
        // identifier (registering the wildcard itself is not supported), and
        // continued-processing handlers may be registered after launch.
        let identifier = "\(Self.taskPrefix).\(UUID().uuidString)"
        let registered = BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) { task in
            MainActor.assumeIsolated { self.run(task) }
        }
        guard registered else { return }
        let request = BGContinuedProcessingTaskRequest(identifier: identifier, title: String(localized: "DSH 任务进行中"), subtitle: subtitle)
        request.strategy = .fail
        do {
            try BGTaskScheduler.shared.submit(request)
            submitted = identifier
        } catch {
            halted = true
            print("[keepalive] continued task not submitted: \(error)")
        }
    }

    @available(iOS 26.0, *)
    private func run(_ task: BGTask) {
        guard let task = task as? BGContinuedProcessingTask else { return }
        submitted = nil
        guard continuedEnabled, !running.isEmpty else {
            task.setTaskCompleted(success: true)
            return
        }
        continued = task
        task.progress.totalUnitCount = 10
        task.expirationHandler = { [weak self] in
            Task { @MainActor in
                guard let self, self.continued === task else { return }
                self.continued = nil
                self.halted = true
                task.setTaskCompleted(success: false)
            }
        }
        tick()
    }

    /// The end of agent work is unknown, so the bar keeps moving without filling:
    /// n events show as n / (n + 10).
    private func tick() {
        guard #available(iOS 26.0, *), let task = continued as? BGContinuedProcessingTask else { return }
        task.progress.completedUnitCount += 1
        task.progress.totalUnitCount = task.progress.completedUnitCount + 10
        task.updateTitle(String(localized: "DSH 任务进行中"), subtitle: subtitle)
    }

    private func finishContinued() {
        guard #available(iOS 26.0, *) else { return }
        halted = false
        if let identifier = submitted {
            BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier)
            submitted = nil
        }
        guard let task = continued as? BGContinuedProcessingTask else { return }
        continued = nil
        task.progress.completedUnitCount = task.progress.totalUnitCount
        task.setTaskCompleted(success: true)
    }
}

/// Plays silence through a mixable `.playback` session: the app keeps running
/// in the background without taking over the user's audio or Now Playing.
@MainActor
private final class SilentAudio {
    private var engine: AVAudioEngine?
    private var observers: [NSObjectProtocol] = []

    func start() {
        guard engine == nil else { return }
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, options: [.mixWithOthers])
            try AVAudioSession.sharedInstance().setActive(true)
            let engine = AVAudioEngine()
            let player = AVAudioPlayerNode()
            let format = AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 1)!
            let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 44_100)!
            buffer.frameLength = buffer.frameCapacity
            memset(buffer.floatChannelData![0], 0, Int(buffer.frameLength) * MemoryLayout<Float>.size)
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: format)
            try engine.start()
            player.scheduleBuffer(buffer, at: nil, options: .loops)
            player.play()
            self.engine = engine
        } catch {
            print("[keepalive] silent audio failed: \(error)")
            return
        }
        // A call or another app's non-mixable audio stops the engine; resume after it.
        let center = NotificationCenter.default
        observers = [
            center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
                let ended = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) == AVAudioSession.InterruptionType.ended.rawValue
                if ended { MainActor.assumeIsolated { self?.restart() } }
            },
            center.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.restart() }
            },
        ]
    }

    func stop() {
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        guard let engine else { return }
        engine.stop()
        self.engine = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func restart() {
        guard engine != nil else { return }
        stop()
        start()
    }
}
