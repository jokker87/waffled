import Foundation
import Testing
@testable import Waffled

// The Family hub's deep-link mapping — the string names `WAFFLED_OPEN_HUB` accepts.
//
// This exists because of a real miss: Weekly Planning had a `HubRoute` case and a
// `HubDestination` arm, so the app COMPILED and the route was reachable in principle,
// but nothing in `FamilyView` navigated to it — no tile in the grid and no name in this
// mapping. A green build proves a destination exists; it cannot prove anything leads
// there. So the mapping gets a test, and the tile gets a screenshot.
@Suite struct FamilyHubRouteTests {

    @Test func planningIsReachableByName() {
        // The name the tile and `WAFFLED_OPEN_HUB=planning` both resolve through.
        #expect(FamilyView.route(for: "planning") == .weeklyPlanning)
    }

    @Test func theEstablishedNamesStillResolve() {
        #expect(FamilyView.route(for: "chores") == .chores)
        #expect(FamilyView.route(for: "goals") == .goals)
        #expect(FamilyView.route(for: "settings") == .settings)
        // "display" deliberately maps to a SETTINGS sub-route, not a top-level page.
        #expect(FamilyView.route(for: "display") == .settingsDisplay)
    }

    @Test func anUnknownNameIsNilRatherThanADefault() {
        // A typo in the env var must leave you where you were, not silently open Today's
        // nearest neighbour — a wrong screen reads as a bug in the screen.
        #expect(FamilyView.route(for: "planing") == nil)
        #expect(FamilyView.route(for: "") == nil)
    }

    // The config panel is reachable by name too, so the switches on it can be verified
    // headlessly. It is NOT the session: `planning` starts/resumes one, this one only
    // configures it.
    @Test func theSettingsPanelHasItsOwnName() {
        #expect(FamilyView.route(for: "settingsPlanning") == .settingsWeeklyPlanning)
        #expect(FamilyView.route(for: "planning") == .weeklyPlanning)
    }
}
