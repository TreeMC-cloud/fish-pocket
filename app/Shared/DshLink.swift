import Foundation

/// The app's `dsh://` links: the Live Activity and the widgets open them, `RootView` reads them.
///
/// - `dsh://session/<id>`: open that session.
/// - `dsh://new`: a new conversation, focused; `workspace`, `preset` and `draft` are
///   optional query items. A draft is placed in the composer, never sent.
enum DshLink: Hashable {
    case session(String)
    case new(workspace: String? = nil, preset: String? = nil, draft: String? = nil)

    static let scheme = "dsh"

    init?(url: URL) {
        guard url.scheme == Self.scheme, let host = url.host() else { return nil }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func item(_ name: String) -> String? {
            items.first { $0.name == name }?.value.flatMap { $0.isEmpty ? nil : $0 }
        }
        switch host {
        case "session":
            guard let id = url.pathComponents.dropFirst().first, !id.isEmpty else { return nil }
            self = .session(id)
        case "new":
            self = .new(workspace: item("workspace"), preset: item("preset"), draft: item("draft"))
        default:
            return nil
        }
    }

    var url: URL {
        var components = URLComponents()
        components.scheme = Self.scheme
        switch self {
        case .session(let id):
            components.host = "session"
            components.path = "/" + id
        case .new(let workspace, let preset, let draft):
            components.host = "new"
            let items = [("workspace", workspace), ("preset", preset), ("draft", draft)]
                .compactMap { name, value in value.map { URLQueryItem(name: name, value: $0) } }
            if !items.isEmpty { components.queryItems = items }
        }
        return components.url!
    }
}
