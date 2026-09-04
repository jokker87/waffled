import Foundation

/// Weekly Planning's pure functions — the ones with no view, no network and no clock.
///
/// Ported deliberately line-for-line from `apps/web/src/lib/api/weeklyPlanning.ts`. Two
/// platforms each deciding "which step is on screen" for themselves is how a session
/// resumed on the iPad lands somewhere else than the same session on the phone.
///
/// Everything here takes strings and returns strings. `weekStart` is a household-local
/// `YYYY-MM-DD` and must NOT be round-tripped through a device `Date`: the household's
/// first-day-of-week is `nil` for an unbounded window while PowerSync is disconnected,
/// and planning runs entirely over REST, so the device genuinely may not know how this
/// family cuts a week. The server owns the boundary; we do string arithmetic on it.
enum PlanningFormat {

    /// The steps that actually run. An unavailable step keeps its place in the catalog
    /// but is never shown, never counted, and never landed on.
    static func availableSteps(_ steps: [WaffledAPI.PlanningStep]) -> [WaffledAPI.PlanningStep] {
        steps.filter(\.available)
    }

    /// "Frame the week" grouping, WITHOUT hardcoding the acts on the client — they arrive
    /// on each step. Consecutive runs only: two separated groups sharing an act name stay
    /// separate, which is what keeps the sheet in catalog order.
    static func stepsByAct(_ steps: [WaffledAPI.PlanningStep]) -> [(act: String, steps: [WaffledAPI.PlanningStep])] {
        var out: [(act: String, steps: [WaffledAPI.PlanningStep])] = []
        for s in availableSteps(steps) {
            if let last = out.last, last.act == s.act {
                out[out.count - 1].steps.append(s)
            } else {
                out.append((act: s.act, steps: [s]))
            }
        }
        return out
    }

    /// Which step is on screen, resolved against what is actually available. In order:
    /// the step explicitly asked for, then the session's own pointer (which is what lets
    /// another device resume where this one left off), then the first runnable step.
    ///
    /// A key that is not available — its module was turned off mid-week, or somebody
    /// deep-linked one — must never strand the session on a blank screen, which is why
    /// every branch falls through to `first`.
    static func resolveCurrent(
        _ view: WaffledAPI.WeeklyPlanningView?,
        asked: String? = nil
    ) -> WaffledAPI.PlanningStep? {
        guard let view else { return nil }
        let avail = availableSteps(view.steps)
        guard !avail.isEmpty else { return nil }
        return avail.first { $0.key == asked }
            ?? avail.first { $0.key == view.session?.currentStep }
            ?? avail.first
    }

    /// The next runnable step after `key`, or nil when that was the last one.
    static func nextStepAfter(_ steps: [WaffledAPI.PlanningStep], key: String) -> WaffledAPI.PlanningStep? {
        let avail = availableSteps(steps)
        guard let i = avail.firstIndex(where: { $0.key == key }), i + 1 < avail.count else { return nil }
        return avail[i + 1]
    }

    /// Step a `YYYY-MM-DD` by whole weeks.
    ///
    /// Done in UTC on purpose. A week start is a calendar label, not an instant: parsing
    /// it in the device's zone and adding 7×86400 seconds crosses a DST boundary twice a
    /// year and lands on the Saturday or the Monday.
    static func addWeeks(_ iso: String, _ n: Int) -> String {
        guard let base = Self.isoDay.date(from: iso) else { return iso }
        let moved = base.addingTimeInterval(Double(n) * 7 * 24 * 60 * 60)
        return Self.isoDay.string(from: moved)
    }

    /// 0 = Sunday … 6 = Saturday, wrapping safely for anything out of range.
    static func planningDayName(_ dow: Int) -> String {
        let names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
        return names[((dow % 7) + 7) % 7]
    }

    /// "6 Sun – 12 Sat" — the week label in the session chrome.
    static func weekLabel(_ iso: String) -> String {
        guard let start = Self.isoDay.date(from: iso) else { return iso }
        let end = start.addingTimeInterval(6 * 24 * 60 * 60)
        return "\(Self.dayNum.string(from: start)) \(Self.dow.string(from: start))"
            + " – \(Self.dayNum.string(from: end)) \(Self.dow.string(from: end))"
    }

    /// How far through the session we are, 0…1 — the 2px progress hair, and the only
    /// progress indicator the design keeps.
    static func fraction(_ steps: [WaffledAPI.PlanningStep]) -> Double {
        let avail = availableSteps(steps)
        guard !avail.isEmpty else { return 0 }
        return Double(avail.filter(\.isSettled).count) / Double(avail.count)
    }

    // Formatters are `static let` per the project's performance rule — these are read
    // per row in the agenda sheet and per render in the chrome.
    //
    // UTC + POSIX on the ISO one: a week start is a label, and a device in a negative
    // offset parsing "2026-09-06" in local time gets the 5th back out.
    private static let isoDay: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()
    private static let dayNum: DateFormatter = {
        let f = DateFormatter()
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "d"
        return f
    }()
    private static let dow: DateFormatter = {
        let f = DateFormatter()
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "EEE"
        return f
    }()
}
