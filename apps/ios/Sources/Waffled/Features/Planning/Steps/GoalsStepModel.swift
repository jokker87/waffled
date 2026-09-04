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
    /// `POST /api/goals` — the goals module's own create, unchanged. This step does not
    /// have (and must not grow) a planning-only goal endpoint.
    typealias CreateGoal = (_ body: [String: JSONValue]) async throws -> Void

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
    /// The group the "＋ New goal for this week" composer is open for, or nil.
    ///
    /// THE LIST ID, NOT THE GROUP: a refetch replaces every group object, and holding one
    /// would leave the composer pointing at a stale copy of the tab it was opened from.
    private(set) var newForListId: String?
    /// A create is in flight. Separate from `savingListId` because it is not an answer to
    /// a group — it must freeze the options (the list is about to change under them)
    /// without reading as "this group is being settled".
    private(set) var creating = false

    private let fetchGoals: FetchGoals
    private let setFocus: SetFocus
    private let createGoal: CreateGoal

    init(
        fetchGoals: @escaping FetchGoals = { sessionId in
            try await WaffledAPI().planningGoals(sessionId: sessionId)
        },
        setFocus: @escaping SetFocus = { sessionId, listId, goalId in
            try await WaffledAPI().planningGoalsSetFocus(
                sessionId: sessionId, listId: listId, goalId: goalId)
        },
        createGoal: @escaping CreateGoal = { body in
            try await WaffledAPI().createGoal(body)
        }
    ) {
        self.fetchGoals = fetchGoals
        self.setFocus = setFocus
        self.createGoal = createGoal
    }

    var groups: [WaffledAPI.PlanningGoalGroup] { view?.groups ?? [] }

    var settledCount: Int { groups.filter(\.settled).count }

    /// The group on screen, resolved against what actually came back.
    var active: WaffledAPI.PlanningGoalGroup? {
        groups.first { $0.listId == tabId } ?? groups.first
    }

    /// The group the composer is open for, resolved against what actually came back.
    var newGoalGroup: WaffledAPI.PlanningGoalGroup? {
        guard let newForListId else { return nil }
        return groups.first { $0.listId == newForListId }
    }

    /// Nothing may be answered while a write is in flight or the shell is busy.
    func isFrozen(shellBusy: Bool) -> Bool {
        shellBusy || savingListId != nil || creating
    }

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

    // MARK: - "＋ New goal for this week"

    /// Open the goals module's own editor for the group ON SCREEN.
    ///
    /// THE WHOLE REASON THIS TAKES NO ARGUMENT. The step's question is per-group, so a
    /// composer that let the group be chosen (or defaulted to one) would create a goal in
    /// a list the family was not looking at — and since only one group is ever on screen,
    /// the goal would appear to vanish. It refuses to open at all when there is no group,
    /// rather than opening group-less.
    func openNewGoal() {
        guard !creating, let listId = active?.listId else { return }
        errorMessage = nil
        newForListId = listId
    }

    func closeNewGoal() { newForListId = nil }

    /// Take the editor's body and make the goal, then re-read so it is ON SCREEN in the
    /// group it joined and can be picked as the week's focus.
    ///
    /// CREATING IS NOT CONFIRMING. This deliberately does not call `/goals/focus`: making
    /// a goal is not the family settling the group, so the tab stays unstarred until they
    /// say so. The goal arrives PINNED (the editor is opened with `startFeatured`), which
    /// is how the server adopts it as the group's current focus on the way back —
    /// `getGoalsStepView` adopts a list's LONE `is_featured` goal — so the family lands
    /// back here with it already selected, waiting to be confirmed. In a group that
    /// already had a pin there are then two, which is ambiguous and the server adopts
    /// neither; the goal is still there in the list and one tap from being the focus.
    /// `listId` IS PASSED IN RATHER THAN READ OFF `newForListId`, and that is not
    /// belt-and-braces: `GoalCreateSheet` dismisses itself the instant it submits, which
    /// flips the sheet binding and clears the flag — possibly BEFORE this task even
    /// starts. Reading the flag here dropped the create on the floor. The caller captures
    /// the group it built the editor for and hands it over.
    /// Answers whether a goal was really made, so the caller only asks the shell to
    /// re-read when there is something new to read: a `refresh()` on the failure path
    /// would flip the shell busy and grey out every option on top of the error banner,
    /// over a goal that was never saved.
    @discardableResult
    func submitNewGoal(
        sessionId: String, listId: String, body: [String: JSONValue]
    ) async -> Bool {
        // A group this step has never heard of is not a target — refusing beats creating
        // a goal somewhere the family cannot see it.
        guard !creating, groups.contains(where: { $0.listId == listId }) else { return false }
        creating = true
        errorMessage = nil
        // The editor is already gone, so the flag goes with it — success or failure.
        // Leaving it set would reopen a sheet nobody asked for.
        newForListId = nil
        defer { creating = false }
        do {
            try await createGoal(Self.newGoalBody(body, listId: listId))
        } catch {
            errorMessage = "That goal didn’t save — try again."
            return false
        }
        // A failed refetch keeps the last good groups and does NOT bump `rev`, so no
        // crumb is pushed off a read that never landed. The goal itself is saved either
        // way; the worse failure would be blanking the step over it.
        if let latest = try? await fetchGoals(sessionId) {
            apply(latest)
            // Land back on the group the goal joined even if `tabId` was still nil
            // (`active` falls back to the first group).
            if latest.groups.contains(where: { $0.listId == listId }) { tabId = listId }
        }
        return true
    }

    /// The ONE thing the step decides about a goal made from here, whatever the editor
    /// says: which group it joins.
    ///
    /// `goalListId` is overwritten rather than trusted because the STEP, not the form, is
    /// what asked "whose focus this week?" — and a goal that silently landed in another
    /// group is the exact bug this button was held back over. Everything else, the tier
    /// included, is the family's answer in the editor and is passed through untouched.
    static func newGoalBody(
        _ body: [String: JSONValue], listId: String
    ) -> [String: JSONValue] {
        var out = body
        out["goalListId"] = .string(listId)
        return out
    }

    /// Whose goals this viewer may actually add to — the GOALS MODULE's own rule:
    /// `goal.manage` holders for any group, everybody else only a group that is just
    /// them. Offering the editor for a group the server would refuse is show-then-403, so
    /// the button says why instead.
    nonisolated static func canTarget(
        _ g: WaffledAPI.PlanningGoalGroup,
        canManageGoals: Bool,
        personId: String?
    ) -> Bool {
        if canManageGoals { return true }
        guard let personId, g.members.count == 1 else { return false }
        return g.members[0].personId == personId
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
