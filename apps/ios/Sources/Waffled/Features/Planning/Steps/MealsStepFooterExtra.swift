import SwiftUI

/// The Meals step's extra footer control — the one step that contributes one.
///
/// ONE CONTROL, IN THE SAME SLOT BEFORE AND AFTER: "✨ Plan the rest for me" becomes
/// "Undo the three" the moment it has filled the empty nights. It sits in the shell's
/// footer beside Skip and the affirmative, which is why it is a separate view from the
/// step body — and why the state it shares with that body lives in
/// `PlanningMealsStepStore` rather than in either view's `@State`. See that store's own
/// comment for why a module-scoped, session+week-keyed slot is the right shape (the web's
/// `MealsStep.tsx` does the same thing for the same reason).
///
/// THIS BUTTON WRITES NOTHING. It opens the shared "Plan my week" planner — the same
/// screen the Meals tab uses, narrowed to the empty nights — and the approved week is
/// applied from there through the step's own fill endpoint. It does NOT draft a week
/// silently, and that is a fix rather than a preference: the port had it fire the headless
/// fill, so the one AI action on the step had no screen and reported as "plan the rest AI
/// didn't bring up the screen".
///
/// THE PLANNER IS PRESENTED BY THE BODY, NOT FROM HERE. `plannerOpen` is on the shared
/// model for the same reason the rest of this step's state is: the shell builds the body
/// and this footer as two sibling trees, so a `.sheet` hung off this view would be a
/// presentation attached to a control that legitimately disappears the moment the fill
/// lands (this body renders NOTHING until the week is read, and swaps to the undo after).
/// The web says the same thing about the same field.
struct MealsStepFooterExtra: View {
    let props: PlanningStepProps

    /// Resolved from the shared store on every body pass — the SAME model the body reads.
    /// It is `@Observable`, so this view invalidates when the fill lands even though the
    /// fill happens from here and the ✨ appears over there.
    private var model: PlanningMealsModel {
        PlanningMealsStepStore.shared.model(sessionId: props.sessionId, weekStart: props.weekStart)
    }

    var body: some View {
        // NO `.task` HERE, deliberately: the body owns the fetching. The shell rebuilds
        // its footer on every `busy` change, so a read hung off this view would re-fire
        // through the whole session.
        if model.view != nil {
            if model.filled.isEmpty {
                fillButton
            } else {
                undoButton
            }
        }
    }

    private var fillButton: some View {
        let empties = model.emptyDates.count
        return Button {
            // ONE THING ONLY: raise the planner. The write happens when the family
            // approves a week in it (`MealsStepView` presents it; `applyPlan` sends it).
            model.openPlanner()
        } label: {
            HStack(spacing: 5) {
                if model.busy {
                    ProgressView().controlSize(.small).tint(WF.ai)
                } else {
                    Text("✨").font(.system(size: 13))
                }
                // "Plan the rest", not the web's "Plan the rest for me": the shell's footer
                // is Skip + this + the affirmative ("Looks right · next: Recap") in one
                // phone-width row, and the longer label truncates mid-word there. The
                // scale factor is the belt — a control that reads "Plan the rest for…" is
                // worse than a slightly smaller one.
                Text("Plan the rest")
                    .font(.system(size: 13.5, weight: .bold)).foregroundStyle(WF.aiD)
                    .lineLimit(1).minimumScaleFactor(0.85)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(WF.ai.opacity(0.10)).clipShape(Capsule())
        }
        .buttonStyle(.plain)
        // Nothing to fill is not an error, so the control states it rather than lying:
        // every night is planned, and the button simply cannot do anything.
        .disabled(props.busy || model.busy || empties == 0)
        .opacity(empties == 0 ? 0.5 : 1)
        .accessibilityLabel(
            empties == 0 ? "Every night is planned" : PlanningMealsText.fillTitle(empties: empties))
    }

    private var undoButton: some View {
        Button {
            Task {
                if await model.undoTheFill(weekStart: props.weekStart) { props.refresh() }
            }
        } label: {
            HStack(spacing: 6) {
                if model.busy { ProgressView().controlSize(.small).tint(WF.ink3) }
                // "Undo the three" — the design's own phrasing, so small counts read as
                // words rather than as digits.
                Text("Undo the \(PlanningMealsText.countWord(model.filled.count))")
                    .font(.system(size: 13.5, weight: .bold)).foregroundStyle(WF.ink3)
                    .lineLimit(1).minimumScaleFactor(0.85)
            }
        }
        .buttonStyle(.plain)
        .disabled(props.busy || model.busy)
    }
}
