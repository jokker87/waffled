import Foundation

/// THE ONE PLACE A GOAL'S PROGRESS IS DECIDED, and the reason it exists.
///
/// `Goal.totalProgress` is the LIFETIME total. For two of the three goal types that is
/// the wrong number to put in front of somebody:
///
///   * a **habit** asks "how many this period?" — it RESETS, so a lifetime count of 340
///     reads as done when this week's answer is 2 of 5;
///   * a **checklist** asks "how many steps?" — its progress is `stepDone / stepTotal`,
///     which has nothing to do with an amount;
///   * everything else is genuinely a lifetime number.
///
/// The web has had `goalDisplayProgress` / `goalDisplayTarget` for exactly this since the
/// goal-axis work; iOS never got them, and never decoded `periodDone` / `stepDone` /
/// `stepTotal` at all — so every iOS surface has been showing habits their lifetime
/// count. This is the port, kept deliberately identical to
/// `apps/web/src/lib/api/goals.ts` so the two platforms cannot drift.
///
/// A VIEW MUST NOT READ `totalProgress` DIRECTLY. That is the whole point of the helper:
/// the axis is a property of the goal's type, not of the screen showing it.
enum GoalDisplay {

    /// The number to show, on the axis this goal is actually measured on.
    static func progress(_ g: WaffledAPI.Goal) -> Double {
        switch g.goalType {
        // A habit resets each period, so the period's own count is the answer. `?? 0`
        // rather than falling back to `totalProgress`: an older response that omits the
        // field has no period figure, and showing the lifetime total in its place is the
        // exact bug this helper exists to prevent.
        case "habit": return g.periodDone ?? 0
        case "checklist": return g.stepDone ?? 0
        default: return g.totalProgress
        }
    }

    /// What that number is measured against, or nil when the goal has no target.
    static func target(_ g: WaffledAPI.Goal) -> Double? {
        switch g.goalType {
        case "habit": return g.habitTargetPerPeriod.map(Double.init) ?? g.target
        // `stepTotal` of 0 is an EMPTY checklist, not a target of zero — nil so callers
        // render "no target" instead of dividing by it.
        case "checklist": return (g.stepTotal ?? 0) > 0 ? g.stepTotal : nil
        default:
            // An each_tracks / per_person goal's ring target is the per-person number
            // times the household size (read 12 EACH → 48 for four), so it grows as
            // people join.
            if g.targetBasis == "per_person", let t = g.target {
                return t * Double(max(1, g.participants.count))
            }
            return g.target
        }
    }

    /// 0…1 completion, clamped. Zero when there is no positive target to measure against.
    static func fraction(_ g: WaffledAPI.Goal) -> Double {
        guard let t = target(g), t > 0 else { return 0 }
        return min(progress(g) / t, 1)
    }

    /// The one place a goal amount is formatted: at most two decimals, trailing zeros
    /// dropped, thousands grouped.
    ///
    /// Amounts are stored EXACT — an hours-and-minutes log is 1h5m = 1.0833… hours — so a
    /// raw interpolation prints a repeating decimal. Every amount the UI shows goes
    /// through here, which is also why it lives beside the axis helpers rather than in a
    /// view.
    static func number(_ n: Double?) -> String {
        guard let n else { return "—" }
        return Self.formatter.string(from: NSNumber(value: n)) ?? "—"
    }

    /// `static let`, per the project's rule about formatters in a render path: building an
    /// NSNumberFormatter per row is measurably slow in a scrolling list.
    private static let formatter: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.maximumFractionDigits = 2
        f.usesGroupingSeparator = true
        return f
    }()
}
