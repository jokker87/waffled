import Foundation

struct IconAppearance: Equatable {
    var symbolNames: [String]
    var accessibilityLabel: String
    var isAnimated: Bool { symbolNames.count > 1 }

    static func forState(_ state: RuntimeState) -> IconAppearance {
        fatalError("not implemented")
    }
}

enum StatusTint: Equatable {
    case running, starting, idle, fault

    static func forState(_ state: RuntimeState) -> StatusTint {
        fatalError("not implemented")
    }
}

struct MenuPresentation: Equatable {
    var statusLine: String
    var statusTint: StatusTint
    var openEnabled: Bool
    var addressLine: String
    var addressEnabled: Bool
    var backupEnabled: Bool
    var showLogs: Bool
    var checkForUpdatesEnabled: Bool

    static func make(
        status: RuntimeStatus?,
        failure: String? = nil,
        transient: String? = nil,
        busy: Bool = false
    ) -> MenuPresentation {
        fatalError("not implemented")
    }
}

enum Lifecycle {
    static func shouldAutoStart(_ state: RuntimeState) -> Bool {
        fatalError("not implemented")
    }

    static func shouldOpenBrowser(
        newState: RuntimeState, startWasAppInitiated: Bool, alreadyOpened: Bool
    ) -> Bool {
        fatalError("not implemented")
    }

    static func pollInterval(for state: RuntimeState?) -> TimeInterval {
        fatalError("not implemented")
    }
}
