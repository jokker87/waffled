import Foundation

// Weekly Planning · step 10 "Recap" — ONE read, and no write at all.
// Ported from `apps/web/src/lib/api/planning/recap.ts`.
//
// EVERY LINE IS A POINTER, NEVER A COPY. Saving the week is the shell's
// `POST /session/:id/complete`; every headline, sentence and tally below arrives already
// RESOLVED from the server, which reads the modules that own each decision. A client that
// re-counted the decisions, or reworded one into its own sentence, would be a second
// reading of the week free to drift from the server's — and from the other platform's.
// The only thing the client decides is layout.
//
// The one place that rule is visible in the wire types is an event's colour: the server
// sends `personId` + `personColor` + `participantIds` — the colour INPUTS — and never a
// resolved colour, so the week strip tints through the app's own `EventPalette`, the same
// resolver the month and week views use.
extension WaffledAPI {

    /// One event on the week strip. The colour inputs, never a colour.
    struct PlanningRecapEvent: Decodable, Identifiable, Sendable, Equatable {
        let id: String
        let title: String
        /// "Saturday 8:00 PM" / "Saturday, all day" — composed server-side in the
        /// household's timezone, so this is text to show, not a date to parse.
        let when: String
        let personId: String?
        let personName: String?
        /// A real `persons.color_hex` — `Color(hexString:)`, never a `WF` token.
        let personColor: String?
        let participantIds: [String]

        /// `participantIds ?? []` IS THE POINT OF THIS INITIALIZER. On the web a missing
        /// array costs one `.map`; in Swift a missing non-optional array THROWS and takes
        /// the entire `PlanningRecapView` decode with it — the final screen of the
        /// session, gone, because one event had no participants key. A payload missing it
        /// must cost a tint, not the recap.
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
            when = try c.decodeIfPresent(String.self, forKey: .when) ?? ""
            personId = try c.decodeIfPresent(String.self, forKey: .personId)
            personName = try c.decodeIfPresent(String.self, forKey: .personName)
            personColor = try c.decodeIfPresent(String.self, forKey: .personColor)
            participantIds = try c.decodeIfPresent([String].self, forKey: .participantIds) ?? []
        }

        private enum CodingKeys: String, CodingKey {
            case id, title, when, personId, personName, personColor, participantIds
        }
    }

    /// One day of the week, read back: its dinner, its events, and how many it is holding
    /// back so a busy day says "+2 more" instead of growing.
    struct PlanningRecapDay: Decodable, Identifiable, Sendable, Equatable {
        let date: String
        /// The dinner planned for that night. Null with the meals module off, too — a
        /// household that doesn't plan meals gets a week of events, not a row of blanks.
        let meal: String?
        let cook: String?
        let events: [PlanningRecapEvent]
        let more: Int

        var id: String { date }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            date = try c.decode(String.self, forKey: .date)
            meal = try c.decodeIfPresent(String.self, forKey: .meal)
            cook = try c.decodeIfPresent(String.self, forKey: .cook)
            events = try c.decodeIfPresent([PlanningRecapEvent].self, forKey: .events) ?? []
            more = try c.decodeIfPresent(Int.self, forKey: .more) ?? 0
        }

        private enum CodingKeys: String, CodingKey { case date, meal, cook, events, more }
    }

    /// What this session changed, grouped by THE MODULE THE DECISION LIVES IN. The
    /// grouping is not cosmetic: a group names the place you would go to change it, which
    /// is what makes the row a pointer.
    struct PlanningRecapGroup: Decodable, Identifiable, Sendable, Equatable {
        let key: String
        let label: String
        /// The tally: what the week says now, and what this session changed.
        let headline: String
        /// The decisions themselves, named, ' · ' separated. Composed server-side so both
        /// platforms read the same sentence.
        let detail: String
        let count: Int
        /// The step that owns it — where you go to change it.
        let stepKey: String?

        var id: String { key }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            key = try c.decode(String.self, forKey: .key)
            label = try c.decodeIfPresent(String.self, forKey: .label) ?? key
            headline = try c.decodeIfPresent(String.self, forKey: .headline) ?? ""
            detail = try c.decodeIfPresent(String.self, forKey: .detail) ?? ""
            count = try c.decodeIfPresent(Int.self, forKey: .count) ?? 0
            stepKey = try c.decodeIfPresent(String.self, forKey: .stepKey)
        }

        private enum CodingKeys: String, CodingKey {
            case key, label, headline, detail, count, stepKey
        }
    }

    /// A note nobody routed anywhere — the last call.
    struct PlanningRecapLastCall: Decodable, Identifiable, Sendable, Equatable {
        let id: String
        let note: String
        /// "Parked by Kevin · 2 weeks ago · passed over 3 times" — step 1's own line,
        /// composed by the same `listParked` that writes it there, so a note reads
        /// identically in both places.
        let detail: String?
    }

    /// What was left alone ON PURPOSE — the other half of the record. A skipped step is a
    /// decision, and "nothing this week" is an answer.
    struct PlanningRecapLeftAlone: Decodable, Identifiable, Sendable, Equatable {
        let key: String
        let label: String
        let detail: String
        /// "skipped" — passed over on purpose · "none" — answered with nothing ·
        /// "parked" — notes waiting for a step that will look at them.
        ///
        /// A STRING, not an enum: the catalog is server-owned and a newer server may name
        /// a fourth badge, which must render as itself rather than fail the decode.
        let badge: String
        let stepKey: String?

        var id: String { key }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            key = try c.decode(String.self, forKey: .key)
            label = try c.decodeIfPresent(String.self, forKey: .label) ?? key
            detail = try c.decodeIfPresent(String.self, forKey: .detail) ?? ""
            badge = try c.decodeIfPresent(String.self, forKey: .badge) ?? ""
            stepKey = try c.decodeIfPresent(String.self, forKey: .stepKey)
        }

        private enum CodingKeys: String, CodingKey { case key, label, detail, badge, stepKey }
    }

    /// The receipt's three numbers. DERIVED SERVER-SIDE on every read from the arrays
    /// above — never stored, and never added up on the client, so the header and the cards
    /// cannot disagree.
    struct PlanningRecapCounts: Decodable, Sendable, Equatable {
        let decisions: Int
        let deferred: Int
        let parked: Int

        init(decisions: Int = 0, deferred: Int = 0, parked: Int = 0) {
            self.decisions = decisions
            self.deferred = deferred
            self.parked = parked
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            decisions = try c.decodeIfPresent(Int.self, forKey: .decisions) ?? 0
            deferred = try c.decodeIfPresent(Int.self, forKey: .deferred) ?? 0
            parked = try c.decodeIfPresent(Int.self, forKey: .parked) ?? 0
        }

        private enum CodingKeys: String, CodingKey { case decisions, deferred, parked }
    }

    struct PlanningRecapView: Decodable, Sendable, Equatable {
        let weekStart: String
        /// The session's finish time, or nil while the week is still being decided.
        let savedAt: String?
        let days: [PlanningRecapDay]
        let groups: [PlanningRecapGroup]
        let lastCall: [PlanningRecapLastCall]
        let lastCallMore: Int
        let leftAlone: [PlanningRecapLeftAlone]
        let counts: PlanningRecapCounts

        /// EVERY collection defaults. This is the last screen of the session: a payload
        /// missing one array must cost that card, never the whole recap — and in Swift the
        /// difference between those two outcomes is exactly this initializer.
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            weekStart = try c.decodeIfPresent(String.self, forKey: .weekStart) ?? ""
            savedAt = try c.decodeIfPresent(String.self, forKey: .savedAt)
            days = try c.decodeIfPresent([PlanningRecapDay].self, forKey: .days) ?? []
            groups = try c.decodeIfPresent([PlanningRecapGroup].self, forKey: .groups) ?? []
            lastCall = try c.decodeIfPresent([PlanningRecapLastCall].self, forKey: .lastCall) ?? []
            lastCallMore = try c.decodeIfPresent(Int.self, forKey: .lastCallMore) ?? 0
            leftAlone = try c.decodeIfPresent([PlanningRecapLeftAlone].self, forKey: .leftAlone) ?? []
            counts = try c.decodeIfPresent(PlanningRecapCounts.self, forKey: .counts)
                ?? PlanningRecapCounts()
        }

        private enum CodingKeys: String, CodingKey {
            case weekStart, savedAt, days, groups, lastCall, lastCallMore, leftAlone, counts
        }
    }

    /// The week read back. WHICH WEEK IS THE SESSION'S: when `sessionId` is given the
    /// session's own `week_start` wins over the query param server-side, because a session
    /// may plan a week further out than the default and answering with a different week's
    /// events would have the last screen read back a week nobody planned.
    ///
    /// `weekStart` is still passed when there is no session, so the sessionless read
    /// resolves through the shell's own week gate rather than through anything the device
    /// computed.
    func planningRecap(sessionId: String?, weekStart: String?) async throws -> PlanningRecapView {
        var q: [String] = []
        if let sessionId, !sessionId.isEmpty { q.append("sessionId=\(PlanningQuery.esc(sessionId))") }
        if let weekStart, !weekStart.isEmpty { q.append("weekStart=\(PlanningQuery.esc(weekStart))") }
        let path = "/api/weekly-planning/recap" + (q.isEmpty ? "" : "?" + q.joined(separator: "&"))
        return try await getJSON(path, as: PlanningRecapView.self)
    }
}

/// The crumb the step hands the session record when the week is saved.
///
/// INTEGERS ONLY — the pointer rule applied to storage. The receipt may freeze how MANY
/// decisions were made tonight (a statement about the session, and so true forever); it
/// must never freeze WHAT they were, because the things themselves live in the modules and
/// a title copied here starts going stale the moment somebody edits it.
///
/// The keys match `planningRecapDecision` in `apps/web/src/lib/api/planning/recap.ts`
/// exactly: both platforms write the same record, and the recap reads back whatever
/// either wrote.
enum PlanningRecapCrumb {
    static func decision(_ view: WaffledAPI.PlanningRecapView?) -> [String: JSONValue]? {
        guard let view else { return nil }
        return [
            "counts": .object([
                "decisions": .int(view.counts.decisions),
                "deferred": .int(view.counts.deferred),
                "parked": .int(view.counts.parked),
            ]),
        ]
    }
}
