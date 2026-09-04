import SwiftUI

/// Weekly Planning · step 4 "Family night" — "Accept the rotation, or change it?"
///
/// The rotation's suggestion per part, pinnable for this week only, a line for what each part actually is, and this week on the calendar.
///
/// **STUB.** The body has not been built yet, so it renders the shell's placeholder: the
/// chrome, the question, Skip and the affirmative all still work, and answering this step
/// is a real answer. The web implementation to port from is
/// `apps/web/src/kiosk/planning/steps/FamilyNightStep.tsx`.
///
/// Owned by this file and this file alone — the registry in `PlanningStepSeam.swift`
/// already points here, so building this step means editing only its own files.
struct FamilyNightStepView: View {
    let props: PlanningStepProps

    var body: some View {
        PlanningStepPlaceholder(step: props.step)
    }
}
