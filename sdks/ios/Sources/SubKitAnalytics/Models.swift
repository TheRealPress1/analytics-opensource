import Foundation

public enum AnalyticsEnvironment: String, Codable, Sendable {
    case development
    case production
}

/// Properties must have an app-defined type. Free-text values are deliberately unsupported.
public enum AnalyticsProperty: Codable, Equatable, Sendable {
    case boolean(Bool)
    case integer(Int)
    case choice(String)

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if let boolean = try? value.decode(Bool.self) { self = .boolean(boolean) }
        else if let number = try? value.decode(Int.self) { self = .integer(number) }
        else { self = .choice(try value.decode(String.self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .boolean(let boolean): try value.encode(boolean)
        case .integer(let number): try value.encode(number)
        case .choice(let string): try value.encode(string)
        }
    }
}

public enum AnalyticsPropertyRule: Sendable {
    case boolean
    case integer(ClosedRange<Int>)
    case choice(Set<String>)

    func permits(_ property: AnalyticsProperty) -> Bool {
        switch (self, property) {
        case (.boolean, .boolean): return true
        case (.integer(let range), .integer(let value)): return range.contains(value)
        case (.choice(let choices), .choice(let value)): return choices.contains(value)
        default: return false
        }
    }
}

public struct AnalyticsEventDefinition: Sendable {
    public let name: String
    public let properties: [String: AnalyticsPropertyRule]

    public init(_ name: String, properties: [String: AnalyticsPropertyRule] = [:]) {
        self.name = name
        self.properties = properties
    }
}

public struct AnalyticsConfiguration: Sendable {
    public let baseURL: URL
    public let appNamespace: String
    public let environment: AnalyticsEnvironment
    public let events: [AnalyticsEventDefinition]
    public let allowsLocalhostHTTP: Bool
    public let automaticFlush: Bool
    public let maxQueuedEvents: Int

    public init(baseURL: URL, appNamespace: String, environment: AnalyticsEnvironment,
                events: [AnalyticsEventDefinition], allowsLocalhostHTTP: Bool = false,
                automaticFlush: Bool = true, maxQueuedEvents: Int = 500) {
        self.baseURL = baseURL
        self.appNamespace = appNamespace
        self.environment = environment
        self.events = events
        self.allowsLocalhostHTTP = allowsLocalhostHTTP
        self.automaticFlush = automaticFlush
        self.maxQueuedEvents = maxQueuedEvents
    }
}

/// Returned by your authenticated backend. A server sk_ key never belongs in the SDK.
public struct CollectorToken: Codable, Sendable {
    public let token: String
    public let subject: String
    public let environment: AnalyticsEnvironment
    public let expiresAt: Date

    public init(token: String, subject: String, environment: AnalyticsEnvironment, expiresAt: Date) {
        self.token = token
        self.subject = subject
        self.environment = environment
        self.expiresAt = expiresAt
    }
}

public typealias CollectorTokenProvider = @Sendable () async throws -> CollectorToken

public enum AnalyticsError: Error, Equatable, Sendable {
    case invalidConfiguration(String)
    case invalidIdentity
    case eventNotAllowed(String)
    case propertyNotAllowed(String)
    case invalidProperty(String)
    case eventTooLarge
    case invalidStoredQueue
    case tokenIdentityMismatch
    case tokenEnvironmentMismatch
    case expiredToken
    case invalidToken
    case invalidAcknowledgment
    case httpStatus(Int)
}

public struct FlushResult: Equatable, Sendable {
    public let accepted: Int
    public let duplicates: Int
    public let discarded: Int
    public let superseded: Bool
    public let busy: Bool

    public init(accepted: Int = 0, duplicates: Int = 0, discarded: Int = 0,
                superseded: Bool = false, busy: Bool = false) {
        self.accepted = accepted
        self.duplicates = duplicates
        self.discarded = discarded
        self.superseded = superseded
        self.busy = busy
    }
}

struct QueuedEvent: Codable, Equatable, Sendable {
    let id: UUID
    let name: String
    let occurredAt: Date
    let sessionId: UUID
    let properties: [String: AnalyticsProperty]
}

struct EventBatch: Codable, Sendable { let events: [QueuedEvent] }
struct EventAcknowledgment: Decodable, Sendable { let accepted: Int; let duplicates: Int }
struct QueueEnvelope: Codable { let version: Int; let scope: String; let events: [QueuedEvent] }

enum AnalyticsJSON {
    static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { value, encoder in
            var container = encoder.singleValueContainer()
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            try container.encode(formatter.string(from: value))
        }
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }

    static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = formatter.date(from: value) { return date }
            formatter.formatOptions = [.withInternetDateTime]
            guard let date = formatter.date(from: value) else {
                throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid timestamp")
            }
            return date
        }
        return decoder
    }
}
