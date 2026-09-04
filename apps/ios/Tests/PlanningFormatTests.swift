import Foundation
import Testing
@testable import Waffled

// Weekly Planning's pure functions.
//
// These are a port of `apps/web/src/lib/api/weeklyPlanning.ts`, and the point of testing
// them here rather than trusting the port is that two platforms disagreeing about "which
// step is on screen" means a session resumed on the iPad lands somewhere else than the
// same session on the phone.

@Suite struct PlanningFormatTests {

    // Fixtures go through the REAL decoder, from bytes, rather than being built by hand.
    // That way they also prove the DTO decodes the shape the server actually sends —
    // including `requiresModule` being ABSENT rather than null on five of the ten steps,
    // which a hand-built struct would never exercise.
    private func stepJSON(
        _ key: String, _ number: Int, act: String = "Frame the week",
        available: Bool = true, status: String = "pending"
    ) -> String {
        """
        {"key":"\(key)","number":\(number),"title":"\(key)","ask":"?","primary":"OK",
         "act":"\(act)","available":\(available),"status":"\(status)","data":{},
         "decidedAt":null,"parked":[]}
        """
    }

    private func step(
        _ key: String, _ number: Int, act: String = "Frame the week",
        available: Bool = true, status: String = "pending"
    ) -> WaffledAPI.PlanningStep {
        let json = stepJSON(key, number, act: act, available: available, status: status)
        return try! WaffledAPI.decoder.decode(WaffledAPI.PlanningStep.self, from: Data(json.utf8))
    }

    private func view(
        steps: [String], currentStep: String? = nil, weekStart: String = "2026-09-06"
    ) -> WaffledAPI.WeeklyPlanningView {
        let session = currentStep.map {
            """
            {"id":"s1","weekStart":"\(weekStart)","status":"active","currentStep":"\($0)",
             "driverPersonId":null,"startedAt":"2026-09-06T17:00:00.000Z","completedAt":null}
            """
        } ?? "null"
        let json = """
        {"config":{"dayOfWeek":0,"time":"17:00","steps":{},"showOnToday":true},
         "weekStart":"\(weekStart)","defaultWeekStart":"\(weekStart)","minWeekStart":"2026-08-30",
         "session":\(session),
         "steps":[\(steps.joined(separator: ","))]}
        """
        return try! WaffledAPI.decoder.decode(WaffledAPI.WeeklyPlanningView.self, from: Data(json.utf8))
    }

    // MARK: - availability

    @Test func anUnavailableStepIsNeverOfferedOrCounted() {
        let steps = [step("looseEnds", 1), step("meals", 2, available: false), step("kids", 2)]
        #expect(PlanningFormat.availableSteps(steps).map(\.key) == ["looseEnds", "kids"])
    }

    // MARK: - stepsByAct

    @Test func actsGroupConsecutiveRunsWithoutHardcodingTheActNames() {
        let steps = [
            step("looseEnds", 1, act: "Intake"),
            step("calendar", 2, act: "Frame the week"),
            step("horizon", 3, act: "Frame the week"),
            step("recap", 4, act: "Close"),
        ]
        let groups = PlanningFormat.stepsByAct(steps)
        #expect(groups.map(\.act) == ["Intake", "Frame the week", "Close"])
        #expect(groups[1].steps.map(\.key) == ["calendar", "horizon"])
    }

    @Test func twoSeparatedRunsOfOneActStaySeparate() {
        // Consecutive runs only — collapsing them would reorder the agenda sheet away
        // from the catalog's own order.
        let steps = [step("a", 1, act: "X"), step("b", 2, act: "Y"), step("c", 3, act: "X")]
        #expect(PlanningFormat.stepsByAct(steps).map(\.act) == ["X", "Y", "X"])
    }

    @Test func anUnavailableStepDoesNotSplitAnActInTwo() {
        let steps = [
            step("calendar", 1, act: "Frame the week"),
            step("meals", 2, act: "Frame the week", available: false),
            step("horizon", 2, act: "Frame the week"),
        ]
        let groups = PlanningFormat.stepsByAct(steps)
        #expect(groups.count == 1)
        #expect(groups[0].steps.map(\.key) == ["calendar", "horizon"])
    }

    // MARK: - resolveCurrent

    @Test func theStepAskedForWinsOverTheSessionsOwnPointer() {
        let v = view(steps: [stepJSON("looseEnds", 1), stepJSON("goals", 2)], currentStep: "looseEnds")
        #expect(PlanningFormat.resolveCurrent(v, asked: "goals")?.key == "goals")
    }

    @Test func withNothingAskedForItResumesWhereTheSessionWasLeft() {
        // This is what lets another device pick a session up mid-way.
        let v = view(steps: [stepJSON("looseEnds", 1), stepJSON("goals", 2)], currentStep: "goals")
        #expect(PlanningFormat.resolveCurrent(v)?.key == "goals")
    }

    @Test func anUnavailableStepNeverStrandsTheSessionOnABlankScreen() {
        // The module behind the pointer was switched off mid-week, or somebody deep-linked
        // a step this household doesn't run. Falling through to the first runnable step is
        // the whole reason the chain has three links.
        let v = view(steps: [stepJSON("looseEnds", 1), stepJSON("meals", 2, available: false)], currentStep: "meals")
        #expect(PlanningFormat.resolveCurrent(v, asked: "meals")?.key == "looseEnds")
    }

    @Test func aViewWithNoRunnableStepsResolvesToNothingRatherThanCrashing() {
        let v = view(steps: [stepJSON("meals", 1, available: false)])
        #expect(PlanningFormat.resolveCurrent(v) == nil)
    }

    @Test func noViewAtAllResolvesToNothing() {
        #expect(PlanningFormat.resolveCurrent(nil) == nil)
    }

    // MARK: - nextStepAfter

    @Test func nextSkipsOverAnUnavailableStep() {
        let steps = [step("calendar", 1), step("meals", 2, available: false), step("kids", 2)]
        #expect(PlanningFormat.nextStepAfter(steps, key: "calendar")?.key == "kids")
    }

    @Test func theLastStepHasNoNext() {
        #expect(PlanningFormat.nextStepAfter([step("recap", 1)], key: "recap") == nil)
    }

    // MARK: - addWeeks

    @Test func weeksStepForwardAndBack() {
        #expect(PlanningFormat.addWeeks("2026-09-06", 1) == "2026-09-13")
        #expect(PlanningFormat.addWeeks("2026-09-06", -1) == "2026-08-30")
        #expect(PlanningFormat.addWeeks("2026-09-06", 0) == "2026-09-06")
    }

    @Test func weeksStepAcrossAMonthAndAYearBoundary() {
        #expect(PlanningFormat.addWeeks("2026-12-27", 1) == "2027-01-03")
    }

    @Test func weeksDoNotDriftAcrossADaylightSavingBoundary() {
        // THE REASON THIS IS UTC. US DST ends 2026-11-01. Parsing a week start in the
        // device's zone and adding 7×86400 seconds lands on the Saturday or the Monday,
        // and a week start that is off by a day silently addresses the wrong session.
        #expect(PlanningFormat.addWeeks("2026-10-25", 1) == "2026-11-01")
        #expect(PlanningFormat.addWeeks("2026-11-01", 1) == "2026-11-08")
        // …and spring forward, 2026-03-08.
        #expect(PlanningFormat.addWeeks("2026-03-01", 1) == "2026-03-08")
        #expect(PlanningFormat.addWeeks("2026-03-08", 1) == "2026-03-15")
    }

    @Test func aWeekStartThatIsNotADateComesBackUnchangedRatherThanCrashing() {
        #expect(PlanningFormat.addWeeks("not-a-date", 1) == "not-a-date")
    }

    // MARK: - labels

    @Test func theDayNameWrapsSafelyForAnythingOutOfRange() {
        #expect(PlanningFormat.planningDayName(0) == "Sunday")
        #expect(PlanningFormat.planningDayName(6) == "Saturday")
        #expect(PlanningFormat.planningDayName(7) == "Sunday")
        #expect(PlanningFormat.planningDayName(-1) == "Saturday")
    }

    @Test func theWeekLabelSpansSevenDaysInclusive() {
        #expect(PlanningFormat.weekLabel("2026-09-06") == "6 Sun – 12 Sat")
    }

    // MARK: - progress

    @Test func progressCountsSettledStepsEitherWaySinceASkipIsARealAnswer() {
        let steps = [
            step("a", 1, status: "done"),
            step("b", 2, status: "skipped"),
            step("c", 3, status: "pending"),
            step("d", 4, status: "pending"),
        ]
        #expect(PlanningFormat.fraction(steps) == 0.5)
    }

    @Test func progressIgnoresUnavailableStepsEntirely() {
        let steps = [step("a", 1, status: "done"), step("b", 2, available: false)]
        #expect(PlanningFormat.fraction(steps) == 1)
    }

    @Test func aSessionWithNoRunnableStepsIsZeroNotADivideByZero() {
        #expect(PlanningFormat.fraction([step("a", 1, available: false)]) == 0)
    }
}
