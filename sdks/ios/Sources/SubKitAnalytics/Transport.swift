import Foundation

public struct AnalyticsHTTPResponse: Sendable {
    public let status: Int
    public let body: Data
    public let retryAfter: TimeInterval?

    public init(status: Int, body: Data, retryAfter: TimeInterval? = nil) {
        self.status = status
        self.body = body
        self.retryAfter = retryAfter
    }
}

public protocol AnalyticsTransport: Sendable {
    func send(_ request: URLRequest) async throws -> AnalyticsHTTPResponse
}

/// An ephemeral session avoids cookies, URL caches and credential persistence.
public final class URLSessionAnalyticsTransport: NSObject, AnalyticsTransport, URLSessionTaskDelegate, @unchecked Sendable {
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 15
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()
    private let lock = NSLock()

    public override init() { super.init() }

    private func sharedSession() -> URLSession {
        lock.lock()
        defer { lock.unlock() }
        return session
    }

    public func send(_ request: URLRequest) async throws -> AnalyticsHTTPResponse {
        let (data, response) = try await sharedSession().data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        let delay = http.value(forHTTPHeaderField: "Retry-After").flatMap(TimeInterval.init)
        return AnalyticsHTTPResponse(status: http.statusCode, body: data, retryAfter: delay)
    }

    /// Never forward bearer credentials to a redirect target.
    public func urlSession(_ session: URLSession, task: URLSessionTask,
                           willPerformHTTPRedirection response: HTTPURLResponse,
                           newRequest request: URLRequest,
                           completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
