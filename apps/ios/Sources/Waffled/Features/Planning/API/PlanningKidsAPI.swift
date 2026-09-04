import Foundation

// Weekly Planning · step 9 "Kids" — the wire types and the three endpoints.
//
// Ported from `apps/web/src/lib/api/planning/kids.ts`. The step is a read over the kids'
// OWN goals, chores and calendar, plus two answers that have no other module to land in.
// Nothing here invents an option: the focus comes out of their goals / their overdue
// chores / the standing chores they already carry, and the thing to look forward to is
// picked off their real week.
//
// NO MODULE GATE. The step reads goals AND chores, which a household toggles separately,
// so gating on either would delete the step for a family that runs the other. A module
// that is off simply contributes nothing (see `sources` on the view).

/// ONE ANSWER ON THE WIRE, AND IT HAS FOUR STATES — NOT AN OPTIONAL.
///
/// `focus` and `forward` on `/kids/answer` each mean four different things, and a
/// `String?` can only say two of them:
///
///   * **absent** — the key is not in the body at all: leave the other answer alone. The
///     two questions are answered one at a time at the board, and sending half an answer
///     must not erase the other half.
///   * **clear** — an explicit `null`: forget this answer.
///   * **key** — `{"key": "goal:…"}`: one of the options the server offered.
///   * **text** — `{"text": "…"}`: free words, trimmed and length-capped server-side.
///
/// THIS IS WHY THE BODY IS BUILT AS A DICTIONARY AND NOT AS AN `Encodable` STRUCT.
/// `JSONEncoder` omits a nil Optional (`encodeIfPresent` is what the synthesized
/// implementation uses for Optionals in practice for `encodeIfPresent`-shaped code, and a
/// hand-written one is one forgotten line away from the same thing), which collapses
/// "clear" into "absent" — the button that forgets an answer would silently do nothing.
enum PlanningKidPick: Equatable, Sendable {
    case absent
    case clear
    case key(String)
    case text(String)

    /// What this state puts in the body, or `nil` for "put nothing in the body".
    ///
    /// Assigning `nil` through `Dictionary`'s subscript REMOVES the key — which is exactly
    /// what `.absent` means — while `.clear` assigns a real `JSONValue.null`. That one
    /// distinction is the whole contract; `PlanningKidsStepTests` asserts all four.
    var wireValue: JSONValue? {
        switch self {
        case .absent: return nil
        case .clear: return .null
        case let .key(k): return .object(["key": .string(k)])
        case let .text(t): return .object(["text": .string(t)])
        }
    }
}

extension WaffledAPI {

    /// Where an option came from. `routine` is a standing chore they already carry — the
    /// one with nothing under it, because nothing is wrong with it. `custom` is free text.
    /// Strings, not enums, so a server that grows a fifth source still decodes.
    struct PlanningKidFocusOption: Decodable, Sendable {
        /// Stable across refetches and unique across sources; what a write names. A chore
        /// step 1 routed here and the same chore found overdue share one key on purpose —
        /// triage promotes the row rather than duplicating it.
        let key: String
        let source: String
        /// The referent in its own module (a goal id, a chore id); nil for free text.
        let id: String?
        let emoji: String
        let label: String
        /// The one line under the label, composed server-side. NIL IS MEANINGFUL: a
        /// standing chore has nothing late or behind about it, so it gets no line.
        let detail: String?
        /// Sent here by step 1's triage. Shown first.
        let routed: Bool
        /// The whole goal, for a goal-sourced option — so the number is read through
        /// `GoalDisplay` instead of an inline `totalProgress`, which would tell a kid
        /// they'd read 99 times this week.
        let goal: Goal?
    }

    struct PlanningKidForwardOption: Decodable, Sendable {
        let key: String
        /// The event it names; nil for free text.
        let eventId: String?
        let emoji: String
        let label: String
        /// The day, in the household's own zone ("Sat").
        let when: String
    }

    struct PlanningKidEvent: Decodable, Identifiable, Sendable {
        let id: String
        let title: String
        /// "Tue 4:00 PM", or just the weekday for an all-day event. Composed server-side,
        /// so there is no date math on this device.
        let when: String
        /// ISO-8601, and a `String` — the decoder has no date strategy.
        let startsAt: String
        let allDay: Bool
    }

    struct PlanningKidChore: Decodable, Identifiable, Sendable {
        let id: String
        let title: String
        let emoji: String?
        /// "every day" · "Sat" · "open since Wednesday".
        let when: String
        let late: Bool
    }

    /// What a card settled on — a SNAPSHOT of the label as it read when chosen. The module
    /// still owns the item; this is what lets the read-back render without re-reading four
    /// modules, and what lets free text (which names nothing) live in the same field.
    struct PlanningKidFocus: Decodable, Equatable, Sendable {
        let source: String
        let id: String?
        let emoji: String
        let label: String
        let detail: String?
    }

    struct PlanningKidForward: Decodable, Equatable, Sendable {
        let eventId: String?
        let emoji: String
        let label: String
        let when: String
    }

    struct PlanningKidCard: Decodable, Identifiable, Sendable {
        let personId: String
        let name: String
        let avatarEmoji: String?
        let colorHex: String?
        /// Nil when there is no birthday on file — the card drops the age rather than
        /// guessing.
        let age: Int?
        /// Nil when the reward economy is off (it is funded by chores, so chores off ⇒
        /// off). NEVER DRAW A ZERO IN ITS PLACE — that reads as "you've earned nothing".
        let stars: Int?
        let starsSymbol: String?
        let week: [PlanningKidEvent]
        let chores: [PlanningKidChore]
        let focusOptions: [PlanningKidFocusOption]
        let forwardOptions: [PlanningKidForwardOption]
        let focus: PlanningKidFocus?
        let forward: PlanningKidForward?
        /// Both answered. Only then does the card flip to its read-back face — half an
        /// answer is not the thing they'll remember.
        let settled: Bool

        var id: String { personId }
    }

    struct PlanningKidsSources: Decodable, Hashable, Sendable {
        let goals: Bool
        let chores: Bool
        let rewards: Bool
    }

    struct PlanningKidsView: Decodable, Sendable {
        let weekStart: String
        let kids: [PlanningKidCard]
        /// Which modules actually contributed, so an empty card can say why rather than
        /// looking broken. Never a claim to have read a module that is off.
        let sources: PlanningKidsSources
        /// A previous session left answers worth copying forward ("Same as last week").
        let canRepeat: Bool
    }

    // MARK: Endpoints

    /// The whole read: a card per child, with their week, their stars, and the two sets of
    /// options.
    ///
    /// `weekStart` is sent for the sessionless case only — WHEN A SESSION IS NAMED, ITS OWN
    /// WEEK WINS on the server. A session may plan a week further out than the default, and
    /// a client that computed its own would be answered with a different week's events.
    func planningKids(sessionId: String, weekStart: String?) async throws -> PlanningKidsView {
        var path = "/api/weekly-planning/kids?sessionId=\(Self.escape(sessionId))"
        if let weekStart, !weekStart.isEmpty { path += "&weekStart=\(Self.escape(weekStart))" }
        return try await getJSON(path, as: PlanningKidsView.self)
    }

    /// The body `/kids/answer` takes, built by hand so "absent" and "clear" stay different
    /// things. Pure and static: `PlanningKidsStepTests` asserts all four states off this
    /// function without a network.
    static func planningKidsAnswerBody(
        sessionId: String,
        personId: String,
        weekStart: String?,
        focus: PlanningKidPick,
        forward: PlanningKidPick
    ) -> [String: JSONValue] {
        var body: [String: JSONValue] = [
            "sessionId": .string(sessionId),
            "personId": .string(personId),
        ]
        if let weekStart, !weekStart.isEmpty { body["weekStart"] = .string(weekStart) }
        // Dictionary subscript semantics ARE the four-state contract: assigning nil
        // removes the key (absent), assigning `.null` writes an explicit null (clear).
        body["focus"] = focus.wireValue
        body["forward"] = forward.wireValue
        return body
    }

    /// Answer one card. Returns the BARE view — no envelope.
    ///
    /// A REAL WRITE, not `setDecisionData`: the read-back frame is the part the kids
    /// remember, so it has to survive a remount, a refresh and the iPad picking up where
    /// the phone left off.
    func planningKidsAnswer(
        sessionId: String,
        personId: String,
        weekStart: String?,
        focus: PlanningKidPick = .absent,
        forward: PlanningKidPick = .absent
    ) async throws -> PlanningKidsView {
        let body = Self.planningKidsAnswerBody(
            sessionId: sessionId, personId: personId, weekStart: weekStart,
            focus: focus, forward: forward)
        return try await sendReturning(
            "PUT", "/api/weekly-planning/kids/answer", body: body, as: PlanningKidsView.self)
    }

    /// "Same as last week" — copy the previous session's answers forward, keeping only the
    /// ones whose referent still stands. Additive: it never clears an answer this session
    /// has already given. Returns the BARE view.
    func planningKidsRepeat(sessionId: String, weekStart: String?) async throws -> PlanningKidsView {
        var body: [String: JSONValue] = ["sessionId": .string(sessionId)]
        if let weekStart, !weekStart.isEmpty { body["weekStart"] = .string(weekStart) }
        return try await sendReturning(
            "POST", "/api/weekly-planning/kids/repeat", body: body, as: PlanningKidsView.self)
    }

    private static func escape(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? s
    }
}

/// The crumb this step hands the session record: what each kid settled on.
///
/// IT MUST MIRROR THE SERVER'S OWN MAP, for the same reason the goals step's does:
/// `/kids/answer` merges `{ kids: { <personId>: { focus, forward } } }` onto the step row
/// with `jsonb_set`, but the shell's `decideStep` REPLACES `data` wholesale when the
/// primary is pressed. Summarise instead of mirroring and pressing "Done" throws away the
/// two sentences the whole step exists to produce.
///
/// The key names and types below are read back by the server's `parseAnswers`, which keeps
/// an entry only when `focus.source` and `focus.label` (and `forward.label`) are strings —
/// so nothing here may be renamed or dropped. Kept identical to the web's
/// `planningKidsDecision`.
enum PlanningKidsCrumb {
    static func decision(_ view: WaffledAPI.PlanningKidsView?) -> [String: JSONValue] {
        var kids: [String: JSONValue] = [:]
        for k in view?.kids ?? [] where k.focus != nil || k.forward != nil {
            kids[k.personId] = .object([
                "focus": k.focus.map(focusJSON) ?? .null,
                "forward": k.forward.map(forwardJSON) ?? .null,
            ])
        }
        return ["kids": .object(kids)]
    }

    private static func focusJSON(_ f: WaffledAPI.PlanningKidFocus) -> JSONValue {
        .object([
            "source": .string(f.source),
            "id": f.id.map(JSONValue.string) ?? .null,
            "emoji": .string(f.emoji),
            "label": .string(f.label),
            "detail": f.detail.map(JSONValue.string) ?? .null,
        ])
    }

    private static func forwardJSON(_ f: WaffledAPI.PlanningKidForward) -> JSONValue {
        .object([
            "eventId": f.eventId.map(JSONValue.string) ?? .null,
            "emoji": .string(f.emoji),
            "label": .string(f.label),
            "when": .string(f.when),
        ])
    }
}

/// WHICH CHIP READS AS CHOSEN. Pure, and shared by the view and its tests, because the
/// bug it prevents is invisible: "I added a custom 'something else' and then clicked an
/// existing one and BOTH looked selected."
enum PlanningKidsChoice {
    /// An offered focus option is the answer when the answer names the same thing it does.
    static func focusChosen(
        _ card: WaffledAPI.PlanningKidCard,
        _ option: WaffledAPI.PlanningKidFocusOption
    ) -> Bool {
        guard let focus = card.focus else { return false }
        return focus.source == option.source && focus.id == option.id
    }

    /// The escape hatch reads as chosen — showing THEIR WORDS, not "＋ Something else" —
    /// only when the answer actually came from it.
    static func focusIsCustom(_ card: WaffledAPI.PlanningKidCard) -> Bool {
        card.focus?.source == "custom"
    }

    /// Guarded against both-nil on purpose: a bare `card.forward?.eventId == option.eventId`
    /// reads TRUE for every option when nothing has been answered.
    static func forwardChosen(
        _ card: WaffledAPI.PlanningKidCard,
        _ option: WaffledAPI.PlanningKidForwardOption
    ) -> Bool {
        guard let forward = card.forward, let answered = forward.eventId,
              let offered = option.eventId else { return false }
        return answered == offered
    }

    /// Free text names no event, which is exactly how it is told apart from a picked one.
    static func forwardIsCustom(_ card: WaffledAPI.PlanningKidCard) -> Bool {
        guard let forward = card.forward else { return false }
        return forward.eventId == nil
    }
}
