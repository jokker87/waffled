import Foundation
import Observation
import ServiceManagement

/// "Start at login", which for a family server is most of the point: the Mac mini on the
/// shelf reboots after an update and the household expects Waffled to be there.
///
/// `SMAppService.mainApp` registers the running `.app` itself — no helper target, no
/// separate bundle id. It is asked once at launch and after each toggle rather than on
/// every poll: the answer changes only when someone changes it, here or in System
/// Settings, and each call crosses into launchd.
@MainActor
@Observable
final class LoginItem {
    private(set) var isEnabled = false
    /// Why the toggle is unavailable, if it is. Shown in the item's own label, because a
    /// `.help(_:)` tooltip does not render on an item in a `.menu`-style `MenuBarExtra`.
    private(set) var unavailableReason: String?

    var isAvailable: Bool { unavailableReason == nil }

    func refresh() {
        switch SMAppService.mainApp.status {
        case .enabled:
            isEnabled = true
            unavailableReason = nil
        case .notRegistered, .notFound:
            isEnabled = false
            unavailableReason = nil
        case .requiresApproval:
            // Registered, but someone has switched it off in System Settings → Login
            // Items. launchd will not run it until they switch it back, and no amount of
            // registering from here changes that.
            isEnabled = false
            unavailableReason = "approve Waffled in System Settings → General → Login Items"
        @unknown default:
            isEnabled = false
            unavailableReason = nil
        }
    }

    func setEnabled(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            refresh()
        } catch {
            // Expected in a development build: launchd will not adopt an app running from
            // DerivedData, and an ad-hoc signature is not an identity it will keep across
            // rebuilds. Say so rather than leaving a toggle that silently does nothing.
            //
            // Re-read the real state, but keep the reason we just captured — a plain
            // `refresh()` here would clear the only explanation there is.
            isEnabled = SMAppService.mainApp.status == .enabled
            unavailableReason = error.localizedDescription
        }
    }
}
