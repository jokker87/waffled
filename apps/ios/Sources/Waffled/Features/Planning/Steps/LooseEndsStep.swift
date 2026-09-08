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
/// WHO ALREADY HAS IT — one view, both modes.
///
/// Not two lookalikes: this step renders a row in the card deck AND in see-all, and this
/// app has been bitten three times by a component copied because the original was local to
/// one place. The wash-behind-the-avatar treatment is the Tasks board's own, so a face
/// reads the same in a planning row as it does on the chores board.
///
/// `Color(hexString:)` rather than a `WF` token on purpose: this is real `persons.color_hex`
/// data — an identity colour, not a theme surface — which is the documented exception to
/// the never-hardcode-a-colour rule.
struct PlanningOwnerChip: View {
    let owner: WaffledAPI.LooseEndOwner

    var body: some View {
        HStack(spacing: 5) {
            Text(owner.avatarEmoji ?? "🙂")
                .font(.system(size: 11))
                .frame(width: 18, height: 18)
                .background((owner.colorHex.flatMap { Color(hexString: $0) } ?? WF.ink3).opacity(0.13))
                .clipShape(Circle())
            Text(owner.name)
                .font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink2)
                .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(owner.name) has this")
    }
}

struct LooseEndsStepView: View {
    let props: PlanningStepProps

    /// Who is running the session — for the lists chooser's gate. The viewer's own
    /// capabilities, read the same way every other gated control in this app reads them,
    /// so there is one answer to "may I" rather than a flag on the payload as well.
    @Environment(SyncManager.self) private var sync

    @State private var model = PlanningLooseEndsModel()
    @State private var group: LooseEndGroup = .notDone
    /// Verification only: `WAFFLED_LE_SEEALL` starts in see-all. See DemoHooks.
    @State private var seeAll = DemoHooks.looseEndsSeeAll
    @State private var chooser = false
    /// The list whose switch is mid-write, so only that row dims.
    @State private var ruling: String?
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

            // WHICH LISTS THIS STEP ASKS ABOUT. Under the note rather than in the bar:
            // the bar already carries the group switch and "See all", and a third control
            // on a phone-width row is how this screen ended up "taking up 50% of the
            // screen" the first time. Only under "not done" — the parked board has no
            // lists behind it — and only for somebody who may make the choice.
            if showChooser { listsButton }

            if let message = model.errorMessage {
                DismissibleErrorBanner(message: message) { model.clearError() }
            }

            content

            trail

            // In card mode the capture bar belongs to group B's deck, so it shows with it.
            if group == .parked && !seeAll { captureBar }
        }
        .sheet(isPresented: $chooser) { listsSheet }
        // Verification only: open the chooser without a tap. See DemoHooks.openLists.
        .task(id: model.listCandidates.count) {
            if DemoHooks.openLists && showChooser { chooser = true }
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

    // MARK: - Which lists this step asks about

    /// Absent entirely rather than disabled: a control that opens an empty sheet, or one
    /// that refuses on save, is worse than no control.
    ///
    /// `planning.manage` is adult-by-default and NOT admin — "any adult can run weekly
    /// planning and choose what lists should matter vs not" — so the person driving the
    /// session on a Sunday evening can do this without going to Settings, which is
    /// admin-only and on the other side of the app.
    private var showChooser: Bool {
        sync.can("planning.manage")
            && !model.listCandidates.isEmpty
            && (seeAll || group == .notDone)
    }

    private var listsButton: some View {
        Button {
            chooser = true
        } label: {
            HStack(spacing: 6) {
                Text("Which lists?").font(.system(size: 13, weight: .bold))
                Text(listsSummary).font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
            }
            .foregroundStyle(WF.ai)
        }
        .buttonStyle(.plain)
    }

    /// "2 of 3" — said here rather than in the sheet, because the whole point of the line
    /// is to tell you something is being left out before you open anything.
    private var listsSummary: String {
        let all = model.listCandidates
        let on = all.filter(\.relevant).count
        return on == all.count ? "asking about all \(all.count)" : "asking about \(on) of \(all.count)"
    }

    private var listsSheet: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text("This step asks about anything still unchecked from before this week. Turn off a list that’s meant to stay open — a someday list, a wishlist — and it stops coming up every session. Your grocery list is never asked about: it rebuilds itself from the meal plan.")
                        .font(.system(size: 12.5)).foregroundStyle(WF.ink3)
                        .fixedSize(horizontal: false, vertical: true)

                    WaffledCard(padding: 4) {
                        VStack(spacing: 0) {
                            ForEach(Array(model.listCandidates.enumerated()), id: \.element.id) { i, list in
                                if i > 0 { Divider().background(WF.hair) }
                                HStack(spacing: 11) {
                                    Text([list.emoji, list.name].compactMap { $0 }.joined(separator: " "))
                                        .font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                                    Spacer(minLength: 8)
                                    Toggle("", isOn: Binding(
                                        get: { list.relevant },
                                        set: { on in rule(list.id, on) }))
                                        .labelsHidden().tint(WF.primary)
                                        .disabled(disabled || ruling != nil)
                                        .accessibilityLabel("Ask about \(list.name) in the weekly planning session")
                                }
                                .padding(.horizontal, 11).padding(.vertical, 11)
                                .opacity(ruling == list.id ? 0.5 : 1)
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
            }
            .background(WF.canvas)
            .navigationTitle("Lists it asks about")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { chooser = false }.font(.system(size: 15, weight: .bold))
                }
            }
        }
    }

    /// The write, then the step's own re-read — a list ruled out takes its cards out of
    /// the deck with it, and which cards those were is the server's answer.
    private func rule(_ id: String, _ on: Bool) {
        guard ruling == nil else { return }
        ruling = id
        Task {
            _ = await model.ruleList(
                id, relevant: on, weekStart: props.weekStart, sessionId: props.sessionId)
            ruling = nil
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
                        HStack(spacing: 8) {
                            SectionLabel(text: LooseEndCopy.kindLabel(item.kind))
                            if let owner = item.owner { PlanningOwnerChip(owner: owner) }
                            Spacer(minLength: 0)
                        }
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
                    VStack(alignment: .leading, spacing: 3) {
                        Text(item.title).font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
                            .fixedSize(horizontal: false, vertical: true)
                        // WHERE IT CAME FROM, and who has it. The card deck has always
                        // named the kind; see-all dropped it, which is how a screen of
                        // eleven rows ended up with a chore called "Groceries"
                        // indistinguishable in kind from an unchecked list item.
                        //
                        // `ChipFlow` rather than an HStack: at phone width a long list
                        // name plus a person's name has to wrap, and truncating the owner
                        // would defeat the point of showing it.
                        ChipFlow(spacing: 6, lineSpacing: 3) {
                            Text(LooseEndCopy.kindLabel(item.kind).uppercased())
                                .font(.system(size: 10.5, weight: .heavy)).tracking(0.5)
                                .foregroundStyle(WF.ink3)
                            if let detail = item.detail, !detail.isEmpty {
                                Text(detail).font(.system(size: 12)).foregroundStyle(WF.ink3)
                            }
                            if let owner = item.owner { PlanningOwnerChip(owner: owner) }
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
