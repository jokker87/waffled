import Foundation
import Testing
@testable import Waffled

// Weekly Planning · step 1 "Loose ends" — the step's wire types and its state machine.
//
// The decoding suite works from VERBATIM payload bytes, lifted from
// `apps/api/test/weekly-planning-looseEnds.integration.test.ts` (the chore fixture "Take
// the bins out", the parked note "Ask about the school trip", the four notDone
// destinations and the two parked ones). Hand-shaped fixtures drift; these are what the
// route actually answers.
//
// The model suite drives the injected closures — the same fake-feed shape as
// `FamilyNightModelTests` — because every network op on the model is a closure with a
// `WaffledAPI()`-backed default, and that is the seam.

private enum LooseEndsFailure: Error { case refused }

private let choreId = "11111111-1111-4111-8111-111111111111"
private let noteId = "22222222-2222-4222-8222-222222222222"

// MARK: - Decoding

@Suite struct PlanningLooseEndsDecodingTests {

    /// The whole read, as the route answers it.
    @Test func decodesTheView() throws {
        let json = """
        {
          "weekStart": "2026-09-06",
          "notDone": [
            {"key":"chore:\(choreId)","kind":"chore","id":"\(choreId)","title":"Take the bins out",
             "emoji":"🗑️","detail":"3 days late","actions":["done"]}
          ],
          "parked": [
            {"key":"parked:\(noteId)","kind":"parked","id":"\(noteId)","title":"Ask about the school trip",
             "emoji":null,"detail":"Parked by Kevin · today","actions":["done","drop"]}
          ],
          "counts": {"notDone":1,"parked":1},
          "destinations": {
            "notDone":[
              {"to":"tasks","label":"Tasks","hint":"Give it an owner and a day","primary":true},
              {"to":"calendar","label":"Calendar","hint":"It needs an appointment slot"},
              {"to":"kids","label":"Kids","hint":"It's really one of the kids'"},
              {"to":"goals","label":"Goals","hint":"It belongs to a goal"}
            ],
            "parked":[
              {"to":"tasks","label":"Make it a task","hint":"Someone owns it this week","primary":true},
              {"to":"calendar","label":"Put it on the calendar","hint":"A date to look, or a deadline"}
            ]
          },
          "routes":[
            {"kind":"chore","id":"\(choreId)","title":"Take the bins out","source":"notDone","to":"tasks"}
          ],
          "sources":["chores","lists","rhythms","goals"]
        }
        """
        let view = try WaffledAPI.decoder.decode(
            WaffledAPI.LooseEndsView.self, from: Data(json.utf8))

        #expect(view.weekStart == "2026-09-06")
        #expect(view.counts.notDone == 1)
        #expect(view.counts.parked == 1)
        #expect(view.sources == ["chores", "lists", "rhythms", "goals"])
        // The key is unique across kinds and is what the deck remembers.
        #expect(view.notDone.first?.key == "chore:\(choreId)")
        #expect(view.notDone.first?.detail == "3 days late")
        #expect(view.notDone.first?.actions == ["done"])
        // Only a parked note can be dropped, and the server says so per item.
        #expect(view.parked.first?.actions == ["done", "drop"])
        #expect(view.parked.first?.emoji == nil)
        #expect(view.routes.first?.to == "tasks")
        #expect(view.routes.first?.source == "notDone")
    }

    /// `primary` IS OPTIONAL. The server omits the key entirely on every destination but
    /// one, so a `Bool` here would fail the whole read.
    @Test func destinationPrimaryIsAbsentOnAllButOne() throws {
        let json = """
        {"notDone":[
           {"to":"tasks","label":"Tasks","hint":"Give it an owner and a day","primary":true},
           {"to":"calendar","label":"Calendar","hint":"It needs an appointment slot"}],
         "parked":[{"to":"calendar","label":"Put it on the calendar","hint":"A date to look, or a deadline"}]}
        """
        let d = try WaffledAPI.decoder.decode(
            WaffledAPI.LooseEndDestinations.self, from: Data(json.utf8))

        #expect(d.notDone[0].primary == true)
        #expect(d.notDone[1].primary == nil)
        #expect(d.parked[0].primary == nil)
        // What the card actually asks: is this the loud one?
        #expect(d.notDone.filter { $0.primary == true }.count == 1)
    }

    /// An item may arrive with the optional keys missing rather than null — both are the
    /// same absence, and neither may cost the step.
    @Test func decodesAnItemWithNoEmojiOrDetailKeys() throws {
        let json = """
        {"key":"goal:\(choreId)","kind":"goal","id":"\(choreId)","title":"Run three times","actions":[]}
        """
        let item = try WaffledAPI.decoder.decode(WaffledAPI.LooseEnd.self, from: Data(json.utf8))

        #expect(item.emoji == nil)
        #expect(item.detail == nil)
        #expect(item.actions.isEmpty)
    }

    /// A route persisted by something older can be missing `title`/`source` — the server's
    /// own guard only checks kind/id/to — and one bad row must not blank the step.
    @Test func decodesARouteMissingTitleAndSource() throws {
        let json = """
        [{"kind":"parked","id":"\(noteId)","to":"tasks"}]
        """
        let routes = try WaffledAPI.decoder.decode(
            [WaffledAPI.LooseEndRoute].self, from: Data(json.utf8))

        #expect(routes.count == 1)
        #expect(routes[0].title == "")
        #expect(routes[0].source == "parked")
    }

    /// FOUR fields — the web client under-types this as `{ ok }`.
    @Test func decodesTheResolveAnswer() throws {
        let json = """
        {"ok":true,"kind":"parked","id":"\(noteId)","action":"drop"}
        """
        let r = try WaffledAPI.decoder.decode(
            WaffledAPI.LooseEndResolution.self, from: Data(json.utf8))

        #expect(r.ok)
        #expect(r.kind == "parked")
        #expect(r.id == noteId)
        #expect(r.action == "drop")
    }

    /// SIX fields — the web client under-types this as `{ id, note }`.
    @Test func decodesAParkedItem() throws {
        let json = """
        {"item":{"id":"\(noteId)","note":"Ask about the school trip","stepKey":null,
                 "status":"open","sessionId":"33333333-3333-4333-8333-333333333333",
                 "createdAt":"2026-09-02T18:04:11.000Z"}}
        """
        struct Envelope: Decodable { let item: WaffledAPI.PlanningParkedItem }
        let item = try WaffledAPI.decoder.decode(Envelope.self, from: Data(json.utf8)).item

        #expect(item.status == "open")
        #expect(item.stepKey == nil)
        #expect(item.sessionId == "33333333-3333-4333-8333-333333333333")
        #expect(item.createdAt == "2026-09-02T18:04:11.000Z")
    }
}

// MARK: - The card's choices

@Suite struct LooseEndChoiceTests {
    private func item(kind: String, actions: [String]) -> WaffledAPI.LooseEnd {
        WaffledAPI.LooseEnd(
            key: "\(kind):\(choreId)", kind: kind, id: choreId, title: "Take the bins out",
            emoji: nil, detail: nil, actions: actions)
    }

    private let notDoneDests = [
        WaffledAPI.LooseEndDestination(to: "tasks", label: "Tasks", hint: "Give it an owner and a day", primary: true),
        WaffledAPI.LooseEndDestination(to: "calendar", label: "Calendar", hint: "It needs an appointment slot", primary: nil),
    ]

    /// Group A: the destinations are the card's choices; the writing answer and "leave it
    /// open" stay quiet underneath, with "leave" first.
    @Test func notDoneKeepsItsWritingAnswerQuiet() {
        let built = LooseEndChoice.build(
            item: item(kind: "chore", actions: ["done"]), group: .notDone, destinations: notDoneDests)

        #expect(built.choices.map(\.key) == ["to:tasks", "to:calendar"])
        #expect(built.choices.first?.isPrimary == true)
        #expect(built.quiet.map(\.key) == ["leave", "do:done"])
        #expect(built.quiet.first?.label == "Leave it open")
        #expect(built.quiet.last?.label == "It’s done already")
    }

    /// Group B: a note might turn out to be nothing, so "talk about it now" and "keep it
    /// parked" are ordinary choices on the card — four in all — and only Drop stays quiet.
    @Test func parkedPromotesTalkAboutItAndKeepItParked() {
        let dests = [
            WaffledAPI.LooseEndDestination(to: "tasks", label: "Make it a task", hint: "Someone owns it this week", primary: true)
        ]
        let built = LooseEndChoice.build(
            item: item(kind: "parked", actions: ["done", "drop"]), group: .parked, destinations: dests)

        #expect(built.choices.map(\.key) == ["to:tasks", "do:done", "leave"])
        #expect(built.choices[1].label == "Talk about it now")
        #expect(built.choices[2].label == "Keep it parked")
        #expect(built.quiet.map(\.key) == ["do:drop"])
        #expect(built.quiet.first?.label == "Drop it")
    }

    /// A card whose item can take no action at all (a chore wanting photo proof) still
    /// offers its destinations — routing is never gated on the module.
    @Test func anItemWithNoActionsStillRoutes() {
        let built = LooseEndChoice.build(
            item: item(kind: "chore", actions: []), group: .notDone, destinations: notDoneDests)

        #expect(built.choices.count == 2)
        #expect(built.quiet.map(\.key) == ["leave"])
    }

    /// The cleared state names what was looked at, and how much is waiting in the group
    /// you are not on.
    @Test func clearedCopyNamesTheSourcesAndTheOtherGroup() {
        #expect(
            LooseEndCopy.clearedSubtitle(.notDone, sources: ["chores", "lists"], remainingOther: 1)
                == "We checked your chores, lists. 1 parked note is still waiting.")
        #expect(
            LooseEndCopy.clearedSubtitle(.notDone, sources: [], remainingOther: 0)
                == "We checked your modules. Both groups are clear.")
        #expect(
            LooseEndCopy.clearedSubtitle(.parked, sources: ["chores"], remainingOther: 2)
                .hasSuffix("2 loose ends are still waiting."))
    }
}

// MARK: - The model

@MainActor
private final class LooseEndsFeed {
    var snapshot: WaffledAPI.LooseEndsView
    var fetchFails = false
    var routeFails = false
    var resolveFails = false
    var parkFails = false
    var fetchCount = 0
    var routeCalls: [(sessionId: String, kind: String, id: String, title: String, source: String, to: String?)] = []
    var resolveCalls: [(kind: String, id: String, action: String, sessionId: String)] = []
    var parkCalls: [(note: String, sessionId: String)] = []
    /// What the next route call should answer with.
    var routesAfterWrite: [WaffledAPI.LooseEndRoute] = []

    init(snapshot: WaffledAPI.LooseEndsView) { self.snapshot = snapshot }
}

private func looseEnd(
    key: String, kind: String, id: String, title: String, actions: [String]
) -> WaffledAPI.LooseEnd {
    WaffledAPI.LooseEnd(
        key: key, kind: kind, id: id, title: title, emoji: nil, detail: nil, actions: actions)
}

private func looseEndsView(
    notDone: [WaffledAPI.LooseEnd],
    parked: [WaffledAPI.LooseEnd] = [],
    routes: [WaffledAPI.LooseEndRoute] = []
) -> WaffledAPI.LooseEndsView {
    WaffledAPI.LooseEndsView(
        weekStart: "2026-09-06",
        notDone: notDone,
        parked: parked,
        counts: WaffledAPI.LooseEndCounts(notDone: notDone.count, parked: parked.count),
        destinations: WaffledAPI.LooseEndDestinations(
            notDone: [
                WaffledAPI.LooseEndDestination(to: "tasks", label: "Tasks", hint: "Give it an owner and a day", primary: true),
                WaffledAPI.LooseEndDestination(to: "calendar", label: "Calendar", hint: "It needs an appointment slot", primary: nil),
            ],
            parked: [
                WaffledAPI.LooseEndDestination(to: "tasks", label: "Make it a task", hint: "Someone owns it this week", primary: true)
            ]),
        routes: routes,
        sources: ["chores", "lists"])
}

@MainActor
private func model(_ feed: LooseEndsFeed) -> PlanningLooseEndsModel {
    PlanningLooseEndsModel(
        fetchLooseEnds: { _, _ in
            feed.fetchCount += 1
            if feed.fetchFails { throw LooseEndsFailure.refused }
            return feed.snapshot
        },
        routeLooseEnd: { sessionId, kind, id, title, source, to in
            feed.routeCalls.append((sessionId, kind, id, title, source, to))
            if feed.routeFails { throw LooseEndsFailure.refused }
            return feed.routesAfterWrite
        },
        resolveLooseEnd: { kind, id, action, sessionId in
            feed.resolveCalls.append((kind, id, action, sessionId))
            if feed.resolveFails { throw LooseEndsFailure.refused }
            return WaffledAPI.LooseEndResolution(ok: true, kind: kind, id: id, action: action)
        },
        parkNote: { note, sessionId in
            feed.parkCalls.append((note, sessionId))
            if feed.parkFails { throw LooseEndsFailure.refused }
            return WaffledAPI.PlanningParkedItem(
                id: noteId, note: note, stepKey: nil, status: "open",
                sessionId: sessionId, createdAt: "2026-09-02T18:04:11.000Z")
        })
}

@MainActor
@Suite struct PlanningLooseEndsModelTests {
    private let chore = looseEnd(
        key: "chore:\(choreId)", kind: "chore", id: choreId, title: "Take the bins out",
        actions: ["done"])
    private let session = "33333333-3333-4333-8333-333333333333"

    /// ROUTING HIDES THE CARD, AND UNDO BRINGS IT BACK. Both go through the same call —
    /// undo is `to: nil` — and the server answers with the whole array either way.
    @Test func routesThenUndoes() async {
        let feed = LooseEndsFeed(snapshot: looseEndsView(notDone: [chore]))
        let m = model(feed)
        await m.load(weekStart: "2026-09-06", sessionId: session)
        #expect(m.remaining(.notDone) == 1)

        let routed = WaffledAPI.LooseEndRoute(
            kind: "chore", id: choreId, title: "Take the bins out", source: "notDone", to: "tasks")
        feed.routesAfterWrite = [routed]
        #expect(await m.send(chore, from: .notDone, to: "tasks", sessionId: session))

        #expect(feed.routeCalls.last?.to == "tasks")
        #expect(feed.routeCalls.last?.source == "notDone")
        #expect(feed.routeCalls.last?.title == "Take the bins out")
        // The deck stops asking about what it has already triaged…
        #expect(m.remaining(.notDone) == 0)
        #expect(m.trail.map(\.title) == ["Take the bins out"])
        // …and the crumb carries the CROSS-STEP CONTRACT, not just counts.
        #expect(m.decisionData["routes"] == .array([routed.json]))
        #expect(m.decisionData["left"] == .int(0))

        feed.routesAfterWrite = []
        #expect(await m.undo(routed, sessionId: session))

        // `to: nil` is the undo — an explicit null on the wire, never an omitted key.
        #expect(feed.routeCalls.count == 2)
        #expect(feed.routeCalls.last?.to == nil)
        #expect(feed.routeCalls.last?.kind == "chore")
        #expect(m.remaining(.notDone) == 1)
        #expect(m.trail.isEmpty)
        #expect(m.decisionData["routes"] == .array([]))
    }

    /// The routes seeded by the READ are what stops a reload mid-step re-asking
    /// everything already triaged.
    @Test func seedsRoutesFromTheRead() async {
        let routed = WaffledAPI.LooseEndRoute(
            kind: "chore", id: choreId, title: "Take the bins out", source: "notDone", to: "kids")
        let feed = LooseEndsFeed(snapshot: looseEndsView(notDone: [chore], routes: [routed]))
        let m = model(feed)

        await m.load(weekStart: "2026-09-06", sessionId: session)

        #expect(m.routes.count == 1)
        #expect(m.remaining(.notDone) == 0)
        #expect(m.total(.notDone) == 1)
    }

    /// THE SEED IS LOAD-BEARING. A second visit to the step starts with a fresh model, and
    /// the crumb REPLACES the step's `data` when it is answered — so a model that pushed an
    /// empty `routes` because its read failed would destroy what the first visit routed.
    @Test func seedsRoutesFromTheStepsOwnDataSoAFailedReadCannotWipeThem() async {
        let persisted = JSONValue.array([
            .object([
                "kind": .string("chore"), "id": .string(choreId),
                "title": .string("Take the bins out"), "source": .string("notDone"),
                "to": .string("tasks"),
            ])
        ])
        let feed = LooseEndsFeed(snapshot: looseEndsView(notDone: [chore]))
        feed.fetchFails = true
        let m = model(feed)

        m.seedRoutes(from: persisted)
        await m.load(weekStart: "2026-09-06", sessionId: session)

        #expect(m.routes.count == 1)
        #expect(m.routes[0].to == "tasks")
        #expect(m.routes[0].title == "Take the bins out")
        // …and so the crumb still carries the cross-step contract rather than erasing it.
        #expect(m.decisionData["routes"] == persisted)
    }

    /// A read that DID come back is authoritative — the seed never fights it.
    @Test func aSuccessfulReadOverridesTheSeed() async {
        let persisted = JSONValue.array([
            .object([
                "kind": .string("chore"), "id": .string(choreId), "title": .string("Stale"),
                "source": .string("notDone"), "to": .string("kids"),
            ])
        ])
        let feed = LooseEndsFeed(snapshot: looseEndsView(notDone: [chore], routes: []))
        let m = model(feed)

        m.seedRoutes(from: persisted)
        #expect(m.routes.count == 1)
        await m.load(weekStart: "2026-09-06", sessionId: session)

        #expect(m.routes.isEmpty)
        // Anything but an array is not a seed — the key is free-form jsonb.
        m.seedRoutes(from: .string("nonsense"))
        m.seedRoutes(from: nil)
        #expect(m.routes.isEmpty)
    }

    /// A REFUSED WRITE CHANGES NOTHING but the error line — the state it would have
    /// written is only assigned when the call returns.
    @Test func aRefusedRouteLeavesTheDeckAlone() async {
        let feed = LooseEndsFeed(snapshot: looseEndsView(notDone: [chore]))
        feed.routeFails = true
        let m = model(feed)
        await m.load(weekStart: "2026-09-06", sessionId: session)

        #expect(await m.send(chore, from: .notDone, to: "tasks", sessionId: session) == false)

        #expect(m.routes.isEmpty)
        #expect(m.remaining(.notDone) == 1)
        #expect(m.trail.isEmpty)
        #expect(m.errorMessage == LooseEndCopy.writeFailed)
        #expect(m.working == false)
    }

    /// A settled item is answered by its own module, so the step re-reads rather than
    /// removing it locally — and the tally the crumb carries counts it.
    @Test func settlingWritesThenReloads() async {
        let feed = LooseEndsFeed(snapshot: looseEndsView(notDone: [chore]))
        let m = model(feed)
        await m.load(weekStart: "2026-09-06", sessionId: session)
        feed.snapshot = looseEndsView(notDone: [])

        #expect(await m.settle(chore, action: "done", weekStart: "2026-09-06", sessionId: session))

        #expect(feed.resolveCalls.last?.action == "done")
        // The session id goes with it: settling RETIRES the item's route server-side.
        #expect(feed.resolveCalls.last?.sessionId == session)
        #expect(feed.fetchCount == 2)
        #expect(m.remaining(.notDone) == 0)
        #expect(m.decisionData["answered"] == .int(1))
    }

    /// A refused settle neither counts nor refetches.
    @Test func aRefusedSettleDoesNotCountOrRefetch() async {
        let feed = LooseEndsFeed(snapshot: looseEndsView(notDone: [chore]))
        feed.resolveFails = true
        let m = model(feed)
        await m.load(weekStart: "2026-09-06", sessionId: session)

        #expect(await m.settle(chore, action: "done", weekStart: "2026-09-06", sessionId: session) == false)

        #expect(feed.fetchCount == 1)
        #expect(m.remaining(.notDone) == 1)
        #expect(m.decisionData["answered"] == .int(0))
        #expect(m.errorMessage == LooseEndCopy.writeFailed)
    }

    /// "Leave it open" writes NOTHING ANYWHERE — no call, no row, just this screen.
    @Test func leavingItOpenTouchesNoEndpoint() async {
        let feed = LooseEndsFeed(snapshot: looseEndsView(notDone: [chore]))
        let m = model(feed)
        await m.load(weekStart: "2026-09-06", sessionId: session)

        m.leave(chore)

        #expect(m.remaining(.notDone) == 0)
        #expect(feed.routeCalls.isEmpty)
        #expect(feed.resolveCalls.isEmpty)
        // …and a new week starts the aside list again.
        m.resetForWeek()
        #expect(m.remaining(.notDone) == 1)
    }

    /// The capture bar parks a note and re-reads, so the new note joins group B.
    @Test func parkingAddsToTheBoard() async {
        let feed = LooseEndsFeed(snapshot: looseEndsView(notDone: []))
        let m = model(feed)
        await m.load(weekStart: "2026-09-06", sessionId: session)
        feed.snapshot = looseEndsView(
            notDone: [],
            parked: [looseEnd(key: "parked:\(noteId)", kind: "parked", id: noteId,
                              title: "Ask about the school trip", actions: ["done", "drop"])])

        #expect(await m.park("  Ask about the school trip  ", weekStart: "2026-09-06", sessionId: session))

        // Trimmed before it goes out; blank input never leaves the device.
        #expect(feed.parkCalls.last?.note == "Ask about the school trip")
        #expect(m.remaining(.parked) == 1)
        #expect(await m.park("   ", weekStart: "2026-09-06", sessionId: session) == false)
        #expect(feed.parkCalls.count == 1)
    }

    /// A failed refresh keeps the last good read and still counts as loaded — the shared
    /// REST loading contract, so a dropped connection never blanks the deck.
    @Test func aFailedRefreshKeepsTheLastRead() async {
        let feed = LooseEndsFeed(snapshot: looseEndsView(notDone: [chore]))
        let m = model(feed)
        await m.load(weekStart: "2026-09-06", sessionId: session)
        feed.fetchFails = true

        await m.load(weekStart: "2026-09-06", sessionId: session)

        #expect(m.loaded)
        #expect(m.remaining(.notDone) == 1)
        #expect(m.view?.weekStart == "2026-09-06")
    }

    /// A first load that fails leaves nothing to show — but it is LOADED, so the step
    /// renders its "couldn't read" state rather than a spinner forever.
    @Test func aFirstLoadThatFailsIsStillLoaded() async {
        let feed = LooseEndsFeed(snapshot: looseEndsView(notDone: [chore]))
        feed.fetchFails = true
        let m = model(feed)

        await m.load(weekStart: "2026-09-06", sessionId: session)

        #expect(m.loaded)
        #expect(m.view == nil)
    }

    /// The trail names the STEP, and always with the notDone label — "Parked"'s own
    /// labels are verbs ("Make it a task"), which read wrong after an arrow.
    @Test func theTrailNamesTheStepNotTheVerb() async {
        let feed = LooseEndsFeed(snapshot: looseEndsView(notDone: [chore]))
        let m = model(feed)
        await m.load(weekStart: "2026-09-06", sessionId: session)

        #expect(m.stepName("tasks") == "Tasks")
        // A route can outlive a module toggle, so an unknown destination falls back to its
        // key rather than rendering blank.
        #expect(m.stepName("meals") == "meals")
    }

    /// Only the last three, most recent first — and only the newest one is undoable.
    @Test func theTrailKeepsTheLastThreeMostRecentFirst() async {
        let feed = LooseEndsFeed(snapshot: looseEndsView(notDone: []))
        let m = model(feed)
        let ids = ["a", "b", "c", "d"]
        feed.snapshot = looseEndsView(
            notDone: [],
            routes: ids.map {
                WaffledAPI.LooseEndRoute(kind: "chore", id: $0, title: $0, source: "notDone", to: "tasks")
            })

        await m.load(weekStart: "2026-09-06", sessionId: session)

        #expect(m.trail.map(\.title) == ["d", "c", "b"])
    }
}

// MARK: - What arrives at the destination step

/// WHAT THE BOX AT THE TOP OF A DESTINATION STEP HOLDS.
///
/// Two different mechanisms put work in front of a later step, and for a while they landed
/// in two different places: a PARKED NOTE came down through `step.parked` and was drawn by
/// the shell's banner at the TOP, while a ROUTED LOOSE END came down through step 1's own
/// `data.routes` and was drawn by the step body itself, in a section at the BOTTOM. It was
/// reported exactly that way — "wouldn't these be in the top 'parked things' box? why are
/// they hidden at the bottom?"
///
/// They share one box now, and this is the rule for what goes in its routed half.
@Suite struct PlanningSentHereTests {

    private let parkedId = "33333333-3333-4333-8333-333333333333"

    @Test func onlyTheRoutesAddressedToThisStep() {
        let routes = [
            route(kind: "chore", id: "c1", title: "Bins", to: "calendar"),
            route(kind: "list", id: "l1", title: "Pack the tent", to: "calendar"),
            route(kind: "goal", id: "g1", title: "Run a 5k", to: "goals"),
        ]

        #expect(
            PlanningRouteSeed.sentHere(to: "calendar", in: routes, parked: nil, settled: []).map(\.id)
                == ["c1", "l1"])
        #expect(
            PlanningRouteSeed.sentHere(to: "goals", in: routes, parked: nil, settled: []).map(\.id)
                == ["g1"])
        #expect(PlanningRouteSeed.sentHere(to: "meals", in: routes, parked: nil, settled: []).isEmpty)
    }

    /// THE DOUBLE-SHOW THIS PREVENTS. Routing a PARKED note also sets its
    /// `planning_parked_items.step_key` (`routeLooseEnd` in `looseEnds.ts` — "the other half
    /// of what that column is for"), so the very same note comes back on the destination
    /// step through BOTH doors: as a `parked` handoff and as a `parked`-kind route. The
    /// handoff is the richer of the two — it can be handled or dropped — so the route row
    /// for it is suppressed.
    @Test func aParkedNoteRoutedHereIsNotOfferedTwice() {
        let routes = [
            route(kind: "parked", id: parkedId, title: "Ask about the school trip", to: "calendar"),
            route(kind: "chore", id: "c1", title: "Bins", to: "calendar"),
        ]
        let parked = [WaffledAPI.PlanningStepHandoff(
            id: parkedId, note: "Ask about the school trip", byline: "Kevin · today")]

        #expect(
            PlanningRouteSeed.sentHere(to: "calendar", in: routes, parked: parked, settled: []).map(\.id)
                == ["c1"])
    }

    /// …but the note has to actually BE in the box. `parkedByStep` caps the handoff list at
    /// six, and a note that fell off that cap (or had its tag cleared) is not on screen —
    /// dropping its route row too would lose it entirely, which is the bug this whole box
    /// exists to fix.
    @Test func aParkedRouteWithNoNoteOnScreenIsStillOffered() {
        let routes = [
            route(kind: "parked", id: parkedId, title: "Ask about the school trip", to: "calendar"),
        ]
        let someoneElse = [WaffledAPI.PlanningStepHandoff(id: "other", note: "Buy stamps", byline: nil)]

        #expect(
            PlanningRouteSeed.sentHere(to: "calendar", in: routes, parked: nil, settled: []).map(\.id)
                == [parkedId])
        #expect(
            PlanningRouteSeed.sentHere(to: "calendar", in: routes, parked: someoneElse, settled: []).map(\.id)
                == [parkedId])
    }

    /// The Kids step's own read already merges what step 1 sent it into its board
    /// (`kids.ts` marks those options `routed` and sorts them first), so the shared box
    /// stays out of its way rather than printing the same chore twice on one screen.
    /// `looseEnds` is the same argument from the other end: step 1 draws the whole board
    /// and its own undo trail. (The server refuses that route anyway — belt and braces.)
    @Test func stepsThatDrawTheirOwnRoutedRowsAreLeftAlone() {
        let routes = [
            route(kind: "chore", id: "c1", title: "Bins", to: "kids"),
            route(kind: "chore", id: "c2", title: "Homework", to: "looseEnds"),
        ]

        #expect(PlanningRouteSeed.sentHere(to: "kids", in: routes, parked: nil, settled: []).isEmpty)
        #expect(PlanningRouteSeed.sentHere(to: "looseEnds", in: routes, parked: nil, settled: []).isEmpty)
    }

    /// The offer goes away once it has been taken, so nobody makes the same event twice.
    /// Keyed `kind:id` rather than by title, because two loose ends can read the same.
    @Test func aRouteAlreadyActedOnStopsBeingOffered() {
        let routes = [
            route(kind: "chore", id: "c1", title: "Bins", to: "calendar"),
            route(kind: "list", id: "l1", title: "Pack the tent", to: "calendar"),
        ]

        #expect(PlanningRouteSeed.key(routes[0]) == "chore:c1")
        #expect(
            PlanningRouteSeed.sentHere(
                to: "calendar", in: routes, parked: nil,
                settled: [PlanningRouteSeed.key(routes[0])]).map(\.id)
                == ["l1"])
    }

    /// Nothing routed here is the NORMAL case, and it has to leave the box empty rather
    /// than draw a heading over nothing.
    @Test func nothingRoutedHereIsTheNormalCase() {
        #expect(PlanningRouteSeed.sentHere(to: "calendar", in: [], parked: nil, settled: []).isEmpty)
        #expect(
            PlanningRouteSeed.sentHere(
                to: "calendar",
                in: [route(kind: "chore", id: "c1", title: "Bins", to: "tasks")],
                parked: nil, settled: []).isEmpty)
    }

    /// A row written by an older build can be missing `title`/`source` — the server's own
    /// guard on this column checks only `kind`/`id`/`to` — and one unreadable row must cost
    /// that row and nothing else. Absent, null and "not an array" all just mean step 1
    /// hasn't routed anything.
    @Test func theRoutesAreDecodedTolerantly() {
        let decoded = PlanningRouteSeed.decode(.array([
            .object([
                "kind": .string("chore"), "id": .string("c1"), "title": .string("Bins"),
                "source": .string("notDone"), "to": .string("calendar"),
            ]),
            .object(["kind": .string("parked"), "id": .string("p1"), "to": .string("calendar")]),
            .string("nonsense"),
        ]))

        #expect(decoded.map(\.id) == ["c1", "p1"])
        #expect(decoded.last?.title == "")
        #expect(decoded.last?.source == "parked")

        #expect(PlanningRouteSeed.decode(nil).isEmpty)
        #expect(PlanningRouteSeed.decode(.null).isEmpty)
        #expect(PlanningRouteSeed.decode(.object(["routes": .string("not an array")])).isEmpty)
    }

    private func route(kind: String, id: String, title: String, to: String) -> WaffledAPI.LooseEndRoute {
        WaffledAPI.LooseEndRoute(kind: kind, id: id, title: title, source: "notDone", to: to)
    }
}
