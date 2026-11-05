import SwiftUI

@main
struct DshIOSApp: App {
    /// The one kind of window; its value says which session it opens on, if any.
    static let window = "conversation"

    @StateObject private var engine = NodeEngine.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup(id: Self.window, for: SessionWindow.self) { $window in
            RootView(session: window?.session)
                .environmentObject(engine)
                .onAppear { engine.start() }
        }
        .commands { ShellCommands() }
        .onChange(of: scenePhase) { _, phase in
            BackgroundKeeper.shared.scenePhaseChanged(to: phase)
            LiveActivityController.shared.scenePhaseChanged(to: phase)
        }
    }
}

/// A window opened on a session. It moves on to other sessions from there, so the token keeps
/// the system from taking a later request for the same session as one for this window.
struct SessionWindow: Codable, Hashable {
    var session: String
    var token = UUID()
}

/// The app's connection to the engine, one however many windows are open: they show
/// the same sessions, and the Live Activity and background work follow one model.
/// Each engine generation (a new listening URL after a restart) gets a fresh one.
@MainActor
@Observable
final class EngineConnection {
    static let shared = EngineConnection()

    private(set) var app: AppModel?
    /// The generation being connected or connected; windows that arrive during it just wait.
    @ObservationIgnored private var generation: Int?

    func connect(to url: URL, generation current: Int) async {
        guard current != generation else { return }
        generation = current
        let model = AppModel(launchURL: url)
        await model.connect()
        if current == generation { app = model }
    }
}

/// Engine start-up, then the native interface.
struct RootView: View {
    /// The session this window opened on.
    let session: String?
    @EnvironmentObject private var engine: NodeEngine
    @AppStorage(ThemePreference.key) private var themePreference = ThemePreference.system
    private let connection = EngineConnection.shared

    var body: some View {
        content.background(WindowAppearance(style: ThemePreference.style(themePreference)))
    }

    @ViewBuilder
    private var content: some View {
        switch engine.phase {
        case .starting:
            // Long enough and it is not slow, it is stuck: say so and hand over the log.
            if engine.stalled {
                EngineTrouble(headline: String(localized: "引擎还没起来"), since: engine.startedAt, logFile: engine.logFile)
            } else {
                StartupView(message: String(localized: "正在启动 DSH 引擎…"))
            }
        case .running(let url, let current):
            Group {
                if let app = connection.app {
                    MainView(session: session)
                        .environment(app)
                } else {
                    StartupView(message: String(localized: "正在连接…"))
                }
            }
            .task(id: current) { await connection.connect(to: url, generation: current) }
        case .exited(let code):
            EngineTrouble(headline: String(localized: "引擎已退出（\(code)）"), since: nil, logFile: engine.logFile)
        }
    }
}

/// Continues the launch screen: the mark stays centred, the state appears under it.
private struct StartupView: View {
    let message: String

    var body: some View {
        Image("LaunchMark")
            .accessibilityHidden(true)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(message)
                }
                .font(.subheadline)
                .foregroundStyle(Palette.secondary)
                .offset(y: 72)
            }
            .background(Palette.background)
            .ignoresSafeArea()
    }
}

/// The engine never reached the interface: it is still being retried long past a
/// normal launch, or it has exited. `engine.log` says which and why, and it was only
/// reachable through 设置 → 引擎日志 — behind the interface that is missing. A launch that
/// hangs is not a crash, so App Store Connect is told nothing about it either: what
/// someone copies here is the only account of it there will ever be.
private struct EngineTrouble: View {
    let headline: String
    /// When the wait began, for the running count; nil once the engine has exited.
    let since: Date?
    let logFile: URL

    @State private var log = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text(headline).font(.headline).foregroundStyle(Palette.ink)
                // One Text: a stack would space the counter off the comma after it.
                if let since {
                    Text("已等待 ") + Text(since, style: .timer).monospacedDigit() + Text("，还在重试")
                }
                Text("下面是引擎日志。复制或分享出去，就能看出卡在哪一步。")
            }
            .font(.subheadline)
            .foregroundStyle(Palette.secondary)

            ScrollView {
                Text(log.isEmpty ? String(localized: "（日志还是空的）") : log)
                    .font(.caption2.monospaced())
                    .foregroundStyle(Palette.ink)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
            }
            .defaultScrollAnchor(.bottom)
            .background(Palette.grouped, in: RoundedRectangle(cornerRadius: 12, style: .continuous))

            HStack(spacing: 12) {
                Button("复制报告") { copyToPasteboard(report()) }
                    .buttonStyle(.capsule(.primary, height: 44))
                if FileManager.default.fileExists(atPath: logFile.path) {
                    ShareLink(item: logFile) { Text("分享日志") }
                        .buttonStyle(.capsule(.secondary, height: 44))
                }
            }
        }
        .padding(16)
        .readableWidth()
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Palette.background.ignoresSafeArea())
        .task {
            // A failing boot writes another round of errors every few seconds, so keep
            // up with it: what is on screen is what gets copied.
            while !Task.isCancelled {
                load()
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    /// One paste that carries the whole picture: which build, which device, how long it
    /// has been, then the log. Without the first three lines a report is 「它卡住了」.
    private func report() -> String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "—"
        let build = info?["CFBundleVersion"] as? String ?? "—"
        var lines = [
            "Fish Pocket \(version) (\(build))",
            "\(deviceModel()) · iOS \(UIDevice.current.systemVersion)",
            headline,
        ]
        if let since { lines.append("已等待 \(Int(Date().timeIntervalSince(since))) 秒") }
        return lines.joined(separator: "\n") + "\n\n" + (log.isEmpty ? "（日志还是空的）" : log)
    }

    /// `iPhone18,1` and the like. The marketing name is what someone writes by hand and
    /// gets wrong; this is what tells one model from another.
    private func deviceModel() -> String {
        // A simulator's `machine` is the Mac's architecture, which would name the wrong
        // device in a report; it says which one it stands in for in the environment.
        if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] {
            return "\(simulated)（模拟器）"
        }
        var system = utsname()
        uname(&system)
        return withUnsafeBytes(of: &system.machine) {
            String(cString: $0.baseAddress!.assumingMemoryBound(to: CChar.self))
        }
    }

    /// The tail is enough to see the failure repeat, and keeps a paste pasteable.
    private func load() {
        guard let handle = try? FileHandle(forReadingFrom: logFile) else { return }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        try? handle.seek(toOffset: size > 32_000 ? size - 32_000 : 0)
        log = String(decoding: handle.readDataToEndOfFile(), as: UTF8.self)
    }
}
