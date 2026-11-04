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
    /// When the current engine generation started listening (设置 → 引擎).
    @Published private(set) var runningSince: Date?
    private var started = false

    private init() {}

    var logFile: URL { EnginePaths.real(EnginePaths.shared + "/engine.log") }

    func start() {
        guard !started else { return }
        started = true
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
