import Foundation
import NodeMobile

/// Runs Node (`nodejs-project/main.mjs`, which hosts the DSH engine in a worker)
/// on a dedicated thread and publishes the web URL once `dsh web` is listening.
/// Node can be started only once per process, so this is a singleton for the
/// app's lifetime; engine restarts happen inside it and show up here as a new
/// `generation`, which tells the web view to reload.
@MainActor
final class NodeEngine: ObservableObject {
    enum Phase: Equatable {
        case starting
        case running(URL, generation: Int)
        case exited(Int32)
    }

    static let shared = NodeEngine()

    @Published private(set) var phase: Phase = .starting
    /// When the current engine generation started listening (the engine card atop 设置).
    @Published private(set) var runningSince: Date?
    /// Start-up has run far past a normal launch and still has no URL. `main.mjs`
    /// restarts an engine worker that dies, so a boot that keeps failing never ends
    /// the process and so never reaches `.exited`: without this the launch screen
    /// stays up forever. A launch that hangs is not a crash either, so nothing about
    /// it reaches App Store Connect — the device's own log is the only account of it.
    @Published private(set) var stalled = false
    /// When `start()` ran, for the counter on that screen.
    @Published private(set) var startedAt: Date?
    private var started = false

    /// A cold start is a few seconds, and far less once the engine is warm. What this
    /// brings up says the engine is still being retried and leaves on its own if it
    /// does come up, so waiting any longer would only hide the problem.
    private static let stallAfter: TimeInterval = 20

    private init() {}

    var logFile: URL { EnginePaths.real(EnginePaths.shared + "/engine.log") }

    func start() {
        guard !started else { return }
        started = true
        startedAt = Date()
        guard EnginePaths.install() else {
            phase = .exited(-1)
            return
        }
        let urlFile = EnginePaths.real(EnginePaths.shared + "/web-url")
        try? FileManager.default.createDirectory(at: urlFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? FileManager.default.removeItem(at: urlFile)
        setenv("DSH_IOS_HOME", EnginePaths.home, 1)
        setenv("DSH_IOS_DATA", EnginePaths.shared, 1)
        setenv("DSH_IOS_DOCUMENTS", EnginePaths.documents, 1)
        #if DEBUG
        // Lets <data>/debug/*.mjs run inside the engine (engine/runtime/debug-inbox.mjs).
        setenv("DSH_IOS_DEBUG", "1", 1)
        #endif

        let thread = Thread {
            let code = NodeEngine.runNode(["node", "--expose-internals", EnginePaths.script])
            Task { @MainActor in NodeEngine.shared.phase = .exited(code) }
        }
        thread.name = "node"
        // V8 derives its stack limit from the thread; DSH's module graph is deep.
        thread.stackSize = 16 * 1024 * 1024
        thread.start()

        Task { await waitForURL(urlFile) }
    }

    /// The engine rewrites the URL file each time it (re)starts listening.
    private func waitForURL(_ file: URL) async {
        var seen: Date?
        var generation = 0
        while true {
            if case .exited = phase { return }
            let modified = (try? FileManager.default.attributesOfItem(atPath: file.path))?[.modificationDate] as? Date
            if let modified, modified != seen,
               let text = try? String(contentsOf: file, encoding: .utf8),
               let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)) {
                seen = modified
                generation += 1
                phase = .running(url, generation: generation)
                runningSince = Date()
                stalled = false
            }
            if case .starting = phase, let startedAt, Date().timeIntervalSince(startedAt) > Self.stallAfter {
                stalled = true
            }
            try? await Task.sleep(for: .milliseconds(500))
        }
    }

    /// node_start needs argv in one contiguous buffer (libuv rewrites it for the process title).
    nonisolated private static func runNode(_ arguments: [String]) -> Int32 {
        let total = arguments.reduce(0) { $0 + $1.utf8.count + 1 }
        let buffer = UnsafeMutablePointer<CChar>.allocate(capacity: total)
        var argv: [UnsafeMutablePointer<CChar>?] = []
        var cursor = buffer
        for argument in arguments {
            argument.withCString { source in
                let length = strlen(source) + 1
                cursor.update(from: source, count: length)
                argv.append(cursor)
                cursor += length
            }
        }
        return argv.withUnsafeMutableBufferPointer { pointer in
            node_start(Int32(arguments.count), pointer.baseAddress)
        }
    }
}
