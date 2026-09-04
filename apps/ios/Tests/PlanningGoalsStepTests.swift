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
    static let viewJSON = json(familyExtra: nil)

    /// The same view, optionally with one EXTRA goal at the head of the family group's
    /// list — which is how the server answers the refetch that follows making a goal in
    /// that group. (`listGoals` is not filtered by pin state, so a brand-new goal is
    /// simply there on the next read.)
    static func json(familyExtra: String?) -> String {
        """
    {"groups":[
      {"listId":"list-family","name":"Family","emoji":"🏡","colorHex":"#EC6049",
       "isPrivate":false,"sortOrder":0,"isEveryone":true,"settled":true,
       "focusGoalId":"goal-read",
       "members":[
         {"personId":"p-kevin","name":"Kevin Sites","avatarEmoji":"🧔","colorHex":"#2F7FED","age":41},
         {"personId":"p-wally","name":"Wally Sites","avatarEmoji":"🧒","colorHex":"#25A368","age":null}
       ],
       "goals":[
         \(familyExtra.map { "\($0)," } ?? "")
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
    }

    static func decoded() throws -> WaffledAPI.PlanningGoalsView {
        try WaffledAPI.decoder.decode(
            WaffledAPI.PlanningGoalsView.self, from: Data(viewJSON.utf8))
    }

    /// The view the server would answer with once a goal called "Sunset walks" exists in
    /// the family group.
    static func decodedWithNewFamilyGoal() throws -> WaffledAPI.PlanningGoalsView {
        let extra = goalJSON(id: "goal-sunset", title: "Sunset walks", type: "count",
                             total: 0, target: "30", isFeatured: true)
        return try WaffledAPI.decoder.decode(
            WaffledAPI.PlanningGoalsView.self,
            from: Data(json(familyExtra: extra).utf8))
    }
}

private enum GoalsStepFailure: Error { case rejected }

@MainActor
private final class GoalsFeed {
    var snapshot: WaffledAPI.PlanningGoalsView
    var fetchFails = false
    var writeFails = false
    var createFails = false
    var fetchCount = 0
    var writes: [(listId: String, goalId: String?)] = []
    /// Every body `POST /api/goals` was called with.
    var creates: [[String: JSONValue]] = []
    /// What the NEXT read answers with once a goal has been created — the stand-in for
    /// the server having actually stored it.
    var afterCreate: WaffledAPI.PlanningGoalsView?

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
        },
        createGoal: { body in
            feed.creates.append(body)
            if feed.createFails { throw GoalsStepFailure.rejected }
            if let after = feed.afterCreate { feed.snapshot = after }
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

// MARK: - "＋ New goal for this week"

/// The tester's report was "I can't create a new one in the weekly plan", and the reason
/// the button was left off in the first place is exactly what these tests pin down: a
/// naive "+ New goal" makes a goal in whichever group list the family was NOT looking at,
/// and the new goal appears to vanish. Every invariant below is one a "simplification"
/// would quietly undo — which group it lands in, that it is then ON SCREEN, that making it
/// is not the same as confirming it, and that a saved goal survives a failed refetch.
@MainActor
@Suite struct PlanningGoalsNewGoalTests {

    /// What the goals module's own editor hands back when the step opens it: the Pinned
    /// tier (it is opened with `startFeatured`, which is what closes the round trip), and
    /// a `goalListId` the step must not trust.
    private static let editorBody: [String: JSONValue] = [
        "title": .string("Sunset walks"),
        "goalListId": .null,
        "goalType": .string("count"),
        "isFeatured": .bool(true),
        "targetValue": .double(30),
    ]

    /// Open the composer on whatever tab is showing, then hand back the editor's body —
    /// the two halves of one gesture. The group is captured from the composer the way the
    /// view does it (the editor dismisses itself on submit, so the flag is already gone
    /// by the time the write runs).
    private func makeGoal(
        _ model: PlanningGoalsStepModel,
        body: [String: JSONValue] = PlanningGoalsNewGoalTests.editorBody
    ) async {
        model.openNewGoal()
        guard let target = model.newForListId else {
            Issue.record("the composer refused to open")
            return
        }
        await model.submitNewGoal(sessionId: "session-1", listId: target, body: body)
    }

    @Test func theGoalIsMadeInTheGroupWhoseTabIsSelected() async throws {
        let feed = GoalsFeed(try GoalsFixture.decoded())
        let model = model(feed)
        await model.load(sessionId: "session-1")
        // DELIBERATELY NOT the tab the step lands on (that is `list-couple`, the only
        // unsettled group) — pick up the default and this test passes for the wrong reason.
        model.selectTab("list-family")

        // The composer takes the group from the TAB, never an argument — that is the whole
        // reason the goal cannot land in a list nobody was looking at.
        model.openNewGoal()
        #expect(model.newForListId == "list-family")
        let made = await model.submitNewGoal(
            sessionId: "session-1", listId: "list-family", body: Self.editorBody)

        #expect(made)
        #expect(feed.creates.count == 1)
        // The group is the HOST's answer, never the form's — a body that arrives with a
        // null (or with another group) must still land where the family was looking.
        #expect(feed.creates[0]["goalListId"] == .string("list-family"))
        // Pinned on the way in: that is what lets the server adopt it as the group's
        // focus on the way back (see `getGoalsStepView`) without a second trip.
        #expect(feed.creates[0]["isFeatured"] == .bool(true))
        // Everything else the editor said is passed through untouched.
        #expect(feed.creates[0]["title"] == .string("Sunset walks"))
        #expect(feed.creates[0]["targetValue"] == .double(30))
    }

    @Test func theGroupIsTheOnlyThingTheStepOverrules() {
        // The tier is the family's answer in the editor, not the step's — overriding it
        // would quietly undo an explicit choice. Only `goalListId` is the step's to
        // decide, because only the step asked whose focus this week is.
        let out = PlanningGoalsStepModel.newGoalBody(
            [
                "title": .string("Sunset walks"),
                // A body that names ANOTHER group is the failure mode this exists for.
                "goalListId": .string("list-lottie"),
                "isFeatured": .bool(false),
                "isSpotlight": .bool(true),
                "participantIds": .array([.string("p-kevin")]),
            ],
            listId: "list-family")

        #expect(out["goalListId"] == .string("list-family"))
        #expect(out["isFeatured"] == .bool(false))
        #expect(out["isSpotlight"] == .bool(true))
        #expect(out["title"] == .string("Sunset walks"))
        #expect(out["participantIds"] == .array([.string("p-kevin")]))
        #expect(out.count == 5)
    }

    @Test func theNewGoalShowsUpInThatGroupsListRatherThanVanishing() async throws {
        let feed = GoalsFeed(try GoalsFixture.decoded())
        feed.afterCreate = try GoalsFixture.decodedWithNewFamilyGoal()
        let model = model(feed)
        await model.load(sessionId: "session-1")
        model.selectTab("list-family")

        await makeGoal(model)

        // A refetch happened…
        #expect(feed.fetchCount == 2)
        // …the family tab is still the one on screen…
        #expect(model.active?.listId == "list-family")
        // …and the goal they just made is in it, pickable as the week's focus.
        let onScreen = model.active?.goals.map(\.goal.id) ?? []
        #expect(onScreen.contains("goal-sunset"))
        // The sheet flag is cleared, so the composer doesn't reopen itself.
        #expect(model.newForListId == nil)
        #expect(model.creating == false)
    }

    @Test func makingAGoalIsNotTheSameAsConfirmingItForTheWeek() async throws {
        // Creating a goal is not the family deciding it — the tab stays unstarred until
        // they say so, so this must NOT call `/goals/focus`.
        let feed = GoalsFeed(try GoalsFixture.decoded())
        let model = model(feed)
        await model.load(sessionId: "session-1")
        model.selectTab("list-couple")

        await makeGoal(model)

        #expect(feed.creates.count == 1)
        #expect(feed.writes.isEmpty)
        let couple = model.groups.first(where: { $0.listId == "list-couple" })
        #expect(couple?.settled == false)
        #expect(model.settledCount == 2)
    }

    @Test func aRefetchThatFailsAfterTheGoalWasSavedKeepsTheLastGoodGroups() async throws {
        // The goal IS saved by this point. Blanking the step — or pushing a crumb built
        // on nothing — would be a far worse failure than simply not seeing it yet.
        let feed = GoalsFeed(try GoalsFixture.decoded())
        let model = model(feed)
        await model.load(sessionId: "session-1")
        let revBefore = model.rev
        feed.fetchFails = true

        await makeGoal(model)

        #expect(feed.creates.count == 1)
        #expect(model.groups.count == 3)
        #expect(model.groups[0].focusGoalId == "goal-read")
        // No bump means no crumb is pushed off a read that never landed.
        #expect(model.rev == revBefore)
        // A saved goal must not leave a stuck sheet flag behind.
        #expect(model.newForListId == nil)
        #expect(model.creating == false)
    }

    @Test func aCreateThatFailsSaysSoAndChangesNothing() async throws {
        let feed = GoalsFeed(try GoalsFixture.decoded())
        feed.createFails = true
        let model = model(feed)
        await model.load(sessionId: "session-1")

        model.openNewGoal()
        let made = await model.submitNewGoal(
            sessionId: "session-1", listId: "list-couple", body: Self.editorBody)

        // The view gates `props.refresh()` on this: refreshing over a goal that never
        // saved flips the shell busy and greys the step out, which is a second, false
        // failure on top of the banner.
        #expect(made == false)
        #expect(model.errorMessage != nil)
        // No refetch after a failed write — the last good answer stays on screen.
        #expect(feed.fetchCount == 1)
        #expect(model.newForListId == nil)
        // And the step is usable again rather than frozen for good.
        #expect(model.isFrozen(shellBusy: false) == false)
    }

    @Test func aSubmitNamingAGroupTheStepDoesNotHaveCreatesNothing() async throws {
        // The group is captured when the editor opens, so a refetch that dropped that
        // list (deleted, or made private) mid-compose must not create a goal into it —
        // that goal would exist somewhere the family cannot see, which is the same
        // "it vanished" failure by another route.
        let feed = GoalsFeed(try GoalsFixture.decoded())
        let model = model(feed)
        await model.load(sessionId: "session-1")

        let made = await model.submitNewGoal(
            sessionId: "session-1", listId: "list-that-went-away", body: Self.editorBody)

        #expect(made == false)
        #expect(feed.creates.isEmpty)
        #expect(model.creating == false)
    }

    @Test func thereIsNothingToOpenWhenTheStepHasNoGroups() async throws {
        // A read that failed (or a household with no goal lists) has no group to create
        // in — the composer must refuse to open rather than open group-less.
        let feed = GoalsFeed(try GoalsFixture.decoded())
        feed.fetchFails = true
        let model = model(feed)
        await model.load(sessionId: "session-1")

        model.openNewGoal()

        #expect(model.newForListId == nil)
        #expect(model.newGoalGroup == nil)
    }

    // MARK: whose group you may add to

    @Test func aManagerMayAddToAnyGroupAndEveryoneElseOnlyToTheirOwn() throws {
        let groups = try GoalsFixture.decoded().groups
        let family = groups[0], lottie = groups[1], couple = groups[2]

        // `goal.manage` — the goals module's own rule — opens every group.
        for g in groups {
            #expect(PlanningGoalsStepModel.canTarget(
                g, canManageGoals: true, personId: "p-lottie"))
        }

        // Without it, only a group that is just you. Offering the editor for a group the
        // server would refuse is show-then-403.
        #expect(PlanningGoalsStepModel.canTarget(
            lottie, canManageGoals: false, personId: "p-lottie"))
        #expect(PlanningGoalsStepModel.canTarget(
            family, canManageGoals: false, personId: "p-lottie") == false)
        // Two people is not "just you", even when you are one of the two.
        #expect(PlanningGoalsStepModel.canTarget(
            couple, canManageGoals: false, personId: "p-kevin") == false)
        // Somebody else's individual list is not yours either.
        #expect(PlanningGoalsStepModel.canTarget(
            lottie, canManageGoals: false, personId: "p-kevin") == false)
        #expect(PlanningGoalsStepModel.canTarget(
            lottie, canManageGoals: false, personId: nil) == false)
    }

    // MARK: the group, in the shape the goals editor speaks

    @Test func theGroupHandedToTheEditorCarriesItsPeopleSoParticipantsFollowTheList() throws {
        // `GoalCreateSheet.submit()` derives `participantIds` from the list's members, so
        // dropping them here would create a goal nobody is a participant in.
        let couple = try GoalsFixture.decoded().groups[2]
        let list = couple.asGoalList

        #expect(list.id == "list-couple")
        #expect(list.name == "Us")
        #expect(list.emoji == "💛")
        #expect(list.goalCount == 1)
        #expect(list.members.map(\.personId) == ["p-kevin", "p-kelly"])
        #expect(list.members[1].name == "Kelly Sites")
        #expect(list.members[0].avatarEmoji == "🧔")
        #expect(list.members[1].colorHex == "#8A5CF0")
    }
}
