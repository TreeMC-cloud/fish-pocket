import Foundation

@_silgen_name("dsh_root_install")
private func dsh_root_install(_ root: UnsafePointer<CChar>, _ bundle: UnsafePointer<CChar>, _ container: UnsafePointer<CChar>) -> Int32

/// The engine runs in its own filesystem view (native/root), where paths never
/// change across app updates: `/` is `root` here, `/opt/dsh` the app bundle.
/// Foundation and the rest of the app see the sandbox, so a path crossing between
/// the two is converted here. The engine's paths are plain strings in this file;
/// the real ones are URLs.
enum EnginePaths {
    static let home = "/home/dsh"
    static let documents = "/home/dsh/Documents"
    /// `DSH_IOS_DATA`: what the host and the engine share.
    static let shared = "/home/dsh/.ios"
    static let script = "/opt/dsh/nodejs-project/main.mjs"
    private static let bundle = "/opt/dsh"

    /// Everything the app keeps, in one real directory.
    static let data = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("dsh-ios", isDirectory: true)
    private static let root = data.appendingPathComponent("root", isDirectory: true)

    /// `$DSH_HOME` on disk.
    static var dshHome: URL { real("/home/dsh/.dsh") }

    /// Call once, before Node starts. On failure the engine must not start: it
    /// would write real paths into everything it keeps.
    static func install() -> Bool {
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return dsh_root_install(root.path, Bundle.main.bundlePath, NSHomeDirectory()) == 0
    }

    /// Where an engine path is on disk.
    static func real(_ path: String) -> URL {
        if path == bundle || path.hasPrefix(bundle + "/") {
            return URL(fileURLWithPath: Bundle.main.bundlePath + path.dropFirst(bundle.count))
        }
        return root.appendingPathComponent(path)
    }
}
