import SwiftUI

/// The Meals step's extra footer control — the one step that contributes one.
///
/// On the web this is "✨ Plan the rest for me", which becomes "Undo the three" once it
/// has filled the empty nights. It lives in the shell's footer beside Skip and the
/// affirmative, which is why it is a separate view from the step body.
///
/// **STUB.** Contributes nothing until the Meals step is built.
struct MealsStepFooterExtra: View {
    let props: PlanningStepProps

    var body: some View {
        EmptyView()
    }
}
