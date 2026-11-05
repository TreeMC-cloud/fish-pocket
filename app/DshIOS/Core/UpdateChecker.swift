import Foundation
import Observation

/// Version numbers as `MARKETING_VERSION` and the release tags write them: `1.2.0`, `v1.2.0`.
enum AppVersion {
    /// The numeric segments; anything after them (`-beta.1`) is ignored. Nil when there are none.
    static func segments(_ text: String) -> [Int]? {
        let bare = text.hasPrefix("v") || text.hasPrefix("V") ? text.dropFirst() : Substring(text)
        let numbers = bare.prefix { $0.isNumber || $0 == "." }.split(separator: ".", omittingEmptySubsequences: false).map { Int($0) }
        return numbers.contains(nil) ? nil : numbers.compactMap { $0 }
    }

    /// Segment by segment, so 1.10.0 beats 1.9.0 and 1.0 equals 1.0.0.
    static func isNewer(_ candidate: String, than current: String) -> Bool {
        guard let new = segments(candidate), let old = segments(current) else { return false }
        for index in 0..<max(new.count, old.count) {
            let lhs = index < new.count ? new[index] : 0
            let rhs = index < old.count ? old[index] : 0
            if lhs != rhs { return lhs > rhs }
        }
        return false
    }
}

/// A newer release and the page that offers it.
struct AppUpdate: Equatable {
    let version: String
    let url: URL
}

/// Finds out whether a newer release exists, from public endpoints alone. The App
/// Store comes first: once the app is listed there, it answers for everyone. Until
/// then GitHub Releases does, except for builds Apple delivered (TestFlight, review),
/// which never point at a download outside the store.
@MainActor @Observable
final class UpdateChecker {
    enum Status: Equatable { case idle, checking, upToDate, failed, available(AppUpdate) }

    static let shared = UpdateChecker()

    /// Fixed rather than read from the bundle: a sideloaded copy is re-signed under another id.
    private static let bundleId = "com.wsw.dsh-ios"
    /// Also where 设置 → 关于 sends people for the source.
    nonisolated static let repository = "imsai-sh/fish-pocket"
    private static let interval: TimeInterval = 24 * 60 * 60
    private static let announcedKey = "dsh.update.announced"

    private(set) var status = Status.idle
    /// The app's App Store page, once a lookup has found one.
    private(set) var storePage: URL?
    private var lastChecked: Date?

    private enum Latest {
        case release(version: String, url: URL)
        /// The source answered: nothing published there.
        case none
        case failed
    }

    /// On launch and on return to the foreground; the app may stay alive for days.
    func checkIfDue() async {
        if let lastChecked, Date.now.timeIntervalSince(lastChecked) < Self.interval { return }
        await check()
    }

    func check() async {
        guard status != .checking else { return }
        let previous = status
        status = .checking
        switch await latest() {
        case .release(let version, let url):
            lastChecked = .now
            status = AppVersion.isNewer(version, than: Self.currentVersion) ? .available(AppUpdate(version: version, url: url)) : .upToDate
        case .none:
            lastChecked = .now
            status = .upToDate
        case .failed:
            // Keep what is already known; a dropped request says nothing about the release.
            if case .available = previous { status = previous } else { status = Task.isCancelled ? previous : .failed }
        }
    }

    /// The update to announce: each version is announced once, 关于 keeps offering it.
    func takeAnnouncement() -> AppUpdate? {
        guard case .available(let update) = status,
              UserDefaults.standard.string(forKey: Self.announcedKey) != update.version else { return nil }
        UserDefaults.standard.set(update.version, forKey: Self.announcedKey)
        return update
    }

    private static var currentVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
    }

    /// App Store and TestFlight installs carry no provisioning profile; anything
    /// signed by hand does. Simulator builds have none either, and are not Apple's.
    private static var deliveredByApple: Bool {
        #if targetEnvironment(simulator)
        false
        #else
        Bundle.main.path(forResource: "embedded", ofType: "mobileprovision") == nil
        #endif
    }

    private func latest() async -> Latest {
        let store = await appStoreLatest()
        if case .release = store { return store }
        return Self.deliveredByApple ? store : await gitHubLatest()
    }

    /// The App Store answers per region and without one means the US, where the app
    /// may not be sold: the device's region first, then that default.
    private func appStoreLatest() async -> Latest {
        let region = Locale.current.region?.identifier
        var result = Latest.failed
        for country in [region, nil] {
            var components = URLComponents(string: Self.base("https://itunes.apple.com") + "/lookup")
            components?.queryItems = [URLQueryItem(name: "bundleId", value: Self.bundleId)]
            if let country { components?.queryItems?.append(URLQueryItem(name: "country", value: country)) }
            guard let url = components?.url, let (data, code) = await Self.get(url), code == 200,
                  let lookup = try? JSONDecoder().decode(StoreLookup.self, from: data) else { continue }
            if let listing = lookup.results.first, let page = URL(string: "https://apps.apple.com/app/id\(listing.trackId)") {
                storePage = page
                return .release(version: listing.version, url: page)
            }
            result = .none
        }
        return result
    }

    private func gitHubLatest() async -> Latest {
        guard let url = URL(string: Self.base("https://api.github.com") + "/repos/\(Self.repository)/releases/latest"),
              let (data, code) = await Self.get(url) else { return .failed }
        if code == 404 { return .none }
        guard code == 200, let release = try? JSONDecoder().decode(GitHubRelease.self, from: data) else { return .failed }
        let tag = release.tag_name
        return .release(version: tag.hasPrefix("v") || tag.hasPrefix("V") ? String(tag.dropFirst()) : tag, url: release.html_url)
    }

    private static func get(_ url: URL) async -> (Data, Int)? {
        let request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse else { return nil }
        return (data, http.statusCode)
    }

    /// DEBUG builds can point both sources at a local stub: `-dshUpdateHost http://127.0.0.1:port`.
    private static func base(_ host: String) -> String {
        #if DEBUG
        UserDefaults.standard.string(forKey: "dshUpdateHost") ?? host
        #else
        host
        #endif
    }

    private struct StoreLookup: Decodable {
        struct Listing: Decodable {
            let version: String
            let trackId: Int
        }
        let results: [Listing]
    }

    private struct GitHubRelease: Decodable {
        let tag_name: String
        let html_url: URL
    }
}
