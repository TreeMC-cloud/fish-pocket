import Foundation

/// Failure reported by the engine for one RPC, or by the transport.
struct EngineError: LocalizedError, Sendable {
    let code: String?
    let message: String
    let detail: JSON

    var errorDescription: String? { message }
}

/// The engine's HTTP API, spoken the way its web frontend speaks it: the
/// launch URL's token is exchanged for a session cookie, then every call is
/// `POST /api/<method>` with a `client-request` envelope.
final class EngineClient: NSObject, @unchecked Sendable, URLSessionTaskDelegate {
    let origin: URL
    private(set) var session: URLSession!
    let launchURL: URL
    /// The session cookie, sent explicitly (it is named after host:port and set on a 303).
    private(set) var cookieHeader: String?

    init(launchURL: URL) {
        self.launchURL = launchURL
        var components = URLComponents(url: launchURL, resolvingAgainstBaseURL: false)!
        components.path = ""
        components.query = nil
        origin = components.url!
        super.init()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.timeoutIntervalForRequest = 600
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }

    /// Exchange the launch token for the session cookie: `GET /?token=` answers
    /// 303 with Set-Cookie, which is read here instead of following the redirect.
    func authenticate() async throws {
        let (_, response) = try await session.data(for: URLRequest(url: launchURL))
        guard let http = response as? HTTPURLResponse,
              let setCookie = http.value(forHTTPHeaderField: "Set-Cookie"),
              let pair = setCookie.split(separator: ";").first else {
            throw EngineError(code: "AUTH", message: "引擎拒绝了登录令牌", detail: .null)
        }
        cookieHeader = String(pair).trimmingCharacters(in: .whitespaces)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    /// A request to the engine carrying the session cookie.
    func request(_ url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        if let cookieHeader { request.setValue(cookieHeader, forHTTPHeaderField: "Cookie") }
        return request
    }

    /// One RPC call; returns `result.value`, throws `result.error`.
    @discardableResult
    func call(_ method: String, _ args: JSON = [:]) async throws -> JSON {
        var request = self.request(origin.appendingPathComponent("api/\(method)"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        let envelope: JSON = [
            "type": "client-request",
            "rpcId": .string(UUID().uuidString.lowercased()),
            "method": .string(method),
            "payload": ["args": args],
        ]
        request.httpBody = try JSONEncoder().encode(envelope)
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard let reply = try? JSONDecoder().decode(JSON.self, from: data) else {
            throw EngineError(code: "HTTP_\(status)", message: "\(method) 返回了无法解析的响应（HTTP \(status)）", detail: .null)
        }
        let result = reply["result"]
        if result["ok"].bool == true { return result["value"] }
        let error = result["error"].isNull ? reply["error"] : result["error"]
        throw EngineError(
            code: error["code"].string,
            message: error["message"].string ?? "\(method) 调用失败",
            detail: error
        )
    }
}
