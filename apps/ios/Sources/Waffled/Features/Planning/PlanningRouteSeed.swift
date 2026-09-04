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
}
