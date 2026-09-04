import Foundation

// Weekly Planning · step 4 (Family night) — this step's wire types, its ONE read, and
// the bodies it posts to the familyNight module.
//
// Ported from `apps/web/src/lib/api/planning/familyNight.ts`. Same shape as the web
// client: one GET of its own, and every WRITE through the familyNight module's existing
// POST /api/family-night/occurrence — the same endpoint the Today card's picker calls. A
// second write path here would be a second place for "who's on the treat" to be true,
// and the two would eventually disagree in front of the family.
//
// ⚠ PRESENCE IS THE MESSAGE. The server reads whether a KEY WAS SENT, not its value
// (see `upsertOccurrence` in apps/api/src/modules/familyNight/familyNight.ts — two
// independent columns, each with its own "was it sent?" flag):
//
//   · a detail-only write must carry NO `personId` key at all. `personId: null` is a
//     real "nobody yet", so including it turns "I named the treat" into "…and nobody
//     has it", un-assigning whoever had it.
//   · `theme: ""` CLEARS the theme; `theme` absent means "leave whatever is there".
//     Same rule for a part's detail.
//   · there is deliberately no un-pin — the module's upsert can write an assignment but
//     never delete one, so `personId: null` writes "nobody yet" rather than handing the
//     part back to the rotation.
//
// WHICH IS WHY THESE BODIES ARE `[String: JSONValue]` DICTIONARIES AND NOT `Encodable`
// STRUCTS. `JSONEncoder` omits a nil `String?` unless you hand-roll `encodeIfPresent`
// logic, so a synthesized struct can express "leave it alone" but never "clear this" —
// and it silently sends the wrong one. `PlanningFamilyNightBody` below is pure and
// covered by `PlanningFamilyNightStepTests`, so a later tidy-up that adds
// `personId: null` to the detail body fails a test instead of a family's evening.
//
// The existing `WaffledAPI.saveFamilyNightOccurrence` is NOT reused: its `assignments`
// parameter is `[(partId, personId)]`, so it always emits a `personId` key, and it can
// express neither `eventId` nor `createEvent`. Rather than split six writes across two
// paths to the same endpoint, all six go through `saveFamilyNightOccurrence(body:)`
// here. The Today card's function is left exactly as it is.

extension WaffledAPI {

    // MARK: - Wire types
    //
    // camelCase 1:1 with the server (`WaffledAPI.decoder` is a plain `JSONDecoder`), and
    // every date/time is a `String` — `weekStart` and `date` are household-local
    // `YYYY-MM-DD` labels that must never round-trip through a device `Date`.

    struct PlanningFamilyNightMember: Decodable, Identifiable, Hashable, Sendable {
        let id: String
        let name: String
        let avatarEmoji: String?
        /// A real `persons.color_hex` — data, not a theme token, so it is read with
        /// `Color(hexString:)` at the call site.
        let colorHex: String?
    }

    struct PlanningFamilyNightPart: Decodable, Identifiable, Hashable, Sendable {
        let partId: String
        let label: String
        let emoji: String
        /// False ⇒ the rotation never auto-fills this part (a fixed host, say). It still
        /// takes a pin: "nobody suggested" is not "nobody allowed".
        let rotates: Bool
        /// What this part IS this week ("the good ice cream") — a different question from
        /// whose turn it is. Writing one does NOT pin the person.
        let detail: String?
        let personId: String?
        let personName: String?
        /// True ⇒ somebody chose this, for this week, and it is written on the
        /// occurrence. False ⇒ it is the rotation's suggestion and nothing is written
        /// down yet. Telling those two apart is the screen's entire job.
        let pinned: Bool

        var id: String { partId }
    }

    struct PlanningFamilyNightBoard: Decodable, Sendable {
        /// The week the server resolved — echoed, never recomputed on the device.
        let weekStart: String
        /// The gathering's date inside that week (`YYYY-MM-DD`).
        let date: String
        let dayOfWeek: Int
        /// "HH:MM", household-local.
        let time: String
        /// Null until somebody touches the week: the board is a pure read, so opening the
        /// step and moving on writes nothing.
        let occurrenceId: String?
        let theme: String?
        /// "planned" | "done" | "skipped".
        let status: String
        /// There is a STANDING recurring event behind this (settings.familyNight.eventId),
        /// set once in Settings. Only then may the step promise that calling one week off
        /// leaves it alone.
        let onCalendar: Bool
        /// THIS week's own event, if the gathering has adopted one — separate from
        /// `onCalendar`'s standing series. A household can have the series and no answer
        /// for this week, or "it's the movie night already on Friday" and no series.
        let eventId: String?
        let eventTitle: String?
        /// Composed household-local server-side ("Friday 7:00 PM") so web and iOS say it
        /// the same way.
        let eventWhen: String?
        let members: [PlanningFamilyNightMember]
        let parts: [PlanningFamilyNightPart]

        var isSkipped: Bool { status == "skipped" }
    }

    /// One event on the week, for "Link an event". A trimmed read of the calendar's own
    /// range endpoint — the picker needs a title and an id, not the whole event.
    struct PlanningWeekEvent: Decodable, Identifiable, Sendable {
        let id: String
        let title: String
        /// "meal_plan" / "meal_prep" mirrors are filtered out: nobody would call a
        /// dinner family night, and offering one would put a meal where an evening goes.
        let origin: String?
    }

    // MARK: - The read

    /// The gathering inside the week being planned, its theme and status, and each
    /// part's suggested-or-pinned person. `weekStart` is the one the shell handed us —
    /// passed back, never computed here.
    func planningFamilyNightBoard(weekStart: String) async throws -> PlanningFamilyNightBoard {
        try await getJSON("/api/weekly-planning/familyNight?weekStart=\(weekStart)",
                          as: PlanningFamilyNightBoard.self)
    }

    /// The week's events, to point one at. `from`/`to` are whole days stepped off the
    /// boundary the SERVER gave us — never a week computed on the device.
    func planningWeekEvents(from: String, to: String) async throws -> [PlanningWeekEvent] {
        struct Resp: Decodable { let events: [PlanningWeekEvent] }
        return try await getJSON("/api/events?from=\(from)&to=\(to)", as: Resp.self).events
    }

    // MARK: - The write

    /// POST the familyNight module's occurrence endpoint with a body built by
    /// `PlanningFamilyNightBody`. Returns the occurrence id.
    ///
    /// Takes the body whole rather than named parameters on purpose: the caller is the
    /// only place that knows which keys it means to send, and a signature with optionals
    /// would collapse "absent" and "null" back together.
    @discardableResult
    func saveFamilyNightOccurrence(body: [String: JSONValue]) async throws -> String {
        struct Resp: Decodable { let id: String }
        return try await sendReturning("POST", "/api/family-night/occurrence",
                                       body: body, as: Resp.self).id
    }
}

/// The six bodies this step posts, and nothing else — pure, so the presence rules above
/// are covered by tests instead of by hope.
enum PlanningFamilyNightBody {

    /// Tap a face. Pinned for THIS WEEK only (the body is scoped to a date), which also
    /// materializes the occurrence — and the occurrence count is what the module's
    /// rotation counts, so pinning is what shifts next week's turn.
    ///
    /// `personId: nil` writes a real "nobody yet" assignment rather than handing the
    /// part back to the rotation. There is no un-pin.
    static func pin(date: String, partId: String, personId: String?) -> [String: JSONValue] {
        [
            "date": .string(date),
            "assignments": .array([
                .object([
                    "partId": .string(partId),
                    // ALWAYS present — that presence is the whole message: "somebody
                    // decided who". `.null` is "nobody yet", which is still a decision.
                    "personId": personId.map(JSONValue.string) ?? .null,
                ]),
            ]),
        ]
    }

    /// What a part IS this week.
    ///
    /// ⚠ NO `personId` KEY. The server reads presence, so adding one — even
    /// `personId: null`, even "for symmetry" — would turn "I named the treat" into
    /// "…and nobody has it". `PlanningFamilyNightStepTests.detailWriteCarriesNoPersonKey`
    /// asserts the exact key set for that reason: if you are here to tidy this, that test
    /// is the argument.
    static func setDetail(date: String, partId: String, detail: String) -> [String: JSONValue] {
        [
            "date": .string(date),
            "assignments": .array([
                .object([
                    "partId": .string(partId),
                    // '' clears; the key being ABSENT would mean "leave it alone".
                    "detail": .string(detail),
                ]),
            ]),
        ]
    }

    /// The night's theme. '' clears it; omitting the key means "leave whatever is there",
    /// which is how a cleared box quietly keeps its old text.
    static func setTheme(date: String, theme: String) -> [String: JSONValue] {
        ["date": .string(date), "theme": .string(theme)]
    }

    /// Call the week off, or put it back on. One body both ways — a skip has to be
    /// undoable, and "planned" is the module's own word for a night that is still on.
    static func setStatus(date: String, status: String) -> [String: JSONValue] {
        ["date": .string(date), "status": .string(status)]
    }

    /// Point this week's gathering at an event that already exists, or `nil` to unlink —
    /// which leaves the event on the calendar. Unlinking is not deleting: "this isn't
    /// family night after all" must never delete Friday.
    static func linkEvent(date: String, eventId: String?) -> [String: JSONValue] {
        ["date": .string(date), "eventId": eventId.map(JSONValue.string) ?? .null]
    }

    /// "Add this week to the calendar": ONE call that creates the event for the
    /// gathering's date and links it, SERVER-SIDE. Deliberately not a create-then-adopt
    /// round trip — a client-made event may not exist server-side yet (the app writes
    /// events locally first and PowerSync uploads afterwards), so the link would 404 on
    /// an unreproducible race. Returns the existing link untouched when the week already
    /// has one, so a double tap can't leave a stray event on the calendar.
    static func addEvent(date: String) -> [String: JSONValue] {
        ["date": .string(date), "createEvent": .bool(true)]
    }
}
