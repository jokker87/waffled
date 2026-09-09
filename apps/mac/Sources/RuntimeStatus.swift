import Foundation

/// The four words `state` can hold (apps/runtime/internal/status).
enum RuntimeState: String, Equatable {
    case stopped, starting, running, unhealthy
}

struct RuntimeStatus: Equatable {
    struct URLs: Equatable { var local = ""; var lan = ""; var powersync = "" }
    struct Ports: Equatable {
        var `public` = 0; var powersyncPublic = 0; var api = 0
        var powersync = 0; var postgres = 0
    }
    struct Versions: Equatable {
        var waffled = ""; var node = ""; var postgres = ""; var caddy = ""
        var powersync = ""; var api = ""; var web = ""
    }
    struct BundleInfo: Equatable {
        var gitSha = ""; var builtAt = ""; var arch = ""; var platform = ""
        var verified = false; var version = ""
        var previousVersion = ""; var versionChangedAt = ""
    }
    struct SupervisorInfo: Equatable { var pid = 0; var running = false }
    struct Service: Equatable {
        var name = ""; var state = RuntimeState.stopped; var pid = 0; var port = 0
        var health = ""; var restarts = 0; var lastError = ""; var log = ""
    }
    struct Backups: Equatable {
        var dir = ""; var lastBackupAt = ""; var lastPath = ""; var lastSizeBytes: Int64 = 0
        var lastMigration = ""; var count = 0; var lastError = ""; var lastErrorAt = ""
        var scheduleInstalled = false
    }
    struct Bonjour: Equatable {
        var advertised = false; var name = ""; var service = ""; var port = 0
        var host = ""; var error = ""
    }

    var schema = 0
    var state = RuntimeState.stopped
    var dataDir = ""
    var bundleDir = ""
    var urls = URLs()
    var ports = Ports()
    var versions = Versions()
    var bundle = BundleInfo()
    var supervisor = SupervisorInfo()
    var services: [Service] = []
    var backups = Backups()
    var bonjour = Bonjour()
    var lastError = ""
    var generatedAt = ""

    static func decode(_ data: Data) throws -> RuntimeStatus {
        fatalError("not implemented")
    }

    var serverAddress: String? {
        fatalError("not implemented")
    }
}

enum RuntimeStatusError: Error, Equatable {
    case unsupportedSchema(Int)
}
