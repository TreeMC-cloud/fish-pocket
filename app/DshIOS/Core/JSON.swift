import Foundation

/// Untyped JSON as the engine sends it. The engine's RPC payloads are wide and
/// evolve with plugins, so views read the fields they need through subscripts
/// instead of mirroring every shape in Codable structs.
enum JSON: Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSON])
    case object([String: JSON])

    subscript(key: String) -> JSON {
        if case .object(let object) = self { return object[key] ?? .null }
        return .null
    }

    subscript(index: Int) -> JSON {
        if case .array(let array) = self, array.indices.contains(index) { return array[index] }
        return .null
    }

    var string: String? { if case .string(let value) = self { return value }; return nil }
    var double: Double? { if case .number(let value) = self { return value }; return nil }
    var int: Int? { double.map { Int($0) } }
    var bool: Bool? { if case .bool(let value) = self { return value }; return nil }
    var array: [JSON] { if case .array(let value) = self { return value }; return [] }
    var object: [String: JSON] { if case .object(let value) = self { return value }; return [:] }
    var isNull: Bool { if case .null = self { return true }; return false }
    /// Self, or nil for `.null`.
    var nonNull: JSON? {
        if isNull { return nil }
        return self
    }

    /// Decode into a Codable type when a shape is stable enough to model.
    func decode<T: Decodable>(_ type: T.Type) throws -> T {
        try JSONDecoder().decode(T.self, from: JSONEncoder().encode(self))
    }
}

extension JSON: Codable {
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([JSON].self) { self = .array(value) }
        else { self = .object(try container.decode([String: JSON].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}

extension JSON: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByBooleanLiteral,
    ExpressibleByDictionaryLiteral, ExpressibleByArrayLiteral, ExpressibleByFloatLiteral {
    init(stringLiteral value: String) { self = .string(value) }
    init(integerLiteral value: Int) { self = .number(Double(value)) }
    init(floatLiteral value: Double) { self = .number(value) }
    init(booleanLiteral value: Bool) { self = .bool(value) }
    init(dictionaryLiteral elements: (String, JSON)...) { self = .object(Dictionary(elements, uniquingKeysWith: { $1 })) }
    init(arrayLiteral elements: JSON...) { self = .array(elements) }
}
