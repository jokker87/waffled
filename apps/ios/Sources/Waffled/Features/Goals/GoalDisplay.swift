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

    // MARK: - The axis, over primitives
    //
    // Factored this way because there are TWO goal DTOs that both need it — the list
    // `Goal` and the `GoalDetail` behind a goal's own screen — and the one thing worse
    // than a view reading `totalProgress` directly is two copies of the axis rule that
    // can disagree with each other.

    private static func axisProgress(
        goalType: String, total: Double, periodDone: Double?, stepDone: Double?
    ) -> Double {
        switch goalType {
        // A habit resets each period, so the period's own count is the answer. `?? 0`
        // rather than falling back to `total`: a response that omits the field has no
        // period figure, and showing the lifetime total in its place is the exact bug
        // this helper exists to prevent.
        case "habit": return periodDone ?? 0
        case "checklist": return stepDone ?? 0
        default: return total
        }
    }

    private static func axisTarget(
        goalType: String, target: Double?, habitTargetPerPeriod: Int?,
        stepTotal: Double?, targetBasis: String?, participantCount: Int
    ) -> Double? {
        switch goalType {
        case "habit": return habitTargetPerPeriod.map(Double.init) ?? target
        // `stepTotal` of 0 is an EMPTY checklist, not a target of zero — nil so callers
        // render "no target" instead of dividing by it.
        case "checklist": return (stepTotal ?? 0) > 0 ? stepTotal : nil
        default:
            // An each_tracks / per_person goal's ring target is the per-person number
            // times the household size (read 12 EACH → 48 for four), so it grows as
            // people join.
            if targetBasis == "per_person", let t = target {
                return t * Double(max(1, participantCount))
            }
            return target
        }
    }

    // MARK: - Goal

    /// The number to show, on the axis this goal is actually measured on.
    static func progress(_ g: WaffledAPI.Goal) -> Double {
        axisProgress(goalType: g.goalType, total: g.totalProgress,
                     periodDone: g.periodDone, stepDone: g.stepDone)
    }

    /// What that number is measured against, or nil when the goal has no target.
    static func target(_ g: WaffledAPI.Goal) -> Double? {
        axisTarget(goalType: g.goalType, target: g.target,
                   habitTargetPerPeriod: g.habitTargetPerPeriod, stepTotal: g.stepTotal,
                   targetBasis: g.targetBasis, participantCount: g.participants.count)
    }

    /// 0…1 completion, clamped. Zero when there is no positive target to measure against.
    static func fraction(_ g: WaffledAPI.Goal) -> Double {
        guard let t = target(g), t > 0 else { return 0 }
        return min(progress(g) / t, 1)
    }

    // MARK: - GoalDetail
    //
    // The same rule for the detail read, so a goal's own screen cannot show a different
    // number from the row that opened it.

    static func progress(_ d: WaffledAPI.GoalDetail) -> Double {
        axisProgress(goalType: d.goalType, total: d.totalProgress,
                     periodDone: d.periodDone, stepDone: d.stepDone)
    }

    static func target(_ d: WaffledAPI.GoalDetail) -> Double? {
        axisTarget(goalType: d.goalType, target: d.target,
                   habitTargetPerPeriod: d.habitTargetPerPeriod, stepTotal: d.stepTotal,
                   targetBasis: d.targetBasis, participantCount: d.participants.count)
    }

    static func fraction(_ d: WaffledAPI.GoalDetail) -> Double {
        guard let t = target(d), t > 0 else { return 0 }
        return min(progress(d) / t, 1)
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
