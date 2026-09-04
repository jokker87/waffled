import Foundation

/// Reading `data.routes` off a step record.
///
/// Step 1's routing decisions are persisted as free-form JSON on its own step row, so
/// getting them back means decoding a `JSONValue` rather than a typed field. Two step
/// models had grown their own copy of this; one implementation, because the tolerance
/// rule below is the kind of thing that only stays true in one place.
enum PlanningRouteSeed {

    /// Decode a `data.routes` value into routes, TOLERANTLY.
    ///
    /// One unreadable row must cost that row and nothing else. The server's own guard on
    /// this column only checks `kind`/`id`/`to`, so a row written by an older build can
    /// be missing `title` or `source` — and a strict decode would then throw away every
    /// route the family had triaged, on the strength of one bad element. A strict
    /// `Decodable` disagreeing with real bytes is also how the kiosk-claim bug hid: it
    /// surfaces as a bogus "couldn't reach server", not as a parse error.
    ///
    /// Returns `[]` for absent, null, or anything that isn't an array — all of which
    /// simply mean "step 1 hasn't routed anything".
    static func decode(_ value: JSONValue?) -> [WaffledAPI.LooseEndRoute] {
        guard let value, case let .array(items) = value else { return [] }
        return items.compactMap { item in
            guard let bytes = try? JSONEncoder().encode(item) else { return nil }
            return try? WaffledAPI.decoder.decode(WaffledAPI.LooseEndRoute.self, from: bytes)
        }
    }

    /// The routes addressed to one step.
    static func addressed(to stepKey: String, in routes: [WaffledAPI.LooseEndRoute]) -> [WaffledAPI.LooseEndRoute] {
        routes.filter { $0.to == stepKey }
    }

    /// A route's identity: `"chore:<uuid>"`. What "this sitting already dealt with it" is
    /// remembered by — never the title, because two loose ends can read the same.
    static func key(_ route: WaffledAPI.LooseEndRoute) -> String { "\(route.kind):\(route.id)" }

    /// WHAT GOES IN THE ROUTED HALF OF THE STEP'S "SENT HERE" BOX.
    ///
    /// The shell's `PlanningHandoffBanner` draws one box at the top of a step holding
    /// everything that was sent to it, and there are two ways in: a PARKED NOTE arrives on
    /// `step.parked`, and a ROUTED LOOSE END arrives in step 1's `data.routes`. Routed ends
    /// used to be drawn by each step BODY instead, in a section at the bottom — "wouldn't
    /// these be in the top 'parked things' box? why are they hidden at the bottom?" — so
    /// this is the filter that box applies. Four rules, in one place because they are all
    /// about the same double-show:
    ///
    ///  1. **Addressed here.** `to == stepKey`; everything else belongs to another step.
    ///  2. **Not already in the box as a note.** Routing a PARKED note also sets its
    ///     `planning_parked_items.step_key` (`routeLooseEnd`, "the other half of what that
    ///     column is for"), so that one note comes back through BOTH doors. The handoff is
    ///     the richer of the two — it can be Handled or Dropped — so the route row for it is
    ///     dropped. Matched on the note's id, NOT on `kind == "parked"` alone:
    ///     `parkedByStep` caps the box at six, and a note that fell off that cap is not on
    ///     screen, so suppressing its route row would lose it entirely.
    ///  3. **Not a step that draws its own.** The Kids step's read already merges what was
    ///     routed to it into its board (`kids.ts` marks those `routed` and sorts them
    ///     first), and step 1 draws the whole board plus its undo trail. Those two would be
    ///     printing the same row twice on one screen.
    ///  4. **Not already acted on.** `settled` holds the `key(_:)`s this sitting turned into
    ///     something, so the offer goes away once it has been taken.
    ///
    /// `parked` is the step's RAW handoff list, not the banner's locally-hidden view of it:
    /// answering "Handled" on a note must not make its routed twin pop into existence.
    static func sentHere(
        to stepKey: String,
        in routes: [WaffledAPI.LooseEndRoute],
        parked: [WaffledAPI.PlanningStepHandoff]?,
        settled: Set<String>
    ) -> [WaffledAPI.LooseEndRoute] {
        guard drawsItsOwn.contains(stepKey) == false else { return [] }
        let notes = Set((parked ?? []).map(\.id))
        return addressed(to: stepKey, in: routes).filter { route in
            if route.kind == "parked" && notes.contains(route.id) { return false }
            return !settled.contains(key(route))
        }
    }

    /// The steps whose own body already shows what was routed to them. See rule 3 above.
    private static let drawsItsOwn: Set<String> = ["kids", "looseEnds"]
}
