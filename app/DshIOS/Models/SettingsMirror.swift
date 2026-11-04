import Foundation
import Observation
import SwiftUI

/// The engine's settings as every settings page reads them (`settings/describe`),
/// held once per connection like the web client's shared mirror
/// (`dsh-client-ui-settings`): pages derive their rows from it and write through
/// it, so a write on one page shows on every other at once.
///
/// It re-reads on `settings/document-updated`, `credentials/reference-updated`,
/// `llm/adapters-updated` and every reconnect; pages attach `.followSettings()`
/// to drive that, and a burst of events coalesces into one read.
@MainActor
@Observable
final class SettingsMirror {
    /// The events that invalidate the describe answer (and the credential states derived from it).
    static let events = ["settings/document-updated", "credentials/reference-updated", "llm/adapters-updated"]

    @ObservationIgnored private let client: EngineClient

    /// The latest `settings/describe` value: `{writable, hasDocument, namespaces:[…]}`.
    private(set) var view: JSON?
    /// The last read's failure; the held view stays usable.
    private(set) var error: String?
    /// Field order of every object node, per namespace and schema uid: the wire
    /// keeps the schema's declaration order, the `JSON` value type does not.
    private(set) var keyOrder: [String: [String: [String]]] = [:]
    /// Bumped whenever a read or a write folds in, so derived caches can key on it.
    private(set) var stamp = 0

    @ObservationIgnored private var loadedRevision: Int?
    @ObservationIgnored private var inflight: Task<Void, Never>?
    /// An event landed during a read, which may predate it: read once more after.
    @ObservationIgnored private var rereadPending = false
    /// Writes to one namespace go out one at a time, as `ConfigForm`'s write queue does.
    @ObservationIgnored private var writeChains: [String: Task<Void, Never>] = [:]

    init(client: EngineClient) {
        self.client = client
    }

    // MARK: Reading

    var loaded: Bool { view != nil }
    /// `false` turns every write control off ("本部署的设置为只读。").
    var writable: Bool { view?["writable"].bool ?? false }
    var hasDocument: Bool { view?["hasDocument"].bool ?? false }
    var namespaces: [JSON] { view?["namespaces"].array ?? [] }

    func namespace(_ ns: String) -> JSON? { namespaces.first { $0["ns"].string == ns } }

    /// `whileServed`: whether the Host currently offers `ns` (pages and rows hide otherwise).
    func serves(_ ns: String) -> Bool { namespace(ns) != nil }

    /// The schema of `ns`, with its field order.
    func graph(_ ns: String) -> SchemaGraph? {
        namespace(ns).map { SchemaGraph($0["schema"], order: keyOrder[ns] ?? [:]) }
    }

    /// Re-read when `revision` (from `app.revision(SettingsMirror.events…)`) moved since the last read.
    func refresh(revision: Int) async {
        if loadedRevision == revision, view != nil { return }
        loadedRevision = revision
        await reload()
    }

    /// Read `settings/describe` now; concurrent callers share one read.
    func reload() async {
        if let inflight {
            rereadPending = true
            await inflight.value
            return
        }
        let task = Task {
            repeat {
                rereadPending = false
                await read()
            } while rereadPending
        }
        inflight = task
        await task.value
        inflight = nil
    }

    private func read() async {
        do {
            let (value, order) = try await Self.describe(client)
            view = value
            keyOrder = order
            error = nil
            stamp += 1
        } catch is CancellationError {
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// `settings/describe`, read raw so the schema's key order survives: the
    /// same envelope `EngineClient.call` sends, parsed twice (values, then key order).
    nonisolated private static func describe(_ client: EngineClient) async throws -> (JSON, [String: [String: [String]]]) {
        var request = client.request(client.origin.appendingPathComponent("api/settings/describe"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        let envelope: JSON = [
            "type": "client-request",
            "rpcId": .string(UUID().uuidString.lowercased()),
            "method": "settings/describe",
            "payload": ["args": [:]],
        ]
        request.httpBody = try JSONEncoder().encode(envelope)
        let (data, _) = try await client.session.data(for: request)
        let reply = try JSONDecoder().decode(JSON.self, from: data)
        let result = reply["result"]
        guard result["ok"].bool == true else {
            let error = result["error"].isNull ? reply["error"] : result["error"]
            throw EngineError(code: error["code"].string, message: error["message"].string ?? "settings/describe 调用失败", detail: error)
        }
        var order: [String: [String: [String]]] = [:]
        if let ordered = OrderedJSONScanner.parse(data) {
            for namespace in ordered["result"]["value"]["namespaces"].elements {
                guard let ns = namespace["ns"].stringValue else { continue }
                var refs: [String: [String]] = [:]
                for (uid, node) in namespace["schema"]["refs"].members {
                    let keys = node["dict"].members.map(\.0)
                    if !keys.isEmpty { refs[uid] = keys }
                }
                order[ns] = refs
            }
        }
        return (result["value"], order)
    }

    // MARK: Writing

    /// `settings/mutate`: path ops against the stored user section, fenced by
    /// `expectedRevision` (nil writes unconditionally). The answer folds into the
    /// mirror; a refusal re-reads it so pages recover from the Host's state.
    @discardableResult
    func mutate(_ ns: String, _ ops: [SettingsOp], expectedRevision: Int?) async throws -> JSON {
        var args: [String: JSON] = ["ns": .string(ns), "ops": .array(ops.map(\.json))]
        if let expectedRevision { args["expectedRevision"] = .number(Double(expectedRevision)) }
        return try await write(ns, "settings/mutate", args)
    }

    /// `settings/update`: merge a patch (the Agent preset default is written this way).
    @discardableResult
    func update(_ ns: String, patch: JSON, expectedRevision: Int?) async throws -> JSON {
        var args: [String: JSON] = ["ns": .string(ns), "patch": patch]
        if let expectedRevision { args["expectedRevision"] = .number(Double(expectedRevision)) }
        return try await write(ns, "settings/update", args)
    }

    /// One `set` (or `unset` when `value` is nil) at the namespace's current revision.
    @discardableResult
    func set(_ ns: String, _ path: [String], _ value: JSON?) async throws -> JSON {
        let op: SettingsOp = value.map { .set(path, $0) } ?? .unset(path)
        return try await mutate(ns, [op], expectedRevision: namespace(ns)?["revision"].int)
    }

    private func write(_ ns: String, _ method: String, _ args: [String: JSON]) async throws -> JSON {
        let previous = writeChains[ns]
        let client = self.client
        let call = Task { () -> Result<JSON, Error> in
            await previous?.value
            do { return .success(try await client.call(method, .object(args))) } catch { return .failure(error) }
        }
        writeChains[ns] = Task { _ = await call.value }
        switch await call.value {
        case .success(let next):
            fold(next)
            return next
        case .failure(let failure):
            await reload()
            throw failure
        }
    }

    /// Replace one namespace view with a write's answer.
    private func fold(_ next: JSON) {
        guard case .object(var root) = view, let ns = next["ns"].string else { return }
        var list = root["namespaces"]?.array ?? []
        if let index = list.firstIndex(where: { $0["ns"].string == ns }) { list[index] = next } else { list.append(next) }
        root["namespaces"] = .array(list)
        view = .object(root)
        stamp += 1
    }

    // MARK: Credentials

    /// `credentials/describe` in batches of 64: `{configured, source?, writable}` per reference.
    func describeCredentials(_ refs: [String]) async throws -> [String: JSON] {
        var result: [String: JSON] = [:]
        let unique = Array(Set(refs.filter { !$0.isEmpty })).sorted()
        var index = 0
        while index < unique.count {
            let batch = Array(unique[index..<min(index + 64, unique.count)])
            let value = try await client.call("credentials/describe", ["refs": .array(batch.map { .string($0) })])
            for (ref, info) in value.object { result[ref] = info }
            index += 64
        }
        return result
    }

    func setCredential(_ ref: String, _ value: String) async throws {
        try await client.call("credentials/set", ["ref": .string(ref), "value": .string(value)])
    }

    func unsetCredential(_ ref: String) async throws {
        try await client.call("credentials/unset", ["ref": .string(ref)])
    }
}

/// One `settings/mutate` edit.
enum SettingsOp: Equatable {
    case set([String], JSON)
    case unset([String])

    var json: JSON {
        switch self {
        case .set(let path, let value): ["op": "set", "path": .array(path.map { .string($0) }), "value": value]
        case .unset(let path): ["op": "unset", "path": .array(path.map { .string($0) })]
        }
    }
}

extension AppModel {
    /// The connection's one settings mirror.
    var settings: SettingsMirror { sharedModel(&SharedModelKey.settings) { SettingsMirror(client: client) } }

    /// The revision every settings page re-reads on.
    var settingsRevision: Int { revision("settings/document-updated", "credentials/reference-updated", "llm/adapters-updated") }
}

/// Models that live exactly as long as their `AppModel` without being its stored
/// properties. Associated, not looked up by identity: an engine restart builds a new
/// `AppModel`, and a freed one's address can come back.
enum SharedModelKey {
    nonisolated(unsafe) static var settings: UInt8 = 0
    nonisolated(unsafe) static var plugins: UInt8 = 0
    nonisolated(unsafe) static var install: UInt8 = 0
}

extension AppModel {
    func sharedModel<Model: AnyObject>(_ key: UnsafeRawPointer, make: () -> Model) -> Model {
        if let model = objc_getAssociatedObject(self, key) as? Model { return model }
        let model = make()
        objc_setAssociatedObject(self, key, model, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        return model
    }
}

private struct FollowSettings: ViewModifier {
    @Environment(AppModel.self) private var app

    func body(content: Content) -> some View {
        content.task(id: app.settingsRevision) { await app.settings.refresh(revision: app.settingsRevision) }
    }
}

extension View {
    /// Keep the shared settings mirror current while this view is on screen.
    func followSettings() -> some View { modifier(FollowSettings()) }
}

// MARK: - Paths

extension JSON {
    /// The value at `path` (array elements by decimal index); nil when absent.
    func value(at path: [String]) -> JSON? {
        var current = self
        for key in path {
            switch current {
            case .object(let object):
                guard let next = object[key] else { return nil }
                current = next
            case .array(let array):
                guard let index = Int(key), array.indices.contains(index) else { return nil }
                current = array[index]
            default:
                return nil
            }
        }
        return current
    }

    func has(_ path: [String]) -> Bool { value(at: path) != nil }

    /// A copy with `value` at `path`, creating objects along the way; nil removes the key.
    func setting(_ path: [String], _ value: JSON?) -> JSON {
        guard let key = path.first else { return value ?? .null }
        let rest = Array(path.dropFirst())
        switch self {
        case .array(var array):
            if let index = Int(key) {
                if let value {
                    let child = array.indices.contains(index) ? array[index] : .null
                    let next = rest.isEmpty ? value : child.setting(rest, value)
                    if array.indices.contains(index) { array[index] = next } else { array.append(next) }
                } else if array.indices.contains(index) {
                    if rest.isEmpty { array.remove(at: index) } else { array[index] = array[index].setting(rest, nil) }
                }
                return .array(array)
            }
            return self
        default:
            var object = self.object
            if rest.isEmpty {
                object[key] = value
            } else if let value {
                object[key] = (object[key] ?? .object([:])).setting(rest, value)
            } else if let child = object[key] {
                object[key] = child.setting(rest, nil)
            }
            return .object(object)
        }
    }

    /// Compact single-line text of the value, for summaries.
    var compactText: String {
        switch self {
        case .string(let value): return value
        case .number(let value): return value.rounded() == value && abs(value) < 1e15 ? String(Int(value)) : String(value)
        case .bool(let value): return value ? "true" : "false"
        case .null: return "null"
        default: return (try? JSONEncoder().encode(self)).map { String(decoding: $0, as: UTF8.self) } ?? ""
        }
    }
}

// MARK: - Errors

/// A thrown engine failure as one sentence for a toast.
func describeFailure(_ error: Error) -> String {
    if let engine = error as? EngineError {
        switch engine.code {
        case "settings/conflict": return String(localized: "设置已在别处被修改，已重新读取，请在当前值上再试一次。")
        case "gateway/cancelled": return String(localized: "请求已取消或连接已断开，请重试。")
        default: return engine.message
        }
    }
    if let url = error as? URLError {
        return url.code == .timedOut ? String(localized: "请求超时，请重试。") : String(localized: "与引擎的连接出错：\(url.localizedDescription)")
    }
    return error.localizedDescription
}

/// Whether an engine failure was a revision conflict (`settings/conflict`).
func isConflict(_ error: Error) -> Bool { (error as? EngineError)?.code == "settings/conflict" }

// MARK: - Ordered JSON

/// A JSON tree that keeps object key order, parsed only where order matters
/// (schema field order). Values are kept as raw scalars; `JSON` carries the data.
indirect enum OrderedJSON {
    case scalar(String?)
    case array([OrderedJSON])
    case object([(String, OrderedJSON)])

    subscript(key: String) -> OrderedJSON {
        if case .object(let members) = self { return members.first { $0.0 == key }?.1 ?? .scalar(nil) }
        return .scalar(nil)
    }

    var members: [(String, OrderedJSON)] { if case .object(let members) = self { return members }; return [] }
    var elements: [OrderedJSON] { if case .array(let elements) = self { return elements }; return [] }
    var stringValue: String? { if case .scalar(let value) = self { return value }; return nil }
}

/// A small recursive-descent JSON parser producing `OrderedJSON`.
struct OrderedJSONScanner {
    private let bytes: [UInt8]
    private var index = 0

    static func parse(_ data: Data) -> OrderedJSON? {
        var scanner = OrderedJSONScanner(bytes: [UInt8](data))
        return scanner.value()
    }

    private init(bytes: [UInt8]) { self.bytes = bytes }

    private mutating func skipSpace() {
        while index < bytes.count, [0x20, 0x09, 0x0A, 0x0D].contains(bytes[index]) { index += 1 }
    }

    private mutating func value() -> OrderedJSON? {
        skipSpace()
        guard index < bytes.count else { return nil }
        switch bytes[index] {
        case UInt8(ascii: "{"):
            index += 1
            var members: [(String, OrderedJSON)] = []
            skipSpace()
            if index < bytes.count, bytes[index] == UInt8(ascii: "}") { index += 1; return .object(members) }
            while index < bytes.count {
                skipSpace()
                guard let key = string() else { return nil }
                skipSpace()
                guard index < bytes.count, bytes[index] == UInt8(ascii: ":") else { return nil }
                index += 1
                guard let child = value() else { return nil }
                members.append((key, child))
                skipSpace()
                guard index < bytes.count else { return nil }
                if bytes[index] == UInt8(ascii: ",") { index += 1; continue }
                if bytes[index] == UInt8(ascii: "}") { index += 1; return .object(members) }
                return nil
            }
            return nil
        case UInt8(ascii: "["):
            index += 1
            var elements: [OrderedJSON] = []
            skipSpace()
            if index < bytes.count, bytes[index] == UInt8(ascii: "]") { index += 1; return .array(elements) }
            while index < bytes.count {
                guard let child = value() else { return nil }
                elements.append(child)
                skipSpace()
                guard index < bytes.count else { return nil }
                if bytes[index] == UInt8(ascii: ",") { index += 1; continue }
                if bytes[index] == UInt8(ascii: "]") { index += 1; return .array(elements) }
                return nil
            }
            return nil
        case UInt8(ascii: "\""):
            return string().map { .scalar($0) }
        default:
            let start = index
            while index < bytes.count, ![UInt8(ascii: ","), UInt8(ascii: "}"), UInt8(ascii: "]"), 0x20, 0x09, 0x0A, 0x0D].contains(bytes[index]) { index += 1 }
            return .scalar(String(decoding: bytes[start..<index], as: UTF8.self))
        }
    }

    /// A string token; escapes are decoded for `\"` and `\\` and kept verbatim otherwise
    /// (only keys and namespace names are read, which do not carry them).
    private mutating func string() -> String? {
        guard index < bytes.count, bytes[index] == UInt8(ascii: "\"") else { return nil }
        index += 1
        var out: [UInt8] = []
        while index < bytes.count {
            let byte = bytes[index]
            if byte == UInt8(ascii: "\"") { index += 1; return String(decoding: out, as: UTF8.self) }
            if byte == UInt8(ascii: "\\"), index + 1 < bytes.count {
                let next = bytes[index + 1]
                if next == UInt8(ascii: "\"") || next == UInt8(ascii: "\\") || next == UInt8(ascii: "/") { out.append(next) } else { out.append(byte); out.append(next) }
                index += 2
                continue
            }
            out.append(byte)
            index += 1
        }
        return nil
    }
}
