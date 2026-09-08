import SwiftUI

/// EVERYTHING SOMEBODY SENT TO THIS STEP, in one box at the top of it.
///
/// **THE SHELL OWNS THIS, NOT THE TEN STEPS.** `planning_parked_items.step_key` names a
/// DESTINATION — "which step is going to look at this" — and for a while nothing read it:
/// a note tagged for Meals or Tasks was never seen again. It was reported exactly that
/// way: "I added a bunch to the park it thing, expecting to go over them in the
/// appropriate step but I never saw them again, where did they go?"
///
/// It belongs to the shell because the box is identical on every step, because the shell
/// already refetches after every write (so a note dealt with anywhere stops being offered
/// everywhere), and because each step's OWN affordances are what act on what is in it.
/// The box's job is to put things back in front of you at the moment they are actionable,
/// not to grow a tenth way to add a chore.
///
/// **TWO WAYS IN, ONE BOX — and the second one used to land at the bottom of the step.**
///
///  · A **parked note** is free text somebody typed, tagged for a step. It arrives on
///    `step.parked`.
///  · A **routed loose end** is a concrete thing that already exists — an overdue chore, an
///    unchecked list item, a parked note — that step 1's triage addressed to a step. It
///    arrives in step 1's own `data.routes` and is handed down through
///    `PlanningStepProps.routes`.
///
/// Routed ends used to be drawn by each step BODY, in a trailing section under the step's
/// real content, which is where they were reported: "wouldn't these be in the top 'parked
/// things' box? why are they hidden at the bottom?" They are in this box now — GROUPED,
/// not flattened, because the two are not the same thing and cannot take the same answers.
/// Each half keeps its own heading and its own affordances, and the whole box disappears
/// when both halves are empty.
///
/// **A note's three answers, and the third is the honest one.** "Handled" resolves the note
/// (you did the thing with the step's own controls) and "Drop it" says it was never really
/// a thing — both are bookkeeping. Leaving a note alone is the real third answer and writes
/// NOTHING: it stays parked and turns up again in the recap, which is what parking is
/// for. And when the step lends one (`PlanningStepProps.lendVerb`), a verb that actually
/// does the thing — "Make a task", "Make an event" — opening that step's own composer
/// seeded with the note's words. A step with no composer lends nothing and the box stays
/// as it was; a button reading "Make a goal" that only ticks the note off promises an
/// action it does not perform.
///
/// **A ROUTED END GETS THE VERB AND NOTHING ELSE.** Routing wrote nothing to any module —
/// the overdue chore is still overdue — so there is no bookkeeping to answer here: no
/// "Handled" (its module already knows), and no "Drop it" (dropping a real chore from a
/// nudge would be a write nobody asked for; step 1 and the recap own that). On a step that
/// lends no verb the row is a plain reminder that this was sent here, which is the whole
/// complaint answered, and it is deliberately not a ghost button.
///
/// Ported from the `Handoff` component in `apps/web/src/kiosk/WeeklyPlanning.tsx`. The
/// routed half is iOS AHEAD of the web (which records routing but never shows it on the
/// destination step), recorded as a web follow-up rather than an accident.
///
/// The caller must give this an `.id(step.key)` (the shell does): `hidden` and `made` are
/// per-row local state and a step change has to start them empty.
/// WHICH WORDS A HANDOFF ANSWER CARRIES: the in-place edit when there is one, otherwise the
/// note as stored.
///
/// A one-line rule that lives outside the view on purpose — the banner is SwiftUI and this
/// app has no view tests, so the only way to pin the behaviour that was wrong (rendering the
/// edit while sending the original) is to make the decision testable on its own.
enum PlanningHandoffWords {
    static func of(_ note: WaffledAPI.PlanningStepHandoff, edited: [String: String]) -> String {
        edited[note.id] ?? note.note
    }
}

struct PlanningHandoffBanner: View {
    let step: WaffledAPI.PlanningStep
    /// EVERY route step 1 wrote this session, not just this step's — the box filters to
    /// its own step (`PlanningRouteSeed.sentHere`). The array lives on the **looseEnds**
    /// step's row, so the shell is the only place that can pass it across; it is the same
    /// value the step bodies get as `PlanningStepProps.routes`.
    let routes: [WaffledAPI.LooseEndRoute]
    /// A write is in flight in the shell — every answer here disables with it.
    let busy: Bool
    /// The verb this step lent, or nil when it has no composer to open.
    let verb: PlanningHandoffVerb?
    /// Settle one note. True when the server took it, so the row can go before the
    /// refetch lands.
    let resolve: (_ id: String, _ action: String) async -> Bool

    /// EVERY STEP THIS HOUSEHOLD RUNS — the tag row an edit may re-address a note to.
    ///
    /// Defaulted, and the banner loads the catalog itself when it is empty (lazily, the
    /// first time somebody actually taps Edit), so the shell's call site needs no change
    /// to get the affordance. Handing it `model.steps` skips that read; nothing else
    /// differs. Wider than the park bar's forward-only tags on purpose: this note has
    /// already LANDED somewhere, and a correction must not be narrower than the mistake.
    var steps: [WaffledAPI.PlanningStep] = []

    /// Fix a note's words and/or its tag. Defaulted to the real route so the shell needs
    /// no wiring; a test injects its own.
    ///
    /// RETURNS THE REFUSAL, NOT A BOOL. The reachable failures here all carry the useful
    /// half — "a note is at most 500 characters", "the meals step is not running in this
    /// household" — and flattening them to "that didn't go through" is the half of the
    /// failure worth keeping thrown away. `PlanningHorizonModel.update` keeps the same
    /// sentence on the board; the two must not diverge on that. nil ⇒ the server took it.
    ///
    /// NO SESSION ID, deliberately. Re-tagging a note that step 1 ROUTED also has to move
    /// that session's trail entry, and the server does not need to be told which session
    /// that is — `updateParkedItem` repairs every OPEN trail that names the note, which is
    /// the invariant stated instead of guessed at.
    var update: (_ id: String, _ note: String?, _ stepKey: String??) async -> String? = { id, note, stepKey in
        do {
            _ = try await WaffledAPI().updatePlanningParkedNote(id: id, note: note, stepKey: stepKey)
            return nil
        } catch {
            return APIErrorText.message(for: error, fallback: LooseEndCopy.writeFailed)
        }
    }

    @State private var working: String?
    /// Which note is being corrected, if any. One at a time: the box is a nudge, not a
    /// form.
    @State private var editing: String?
    /// Words this sitting has rewritten, by note id. The shell owns `step.parked` and only
    /// refetches after a resolve, so this overlay is what makes an edit visible now; the
    /// next refetch is authoritative and agrees with it.
    @State private var edited: [String: String] = [:]
    /// The catalog, when the shell didn't hand it over. See `steps`.
    @State private var loadedSteps: [WaffledAPI.PlanningStep] = []
    /// A refused edit's sentence, shown under the field you typed in rather than at the
    /// top of the screen.
    @State private var editError: String?
    /// Hidden locally as well as refetched: the refetch is what makes it true, and this
    /// is what makes it FEEL true before the round trip lands.
    @State private var hidden: Set<String> = []
    /// Routed ends this sitting has already turned into something, by `kind:id`. There is
    /// nothing to refetch for these — routing wrote nothing to settle — so this local set
    /// IS the record that the offer was taken, and it lasts exactly as long as the step is
    /// on screen.
    @State private var made: Set<String> = []

    /// `?? []` on purpose: a payload missing the field must cost the banner, never the
    /// session screen. The shell is the one view whose failure has nowhere to fall back
    /// to — there is no error boundary above it.
    private var notes: [WaffledAPI.PlanningStepHandoff] {
        (step.parked ?? []).filter { !hidden.contains($0.id) }
    }

    /// The words to show for a note — this sitting's rewrite when there is one.
    private func words(_ note: WaffledAPI.PlanningStepHandoff) -> String {
        PlanningHandoffWords.of(note, edited: edited)
    }

    /// The tag chips an edit may choose from. Step 1 is never among them: the server
    /// refuses "the step it came from" as a circle.
    private var tags: [PlanningParkedTag] {
        (steps.isEmpty ? loadedSteps : steps)
            .filter { $0.available && $0.key != "looseEnds" }
            .map { PlanningParkedTag(stepKey: $0.key, label: $0.title) }
    }

    /// The routed ends addressed here. `step.parked` is passed RAW — not `notes` — so that
    /// answering "Handled" on a parked note cannot make its routed twin pop into existence
    /// underneath. (Routing a parked note sets its `step_key` too, so the same note really
    /// does arrive through both doors.)
    private var sent: [WaffledAPI.LooseEndRoute] {
        PlanningRouteSeed.sentHere(
            to: step.key, in: routes, parked: step.parked, settled: made)
    }

    var body: some View {
        if !notes.isEmpty || !sent.isEmpty { card }
    }

    // Hand-rolled rather than `WaffledCard`: this is the app's tinted-attention banner
    // shape (`ApprovalsBanner`) — a gold wash, gold hairline, `WF.rLG` — not a white
    // surface. `DismissibleErrorBanner` is the only shared banner and it is coral and
    // error-shaped, which would read as "something went wrong" for what is a nudge.
    private var card: some View {
        VStack(alignment: .leading, spacing: 14) {
            if !notes.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    heading("📌", notes.count == 1
                            ? "You parked this for right here"
                            : "You parked \(notes.count) things for right here")
                    ForEach(notes) { note in noteRow(note) }
                }
            }
            if !sent.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    heading("➡️", sent.count == 1
                            ? "You sent this here from loose ends"
                            : "You sent \(sent.count) things here from loose ends")
                    ForEach(sent, id: \.id) { route in sentRow(route) }
                }
            }
        }
        .padding(14)
        .background(WF.gold.opacity(0.10))
        .clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: WF.rLG, style: .continuous)
                .strokeBorder(WF.gold.opacity(0.30), lineWidth: 1))
        // The tag catalog, and only once somebody actually opens an editor — the box
        // itself needs none of it, so a step nobody corrects a note on costs no read.
        // Skipped entirely when the shell handed `steps` over.
        .task(id: editing) {
            guard editing != nil, steps.isEmpty, loadedSteps.isEmpty else { return }
            // A failure costs the chips, never the box: the editor still offers the note's
            // own tag and "No tag", and the words can be fixed regardless.
            loadedSteps = (try? await WaffledAPI().weeklyPlanning())?.steps ?? []
        }
    }

    /// ONE heading treatment for both halves, so neither reads as the more important one —
    /// and the parked string is byte-identical to what it always said, so a step with only
    /// parked notes looks exactly as it did.
    private func heading(_ emoji: String, _ text: String) -> some View {
        HStack(spacing: 7) {
            Text(emoji).font(.system(size: 14))
            Text(text)
                .font(.system(size: 13, weight: .heavy)).foregroundStyle(WF.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - A parked note

    @ViewBuilder private func noteRow(_ note: WaffledAPI.PlanningStepHandoff) -> some View {
        if editing == note.id {
            // In place, replacing the row: the note is one line, and a sheet for one line
            // loses the box you were reading it in. The step it ARRIVED on is its current
            // tag — that is why the box raised it — so the editor opens on that chip.
            PlanningParkedNoteEditor(
                note: words(note),
                stepKey: step.key,
                tags: tags,
                busy: busy,
                errorMessage: editError,
                onCancel: {
                    editing = nil
                    editError = nil
                },
                onSave: { text, stepKey in
                    // The server's own sentence, under the field you typed in.
                    if let refusal = await update(note.id, text, stepKey) {
                        editError = refusal
                        return false
                    }
                    editError = nil
                    if let text { edited[note.id] = text }
                    // RE-TAGGED AWAY FROM HERE, so it stops being this step's business —
                    // the same local hide a resolve does, and the next refetch agrees.
                    if case .some(let moved) = stepKey, moved != step.key { hidden.insert(note.id) }
                    return true
                })
        } else {
            VStack(alignment: .leading, spacing: 8) {
                Text(words(note))
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

    /// The verb first (when the step lent one), then the two bookkeeping answers.
    ///
    /// `ChipFlow` wraps these rather than an `HStack`: three labels — "Make an event",
    /// "Already handled", "Drop it" — do not fit one phone line, and a truncated
    /// destructive button is worse than a wrapped one.
    private func actions(for note: WaffledAPI.PlanningStepHandoff) -> some View {
        ChipFlow(spacing: 8, lineSpacing: 8) {
            if let verb {
                answerButton(verb.label, tint: WF.primary, filled: true, key: note.id) {
                    // The note's id is captured HERE rather than parked in a field, so a
                    // second composer opened before the first reports back cannot settle
                    // the wrong note.
                    // THE EDITED WORDS, not the stored ones. The banner renders
                    // `words(note)`, so a note corrected in place shows its correction —
                    // and this used to hand `note.note` to the composer anyway, discarding
                    // that correction at the one moment the note becomes a real thing.
                    verb.run(words(note)) { created in
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
            answerButton(verb == nil ? "Handled" : "Already handled", tint: WF.ink2, filled: false, key: note.id) {
                answer(note.id, "done")
            }
            // FIX IT INSTEAD OF ANSWERING IT. "I have no way to edit the item or change the
            // category and I should" — before this, a typo or the wrong tag could only be
            // cleared with Drop, which is supposed to mean "it was never really a thing".
            answerButton("Edit", tint: WF.ink2, filled: false, key: note.id) {
                editError = nil
                editing = note.id
            }
            answerButton("Drop it", tint: WF.danger, filled: false, key: note.id) {
                answer(note.id, "drop")
            }
        }
    }

    // MARK: - A routed loose end

    private func sentRow(_ route: WaffledAPI.LooseEndRoute) -> some View {
        let key = PlanningRouteSeed.key(route)
        return VStack(alignment: .leading, spacing: 8) {
            // A route written by an older build can be missing its title (the server's
            // guard on that column checks only kind/id/to), and a blank row would be worse
            // than a vague one.
            Text(route.title.isEmpty ? "Something you sent here" : route.title)
                .font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            // WHICH KIND OF THING THIS IS — "Chore", "List", "Goal" — in the same slot the
            // parked note puts its byline, so the two rows read as siblings while still
            // saying which is which. `LooseEndCopy` is step 1's own labelling; one spelling.
            Text(LooseEndCopy.kindLabel(route.kind))
                .font(.system(size: 11.5)).foregroundStyle(WF.ink3)
            if let verb {
                answerButton(verb.label, tint: WF.primary, filled: true, key: key) {
                    verb.run(route.title) { created in
                        // Same rule as a note: a cancelled composer takes nothing off the
                        // list. Nothing is written to the server either way — routing never
                        // touched the chore, so there is nothing to resolve.
                        guard created else { return }
                        made.insert(key)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Shared chrome

    /// `key` is whatever identifies the row — a note's id, or a route's `kind:id`.
    private func answerButton(
        _ label: String, tint: Color, filled: Bool,
        key: String, action: @escaping () -> Void
    ) -> some View {
        WaffledPillButton(
            label: label, tint: tint, filled: filled,
            disabled: busy, working: working == key, action: action)
    }

    private func answer(_ id: String, _ action: String) {
        guard working == nil else { return }
        working = id
        Task {
            let took = await resolve(id, action)
            // A failure leaves the note on screen rather than half-answered; the next
            // refetch is authoritative either way.
            if took { hidden.insert(id) }
            working = nil
        }
    }
}
