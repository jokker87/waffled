import SwiftUI

/// Waffled for Mac: a menu-bar icon that runs the family server and gets out of the way.
///
/// There is no window and no Dock icon (`LSUIElement`) on purpose — the product is the web
/// app the server serves, exactly as the plan's §1 says. Everything this app can do,
/// `waffled-runtime` can do from Terminal.
@main
struct WaffledApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = ServerModel.shared

    var body: some Scene {
        MenuBarExtra {
            MenuContent(model: model)
        } label: {
            // A menu-bar image is a monochrome template: macOS recolours it for light,
            // dark and the menu's own highlight, so state is carried by shape (fill,
            // slash) and never by colour.
            Image(systemName: model.currentSymbol)
                .accessibilityLabel(model.icon.accessibilityLabel)
        }
        // .menu, not .window: the §2 mock-up is a menu, and .menu is what draws like every
        // other menu-bar item on the Mac.
        .menuBarExtraStyle(.menu)
    }
}

/// The polling loop is started from the delegate rather than from a view: a
/// `MenuBarExtra`'s content is not built until someone opens the menu, and the server has
/// to be on its way up long before that.
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        MainActor.assumeIsolated { ServerModel.shared.begin() }
    }

    func applicationWillTerminate(_ notification: Notification) {
        MainActor.assumeIsolated { ServerModel.shared.end() }
    }
}

private struct MenuContent: View {
    @Bindable var model: ServerModel

    var body: some View {
        let menu = model.presentation

        Text("\(menu.statusTint.glyph) \(menu.statusLine)")

        Button("Open Waffled") { model.openWebApp() }
            .disabled(!menu.openEnabled)

        Divider()

        Button(menu.addressLine) { model.copyServerAddress() }
            .disabled(!menu.addressEnabled)

        if model.loginItem.isAvailable {
            Toggle("Start at login", isOn: Binding(
                get: { model.loginItem.isEnabled },
                set: { model.loginItem.setEnabled($0) }))
        } else {
            // The reason goes in the label: a .help(_:) tooltip does not render on an
            // item in a .menu-style MenuBarExtra, and a disabled toggle with no
            // explanation is worse than no toggle.
            Button("Start at login — \(model.loginItem.unavailableReason ?? "unavailable")") {}
                .disabled(true)
        }

        Button("Back up now") { model.backUpNow() }
            .disabled(!menu.backupEnabled)

        Button("Check for updates… (coming with the updater)") {}
            .disabled(true)

        if menu.showLogs {
            Button("Show logs") { model.revealLogs() }
        }

        Divider()

        Button("Quit Waffled") { model.confirmAndQuit() }
    }
}

private extension StatusTint {
    /// The dot in front of the status line. It is a character rather than a coloured view
    /// because this line is disabled — greyed, per the §2 mock-up — and a menu greys the
    /// colour out of it anyway; the shape is what survives, and it is enough.
    var glyph: String {
        switch self {
        case .running: return "●"
        case .starting: return "◐"
        case .idle: return "○"
        case .fault: return "⚠"
        }
    }
}
