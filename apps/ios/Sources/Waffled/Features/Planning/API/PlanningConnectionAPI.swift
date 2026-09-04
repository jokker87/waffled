import Foundation

// Weekly Planning · step 5 (Connection) — TWO READS AND ONE POINTER.
// Ported from `apps/web/src/lib/api/planning/connection.ts`.
//
// NOTHING NEW IS STORED FOR THIS STEP, and that is the whole design. A pairing is not a
// record: it is a QUERY over event_participants for an event whose people are exactly
// those two. Claiming a slot writes an ORDINARY CALENDAR EVENT with those participants —
// through the app's own `EventEditSheet`, which already owns the local-first write — so
// there is deliberately no "create pairing" call here. A second door onto the events
// table is how the two would drift.
//
// The one write is `/links`, and it holds the line: it stores a POINTER from a pairing to
// an event that already exists (no event, no pairing, no time), because a link is the
// ANSWER to a pairing and has to outlive the render that made it. It is a MID-STEP write
// — it merges onto the step's row and deliberately does NOT settle the step.
//
// EVERY SENTENCE ON A ROW IS COMPOSED SERVER-SIDE. `day`, `time`, `when` and a slot's
// `label` arrive ready to render, in the household's zone. Do not rebuild them on the
// device: the pairing and the calendar would then be able to word the same event two
// different ways, and the row's whole job is to name something you can find on the week.

extension WaffledAPI {

    /// A gap the week left behind.
    struct PlanningConnectionSlot: Decodable, Sendable, Equatable, Identifiable {
        /// The day inside the planned week (`YYYY-MM-DD`, household-local).
        let date: String
        /// When the gap opens, or `nil` for a day with nothing on it.
        ///
        /// ⚠️ NIL IS NOT "UNKNOWN" — it means the WHOLE DAY IS FREE, and the event
        /// sheet's own time picker decides the hour. The label already says so ("Sat ·
        /// free all day"), so a client that treated this as missing data would drop the
        /// roomiest offer on the row.
        let startsAt: String?
        /// `after` | `open`. Left as a `String`: the catalog of kinds is the server's.
        let kind: String
        /// The event the gap opens after (`after` only).
        let afterTitle: String?
        /// "Wed after Scouts" / "Tue after 8:30 PM" / "Sun · free all day". Built
        /// server-side so web and iOS say it the same way.
        let label: String

        /// One slot per day, so the day is the identity — the same key the web uses.
        var id: String { date }

        /// The whole day is free (no hour to prefill). Reads as an ANSWER, not as a gap
        /// in the data.
        var isFreeAllDay: Bool { startsAt == nil }
    }

    /// An event on the planned week with the pairing's people on it.
    struct PlanningConnectionEvent: Decodable, Sendable, Equatable, Identifiable {
        let id: String
        let title: String
        let startsAt: String
        let endsAt: String?
        let allDay: Bool
        /// Length in minutes, when the event has an end.
        let minutes: Int?
        /// "Saturday" — the row's sentence needs the possessive ("Saturday's yard work").
        let day: String
        /// "1:00 PM", or nil on an all-day row.
        let time: String?
        /// "Saturday 1:00 PM" — formatted in the household's zone, SERVER-SIDE.
        let when: String
    }

    struct PlanningConnectionPairing: Decodable, Sendable, Equatable, Identifiable {
        /// Exactly the pairing's people, in household order.
        let personIds: [String]
        /// "Kevin and Kelly".
        let who: String
        /// The last event BEFORE the planned week whose people were exactly these two.
        let lastTogetherOn: String?
        let lastTogetherTitle: String?
        /// Events this week whose people are EXACTLY these two — time that already exists.
        let alreadyThisWeek: [PlanningConnectionEvent]
        /// Events this week with both of them AND someone else: "you're both there, and
        /// it still isn't that".
        let togetherThisWeek: [PlanningConnectionEvent]
        /// Ranked gaps, roomiest first — ALL of them. How many chips fit is the step's call.
        let slots: [PlanningConnectionSlot]

        /// THE PAIRING'S KEY, and the exact spelling `PUT /links` is keyed by. Ported
        /// from the web's `p.personIds.join('-')`; both platforms write the same map, so
        /// this must not be re-spelled.
        var key: String { personIds.joined(separator: "-") }
        var id: String { key }
    }

    struct PlanningConnectionBoard: Decodable, Sendable, Equatable {
        /// The week the server resolved (snapped and floored) — echoed, never computed here.
        let weekStart: String
        /// EVERY pair in the household, ranked by how long it has been. The step draws
        /// the top few (see `PlanningConnectionCopy.visible`) — the cut is the client's,
        /// so the two platforms can't disagree about the ranking.
        let pairings: [PlanningConnectionPairing]
    }

    struct PlanningConnectionSlots: Decodable, Sendable, Equatable {
        let weekStart: String
        /// Household order, not the order they were tapped — the server re-sorts.
        let personIds: [String]
        let who: String
        let slots: [PlanningConnectionSlot]
    }

    /// The board. `weekStart` is the one the shell handed us — passed back, never computed
    /// on the device (the server owns the boundary and re-snaps whatever it is given).
    func planningConnectionBoard(weekStart: String?) async throws -> PlanningConnectionBoard {
        var path = "/api/weekly-planning/connection"
        if let weekStart, !weekStart.isEmpty { path += "?weekStart=\(PlanningQuery.esc(weekStart))" }
        return try await getJSON(path, as: PlanningConnectionBoard.self)
    }

    /// The same gaps, for people the app didn't suggest — what makes "Make a pairing" a
    /// first-class action rather than a blank date picker. 400s on fewer than two people,
    /// or on an id from another household.
    func planningConnectionSlots(
        weekStart: String, personIds: [String]
    ) async throws -> PlanningConnectionSlots {
        let people = personIds.joined(separator: ",")
        let path = "/api/weekly-planning/connection/slots"
            + "?weekStart=\(PlanningQuery.esc(weekStart))&people=\(PlanningQuery.esc(people))"
        return try await getJSON(path, as: PlanningConnectionSlots.self)
    }

    /// WHICH EVENT ANSWERS EACH PAIRING, keyed by the pairing's people.
    ///
    /// A MID-STEP write: the server merges this map onto the step's row with `jsonb_set`
    /// and leaves `status` / `decided_at` alone — linking a time is not answering the
    /// step. `setDecisionData` alone would not do: it only reaches the server when the
    /// step IS answered, and somebody who links a time then walks off has answered
    /// nothing. (The crumb still carries `links`, because answering the step REPLACES the
    /// step's data and would otherwise wipe what this wrote.)
    @discardableResult
    func savePlanningConnectionLinks(
        sessionId: String, links: [String: String]
    ) async throws -> Bool {
        struct Resp: Decodable { let ok: Bool }
        let body: [String: JSONValue] = [
            "sessionId": .string(sessionId),
            "links": .object(links.mapValues(JSONValue.string)),
        ]
        return try await sendReturning(
            "PUT", "/api/weekly-planning/connection/links", body: body, as: Resp.self).ok
    }
}
