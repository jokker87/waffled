import SwiftUI

// THE CONTRACT BETWEEN THE SHELL AND A STEP.
//
// The shell owns the chrome — step counter, title, the one question, the week label, the
// progress hair, "Leave for now", Skip and the affirmative — and each step owns only what
// goes between them. This file is the single place the two meet: all ten keys point at all
// ten view types, so building a step means editing that step's own files and nothing else.
//
// Web parity with `planning/registry.ts`, which does the same job with lazy imports; the
// Swift equivalent is that a `switch` in a `@ViewBuilder` builds only the arm it takes.

/// What every step body is handed.
struct PlanningStepProps {
    let step: WaffledAPI.PlanningStep
    let sessionId: String

    /// The week being planned (`YYYY-MM-DD`, a household week start).
    ///
    /// ALWAYS USE THIS rather than computing a week on the device. The server owns the
    /// boundary — and `SyncManager.householdWeekStart` is genuinely `nil` for an
    /// unbounded window while PowerSync is disconnected, which planning does not care
    /// about because it runs entirely over REST. A step that derived its own week would
    /// be right on the web and wrong here.
    let weekStart: String

    /// Attach the crumb this step wants kept on the session record ("3 nights were
    /// auto-filled and can still be undone"). `nil` clears it.
    ///
    /// NEVER A COPY OF MODULE DATA. The recap reads through to the modules that own each
    /// decision, so duplicating an event's title or hour here just gives the two
    /// something to disagree about.
    ///
    /// IT IS ONLY PERSISTED WHEN THE STEP IS ANSWERED. The shell holds it until Skip or
    /// the affirmative sends it, so a step that is used and then walked away from loses
    /// it. Never make it the authority for anything the step must find again on a second
    /// visit — read that back from the module that owns it, and treat the crumb as a hint
    /// at most. A step needing a mid-step write calls its own route (Goals' `/goals/focus`
    /// and Connection's `/connection/links` both exist for exactly this).
    let setDecisionData: ([String: JSONValue]?) -> Void

    /// Re-read the session view. Call it after writing into another module so the counter
    /// and the agenda sheet agree with what just happened.
    let refresh: () -> Void

    /// A write is in flight somewhere in the shell — disable your own controls.
    let busy: Bool

    /// WHAT STEP 1 ROUTED, and why it is handed down here rather than read off
    /// `step.data`.
    ///
    /// Routing a loose end at step 1 appends to `data.routes` on the **looseEnds** step's
    /// own row (`looseEnds.ts`), because that is the step whose decision it is. A body is
    /// handed only its OWN step, so a destination step reading `step.data["routes"]` finds
    /// nothing — it is not its data. The shell has the whole `steps` array, so it is the
    /// only place that can pass this across.
    ///
    /// NOT read by any step body — the SHELL hands this to `PlanningHandoffBanner`, which
    /// filters it (`PlanningRouteSeed.sentHere`) and shows routed items in the same top box
    /// as parked notes. It stays on the props because that is how it reaches the shell's
    /// banner for the step on screen; a step body wanting it would be a design mistake.
    ///
    /// It used to be filtered per-step and drawn in each body's own trailing section, which
    /// is exactly the bug that moved it: "wouldnt these be in the top 'parked things' box?
    /// why are they hidden at the bottom?" Worse, a routed PARKED note arrived through both
    /// doors at once — `routeLooseEnd` sets `planning_parked_items.step_key` too — so the
    /// bottom section was a duplicate of the top box, not merely a stray. Empty is the
    /// normal case.
    ///
    /// NOTE FOR PARITY: the web does not surface these on the destination step at all —
    /// routing is a record of triage there, and only step 1 reads it back. iOS showing
    /// them is the same fix the parked-note handoff was ("I routed it and never saw it
    /// again"), so this is iOS briefly AHEAD, recorded as a web follow-up rather than an
    /// accident.
    let routes: [WaffledAPI.LooseEndRoute]

    /// Show another step. The recap's rows use it — each names the step whose module owns
    /// that decision, and following one should land you there.
    ///
    /// It does NOT move the session's `currentStep`: that is the cross-device resume
    /// pointer, and the web's equivalent is a link that changes the address and nothing
    /// else. Following a recap row must not tell another device the family went back.
    let goToStep: (String) -> Void

    /// Lend the shell's parked-note banner this step's own verb, or `nil` to withdraw it.
    ///
    /// The banner belongs to the shell (it is identical on ten steps, and the shell is
    /// what refetches after a write), but its only answers on their own are bookkeeping:
    /// "Handled" and "Drop it". A step that HAS a composer lends the banner one verb —
    /// "Make a task", "Make an event" — which opens that step's own composer seeded with
    /// the note's words.
    ///
    /// A STEP WITHOUT A COMPOSER LENDS NOTHING and the banner keeps saying "Handled".
    /// That is the important half: a button reading "Make a goal" that only ticks the note
    /// off promises an action it does not perform, which is worse than the plain one.
    let lendVerb: (PlanningHandoffVerb?) -> Void

    /// Tell the shell a write THIS STEP owns is in flight, so Skip and the affirmative go
    /// cold until it lands.
    ///
    /// `busy` above flows the other way — it is the SHELL's own writes. A step's writes were
    /// invisible to the chrome, so "✨ Plan the rest" and "Looks right" could be tapped in
    /// that order: the affirmative reads the crumb immediately, so the record was written
    /// without the nights still being filled (they lose their ✨ afterwards), and the fill's
    /// `apply` landed on a step that had already been answered.
    ///
    /// Only a step with a LONG write needs to call it — Meals' auto-fill is the one that
    /// prompted this. A step whose writes are a single quick call can ignore it; the shell
    /// defaults to not busy.
    let reportBusy: (Bool) -> Void
}

/// One verb, lent to the shell's banner by the step you are standing on.
struct PlanningHandoffVerb {
    /// "Make a task", "Make an event" — the verb of this step.
    let label: String
    /// Open this step's OWN composer, seeded with the note's words, and report back
    /// through the completion whether something was really created.
    ///
    /// A CANCELLED COMPOSER MUST REPORT `false`. Settling the note on a cancel would
    /// throw away the only record that the thing still needs doing, on the strength of
    /// somebody having opened a box and closed it again.
    let run: (_ note: String, _ done: @escaping (Bool) -> Void) -> Void
}

/// A step whose body has not been built yet. The shell renders this rather than a blank
/// screen, so an unfinished step is still walk-past-able: the chrome, the question, Skip
/// and the affirmative all work, and answering it is a real answer.
struct PlanningStepPlaceholder: View {
    let step: WaffledAPI.PlanningStep

    var body: some View {
        WaffledEmptyState(
            emoji: "🚧",
            title: step.title,
            message: "This step isn't on iPhone yet — it's on the web session. You can still skip it or mark it done."
        )
    }
}

/// THE REGISTRY. Ten keys, ten views, and the placeholder for anything unknown.
///
/// `default` is not dead code: the catalog is server-owned, so a server newer than the
/// app can name a step this build has never heard of. It must render as a walk-past-able
/// placeholder, not crash and not vanish.
@ViewBuilder
func planningStepBody(_ props: PlanningStepProps) -> some View {
    switch props.step.key {
    case "looseEnds":   LooseEndsStepView(props: props)
    case "calendar":    CalendarStepView(props: props)
    case "horizon":     HorizonStepView(props: props)
    case "familyNight": FamilyNightStepView(props: props)
    case "connection":  ConnectionStepView(props: props)
    case "goals":       GoalsStepView(props: props)
    case "meals":       MealsStepView(props: props)
    case "tasks":       TasksStepView(props: props)
    case "kids":        KidsStepView(props: props)
    case "recap":       RecapStepView(props: props)
    default:            PlanningStepPlaceholder(step: props.step)
    }
}

/// One more control in the footer, beside Skip and the affirmative. Only Meals uses it
/// ("✨ Plan the rest for me", then "Undo the three"); everything else contributes
/// nothing and gets an `EmptyView`.
@ViewBuilder
func planningStepFooterExtra(_ props: PlanningStepProps) -> some View {
    switch props.step.key {
    case "meals": MealsStepFooterExtra(props: props)
    default:      EmptyView()
    }
}
