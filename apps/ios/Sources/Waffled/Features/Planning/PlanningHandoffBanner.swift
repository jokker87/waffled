import SwiftUI

/// A parked note handed to the step it was tagged for.
///
/// **THE SHELL OWNS THIS, NOT THE TEN STEPS.** `planning_parked_items.step_key` names a
/// DESTINATION — "which step is going to look at this" — and for a while nothing read it:
/// a note tagged for Meals or Tasks was never seen again. It was reported exactly that
/// way: "I added a bunch to the park it thing, expecting to go over them in the
/// appropriate step but I never saw them again, where did they go?"
///
/// It belongs to the shell because the banner is identical on every step, because the
/// shell already refetches after every write (so a note dealt with anywhere stops being
/// offered everywhere), and because each step's OWN affordances are what act on the note.
/// The banner's job is to put it back in front of you at the moment it is actionable, not
/// to grow a tenth way to add a chore.
///
/// **Three answers, and the third is the honest one.** "Handled" resolves the note (you
/// did the thing with the step's own controls) and "Drop it" says it was never really a
/// thing — both are bookkeeping. Leaving a note alone is the real third answer and writes
/// NOTHING: it stays parked and turns up again in the recap, which is what parking is
/// for. And when the step lends one (`PlanningStepProps.lendVerb`), a verb that actually
/// does the thing — "Make a task", "Make an event" — opening that step's own composer
/// seeded with the note's words. A step with no composer lends nothing and the banner
/// stays as it was; a button reading "Make a goal" that only ticks the note off promises
/// an action it does not perform.
///
/// Ported from the `Handoff` component in `apps/web/src/kiosk/WeeklyPlanning.tsx`.
///
/// The caller must give this an `.id(step.key)` (the shell does): `hidden` is per-note
/// local state and a step change has to start it empty.
struct PlanningHandoffBanner: View {
    let step: WaffledAPI.PlanningStep
    /// A write is in flight in the shell — every answer here disables with it.
    let busy: Bool
    /// The verb this step lent, or nil when it has no composer to open.
    let verb: PlanningHandoffVerb?
    /// Settle one note. True when the server took it, so the row can go before the
    /// refetch lands.
    let resolve: (_ id: String, _ action: String) async -> Bool

    @State private var working: String?
    /// Hidden locally as well as refetched: the refetch is what makes it true, and this
    /// is what makes it FEEL true before the round trip lands.
    @State private var hidden: Set<String> = []

    /// `?? []` on purpose: a payload missing the field must cost the banner, never the
    /// session screen. The shell is the one view whose failure has nowhere to fall back
    /// to — there is no error boundary above it.
    private var notes: [WaffledAPI.PlanningStepHandoff] {
        (step.parked ?? []).filter { !hidden.contains($0.id) }
    }

    var body: some View {
        if !notes.isEmpty { card }
    }

    // Hand-rolled rather than `WaffledCard`: this is the app's tinted-attention banner
    // shape (`ApprovalsBanner`) — a gold wash, gold hairline, `WF.rLG` — not a white
    // surface. `DismissibleErrorBanner` is the only shared banner and it is coral and
    // error-shaped, which would read as "something went wrong" for what is a nudge.
    private var card: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 7) {
                Text("📌").font(.system(size: 14))
                Text(notes.count == 1
                     ? "You parked this for right here"
                     : "You parked \(notes.count) things for right here")
                    .font(.system(size: 13, weight: .heavy)).foregroundStyle(WF.ink)
            }
            ForEach(notes) { note in
                VStack(alignment: .leading, spacing: 8) {
                    Text(note.note)
                        .font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let byline = note.byline, !byline.isEmpty {
                        Text(byline).font(.system(size: 11.5)).foregroundStyle(WF.ink3)
                    }
                    actions(for: note)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(14)
        .background(WF.gold.opacity(0.10))
        .clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: WF.rLG, style: .continuous)
                .strokeBorder(WF.gold.opacity(0.30), lineWidth: 1))
    }

    /// The verb first (when the step lent one), then the two bookkeeping answers.
    ///
    /// `ChipFlow` wraps these rather than an `HStack`: three labels — "Make an event",
    /// "Already handled", "Drop it" — do not fit one phone line, and a truncated
    /// destructive button is worse than a wrapped one.
    private func actions(for note: WaffledAPI.PlanningStepHandoff) -> some View {
        ChipFlow(spacing: 8, lineSpacing: 8) {
            if let verb {
                answerButton(verb.label, tint: WF.primary, filled: true, note: note) {
                    // The note's id is captured HERE rather than parked in a field, so a
                    // second composer opened before the first reports back cannot settle
                    // the wrong note.
                    verb.run(note.note) { created in
                        // A CANCELLED composer settles nothing. Ticking the note off would
                        // throw away the only record that it still needs doing, on the
                        // strength of somebody having opened a box and closed it again.
                        guard created else { return }
                        answer(note.id, "done")
                    }
                }
            }
            // "Already handled" once there's a verb beside it — "Handled" alone would read
            // as the same offer twice.
            answerButton(verb == nil ? "Handled" : "Already handled", tint: WF.ink2, filled: false, note: note) {
                answer(note.id, "done")
            }
            answerButton("Drop it", tint: WF.danger, filled: false, note: note) {
                answer(note.id, "drop")
            }
        }
    }

    private func answerButton(
        _ label: String, tint: Color, filled: Bool,
        note: WaffledAPI.PlanningStepHandoff, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(filled ? .white : tint)
                .padding(.horizontal, 13).padding(.vertical, 7)
                .background(filled ? tint : WF.card)
                .overlay(Capsule().strokeBorder(filled ? .clear : WF.hair, lineWidth: 1))
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(busy || working == note.id)
        .opacity(working == note.id ? 0.5 : 1)
    }

    private func answer(_ id: String, _ action: String) {
        guard working == nil else { return }
        working = id
        Task {
            let settled = await resolve(id, action)
            // A failure leaves the note on screen rather than half-answered; the next
            // refetch is authoritative either way.
            if settled { hidden.insert(id) }
            working = nil
        }
    }
}
