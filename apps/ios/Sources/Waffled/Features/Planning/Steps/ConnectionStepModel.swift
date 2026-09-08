import Foundation
import Observation

// Weekly Planning · step 5 "Connection" — the pure wording, the row arithmetic, and the
// state behind the board. Ported from
// `apps/web/src/kiosk/planning/steps/ConnectionStep.tsx`.
//
// THE ROW'S SENTENCE IS THE STEP. Everything a row says is either a string the server
// composed (`day`, `time`, `when`, a slot's `label`) or one of the four functions in
// `PlanningConnectionCopy` — which are pure, and factored out for exactly that reason:
// the web's own comment says the wording must be testable without a view so iOS has
// something to copy. Nothing in here parses a household-local timestamp.

/// The step's pure functions — the wording, and which rows exist at all.
enum PlanningConnectionCopy {

    /// How many pairings the step draws. A six-person household has fifteen pairs; three
    /// rows is a LAYOUT decision, which is why the server ranks them all and the client
    /// takes the top. It only grows when more than three pairings genuinely have time on
    /// them (see `visible`).
    static let rows = 3

    /// How many of a pairing's gaps fit on a row before "＋ Another time" takes over.
    static let slotsPerRow = 2

    /// EVERY event this week with both of them on it, in the order they deserve: time
    /// that is already just the two of them first, then the evenings where they are both
    /// there alongside somebody else.
    ///
    /// This is the candidate list for "Link a time", and the reason it needs no new read:
    /// "an event with both people on it" is precisely `alreadyThisWeek ∪ togetherThisWeek`.
    static func bothOnIt(
        _ p: WaffledAPI.PlanningConnectionPairing
    ) -> [WaffledAPI.PlanningConnectionEvent] {
        p.alreadyThisWeek + p.togetherThisWeek
    }

    /// Which pairings the step draws, IN THE SERVER'S OWN ORDER.
    ///
    /// A bare `prefix(3)` was reported as a disappearing act: "I added a custom time …
    /// the events did save but they didn't populate on the connection tab." The board is
    /// ranked by how long it has been since it was just those two, and that ranking reads
    /// only history BEFORE the planned week — so giving a pairing time INSIDE the week
    /// does not move it up, and a pairing ranked fourth stayed invisible no matter what
    /// you had just done for it. A row you cannot see is indistinguishable from a write
    /// that never happened, which is exactly how it was read.
    ///
    /// So the pairings with time on the week claim their places first, and what is left of
    /// the cap goes to the best-ranked pairings that have none. FILTERED, NOT PARTITIONED:
    /// re-grouping would float the credit rows to the top and throw away the ranking,
    /// which is the step's actual argument.
    static func visible(
        _ pairings: [WaffledAPI.PlanningConnectionPairing]
    ) -> [WaffledAPI.PlanningConnectionPairing] {
        var keep = Set(pairings.filter { !$0.alreadyThisWeek.isEmpty }.map(\.key))
        var guesses = max(0, rows - keep.count)
        for p in pairings {
            if guesses <= 0 { break }
            if keep.contains(p.key) { continue }
            keep.insert(p.key)
            guesses -= 1
        }
        return pairings.filter { keep.contains($0.key) }
    }

    /// "2 hours" / "45 minutes" — how long the thing they already have actually runs.
    static func durationWords(_ minutes: Int) -> String {
        if minutes % 60 == 0 {
            let h = minutes / 60
            return "\(h) \(h == 1 ? "hour" : "hours")"
        }
        return "\(minutes) minutes"
    }

    /// "Aug 8", from a `YYYY-MM-DD`.
    ///
    /// UTC + POSIX, and never a device-zone `Date` round-trip: `lastTogetherOn` is a
    /// calendar LABEL the server already resolved in the household's zone, and parsing it
    /// locally west of Greenwich hands back the 7th.
    static func monthDay(_ iso: String) -> String {
        guard let d = isoDay.date(from: iso) else { return iso }
        return monthDayOut.string(from: d)
    }

    /// The one line under a pairing's name — the whole job of a row.
    ///
    /// It leads with the time that ALREADY EXISTS, because that is usually the true
    /// answer. Failing that it says how long it has been and names the thing that is
    /// nearly it but isn't ("Friday's dinner at the Hales is you both, but it's not
    /// that") — a near miss is the most useful thing a row can say, and the honest one.
    ///
    /// A LINKED event answers the pairing whatever else the week says — including an
    /// evening with somebody else on it too, which is the whole point of being able to
    /// pick one. Looked up across BOTH lists rather than assumed to be
    /// `alreadyThisWeek.first`, which is what let the sentence and the chip beside it name
    /// two different events at once.
    static func sentence(
        _ p: WaffledAPI.PlanningConnectionPairing, linkedId: String?
    ) -> String {
        if let linkedId, let linked = bothOnIt(p).first(where: { $0.id == linkedId }) {
            return "Nothing new — \(linked.day)’s \(linked.title) already is it, and you said so out loud."
        }
        if let credit = p.alreadyThisWeek.first {
            let len = credit.minutes.map { " for \(durationWords($0))" } ?? ""
            return "\(credit.day)’s \(credit.title) is the two of you\(len) — that may already be it."
        }
        let since = p.lastTogetherOn.map { " since \(monthDay($0))" } ?? ""
        let lead = "Nothing on the calendar with just the two of you\(since)."
        let near = p.togetherThisWeek
        if near.count == 1 {
            return "\(lead) \(near[0].day)’s \(near[0].title) is you both, but it’s not that."
        }
        if near.count > 1 {
            return "\(lead) You’re both at \(near.count) things this week, but none of them is that."
        }
        return lead
    }

    /// How many credited evenings the WHOLE BOARD carries — the number the catch-up
    /// ladder watches.
    ///
    /// Board-wide on purpose, not per pairing. A trio event made from "Make a pairing"
    /// credits no row at all, so the total never moves, the ladder runs out and nothing
    /// is linked — which is the correct outcome (there is no row to answer), and a
    /// per-pairing count would have to invent a different rule for it.
    static func credited(_ board: WaffledAPI.PlanningConnectionBoard?) -> Int {
        (board?.pairings ?? []).reduce(0) { $0 + $1.alreadyThisWeek.count }
    }

    // Formatters are `static let` per the project's performance rule.
    private static let isoDay: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()
    private static let monthDayOut: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "MMM d"
        return f
    }()
}

/// One pairing, fully resolved BEFORE the view renders — the sentence, the candidates,
/// which single chip may read as chosen, and the capped slots. Rebuilt once per board or
/// link change rather than per render (the project's "keep date math and string building
/// out of the render path" rule).
struct PlanningConnectionRow: Identifiable, Equatable, Sendable {
    /// `personIds.joined(separator: "-")` — the key `PUT /links` is keyed by.
    let key: String
    let personIds: [String]
    let who: String
    let sentence: String
    /// Every event this week with both of them on it — what "Link a time" offers.
    let candidates: [WaffledAPI.PlanningConnectionEvent]
    /// The event somebody ACTUALLY PICKED, if any. Not "the first credited one".
    let answer: WaffledAPI.PlanningConnectionEvent?
    /// What a single chip can honestly stand for: the answer if there is one, otherwise
    /// the ONE obvious candidate — and NOTHING when there are several. The chip used to
    /// read "Tue 8:00 PM counts", which identifies nothing on a row that can carry three
    /// credited evenings, and it always showed `alreadyThisWeek[0]` while the sentence
    /// showed the LINKED event, so it could name two different events at once.
    let oneTap: WaffledAPI.PlanningConnectionEvent?
    /// Whether the one-tap chip reads as CHOSEN. EXACTLY ONE CHIP ON A ROW EVER DOES, and
    /// it is the one with the event's name on it — the "Link a time" button and the slot
    /// chips are never in a chosen state.
    let oneTapChosen: Bool
    /// Offer the picker only when there is more to choose from than the one-tap chip
    /// already covers.
    let showPicker: Bool
    /// The gaps this row draws (`slotsPerRow` of them).
    let slots: [WaffledAPI.PlanningConnectionSlot]

    var id: String { key }

    init(_ p: WaffledAPI.PlanningConnectionPairing, linkedId: String?) {
        let candidates = PlanningConnectionCopy.bothOnIt(p)
        let answer = linkedId.flatMap { id in candidates.first { $0.id == id } }
        // THE ANSWER AND THE ONE-TAP OFFER ARE TWO DIFFERENT THINGS — conflating them is
        // what put two chips on this row reading as chosen at once ("why does it show
        // both?").
        let tap = answer ?? (candidates.count == 1 ? candidates[0] : nil)
        key = p.key
        personIds = p.personIds
        who = p.who
        sentence = PlanningConnectionCopy.sentence(p, linkedId: linkedId)
        self.candidates = candidates
        self.answer = answer
        oneTap = tap
        oneTapChosen = answer != nil
        showPicker = candidates.count > (tap == nil ? 0 : 1)
        slots = Array(p.slots.prefix(PlanningConnectionCopy.slotsPerRow))
    }
}

@MainActor
@Observable
final class PlanningConnectionModel {
    typealias FetchBoard = (_ weekStart: String) async throws -> WaffledAPI.PlanningConnectionBoard
    typealias FetchSlots = (
        _ weekStart: String, _ personIds: [String]
    ) async throws -> WaffledAPI.PlanningConnectionSlots
    typealias SaveLinks = (_ sessionId: String, _ links: [String: String]) async throws -> Void
    /// The ladder's pause, injected so the tests don't sit through seven real seconds.
    typealias Wait = (_ duration: Duration) async -> Void

    /// HOW LONG TO KEEP ASKING THE SERVER AFTER A SAVE, AND WHY THERE IS A LADDER AT ALL.
    ///
    /// THE WRITE IS LOCAL-FIRST; THIS BOARD IS A SERVER READ. `EventEditSheet` saves
    /// through the PowerSync mirror and uploads afterwards, so at the instant `onSaved`
    /// fires the server has not been told yet. Re-reading once, immediately, reliably
    /// asked too early — and the failure looked exactly like a lost save: the event WAS on
    /// the calendar (which renders the local mirror, so it is instant there) while the
    /// pairing underneath it still read "Nothing on the calendar with just the two of
    /// you". Reported twice.
    ///
    /// So: ask, and if the board hasn't moved, ask again on a widening ladder, stopping
    /// the moment the credited count goes UP. That is the board having caught up, and it
    /// is usually the first or second try. Roughly seven seconds all told; past that the
    /// upload isn't landing on this visit and the next ordinary read is authoritative.
    ///
    /// Deliberately NOT a second source of truth. Crediting the pairing from the local
    /// mirror would put the row's sentence — the title, the duration, the household's
    /// clock — on the device, and this step's contract is that the SERVER composes those.
    /// This keeps one reader and only fixes WHEN it reads.
    static let catchup: [Duration] = [
        .milliseconds(250), .milliseconds(500), .seconds(1), .seconds(2), .seconds(3),
    ]

    private(set) var board: WaffledAPI.PlanningConnectionBoard?
    /// The rows the step draws, resolved. Rebuilt on every board or link change.
    private(set) var rows: [PlanningConnectionRow] = []
    /// A failed fetch keeps the previous board and STILL counts as loaded — the shared
    /// REST loading contract (`Features/Shared/RestDomain.swift`).
    private(set) var loaded = false
    /// The last read failed. Drives the banner; it does NOT blank a board we already have.
    private(set) var failed = false
    /// WHICH EVENT ANSWERS EACH PAIRING, keyed by the pairing's people → event id.
    ///
    /// Seeded from the step's own record and written back through the mid-step route on
    /// every change. It started life as a local `Set` of acknowledged pairings on the
    /// grounds that it "changes a sentence, nothing else" — which stopped being true the
    /// moment you could CHOOSE which event it was: a link is the ANSWER to the pairing,
    /// and a step that forgets it the moment you walk away is the complaint this module
    /// has already collected twice.
    private(set) var links: [String: String] = [:]
    /// What this sitting put on the calendar. Only ever a COUNT.
    private(set) var added = 0
    /// Bumped on every observable change, so the view can push the crumb from one
    /// `.onChange` rather than watching five properties.
    private(set) var revision = 0

    private let fetchBoard: FetchBoard
    private let fetchSlots: FetchSlots
    private let saveLinks: SaveLinks
    private let wait: Wait

    init(
        fetchBoard: @escaping FetchBoard = { weekStart in
            try await WaffledAPI().planningConnectionBoard(weekStart: weekStart)
        },
        fetchSlots: @escaping FetchSlots = { weekStart, personIds in
            try await WaffledAPI().planningConnectionSlots(weekStart: weekStart, personIds: personIds)
        },
        saveLinks: @escaping SaveLinks = { sessionId, links in
            try await WaffledAPI().savePlanningConnectionLinks(sessionId: sessionId, links: links)
        },
        wait: @escaping Wait = { duration in try? await Task.sleep(for: duration) }
    ) {
        self.fetchBoard = fetchBoard
        self.fetchSlots = fetchSlots
        self.saveLinks = saveLinks
        self.wait = wait
    }

    // MARK: - The crumb

    /// THE CRUMB IS A MIRROR OF WHAT THE STEP DECIDED, not a bare count.
    ///
    /// `decideStep` REPLACES the step's `data`, so `links` — which the mid-step route
    /// persisted onto the same row — has to be written back or answering the step erases
    /// it. The keys match the web's exactly (`added`, `alreadyCounted`, `links`), because
    /// both platforms write the same record and the recap reads back whatever either
    /// wrote.
    var decisionData: [String: JSONValue] {
        [
            "added": .int(added),
            "alreadyCounted": .int(links.count),
            "links": .object(links.mapValues(JSONValue.string)),
        ]
    }

    /// Which week the links currently in hand were seeded for. A different week is a
    /// different set — see `seedLinks`.
    private var seededWeek: String?

    /// Seed `links` from the step's OWN persisted `data.links`, BEFORE the read lands.
    ///
    /// Order matters: the crumb carries `links`, so pushing one before the seed arrives
    /// would hand the shell an empty map to write back over a real one. Guarded on
    /// `links.isEmpty`, so a link made in this sitting is never overwritten by a re-seed.
    ///
    /// THE WEEK IS PART OF THAT GUARD, and it wasn't. The week stepper is reachable from
    /// inside a session, and with a session open on this step in two weeks the shell handed
    /// the SAME model to both (its body was keyed on the step alone). `links.isEmpty` was
    /// false, so week B's own `data.links` was refused, week B rendered week A's pairings as
    /// already answered — the keys are person-id joins, identical across weeks — and the
    /// next `link()`, which PUTs the whole map, persisted WEEK A'S EVENT IDS ONTO WEEK B.
    ///
    /// So: same week, keep what this sitting made; different week, start from that week's
    /// own data. The shell also keys the body by week now, which is the root fix — this is
    /// the model refusing to be wrong even if that keying is lost again.
    func seedLinks(from value: JSONValue?, weekStart: String) {
        if seededWeek != weekStart {
            links = [:]
            seededWeek = weekStart
            rebuild()
        }
        guard links.isEmpty, let value, case let .object(map) = value else { return }
        var seeded: [String: String] = [:]
        for (key, entry) in map {
            if case let .string(eventId) = entry { seeded[key] = eventId }
        }
        guard !seeded.isEmpty else { return }
        links = seeded
        rebuild()
    }

    // MARK: - Reading the board

    func load(weekStart: String) async {
        do {
            board = try await fetchBoard(weekStart)
            failed = false
        } catch {
            // KEEP THE BOARD WE HAD. A row that vanishes under somebody mid-read is worse
            // than a stale one, and `loaded` still flips so the step never sits on
            // "Looking at who's been where…" forever.
            failed = true
        }
        loaded = true
        rebuild()
    }

    /// Gaps for a set of people the app didn't suggest — "Make a pairing"'s When row.
    /// Returns nil when the server refuses (fewer than two people, a stranger's id), which
    /// the caller renders as "no slots" rather than as an error.
    func slots(weekStart: String, personIds: [String]) async -> WaffledAPI.PlanningConnectionSlots? {
        try? await fetchSlots(weekStart, personIds)
    }

    // MARK: - Linking a time

    /// Record (or clear) which event answers a pairing. Nothing is written to the
    /// calendar and nobody's event is edited — this stores a POINTER.
    ///
    /// Picking the event already linked UNLINKS it: the answer stays undoable. A failed
    /// write costs the MEMORY of the link, not the sitting — the link is already on
    /// screen, and the next ordinary read is authoritative.
    func link(key: String, eventId: String?, sessionId: String) async {
        var next = links
        if eventId == nil || next[key] == eventId {
            next.removeValue(forKey: key)
        } else {
            next[key] = eventId
        }
        links = next
        rebuild()
        try? await saveLinks(sessionId, next)
    }

    // MARK: - After a save

    /// An event was really created from this step. Re-read until the board agrees, and
    /// link what appeared to the pairing it was made for.
    ///
    /// `participantIds` is what the composer was OPENED with, in household order, so its
    /// key matches a row's. A pairing built from scratch may match no row on the board,
    /// and then nothing is linked — which is correct: there is no row to answer.
    func settleAfterSave(weekStart: String, sessionId: String, participantIds: [String]) async {
        added += 1
        revision &+= 1
        // BOTH READ BEFORE THE RE-READ, so the difference afterwards names the event that
        // was just created.
        let was = PlanningConnectionCopy.credited(board)
        let key = participantIds.joined(separator: "-")
        let row = board?.pairings.first { $0.key == key }
        let before = row.map { Set($0.alreadyThisWeek.map(\.id)) }
        await settle(
            weekStart: weekStart, sessionId: sessionId, was: was,
            autoLink: before.map { (key: key, before: $0) })
    }

    /// THE CATCH-UP LADDER. Six reads, five widening pauses, stopping the moment the
    /// credited count goes UP — see `catchup`.
    func settle(
        weekStart: String,
        sessionId: String,
        was: Int,
        autoLink: (key: String, before: Set<String>)?
    ) async {
        for attempt in 0...Self.catchup.count {
            do {
                let next = try await fetchBoard(weekStart)
                board = next
                failed = false
                loaded = true
                rebuild()
                if PlanningConnectionCopy.credited(next) > was {
                    // AN EVENT YOU MAKE FOR A PAIRING IS THAT PAIRING'S ANSWER. "If I make
                    // an event there I expect it to be linked on the connection page" —
                    // you opened this pairing's own chip and put time in the week for
                    // exactly these two; nobody should then have to tell the step that the
                    // thing they just did counts.
                    //
                    // WHICH EVENT IS "THE ONE YOU JUST MADE" IS ANSWERED BY DIFFERENCE,
                    // not by an id from the sheet: the write is local-first, so the only id
                    // that certainly belongs to the server is the one that has APPEARED
                    // since we looked — and `PUT /links` stores an id the server must
                    // resolve.
                    if let autoLink,
                       let pair = next.pairings.first(where: { $0.key == autoLink.key }),
                       let fresh = pair.alreadyThisWeek.first(where: { !autoLink.before.contains($0.id) }) {
                        await link(key: autoLink.key, eventId: fresh.id, sessionId: sessionId)
                    }
                    return
                }
            } catch {
                // A failed read is not "the board hasn't caught up yet" — it is the read
                // being broken, and climbing the ladder on it would hammer a dead endpoint
                // six times. Keep the board, say so, stop.
                failed = true
                loaded = true
                revision &+= 1
                return
            }
            // The last attempt has no pause after it: the ladder GIVES UP rather than
            // looping forever. Past ~7 seconds the upload isn't landing on this visit, and
            // the next ordinary read is authoritative anyway.
            guard attempt < Self.catchup.count else { return }
            await wait(Self.catchup[attempt])
        }
    }

    /// Dismiss the "couldn't read your week" banner. The board underneath it is whatever
    /// the last SUCCESSFUL read said, which is why the banner is dismissible at all.
    func clearFailed() {
        failed = false
        revision &+= 1
    }

    // MARK: - Rows

    private func rebuild() {
        rows = PlanningConnectionCopy.visible(board?.pairings ?? [])
            .map { PlanningConnectionRow($0, linkedId: links[$0.key]) }
        revision &+= 1
    }
}
