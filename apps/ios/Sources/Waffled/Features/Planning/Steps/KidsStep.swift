import SwiftUI

/// Weekly Planning · step 9 "Kids" — "What's your week about?"
///
/// Ported from `apps/web/src/kiosk/planning/steps/KidsStep.tsx`.
///
/// THE ONE STEP THE KIDS THEMSELVES READ. Their NAME is the title of their card, the type
/// is sized for them, and on the iPad every card is up at once — there is no per-kid
/// navigation for a family of two. On the phone there isn't room, so a segmented row puts
/// one kid on screen at a time.
///
/// TWO QUESTIONS EACH, AND BOTH ARE ANSWERED FROM THINGS THAT ALREADY EXIST. The focus
/// options are that child's own goals, their own overdue chores and the standing chores
/// they already carry; the look-forward-to options are events already on their week.
/// "＋ Something else" is the escape hatch and sits LAST — a kid should recognise their
/// week in the list rather than have to invent it. Everything on screen is composed by the
/// server except the goal's number, which goes through `GoalDisplay` so a habit reads as
/// this period's count and not a lifetime total.
///
/// THE SECOND FRAME IS THE READ-BACK. Once every card has both answers the step stops
/// being a picker and becomes the two sentences, large. "Change something" puts the picker
/// back.
///
/// The answers are a REAL write, never `setDecisionData` — the crumb only reaches the
/// server when the step is ANSWERED, so a family that reads the cards out and walks away
/// without pressing Done would lose the very thing they came here to say.
struct KidsStepView: View {
    let props: PlanningStepProps

    @State private var model = PlanningKidsStepModel()

    var body: some View {
        // NO OUTER ScrollView: the shell owns the chrome around a step, and the scrolling
        // with it. A second one nested inside would fight it.
        VStack(alignment: .leading, spacing: 12) {
            if !model.loaded {
                WaffledLoading()
            } else if model.view == nil {
                WaffledEmptyState(
                    emoji: "🧒",
                    title: "Couldn’t read their week",
                    message: "Reload, or skip this step — skipping is a real answer.")
            } else if model.kids.isEmpty {
                WaffledEmptyState(
                    emoji: "🧒",
                    title: "No cards to read out",
                    message: "No one in this household is set up as a child yet. Add them in Settings → People (member type “kid”) and this step will have something to ask. Skipping is a real answer in the meantime.")
            } else {
                Text(model.heading)
                    .font(WF.serif(20, .bold))
                    .foregroundStyle(WF.ink)

                if showsKidTabs { kidTabs }

                if let message = model.errorMessage {
                    DismissibleErrorBanner(message: message) { model.dismissError() }
                }

                cards
                extraControl
            }
        }
        // Keyed on session AND week: stepping to another week must not leave the previous
        // week's answers on screen.
        .task(id: "\(props.sessionId)|\(props.weekStart)") { await reload() }
        // Mirror what the session already knows onto the crumb after EVERY fresh read AND
        // every write — not only after a tap. The shell resets the crumb on step change and
        // REPLACES the step's stored data when the affirmative is pressed, so a body that
        // only set it in its tap handler would erase the kids' answers on a remount.
        //
        // NEVER `setDecisionData(model.crumb)` STRAIGHT THROUGH. This crumb is a MIRROR of
        // server state that the affirmative overwrites, so handing the shell a nil after a
        // failed fetch is not "no news" — it is the wipe, and what it throws away is the
        // two sentences the whole step exists to produce.
        .onChange(of: model.rev) {
            if let crumb = model.crumb { props.setDecisionData(crumb) }
        }
        // THIS STEP LENDS THE BANNER NOTHING. Its text box answers one child's question —
        // it creates nothing in any module — so there is no verb here that a parked note
        // could honestly be handed to. Withdrawn explicitly, because the verb is the
        // SHELL's state and would otherwise still be the previous step's.
        .onAppear { props.lendVerb(nil) }
    }

    // MARK: - Which cards are on screen

    /// The iPad is the family display — both cards fit, and switching kid at the board is
    /// the thing the design is trying to avoid. The phone has no such room.
    private var showsKidTabs: Bool {
        DeviceExperience.current == .planner && model.kids.count > 1
    }

    @ViewBuilder private var cards: some View {
        if showsKidTabs {
            if let card = model.activeCard { kidCard(card) }
        } else {
            VStack(spacing: 12) {
                ForEach(model.kids) { kidCard($0) }
            }
        }
    }

    private var kidTabs: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(model.kids) { k in
                    let on = k.personId == model.activeCard?.personId
                    Button { model.select(personId: k.personId) } label: {
                        HStack(spacing: 6) {
                            Avatar(colorHex: k.colorHex, emoji: k.avatarEmoji ?? "🙂", size: 22)
                            Text(k.name)
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(on ? WF.ink : WF.ink2)
                            if k.settled {
                                Text("★").font(.system(size: 12, weight: .bold))
                                    .foregroundStyle(WF.gold)
                            }
                        }
                        .padding(.horizontal, 10).padding(.vertical, 6)
                        .wfChip(selected: on)
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(on ? [.isSelected] : [])
                }
            }
            .padding(.horizontal, 2).padding(.vertical, 2)
        }
    }

    // MARK: - One card

    private func kidCard(_ card: WaffledAPI.PlanningKidCard) -> some View {
        let frozen = model.isFrozen(shellBusy: props.busy)
        return WaffledCard(padding: 14) {
            VStack(alignment: .leading, spacing: 12) {
                cardHeader(card)
                theirWeek(card)

                if model.isReadBack {
                    readBack(card)
                } else {
                    question(
                        card,
                        which: .focus,
                        label: "One thing to focus on",
                        frozen: frozen,
                        options: {
                            VStack(spacing: 8) {
                                ForEach(card.focusOptions, id: \.key) {
                                    focusOption($0, card: card, frozen: frozen)
                                }
                                focusHatch(card, frozen: frozen)
                            }
                        })

                    question(
                        card,
                        which: .forward,
                        label: "Something to look forward to",
                        frozen: frozen,
                        options: {
                            ChipFlow(spacing: 8, lineSpacing: 8) {
                                ForEach(card.forwardOptions, id: \.key) {
                                    forwardOption($0, card: card, frozen: frozen)
                                }
                                forwardHatch(card, frozen: frozen)
                            }
                        })
                }
            }
        }
    }

    private func cardHeader(_ card: WaffledAPI.PlanningKidCard) -> some View {
        HStack(spacing: 10) {
            Avatar(colorHex: card.colorHex, emoji: card.avatarEmoji ?? "🙂", size: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(card.name).font(.system(size: 17, weight: .heavy)).foregroundStyle(WF.ink)
                if let age = card.age {
                    Text("age \(age)").font(.system(size: 12)).foregroundStyle(WF.ink3)
                }
            }
            Spacer(minLength: 6)
            // Stars are funded by chores, so an economy that is off simply isn't drawn —
            // NEVER a zero, which would read as "you've earned nothing".
            if let stars = card.stars {
                WaffledStatusBadge(
                    text: "\(card.starsSymbol ?? "⭐") \(stars)", color: WF.gold, size: 13, weight: .heavy)
            }
        }
    }

    /// Their week, in BOTH frames: the kid at the board wants to see their own week whether
    /// or not they've answered yet.
    private func theirWeek(_ card: WaffledAPI.PlanningKidCard) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            SectionLabel(text: "Your week")
            if card.week.isEmpty && card.chores.isEmpty {
                Text("Nothing on it yet").font(.system(size: 13)).foregroundStyle(WF.ink3)
            } else {
                ChipFlow(spacing: 6, lineSpacing: 6) {
                    ForEach(card.week) { weekChip(when: $0.when, title: $0.title, late: false) }
                    ForEach(card.chores) { weekChip(when: $0.when, title: $0.title, late: $0.late) }
                }
            }
        }
    }

    /// `when` is composed server-side in the household's own zone — there is deliberately
    /// no date math on this device, and so no formatter in this render path.
    private func weekChip(when: String, title: String, late: Bool) -> some View {
        HStack(spacing: 5) {
            Text(when)
                .font(.system(size: 11, weight: .heavy))
                .foregroundStyle(late ? WF.warn : WF.ink3)
            Text(title).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(WF.ink)
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(late ? WF.warnT : WF.panel)
        .clipShape(Capsule())
    }

    // MARK: - The two questions

    private func question<Options: View>(
        _ card: WaffledAPI.PlanningKidCard,
        which: PlanningKidsStepModel.Question,
        label: String,
        frozen: Bool,
        @ViewBuilder options: () -> Options
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel(text: label)
            options()
            if model.isTyping(personId: card.personId, which: which) {
                PlanningKidTypeIn(
                    placeholder: which == .focus ? "In their own words" : "Something on their week",
                    accessibilityLabel: which == .focus
                        ? "Something else for \(card.name)"
                        : "Something else for \(card.name) to look forward to",
                    initial: model.typeInSeed(card, which),
                    disabled: frozen,
                    onCancel: { model.cancelTyping() },
                    onSave: { text in
                        if which == .focus {
                            answer(card.personId, focus: .text(text))
                        } else {
                            answer(card.personId, forward: .text(text))
                        }
                    },
                    onDraft: { text in
                        model.recordDraft(personId: card.personId, which: which, text: text)
                    })
                // A new box per person AND per question, so switching kid never inherits
                // the other one's half-typed words.
                .id("\(card.personId):\(which.rawValue)")
            }
        }
    }

    private func focusOption(
        _ o: WaffledAPI.PlanningKidFocusOption,
        card: WaffledAPI.PlanningKidCard,
        frozen: Bool
    ) -> some View {
        let checked = PlanningKidsChoice.focusChosen(card, o)
        // The number ALWAYS comes from the shared helper — never an inline `totalProgress`,
        // which would tell a kid they'd read 99 times this week.
        var progress: Double?
        var target: Double?
        if let g = o.goal {
            progress = GoalDisplay.progress(g)
            target = GoalDisplay.target(g)
        }

        return Button { answer(card.personId, focus: .key(o.key)) } label: {
            HStack(alignment: .top, spacing: 10) {
                Text(o.emoji).font(.system(size: 20)).frame(width: 26)
                VStack(alignment: .leading, spacing: 3) {
                    Text(o.label)
                        .font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    // `detail` is null on a standing chore because nothing is wrong with
                    // it: that absence is the design, not a missing string.
                    if let detail = o.detail {
                        Text(detail).font(.system(size: 12)).foregroundStyle(WF.ink3)
                    }
                    if o.routed {
                        Text("sent here in step 1")
                            .font(.system(size: 10.5, weight: .heavy))
                            .foregroundStyle(WF.ai)
                    }
                }
                Spacer(minLength: 6)
                if let progress {
                    HStack(alignment: .firstTextBaseline, spacing: 2) {
                        Text(goalFmt(progress))
                            .font(.system(size: 16, weight: .heavy)).foregroundStyle(WF.ink)
                        if let target {
                            Text("/ \(goalFmt(target))")
                                .font(.system(size: 11, weight: .semibold)).foregroundStyle(WF.ink3)
                        }
                    }
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .planningOptionChrome(selected: checked)
        }
        .buttonStyle(.plain)
        .disabled(frozen)
        .opacity(frozen ? 0.6 : 1)
        .accessibilityAddTraits(checked ? [.isSelected] : [])
    }

    /// LAST, and quiet: the escape hatch, not the main path. Once it HAS been used it reads
    /// as the chosen answer and says what they said — an option that still read "＋
    /// Something else" would look like nothing had been picked at all.
    private func focusHatch(_ card: WaffledAPI.PlanningKidCard, frozen: Bool) -> some View {
        let chosen = PlanningKidsChoice.focusIsCustom(card)
        return Button { model.beginTyping(personId: card.personId, which: .focus) } label: {
            HStack(spacing: 10) {
                Text(chosen ? (card.focus?.emoji ?? "✨") : "＋")
                    .font(.system(size: 18)).frame(width: 26)
                Text(chosen ? (card.focus?.label ?? "") : "Something else")
                    .font(.system(size: 15, weight: chosen ? .semibold : .regular))
                    .foregroundStyle(chosen ? WF.ink : WF.ink3)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 6)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .planningOptionChrome(selected: chosen)
        }
        .buttonStyle(.plain)
        .disabled(frozen)
        .opacity(frozen ? 0.6 : 1)
        .accessibilityAddTraits(chosen ? [.isSelected] : [])
    }

    private func forwardOption(
        _ o: WaffledAPI.PlanningKidForwardOption,
        card: WaffledAPI.PlanningKidCard,
        frozen: Bool
    ) -> some View {
        let checked = PlanningKidsChoice.forwardChosen(card, o)
        return Button { answer(card.personId, forward: .key(o.key)) } label: {
            HStack(spacing: 5) {
                Text(o.emoji).font(.system(size: 14))
                // Day and title in ONE label: the week strip above already carries the
                // title on its own, and two identical labels on a card make it unreadable
                // read out loud.
                Text("\(o.when) · \(o.label)")
                    .font(.system(size: 13.5, weight: .semibold))
                    .foregroundStyle(checked ? WF.ink : WF.ink2)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .wfChip(selected: checked)
        }
        .buttonStyle(.plain)
        .disabled(frozen)
        .opacity(frozen ? 0.6 : 1)
        .accessibilityAddTraits(checked ? [.isSelected] : [])
    }

    private func forwardHatch(_ card: WaffledAPI.PlanningKidCard, frozen: Bool) -> some View {
        let chosen = PlanningKidsChoice.forwardIsCustom(card)
        return Button { model.beginTyping(personId: card.personId, which: .forward) } label: {
            HStack(spacing: 5) {
                Text(chosen ? (card.forward?.emoji ?? "✨") : "＋").font(.system(size: 14))
                Text(chosen ? (card.forward?.label ?? "") : "Add something")
                    .font(.system(size: 13.5, weight: .semibold))
                    .foregroundStyle(chosen ? WF.ink : WF.ink3)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .wfChip(selected: chosen)
        }
        .buttonStyle(.plain)
        .disabled(frozen)
        .opacity(frozen ? 0.6 : 1)
        .accessibilityAddTraits(chosen ? [.isSelected] : [])
    }

    // MARK: - The read-back

    private func readBack(_ card: WaffledAPI.PlanningKidCard) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if let focus = card.focus {
                said(emoji: focus.emoji, big: focus.label, caption: "this week’s one thing")
            }
            if let forward = card.forward {
                said(
                    emoji: forward.emoji,
                    big: forward.label,
                    caption: forward.when.isEmpty
                        ? "the bit to look forward to"
                        : "\(forward.when) — the bit to look forward to")
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("What \(card.name) said")
    }

    private func said(emoji: String, big: String, caption: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text(emoji).font(.system(size: 30))
            VStack(alignment: .leading, spacing: 2) {
                Text(big)
                    .font(WF.serif(20, .bold)).foregroundStyle(WF.ink)
                    .fixedSize(horizontal: false, vertical: true)
                Text(caption).font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
            }
            Spacer(minLength: 0)
        }
    }

    // MARK: - The frame's own control
    //
    // On the web this is the shell's FooterExtra: "Same as last week" on the picker,
    // "Change something" on the read-back. The iOS seam routes a footer extra for `meals`
    // only and this step may not touch it, so the control lives in the body — the one place
    // it can, and where per-kid navigation already lives.

    @ViewBuilder private var extraControl: some View {
        if model.isReadBack {
            ghostButton("Change something", disabled: false) { model.beginChanging() }
        } else if model.canRepeat {
            ghostButton("Same as last week", disabled: model.isFrozen(shellBusy: props.busy)) {
                Task {
                    await model.repeatLastWeek(
                        sessionId: props.sessionId, weekStart: props.weekStart)
                    props.refresh()
                }
            }
        }
    }

    private func ghostButton(
        _ label: String, disabled: Bool, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(WF.ink2)
                .padding(.horizontal, 16).padding(.vertical, 9)
                .background(WF.panel)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.6 : 1)
    }

    // MARK: - Writes

    /// The read, and the crumb it produces. Set here as well as on the `rev` change: a
    /// remount whose fetch fails must not leave the shell holding a crumb it will replace
    /// the step's data with.
    private func reload() async {
        await model.load(sessionId: props.sessionId, weekStart: props.weekStart)
        if let crumb = model.crumb { props.setDecisionData(crumb) }
    }

    private func answer(
        _ personId: String,
        focus: PlanningKidPick = .absent,
        forward: PlanningKidPick = .absent
    ) {
        guard !model.isFrozen(shellBusy: props.busy) else { return }
        Task {
            await model.answer(
                sessionId: props.sessionId, personId: personId, weekStart: props.weekStart,
                focus: focus, forward: forward)
            // The crumb rides the `rev` bump on the body rather than being set here twice.
            props.refresh()
        }
    }
}

/// The escape hatch's box.
///
/// `initial` is what they said last time when this is reopening their own answer, or the
/// draft they typed and never saved — an empty box here discards words somebody already
/// dictated and makes the chip above look inert.
///
/// `onDraft` fires ONCE, as the box goes away, with whatever was in it. On disappear rather
/// than on every keystroke deliberately: the draft lives in the step's model, and writing
/// to it per character would re-render every card in the step to move a cursor.
private struct PlanningKidTypeIn: View {
    let placeholder: String
    let accessibilityLabel: String
    let initial: String
    let disabled: Bool
    let onCancel: () -> Void
    let onSave: (String) -> Void
    let onDraft: (String) -> Void

    /// The server caps free text at 120 characters and 400s past it; the box simply stops
    /// rather than letting a kid type a sentence that gets rejected.
    private static let maxLength = 120

    @State private var text: String
    @FocusState private var focused: Bool

    init(
        placeholder: String,
        accessibilityLabel: String,
        initial: String,
        disabled: Bool,
        onCancel: @escaping () -> Void,
        onSave: @escaping (String) -> Void,
        onDraft: @escaping (String) -> Void
    ) {
        self.placeholder = placeholder
        self.accessibilityLabel = accessibilityLabel
        self.initial = initial
        self.disabled = disabled
        self.onCancel = onCancel
        self.onSave = onSave
        self.onDraft = onDraft
        _text = State(initialValue: initial)
    }

    private var trimmed: String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField(placeholder, text: $text)
                .font(.system(size: 15))
                .focused($focused)
                .submitLabel(.done)
                .onSubmit(save)
                .padding(.horizontal, 12).padding(.vertical, 10)
                .wfField()
                .accessibilityLabel(accessibilityLabel)
            HStack(spacing: 8) {
                Button(action: onCancel) {
                    Text("Cancel")
                        .font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink2)
                        .frame(maxWidth: .infinity).padding(.vertical, 14)
                        .background(WF.panel)
                        .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                }
                .buttonStyle(.plain)
                WaffledPrimaryCTA(
                    label: "Save", isDisabled: disabled || trimmed.isEmpty, action: save)
            }
        }
        .onAppear { focused = true }
        .onChange(of: text) { _, latest in
            if latest.count > Self.maxLength { text = String(latest.prefix(Self.maxLength)) }
        }
        .onDisappear { onDraft(text) }
    }

    private func save() {
        let value = trimmed
        guard !disabled, !value.isEmpty else { return }
        onSave(value)
    }
}
