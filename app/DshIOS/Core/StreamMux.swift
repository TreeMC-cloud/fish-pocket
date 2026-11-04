import Foundation

/// The engine's streaming endpoints (`session/follow`, `workspace/follow`, …)
/// share one WebSocket at `/api/remote.mux`. Each logical stream is opened
/// with `{type:"open", streamId, endpoint, payload:{args}}`; the engine
/// answers with `item` frames and finishes with `end` or `error`; the client
/// may `cancel`. One socket per connection, reopened on demand.
final class StreamMux: NSObject, @unchecked Sendable, URLSessionWebSocketDelegate {
    private let client: EngineClient
    private var task: URLSessionWebSocketTask?
    private var opened = false
    private var waiters: [CheckedContinuation<Void, Error>] = []
    private var streams: [String: AsyncThrowingStream<JSON, Error>.Continuation] = [:]
    private let lock = NSLock()

    init(client: EngineClient) {
        self.client = client
    }

    /// Open one logical stream; the sequence ends with the engine's `end`, throws its `error`,
    /// and cancels the stream on the engine when the consumer stops iterating.
    func open(_ endpoint: String, _ args: JSON) -> AsyncThrowingStream<JSON, Error> {
        openDuplex(endpoint, args).items
    }

    /// A stream that also carries the client's items up (e.g. terminal input):
    /// `send` delivers one `item` frame on the same logical stream.
    func openDuplex(_ endpoint: String, _ args: JSON) -> (items: AsyncThrowingStream<JSON, Error>, send: @Sendable (JSON) async throws -> Void) {
        let streamId = UUID().uuidString.lowercased()
        let items = AsyncThrowingStream<JSON, Error> { continuation in
            lock.withLock { streams[streamId] = continuation }
            continuation.onTermination = { [weak self] reason in
                guard let self else { return }
                let wasOpen = self.lock.withLock { self.streams.removeValue(forKey: streamId) != nil }
                if case .cancelled = reason, wasOpen {
                    Task { try? await self.send(["type": "cancel", "streamId": .string(streamId)]) }
                }
            }
            Task {
                do {
                    try await self.send(["type": "open", "streamId": .string(streamId), "endpoint": .string(endpoint), "payload": ["args": args]])
                } catch {
                    self.finish(streamId, error)
                }
            }
        }
        let send: @Sendable (JSON) async throws -> Void = { [weak self] value in
            try await self?.send(["type": "item", "streamId": .string(streamId), "value": value])
        }
        return (items, send)
    }

    private func finish(_ streamId: String, _ error: Error?) {
        let continuation = lock.withLock { streams.removeValue(forKey: streamId) }
        continuation?.finish(throwing: error)
    }

    private func socket() async throws -> URLSessionWebSocketTask {
        if let task = lock.withLock({ opened ? self.task : nil }) { return task }
        if lock.withLock({ task == nil }) {
            var components = URLComponents(url: client.origin, resolvingAgainstBaseURL: false)!
            components.scheme = components.scheme == "https" ? "wss" : "ws"
            components.path = "/api/remote.mux"
            let request = client.request(components.url!)
            let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
            let task = session.webSocketTask(with: request)
            task.maximumMessageSize = 64 * 1024 * 1024
            lock.withLock { self.task = task }
            task.resume()
            receive(on: task)
        }
        try await withCheckedThrowingContinuation { continuation in
            let ready = lock.withLock { () -> Bool in
                if opened { return true }
                waiters.append(continuation)
                return false
            }
            if ready { continuation.resume() }
        }
        return lock.withLock { task! }
    }

    private func send(_ frame: JSON) async throws {
        let task = try await socket()
        let data = try JSONEncoder().encode(frame)
        try await task.send(.string(String(decoding: data, as: UTF8.self)))
    }

    private func receive(on task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                let data: Data
                switch message {
                case .string(let text): data = Data(text.utf8)
                case .data(let bytes): data = bytes
                @unknown default: data = Data()
                }
                if let frame = try? JSONDecoder().decode(JSON.self, from: data) { self.dispatch(frame) }
                self.receive(on: task)
            case .failure(let error):
                self.drop(task, error)
            }
        }
    }

    private func dispatch(_ frame: JSON) {
        guard let streamId = frame["streamId"].string else { return }
        switch frame["type"].string {
        case "item":
            _ = lock.withLock { streams[streamId] }?.yield(frame["value"])
        case "end":
            finish(streamId, nil)
        case "error":
            let error = frame["error"]
            finish(streamId, EngineError(code: error["code"].string, message: error["message"].string ?? "stream failed", detail: error))
        default:
            break
        }
    }

    /// The socket closed: every stream on it ends with the failure, and the next open reconnects.
    private func drop(_ task: URLSessionWebSocketTask, _ error: Error) {
        let (continuations, pending) = lock.withLock { () -> ([AsyncThrowingStream<JSON, Error>.Continuation], [CheckedContinuation<Void, Error>]) in
            guard self.task === task else { return ([], []) }
            self.task = nil
            opened = false
            let all = Array(streams.values)
            streams.removeAll()
            let waiting = waiters
            waiters.removeAll()
            return (all, waiting)
        }
        continuations.forEach { $0.finish(throwing: error) }
        pending.forEach { $0.resume(throwing: error) }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        let pending = lock.withLock { () -> [CheckedContinuation<Void, Error>] in
            guard task === webSocketTask else { return [] }
            opened = true
            let waiting = waiters
            waiters.removeAll()
            return waiting
        }
        pending.forEach { $0.resume() }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        drop(webSocketTask, EngineError(code: "WS_CLOSED", message: "连接已断开", detail: .null))
    }
}
