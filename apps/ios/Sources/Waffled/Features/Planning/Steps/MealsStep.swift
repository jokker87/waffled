import SwiftUI

/// Weekly Planning · step 7 "Meals" — "What's planned, and what's still open?"
///
/// Dinners in the same seven columns, fill-only-the-empties with undo, and the shopping trip assignable as a real chore.
///
/// **STUB.** The body has not been built yet, so it renders the shell's placeholder: the
/// chrome, the question, Skip and the affirmative all still work, and answering this step
/// is a real answer. The web implementation to port from is
/// `apps/web/src/kiosk/planning/steps/MealsStep.tsx`.
///
/// Owned by this file and this file alone — the registry in `PlanningStepSeam.swift`
/// already points here, so building this step means editing only its own files.
struct MealsStepView: View {
    let props: PlanningStepProps

    var body: some View {
        PlanningStepPlaceholder(step: props.step)
    }
}
