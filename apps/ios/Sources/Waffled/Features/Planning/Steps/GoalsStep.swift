import SwiftUI

/// Weekly Planning · step 6 "Goals" — "What's each group's focus this week?"
///
/// A tab per goal list, focus set through the existing featured flag. Progress goes through `GoalDisplay` — never `totalProgress` directly.
///
/// **STUB.** The body has not been built yet, so it renders the shell's placeholder: the
/// chrome, the question, Skip and the affirmative all still work, and answering this step
/// is a real answer. The web implementation to port from is
/// `apps/web/src/kiosk/planning/steps/GoalsStep.tsx`.
///
/// Owned by this file and this file alone — the registry in `PlanningStepSeam.swift`
/// already points here, so building this step means editing only its own files.
struct GoalsStepView: View {
    let props: PlanningStepProps

    var body: some View {
        PlanningStepPlaceholder(step: props.step)
    }
}
