import Foundation
import SwiftUI
import UIKit
import Testing
@testable import Waffled

// Dark mode: the WF token table must resolve to the source-of-truth hex under BOTH
// appearances (values mirror apps/web/src/styles/waffled.css :root + [data-theme=dark]),
// brand hues stay fixed with the lights off, elevation inverts, and the theme preference
// persists + maps to a SwiftUI ColorScheme. See apps/ios/DARK_MODE.md.
@Suite struct ThemeTests {

    /// Resolve a dynamic SwiftUI Color to 8-bit RGB under a specific interface style.
    private func rgb(_ color: Color, _ style: UIUserInterfaceStyle) -> (r: Int, g: Int, b: Int) {
        let ui = UIColor(color).resolvedColor(with: UITraitCollection(userInterfaceStyle: style))
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        ui.getRed(&r, green: &g, blue: &b, alpha: &a)
        return (Int((r * 255).rounded()), Int((g * 255).rounded()), Int((b * 255).rounded()))
    }

    private func alpha(_ color: Color, _ style: UIUserInterfaceStyle) -> CGFloat {
        UIColor(color).resolvedColor(with: UITraitCollection(userInterfaceStyle: style)).cgColor.alpha
    }

    // MARK: dynamic init

    @Test func dynamicColorResolvesPerAppearance() {
        let c = Color(light: 0xFAF7F2, dark: 0x14110C)
        #expect(rgb(c, .light) == (0xFA, 0xF7, 0xF2))
        #expect(rgb(c, .dark) == (0x14, 0x11, 0x0C))
    }

    // MARK: surfaces + ink mirror the source of truth

    @Test func surfaceTokensMatchSourceOfTruth() {
        #expect(rgb(WF.canvas, .light) == (0xFA, 0xF7, 0xF2))
        #expect(rgb(WF.canvas, .dark) == (0x14, 0x11, 0x0C))
        #expect(rgb(WF.card, .light) == (0xFF, 0xFF, 0xFF))
        #expect(rgb(WF.card, .dark) == (0x23, 0x20, 0x19))
        #expect(rgb(WF.ink, .light) == (0x1D, 0x1D, 0x1F))
        #expect(rgb(WF.ink, .dark) == (0xF3, 0xEE, 0xE4))
    }

    @Test func elevationInvertsCardIsLighterThanCanvasInDark() {
        // A raised surface catches light: in dark, card must be lighter than canvas.
        let card = rgb(WF.card, .dark), canvas = rgb(WF.canvas, .dark)
        #expect(card.r > canvas.r && card.g > canvas.g && card.b > canvas.b)
        // In light it's the reverse — canvas is warm-white, card is pure white above it.
        #expect(rgb(WF.card, .light).r >= rgb(WF.canvas, .light).r)
    }

    // MARK: status tokens (new on iOS) flip

    @Test func statusTokensExistAndFlip() {
        #expect(rgb(WF.success, .light) == (0x25, 0xA3, 0x68))
        #expect(rgb(WF.success, .dark) == (0x34, 0xB8, 0x7A))
        #expect(rgb(WF.danger, .light) == (0xC0, 0x39, 0x2B))
        #expect(rgb(WF.danger, .dark) == (0xE1, 0x5B, 0x4C))
        #expect(rgb(WF.warn, .light) == (0xC7, 0x7A, 0x1A))
        #expect(rgb(WF.info, .dark) == (0x4C, 0x9B, 0xFF))
    }

    // MARK: brand fixedness — the lights-off invariant

    @Test func brandHuesAreFixedAcrossThemes() {
        #expect(rgb(WF.primary, .light) == rgb(WF.primary, .dark))
        #expect(rgb(WF.gold, .light) == rgb(WF.gold, .dark))
    }

    @Test func aiAccentIsLighterInLightRicherInDark() {
        // waffled.css late swap: --ai is #8C74E8 (light) / #6E56CF (dark). An old table
        // reproduced the "AI purple backwards" bug — lock the corrected direction.
        #expect(rgb(WF.ai, .light) == (0x8C, 0x74, 0xE8))
        #expect(rgb(WF.ai, .dark) == (0x6E, 0x56, 0xCF))
    }

    // MARK: per-person slots (renamed from kevin/kelly/... for web parity)

    @Test func personSlotsSolidHuesAreFixed() {
        for slot in FamilyColor.allCases {
            #expect(rgb(slot.solid, .light) == rgb(slot.solid, .dark))
        }
    }

    @Test func personTintBecomesWashInDark() {
        // Light: a pale solid (alpha ~1). Dark: the base hue at ~18–22% alpha.
        #expect(alpha(FamilyColor.person1.tint, .light) > 0.9)
        #expect(alpha(FamilyColor.person1.tint, .dark) < 0.5)
    }

    // MARK: bottom-bar clearance

    // Two different jobs, one source. A SCROLLING screen wants the bar's height plus
    // breathing room so its last row doesn't hug the bar; a FIXED footer wants to sit
    // exactly on top of the bar with no dead space under it. Before these were derived,
    // the planning session's fixed footer used the scroll figure and left ~46pt of blank
    // canvas above the tab bar — half of "the bottom action bar takes up too much room".

    @Test func theBarsHeightIsWhatTheBarActuallyDraws() {
        // Not a guess: `WaffledTabBar` frames the capture button at `captureButtonSize`
        // and pads itself by `barTopPadding`, so this is the same arithmetic the bar does.
        // The FAB's `-18` offset is cosmetic and does NOT participate in layout, which is
        // why the tallest CHILD sets the height.
        #expect(WF.tabBarHeight == WF.captureButtonSize + WF.barTopPadding)
        #expect(WF.tabBarHeight == 64)
    }

    @Test func theScrollClearanceIsStillExactlyOneHundredAndTen() {
        // Every scrolling screen in the app is tuned against this number — deriving it
        // must not move it. This is the regression guard on the refactor, not a new rule.
        #expect(WF.tabBarClearance == 110)
        #expect(WF.tabBarClearance == WF.tabBarHeight + WF.scrollBreathingRoom)
    }

    @Test func aFixedFooterClearsTheBarWithoutTheBreathingRoom() {
        // The whole point: strictly less than the scroll clearance, but still at least
        // the bar's height — anything less puts the footer's controls UNDER the bar,
        // which is how the pantry Edit button became untappable.
        #expect(WF.fixedBarClearance < WF.tabBarClearance)
        #expect(WF.fixedBarClearance >= WF.tabBarHeight || WF.fixedBarClearance == 0)
    }

    // MARK: ThemeStore

    private func freshDefaults(_ name: String) -> UserDefaults {
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        return d
    }

    @Test func themeStoreDefaultsToSystem() {
        let store = ThemeStore(defaults: freshDefaults("test.theme.default"))
        #expect(store.pref == .system)
        #expect(store.colorScheme == nil)  // nil lets iOS follow the device
    }

    @Test func themeStorePersistsAndMapsColorScheme() {
        let defaults = freshDefaults("test.theme.persist")
        let store = ThemeStore(defaults: defaults)

        store.pref = .dark
        #expect(store.colorScheme == .dark)
        #expect(defaults.string(forKey: "waffled.theme") == "dark")

        store.pref = .light
        #expect(store.colorScheme == .light)
        #expect(defaults.string(forKey: "waffled.theme") == "light")

        // A fresh store reads the persisted value back — mirrors the web localStorage key.
        #expect(ThemeStore(defaults: defaults).pref == .light)
    }
}
