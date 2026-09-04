import Foundation
import Observation

/// Weekly Planning · step 6 "Goals" — the step's state, with no view in it.
///
/// Every network op is an injected closure with a `WaffledAPI()`-backed default (the test
/// seam this project uses everywhere — see `FamilyNightModel`), so `PlanningGoalsStepTests`
/// drives the whole step without a server.
///
/// THE LOADING CONTRACT (`Features/Shared/RestDomain.swift`): a FAILED fetch keeps the
/// previous value and still sets `loaded`, so the step never blanks a group of goals it
/// had, and never sits on "Loading…" forever. A failed write does not refetch and does not
/// mutate — the last good answer stays on screen rather than a half-applied one.
@MainActor
@Observable
final class PlanningGoalsStepModel {
    typealias FetchGoals = (_ sessionId: String) async throws -> WaffledAPI.PlanningGoalsView
    typealias SetFocus = (
        _ sessionId: String, _ listId: String, _ goalId: String?
    ) async throws -> WaffledAPI.PlanningGoalsView

    private(set) var view: WaffledAPI.PlanningGoalsView?
    private(set) var loaded = false
    /// The list a write is in flight for. ONE AT A TIME: a second click while the first is
    /// landing would race two read-modify-writes of the same session crumb.
    private(set) var savingListId: String?
    private(set) var errorMessage: String?
    /// Which tab is on screen. Never blindly kept: a refetch that drops the list (it was
    /// deleted, or made private) re-lands on something real.
    private(set) var tabId: String?
    /// Bumped every time a read or a write lands, so the view can push the crumb on ONE
    /// `onChange` instead of after each call site — the convention the other steps follow.
    /// A failed write never bumps it, which is what keeps a half-applied answer out of the
    /// session record.
    private(set) var rev = 0

    private let fetchGoals: FetchGoals
    private let setFocus: SetFocus

    init(
        fetchGoals: @escaping FetchGoals = { sessionId in
            try await WaffledAPI().planningGoals(sessionId: sessionId)
        },
        setFocus: @escaping SetFocus = { sessionId, listId, goalId in
            try await WaffledAPI().planningGoalsSetFocus(
                sessionId: sessionId, listId: listId, goalId: goalId)
        }
    ) {
        self.fetchGoals = fetchGoals
        self.setFocus = setFocus
    }

    var groups: [WaffledAPI.PlanningGoalGroup] { view?.groups ?? [] }

    var settledCount: Int { groups.filter(\.settled).count }

    /// The group on screen, resolved against what actually came back.
    var active: WaffledAPI.PlanningGoalGroup? {
        groups.first { $0.listId == tabId } ?? groups.first
    }

    /// Nothing may be answered while a write is in flight or the shell is busy.
    func isFrozen(shellBusy: Bool) -> Bool { shellBusy || savingListId != nil }

    /// The crumb to hand the shell after every fresh read AND every write — see
    /// `PlanningGoalsCrumb` for why it mirrors rather than summarises.
    ///
    /// NIL UNTIL A READ HAS ACTUALLY LANDED. An empty map is not "nothing settled", it is
    /// a claim — and since the shell REPLACES the step's data when the primary is pressed,
    /// handing one up after a failed fetch would erase every answer the session recorded.
    var crumb: [String: JSONValue]? {
        guard view != nil else { return nil }
        return PlanningGoalsCrumb.decision(view)
    }

    func load(sessionId: String) async {
        if let latest = try? await fetchGoals(sessionId) { apply(latest) }
        loaded = true
    }

    func selectTab(_ listId: String) {
        guard groups.contains(where: { $0.listId == listId }) else { return }
        tabId = listId
    }

    func dismissError() { errorMessage = nil }

    /// Answer one group. `goalId` nil is the real answer "nothing this week".
    ///
    /// A MID-STEP WRITE: it returns the bare view and deliberately does not settle the
    /// STEP, so the caller must not also decide the step. On failure the previous view is
    /// left exactly as it was.
    func pick(sessionId: String, listId: String, goalId: String?) async {
        guard savingListId == nil else { return }
        savingListId = listId
        errorMessage = nil
        defer { savingListId = nil }
        do {
            apply(try await setFocus(sessionId, listId, goalId))
        } catch {
            errorMessage = "That didn’t take — try again."
        }
    }

    private func apply(_ latest: WaffledAPI.PlanningGoalsView) {
        view = latest
        rev += 1
        // Land on WHAT'S LEFT the first time, and stay put after that. Re-deriving the tab
        // on every write would jump the family off the group they just answered.
        if let tabId, latest.groups.contains(where: { $0.listId == tabId }) { return }
        tabId = (latest.groups.first { !$0.settled } ?? latest.groups.first)?.listId
    }
}

/// The step's pure text, kept out of the view so it can be read and tested on its own.
enum PlanningGoalsText {

    /// The axis label under the number, matching the rule `GoalDisplay` implements: a habit
    /// is this period's count, a checklist is steps, everything else the running total.
    static func axisLabel(_ g: WaffledAPI.Goal) -> String {
        switch g.goalType {
        case "habit": return g.habitPeriod == "day" ? "today" : "this \(g.habitPeriod ?? "week")"
        case "checklist": return "steps done"
        default: return g.unit ?? "so far"
        }
    }

    static func kindLabel(_ g: WaffledAPI.Goal) -> String {
        ["count": "Count", "total": "Total", "habit": "Habit", "checklist": "Checklist"][g.goalType]
            ?? g.goalType
    }

    /// What the group card's header says the group IS. EVERY CLAUSE IS A FACT THE SERVER
    /// SENT — `isEveryone` and a member's `age` — never a guess: a member with no birthday
    /// on file simply drops the age rather than inventing one.
    static func groupSubtitle(_ g: WaffledAPI.PlanningGoalGroup) -> String {
        let n = g.members.count
        if g.isPrivate {
            if n == 2 { return "private · just the two of you" }
            if n == 1 { return "private · just you" }
            return "private · \(n) people"
        }
        if n == 1 {
            if let age = g.members.first?.age { return "individual · age \(age)" }
            return "individual"
        }
        if g.isEveryone { return "shared · everyone tracks it" }
        if n == 2 { return "shared · " + g.members.map(firstName).joined(separator: " & ") }
        return "shared · \(n) people"
    }

    /// Where the group stands, in one line. THREE STATES, because "already pinned" and "we
    /// decided" are not the same claim: a goal that arrives featured shows as the focus but
    /// still waits to be confirmed.
    static func verdict(_ g: WaffledAPI.PlanningGoalGroup) -> String {
        guard let focus = g.goals.first(where: { $0.id == g.focusGoalId }) else {
            return "No focus this week — that’s allowed"
        }
        return g.settled
            ? "★ This week · \(focus.goal.title)"
            : "Pinned already · \(focus.goal.title) — keep it, or pick another"
    }

    private static func firstName(_ m: WaffledAPI.PlanningGoalMember) -> String {
        m.name.split(separator: " ").first.map(String.init) ?? m.name
    }
}
