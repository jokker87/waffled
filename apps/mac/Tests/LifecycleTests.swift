import XCTest
@testable import Waffled

/// The two rules that decide what the app does on its own, kept as pure functions so
/// they can be asserted rather than watched.
final class LifecycleTests: XCTestCase {

    /// A stopped stack is started; an unhealthy one is NOT. The runtime supervises its
    /// own children and restarts what it can — an app that starts on `unhealthy` is the
    /// restart loop the plan forbids.
    func testAutoStartOnlyFromStopped() {
        XCTAssertTrue(Lifecycle.shouldAutoStart(.stopped))
        XCTAssertFalse(Lifecycle.shouldAutoStart(.starting))
        XCTAssertFalse(Lifecycle.shouldAutoStart(.running))
        XCTAssertFalse(Lifecycle.shouldAutoStart(.unhealthy))
    }

    /// Finding a server already running is a relaunch, not a first start: it re-opens the
    /// existing server (plan §2 step 6) without stealing the screen.
    func testBrowserOpensOnlyForAStartThisAppInitiated() {
        XCTAssertTrue(Lifecycle.shouldOpenBrowser(
            newState: .running, startWasAppInitiated: true, alreadyOpened: false))

        XCTAssertFalse(Lifecycle.shouldOpenBrowser(
            newState: .running, startWasAppInitiated: false, alreadyOpened: false),
            "already running when we launched — do not steal the screen")

        XCTAssertFalse(Lifecycle.shouldOpenBrowser(
            newState: .running, startWasAppInitiated: true, alreadyOpened: true),
            "once per process, not once per poll")

        for state in [RuntimeState.stopped, .starting, .unhealthy] {
            XCTAssertFalse(Lifecycle.shouldOpenBrowser(
                newState: state, startWasAppInitiated: true, alreadyOpened: false))
        }
    }

    /// Polling is cheap but not free (it spawns a process), so it slows down once the
    /// answer stops changing.
    func testPollingIsFasterWhileSomethingIsHappening() {
        XCTAssertEqual(Lifecycle.pollInterval(for: .starting), 1)
        XCTAssertEqual(Lifecycle.pollInterval(for: .running), 2)
        XCTAssertEqual(Lifecycle.pollInterval(for: .stopped), 2)
        XCTAssertEqual(Lifecycle.pollInterval(for: .unhealthy), 2)
        XCTAssertEqual(Lifecycle.pollInterval(for: nil), 2)
    }
}

/// Dev mode is how this app is run before anything is embedded, so its precedence is
/// worth pinning down.
final class RuntimeLocatorTests: XCTestCase {
    private let resources = URL(fileURLWithPath: "/Applications/Waffled.app/Contents/Resources")

    func testProductionLooksInsideTheAppBundle() throws {
        let l = try XCTUnwrap(RuntimeLocator.locate(environment: [:], resourceURL: resources))

        XCTAssertEqual(l.binary.path,
                       "/Applications/Waffled.app/Contents/Resources/runtime/bin/waffled-runtime")
        XCTAssertEqual(l.bundleDir?.path,
                       "/Applications/Waffled.app/Contents/Resources/runtime")
        XCTAssertNil(l.dataDir, "production uses the runtime's own default data directory")
        XCTAssertFalse(l.isDevMode)
    }

    func testDevModeOverridesAllThree() throws {
        let env = [
            "WAFFLED_RUNTIME_BIN": "/tmp/bin/waffled-runtime",
            "WAFFLED_RUNTIME_BUNDLE": "/tmp/runtime",
            "WAFFLED_DATA_DIR": "/tmp/mac-data",
        ]
        let l = try XCTUnwrap(RuntimeLocator.locate(environment: env, resourceURL: resources))

        XCTAssertEqual(l.binary.path, "/tmp/bin/waffled-runtime")
        XCTAssertEqual(l.bundleDir?.path, "/tmp/runtime")
        XCTAssertEqual(l.dataDir?.path, "/tmp/mac-data")
        XCTAssertTrue(l.isDevMode)
    }

    /// The data directory is the optional one: a dev run against the real default is a
    /// legitimate thing to want, even though this repo's agents must never do it.
    func testDevModeDataDirectoryIsOptional() throws {
        let env = [
            "WAFFLED_RUNTIME_BIN": "/tmp/bin/waffled-runtime",
            "WAFFLED_RUNTIME_BUNDLE": "/tmp/runtime",
        ]
        let l = try XCTUnwrap(RuntimeLocator.locate(environment: env, resourceURL: resources))

        XCTAssertEqual(l.binary.path, "/tmp/bin/waffled-runtime")
        XCTAssertNil(l.dataDir)
        XCTAssertTrue(l.isDevMode)
    }

    /// Nothing embedded yet and no dev envs set: there is no runtime to talk to, and the
    /// menu has to say so rather than report a stopped server.
    func testNoBundleAndNoEnvironmentLocatesNothing() {
        XCTAssertNil(RuntimeLocator.locate(environment: [:], resourceURL: nil))
    }
}
