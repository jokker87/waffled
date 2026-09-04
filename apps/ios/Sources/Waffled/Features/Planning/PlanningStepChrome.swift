import SwiftUI

// Chrome shared by the planning steps' pickers.
//
// `wfChip(selected:tint:)` in `DesignSystem/FieldStyles.swift` is the canonical selectable
// treatment and is used verbatim wherever a chip is a chip (the goal-group tabs, the kids'
// look-forward-to chips). It clips to a `Capsule`, though, and a focus option here is a
// three-line row — a title, a pace line and a progress bar — which a capsule crops.
//
// So this is the SAME treatment on a rounded rectangle, in one place rather than re-spelled
// in both steps: tinted fill + colored border when selected, card fill + hairline when not.

extension View {
    /// Selectable-ROW treatment: `wfChip`'s look, squared off for multi-line options.
    func planningOptionChrome(
        selected: Bool,
        tint: Color = WF.primary,
        radius: CGFloat = WF.rMD
    ) -> some View {
        background(selected ? tint.opacity(0.12) : WF.card)
            .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(selected ? tint : WF.hair, lineWidth: selected ? 1.5 : 1)
            )
    }
}

/// The tone of a goal's pace sentence, in WF tokens.
///
/// Three tones, three meanings — and `flat` is deliberately NOT a warning colour: "roughly
/// 1 book a month" is a fact about a slow goal, not a complaint about it.
///
/// The classification is split out from the colour so it can be asserted without comparing
/// two `Color`s: the tone arrives as a STRING (a server newer than this build may name a
/// fourth one), and what matters is that anything unrecognised reads neutral rather than
/// alarming.
enum PlanningPaceTone {
    enum Kind: Hashable {
        case ok
        case behind
        case neutral
    }

    static func kind(_ tone: String) -> Kind {
        switch tone {
        case "ok": return .ok
        case "behind": return .behind
        default: return .neutral
        }
    }

    static func color(_ tone: String) -> Color {
        switch kind(tone) {
        case .ok: return WF.success
        case .behind: return WF.warn
        case .neutral: return WF.ink3
        }
    }
}
