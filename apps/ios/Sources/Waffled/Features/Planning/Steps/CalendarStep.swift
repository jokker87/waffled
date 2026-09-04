import SwiftUI

/// Weekly Planning · step 2 "Calendar" — "Here's your week. Anything missing?"
///
/// The real week, with add-in-place on a tapped day. Reads the ordinary calendar; there is no planning-only event store.
///
/// **STUB.** The body has not been built yet, so it renders the shell's placeholder: the
/// chrome, the question, Skip and the affirmative all still work, and answering this step
/// is a real answer. The web implementation to port from is
/// `apps/web/src/kiosk/planning/steps/CalendarStep.tsx`.
///
/// Owned by this file and this file alone — the registry in `PlanningStepSeam.swift`
/// already points here, so building this step means editing only its own files.
struct CalendarStepView: View {
    let props: PlanningStepProps

    var body: some View {
        PlanningStepPlaceholder(step: props.step)
    }
}
