import Foundation
import Testing
@testable import Waffled

// Weekly Planning · step 6 — Goals, on iOS.
//
// Three things are worth locking here, and all three are ones a "simplification" would
// silently undo:
//
//   1. A GOAL'S NUMBER COMES OFF `GoalDisplay`, NOT `totalProgress`. The step renders a
//      habit, and a habit's lifetime count reads as long-since-done where this week's
//      honest answer is "2 of 5". So the DTO is decoded from bytes and the axis asserted.
//   2. THE CRUMB MIRRORS THE SERVER'S FOCUS MAP. `/goals/focus` merges `{focus: {...}}`
//      onto the step row, but the shell REPLACES the step's data when the affirmative is
//      pressed — a crumb that summarised would erase every answer the session recorded.
//      And it must mirror SETTLED groups only: an unsettled group's `focusGoalId` may be a
//      pre-existing pin the server merely adopted for display.
//   3. THE LOADING CONTRACT. A failed fetch keeps the last good groups and still counts as
//      loaded; a failed write mutates nothing.
//
// The JSON below is the shape `apps/api/test/weekly-planning-goals.integration.test.ts`
// asserts on — a group with its members' ages, goals carrying the display-axis fields, and
// the pace sentence with one of its three tones.

// MARK: - Fixtures

private enum GoalsFixture {

    /// One goal object, exactly as the server sends it: a flat `Goal` with `pace` beside it.
    static func goalJSON(
        id: String,
        title: String,
        type: String,
        total: Double,
        target: String = "null",
        habitTarget: String = "null",
        habitPeriod: String = "null",
        periodDone: String = "null",
        stepDone: String = "null",
        stepTotal: String = "null",
        isFeatured: Bool = false,
        pace: String = "null"
    ) -> String {
        """
        {"id":"\(id)","goalListId":"list-family","title":"\(title)","emoji":"📚",
         "category":"intellectual","goalType":"\(type)","unit":null,
         "habitPeriod":\(habitPeriod),"habitTargetPerPeriod":\(habitTarget),
         "trackingMode":"shared","participantMode":null,"targetBasis":null,"deadline":null,
         "isFeatured":\(isFeatured),"isSpotlight":false,"target":\(target),
         "totalProgress":\(total),"periodDone":\(periodDone),"stepDone":\(stepDone),
         "stepTotal":\(stepTotal),"logMethod":"manual","hasRewards":false,
         "milestoneTotal":0,"milestoneReached":0,"streakDays":3,"autoFromCalendar":false,
         "healthMetric":null,"createdAt":"2026-01-01T00:00:00.000Z","participants":[],
         "pace":\(pace)}
        """
    }

    /// The whole view: the family list (settled on a goal), Lottie's individual list
    /// (settled on NOTHING — a real answer), and the couple's private list (not settled,
    /// but carrying a lone pre-existing pin the server adopts for display only).
    static let viewJSON = """
    {"groups":[
      {"listId":"list-family","name":"Family","emoji":"🏡","colorHex":"#EC6049",
       "isPrivate":false,"sortOrder":0,"isEveryone":true,"settled":true,
       "focusGoalId":"goal-read",
       "members":[
         {"personId":"p-kevin","name":"Kevin Sites","avatarEmoji":"🧔","colorHex":"#2F7FED","age":41},
         {"personId":"p-wally","name":"Wally Sites","avatarEmoji":"🧒","colorHex":"#25A368","age":null}
       ],
       "goals":[
         \(goalJSON(id: "goal-read", title: "Read together", type: "habit", total: 340,
                    habitTarget: "5", habitPeriod: "\"week\"", periodDone: "2",
                    isFeatured: true,
                    pace: "{\"text\":\"2 of 5 last week\",\"tone\":\"behind\"}")),
         \(goalJSON(id: "goal-walk", title: "Walk the loop", type: "count", total: 12,
                    target: "20", pace: "{\"text\":\"3 days logged last week\",\"tone\":\"ok\"}"))
       ]},
      {"listId":"list-lottie","name":"Lottie","emoji":"🎀","colorHex":null,
       "isPrivate":false,"sortOrder":1,"isEveryone":false,"settled":true,
       "focusGoalId":null,
       "members":[{"personId":"p-lottie","name":"Lottie Sites","avatarEmoji":"🎀","colorHex":"#E0548B","age":6}],
       "goals":[
         \(goalJSON(id: "goal-recital", title: "Recital practice", type: "checklist",
                    total: 99, stepDone: "3", stepTotal: "4",
                    pace: "{\"text\":\"roughly 1 a month\",\"tone\":\"flat\"}"))
       ]},
      {"listId":"list-couple","name":"Us","emoji":"💛","colorHex":null,
       "isPrivate":true,"sortOrder":2,"isEveryone":false,"settled":false,
       "focusGoalId":"goal-date",
       "members":[
         {"personId":"p-kevin","name":"Kevin Sites","avatarEmoji":"🧔","colorHex":"#2F7FED","age":41},
         {"personId":"p-kelly","name":"Kelly Sites","avatarEmoji":"👩","colorHex":"#8A5CF0","age":40}
       ],
       "goals":[\(goalJSON(id: "goal-date", title: "Date night", type: "count", total: 1,
                           target: "12", isFeatured: true))]}
    ]}
    """

    static func decoded() throws -> WaffledAPI.PlanningGoalsView {
        try WaffledAPI.decoder.decode(
            WaffledAPI.PlanningGoalsView.self, from: Data(viewJSON.utf8))
    }
}

private enum GoalsStepFailure: Error { case rejected }

@MainActor
private final class GoalsFeed {
    var snapshot: WaffledAPI.PlanningGoalsView
    var fetchFails = false
    var writeFails = false
    var fetchCount = 0
    var writes: [(listId: String, goalId: String?)] = []

    init(_ snapshot: WaffledAPI.PlanningGoalsView) { self.snapshot = snapshot }
}

@MainActor
private func model(_ feed: GoalsFeed) -> PlanningGoalsStepModel {
    PlanningGoalsStepModel(
        fetchGoals: { _ in
            feed.fetchCount += 1
            if feed.fetchFails { throw GoalsStepFailure.rejected }
            return feed.snapshot
        },
        setFocus: { _, listId, goalId in
            feed.writes.append((listId, goalId))
            if feed.writeFails { throw GoalsStepFailure.rejected }
            return feed.snapshot
        })
}

// MARK: - Decoding

@Suite struct PlanningGoalsDecodingTests {

    @Test func theStepsViewDecodesFromTheServersOwnShape() throws {
        let view = try GoalsFixture.decoded()
        #expect(view.groups.count == 3)

        let family = view.groups[0]
        #expect(family.listId == "list-family")
        #expect(family.isPrivate == false)
        #expect(family.isEveryone)
        #expect(family.settled)
        #expect(family.focusGoalId == "goal-read")
        #expect(family.sortOrder == 0)
        #expect(family.goals.count == 2)

        // A member with no birthday on file drops the age rather than inventing one.
        #expect(family.members[0].age == 41)
        #expect(family.members[1].age == nil)

        // The private list is served only to its members — the tab wears a lock.
        #expect(view.groups[2].isPrivate)
    }

    @Test func aHabitsNumberComesOffTheDisplayAxisNotItsLifetimeTotal() throws {
        let view = try GoalsFixture.decoded()
        let read = view.groups[0].goals[0].goal
        #expect(read.goalType == "habit")
        #expect(read.totalProgress == 340)

        // 2 of 5 THIS WEEK. 340 is the number this step must never show.
        #expect(GoalDisplay.progress(read) == 2)
        #expect(GoalDisplay.target(read) == 5)
        #expect(GoalDisplay.fraction(read) == 0.4)
        #expect(PlanningGoalsText.axisLabel(read) == "this week")
    }

    @Test func aChecklistIsMeasuredInStepsAndACountInItsTotal() throws {
        let view = try GoalsFixture.decoded()
        let recital = view.groups[1].goals[0].goal
        #expect(GoalDisplay.progress(recital) == 3)
        #expect(GoalDisplay.target(recital) == 4)
        #expect(PlanningGoalsText.axisLabel(recital) == "steps done")

        let walk = view.groups[0].goals[1].goal
        #expect(GoalDisplay.progress(walk) == 12)
        #expect(GoalDisplay.target(walk) == 20)
    }

    @Test func thePaceSentenceAndItsToneArriveWithTheGoal() throws {
        let view = try GoalsFixture.decoded()
        #expect(view.groups[0].goals[0].pace?.text == "2 of 5 last week")
        #expect(view.groups[0].goals[0].pace?.tone == "behind")
        #expect(view.groups[1].goals[0].pace?.tone == "flat")
        // Nil when there is genuinely nothing honest to say about a goal's pace.
        #expect(view.groups[2].goals[0].pace == nil)
    }

    @Test func anUnknownToneReadsNeutralRatherThanAlarming() {
        // A server newer than this build may name a fourth tone: it must render in the
        // neutral colour, never fail to decode and never be dressed up as "behind".
        #expect(PlanningPaceTone.kind("ok") == .ok)
        #expect(PlanningPaceTone.kind("behind") == .behind)
        #expect(PlanningPaceTone.kind("flat") == .neutral)
        #expect(PlanningPaceTone.kind("euphoric") == .neutral)
    }
}

// MARK: - The crumb

@Suite struct PlanningGoalsCrumbTests {

    @Test func theCrumbMirrorsTheServersFocusMapIncludingItsExplicitNull() throws {
        let crumb = PlanningGoalsCrumb.decision(try GoalsFixture.decoded())
        guard case let .object(focus)? = crumb["focus"] else {
            Issue.record("the crumb must carry a `focus` object")
            return
        }
        // The goal the family settled on…
        #expect(focus["list-family"] == .string("goal-read"))
        // …and "nothing this week", which is a REAL answer and must survive as a null.
        // Dropping the key would make the group read as unanswered on the next visit.
        #expect(focus["list-lottie"] == .null)
        #expect(focus.count == 2)
    }

    @Test func anUnsettledGroupsAdoptedPinIsNotRecordedAsAnAnswer() throws {
        let crumb = PlanningGoalsCrumb.decision(try GoalsFixture.decoded())
        guard case let .object(focus)? = crumb["focus"] else {
            Issue.record("the crumb must carry a `focus` object")
            return
        }
        // `list-couple` is not settled, but carries `focusGoalId` because ONE of its goals
        // was already pinned by hand. Writing it would star a tab nobody has looked at.
        #expect(focus["list-couple"] == nil)
    }

}

// MARK: - The model

@MainActor
@Suite struct PlanningGoalsStepModelTests {

    @Test func noCrumbIsOfferedBeforeAReadHasLanded() async throws {
        // An empty map is not "nothing settled" — it is a claim, and the shell REPLACES the
        // step's data with the crumb. Offering one after a failed fetch would erase every
        // answer the session recorded.
        let feed = GoalsFeed(try GoalsFixture.decoded())
        feed.fetchFails = true
        let model = model(feed)

        await model.load(sessionId: "session-1")

        #expect(model.loaded)
        #expect(model.crumb == nil)
    }

    @Test func theStepSkipsPastASettledGroupToLandOnWhatIsLeft() async throws {
        // "What's left" is the useful place to land when you come back to the step — so the
        // FIRST group is deliberately settled here. Land on `groups.first` regardless and
        // this fails; a test where every group is unsettled would pass either way.
        let json = GoalsFixture.viewJSON
            // Un-settle the middle group so it, not the family list, is what's left.
            .replacingOccurrences(
                of: "\"isEveryone\":false,\"settled\":true",
                with: "\"isEveryone\":false,\"settled\":false")
        let view = try WaffledAPI.decoder.decode(
            WaffledAPI.PlanningGoalsView.self, from: Data(json.utf8))
        let feed = GoalsFeed(view)
        let model = model(feed)

        await model.load(sessionId: "session-1")

        // Family (settled) is skipped; Lottie's list is the first unanswered one.
        #expect(view.groups[0].settled)
        #expect(model.tabId == "list-lottie")
    }

    @Test func theStepOpensOnTheOnlyUnsettledGroupWhenTheOthersAreDone() async throws {
        let feed = GoalsFeed(try GoalsFixture.decoded())
        let model = model(feed)

        await model.load(sessionId: "session-1")

        // Family and Lottie have both answered; the couple's list is what's left.
        #expect(model.tabId == "list-couple")
        #expect(model.settledCount == 2)
    }

    @Test func aFailedReadKeepsTheGroupsItHadAndStillCountsAsLoaded() async throws {
        let feed = GoalsFeed(try GoalsFixture.decoded())
        let model = model(feed)
        await model.load(sessionId: "session-1")
        feed.fetchFails = true

        await model.load(sessionId: "session-1")

        #expect(model.groups.count == 3)
        #expect(model.loaded)
    }

    @Test func nothingThisWeekIsSentAsARealAnswerNotAsAMissingOne() async throws {
        let feed = GoalsFeed(try GoalsFixture.decoded())
        let model = model(feed)
        await model.load(sessionId: "session-1")

        await model.pick(sessionId: "session-1", listId: "list-couple", goalId: nil)

        #expect(feed.writes.count == 1)
        #expect(feed.writes[0].listId == "list-couple")
        #expect(feed.writes[0].goalId == nil)
    }

    @Test func aFailedWriteLeavesTheLastGoodAnswerOnScreenAndDoesNotRefetch() async throws {
        let feed = GoalsFeed(try GoalsFixture.decoded())
        let model = model(feed)
        await model.load(sessionId: "session-1")
        feed.writeFails = true

        await model.pick(sessionId: "session-1", listId: "list-family", goalId: "goal-walk")

        #expect(feed.fetchCount == 1)
        #expect(model.errorMessage != nil)
        // Still the answer the server last confirmed.
        #expect(model.groups[0].focusGoalId == "goal-read")
        // …and the step is answerable again rather than frozen for good.
        #expect(model.isFrozen(shellBusy: false) == false)
    }

    @Test func theTabTheFamilyIsStandingOnSurvivesAWrite() async throws {
        let feed = GoalsFeed(try GoalsFixture.decoded())
        let model = model(feed)
        await model.load(sessionId: "session-1")
        model.selectTab("list-family")

        await model.pick(sessionId: "session-1", listId: "list-family", goalId: "goal-walk")

        // Re-deriving "the first unsettled group" on every write would jump them off the
        // group they just answered.
        #expect(model.tabId == "list-family")
    }
}

// MARK: - The step's words

@Suite struct PlanningGoalsTextTests {

    @Test func theGroupSubLineOnlyEverStatesFactsTheServerSent() throws {
        let view = try GoalsFixture.decoded()
        #expect(PlanningGoalsText.groupSubtitle(view.groups[0]) == "shared · everyone tracks it")
        #expect(PlanningGoalsText.groupSubtitle(view.groups[1]) == "individual · age 6")
        #expect(PlanningGoalsText.groupSubtitle(view.groups[2]) == "private · just the two of you")
    }

    @Test func theVerdictTellsAlreadyPinnedApartFromWeDecided() throws {
        let view = try GoalsFixture.decoded()
        // Settled on a goal.
        #expect(PlanningGoalsText.verdict(view.groups[0]) == "★ This week · Read together")
        // Settled on nothing — still an answer.
        #expect(PlanningGoalsText.verdict(view.groups[1]) == "No focus this week — that’s allowed")
        // A pin that predates the session shows as the focus but is NOT a decision yet.
        #expect(PlanningGoalsText.verdict(view.groups[2])
                == "Pinned already · Date night — keep it, or pick another")
    }
}
