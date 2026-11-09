import Foundation

/// Synchronous operations are serialized by the analytics actor. Implementations must be thread-safe.
public protocol AnalyticsQueueStorage: Sendable {
    func read(scope: String) throws -> Data?
    func write(_ data: Data, scope: String) throws
    func remove(scope: String) throws
}

public struct FileAnalyticsQueueStorage: AnalyticsQueueStorage {
    private let directory: URL

    public init(directory: URL) throws {
        guard directory.isFileURL else { throw AnalyticsError.invalidConfiguration("Storage must be a file URL") }
        self.directory = directory
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        var excluded = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try excluded.setResourceValues(values)
    }

    private func file(_ scope: String) -> URL {
        // Scope is a SHA256 hex digest created inside the SDK, never an app-supplied path.
        directory.appendingPathComponent(scope).appendingPathExtension("json")
    }

    public func read(scope: String) throws -> Data? {
        let file = file(scope)
        guard FileManager.default.fileExists(atPath: file.path) else { return nil }
        let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
        guard let size = attributes[.size] as? NSNumber, size.intValue <= 4 * 1024 * 1024 else {
            throw AnalyticsError.invalidStoredQueue
        }
        return try Data(contentsOf: file)
    }

    public func write(_ data: Data, scope: String) throws {
        let file = file(scope)
        #if os(iOS)
        try data.write(to: file, options: [.atomic, .completeFileProtectionUnlessOpen])
        #else
        try data.write(to: file, options: [.atomic])
        #endif
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }

    public func remove(scope: String) throws {
        let file = file(scope)
        if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
    }
}
