import Foundation

// Weekly Planning · step 1 "Loose ends" — the four endpoints this step owns, and the
// wire types they carry. Ported from `apps/web/src/lib/api/planning/looseEnds.ts`.
//
// STEP 1 IS INTAKE, NOT REPAIR. Its main verb is ROUTING, which decides which LATER
// step handles a loose end and writes NOTHING to any module. Two answers are the
// exceptions and do write: "It's done already" (`done`) and, on a parked note only,
// "Drop it" (`drop`). The capture bar is the third write, and it only ever adds a note
// to our own table.
//
// THE CROSS-STEP CONTRACT lives here: `LooseEndRoute`. Routes are persisted on step 1's
// own `planning_session_steps.data` as `{ routes: [...] }`, so steps 2 / 6 / 8 / 9 need
// no endpoint of their own — they already receive the whole session view and read
//
//     let routes = view.steps.first { $0.key == "looseEnds" }?.data["routes"]
//
// out of `step.data`. Get the shape right; changing it is a cross-platform break.
//
// This file is an `extension WaffledAPI` rather than another thousand lines inside
// `Sync/WaffledAPI.swift` — which is exactly why `getJSON`/`sendReturning` are internal
// (see the transport section's own comment there).

extension WaffledAPI {

    /// One thing still open. `kind` is `chore | list | rhythm | goal | parked` and
    /// `actions` holds `done` / `drop` — both left as `String` ON PURPOSE. The decoder
    /// is strict, so a server newer than this build naming a fifth kind (or a third
    /// action) would throw and blank the whole step rather than render the four it does
    /// understand. The catalog is server-owned; the client renders what it is given.
    struct LooseEnd: Decodable, Sendable, Equatable {
        /// Unique across kinds and stable across refetches — `"chore:<uuid>"`. The list
        /// key, and what the deck remembers as already triaged.
        let key: String
        let kind: String
        let id: String
        let title: String
        let emoji: String?
        /// The one line under the title ("3 days late", "on Groceries", "Parked by
        /// Kevin · 2 weeks ago"). Server-composed so web and iOS say it the same way.
        let detail: String?
        /// Which of done/drop THIS item can take — decided per item by the server (a
        /// chore wanting photo proof can't be completed from a session with no camera).
        let actions: [String]
    }

    /// Where a card can send an item: a step, with the reason under its name. Filtered
    /// server-side to the steps this household actually runs.
    struct LooseEndDestination: Decodable, Sendable, Equatable {
        let to: String
        let label: String
        let hint: String
        /// OPTIONAL, and absent on every destination but one — the server omits the key
        /// entirely rather than sending `false`, so this must not be a plain `Bool`.
        let primary: Bool?
    }

    /// WHAT STEP 1 DECIDED, and the shape every later step reads off the session.
    struct LooseEndRoute: Decodable, Sendable, Equatable {
        let kind: String
        let id: String
        /// The title as it read when routed, so a later step can render the row without
        /// re-reading four modules. A label, never a source of truth.
        let title: String
        /// Which half of step 1 it came from: `notDone` | `parked`.
        let source: String
        /// The step that will handle it — a key from the server-owned catalog.
        let to: String

        /// Tolerant on purpose. The server's own guard for a persisted route
        /// (`isRoute` in looseEnds.ts) checks only `kind`/`id`/`to`, so a row written by
        /// something older can come back missing `title` or `source` — and a strict
        /// decode there would fail the WHOLE view and blank the step over one bad row.
        /// The fallbacks are the server's own (`source` defaults by kind).
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            kind = try c.decode(String.self, forKey: .kind)
            id = try c.decode(String.self, forKey: .id)
            to = try c.decode(String.self, forKey: .to)
            title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
            source = try c.decodeIfPresent(String.self, forKey: .source)
                ?? (kind == "parked" ? "parked" : "notDone")
        }

        /// For tests and for the crumb builder.
        init(kind: String, id: String, title: String, source: String, to: String) {
            self.kind = kind
            self.id = id
            self.title = title
            self.source = source
            self.to = to
        }

        private enum CodingKeys: String, CodingKey { case kind, id, title, source, to }

        /// Back onto the session's `data.routes`.
        ///
        /// THIS IS WHY THE CRUMB IS NOT COUNT-ONLY HERE. `decideStep` REPLACES the
        /// step's `data` with what the shell sends when the step is answered
        /// (`do update set data = excluded.data`), so a crumb of bare counts would wipe
        /// `data.routes` — the array steps 2/6/8/9 read. The web sends the routes back
        /// for the same reason; they are step 1's own decision record, not a copy of
        /// anything a module owns.
        var json: JSONValue {
            .object([
                "kind": .string(kind), "id": .string(id), "title": .string(title),
                "source": .string(source), "to": .string(to),
            ])
        }
    }

    struct LooseEndDestinations: Decodable, Sendable, Equatable {
        let notDone: [LooseEndDestination]
        let parked: [LooseEndDestination]
    }

    /// The server's own tally of each group — the number BEFORE anything was routed or
    /// set aside on this screen. The deck derives its badges from the lists themselves.
    struct LooseEndCounts: Decodable, Sendable, Equatable {
        let notDone: Int
        let parked: Int
    }

    struct LooseEndsView: Decodable, Sendable, Equatable {
        let weekStart: String
        let notDone: [LooseEnd]
        let parked: [LooseEnd]
        let counts: LooseEndCounts
        let destinations: LooseEndDestinations
        let routes: [LooseEndRoute]
        /// Friendly names of the modules actually read ("chores, lists, rhythms"), for
        /// the cleared state's "We checked your …" line — so it never claims to have
        /// checked a module that is off.
        let sources: [String]
        /// The lists this step COULD ask about, with how each currently stands — the
        /// chooser in the step renders off this rather than fetching the config as well.
        /// The server derives `sources` above from the same value, so the two cannot
        /// disagree. OPTIONAL because a server predating the setting sends no key.
        let lists: [PlanningListCandidate]?

        init(
            weekStart: String, notDone: [LooseEnd], parked: [LooseEnd],
            counts: LooseEndCounts, destinations: LooseEndDestinations,
            routes: [LooseEndRoute], sources: [String],
            lists: [PlanningListCandidate]? = nil
        ) {
            self.weekStart = weekStart
            self.notDone = notDone
            self.parked = parked
            self.counts = counts
            self.destinations = destinations
            self.routes = routes
            self.sources = sources
            self.lists = lists
        }
    }

    /// FOUR fields, not one. (The web client under-types this as `{ ok }`.)
    struct LooseEndResolution: Decodable, Sendable, Equatable {
        let ok: Bool
        let kind: String
        let id: String
        let action: String
    }

    /// SIX fields, not two. (The web client under-types this as `{ id, note }`.)
    struct PlanningParkedItem: Decodable, Sendable, Equatable {
        let id: String
        let note: String
        let stepKey: String?
        /// `open` | `resolved` | `dropped`.
        let status: String
        let sessionId: String?
        let createdAt: String
    }

    // MARK: - The four routes

    /// Both groups for the week being planned, the destinations each can send an item
    /// to, and what this session has routed so far.
    ///
    /// `weekStart` is the SHELL'S — never a week computed on the device (the server owns
    /// the boundary, and it re-snaps whatever it is given anyway).
    func planningLooseEnds(weekStart: String?, sessionId: String?) async throws -> LooseEndsView {
        var q: [String] = []
        if let weekStart, !weekStart.isEmpty { q.append("weekStart=\(PlanningQuery.esc(weekStart))") }
        if let sessionId, !sessionId.isEmpty { q.append("sessionId=\(PlanningQuery.esc(sessionId))") }
        let path = "/api/weekly-planning/loose-ends" + (q.isEmpty ? "" : "?\(q.joined(separator: "&"))")
        return try await getJSON(path, as: LooseEndsView.self)
    }

    /// THE STEP'S MAIN VERB. Send an item to the step that will handle it, and get the
    /// whole routes array back.
    ///
    /// `to: nil` UNDOES the routing — which is what the trail's Undo calls. The server
    /// treats an explicit `null` and an absent key identically here, and we send the
    /// explicit `null` because it says what it means. (This is exactly why bodies are
    /// `[String: JSONValue]` and not a synthesized `Encodable`: Swift omits a nil
    /// optional, and a route that means "undo" would look like a route that forgot to
    /// say where.)
    @discardableResult
    func routePlanningLooseEnd(
        sessionId: String, kind: String, id: String, title: String, source: String, to: String?
    ) async throws -> [LooseEndRoute] {
        let body: [String: JSONValue] = [
            "sessionId": .string(sessionId),
            "kind": .string(kind),
            "id": .string(id),
            "title": .string(title),
            "source": .string(source),
            "to": to.map(JSONValue.string) ?? .null,
        ]
        return try await sendReturning(
            "POST", "/api/weekly-planning/loose-ends/route", body: body,
            as: PlanningRoutesResponse.self).routes
    }

    /// The two answers that DO write. `sessionId` is not for the write — it retires any
    /// route this item had, so a later step is never handed something its own module
    /// already considers finished.
    @discardableResult
    func resolvePlanningLooseEnd(
        kind: String, id: String, action: String, sessionId: String?
    ) async throws -> LooseEndResolution {
        var body: [String: JSONValue] = [
            "kind": .string(kind), "id": .string(id), "action": .string(action),
        ]
        if let sessionId, !sessionId.isEmpty { body["sessionId"] = .string(sessionId) }
        return try await sendReturning(
            "POST", "/api/weekly-planning/loose-ends/resolve", body: body,
            as: LooseEndResolution.self)
    }

    /// The capture bar. Step 3 ("Horizon scan") parks through this one too, with a
    /// `stepKey` naming the step that should look at the note — the table and the route
    /// were both written general so there is exactly one parked-item writer.
    ///
    /// Both optionals are OMITTED rather than sent as null when absent: the server reads
    /// key PRESENCE (`input.stepKey !== undefined`), and "No tag" is the absence of a
    /// tag rather than a tag called nothing.
    @discardableResult
    func parkPlanningNote(
        note: String, stepKey: String? = nil, sessionId: String? = nil
    ) async throws -> PlanningParkedItem {
        var body: [String: JSONValue] = ["note": .string(note)]
        if let stepKey, !stepKey.isEmpty { body["stepKey"] = .string(stepKey) }
        if let sessionId, !sessionId.isEmpty { body["sessionId"] = .string(sessionId) }
        return try await sendReturning(
            "POST", "/api/weekly-planning/loose-ends/parked", body: body,
            as: PlanningParkedResponse.self).item
    }

    /// FIX A NOTE THAT IS ALREADY PARKED — its words, its tag, or both.
    ///
    /// "Parked in this session — I have no way to edit the item or change the category and
    /// I should." Until this route a note was written once and only ever ANSWERED, so a
    /// typo or the wrong tag chip could be repaired only by dropping the note and typing
    /// it again — and Drop is supposed to mean "it was never really a thing".
    ///
    /// THE TWO OPTIONALS ARE NOT THE SAME KIND OF OPTIONAL, which is why `stepKey` is
    /// doubly wrapped. The server reads both fields for PRESENCE:
    ///
    ///   * `note: nil`               → key omitted → leave the words alone.
    ///   * `stepKey: nil`            → key omitted → leave the tag alone.
    ///   * `stepKey: .some(nil)`     → `null` sent → "No tag", the real answer.
    ///
    /// A synthesized `Encodable` cannot say the third thing, which is the reason every
    /// body in this module is a `[String: JSONValue]` dictionary.
    ///
    /// `sessionId` is optional and worth passing: a note that step 1 ROUTED also has an
    /// entry on that session's trail quoting its words and naming its destination, and the
    /// server moves the two together. (It repairs every open trail that names the note
    /// either way — the id only says which one to echo back.)
    @discardableResult
    func updatePlanningParkedNote(
        id: String, note: String? = nil, stepKey: String?? = nil, sessionId: String? = nil
    ) async throws -> PlanningParkedItem {
        var body: [String: JSONValue] = [:]
        if let note { body["note"] = .string(note) }
        if let stepKey { body["stepKey"] = stepKey.map(JSONValue.string) ?? .null }
        if let sessionId, !sessionId.isEmpty { body["sessionId"] = .string(sessionId) }
        return try await sendReturning(
            "PATCH", "/api/weekly-planning/loose-ends/parked/\(PlanningQuery.esc(id))", body: body,
            as: PlanningParkedResponse.self).item
    }

}

/// Percent-encode one query value. Session ids and week starts are tame, but a
/// hand-rolled interpolation is the kind of thing that only breaks on the one value
/// nobody tried. Namespaced rather than dropped on `WaffledAPI` — `query` is too good a
/// name to take from ten other steps.
enum PlanningQuery {
    static func esc(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? value
    }
}

// The envelopes, unwrapped locally rather than leaked into the feature: `{ routes }`
// and `{ item }` are transport, not domain.
private struct PlanningRoutesResponse: Decodable {
    let routes: [WaffledAPI.LooseEndRoute]
}

private struct PlanningParkedResponse: Decodable {
    let item: WaffledAPI.PlanningParkedItem
}
