import Foundation

// Weekly Planning — the SHELL's eight endpoints (plus the one the parked-note banner
// needs). The ten steps' own reads live in their own `Planning<Step>API.swift`, which is
// why `WaffledAPI`'s `getJSON` / `send*` / `delete` were widened to internal: an
// `extension WaffledAPI` in a feature file can reach them, and this file never has to
// grow into the 4,000-line one.
//
// EVERY BODY IS A `[String: JSONValue]` DICTIONARY, NOT AN `Encodable` STRUCT. Three of
// these routes read key PRESENCE rather than value:
//
//   * `PATCH /session/:id` gates both `currentStep` and `status` on `!== undefined`, so
//     an omitted key means "leave it alone" and a `null` is a 400 ("unknown step").
//     `JSONEncoder` on a struct with `nil` optionals would omit them too — but it gives
//     no way to say "send this one and not that one" from the same type, and the first
//     person to reach for `encodeIfPresent` with a doubly-optional field gets it wrong.
//   * `PUT /config`'s `steps` is a SPARSE MERGE server-side. Sending the whole map would
//     clobber every other step's opt-out with whatever this client last saw.
//   * `POST /session/:id/step`'s `data` is coerced to `{}` when it isn't an object, so an
//     absent crumb must be an absent key.
//
// Envelopes are unwrapped through a file-private `Decodable` right where they land, so no
// caller ever holds a `{ session: … }` wrapper.
extension WaffledAPI {

    // MARK: - The view

    /// The landing read: config, the week in question, its session, and all ten steps
    /// with their availability and decisions.
    ///
    /// `weekStart` plans a week other than the default; the server snaps and floors it,
    /// and the answer's own `weekStart` is the authority — echo that, never a week the
    /// device computed.
    func weeklyPlanning(weekStart: String? = nil) async throws -> WeeklyPlanningView {
        var path = "/api/weekly-planning"
        if let weekStart, !weekStart.isEmpty {
            let escaped = weekStart.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? weekStart
            path += "?weekStart=\(escaped)"
        }
        return try await getJSON(path, as: WeeklyPlanningView.self)
    }

    // MARK: - Config

    /// One entry of the SERVER-OWNED step catalog as `GET /config` serves it.
    ///
    /// Deliberately NOT `PlanningStep`: that route returns the bare `STEPS` array, which
    /// carries no `available`, `status`, `number`, `data`, `decidedAt` or `parked` —
    /// those are per-household, per-session facts the full view computes. Decoding the
    /// catalog as a `PlanningStep` would fail outright on the missing keys.
    struct PlanningStepCatalogEntry: Decodable, Identifiable, Hashable, Sendable {
        let key: String
        let title: String
        let ask: String
        let primary: String
        let act: String
        let requiresModule: String?

        var id: String { key }
    }

    struct WeeklyPlanningConfigView: Decodable, Sendable {
        let config: WeeklyPlanningConfig
        let steps: [PlanningStepCatalogEntry]
    }

    /// Config plus the bare catalog — the session-free read. Cheaper than the full view
    /// when all you want is the day/time.
    func weeklyPlanningConfig() async throws -> WeeklyPlanningConfigView {
        try await getJSON("/api/weekly-planning/config", as: WeeklyPlanningConfigView.self)
    }

    /// Admin-only. A PARTIAL patch: pass only what changed.
    ///
    /// `steps` in particular is merged server-side onto the household's existing opt-out
    /// map, so `["horizon": false]` turns Horizon off and leaves the other nine exactly
    /// as they were. Passing the whole map from a client's snapshot is how one device's
    /// stale view silently re-enables a step another device just turned off.
    func setWeeklyPlanningConfig(
        dayOfWeek: Int? = nil,
        time: String? = nil,
        showOnToday: Bool? = nil,
        steps: [String: Bool]? = nil
    ) async throws -> WeeklyPlanningConfig {
        var body: [String: JSONValue] = [:]
        if let dayOfWeek { body["dayOfWeek"] = .int(dayOfWeek) }
        if let time { body["time"] = .string(time) }
        if let showOnToday { body["showOnToday"] = .bool(showOnToday) }
        if let steps { body["steps"] = .object(steps.mapValues { JSONValue.bool($0) }) }

        struct Resp: Decodable { let config: WeeklyPlanningConfig }
        return try await sendReturning("PUT", "/api/weekly-planning/config", body: body, as: Resp.self).config
    }

    // MARK: - The session record

    /// Start this week's session, or resume the one already there — the route does both,
    /// which is why "Start the session" and coming back to a half-done week are the same
    /// call. An absent `weekStart` takes the server's default week.
    func startWeeklyPlanningSession(weekStart: String? = nil) async throws -> PlanningSession {
        var body: [String: JSONValue] = [:]
        if let weekStart, !weekStart.isEmpty { body["weekStart"] = .string(weekStart) }
        struct Resp: Decodable { let session: PlanningSession }
        return try await sendReturning("POST", "/api/weekly-planning/session", body: body, as: Resp.self).session
    }

    /// Move the driver between steps, and/or reopen/finish the session.
    ///
    /// OMIT WHAT YOU AREN'T CHANGING. Both fields are gated on `!== undefined`, so a
    /// `null` `currentStep` is not "no change" — it is an unknown step key and a 400.
    func patchWeeklyPlanningSession(
        id: String,
        currentStep: String? = nil,
        status: String? = nil
    ) async throws -> PlanningSession {
        var body: [String: JSONValue] = [:]
        if let currentStep { body["currentStep"] = .string(currentStep) }
        if let status { body["status"] = .string(status) }
        struct Resp: Decodable { let session: PlanningSession }
        return try await sendReturning(
            "PATCH", "/api/weekly-planning/session/\(id)", body: body, as: Resp.self
        ).session
    }

    /// Record what a step decided. `"skipped"` is a real answer, not a failure.
    ///
    /// `data` is the step's crumb, and it is omitted entirely when nil — the route
    /// coerces a non-object to `{}`, so an absent key and an empty object mean the same
    /// thing to the server, and sending `null` would just be a wasted byte with a worse
    /// story if the coercion ever tightened.
    func decideWeeklyPlanningStep(
        sessionId: String,
        stepKey: String,
        status: String,
        data: [String: JSONValue]? = nil
    ) async throws -> [PlanningStep] {
        var body: [String: JSONValue] = ["stepKey": .string(stepKey), "status": .string(status)]
        if let data { body["data"] = .object(data) }
        struct Resp: Decodable { let steps: [PlanningStep] }
        return try await sendReturning(
            "POST", "/api/weekly-planning/session/\(sessionId)/step", body: body, as: Resp.self
        ).steps
    }

    /// Throw the session away and put the week back to its lobby. What it already
    /// decided — events added, chores handed out — lives in the modules that own it and
    /// stays put; only the session record goes.
    func discardWeeklyPlanningSession(id: String) async throws {
        try await delete("/api/weekly-planning/session/\(id)")
    }

    struct WeeklyPlanningCompletion: Decodable, Sendable {
        let session: PlanningSession
        let steps: [PlanningStep]
    }

    /// Finish it — the record gets its timestamp and Today becomes the surface again.
    /// No body, hence `sendJSON` rather than `sendReturning`.
    func completeWeeklyPlanningSession(id: String) async throws -> WeeklyPlanningCompletion {
        try await sendJSON(
            "POST", "/api/weekly-planning/session/\(id)/complete", as: WeeklyPlanningCompletion.self)
    }

    // MARK: - Loose ends (what the parked-note banner answers with)

    /// Settle one routed loose end. The banner only ever uses `kind: "parked"` — the
    /// other kinds (chore/list/rhythm/goal) belong to the Loose ends step, which owns
    /// the whole board.
    ///
    /// `sessionId` is optional to the server and does one thing: retires the item from
    /// THIS session's route list, so a note dealt with here stops being offered by the
    /// recap. Always pass it when there is one.
    func resolveWeeklyPlanningLooseEnd(
        kind: String,
        id: String,
        action: String,
        sessionId: String? = nil
    ) async throws {
        var body: [String: JSONValue] = [
            "kind": .string(kind), "id": .string(id), "action": .string(action),
        ]
        if let sessionId { body["sessionId"] = .string(sessionId) }
        try await send("POST", "/api/weekly-planning/loose-ends/resolve", body: body)
    }
}
