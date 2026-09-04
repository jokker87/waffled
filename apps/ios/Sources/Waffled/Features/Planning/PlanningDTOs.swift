import Foundation

// Weekly Planning — the shell's wire types.
//
// THE STEP CATALOG IS SERVER-OWNED. The ten keys, their titles, the one question each
// asks, the affirmative button's label and the `act` they group under all arrive in the
// view. iOS renders what it is given and hardcodes none of it: a household with meals
// switched off gets nine steps and a counter that reads "3 of 9", and that arithmetic is
// the server's, not ours.
//
// Property names are camelCase and 1:1 with the server because `WaffledAPI.decoder` is a
// plain `JSONDecoder` with no key strategy. Every date is a `String` for the same reason
// — there is no date strategy either, and `weekStart` is a household-local `YYYY-MM-DD`
// that must never go near a `Date` round-trip on the device.
extension WaffledAPI {

    /// A parked note handed to the step it was tagged for. Capped server-side: a nudge,
    /// not an inbox.
    struct PlanningStepHandoff: Decodable, Identifiable, Hashable, Sendable {
        let id: String
        let note: String
        /// "Kevin · 2 weeks ago" — composed server-side so web and iOS say it the same way.
        let byline: String?
    }

    // Equatable, NOT Hashable: `data` is [String: JSONValue] and JSONValue is Equatable
    // only, so Hashable cannot be synthesized. `Identifiable` is what ForEach needs, and
    // `step.key` is the right thing to key a .task(id:) on anyway.
    struct PlanningStep: Decodable, Identifiable, Equatable, Sendable {
        let key: String
        /// 1-based position in the CATALOG — `i + 1` over all ten steps, including the
        /// ones this household doesn't run.
        ///
        /// ⚠️ THIS IS NOT THE "2 of 9" THE COUNTER SHOWS, and an earlier version of this
        /// comment claimed it was. A household with meals off would render "4 of 9" with
        /// no step 3 anywhere, because the number skips the unavailable step while the
        /// total counts only runnable ones. The web has never used it for the counter
        /// either — `WeeklyPlanning.tsx` computes `runnable.findIndex(...) + 1`. Derive
        /// the position from the runnable list (see `PlanningFormat.position`); use this
        /// field only when you genuinely want the catalog slot.
        let number: Int
        let title: String
        /// The one question the step asks, shown in the chrome beside the title.
        let ask: String
        /// The affirmative button's label for this step ("Looks right", "Handed out").
        let primary: String
        /// The phase this step groups under in the agenda sheet ("Frame the week").
        let act: String
        /// Absent on five of the ten steps — a step with no module behind it.
        let requiresModule: String?
        /// False when the module this step reads is off, or the household turned the step
        /// off. An unavailable step is skipped and never counted.
        let available: Bool
        /// "pending" | "done" | "skipped".
        let status: String
        /// The step's crumb. Free-form by design, so it stays `JSONValue` rather than
        /// being modelled per step — a step reads its own keys out of it.
        let data: [String: JSONValue]
        let decidedAt: String?
        /// Notes parked FOR this step. `?? []` at every read site: a payload missing the
        /// field must cost the banner, never the session screen.
        let parked: [PlanningStepHandoff]?

        var id: String { key }
        var isDone: Bool { status == "done" }
        var isSkipped: Bool { status == "skipped" }
        /// Answered either way — done or deliberately skipped. Both are real answers.
        var isSettled: Bool { status != "pending" }
    }

    struct PlanningSession: Decodable, Identifiable, Hashable, Sendable {
        let id: String
        let weekStart: String
        /// "active" | "completed".
        let status: String
        /// Where this session was last left — what lets another device pick it up.
        let currentStep: String?
        let driverPersonId: String?
        let startedAt: String
        let completedAt: String?

        var isActive: Bool { status == "active" }
        var isCompleted: Bool { status == "completed" }
    }

    struct WeeklyPlanningConfig: Decodable, Hashable, Sendable {
        /// 0 = Sunday … 6 = Saturday. Drives the "session due" prompt; it does NOT decide
        /// which week is planned — the server does that.
        let dayOfWeek: Int
        /// "HH:MM", household-local.
        let time: String
        /// Per-step opt-out keyed by catalog key. Absent ⇒ on. A step whose module is off
        /// is unavailable regardless of what is in here.
        let steps: [String: Bool]
        let showOnToday: Bool
    }

    struct WeeklyPlanningView: Decodable, Sendable {
        let config: WeeklyPlanningConfig
        /// The week this view is about — snapped and floored by the server. ECHO IT; never
        /// compute a week on the device (`Cal.weekStart` needs the household's first day,
        /// which is `nil` for an unbounded window while PowerSync is disconnected, and
        /// planning runs entirely over REST).
        let weekStart: String
        /// The week a fresh session would plan — today's week if today IS the week-start
        /// day, otherwise the week ahead.
        let defaultWeekStart: String
        /// The earliest week the stepper may reach: the household's CURRENT week. A week
        /// that has finished cannot be planned.
        let minWeekStart: String
        let session: PlanningSession?
        let steps: [PlanningStep]
    }
}
