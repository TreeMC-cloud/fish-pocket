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
    private let connection = EngineConnection.shared

    var body: some View {
        switch engine.phase {
        case .starting:
            StartupView(message: String(localized: "正在启动 DSH 引擎…"))
        case .running(let url, let current):
            Group {
                if let app = connection.app {
                    MainView(session: session)
                        .environment(app)
                        .preferredColorScheme(app.colorScheme)
                } else {
                    StartupView(message: String(localized: "正在连接…"))
                }
            }
            .task(id: current) { await connection.connect(to: url, generation: current) }
        case .exited(let code):
            VStack(spacing: 12) {
                Text("引擎已退出（\(code)）").font(.headline)
                Text(engine.logFile.path).font(.caption).foregroundStyle(Palette.secondary).textSelection(.enabled)
            }
            .padding()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Palette.background)
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
