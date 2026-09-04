import Foundation
import Testing
@testable import Waffled

// Weekly Planning · step 7 (Meals).
//
// FOUR THINGS HERE ARE WORTH MORE THAN THE REST:
//
//  1. THE THREE-WAY `cards`. Absent means "server, draft it"; a real array means "apply
//     the week we approved"; anything else present means "write nothing". So the body must
//     OMIT THE KEY — not send a null — and the test has to fail if anybody ever writes
//     `body["cards"] = cards.map(…) ?? .null`, because that silently turns the one AI
//     button into a no-op that still reports success.
//  2. THE UNDO KEEPS A NIGHT DECIDED SINCE. `kept` is not a failure: the night leaves the
//     undoable set WITHOUT being cleared, keeps whatever somebody put there, and the copy
//     names it.
//  3. THE SHOPPER RULE. Handing the trip to somebody else is `chore.manage`; putting it on
//     yourself or leaving it up for grabs is not. And a refused write must not mutate
//     anything or refetch.
//  4. THE FILLED-NIGHT RECEIPT ROUND-TRIPS `mealId`. It is the only dimension that tells a
//     night filled with the title "BBQ Sunday" from a night since hand-changed to the
//     PLATE of that name — drop it and the undo clears somebody's decision.

private enum MealsStepFailure: Error { case rejected }

// MARK: - The week, VERBATIM off the wire
//
// Field-for-field what `mealsStepView` returns and what
// `apps/api/test/weekly-planning-meals.integration.test.ts` drives: the household plans
// the week of Sunday 2026-09-06; four nights are already decided (a recipe with a real
// cook, a recipe without one, "Leftovers" and "Eating out") and three are empty; the empty
// Wednesday carries a real event, while the Sunday's meal-plan MIRROR event is absent
// because the server filters `origin in ('meal_plan','meal_prep')` out of the context.

private let weekNights = """
[
  { "date": "2026-09-06", "events": [],
    "dinner": { "entryId": "e-sun", "title": "Pasta bake", "emoji": null, "recipeId": "r-pasta",
                "mealId": null, "imageUrl": null, "cookName": "Kevin", "cookAvatar": null,
                "cookColor": null, "minutes": null } },
  { "date": "2026-09-07", "events": [],
    "dinner": { "entryId": "e-mon", "title": "Fish tacos", "emoji": null, "recipeId": "r-tacos",
                "mealId": null, "imageUrl": null, "cookName": null, "cookAvatar": null,
                "cookColor": null, "minutes": null } },
  { "date": "2026-09-08", "events": [],
    "dinner": { "entryId": "e-tue", "title": "Leftovers", "emoji": null, "recipeId": null,
                "mealId": null, "imageUrl": null, "cookName": null, "cookAvatar": null,
                "cookColor": null, "minutes": null } },
  { "date": "2026-09-09",
    "events": [
      { "id": "ev-soccer", "title": "Soccer practice", "startsAt": "2026-09-09T22:30:00.000Z",
        "allDay": false, "personId": "p-lottie", "personName": "Lottie",
        "personColor": "#7A5AF8", "participantIds": [] }
    ],
    "dinner": null },
  { "date": "2026-09-10", "events": [],
    "dinner": { "entryId": "e-thu", "title": "Eating out", "emoji": null, "recipeId": null,
                "mealId": null, "imageUrl": null, "cookName": null, "cookAvatar": null,
                "cookColor": null, "minutes": null } },
  { "date": "2026-09-11", "events": [], "dinner": null },
  { "date": "2026-09-12", "events": [], "dinner": null }
]
"""

private let weekJSON = Data("""
{
  "weekStart": "2026-09-06",
  "nights": \(weekNights),
  "emptyDates": ["2026-09-09", "2026-09-11", "2026-09-12"],
  "groceries": { "items": 9, "checked": 2 },
  "choresOn": true,
  "shopping": null
}
""".utf8)

/// The trip, read back off a REAL one-off chore — which is why it carries a `choreId` the
/// client hands back on every later read and write.
private let tripJSON = """
{ "choreId": "c-groceries", "personId": "p-kevin", "personName": "Kevin", "personAvatar": "🧢",
  "personColor": "#EC6049", "dueOn": "2026-09-12", "dueTime": "09:00", "status": "pending" }
"""

/// `PUT /shopper`'s answer: the trip, plus the whole week again — the plan is unchanged, but
/// the server still re-reads and returns it, so the client never has to merge.
private let shopperJSON = Data("""
{
  "weekStart": "2026-09-06",
  "shopping": \(tripJSON),
  "view": {
    "weekStart": "2026-09-06",
    "nights": \(weekNights),
    "emptyDates": ["2026-09-09", "2026-09-11", "2026-09-12"],
    "groceries": { "items": 9, "checked": 2 },
    "choresOn": true,
    "shopping": \(tripJSON)
  }
}
""".utf8)

/// The same week after a fill: the three empties now carry drafted dishes, and the grocery
/// line has moved with the plan (9 → 14, which is what makes "5 items added" MEASURED
/// rather than claimed).
private let filledWeekJSON = """
{
  "weekStart": "2026-09-06",
  "nights": [
    { "date": "2026-09-06", "events": [],
      "dinner": { "entryId": "e-sun", "title": "Pasta bake", "recipeId": "r-pasta", "mealId": null,
                  "cookName": "Kevin", "minutes": null } },
    { "date": "2026-09-07", "events": [],
      "dinner": { "entryId": "e-mon", "title": "Fish tacos", "recipeId": "r-tacos", "mealId": null } },
    { "date": "2026-09-08", "events": [],
      "dinner": { "entryId": "e-tue", "title": "Leftovers", "recipeId": null, "mealId": null } },
    { "date": "2026-09-09", "events": [],
      "dinner": { "entryId": "e-wed", "title": "Chili", "recipeId": "r-chili", "mealId": null } },
    { "date": "2026-09-10", "events": [],
      "dinner": { "entryId": "e-thu", "title": "Eating out", "recipeId": null, "mealId": null } },
    { "date": "2026-09-11", "events": [],
      "dinner": { "entryId": "e-fri", "title": "Stir fry", "recipeId": "r-stir", "mealId": null } },
    { "date": "2026-09-12", "events": [],
      "dinner": { "entryId": "e-sat", "title": "Soup", "recipeId": "r-soup", "mealId": null } }
  ],
  "emptyDates": [],
  "groceries": { "items": 14, "checked": 2 },
  "choresOn": true,
  "shopping": null
}
"""

/// What the fill wrote — the receipt, `mealId` null on every claim because a fill writes
/// recipes and titles, never plates.
private let fillJSON = Data("""
{
  "weekStart": "2026-09-06",
  "filled": [
    { "date": "2026-09-09", "entryId": "e-wed", "recipeId": "r-chili", "mealId": null, "title": null },
    { "date": "2026-09-11", "entryId": "e-fri", "recipeId": "r-stir", "mealId": null, "title": null },
    { "date": "2026-09-12", "entryId": "e-sat", "recipeId": "r-soup", "mealId": null, "title": null }
  ],
  "view": \(filledWeekJSON)
}
""".utf8)

/// The undo that hit a night somebody decided since: two cleared, ONE KEPT — and the kept
/// night comes back still carrying what they put there ("Grandma's").
private let undoJSON = Data("""
{
  "weekStart": "2026-09-06",
  "cleared": ["2026-09-09", "2026-09-12"],
  "kept": ["2026-09-11"],
  "view": {
    "weekStart": "2026-09-06",
    "nights": [
      { "date": "2026-09-06", "events": [], "dinner": { "entryId": "e-sun", "title": "Pasta bake", "recipeId": "r-pasta" } },
      { "date": "2026-09-07", "events": [], "dinner": { "entryId": "e-mon", "title": "Fish tacos", "recipeId": "r-tacos" } },
      { "date": "2026-09-08", "events": [], "dinner": { "entryId": "e-tue", "title": "Leftovers", "recipeId": null } },
      { "date": "2026-09-09", "events": [], "dinner": null },
      { "date": "2026-09-10", "events": [], "dinner": { "entryId": "e-thu", "title": "Eating out", "recipeId": null } },
      { "date": "2026-09-11", "events": [], "dinner": { "entryId": "e-fri", "title": "Grandma’s", "recipeId": null } },
      { "date": "2026-09-12", "events": [], "dinner": null }
    ],
    "emptyDates": ["2026-09-09", "2026-09-12"],
    "groceries": { "items": 11, "checked": 2 },
    "choresOn": true,
    "shopping": null
  }
}
""".utf8)

/// A night that is a PLATE: recipe-less, carrying a `mealId`, with the plate's NAME as its
/// title — and the plate is deliberately called something a takeout classifier would bite
/// on, because that is the bug the plate branch exists to stop.
private let plateNightJSON = Data("""
{ "date": "2026-09-09", "events": [],
  "dinner": { "entryId": "e-wed", "title": "Takeout Tuesday", "emoji": null, "recipeId": null,
              "mealId": "m-copy-1", "imageUrl": null, "cookName": null, "cookAvatar": null,
              "cookColor": null, "minutes": null } }
""".utf8)

private func decodedWeek() throws -> WaffledAPI.PlanningMealsView {
    try WaffledAPI.decoder.decode(WaffledAPI.PlanningMealsView.self, from: weekJSON)
}

// MARK: - The feed

@MainActor
private final class MealsFeed {
    var view: WaffledAPI.PlanningMealsView
    var fillResult: WaffledAPI.PlanningMealsFill
    var undoResult: WaffledAPI.PlanningMealsUndo
    var shopperResult: WaffledAPI.PlanningMealsShopperResult

    var fetchFails = false
    var fillFails = false
    var undoFails = false
    var shopperForbidden = false
    var shopperFails = false
    /// Park the fill mid-flight, so "one write at a time" can be asserted deterministically
    /// rather than by racing two tasks and hoping they interleave.
    var holdFill = false
    var fillGate: CheckedContinuation<Void, Never>?

    var fetchCount = 0
    var fillBodies: [[String: JSONValue]] = []
    var undoBodies: [[String: JSONValue]] = []
    var shopperCalls: [(weekStart: String, dueOn: String?, personId: String?, dueTime: String?, choreId: String?)] = []
    var plannedSlots: [(date: String, recipeId: String?, title: String?)] = []
    var clearedSlots: [String] = []

    init() throws {
        view = try WaffledAPI.decoder.decode(WaffledAPI.PlanningMealsView.self, from: weekJSON)
        fillResult = try WaffledAPI.decoder.decode(WaffledAPI.PlanningMealsFill.self, from: fillJSON)
        undoResult = try WaffledAPI.decoder.decode(WaffledAPI.PlanningMealsUndo.self, from: undoJSON)
        shopperResult = try WaffledAPI.decoder.decode(
            WaffledAPI.PlanningMealsShopperResult.self, from: shopperJSON)
    }
}

@MainActor
private func model(_ feed: MealsFeed) -> PlanningMealsModel {
    PlanningMealsModel(
        fetchView: { _, _ in
            feed.fetchCount += 1
            if feed.fetchFails { throw MealsStepFailure.rejected }
            return feed.view
        },
        fill: { weekStart, cards in
            // Recorded as the BODY, not as the arguments: the encoding is the thing that
            // can be wrong, and it is what the server actually reads.
            feed.fillBodies.append(PlanningMealsWire.fillBody(weekStart: weekStart, cards: cards))
            if feed.holdFill {
                await withCheckedContinuation { feed.fillGate = $0 }
            }
            if feed.fillFails { throw MealsStepFailure.rejected }
            feed.view = feed.fillResult.view
            return feed.fillResult
        },
        undo: { weekStart, filled in
            feed.undoBodies.append(PlanningMealsWire.undoBody(weekStart: weekStart, filled: filled))
            if feed.undoFails { throw MealsStepFailure.rejected }
            feed.view = feed.undoResult.view
            return feed.undoResult
        },
        setShopper: { weekStart, dueOn, personId, dueTime, choreId in
            feed.shopperCalls.append((weekStart, dueOn, personId, dueTime, choreId))
            if feed.shopperForbidden { throw WaffledAPI.APIError.http(403, "Forbidden") }
            if feed.shopperFails { throw MealsStepFailure.rejected }
            feed.view = feed.shopperResult.view
            return feed.shopperResult
        },
        planSlot: { date, recipeId, title in
            feed.plannedSlots.append((date, recipeId, title))
        },
        planPlate: { date, _ in
            feed.plannedSlots.append((date, nil, "plate"))
        },
        clearSlot: { date in
            feed.clearedSlots.append(date)
        })
}

// MARK: - The three-way `cards`

@Suite struct PlanningMealsFillBodyTests {

    @Test func omitsTheCardsKeyEntirelyWhenTheServerShouldDraft() throws {
        let body = PlanningMealsWire.fillBody(weekStart: "2026-09-06", cards: nil)

        // THE ASSERTION THAT MATTERS: absent, not null. `body.cards === undefined` is what
        // makes the server draft; a present null parses as "not a usable list" and writes
        // NOTHING while still answering 200, so an app that sent one would report a week
        // it never planned.
        #expect(body["cards"] == nil)
        #expect(Array(body.keys) == ["weekStart"])

        // …and it is still absent once encoded, which is the only form the server sees.
        let encoded = String(decoding: try JSONEncoder().encode(body), as: UTF8.self)
        #expect(!encoded.contains("cards"))
    }

    @Test func sendsAnApprovedWeekAsARealArray() throws {
        let cards = [
            WaffledAPI.PlanningMealsCard(date: "2026-09-09", title: "Approved 3"),
            WaffledAPI.PlanningMealsCard(date: "2026-09-11", recipeId: "r-chili"),
        ]
        let body = PlanningMealsWire.fillBody(weekStart: "2026-09-06", cards: cards)

        guard case let .array(sent)? = body["cards"] else {
            Issue.record("cards should be a present array")
            return
        }
        #expect(sent.count == 2)
        #expect(sent[0] == .object([
            "date": .string("2026-09-09"),
            "mealType": .string("dinner"),
            "title": .string("Approved 3"),
            "recipeId": .null,
        ]))
        // The step plans DINNERS, so every card says so — the server drops any that
        // doesn't rather than moving somebody's lunch to 6pm.
        #expect(sent[1] == .object([
            "date": .string("2026-09-11"),
            "mealType": .string("dinner"),
            "title": .string(""),
            "recipeId": .string("r-chili"),
        ]))
    }

    @Test func anEmptyApprovedWeekStaysPresentAndEmpty() {
        // The third case, and the one that is easy to "helpfully" collapse to absent: an
        // empty list is a caller that approved nothing, and the server writes nothing for
        // it (`chosen = []` skips the drafting branch, and the fill loop has nothing to
        // iterate). Turning it into absent would hand the family a week they never saw.
        let body = PlanningMealsWire.fillBody(weekStart: "2026-09-06", cards: [])
        #expect(body["cards"] == .array([]))
    }
}

@Suite struct PlanningMealsUndoBodyTests {

    @Test func roundTripsEveryDimensionOfTheReceiptIncludingMealId() throws {
        let claim = try WaffledAPI.decoder.decode(
            WaffledAPI.PlanningFilledNight.self,
            from: Data("""
            { "date": "2026-09-09", "entryId": "e-wed", "recipeId": null,
              "mealId": "m-copy-1", "title": "BBQ Sunday" }
            """.utf8))

        let body = PlanningMealsWire.undoBody(weekStart: "2026-09-06", filled: [claim])

        #expect(body["weekStart"] == .string("2026-09-06"))
        #expect(body["filled"] == .array([
            .object([
                "date": .string("2026-09-09"),
                "entryId": .string("e-wed"),
                "recipeId": .null,
                // WITHOUT THIS the undo would clear a decision it never made: a night
                // filled with the bare title "BBQ Sunday" and a night since hand-changed
                // to the PLATE "BBQ Sunday" agree on entryId, recipeId and title, because
                // the upsert keeps the row id.
                "mealId": .string("m-copy-1"),
                "title": .string("BBQ Sunday"),
            ]),
        ]))
    }

    @Test func writesExplicitNullsRatherThanOmittingFields() throws {
        let claim = try WaffledAPI.decoder.decode(
            WaffledAPI.PlanningFilledNight.self,
            from: Data("""
            { "date": "2026-09-11", "entryId": "e-fri", "recipeId": "r-stir", "mealId": null, "title": null }
            """.utf8))
        guard case let .array(sent)? = PlanningMealsWire.undoBody(weekStart: "w", filled: [claim])["filled"],
              case let .object(one) = sent[0] else {
            Issue.record("filled should be an array of objects")
            return
        }
        #expect(one["mealId"] == .null)
        #expect(one["title"] == .null)
        #expect(one.keys.count == 5)
    }
}

@Suite struct PlanningMealsShopperBodyTests {

    @Test func clearingTheTripSendsExplicitNulls() {
        // `dueOn: null` is "no trip this week" — the chore is REMOVED. A body built with
        // `if let` would omit the key and the clear would be a silent no-op.
        let body = PlanningMealsWire.shopperBody(
            weekStart: "2026-09-06", dueOn: nil, personId: nil, dueTime: nil, choreId: "c-1")
        #expect(body["dueOn"] == .null)
        #expect(body["personId"] == .null)
        #expect(body["dueTime"] == .null)
        #expect(body["choreId"] == .string("c-1"))
    }
}

// MARK: - Who may be handed the trip

@Suite struct PlanningMealsShopperCapabilityTests {

    @Test func handingTheTripToSomebodyElseNeedsChoreManage() {
        // The server's own rule (`meals.routes.ts`): `personId !== null && personId !==
        // tenant.personId` requires `chore.manage`. Stated client-side so the picker never
        // offers a tap that 403s.
        #expect(!PlanningMealsShopper.mayAssign(
            personId: "p-wally", myPersonId: "p-kevin", canManage: false))
        #expect(PlanningMealsShopper.mayAssign(
            personId: "p-wally", myPersonId: "p-kevin", canManage: true))
    }

    @Test func puttingItOnYourselfOrUpForGrabsNeedsNothing() {
        #expect(PlanningMealsShopper.mayAssign(
            personId: "p-kevin", myPersonId: "p-kevin", canManage: false))
        // Up for grabs is a real answer, not an assignment.
        #expect(PlanningMealsShopper.mayAssign(
            personId: nil, myPersonId: "p-kevin", canManage: false))
        #expect(PlanningMealsShopper.mayAssign(personId: nil, myPersonId: nil, canManage: false))
    }

    @Test func aDeviceWithNoPersonCannotClaimTheTripForItself() {
        // A kiosk identity has no person of its own, so "that's me" is not available to
        // it — the capability is the only way through.
        #expect(!PlanningMealsShopper.mayAssign(
            personId: "p-kevin", myPersonId: nil, canManage: false))
    }
}

// MARK: - Decoding

@Suite struct PlanningMealsDecodingTests {

    @Test func decodesTheWeekTheServerNamed() throws {
        let view = try decodedWeek()
        #expect(view.weekStart == "2026-09-06")
        #expect(view.nights.map(\.date) == [
            "2026-09-06", "2026-09-07", "2026-09-08", "2026-09-09",
            "2026-09-10", "2026-09-11", "2026-09-12",
        ])
        #expect(view.emptyDates == ["2026-09-09", "2026-09-11", "2026-09-12"])
        #expect(view.nights[0].dinner?.title == "Pasta bake")
        // A cook is REAL data (`cook_person_id`); every other night reports null and the
        // tile falls back to what the recipe knows.
        #expect(view.nights[0].dinner?.cookName == "Kevin")
        #expect(view.nights[1].dinner?.cookName == nil)
        // The seeded recipes carry no times, so minutes is honestly null rather than 0.
        #expect(view.nights[1].dinner?.minutes == nil)
        #expect(view.groceries?.items == 9)
        #expect(view.groceries?.checked == 2)
        #expect(view.choresOn)
        #expect(view.shopping == nil)
    }

    @Test func keepsTheNightsEventsWithTheirColourInputs() throws {
        let wed = try decodedWeek().nights[3]
        #expect(wed.events.map(\.title) == ["Soccer practice"])
        #expect(wed.events[0].personColor == "#7A5AF8")
        #expect(wed.events[0].participantIds.isEmpty)
        #expect(!wed.events[0].allDay)
    }

    @Test func aPayloadMissingAnArrayCostsThatArrayAndNotTheWeek() throws {
        // Swift is stricter than the web here: a missing non-optional array THROWS and
        // would fail the WHOLE view. A night with no `events` key, and an event with no
        // `participantIds`, must both still decode.
        let view = try WaffledAPI.decoder.decode(
            WaffledAPI.PlanningMealsView.self,
            from: Data("""
            { "weekStart": "2026-09-06",
              "nights": [
                { "date": "2026-09-06" },
                { "date": "2026-09-07",
                  "events": [ { "id": "ev-1", "title": "Dance", "startsAt": "2026-09-07T23:00:00.000Z", "allDay": false } ] }
              ] }
            """.utf8))
        #expect(view.nights.count == 2)
        #expect(view.nights[0].events.isEmpty)
        #expect(view.nights[1].events[0].participantIds.isEmpty)
        // …and the fields that were genuinely absent read as the honest default.
        #expect(view.emptyDates.isEmpty)
        #expect(!view.choresOn)
        #expect(view.groceries == nil)
    }

    @Test func decodesTheFillReceiptWithMealIdNullOnEveryClaim() throws {
        let fill = try WaffledAPI.decoder.decode(WaffledAPI.PlanningMealsFill.self, from: fillJSON)
        #expect(fill.filled.map(\.date) == ["2026-09-09", "2026-09-11", "2026-09-12"])
        // A fill writes recipes and titles, never plates — so the receipt says so.
        #expect(fill.filled.allSatisfy { $0.mealId == nil })
        #expect(fill.view.emptyDates.isEmpty)
    }
}

// MARK: - The plate branch

@Suite struct PlanningMealsPlateTests {

    @Test func aPlateIsNeverTakeoutHoweverItIsNamed() throws {
        let night = try WaffledAPI.decoder.decode(
            WaffledAPI.PlanningMealsNight.self, from: plateNightJSON)
        let dinner = try #require(night.dinner)

        // `recipeId == nil && mealId != nil` is the PLATE branch, checked before the
        // classifier — otherwise a plate somebody called "Takeout Tuesday" would wear the
        // takeout tile and claim "no cooking" about several dishes cooked from scratch.
        #expect(dinner.mealId == "m-copy-1")
        #expect(!PlanningMealsText.isEatingOut(dinner))
        #expect(PlanningMealsText.attribution(dinner, auto: false, eatingOut: false) == "a whole plate")
    }

    @Test func aRecipelessTakeoutTitleStillReadsAsTakeout() throws {
        let dinner = try WaffledAPI.decoder.decode(
            WaffledAPI.PlanningNightDinner.self,
            from: Data("""
            { "entryId": "e-thu", "title": "Eating out", "recipeId": null, "mealId": null }
            """.utf8))
        #expect(PlanningMealsText.isEatingOut(dinner))
        #expect(PlanningMealsText.attribution(dinner, auto: false, eatingOut: true) == "no cooking")
    }
}

// MARK: - The copy

@Suite struct PlanningMealsTextTests {

    @Test func smallCountsReadAsWords() {
        #expect(PlanningMealsText.countWord(3) == "three")
        #expect(PlanningMealsText.countWord(1) == "one")
        #expect(PlanningMealsText.countWord(9) == "9")
    }

    @Test func theKeptNoteNamesTheNightsItWalkedPast() {
        // "Undo the three" that clears two has to SAY so, or it reads as a bug.
        #expect(PlanningMealsText.keptSentence([]) == nil)
        #expect(PlanningMealsText.keptSentence(["2026-09-11"])
            == "one night was left alone — Fri has been decided since.")
        #expect(PlanningMealsText.keptSentence(["2026-09-11", "2026-09-12"])
            == "two nights were left alone — Fri, Sat have been decided since.")
    }

    @Test func theTripPillSaysUpForGrabsRatherThanNothing() throws {
        #expect(PlanningMealsText.tripLabel(nil) == "Who's shopping?")

        let unassigned = try WaffledAPI.decoder.decode(
            WaffledAPI.PlanningShoppingTrip.self,
            from: Data("""
            { "choreId": "c-1", "personId": null, "personName": null, "personAvatar": null,
              "personColor": null, "dueOn": "2026-09-12", "dueTime": "09:00", "status": "pending" }
            """.utf8))
        // Planned but unassigned is a REAL answer, not a blank.
        #expect(PlanningMealsText.tripLabel(unassigned) == "Up for grabs · Sat 09:00")

        let assigned = try WaffledAPI.decoder.decode(
            WaffledAPI.PlanningShoppingTrip.self,
            from: Data("""
            { "choreId": "c-1", "personId": "p-kevin", "personName": "Kevin", "personAvatar": "🧢",
              "personColor": "#EC6049", "dueOn": "2026-09-12", "dueTime": null, "status": "pending" }
            """.utf8))
        #expect(PlanningMealsText.tripLabel(assigned) == "🧢 Kevin shops Sat")
    }

    @Test func theGroceryLineOnlyClaimsWhatWasMeasured() {
        #expect(PlanningMealsText.grocerySub(added: nil)
            == "built from what's planned so far · staples skipped")
        #expect(PlanningMealsText.grocerySub(added: 5) == "5 items added · staples skipped")
    }

    @Test func anAllDayEventSaysSoAndAnUnreadableInstantSaysNothing() throws {
        // The clock itself is deliberately read in the DEVICE's zone — `startsAt` is a
        // real instant, not a calendar label, and the web's `toLocaleTimeString` does the
        // same — so it is not asserted here (the answer would depend on the machine).
        // What IS asserted is the two branches that must never depend on a zone.
        let allDay = try WaffledAPI.decoder.decode(
            WaffledAPI.PlanningNightEvent.self,
            from: Data("""
            { "id": "ev-1", "title": "School closed", "startsAt": "2026-09-09T00:00:00.000Z",
              "allDay": true, "participantIds": [] }
            """.utf8))
        #expect(PlanningMealsText.clock(allDay) == "All day")

        let unreadable = try WaffledAPI.decoder.decode(
            WaffledAPI.PlanningNightEvent.self,
            from: Data("""
            { "id": "ev-2", "title": "Odd one", "startsAt": "not a timestamp", "allDay": false }
            """.utf8))
        // Blank rather than a lie, and it must not crash the seven nights either.
        #expect(PlanningMealsText.clock(unreadable) == "")
    }

    @Test func dayLabelsAreReadInUTCBecauseADateIsALabel() {
        // Parsed in a negative-offset zone a bare YYYY-MM-DD hands back the day before,
        // which would print the whole week shifted by one weekday.
        #expect(PlanningMealsText.dow("2026-09-06") == "Sun")
        #expect(PlanningMealsText.monthDay("2026-09-06") == "Sep 6")
    }
}

// MARK: - The crumb

@Suite struct PlanningMealsCrumbTests {

    @Test func readsOnlyRealDaysOutOfWhateverTheSessionKept() {
        // `step.data` is free-form by the time it comes back, so it is filtered rather
        // than trusted.
        let data: [String: JSONValue] = [
            "autoFilled": .array([
                .string("2026-09-09"), .string("nope"), .int(7), .string("2026-9-9"),
                .string("2026-09-12"),
            ]),
        ]
        #expect(PlanningMealsCrumb.dates(data) == ["2026-09-09", "2026-09-12"])
        #expect(PlanningMealsCrumb.dates(nil).isEmpty)
        #expect(PlanningMealsCrumb.dates(["autoFilled": .string("2026-09-09")]).isEmpty)
    }
}

// MARK: - The model

@MainActor
@Suite struct PlanningMealsModelTests {

    @Test func failedReadKeepsTheWeekItAlreadyHadAndStillLoads() async throws {
        let feed = try MealsFeed()
        let model = model(feed)
        await model.load(weekStart: "2026-09-06", seed: [])
        feed.fetchFails = true

        await model.reread(weekStart: "2026-09-06")

        #expect(model.loaded)
        #expect(model.rows.count == 7)
        #expect(model.rows[0].dinner?.title == "Pasta bake")
    }

    @Test func theCrumbIsNilUntilTheAppHasActuallyPickedANight() async throws {
        let feed = try MealsFeed()
        let model = model(feed)
        await model.load(weekStart: "2026-09-06", seed: [])

        // No ✨ anywhere ⇒ nil, matching the web's `dates.length ? {…} : null`. An empty
        // list would be a claim rather than an absence.
        #expect(model.crumb == nil)
    }

    @Test func theCrumbRestoresTheMarksButNeverTheUndo() async throws {
        let feed = try MealsFeed()
        let model = model(feed)

        // A previous visit said Sunday and Wednesday were auto-filled. Sunday is still
        // planned; Wednesday is now empty, so its mark is dropped.
        await model.load(weekStart: "2026-09-06", seed: ["2026-09-06", "2026-09-09"])

        #expect(model.autoMarks == ["2026-09-06"])
        #expect(model.rows[0].auto)
        #expect(model.rows[0].attribution == "👤 Kevin") // a real cook still outranks ✨
        #expect(model.crumb == ["autoFilled": .array([.string("2026-09-06")])])

        // AND THE UNDO IS NOT LIVE. A claim rebuilt from the view proves nothing — it
        // would be compared against the very row it was read from — so the footer must
        // still offer the fill, not "Undo the one".
        #expect(model.filled.isEmpty)
    }

    @Test func fillingMarksTheNightsMeasuresTheGroceriesAndArmsTheUndo() async throws {
        let feed = try MealsFeed()
        let model = model(feed)
        await model.load(weekStart: "2026-09-06", seed: [])

        let landed = await model.planTheRest(weekStart: "2026-09-06")

        #expect(landed)
        // The one that would be catastrophic: iOS drafts headlessly, so the key is absent.
        #expect(feed.fillBodies.count == 1)
        #expect(feed.fillBodies[0]["cards"] == nil)

        #expect(model.filled.map(\.date) == ["2026-09-09", "2026-09-11", "2026-09-12"])
        #expect(model.crumb == ["autoFilled": .array([
            .string("2026-09-09"), .string("2026-09-11"), .string("2026-09-12"),
        ])])
        // Measured, not claimed: 9 items before, 14 after.
        #expect(model.groceryAdded == 5)
        let wed = try #require(model.rows.first { $0.date == "2026-09-09" })
        #expect(wed.auto)
        #expect(wed.attribution == "the app picked this")
        #expect(model.emptyDates.isEmpty)
    }

    @Test func undoKeepsANightSomebodyDecidedSinceAndSaysSo() async throws {
        let feed = try MealsFeed()
        let model = model(feed)
        await model.load(weekStart: "2026-09-06", seed: [])
        await model.planTheRest(weekStart: "2026-09-06")

        let landed = await model.undoTheFill(weekStart: "2026-09-06")

        #expect(landed)
        // The claim went out with all three nights — the SERVER decides which are still
        // undoable, and it answered "this one isn't".
        guard case let .array(sent)? = feed.undoBodies[0]["filled"] else {
            Issue.record("the undo must send its receipt")
            return
        }
        #expect(sent.count == 3)

        #expect(model.kept == ["2026-09-11"])
        // A kept night is no longer an auto-fill: it leaves the undoable set WITHOUT being
        // cleared, so a second tap can't come back for it.
        #expect(model.filled.isEmpty)
        #expect(model.autoMarks.isEmpty)
        // …and what somebody put there is still there.
        let fri = try #require(model.rows.first { $0.date == "2026-09-11" })
        #expect(fri.dinner?.title == "Grandma’s")
        #expect(!fri.auto)
        // The copy has to name it, or "Undo the three" that cleared two reads as a bug.
        #expect(PlanningMealsText.keptSentence(model.kept)
            == "one night was left alone — Fri has been decided since.")
        // The crumb followed: nothing is marked any more.
        #expect(model.crumb == nil)
    }

    @Test func aFailedFillChangesNothingAndSaysWhy() async throws {
        let feed = try MealsFeed()
        feed.fillFails = true
        let model = model(feed)
        await model.load(weekStart: "2026-09-06", seed: [])

        let landed = await model.planTheRest(weekStart: "2026-09-06")

        #expect(!landed)
        #expect(model.filled.isEmpty)
        #expect(model.errorMessage != nil)
        // A failed write does not refetch — the week is exactly as it was.
        #expect(feed.fetchCount == 1)
        #expect(model.emptyDates == ["2026-09-09", "2026-09-11", "2026-09-12"])
    }

    @Test func undoDoesNothingWithoutALiveReceipt() async throws {
        let feed = try MealsFeed()
        let model = model(feed)
        await model.load(weekStart: "2026-09-06", seed: ["2026-09-06"])

        // A restored MARK is not a receipt, so there is nothing to take back.
        let landed = await model.undoTheFill(weekStart: "2026-09-06")

        #expect(!landed)
        #expect(feed.undoBodies.isEmpty)
    }

    @Test func decidingANightByHandStopsItBeingAnAutoFill() async throws {
        let feed = try MealsFeed()
        let model = model(feed)
        await model.load(weekStart: "2026-09-06", seed: [])
        await model.planTheRest(weekStart: "2026-09-06")
        #expect(model.filled.count == 3)

        // The picker writes through the meal-plan endpoint the Meals screen uses.
        feed.view = feed.fillResult.view
        let landed = await model.planNight(
            weekStart: "2026-09-06", date: "2026-09-11", recipeId: "r-curry", title: nil)

        #expect(landed)
        #expect(feed.plannedSlots.map { $0.date } == ["2026-09-11"])
        #expect(feed.plannedSlots[0].recipeId == "r-curry")
        // It left the undoable set AND the marks — a decision is not an auto-fill.
        #expect(model.filled.map(\.date) == ["2026-09-09", "2026-09-12"])
        #expect(model.crumb == ["autoFilled": .array([
            .string("2026-09-09"), .string("2026-09-12"),
        ])])
    }

    @Test func aHandWriteForgetsTheStarEvenIfTheReReadFails() async throws {
        let feed = try MealsFeed()
        let model = model(feed)
        await model.load(weekStart: "2026-09-06", seed: [])
        await model.planTheRest(weekStart: "2026-09-06")

        // The write lands, the re-read after it does not (offline for a second). The
        // loading contract keeps the previous view — which must NOT mean keeping the ✨:
        // the tile would still say "the app picked this" about a night somebody just
        // decided, and the crumb would still name it, so answering the step would record
        // a night the family chose as auto-filled.
        feed.fetchFails = true
        let landed = await model.planNight(
            weekStart: "2026-09-06", date: "2026-09-11", recipeId: "r-curry", title: nil)

        #expect(landed)
        let fri = try #require(model.rows.first { $0.date == "2026-09-11" })
        #expect(!fri.auto)
        #expect(fri.attribution != "the app picked this")
        #expect(model.crumb == ["autoFilled": .array([
            .string("2026-09-09"), .string("2026-09-12"),
        ])])
    }

    @Test func clearingANightGoesThroughTheMealsScreensOwnDelete() async throws {
        let feed = try MealsFeed()
        let model = model(feed)
        await model.load(weekStart: "2026-09-06", seed: [])

        #expect(await model.clearNight(weekStart: "2026-09-06", date: "2026-09-08"))
        #expect(feed.clearedSlots == ["2026-09-08"])
    }

    @Test func assigningTheTripReadsItBackOffTheChoreAndKeepsItsIdForNextTime() async throws {
        let feed = try MealsFeed()
        let model = model(feed)
        await model.load(weekStart: "2026-09-06", seed: [])
        // Nothing to hint with yet, so the first write carries no chore id.
        #expect(model.choreHint == nil)

        #expect(await model.setShopper(
            weekStart: "2026-09-06", dueOn: "2026-09-12", personId: "p-kevin", dueTime: "09:00"))

        #expect(model.view?.shopping?.choreId == "c-groceries")
        #expect(model.view?.shopping?.personName == "Kevin")
        #expect(PlanningMealsText.tripLabel(model.view?.shopping) == "🧢 Kevin shops Sat 09:00")
        // A shopper write must not refetch the week — the answer already carries it.
        #expect(feed.fetchCount == 1)

        // AND THE HINT NOW TRAVELS. It is what keeps a chore renamed on the Tasks board
        // recognised as this week's trip instead of spawning a second "Groceries".
        #expect(model.choreHint == "c-groceries")
        #expect(await model.setShopper(
            weekStart: "2026-09-06", dueOn: "2026-09-11", personId: nil, dueTime: nil))
        #expect(feed.shopperCalls.count == 2)
        #expect(feed.shopperCalls[1].choreId == "c-groceries")
        // Up for grabs is a real answer, so it goes out as an explicit null rather than as
        // "leave the assignee alone".
        #expect(PlanningMealsWire.shopperBody(
            weekStart: "2026-09-06", dueOn: "2026-09-11", personId: nil,
            dueTime: nil, choreId: "c-groceries")["personId"] == .null)
    }

    @Test func aRefusedShopperWriteLeavesTheTripAloneAndDoesNotRefetch() async throws {
        let feed = try MealsFeed()
        feed.shopperForbidden = true
        let model = model(feed)
        await model.load(weekStart: "2026-09-06", seed: [])

        let landed = await model.setShopper(
            weekStart: "2026-09-06", dueOn: "2026-09-12", personId: "p-wally", dueTime: "09:00")

        #expect(!landed)
        // The server's 403 is the authority; the client only avoids OFFERING the tap.
        #expect(model.errorMessage == "Only a parent can hand the shopping to somebody else.")
        #expect(model.view?.shopping == nil)
        #expect(feed.fetchCount == 1)
        // …and the chore hint travelled, so a renamed chore is still this week's trip.
        #expect(feed.shopperCalls.count == 1)
        #expect(feed.shopperCalls[0].choreId == nil) // no trip yet, so nothing to hint with
    }

    @Test func oneWriteAtATimeAndTheSecondSaysSoRatherThanReturningQuietly() async throws {
        let feed = try MealsFeed()
        let model = model(feed)
        await model.load(weekStart: "2026-09-06", seed: [])

        // The first fill is parked inside the stub, so the second genuinely arrives while
        // a write is in flight. A quiet `return` there would report a week that was never
        // written, because the control that called it has already changed its label.
        feed.holdFill = true
        let first = Task { await model.planTheRest(weekStart: "2026-09-06") }
        var spins = 0
        while feed.fillGate == nil && spins < 1_000 {
            await Task.yield()
            spins += 1
        }
        try #require(feed.fillGate != nil)

        let second = await model.planTheRest(weekStart: "2026-09-06")

        feed.fillGate?.resume()
        feed.fillGate = nil
        let landed = await first.value

        #expect(landed)
        #expect(!second)
        #expect(feed.fillBodies.count == 1)
        #expect(model.errorMessage != nil)
    }
}

// MARK: - The store the body and the footer share

/// `.serialized` because these cases share the process-wide store the body and the footer
/// meet in. They are all synchronous today, so they cannot interleave — but the first
/// `await` anybody adds would make them flaky, and the flake would look like a store bug.
@MainActor
@Suite(.serialized) struct PlanningMealsStepStoreTests {

    @Test func theBodyAndTheFooterGetTheSAMEModel() throws {
        let store = PlanningMealsStepStore.shared
        store.reset()
        let feed = try MealsFeed()

        // The body resolves first (it is built first), the footer second. If these were
        // two models the ✨ the footer's fill writes would never reach the body's nights.
        let body = store.model(sessionId: "s-1", weekStart: "2026-09-06", make: { model(feed) })
        let footer = store.model(sessionId: "s-1", weekStart: "2026-09-06", make: { model(feed) })

        #expect(body === footer)
        store.reset()
    }

    @Test func steppingToAnotherWeekCannotInheritTheLastWeeksMarks() throws {
        let store = PlanningMealsStepStore.shared
        store.reset()
        let feed = try MealsFeed()

        let first = store.model(sessionId: "s-1", weekStart: "2026-09-06", make: { model(feed) })
        let next = store.model(sessionId: "s-2", weekStart: "2026-09-13", make: { model(feed) })

        #expect(first !== next)
        // Single-slot: asking for the old key again builds a fresh model rather than
        // handing back a stale one, so a previous week's undo receipt can never be live.
        let again = store.model(sessionId: "s-1", weekStart: "2026-09-06", make: { model(feed) })
        #expect(again !== first)
        store.reset()
    }

    @Test func theKeyIsSpelledInExactlyOnePlace() {
        #expect(PlanningMealsStepStore.key(sessionId: "s-1", weekStart: "2026-09-06")
            == "s-1|2026-09-06")
    }
}
