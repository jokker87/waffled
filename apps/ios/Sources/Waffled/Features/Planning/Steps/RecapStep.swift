import SwiftUI

/// Weekly Planning · step 10 "Recap" — "Here's the week you just decided."
///
/// The week read back one last time, grouped by the module each decision lives in — every line a pointer to live data, never a copy.
///
/// **STUB.** The body has not been built yet, so it renders the shell's placeholder: the
/// chrome, the question, Skip and the affirmative all still work, and answering this step
/// is a real answer. The web implementation to port from is
/// `apps/web/src/kiosk/planning/steps/RecapStep.tsx`.
///
/// Owned by this file and this file alone — the registry in `PlanningStepSeam.swift`
/// already points here, so building this step means editing only its own files.
struct RecapStepView: View {
    let props: PlanningStepProps

    var body: some View {
        PlanningStepPlaceholder(step: props.step)
    }
}
