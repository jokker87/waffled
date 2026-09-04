import SwiftUI

/// Weekly Planning · step 1 "Loose ends" — "Anything still open from last week?"
///
/// What is still open, and the notes somebody parked — each routed to the step that will handle it.
///
/// Ported from `apps/web/src/kiosk/planning/steps/LooseEndsStep.tsx`. The state, the copy
/// and the card's choice table live in `LooseEndsModel.swift`; this file is the screen.
///
/// STEP 1 ROUTES; IT DOES NOT REPAIR. Every primary choice on the card is a DESTINATION —
/// the step that will handle the thing — and choosing one writes nothing to any module.
/// The see-all screen says so out loud, because it is the one claim a user has to believe
/// for the step to feel safe.
///
/// THE SWITCH BELONGS TO THE DECK, NOT TO SEE-ALL. See-all lists BOTH groups under their
/// own headings, so a switch there would govern nothing while still looking selected —
/// which read as "these are my not-done items" when it wasn't. So the switch renders only
/// in card mode; the way back is the "One at a time" control that never moves.
///
/// The body is content-sized on the assumption that the SHELL owns the scroll view (it
/// owns the chrome, the counter and the footer) — hence no `ScrollView` and no
/// `WF.tabBarClearance` here.
struct LooseEndsStepView: View {
    let props: PlanningStepProps

    @State private var model = PlanningLooseEndsModel()
    @State private var group: LooseEndGroup = .notDone
    @State private var seeAll = false
    @State private var note = ""
    @FocusState private var noteFocused: Bool

    /// The shell is writing, or we are. Either way the controls are cold.
    private var disabled: Bool { props.busy || model.working }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            bar

            // The switch is the entire explanation of the two kinds, so the note goes with
            // it — in see-all each section carries its own caption instead.
            if !seeAll {
                Text(group.note)
                    .font(.system(size: 12.5)).foregroundStyle(WF.ink3)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let message = model.errorMessage {
                DismissibleErrorBanner(message: message) { model.clearError() }
            }

            content

            trail

            // In card mode the capture bar belongs to group B's deck, so it shows with it.
            if group == .parked && !seeAll { captureBar }
        }
        // One key for both: a new session or a new week is a different set of loose ends.
        .task(id: "\(props.sessionId)|\(props.weekStart)") {
            model.resetForWeek()
            // The step's own persisted decisions, read BEFORE the fetch. `data.routes` is
            // therefore a READ dependency of this step, not only somewhere it writes: the
            // crumb replaces `data` when the step is answered, so a second visit whose
            // fetch failed must not push an empty array over what the first one routed.
            model.seedRoutes(from: props.step.data["routes"])
            await model.load(weekStart: props.weekStart, sessionId: props.sessionId)
            // Headless keyboard verification (`DemoHooks.focusPark`): the session footer is
            // PINNED, so the band between it and the keyboard is only measurable with the
            // keyboard up — and the Simulator has no way to tap a text field. The capture
            // bar belongs to group B's deck, so switch to it first or there is no field to
            // focus. The sleep waits for the deck to lay out; focus on a view that isn't on
            // screen yet is a silent no-op, exactly as it is on a disabled one.
            if DemoHooks.focusPark {
                group = .parked
                try? await Task.sleep(for: .seconds(1))
                noteFocused = true
            }
        }
        // The crumb, pushed on every state change rather than from five call sites.
        .onChange(of: model.revision) { _, _ in props.setDecisionData(model.decisionData) }
        // THIS STEP LENDS NOTHING. Its own bar PARKS notes, so a verb that turned a parked
        // note into a parked note is circular; the shell's banner keeps saying "Handled",
        // which is the honest answer here.
        .onAppear { props.lendVerb(nil) }
    }

    // MARK: - The bar

    @ViewBuilder private var bar: some View {
        HStack(spacing: 10) {
            if seeAll {
                // No switch here — see-all shows BOTH groups under their own headings.
                Text("Everything still open")
                    .font(.system(size: 14, weight: .bold)).foregroundStyle(WF.ink)
            } else {
                // The switch carries the distinction AND both counts, so you always know
                // what is left in the group you are not looking at. A cleared group shows
                // a check instead of a zero.
                HStack(spacing: 8) {
                    ForEach(LooseEndGroup.allCases, id: \.rawValue) { g in
                        Button {
                            group = g
                            model.clearError()
                        } label: {
                            HStack(spacing: 6) {
                                Text(g.label).font(.system(size: 13, weight: .bold))
                                    .foregroundStyle(g == group ? WF.ink : WF.ink2)
                                Text(model.remaining(g) == 0 ? "✓" : "\(model.remaining(g))")
                                    .font(.system(size: 12, weight: .heavy))
                                    .foregroundStyle(g == group ? WF.primary : WF.ink3)
                            }
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .wfChip(selected: g == group)
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(g == group ? .isSelected : [])
                    }
                }
            }
            Spacer(minLength: 6)
            // The escape hatch for the week somebody dropped twenty things — and, from
            // see-all, the only way back, which is why it never moves.
            Button(seeAll ? "One at a time" : "See all") { seeAll.toggle() }
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(WF.ai)
                .buttonStyle(.plain)
        }
    }

    // MARK: - Content

    @ViewBuilder private var content: some View {
        if !model.loaded {
            WaffledLoading(top: 24)
        } else if model.view == nil {
            WaffledEmptyState(
                emoji: "🌐",
                title: "Couldn’t read your loose ends",
                message: "Check your connection and try again.",
                top: 24)
        } else if seeAll {
            seeAllList
        } else if let card = model.open(group).first {
            deck(card)
        } else {
            cleared
        }
    }

    // MARK: one at a time

    @ViewBuilder private func deck(_ item: WaffledAPI.LooseEnd) -> some View {
        let total = model.total(group)
        let position = total - model.remaining(group) + 1
        let built = LooseEndChoice.build(item: item, group: group, destinations: model.destinations(group))

        VStack(alignment: .leading, spacing: 10) {
            Text("\(position) of \(total)")
                .font(.system(size: 12, weight: .heavy)).foregroundStyle(WF.ink3)

            // Two offset layers behind the card, so it reads as a stack you are working
            // through rather than a form that happens to change.
            ZStack(alignment: .top) {
                RoundedRectangle(cornerRadius: WF.rLG, style: .continuous)
                    .fill(WF.card).opacity(0.5)
                    .frame(height: 40)
                    .padding(.horizontal, 18).offset(y: 12)
                RoundedRectangle(cornerRadius: WF.rLG, style: .continuous)
                    .fill(WF.card).opacity(0.75)
                    .frame(height: 40)
                    .padding(.horizontal, 9).offset(y: 6)

                WaffledCard(padding: 16) {
                    VStack(alignment: .leading, spacing: 10) {
                        SectionLabel(text: LooseEndCopy.kindLabel(item.kind))
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            if let emoji = item.emoji, !emoji.isEmpty {
                                Text(emoji).font(.system(size: 20))
                            }
                            Text(item.title)
                                .font(WF.serif(20)).foregroundStyle(WF.ink)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        if let detail = item.detail, !detail.isEmpty {
                            Text(detail).font(.system(size: 13)).foregroundStyle(WF.ink3)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        VStack(spacing: 8) {
                            ForEach(built.choices) { choice in
                                choiceButton(choice, item: item)
                            }
                        }
                        .padding(.top, 2)
                        if !built.quiet.isEmpty {
                            HStack(spacing: 14) {
                                ForEach(built.quiet) { choice in
                                    Button(choice.label) { perform(choice, on: item) }
                                        .font(.system(size: 13, weight: .semibold))
                                        .foregroundStyle(WF.ink2)
                                        .buttonStyle(.plain)
                                        .disabled(disabled)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    /// One full-width choice — the label, and the reason under it. Full width rather than
    /// the web's two-column grid: four destinations at phone width would each be a
    /// truncated two-word column, and the hint is half of what makes the choice choosable.
    private func choiceButton(_ choice: LooseEndChoice, item: WaffledAPI.LooseEnd) -> some View {
        Button {
            perform(choice, on: item)
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(choice.label)
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(choice.isPrimary ? WF.onInk : WF.ink)
                    Text(choice.hint)
                        .font(.system(size: 12))
                        .foregroundStyle(choice.isPrimary ? WF.onInk.opacity(0.75) : WF.ink3)
                }
                Spacer(minLength: 6)
                Image(systemName: "arrow.right")
                    .font(.system(size: 12, weight: .heavy))
                    .foregroundStyle(choice.isPrimary ? WF.onInk.opacity(0.8) : WF.ink3)
                    .opacity(isRoute(choice) ? 1 : 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14).padding(.vertical, 11)
            // A primary destination fills with ink, so its label takes `WF.onInk` — never
            // `.white`, which would go white-on-white once ink flips in dark mode.
            .background(choice.isPrimary ? WF.ink : WF.panel)
            .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.6 : 1)
    }

    private func isRoute(_ choice: LooseEndChoice) -> Bool {
        if case .route = choice.act { return true }
        return false
    }

    // MARK: see all

    @ViewBuilder private var seeAllList: some View {
        VStack(alignment: .leading, spacing: 16) {
            // The one claim the user has to believe for this step to feel safe.
            Text(LooseEndCopy.disclaimer)
                .font(.system(size: 12.5)).foregroundStyle(WF.ink2)
                .fixedSize(horizontal: false, vertical: true)
                .padding(11)
                .frame(maxWidth: .infinity, alignment: .leading)
                .wfField(fill: WF.panel)

            ForEach(LooseEndGroup.allCases, id: \.rawValue) { g in
                VStack(alignment: .leading, spacing: 10) {
                    // With no switch above, the heading is the whole label for what
                    // follows: the name, the count the switch used to carry, and the
                    // four-word version of what the group means.
                    HStack(spacing: 6) {
                        Text(g.label).font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
                        Text(model.remaining(g) == 0 ? "✓" : "\(model.remaining(g))")
                            .font(.system(size: 12, weight: .heavy)).foregroundStyle(WF.primary)
                        Text("· \(g.caption)").font(.system(size: 12)).foregroundStyle(WF.ink3)
                    }
                    if model.open(g).isEmpty {
                        Text(g == .parked ? "Nothing parked is waiting." : "Nothing left open.")
                            .font(.system(size: 13)).foregroundStyle(WF.ink3)
                    } else {
                        VStack(spacing: 8) {
                            ForEach(model.open(g), id: \.key) { item in row(item, group: g) }
                        }
                    }
                    // The capture bar is reachable in BOTH modes — "See all" reads as the
                    // fuller screen and must not be the one place you cannot write
                    // something down. Inside the Parked section, so what it adds to is
                    // never in question.
                    if g == .parked { captureBar }
                }
            }
        }
    }

    private func row(_ item: WaffledAPI.LooseEnd, group g: LooseEndGroup) -> some View {
        WaffledCard(padding: 12) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top, spacing: 8) {
                    Text(item.emoji.flatMap { $0.isEmpty ? nil : $0 } ?? "•")
                        .font(.system(size: 15))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.title).font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
                            .fixedSize(horizontal: false, vertical: true)
                        if let detail = item.detail, !detail.isEmpty {
                            Text(detail).font(.system(size: 12)).foregroundStyle(WF.ink3)
                        }
                    }
                    Spacer(minLength: 0)
                }
                // Every choice as a pill — the destinations first, then the answers that
                // write. `ChipFlow` wraps them rather than scrolling, so nothing hides.
                ChipFlow(spacing: 6, lineSpacing: 6) {
                    ForEach(model.destinations(g), id: \.to) { d in
                        pill(d.label, primary: d.primary == true) { sendOn(item, from: g, to: d.to) }
                    }
                    ForEach(item.actions, id: \.self) { a in
                        pill(LooseEndCopy.actionLabel(a, kind: item.kind), primary: false) {
                            settle(item, action: a)
                        }
                    }
                }
            }
        }
    }

    private func pill(_ label: String, primary: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 12.5, weight: .bold))
                .foregroundStyle(primary ? WF.onInk : WF.ink2)
                .padding(.horizontal, 11).padding(.vertical, 6)
                .background(primary ? WF.ink : WF.panel)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.6 : 1)
    }

    // MARK: cleared

    @ViewBuilder private var cleared: some View {
        let other = group.other
        VStack(spacing: 10) {
            Text("✓").font(.system(size: 34, weight: .heavy)).foregroundStyle(WF.success)
            Text(LooseEndCopy.clearedTitle(group)).font(WF.serif(20)).foregroundStyle(WF.ink)
            Text(LooseEndCopy.clearedSubtitle(
                group, sources: model.view?.sources ?? [], remainingOther: model.remaining(other)))
                .font(.system(size: 13)).foregroundStyle(WF.ink3)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            if model.remaining(other) > 0 {
                WaffledPrimaryCTA(label: "Go to \(other.label)") { group = other }
                    .padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 18)
    }

    // MARK: trail

    @ViewBuilder private var trail: some View {
        let items = model.trail
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text(LooseEndCopy.trailCaption)
                    .font(.system(size: 11.5, weight: .semibold)).foregroundStyle(WF.ink3)
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(Array(items.enumerated()), id: \.offset) { index, route in
                    HStack(spacing: 6) {
                        Text(route.title)
                            .font(.system(size: 13, weight: index == 0 ? .bold : .semibold))
                            .foregroundStyle(index == 0 ? WF.ink : WF.ink2)
                            .lineLimit(1)
                        Text("→").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink3)
                        Text(model.stepName(route.to))
                            .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink2)
                        Spacer(minLength: 6)
                        if index == 0 {
                            Button("Undo") { undo(route) }
                            .font(.system(size: 13, weight: .bold))
                            .foregroundStyle(WF.ai)
                            .buttonStyle(.plain)
                            .disabled(disabled)
                        }
                    }
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .wfField(fill: WF.panel)
        }
    }

    // MARK: capture

    private var captureBar: some View {
        HStack(spacing: 8) {
            Text("＋").font(.system(size: 15, weight: .heavy)).foregroundStyle(WF.ink3)
            // NOT disabled while the write is in flight: focus on a disabled field is a
            // silent no-op, and this bar puts the cursor back after every note.
            TextField(LooseEndCopy.capturePlaceholder, text: $note)
                .font(.system(size: 15))
                .focused($noteFocused)
                .submitLabel(.done)
                .onSubmit { park() }
            Button("Park it") { park() }
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(canPark ? WF.primary : WF.ink3)
                .buttonStyle(.plain)
                .disabled(!canPark)
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .wfField()
        // NO `.wfKeyboardDoneToolbar` HERE, deliberately — see the note in
        // PlanningShellView.sessionScreen. That accessory bar measured ~79pt on an
        // iPhone 17 Pro for a single button, stacked directly on top of the session's
        // fixed footer: "why is there so much extra space?" The shell dismisses the
        // keyboard on scroll instead, and this field's keyboard has a return key.
    }

    private var canPark: Bool {
        !disabled && !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    // MARK: actions

    private func perform(_ choice: LooseEndChoice, on item: WaffledAPI.LooseEnd) {
        switch choice.act {
        case let .route(to):
            sendOn(item, from: group, to: to)
        case let .settle(action):
            settle(item, action: action)
        case .leave:
            model.leave(item)
        }
    }

    /// Send it on. The shell is told afterwards for the same reason the web emits
    /// `weeklyPlanning` on every route: routing a PARKED note sets its `step_key`, which is
    /// what the later steps' hand-off banners read, so the session view is genuinely stale
    /// until it re-reads.
    private func sendOn(_ item: WaffledAPI.LooseEnd, from g: LooseEndGroup, to: String) {
        Task {
            if await model.send(item, from: g, to: to, sessionId: props.sessionId) {
                props.refresh()
            }
        }
    }

    private func undo(_ r: WaffledAPI.LooseEndRoute) {
        Task {
            if await model.undo(r, sessionId: props.sessionId) { props.refresh() }
        }
    }

    private func settle(_ item: WaffledAPI.LooseEnd, action: String) {
        Task {
            let ok = await model.settle(
                item, action: action, weekStart: props.weekStart, sessionId: props.sessionId)
            // The write landed in another module, so the shell's counter and its agenda
            // sheet should agree with what just happened.
            if ok { props.refresh() }
        }
    }

    private func park() {
        let text = note
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        Task {
            if await model.park(text, weekStart: props.weekStart, sessionId: props.sessionId) {
                note = ""
                // Parking is a burst — somebody empties their head into the bar — so the
                // cursor goes back rather than making you re-aim at the field.
                noteFocused = true
                props.refresh()
            }
        }
    }
}
