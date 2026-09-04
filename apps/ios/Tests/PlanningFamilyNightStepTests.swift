import Foundation
import Testing
@testable import Waffled

// Weekly Planning · step 4 (Family night).
//
// THE PRESENCE TESTS ARE THE POINT OF THIS FILE. The familyNight occurrence endpoint
// reads whether a KEY WAS SENT, not its value, so "clear the theme" and "leave the theme
// alone" are two different bodies for the same field — and a detail-only write that also
// carries `personId` un-assigns whoever had that part. `assertKeys` asserts the exact key
// SET rather than one key's absence, so a later tidy-up that adds `personId: null` "for
// symmetry" fails here instead of in front of a family on a Wednesday evening.
//
// The rest mirrors `FamilyNightModelTests`: a fake feed, and the loading contract
// (a failed fetch keeps the last board; a failed write neither refetches nor mutates).

private enum PlanningFamilyNightFailure: Error { case rejected }

// MARK: - Reading a body

/// The object inside `assignments[i]`. EMPTY when the body isn't shaped like that at all
/// — which fails the key-set assertion below, and keeps every lookup a SINGLE optional.
/// (Returning `[String: JSONValue]?` would make `fields?["personId"] == nil` compare the
/// OUTER optional, so the presence test would pass for entirely the wrong reason.)
private func assignment(_ body: [String: JSONValue], _ index: Int = 0) -> [String: JSONValue] {
    guard case let .array(items)? = body["assignments"], index < items.count,
          case let .object(fields) = items[index] else { return [:] }
    return fields
}

/// Assert a dictionary's key set EXACTLY. The whole contract is which keys are present.
private func assertKeys(_ fields: [String: JSONValue], _ expected: Set<String>,
                        _ what: String, sourceLocation: SourceLocation = #_sourceLocation) {
    #expect(Set(fields.keys) == expected, "\(what) sent \(Set(fields.keys).sorted())",
            sourceLocation: sourceLocation)
}

// MARK: - The board, VERBATIM off the wire
//
// Field-for-field what `getFamilyNightBoard` returns and what
// `apps/api/test/weekly-planning-familyNight.integration.test.ts` asserts against: the
// fixture household ([Kevin, Kelly, Wally, Lottie], the three default parts), with the
// treat pinned and holding a detail, and the check-in on rotation.
private let boardJSON = Data("""
{
  "weekStart": "2026-09-06",
  "date": "2026-09-09",
  "dayOfWeek": 3,
  "time": "17:00",
  "occurrenceId": "5c1f0a2e-0000-4000-8000-000000000001",
  "theme": "pizza and the new Lego set",
  "status": "planned",
  "onCalendar": true,
  "eventId": "5c1f0a2e-0000-4000-8000-000000000002",
  "eventTitle": "Family Night",
  "eventWhen": "Wednesday 5:00 PM",
  "members": [
    { "id": "p-kevin", "name": "Kevin", "avatarEmoji": null, "colorHex": null },
    { "id": "p-kelly", "name": "Kelly", "avatarEmoji": "🦊", "colorHex": "#E0653F" },
    { "id": "p-wally", "name": "Wally", "avatarEmoji": "🐢", "colorHex": "#25A368" },
    { "id": "p-lottie", "name": "Lottie", "avatarEmoji": "🦄", "colorHex": "#7A5AF8" }
  ],
  "parts": [
    { "partId": "activity", "label": "Activity", "emoji": "🎲", "rotates": true,
      "detail": null, "personId": "p-kevin", "personName": "Kevin", "pinned": false },
    { "partId": "treat", "label": "Treat", "emoji": "🍨", "rotates": true,
      "detail": "the good ice cream", "personId": "p-lottie", "personName": "Lottie", "pinned": true },
    { "partId": "checkin", "label": "Check-in", "emoji": "💬", "rotates": false,
      "detail": null, "personId": null, "personName": null, "pinned": false }
  ]
}
""".utf8)

private func decodedBoard() throws -> WaffledAPI.PlanningFamilyNightBoard {
    try WaffledAPI.decoder.decode(WaffledAPI.PlanningFamilyNightBoard.self, from: boardJSON)
}

// MARK: - The feed

@MainActor
private final class FamilyNightBoardFeed {
    var board: WaffledAPI.PlanningFamilyNightBoard
    var fetchFails = false
    var saveFails = false
    var fetchCount = 0
    var bodies: [[String: JSONValue]] = []

    init(_ board: WaffledAPI.PlanningFamilyNightBoard) { self.board = board }
}

@MainActor
private func model(_ feed: FamilyNightBoardFeed) -> PlanningFamilyNightModel {
    PlanningFamilyNightModel(
        fetchBoard: { _ in
            feed.fetchCount += 1
            if feed.fetchFails { throw PlanningFamilyNightFailure.rejected }
            return feed.board
        },
        saveOccurrence: { body in
            feed.bodies.append(body)
            if feed.saveFails { throw PlanningFamilyNightFailure.rejected }
        },
        fetchWeekEvents: { _, _ in [] })
}

// MARK: - Tests

@MainActor
@Suite struct PlanningFamilyNightStepTests {

    // ── The presence rules ───────────────────────────────────────────────────────

    @Test func detailWriteCarriesNoPersonKey() {
        let body = PlanningFamilyNightBody.setDetail(date: "2026-09-09", partId: "treat",
                                                     detail: "the good ice cream")
        assertKeys(body, ["date", "assignments"], "the detail body")
        // THE ONE THAT MATTERS. The server reads presence, so `personId: null` here would
        // mean "…and nobody has the treat" and would un-pin whoever does. Not "personId
        // is null" — personId must not be in the dictionary AT ALL.
        assertKeys(assignment(body), ["partId", "detail"], "the detail assignment")
        #expect(!assignment(body).keys.contains("personId"),
                "personId must not be in a detail body AT ALL — not even as null")
        #expect(assignment(body)["detail"] == JSONValue.string("the good ice cream"))
    }

    @Test func detailWriteClearsWithAnEmptyStringRatherThanAMissingKey() {
        let body = PlanningFamilyNightBody.setDetail(date: "2026-09-09", partId: "treat", detail: "")
        // '' CLEARS. An absent `detail` key would mean "leave whatever is there", which is
        // how a cleared box quietly keeps its old text.
        assertKeys(assignment(body), ["partId", "detail"], "the cleared detail assignment")
        #expect(assignment(body)["detail"] == JSONValue.string(""))
    }

    @Test func pinAlwaysCarriesAPersonKey() {
        let body = PlanningFamilyNightBody.pin(date: "2026-09-09", partId: "treat", personId: "p-wally")
        assertKeys(assignment(body), ["partId", "personId"], "the pin assignment")
        #expect(assignment(body)["personId"] == JSONValue.string("p-wally"))
        // Never carries `detail`: pinning a face must not wipe what the part is.
        #expect(!assignment(body).keys.contains("detail"))
    }

    @Test func pinningNobodyWritesARealNobodyYetRatherThanOmittingTheKey() {
        let body = PlanningFamilyNightBody.pin(date: "2026-09-09", partId: "treat", personId: nil)
        assertKeys(assignment(body), ["partId", "personId"], "the nobody-yet assignment")
        // There is deliberately no un-pin: the module's upsert can write an assignment but
        // never delete one, so this is "nobody yet", not "back on rotation".
        #expect(assignment(body)["personId"] == JSONValue.null)
    }

    @Test func themeClearsWithAnEmptyStringAndNeverWithAMissingKey() {
        assertKeys(PlanningFamilyNightBody.setTheme(date: "2026-09-09", theme: ""),
                   ["date", "theme"], "the cleared theme body")
        #expect(PlanningFamilyNightBody.setTheme(date: "2026-09-09", theme: "")["theme"] == JSONValue.string(""))
        #expect(PlanningFamilyNightBody.setTheme(date: "2026-09-09", theme: "movie night")["theme"]
                == JSONValue.string("movie night"))
    }

    @Test func statusBodyIsUndoableBothWays() {
        for status in ["skipped", "planned"] {
            let body = PlanningFamilyNightBody.setStatus(date: "2026-09-09", status: status)
            assertKeys(body, ["date", "status"], "the \(status) body")
            #expect(body["status"] == JSONValue.string(status))
        }
    }

    @Test func unlinkingSendsAnExplicitNullSoTheEventItselfSurvives() {
        let body = PlanningFamilyNightBody.linkEvent(date: "2026-09-09", eventId: nil)
        assertKeys(body, ["date", "eventId"], "the unlink body")
        // An absent key means "leave the link alone", so `null` is the only way to say
        // "this isn't family night after all" — and it never deletes Friday.
        #expect(body["eventId"] == JSONValue.null)
    }

    @Test func addToCalendarAsksTheSERVERToMakeTheEvent() {
        let body = PlanningFamilyNightBody.addEvent(date: "2026-09-09")
        // Not a create-then-adopt round trip: a client-made event may have no server id
        // yet, so the link would 404 on an unreproducible race.
        assertKeys(body, ["date", "createEvent"], "the add-to-calendar body")
        #expect(body["createEvent"] == JSONValue.bool(true))
        #expect(body["eventId"] == nil)
    }

    // ── Decoding ────────────────────────────────────────────────────────────────

    @Test func decodesTheBoardVerbatimOffTheWire() throws {
        let board = try decodedBoard()
        #expect(board.weekStart == "2026-09-06")
        #expect(board.date == "2026-09-09")
        #expect(board.dayOfWeek == 3)
        #expect(board.time == "17:00")
        #expect(board.status == "planned")
        #expect(!board.isSkipped)
        // `onCalendar` (the standing series) and `eventId` (this week's own event) are
        // different facts, and the step has to keep them apart.
        #expect(board.onCalendar)
        #expect(board.eventTitle == "Family Night")
        #expect(board.eventWhen == "Wednesday 5:00 PM")
        #expect(board.members.count == 4)
        #expect(board.members[0].avatarEmoji == nil)
        #expect(board.members[1].colorHex == "#E0653F")
        #expect(board.parts.map(\.partId) == ["activity", "treat", "checkin"])
        // Pinned vs suggested is the screen's whole job.
        #expect(board.parts[0].pinned == false)
        #expect(board.parts[1].pinned == true)
        #expect(board.parts[1].detail == "the good ice cream")
        // A detail with no person on a non-rotating part still reads as nobody yet.
        #expect(board.parts[2].rotates == false)
        #expect(board.parts[2].personName == nil)
    }

    // ── The lines the rows read ─────────────────────────────────────────────────

    @Test func theSublineTellsASuggestionApartFromADecision() throws {
        let board = try decodedBoard()
        #expect(PlanningFamilyNightFormat.suggestion(board.parts[0])
                == "suggested · Kevin, next in the rotation")
        #expect(PlanningFamilyNightFormat.suggestion(board.parts[1])
                == "pinned for this week · Lottie")
        #expect(PlanningFamilyNightFormat.suggestion(board.parts[2]) == "nobody yet")
    }

    @Test func detailHintsFallBackToThePartsOwnLabel() throws {
        let board = try decodedBoard()
        // THE THREE STOCK PARTS GET A CONCRETE EXAMPLE. "optional — what's the treat?"
        // asks the question back at you; "the good ice cream" shows what an answer looks
        // like, which is the whole job of a placeholder.
        #expect(PlanningFamilyNightFormat.detailHint(board.parts[0]).contains("charades"))
        #expect(PlanningFamilyNightFormat.detailHint(board.parts[1]).contains("good ice cream"))
        #expect(PlanningFamilyNightFormat.detailHint(board.parts[2]).contains("how was school"))

        // A part this build has never heard of — a household that renames its parts, or a
        // server that grows a fourth — gets a question built from its OWN label rather
        // than one of the three canned examples or an empty box. (This assertion used to
        // name `parts[2]`, which is `checkin` and therefore stock: it was asserting the
        // fallback against a part that never reaches it.)
        let custom = try #require(try? WaffledAPI.decoder.decode(
            WaffledAPI.PlanningFamilyNightPart.self,
            from: Data(#"{"partId":"service","label":"Service","emoji":"🤝","rotates":true,"detail":null,"personId":null,"personName":null,"pinned":false}"#.utf8)))
        #expect(PlanningFamilyNightFormat.detailHint(custom) == "optional — what's the service?")
    }

    @Test func theEventPickersWeekIsSteppedInWholeDaysOffTheServersBoundary() {
        #expect(PlanningFamilyNightFormat.plusDays("2026-09-06", 6) == "2026-09-12")
        // Across a US DST boundary (2026-11-01): a date is a label, not an instant.
        #expect(PlanningFamilyNightFormat.plusDays("2026-10-29", 6) == "2026-11-04")
    }

    // ── The loading contract ────────────────────────────────────────────────────

    @Test func aFailedReadKeepsTheBoardThatWasAlreadyOnScreen() async throws {
        let feed = FamilyNightBoardFeed(try decodedBoard())
        let model = model(feed)
        await model.load(weekStart: "2026-09-06")
        feed.fetchFails = true

        await model.load(weekStart: "2026-09-06")

        #expect(model.board?.theme == "pizza and the new Lego set")
        #expect(model.loaded)
    }

    @Test func aFailedWriteNeitherRefetchesNorMutates() async throws {
        let feed = FamilyNightBoardFeed(try decodedBoard())
        feed.saveFails = true
        let model = model(feed)
        await model.load(weekStart: "2026-09-06")
        let revBefore = model.rev

        let ok = await model.write(
            PlanningFamilyNightBody.setStatus(date: "2026-09-09", status: "skipped"),
            weekStart: "2026-09-06")

        #expect(!ok)
        #expect(feed.bodies.count == 1)
        #expect(feed.fetchCount == 1)          // the initial load only
        #expect(model.rev == revBefore)
        #expect(model.board?.status == "planned")
        #expect(model.errorMessage != nil)
    }

    @Test func aWriteThatLandsRereadsRatherThanPatchingLocally() async throws {
        let feed = FamilyNightBoardFeed(try decodedBoard())
        let model = model(feed)
        await model.load(weekStart: "2026-09-06")

        let ok = await model.write(
            PlanningFamilyNightBody.pin(date: "2026-09-09", partId: "activity", personId: "p-wally"),
            weekStart: "2026-09-06")

        #expect(ok)
        // The SERVER owns which parts are on rotation, so the board comes back from it.
        #expect(feed.fetchCount == 2)
        #expect(feed.bodies.count == 1)
        #expect(model.rows.count == 3)
        #expect(model.recurrence == "every Wednesday")
    }

    // ── The crumb ───────────────────────────────────────────────────────────────

    @Test func theCrumbRecordsWhatWasDecidedAndNotACopyOfTheModule() throws {
        let crumb = PlanningFamilyNightDecision.crumb(try decodedBoard())
        // Web parity, verbatim: both platforms write the same session-step record and the
        // recap reads back whatever either one wrote.
        #expect(Set(crumb.keys) == ["pinned", "skipped"])
        #expect(crumb["pinned"] == JSONValue.array([.string("treat")]))
        #expect(crumb["skipped"] == JSONValue.bool(false))
        // No theme, no person names, no dates — the recap reads those through to the
        // familyNight module itself.
    }

    @Test func theCrumbIsEmptyButWellFormedBeforeAnythingIsRead() {
        let crumb = PlanningFamilyNightDecision.crumb(nil)
        #expect(crumb["pinned"] == JSONValue.array([]))
        #expect(crumb["skipped"] == JSONValue.bool(false))
    }
}
