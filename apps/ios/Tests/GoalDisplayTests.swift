import Foundation
import Testing
@testable import Waffled

// The goal display AXIS: which number a goal is actually measured on.
//
// This is the iOS half of a rule the web has had for a while and iOS never got — the
// `Goal` DTO here didn't even decode `periodDone`, so every iOS surface showed habits
// their LIFETIME total. A habit at 340 lifetime reps reads as long-since-done when this
// week's honest answer is "2 of 5".
//
// Kept deliberately parallel to `apps/web/src/lib/api/goals.ts`, because two platforms
// each deciding this for themselves is how they drift.

@Suite struct GoalDisplayTests {

    private func goal(
        type: String,
        total: Double = 0,
        target: Double? = nil,
        habitTarget: Int? = nil,
        periodDone: Double? = nil,
        stepDone: Double? = nil,
        stepTotal: Double? = nil,
        targetBasis: String? = nil,
        participants: Int = 0
    ) -> WaffledAPI.Goal {
        var g = WaffledAPI.Goal(
            id: "g1", goalListId: nil, title: "T", emoji: nil, category: nil,
            goalType: type, unit: nil, habitPeriod: habitTarget == nil ? nil : "week",
            habitTargetPerPeriod: habitTarget, trackingMode: "shared",
            participantMode: nil, targetBasis: targetBasis, deadline: nil,
            isFeatured: false, isSpotlight: nil, target: target, totalProgress: total,
            milestoneTotal: 0, milestoneReached: 0, streakDays: 0,
            autoFromCalendar: false, healthMetric: nil, createdAt: nil,
            participants: (0..<participants).map {
                .init(personId: "p\($0)", name: "P\($0)", colorHex: nil, avatarEmoji: nil,
                      target: nil, progress: 0)
            }
        )
        g.periodDone = periodDone
        g.stepDone = stepDone
        g.stepTotal = stepTotal
        return g
    }

    @Test func aHabitReadsThisPeriodsCountNotItsLifetimeTotal() {
        // The bug this helper exists to stop: 340 lifetime reps against a target of 5.
        let g = goal(type: "habit", total: 340, habitTarget: 5, periodDone: 2)
        #expect(GoalDisplay.progress(g) == 2)
        #expect(GoalDisplay.target(g) == 5)
        #expect(GoalDisplay.fraction(g) == 0.4)
    }

    @Test func aHabitWithNoPeriodFigureShowsZeroNotTheLifetimeTotal() {
        // An older response omits `periodDone`. Falling back to `totalProgress` would
        // reintroduce the exact defect, so the fallback is 0.
        let g = goal(type: "habit", total: 340, habitTarget: 5)
        #expect(GoalDisplay.progress(g) == 0)
    }

    @Test func aChecklistIsMeasuredInSteps() {
        let g = goal(type: "checklist", total: 99, stepDone: 3, stepTotal: 4)
        #expect(GoalDisplay.progress(g) == 3)
        #expect(GoalDisplay.target(g) == 4)
        #expect(GoalDisplay.fraction(g) == 0.75)
    }

    @Test func anEmptyChecklistHasNoTargetRatherThanATargetOfZero() {
        let g = goal(type: "checklist", stepDone: 0, stepTotal: 0)
        #expect(GoalDisplay.target(g) == nil)
        // …and nothing divides by it.
        #expect(GoalDisplay.fraction(g) == 0)
    }

    @Test func everythingElseIsGenuinelyALifetimeNumber() {
        let g = goal(type: "amount", total: 12, target: 20)
        #expect(GoalDisplay.progress(g) == 12)
        #expect(GoalDisplay.target(g) == 20)
    }

    @Test func aPerPersonTargetGrowsWithTheHousehold() {
        // "Read 12 EACH" across four people is a ring of 48, matching the goals list.
        let g = goal(type: "amount", total: 0, target: 12, targetBasis: "per_person", participants: 4)
        #expect(GoalDisplay.target(g) == 48)
    }

    @Test func aPerPersonTargetNeverDividesByZeroPeople() {
        let g = goal(type: "amount", target: 12, targetBasis: "per_person", participants: 0)
        #expect(GoalDisplay.target(g) == 12)
    }

    @Test func fractionIsClampedSoOvershootDoesNotOverflowARing() {
        let g = goal(type: "habit", habitTarget: 5, periodDone: 9)
        #expect(GoalDisplay.fraction(g) == 1)
    }

    // MARK: - the GoalDetail overload
    //
    // There are two goal DTOs and one axis rule. The overloads are three-line
    // delegations, which is exactly the shape where a swapped argument (periodDone for
    // stepDone) compiles fine and shows the wrong number forever — so they get their own
    // tests, decoded from bytes rather than hand-built.

    private func detailJSON(type: String, total: Double, habitTarget: Int?,
                            periodDone: Double?, stepDone: Double?, stepTotal: Double?) -> Data {
        func num(_ d: Double?) -> String { d.map { "\($0)" } ?? "null" }
        let json = """
        {"id":"g1","goalListId":null,"title":"T","emoji":null,"category":null,
         "goalType":"\(type)","unit":null,"target":null,"trackingMode":"shared",
         "participantMode":null,"targetBasis":null,"habitPeriod":null,
         "habitTargetPerPeriod":\(habitTarget.map { "\($0)" } ?? "null"),
         "isFeatured":false,"isSpotlight":null,"hasRewards":false,
         "totalProgress":\(total),"periodDone":\(num(periodDone)),
         "stepDone":\(num(stepDone)),"stepTotal":\(num(stepTotal)),
         "streakDays":0,"deadline":null,"createdAt":"2026-01-01T00:00:00.000Z",
         "thisWeek":0,"autoFromCalendar":false,"healthMetric":null,"healthDailyTarget":null,
         "participants":[],"milestones":[],"steps":[],"recent":[]}
        """
        return Data(json.utf8)
    }

    @Test func aHabitsDETAILScreenAlsoReadsThisPeriodsCount() {
        let d = try! WaffledAPI.decoder.decode(
            WaffledAPI.GoalDetail.self,
            from: detailJSON(type: "habit", total: 340, habitTarget: 5,
                             periodDone: 2, stepDone: 99, stepTotal: 99))
        // 2, not 340 — and not 99, which is what a swapped argument would produce.
        #expect(GoalDisplay.progress(d) == 2)
        #expect(GoalDisplay.target(d) == 5)
        #expect(GoalDisplay.fraction(d) == 0.4)
    }

    @Test func aChecklistsDETAILScreenIsMeasuredInSteps() {
        let d = try! WaffledAPI.decoder.decode(
            WaffledAPI.GoalDetail.self,
            from: detailJSON(type: "checklist", total: 99, habitTarget: nil,
                             periodDone: 77, stepDone: 3, stepTotal: 4))
        // 3 of 4 — 77 is `periodDone`, which the checklist arm must not reach for.
        #expect(GoalDisplay.progress(d) == 3)
        #expect(GoalDisplay.target(d) == 4)
    }

    @Test func aDetailResponseMissingTheAxisFieldsStillDecodes() {
        // The fields are optional on purpose: an older/cached response must not fail to
        // decode, which on this app surfaces as a bogus "couldn't reach server".
        let json = """
        {"id":"g1","goalListId":null,"title":"T","emoji":null,"category":null,
         "goalType":"amount","unit":null,"target":20,"trackingMode":"shared",
         "participantMode":null,"targetBasis":null,"habitPeriod":null,
         "habitTargetPerPeriod":null,"isFeatured":false,"isSpotlight":null,
         "hasRewards":false,"totalProgress":12,"streakDays":0,"deadline":null,
         "createdAt":"2026-01-01T00:00:00.000Z","thisWeek":0,"autoFromCalendar":false,
         "healthMetric":null,"healthDailyTarget":null,
         "participants":[],"milestones":[],"steps":[],"recent":[]}
        """
        let d = try! WaffledAPI.decoder.decode(WaffledAPI.GoalDetail.self, from: Data(json.utf8))
        #expect(d.periodDone == nil)
        #expect(GoalDisplay.progress(d) == 12)
    }

    @Test func amountsAreFormattedRatherThanInterpolatedRaw() {
        // 1h5m logged in hours is 1.0833… — a raw interpolation prints the repeater.
        #expect(GoalDisplay.number(1.0 + 5.0 / 60.0) == "1.08")
        #expect(GoalDisplay.number(1.5) == "1.5")
        #expect(GoalDisplay.number(1000) == "1,000")
        #expect(GoalDisplay.number(nil) == "—")
    }
}
