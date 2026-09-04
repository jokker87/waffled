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

    @Test func amountsAreFormattedRatherThanInterpolatedRaw() {
        // 1h5m logged in hours is 1.0833… — a raw interpolation prints the repeater.
        #expect(GoalDisplay.number(1.0 + 5.0 / 60.0) == "1.08")
        #expect(GoalDisplay.number(1.5) == "1.5")
        #expect(GoalDisplay.number(1000) == "1,000")
        #expect(GoalDisplay.number(nil) == "—")
    }
}
