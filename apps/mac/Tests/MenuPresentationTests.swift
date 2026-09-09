import XCTest
@testable import Waffled

/// Everything the menu shows is a pure function of the last status document, so all of it
/// can be asserted without a menu, a process, or a run loop.
final class MenuPresentationTests: XCTestCase {

    // MARK: icon

    func testEachStateHasItsOwnIconAndSpokenLabel() {
        let stopped = IconAppearance.forState(.stopped)
        let starting = IconAppearance.forState(.starting)
        let running = IconAppearance.forState(.running)
        let unhealthy = IconAppearance.forState(.unhealthy)

        XCTAssertEqual(stopped.symbolNames, ["house"])
        XCTAssertEqual(running.symbolNames, ["house.fill"])
        XCTAssertEqual(unhealthy.symbolNames, ["house.slash"])
        // Starting is the only animated one: the icon cycles these on a timer.
        XCTAssertEqual(starting.symbolNames, ["house", "house.fill"])

        XCTAssertFalse(stopped.isAnimated)
        XCTAssertFalse(running.isAnimated)
        XCTAssertFalse(unhealthy.isAnimated)
        XCTAssertTrue(starting.isAnimated)

        XCTAssertEqual(stopped.accessibilityLabel, "Waffled is stopped")
        XCTAssertEqual(starting.accessibilityLabel, "Waffled is starting")
        XCTAssertEqual(running.accessibilityLabel, "Waffled is running")
        XCTAssertEqual(unhealthy.accessibilityLabel, "Waffled needs attention")

        // The four are genuinely distinguishable in the menu bar, which is the point.
        let firstFrames = Set([stopped, starting, running, unhealthy].map { $0.symbolNames[0] })
        XCTAssertEqual(firstFrames.count, 3, "only starting may share a frame with another state")
    }

    /// Colour belongs to the status line, never the icon: menu-bar icons are template
    /// images and macOS recolours them for the menu bar's own appearance.
    func testStatusTintIsPerStateAndLivesInTheMenuNotTheIcon() {
        XCTAssertEqual(StatusTint.forState(.running), .running)
        XCTAssertEqual(StatusTint.forState(.starting), .starting)
        XCTAssertEqual(StatusTint.forState(.stopped), .idle)
        XCTAssertEqual(StatusTint.forState(.unhealthy), .fault)
    }

    // MARK: server address

    func testServerAddressPrefersTheLanURL() throws {
        let s = try RuntimeStatus.decode(Fixtures.data(Fixtures.fullRunning))
        XCTAssertEqual(s.serverAddress, "192.168.1.5:8080")
    }

    /// No LAN URL but an advertisement: the mock-up's `kevins-mac-mini.local:8080` form.
    /// The Bonjour block's own port can be 0 (nothing advertising right now), so the
    /// public port stands in — it is the same port either way.
    func testServerAddressFallsBackToBonjourHostAndThePublicPort() throws {
        let s = try RuntimeStatus.decode(Fixtures.data(Fixtures.bonjourOnly))
        XCTAssertEqual(s.serverAddress, "kevins-mac-mini.local:8090")
    }

    func testServerAddressIsNilWhenNothingIsReachableFromAnotherDevice() throws {
        let s = try RuntimeStatus.decode(Fixtures.data(Fixtures.noAddress))
        XCTAssertNil(s.serverAddress)
    }

    // MARK: the menu's enabled/disabled table

    func testRunningEnablesEverythingItCan() throws {
        let s = try RuntimeStatus.decode(Fixtures.data(Fixtures.fullRunning))
        let m = MenuPresentation.make(status: s)

        XCTAssertEqual(m.statusLine, "Waffled is running")
        XCTAssertEqual(m.statusTint, .running)
        XCTAssertTrue(m.openEnabled)
        XCTAssertEqual(m.addressLine, "Server address: 192.168.1.5:8080")
        XCTAssertTrue(m.addressEnabled)
        XCTAssertTrue(m.backupEnabled)
        XCTAssertFalse(m.showLogs)
        // Present but inert until Phase 3 item 6 ships the appcast.
        XCTAssertFalse(m.checkForUpdatesEnabled)
    }

    func testStartingDisablesTheActionsThatNeedAServer() throws {
        let s = try RuntimeStatus.decode(Fixtures.data(Fixtures.withUnknownFields))
        let m = MenuPresentation.make(status: s)

        XCTAssertEqual(m.statusLine, "Waffled is starting…")
        XCTAssertEqual(m.statusTint, .starting)
        XCTAssertFalse(m.openEnabled)
        XCTAssertFalse(m.addressEnabled)
        XCTAssertFalse(m.showLogs)
    }

    /// Backup is enabled while stopped on purpose: `waffled-runtime backup` starts
    /// Postgres for itself, and "am I protected?" is asked exactly when nothing is up.
    func testStoppedStillAllowsABackup() throws {
        let s = try RuntimeStatus.decode(Fixtures.data(Fixtures.minimalStopped))
        let m = MenuPresentation.make(status: s)

        XCTAssertEqual(m.statusLine, "Waffled is stopped")
        XCTAssertEqual(m.statusTint, .idle)
        XCTAssertFalse(m.openEnabled)
        XCTAssertEqual(m.addressLine, "Server address: —")
        XCTAssertFalse(m.addressEnabled)
        XCTAssertTrue(m.backupEnabled)
        XCTAssertFalse(m.showLogs)
    }

    func testUnhealthyShowsTheRuntimesOwnFirstLineAndOffersTheLogs() throws {
        let s = try RuntimeStatus.decode(Fixtures.data(Fixtures.unhealthy))
        let m = MenuPresentation.make(status: s)

        XCTAssertEqual(m.statusLine, "api exited with status 1")
        XCTAssertEqual(m.statusTint, .fault)
        XCTAssertFalse(m.openEnabled)
        XCTAssertFalse(m.addressEnabled, "an address nothing is answering on is not an address")
        XCTAssertTrue(m.showLogs)
    }

    /// A failed `start` is reported by the app, not by a status document: the runtime
    /// exited, so `state` may still read `stopped`.
    func testAFailureOverridesTheStatusLineAndRevealsTheLogs() throws {
        let s = try RuntimeStatus.decode(Fixtures.data(Fixtures.minimalStopped))
        let m = MenuPresentation.make(
            status: s,
            failure: "postgres refused to start\ninitdb: could not create directory")

        XCTAssertEqual(m.statusLine, "postgres refused to start")
        XCTAssertEqual(m.statusTint, .fault)
        XCTAssertTrue(m.showLogs)
        XCTAssertFalse(m.openEnabled)
    }

    /// "Back up now" and the address click both answer in the status line for a few
    /// seconds. A transient message wins over everything, including a failure.
    func testATransientMessageTakesTheStatusLine() throws {
        let s = try RuntimeStatus.decode(Fixtures.data(Fixtures.fullRunning))
        let m = MenuPresentation.make(status: s, transient: "Backed up (4.6 MB)")

        XCTAssertEqual(m.statusLine, "Backed up (4.6 MB)")
        XCTAssertTrue(m.openEnabled, "a transient note changes the words, never the actions")
    }

    /// Before the first poll comes back there is no document at all.
    func testNoStatusYetReadsAsChecking() {
        let m = MenuPresentation.make(status: nil)

        XCTAssertEqual(m.statusLine, "Checking…")
        XCTAssertFalse(m.openEnabled)
        XCTAssertFalse(m.addressEnabled)
        XCTAssertFalse(m.backupEnabled, "nothing to back up until we know a runtime answers")
    }

    /// While a start, stop or backup is in flight, the actions that would collide with it
    /// are off — the runtime serialises them anyway, but a menu that lets you click twice
    /// is a menu that looks broken.
    func testAnOperationInFlightDisablesTheActions() throws {
        let s = try RuntimeStatus.decode(Fixtures.data(Fixtures.fullRunning))
        let m = MenuPresentation.make(status: s, busy: true)

        XCTAssertFalse(m.backupEnabled)
        XCTAssertTrue(m.openEnabled, "opening a browser cannot collide with anything")
    }
}
