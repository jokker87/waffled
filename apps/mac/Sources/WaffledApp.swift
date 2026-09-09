import SwiftUI

@main
struct WaffledApp: App {
    var body: some Scene {
        MenuBarExtra("Waffled", systemImage: "square.grid.2x2") {
            Text("Waffled")
        }
        .menuBarExtraStyle(.menu)
    }
}
