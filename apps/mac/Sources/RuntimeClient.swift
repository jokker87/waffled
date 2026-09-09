import Foundation

struct RuntimeProcessResult: Equatable {
    var exitCode: Int32
    var standardOutput: Data
    var standardError: String
}

/// Everything the app runs goes through this, so the tests never spawn a process.
protocol RuntimeProcessRunning: Sendable {
    func run(executable: URL, arguments: [String]) async throws -> RuntimeProcessResult
}

struct RuntimeLocation: Equatable {
    var binary: URL
    var bundleDir: URL?
    var dataDir: URL?
    var isDevMode: Bool
}

enum RuntimeLocator {
    static func locate(environment: [String: String], resourceURL: URL?) -> RuntimeLocation? {
        fatalError("not implemented")
    }
}

enum RuntimeClientError: Error, Equatable {
    case commandFailed(command: String, exitCode: Int32, message: String)
    case cannotRunRuntime(path: String, reason: String)
    case unreadableStatus(String)

    var firstLine: String { fatalError("not implemented") }
}

struct RuntimeClient {
    var location: RuntimeLocation
    var runner: RuntimeProcessRunning

    func status() async throws -> RuntimeStatus { fatalError("not implemented") }
    func start() async throws { fatalError("not implemented") }
    func stop() async throws { fatalError("not implemented") }
    @discardableResult func backup() async throws -> String { fatalError("not implemented") }
}
