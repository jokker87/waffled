import Foundation

// Weekly Planning · step 6 "Goals" — the wire types and the two endpoints.
//
// Ported from `apps/web/src/lib/api/planning/goals.ts`. The step is a READ over the goal
// lists that already exist plus ONE write: picking a group's focus, which sets that
// goal's existing `is_featured` flag. Nothing here invents a "focus" record — `settled` /
// `focusGoalId` are the SESSION's memory of what it decided (so "nothing this week" can
// be a real answer and put a ★ on the tab), while `goals[].isFeatured` stays the goals
// module's own truth.
//
// This lives in its own file rather than in `WaffledAPI.swift` on purpose: the primitives
// (`getJSON` / `sendReturning`) were widened to internal so each planning step could keep
// its endpoints next to the feature that uses them.
//
// Property names are camelCase and 1:1 with the server — `WaffledAPI.decoder` is a plain
// `JSONDecoder` with no key strategy and no date strategy, so every date is a `String`.
extension WaffledAPI {

    /// How a goal is actually GOING, in a sentence, with one of three tones. Derived
    /// server-side from real logged activity so web and iOS read the same verdict — no
    /// client is ever tempted to make a phrase up for a goal it knows nothing about.
    struct PlanningGoalPace: Decodable, Hashable, Sendable {
        let text: String
        /// "ok" | "flat" | "behind". A String, not an enum: a server newer than this build
        /// naming a fourth tone must render in the neutral one, never fail to decode.
        let tone: String
    }

    /// A goal as this step shows it: the whole goals-screen `Goal`, plus its pace.
    ///
    /// The server sends ONE flat object (`{...goal, pace}`), so `Goal` is decoded from the
    /// same container rather than from a nested key. That is what keeps `GoalDisplay`
    /// working on it unchanged — a habit reads as this period's count, a checklist as its
    /// steps, everything else as the lifetime total.
    struct PlanningGoalGoal: Decodable, Identifiable, Sendable {
        let goal: Goal
        /// Nil when there is genuinely nothing honest to say about the goal's pace.
        let pace: PlanningGoalPace?

        var id: String { goal.id }

        private enum CodingKeys: String, CodingKey { case pace }

        init(from decoder: Decoder) throws {
            goal = try Goal(from: decoder)
            let c = try decoder.container(keyedBy: CodingKeys.self)
            pace = try c.decodeIfPresent(PlanningGoalPace.self, forKey: .pace)
        }
    }

    /// A goal-list member, plus their age for the group card's sub line. Age is nil when
    /// there is no birthday on file — the sub line drops it rather than guessing one.
    struct PlanningGoalMember: Decodable, Identifiable, Hashable, Sendable {
        let personId: String
        let name: String
        let avatarEmoji: String?
        let colorHex: String?
        let age: Int?

        var id: String { personId }
    }

    /// One tab: a real `goal_lists` row with its goals and what this session settled on.
    struct PlanningGoalGroup: Decodable, Identifiable, Sendable {
        /// Named `listId` (not `id`) by the server so a tab can never be confused with a
        /// goal; `id` below is the `Identifiable` conformance, not a decoded field.
        let listId: String
        let name: String
        let emoji: String?
        let colorHex: String?
        /// A private list is only ever SERVED to its own members — the tab wears a lock,
        /// and the server 404s a write naming a list this caller cannot see.
        let isPrivate: Bool
        let sortOrder: Int
        let members: [PlanningGoalMember]
        /// The group is literally every person in the household — what lets the card say
        /// "everyone tracks it" without the client counting people.
        let isEveryone: Bool
        let goals: [PlanningGoalGoal]
        /// True once THIS session has answered for the group — the ★ on its tab. Never set
        /// by a flag the session merely found: a pre-existing pin does not star a tab.
        let settled: Bool
        /// When settled, what the session answered (nil for the real answer "nothing this
        /// week"). When not settled, the list's one already-featured goal if it has exactly
        /// one — which is how a goal pinned on the goals screen arrives already selected.
        let focusGoalId: String?

        var id: String { listId }
    }

    struct PlanningGoalsView: Decodable, Sendable {
        let groups: [PlanningGoalGroup]
    }

    // MARK: Endpoints

    /// The step's whole read. 403s when the goals module is off (the step is unavailable
    /// then too, so the shell never lands on it).
    func planningGoals(sessionId: String) async throws -> PlanningGoalsView {
        let q = sessionId.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? sessionId
        return try await getJSON("/api/weekly-planning/goals?sessionId=\(q)", as: PlanningGoalsView.self)
    }

    /// Answer one group. `goalId: nil` is the real answer "nothing this week" — it clears
    /// the list's focus and still marks the group settled.
    ///
    /// A MID-STEP WRITE. It merges onto the step row and deliberately does NOT settle the
    /// step (`status` / `decidedAt` are left alone), and it answers with the BARE view —
    /// no envelope. The caller must not also decide the step.
    func planningGoalsSetFocus(
        sessionId: String,
        listId: String,
        goalId: String?
    ) async throws -> PlanningGoalsView {
        // `null`, `""` and an omitted key are all read by the server as "nothing this
        // week", so an explicit null is the honest thing to send and needs no presence
        // gymnastics (unlike the kids step's four-state answers).
        let body: [String: JSONValue] = [
            "sessionId": .string(sessionId),
            "listId": .string(listId),
            "goalId": goalId.map(JSONValue.string) ?? .null,
        ]
        return try await sendReturning(
            "PUT", "/api/weekly-planning/goals/focus", body: body, as: PlanningGoalsView.self)
    }
}

extension WaffledAPI.PlanningGoalGroup {

    /// This group in the shape the goals module's OWN editor speaks, so "＋ New goal for
    /// this week" can hand `GoalCreateSheet` the real thing rather than a second,
    /// planning-only form that would drift from it.
    ///
    /// THE MEMBERS ARE THE POINT, not decoration: `GoalCreateSheet.submit()` derives
    /// `participantIds` from the chosen list's members, so a conversion that dropped them
    /// would create a goal with nobody on it. `goalCount` is only ever a label in that
    /// sheet, so the goals this step already has is an honest value for it.
    var asGoalList: WaffledAPI.GoalList {
        WaffledAPI.GoalList(
            id: listId,
            name: name,
            emoji: emoji,
            colorHex: colorHex,
            goalCount: goals.count,
            members: members.map {
                WaffledAPI.GoalList.Member(
                    personId: $0.personId,
                    name: $0.name,
                    avatarEmoji: $0.avatarEmoji,
                    colorHex: $0.colorHex)
            })
    }
}

/// The crumb this step hands the session record: which group settled on what.
///
/// IT MUST MIRROR THE SERVER'S OWN MAP. `/goals/focus` merges `{ focus: { <listId>:
/// <goalId>|null } }` onto the step row with `jsonb_set`, but the shell's `decideStep`
/// REPLACES `data` wholesale when the primary is pressed. A crumb that summarised instead
/// of mirroring would therefore erase, on "Looks right", the very thing every mid-step
/// write persisted — the record of which groups answered, and which answered "nothing".
///
/// This is a record of the DECISION (list ids to goal ids), not a copy of module data: the
/// `is_featured` flag itself stays the goals module's truth and the recap reads through to
/// it. Kept identical to the web's `planningGoalsDecision`.
enum PlanningGoalsCrumb {
    static func decision(_ view: WaffledAPI.PlanningGoalsView?) -> [String: JSONValue] {
        var focus: [String: JSONValue] = [:]
        // SETTLED GROUPS ONLY. An unsettled group's `focusGoalId` may be a pre-existing
        // pin the server merely adopted for display; writing it would star a tab nobody
        // has looked at, which is precisely what the ★ exists to rule out.
        for g in view?.groups ?? [] where g.settled {
            focus[g.listId] = g.focusGoalId.map(JSONValue.string) ?? .null
        }
        return ["focus": .object(focus)]
    }
}
