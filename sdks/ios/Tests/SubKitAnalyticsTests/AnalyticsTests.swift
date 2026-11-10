import Foundation
import Testing
@testable import SubKitAnalytics

private let instant = Date(timeIntervalSince1970: 1_794_052_800)
private let userA = "synthetic_user_a"
private let userB = "synthetic_user_b"

private final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Date
    init(_ value: Date = instant) { self.value = value }
    func now() -> Date { lock.lock(); defer { lock.unlock() }; return value }
    func advance(_ interval: TimeInterval) { lock.lock(); defer { lock.unlock() }; value += interval }
}

private final class MemoryStorage: AnalyticsQueueStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var files: [String: Data] = [:]
    func read(scope: String) throws -> Data? { lock.lock(); defer { lock.unlock() }; return files[scope] }
    func write(_ data: Data, scope: String) throws { lock.lock(); defer { lock.unlock() }; files[scope] = data }
    func remove(scope: String) throws { lock.lock(); defer { lock.unlock() }; files[scope] = nil }
    func snapshots() -> [Data] { lock.lock(); defer { lock.unlock() }; return Array(files.values) }
}

private actor RecordingTransport: AnalyticsTransport {
    private var responses: [AnalyticsHTTPResponse]
    private(set) var requests: [URLRequest] = []
    init(_ responses: [AnalyticsHTTPResponse] = []) { self.responses = responses }
    func send(_ request: URLRequest) async throws -> AnalyticsHTTPResponse {
        requests.append(request)
        guard !responses.isEmpty else { throw URLError(.notConnectedToInternet) }
        return responses.removeFirst()
    }
}

private actor RefreshingTokenProvider {
    private(set) var calls = 0
    func credential() -> CollectorToken {
        calls += 1
        return CollectorToken(token: "synthetic.collector.\(calls)", subject: userA,
                              environment: .development, expiresAt: instant.addingTimeInterval(3_600))
    }
}

private actor SuspendedTransport: AnalyticsTransport {
    private(set) var requests: [URLRequest] = []
    private var continuation: CheckedContinuation<AnalyticsHTTPResponse, Never>?
    private var waiter: CheckedContinuation<Void, Never>?
    func send(_ request: URLRequest) async throws -> AnalyticsHTTPResponse {
        requests.append(request)
        waiter?.resume()
        waiter = nil
        return await withCheckedContinuation { continuation = $0 }
    }
    func waitForRequest() async {
        if !requests.isEmpty { return }
        await withCheckedContinuation { waiter = $0 }
    }
    func resolve(_ response: AnalyticsHTTPResponse) {
        continuation?.resume(returning: response)
        continuation = nil
    }
}

private actor SuspendedToken {
    private var continuation: CheckedContinuation<CollectorToken, Never>?
    private var waiter: CheckedContinuation<Void, Never>?
    private var requested = false
    func get() async -> CollectorToken {
        requested = true
        waiter?.resume()
        waiter = nil
        return await withCheckedContinuation { continuation = $0 }
    }
    func waitForRequest() async {
        if requested { return }
        await withCheckedContinuation { waiter = $0 }
    }
    func resolve(_ credential: CollectorToken) { continuation?.resume(returning: credential); continuation = nil }
}

private func ack(_ count: Int, duplicates: Int = 0) -> AnalyticsHTTPResponse {
    AnalyticsHTTPResponse(status: 200, body: Data("{\"accepted\":\(count),\"duplicates\":\(duplicates)}".utf8))
}

private func token(_ subject: String = userA, environment: AnalyticsEnvironment = .development,
                   expiry: Date = instant.addingTimeInterval(3_600)) -> CollectorToken {
    CollectorToken(token: "synthetic.collector.token", subject: subject, environment: environment, expiresAt: expiry)
}

private func config(max: Int = 500, automatic: Bool = false, baseURL: String = "https://analytics.example.test",
                    environment: AnalyticsEnvironment = .development, localhost: Bool = false) -> AnalyticsConfiguration {
    AnalyticsConfiguration(baseURL: URL(string: baseURL)!, appNamespace: "synthetic-app", environment: environment,
        events: [AnalyticsEventDefinition("app_opened"), AnalyticsEventDefinition("action_completed", properties: [
            "source": .choice(["button", "shortcut"]), "success": .boolean, "count": .integer(0...10)
        ])], allowsLocalhostHTTP: localhost, automaticFlush: automatic, maxQueuedEvents: max)
}

private func client(storage: MemoryStorage = MemoryStorage(), transport: any AnalyticsTransport = RecordingTransport(),
                    clock: TestClock = TestClock(), subject: String = userA, enabled: Bool = true,
                    max: Int = 500) throws -> SubKitAnalytics {
    try SubKitAnalytics(configuration: config(max: max), subject: subject, enabled: enabled,
                        storage: storage, transport: transport, clock: { clock.now() }, tokenProvider: { token(subject) })
}

private func events(in request: URLRequest) throws -> [QueuedEvent] {
    try AnalyticsJSON.decoder().decode(EventBatch.self, from: #require(request.httpBody)).events
}

@Suite("Explicit, isolated and durable usage collection")
struct AnalyticsTests {
    @Test func disabledByDefaultDoesNotQueueOrSend() async throws {
        let storage = MemoryStorage()
        let transport = RecordingTransport()
        let sdk = try SubKitAnalytics(configuration: config(), subject: userA, storage: storage,
                                      transport: transport, clock: { instant }, tokenProvider: { token() })
        #expect(try await sdk.track("app_opened") == nil)
        #expect(try await sdk.flush() == FlushResult())
        #expect(await transport.requests.isEmpty)
        #expect(storage.snapshots().isEmpty)
    }

    @Test func rejectsUnknownEventsAndPropertiesBeforePersistence() async throws {
        let sdk = try client()
        await #expect(throws: AnalyticsError.eventNotAllowed("meal_name")) { try await sdk.track("meal_name") }
        await #expect(throws: AnalyticsError.propertyNotAllowed("email")) {
            try await sdk.track("app_opened", properties: ["email": .choice("member@example.test")])
        }
        await #expect(throws: AnalyticsError.invalidProperty("source")) {
            try await sdk.track("action_completed", properties: ["source": .choice("free text")])
        }
        await #expect(throws: AnalyticsError.invalidProperty("count")) {
            try await sdk.track("action_completed", properties: ["count": .integer(11)])
        }
        #expect(await sdk.pendingEventCount == 0)
    }

    @Test func transientFailureRetriesExactlyTheSameEvent() async throws {
        let transport = RecordingTransport([AnalyticsHTTPResponse(status: 503, body: Data()), ack(1)])
        let sdk = try client(transport: transport)
        let id = try await sdk.track("app_opened")
        await #expect(throws: AnalyticsError.httpStatus(503)) { try await sdk.flush() }
        #expect(await sdk.pendingEventCount == 1)
        #expect(try await sdk.flush() == FlushResult(accepted: 1))
        let requests = await transport.requests
        #expect(requests.count == 2)
        #expect(requests[0].httpBody == requests[1].httpBody)
        #expect(try events(in: requests[1]).first?.id == id)
        #expect(await sdk.pendingEventCount == 0)
    }

    @Test func duplicateAcknowledgmentCompletesRetry() async throws {
        let sdk = try client(transport: RecordingTransport([ack(0, duplicates: 1)]))
        try await sdk.track("app_opened")
        #expect(try await sdk.flush() == FlushResult(duplicates: 1))
        #expect(await sdk.pendingEventCount == 0)
    }

    @Test func unauthorizedResponseRetainsEventsAndAutomaticallyFetchesFreshToken() async throws {
        let transport = RecordingTransport([AnalyticsHTTPResponse(status: 401, body: Data()), ack(1)])
        let provider = RefreshingTokenProvider()
        let sdk = try SubKitAnalytics(configuration: config(automatic: true), subject: userA, enabled: true,
            storage: MemoryStorage(), transport: transport, clock: { instant },
            tokenProvider: { await provider.credential() })
        let identifier = try await sdk.track("app_opened")
        await #expect(throws: AnalyticsError.httpStatus(401)) { try await sdk.flush() }
        #expect(await sdk.pendingEventCount == 1)
        let deadline = ContinuousClock.now.advanced(by: .seconds(6))
        while await sdk.pendingEventCount > 0, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(50))
        }
        #expect(await provider.calls == 2)
        #expect(await sdk.pendingEventCount == 0)
        let requests = await transport.requests
        #expect(requests.count == 2)
        #expect(requests[0].httpBody == requests[1].httpBody)
        #expect(try events(in: requests[1]).first?.id == identifier)
        #expect(requests[0].value(forHTTPHeaderField: "Authorization") == "Bearer synthetic.collector.1")
        #expect(requests[1].value(forHTTPHeaderField: "Authorization") == "Bearer synthetic.collector.2")
    }

    @Test func automaticModeRetriesTransientFailureWithoutAnotherTrack() async throws {
        let transport = RecordingTransport([AnalyticsHTTPResponse(status: 503, body: Data()), ack(1)])
        let sdk = try SubKitAnalytics(configuration: config(automatic: true), subject: userA, enabled: true,
            storage: MemoryStorage(), transport: transport, clock: { instant }, tokenProvider: { token() })
        try await sdk.track("app_opened")
        await #expect(throws: AnalyticsError.httpStatus(503)) { try await sdk.flush() }
        let deadline = ContinuousClock.now.advanced(by: .seconds(6))
        while await sdk.pendingEventCount > 0, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(50))
        }
        #expect(await transport.requests.count == 2)
        #expect(await sdk.pendingEventCount == 0)
        let requests = await transport.requests
        #expect(requests[0].httpBody == requests[1].httpBody)
    }

    @Test func restartedAutomaticClientFlushesPersistedQueue() async throws {
        let storage = MemoryStorage()
        let original = try client(storage: storage)
        try await original.track("app_opened")
        let transport = RecordingTransport([ack(1)])
        let resumed = try SubKitAnalytics(configuration: config(automatic: true), subject: userA, enabled: true,
            storage: storage, transport: transport, clock: { instant }, tokenProvider: { token() })
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while await resumed.pendingEventCount > 0, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(await transport.requests.count == 1)
        #expect(await resumed.pendingEventCount == 0)
    }

    @Test func ambiguousAcknowledgmentAndAsync202KeepPending() async throws {
        let transport = RecordingTransport([ack(0), AnalyticsHTTPResponse(status: 202, body: Data())])
        let sdk = try client(transport: transport)
        try await sdk.track("app_opened")
        await #expect(throws: AnalyticsError.invalidAcknowledgment) { try await sdk.flush() }
        #expect(await sdk.pendingEventCount == 1)
        await #expect(throws: AnalyticsError.httpStatus(202)) { try await sdk.flush() }
        #expect(await sdk.pendingEventCount == 1)
    }

    @Test func permanentRejectionIsReportedAsDiscarded() async throws {
        let sdk = try client(transport: RecordingTransport([AnalyticsHTTPResponse(status: 400, body: Data())]))
        try await sdk.track("app_opened")
        #expect(try await sdk.flush() == FlushResult(discarded: 1))
        #expect(await sdk.pendingEventCount == 0)
    }

    @Test func batchesAtFiftyWithoutDiscardingLaterEvents() async throws {
        let transport = RecordingTransport([ack(50), ack(25)])
        let sdk = try client(transport: transport)
        for _ in 0..<75 { try await sdk.track("app_opened") }
        #expect(try await sdk.flush().accepted == 50)
        #expect(await sdk.pendingEventCount == 25)
        #expect(try await sdk.flush().accepted == 25)
        let requests = await transport.requests
        #expect(try events(in: requests[0]).count == 50)
        #expect(try events(in: requests[1]).count == 25)
    }

    @Test func boundedQueueRetainsNewestEvents() async throws {
        let transport = RecordingTransport([ack(3)])
        let sdk = try client(transport: transport, max: 3)
        var identifiers: [UUID] = []
        for _ in 0..<5 { identifiers.append(try #require(await sdk.track("app_opened"))) }
        #expect(await sdk.pendingEventCount == 3)
        try await sdk.flush()
        #expect(try events(in: await transport.requests[0]).map(\.id) == Array(identifiers.suffix(3)))
    }

    @Test func relaunchRestoresOnlySameAppAccountAndEnvironment() async throws {
        let storage = MemoryStorage()
        let first = try client(storage: storage)
        let id = try await first.track("app_opened")
        let transport = RecordingTransport([ack(1)])
        let resumed = try client(storage: storage, transport: transport)
        #expect(await resumed.pendingEventCount == 1)
        #expect(await (try client(storage: storage, subject: userB)).pendingEventCount == 0)
        let production = try SubKitAnalytics(configuration: config(environment: .production), subject: userA,
            enabled: true, storage: storage, clock: { instant }, tokenProvider: { token(environment: .production) })
        #expect(await production.pendingEventCount == 0)
        let savedText = String(decoding: try #require(storage.snapshots().first), as: UTF8.self)
        #expect(!savedText.contains(userA))
        #expect(!savedText.contains("synthetic.collector.token"))
        try await resumed.flush()
        #expect(try events(in: await transport.requests[0]).first?.id == id)
    }

    @Test func oldEventsExpireAfterSevenDays() async throws {
        let storage = MemoryStorage()
        let clock = TestClock()
        let sdk = try client(storage: storage, clock: clock)
        try await sdk.track("app_opened")
        clock.advance(7 * 86_400)
        let resumed = try client(storage: storage, clock: clock)
        #expect(await resumed.pendingEventCount == 0)
        #expect(try await sdk.flush() == FlushResult())
        #expect(storage.snapshots().isEmpty)
    }

    @Test func disablePurgesPersistenceAndStopsTracking() async throws {
        let storage = MemoryStorage()
        let sdk = try client(storage: storage)
        try await sdk.track("app_opened")
        try await sdk.setEnabled(false)
        #expect(await sdk.pendingEventCount == 0)
        #expect(storage.snapshots().isEmpty)
        #expect(try await sdk.track("app_opened") == nil)
    }

    @Test func accountSwitchFencesLateHTTPCompletion() async throws {
        let transport = SuspendedTransport()
        let sdk = try client(transport: transport)
        try await sdk.track("app_opened")
        let oldRequest = Task { try await sdk.flush() }
        await transport.waitForRequest()
        try await sdk.setIdentity(userB, enabled: true, tokenProvider: { token(userB) })
        let newId = try await sdk.track("app_opened")
        await transport.resolve(ack(1))
        #expect(try await oldRequest.value.superseded)
        #expect(await sdk.pendingEventCount == 1)
        #expect(newId != nil)
        #expect(await transport.requests.count == 1)
    }

    @Test func accountSwitchCancelsLateTokenBeforeAnyHTTP() async throws {
        let tokenGate = SuspendedToken()
        let transport = RecordingTransport([ack(1)])
        let sdk = try SubKitAnalytics(configuration: config(), subject: userA, enabled: true,
            storage: MemoryStorage(), transport: transport, clock: { instant }, tokenProvider: { await tokenGate.get() })
        try await sdk.track("app_opened")
        let pending = Task { try await sdk.flush() }
        await tokenGate.waitForRequest()
        try await sdk.setIdentity(userB, enabled: true, tokenProvider: { token(userB) })
        try await sdk.track("app_opened")
        await tokenGate.resolve(token())
        #expect(try await pending.value.superseded)
        #expect(await transport.requests.isEmpty)
        #expect(try await sdk.flush().accepted == 1)
    }

    @Test func disableFencesLateHTTPCompletion() async throws {
        let transport = SuspendedTransport()
        let storage = MemoryStorage()
        let sdk = try client(storage: storage, transport: transport)
        try await sdk.track("app_opened")
        let request = Task { try await sdk.flush() }
        await transport.waitForRequest()
        try await sdk.setEnabled(false)
        await transport.resolve(ack(1))
        #expect(try await request.value.superseded)
        #expect(storage.snapshots().isEmpty)
    }

    @Test func newIdentityRequiresItsOwnConsentAndNewSession() async throws {
        let transport = RecordingTransport([ack(1), ack(1)])
        let sdk = try client(transport: transport)
        try await sdk.track("app_opened")
        try await sdk.flush()
        try await sdk.setIdentity(userB, tokenProvider: { token(userB) })
        #expect(!(await sdk.isEnabled))
        #expect(try await sdk.track("app_opened") == nil)
        try await sdk.setEnabled(true)
        try await sdk.track("app_opened")
        try await sdk.flush()
        let requests = await transport.requests
        #expect(try events(in: requests[0]).first?.sessionId != events(in: requests[1]).first?.sessionId)
    }

    @Test func inactivityStartsNewSession() async throws {
        let clock = TestClock()
        let transport = RecordingTransport([ack(3)])
        let sdk = try client(transport: transport, clock: clock)
        try await sdk.track("app_opened")
        clock.advance(60)
        try await sdk.track("app_opened")
        clock.advance(30 * 60)
        try await sdk.track("app_opened")
        try await sdk.flush()
        let sent = try events(in: await transport.requests[0])
        #expect(sent[0].sessionId == sent[1].sessionId)
        #expect(sent[1].sessionId != sent[2].sessionId)
    }

    @Test func tokenMustMatchIdentityEnvironmentAndExpiry() async throws {
        for (credential, error) in [
            (token(userB), AnalyticsError.tokenIdentityMismatch),
            (token(environment: .production), AnalyticsError.tokenEnvironmentMismatch),
            (token(expiry: instant), AnalyticsError.expiredToken)
        ] {
            let transport = RecordingTransport()
            let sdk = try SubKitAnalytics(configuration: config(), subject: userA, enabled: true,
                storage: MemoryStorage(), transport: transport, clock: { instant }, tokenProvider: { credential })
            try await sdk.track("app_opened")
            await #expect(throws: error) { try await sdk.flush() }
            #expect(await transport.requests.isEmpty)
            #expect(await sdk.pendingEventCount == 1)
        }
    }

    @Test func rejectsInsecureOriginsAndEmailIdentity() throws {
        for configuration in [config(baseURL: "http://example.test"),
                              config(baseURL: "http://localhost:8080"),
                              config(baseURL: "http://localhost:8080", environment: .production, localhost: true),
                              config(baseURL: "https://user:password@example.test"),
                              config(baseURL: "https://example.test?secret=value")] {
            #expect(throws: AnalyticsError.self) {
                try SubKitAnalytics(configuration: configuration, subject: userA, storage: MemoryStorage(), tokenProvider: { token() })
            }
        }
        #expect(throws: AnalyticsError.invalidIdentity) {
            try client(subject: "person@example.test")
        }
        _ = try SubKitAnalytics(configuration: config(baseURL: "http://localhost:8080", localhost: true),
            subject: userA, storage: MemoryStorage(), tokenProvider: { token() })
    }

    @Test func diskStorageRestoresEventsAndExcludesTokens() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let storage = try FileAnalyticsQueueStorage(directory: directory)
        let sdk = try SubKitAnalytics(configuration: config(), subject: userA, enabled: true,
            storage: storage, clock: { instant }, tokenProvider: { token() })
        try await sdk.track("action_completed", properties: ["success": .boolean(true), "source": .choice("button")])
        let resumed = try SubKitAnalytics(configuration: config(), subject: userA, enabled: true,
            storage: storage, clock: { instant }, tokenProvider: { token() })
        #expect(await resumed.pendingEventCount == 1)
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        #expect(files.count == 1)
        let permissions = try FileManager.default.attributesOfItem(atPath: files[0].path)[.posixPermissions] as? NSNumber
        #expect(permissions?.intValue == 0o600)
        let text = try String(contentsOf: files[0], encoding: .utf8)
        #expect(!text.contains("token"))
        try await resumed.signOut()
        #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path).isEmpty)
    }
}
