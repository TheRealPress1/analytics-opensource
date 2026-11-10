import CryptoKit
import Foundation

/// Explicit usage events only. The SDK never inspects screens, files, health data or device identifiers.
public actor SubKitAnalytics {
    private let configuration: AnalyticsConfiguration
    private let baseURL: URL
    private let definitions: [String: AnalyticsEventDefinition]
    private let storage: any AnalyticsQueueStorage
    private let transport: any AnalyticsTransport
    private let clock: @Sendable () -> Date
    private var subject: String
    private var scope: String
    private var provider: CollectorTokenProvider
    private var enabled: Bool
    private var events: [QueuedEvent]
    private var sessionID = UUID()
    private var lastActivityAt: Date?
    private var generation = UUID()
    private var inFlight: Task<AnalyticsHTTPResponse, Error>?
    private var scheduled: Task<Void, Never>?
    private var retryAttempt = 0

    public init(configuration: AnalyticsConfiguration, subject: String,
                enabled: Bool = false, storage: any AnalyticsQueueStorage,
                transport: any AnalyticsTransport = URLSessionAnalyticsTransport(),
                clock: @escaping @Sendable () -> Date = { Date() },
                tokenProvider: @escaping CollectorTokenProvider) throws {
        let baseURL = try Self.validate(configuration)
        guard Self.validSubject(subject) else { throw AnalyticsError.invalidIdentity }
        self.configuration = configuration
        self.baseURL = baseURL
        self.subject = subject
        self.enabled = enabled
        self.storage = storage
        self.transport = transport
        self.clock = clock
        provider = tokenProvider
        let validatedDefinitions = Dictionary(uniqueKeysWithValues: configuration.events.map { ($0.name, $0) })
        definitions = validatedDefinitions
        scope = Self.scope(configuration: configuration, baseURL: baseURL, subject: subject)
        events = []
        if enabled, let saved = try storage.read(scope: scope) {
            guard let envelope = try? AnalyticsJSON.decoder().decode(QueueEnvelope.self, from: saved),
                  envelope.version == 1, envelope.scope == scope,
                  envelope.events.count <= 500 else { throw AnalyticsError.invalidStoredQueue }
            let now = clock()
            events = envelope.events.filter { event in
                event.occurredAt > now.addingTimeInterval(-7 * 86_400) && event.occurredAt <= now &&
                    Self.permitted(event: event, definitions: validatedDefinitions)
            }
            events = Array(events.suffix(configuration.maxQueuedEvents))
            if events.isEmpty { try storage.remove(scope: scope) }
            else { try storage.write(AnalyticsJSON.encoder().encode(QueueEnvelope(version: 1, scope: scope, events: events)), scope: scope) }
        } else if !enabled {
            try storage.remove(scope: scope)
        }
        if configuration.automaticFlush, enabled, !events.isEmpty {
            Task { [weak self] in _ = try? await self?.flush() }
        }
    }

    deinit {
        scheduled?.cancel()
        inFlight?.cancel()
    }

    public var pendingEventCount: Int { events.count }
    public var isEnabled: Bool { enabled }

    /// The app must call this only after the member's applicable analytics choice permits collection.
    public func setEnabled(_ value: Bool) throws {
        guard enabled != value else { return }
        enabled = value
        if !value {
            invalidateInFlight()
            events = []
            sessionID = UUID()
            lastActivityAt = nil
            try storage.remove(scope: scope)
        } else {
            scheduleFlush(after: 0)
        }
    }

    /// Old-account pending events are discarded, never attributed to the new account.
    /// Consent resets to disabled unless the host explicitly supplies the new account's choice.
    public func setIdentity(_ newSubject: String, enabled newEnabled: Bool = false,
                            tokenProvider: @escaping CollectorTokenProvider) throws {
        guard Self.validSubject(newSubject) else { throw AnalyticsError.invalidIdentity }
        invalidateInFlight()
        enabled = false
        events = []
        try storage.remove(scope: scope)
        subject = newSubject
        scope = Self.scope(configuration: configuration, baseURL: baseURL, subject: newSubject)
        provider = tokenProvider
        sessionID = UUID()
        lastActivityAt = nil
        retryAttempt = 0
        try storage.remove(scope: scope)
        enabled = newEnabled
    }

    /// Drops pending analytics on sign-out. Call setIdentity with the next authenticated account.
    public func signOut() throws { try setEnabled(false) }

    /// Begins a new explicit session; inactivity also starts one after 30 minutes.
    public func startSession() {
        sessionID = UUID()
        lastActivityAt = nil
    }

    /// Returns nil while disabled. Only values declared by the configured schema can be queued.
    @discardableResult
    public func track(_ name: String, properties: [String: AnalyticsProperty] = [:]) throws -> UUID? {
        guard enabled else { return nil }
        guard let definition = definitions[name] else { throw AnalyticsError.eventNotAllowed(name) }
        for (key, value) in properties {
            guard let rule = definition.properties[key] else { throw AnalyticsError.propertyNotAllowed(key) }
            guard rule.permits(value) else { throw AnalyticsError.invalidProperty(key) }
        }
        let now = clock()
        if let lastActivityAt, now.timeIntervalSince(lastActivityAt) >= 30 * 60 || now < lastActivityAt {
            sessionID = UUID()
        }
        lastActivityAt = now
        let event = QueuedEvent(id: UUID(), name: name, occurredAt: now, sessionId: sessionID, properties: properties)
        guard try AnalyticsJSON.encoder().encode(event).count <= 4_096 else { throw AnalyticsError.eventTooLarge }
        let previous = events
        events.removeAll { $0.occurredAt <= now.addingTimeInterval(-7 * 86_400) || $0.occurredAt > now }
        events.append(event)
        events = Array(events.suffix(configuration.maxQueuedEvents))
        do { try persist() } catch { events = previous; throw error }
        scheduleFlush(after: 1)
        return event.id
    }

    /// Flushes one batch. Automatic mode drains remaining batches and retries transient failures.
    /// Retried events retain their original UUIDs and timestamps for server idempotency.
    @discardableResult
    public func flush() async throws -> FlushResult {
        guard enabled else { return FlushResult() }
        guard inFlight == nil else { return FlushResult(busy: true) }
        scheduled?.cancel()
        scheduled = nil
        let now = clock()
        let originalCount = events.count
        events.removeAll { $0.occurredAt <= now.addingTimeInterval(-7 * 86_400) || $0.occurredAt > now }
        if events.count != originalCount { try persist() }
        guard !events.isEmpty else { return FlushResult() }
        var batch = Array(events.prefix(50))
        var body = try AnalyticsJSON.encoder().encode(EventBatch(events: batch))
        while body.count > 60 * 1024 {
            batch.removeLast()
            body = try AnalyticsJSON.encoder().encode(EventBatch(events: batch))
        }
        let capturedGeneration = generation
        let capturedSubject = subject
        let capturedEnvironment = configuration.environment
        let capturedProvider = provider
        let capturedTransport = transport
        let capturedClock = clock
        let url = baseURL.appendingPathComponent("v1/events")
        let task = Task<AnalyticsHTTPResponse, Error> {
            let credential = try await capturedProvider()
            try Task.checkCancellation()
            guard credential.subject == capturedSubject else { throw AnalyticsError.tokenIdentityMismatch }
            guard credential.environment == capturedEnvironment else { throw AnalyticsError.tokenEnvironmentMismatch }
            guard credential.expiresAt > capturedClock().addingTimeInterval(5) else { throw AnalyticsError.expiredToken }
            guard !credential.token.isEmpty, !credential.token.hasPrefix("sk_"),
                  !credential.token.contains(where: { $0.isWhitespace }) else { throw AnalyticsError.invalidToken }
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.timeoutInterval = 15
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("Bearer \(credential.token)", forHTTPHeaderField: "Authorization")
            request.httpBody = body
            return try await capturedTransport.send(request)
        }
        inFlight = task
        do {
            let response = try await task.value
            guard generation == capturedGeneration, enabled else { return FlushResult(superseded: true) }
            inFlight = nil
            if response.status == 200 {
                guard let acknowledgment = try? AnalyticsJSON.decoder().decode(EventAcknowledgment.self, from: response.body),
                      acknowledgment.accepted >= 0, acknowledgment.duplicates >= 0,
                      acknowledgment.accepted + acknowledgment.duplicates == batch.count else {
                    throw AnalyticsError.invalidAcknowledgment
                }
                try removeAcknowledged(batch)
                retryAttempt = 0
                scheduleFlush(after: 0)
                return FlushResult(accepted: acknowledgment.accepted, duplicates: acknowledgment.duplicates)
            }
            if (400..<500).contains(response.status), response.status != 401, response.status != 408, response.status != 429 {
                try removeAcknowledged(batch)
                retryAttempt = 0
                scheduleFlush(after: 0)
                return FlushResult(discarded: batch.count)
            }
            scheduleRetry(retryAfter: response.retryAfter)
            throw AnalyticsError.httpStatus(response.status)
        } catch {
            guard generation == capturedGeneration, enabled else { return FlushResult(superseded: true) }
            inFlight = nil
            if scheduled == nil { scheduleRetry(retryAfter: nil) }
            throw error
        }
    }

    private func invalidateInFlight() {
        generation = UUID()
        scheduled?.cancel()
        scheduled = nil
        inFlight?.cancel()
        inFlight = nil
    }

    private func persist() throws {
        if events.isEmpty { try storage.remove(scope: scope); return }
        let envelope = QueueEnvelope(version: 1, scope: scope, events: events)
        try storage.write(AnalyticsJSON.encoder().encode(envelope), scope: scope)
    }

    private func removeAcknowledged(_ batch: [QueuedEvent]) throws {
        let ids = Set(batch.map(\.id))
        let previous = events
        events.removeAll { ids.contains($0.id) }
        do { try persist() } catch { events = previous; throw error }
    }

    private func scheduleRetry(retryAfter: TimeInterval?) {
        retryAttempt = min(retryAttempt + 1, 12)
        let backoff = min(3_600, pow(2, Double(retryAttempt)))
        let delay = max(backoff, min(max(retryAfter ?? 0, 0), 3_600))
        scheduleFlush(after: delay)
    }

    private func scheduleFlush(after seconds: TimeInterval) {
        guard configuration.automaticFlush, enabled, !events.isEmpty, scheduled == nil else { return }
        let current = generation
        scheduled = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(seconds)) } catch { return }
            await self?.performScheduledFlush(generation: current)
        }
    }

    private func performScheduledFlush(generation expected: UUID) async {
        guard generation == expected else { return }
        scheduled = nil
        _ = try? await flush()
    }

    private static func scope(configuration: AnalyticsConfiguration, baseURL: URL, subject: String) -> String {
        let input = "\(baseURL.absoluteString)|\(configuration.appNamespace)|\(configuration.environment.rawValue)|\(subject)"
        return SHA256.hash(data: Data(input.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private static func validSubject(_ value: String) -> Bool {
        value.range(of: "^[A-Za-z0-9_-]{8,128}$", options: .regularExpression) != nil
    }

    private static func validName(_ value: String) -> Bool {
        value.range(of: "^[a-z][a-z0-9_]{0,63}$", options: .regularExpression) != nil
    }

    private static func permitted(event: QueuedEvent, definitions: [String: AnalyticsEventDefinition]) -> Bool {
        guard let definition = definitions[event.name] else { return false }
        return event.properties.allSatisfy { key, value in definition.properties[key]?.permits(value) == true }
    }

    private static func validate(_ configuration: AnalyticsConfiguration) throws -> URL {
        let url = configuration.baseURL
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: true) else {
            throw AnalyticsError.invalidConfiguration("Invalid API URL")
        }
        let path = components.percentEncodedPath
        let local = ["localhost", "127.0.0.1", "[::1]", "::1"].contains(url.host?.lowercased() ?? "")
        guard url.scheme == "https" || (url.scheme == "http" && local && configuration.allowsLocalhostHTTP && configuration.environment == .development),
              url.host != nil, url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              path.range(of: "^(?:/[A-Za-z0-9._~-]+)*/?$", options: .regularExpression) != nil,
              !path.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }) else {
            throw AnalyticsError.invalidConfiguration("Use an HTTPS API URL with a plain mount path; localhost HTTP is development-only")
        }
        guard !configuration.appNamespace.isEmpty, configuration.appNamespace.count <= 128,
              (1...500).contains(configuration.maxQueuedEvents), !configuration.events.isEmpty,
              configuration.events.count <= 100 else {
            throw AnalyticsError.invalidConfiguration("Invalid namespace, event definitions or queue bound")
        }
        var names: Set<String> = []
        for event in configuration.events {
            guard validName(event.name), names.insert(event.name).inserted, event.properties.count <= 10 else {
                throw AnalyticsError.invalidConfiguration("Event names must be unique snake_case identifiers")
            }
            for (key, rule) in event.properties {
                guard validName(key), key.count <= 32 else { throw AnalyticsError.invalidConfiguration("Invalid property name") }
                if case .choice(let values) = rule,
                   values.isEmpty || values.count > 30 || values.contains(where: { $0.isEmpty || $0.utf8.count > 40 }) {
                    throw AnalyticsError.invalidConfiguration("Choices must be a small, fixed vocabulary")
                }
                if case .integer(let range) = rule,
                   range.lowerBound < -9_007_199_254_740_991 || range.upperBound > 9_007_199_254_740_991 {
                    throw AnalyticsError.invalidConfiguration("Integer bounds must be exactly representable in JSON")
                }
            }
        }
        components.percentEncodedPath = path.hasSuffix("/") ? String(path.dropLast()) : path
        guard let normalized = components.url else { throw AnalyticsError.invalidConfiguration("Invalid API URL") }
        return normalized
    }
}
