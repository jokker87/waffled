import Foundation

// Weekly Planning · step 3 "Horizon scan" — ONE read, and deliberately not three.
// Ported from `apps/web/src/lib/api/planning/horizon.ts`.
//
// Almost nothing about this step is new, so almost nothing belongs here:
//
//   · THE MONTH is the calendar the family already has. On iOS that is the PowerSync
//     mirror (`SyncManager.eventsByDay`), which is what `GET /api/events?from&to` is on
//     the web — the same rows, read the way this platform reads them. A planning-owned
//     month endpoint would be a second door onto the same events.
//   · ADDING AN EVENT is the app's own `EventEditSheet`.
//   · PARKING A NOTE is step 1's `parkPlanningNote` (see PlanningLooseEndsAPI.swift),
//     whose own header says step 3 writes through it. A second parked-item path is how
//     two writers end up leaving rows a later step can't read the same way.
//
// What is left is the one read the park bar cannot derive for itself: which tags it may
// offer (only steps still AHEAD of this one, and only those this household runs), and
// what THIS SESSION has already parked — because `setDecisionData` is not storage, so
// anything that must still be true on a second visit is read back from the table that
// owns it.

extension WaffledAPI {

    /// One tag the park bar may offer. The tag names the step that will LOOK at the
    /// note — never `horizon`, the step doing the writing.
    struct HorizonTag: Decodable, Sendable, Equatable {
        /// A step key from the server-owned catalog.
        let stepKey: String
        /// The catalog's own title for that step, so the bar and the agenda sheet can
        /// never call the same step two different things.
        let label: String
        let hint: String
        /// OPTIONAL. The one the bar opens on — at most one, and ABSENT ENTIRELY when
        /// its step is not available (a household with no Tasks step has no primary, and
        /// the bar must then open on "No tag" rather than on whatever happens to be
        /// first).
        let primary: Bool?
    }

    /// A note parked during this session, whichever bar wrote it.
    struct HorizonNote: Decodable, Sendable, Equatable, Identifiable {
        let id: String
        let note: String
        let stepKey: String?
        /// The tag as a person reads it, composed server-side.
        let stepLabel: String?
        let createdAt: String

        init(id: String, note: String, stepKey: String?, stepLabel: String?, createdAt: String) {
            self.id = id
            self.note = note
            self.stepKey = stepKey
            self.stepLabel = stepLabel
            self.createdAt = createdAt
        }
    }

    struct HorizonView: Decodable, Sendable, Equatable {
        /// "No tag" is the ABSENCE of a tag, so it is never in this list — the client
        /// renders it as the option that sends no `stepKey` at all.
        let tags: [HorizonTag]
        /// Every OPEN note parked during this session — step 1's capture bar and step 3's
        /// park bar drop the same kind of thing in the same table.
        let parked: [HorizonNote]

        init(tags: [HorizonTag], parked: [HorizonNote]) {
            self.tags = tags
            self.parked = parked
        }

        /// Both lists default to empty rather than being required, the same defence the
        /// web read makes (`v.tags ?? []`): a payload missing one of them should cost
        /// that list, never the whole step.
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            tags = try c.decodeIfPresent([HorizonTag].self, forKey: .tags) ?? []
            parked = try c.decodeIfPresent([HorizonNote].self, forKey: .parked) ?? []
        }

        private enum CodingKeys: String, CodingKey { case tags, parked }
    }

    /// The bar's tags and this session's board. `sessionId` is optional server-side —
    /// without one the tags still come back and the board is empty.
    func planningHorizon(sessionId: String?) async throws -> HorizonView {
        var path = "/api/weekly-planning/horizon"
        if let sessionId, !sessionId.isEmpty { path += "?sessionId=\(PlanningQuery.esc(sessionId))" }
        return try await getJSON(path, as: HorizonView.self)
    }
}
