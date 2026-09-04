import SwiftUI

/// Weekly Planning · step 8 "Tasks" — "Who's doing what?"
///
/// Per-person columns, an up-for-grabs strip, and the existing chore editor for both
/// adding and editing.
///
/// Ported from `apps/web/src/kiosk/planning/steps/TasksStep.tsx`.
///
/// Laid out by person, in the same vocabulary the Chores screen uses, because that is
/// where the family already reads this. Everything nobody has taken sits in one strip at
/// the top with the member faces under each card: tap a face and the task moves to that
/// person; leave it and it stays up for grabs, which is a real answer and not an error
/// state. Each person's footer names the recurring load they already carry, so fairness
/// is visible without anyone computing a score.
///
/// EVERY MOVE IS REVERSIBLE. A card in a person's block carries the same faces as one in
/// the strip, plus a 🙌 that puts it back up for grabs — handing a task over is a
/// decision, and a decision you can't take back is a trap. Both directions move the
/// chore definition AND every open day of it already sitting on a kiosk board (see
/// `planningHandOutChore`), so the two screens can never end up disagreeing about who
/// has it.
///
/// THIS STEP LENDS THE SHELL'S PARKED-NOTE BANNER A VERB. "Make a task" opens the very
/// same `ChoreEditSheet` the strip's own "Add a task" opens, seeded with the note's
/// words, and reports back `true` only if a task was really created.
///
/// DRAGGING DOES THE SAME THING AS TAPPING, AND ADDS NOTHING OF ITS OWN. Grip a card,
/// drop it on a person's block or back on the strip; it resolves through the very same
/// `give` the faces call (`PlanningTasksModel.drop`), and a card dropped where it already
/// sits writes nothing. Tapping a face is NOT replaced by it — one gesture for the person
/// who reaches for a drag, one for the person who can't. Three things this cost us:
///
///  * **The drag lives on a grip, not on the whole card.** A card holds three Buttons
///    (title, day chip, faces); making the card itself `.draggable` would have meant
///    demoting those to `.onTapGesture` and fighting the drag for every tap.
///  * **The payload is a custom `PlanningTaskDrag`, never a `String`.** A string id is
///    offered to every text field in the app and gets pasted in as text.
///  * **Not a `List`.** `List` silently refuses `.dropDestination`, so the drop targets
///    would have been dead with no error anywhere. The shell's `ScrollView` around this
///    body is what the drop targets live in; this step must never become a `List`.
///
/// ONE KNOWN DIVERGENCE FROM THE WEB, deliberate: **the chore editor here cannot delete**
/// (`canDelete: false`, matching the web). This step asks who does what, not which chores
/// should exist: removing one reaches far outside the week being planned, and the Meals
/// step's shopping trip is a real chore on this very board whose identity other steps
/// resolve by id.
///
/// The body is content-sized: the SHELL owns the scroll view, so there is no `ScrollView`
/// and no `WF.tabBarClearance` here — and no horizontal padding of its own either. The
/// shell already insets every step by 16, and a second 16 here drew this step's columns
/// 32pt narrower than the Calendar and Meals steps beside it.
struct TasksStepView: View {
    let props: PlanningStepProps

    @Environment(SyncManager.self) private var sync
    @State private var model = PlanningTasksModel()

    /// Moving a task between people is `chore.manage` — the server enforces it, and the
    /// Chores board hides its own drag grip the same way. Don't offer a tap that 403s.
    private var canAssign: Bool { sync.can("chore.manage") }
    /// A write is in flight somewhere — the shell's or ours.
    private var frozen: Bool { props.busy || model.savingChoreId != nil }

    /// The column a drag is hovering, for the highlight ring. Nil the rest of the time.
    @State private var dropTarget: PlanningTaskColumn?

    /// Whether a column should accept drops right now. A ring that lights up while a
    /// write is already in flight is a ring that lies — `give` refuses a second one.
    ///
    /// DELIBERATELY NOT USED TO GATE THE GRIP. `frozen` flips the moment a hand-out
    /// starts, so gating the grip on it would delete the drag source out from under the
    /// finger holding it — including the very drag that started the write. The Chores
    /// board gates its own grip on the permission alone for the same reason. A grip whose
    /// drop lands nowhere is far better than one that vanishes mid-gesture.
    private var canDrop: Bool { canAssign && !frozen }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let message = model.errorMessage {
                DismissibleErrorBanner(message: message) { model.errorMessage = nil }
            }

            if let board = model.board {
                strip(board)
                ForEach(board.people) { person in
                    personBlock(person, board: board)
                }
            } else if model.loaded {
                WaffledEmptyState(
                    emoji: "🧹",
                    title: "Couldn't load the chores board",
                    message: "Try again in a moment — nothing has been changed.")
            } else {
                WaffledLoading()
            }
        }
        .task(id: props.weekStart) { await model.load(weekStart: props.weekStart) }
        .task { await sync.loadCurrencies() }
        // Both halves of the crumb: `rev` covers "what's still up for grabs" (it comes
        // off the board), `assigned` covers the tally, which a write can move even when
        // the re-read afterwards doesn't land.
        .onChange(of: model.rev) { props.setDecisionData(model.crumb) }
        .onChange(of: model.assigned) { props.setDecisionData(model.crumb) }
        .onAppear {
            // The verb this step lends the banner. `model` is a class, so the closure
            // captures the live instance rather than a stale copy of view state.
            let stepModel = model
            props.lendVerb(PlanningHandoffVerb(label: "Make a task") { note, done in
                stepModel.beginHandoff(note: note, done: done)
            })
        }
        .onDisappear {
            props.lendVerb(nil)
            // A note still sitting in an open composer is unfinished, and the banner has
            // to be told so rather than left waiting on a completion that never comes.
            model.abandonHandoff()
        }
        .sheet(item: composerBinding) { composer in
            editor(composer)
        }
    }

    // MARK: - Up for grabs

    @ViewBuilder
    private func strip(_ board: WaffledAPI.PlanningTasksBoard) -> some View {
        VStack(alignment: .leading, spacing: 11) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 9) {
                    Text("🙌").font(.system(size: 17))
                        .frame(width: 34, height: 34)
                        .background(WF.card.opacity(0.6)).clipShape(Circle())
                    Text("Up for grabs")
                        .font(.system(size: 16, weight: .bold)).foregroundStyle(WF.ink)
                }
                // The drag hint is in the copy because a drag is otherwise invisible —
                // there is no way to discover a grip you weren't told about (web parity).
                Text(board.unassigned.isEmpty
                     ? "✓ Everything's handed out."
                     : canAssign
                        ? "Tap a face (or drag the card by its grip) to hand one over. Leaving one up for grabs is a real answer — whoever does it gets the stars."
                        : "Whoever does one gets the stars.")
                    .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(WF.ink2)
                    .fixedSize(horizontal: false, vertical: true)
            }

            ForEach(board.unassigned) { chore in
                choreCard(chore, owner: nil, board: board)
            }

            // The strip's own tile — a task nobody owns yet, which is not the same thing
            // as adding one to a person's column.
            addButton("Add a task") { model.openAdd(personId: nil) }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        // The same shared tint the Chores board gives its up-for-grabs column, as tokens
        // so dark mode comes for free.
        .background(LinearGradient(colors: [WF.aiT, WF.infoT], startPoint: .topLeading, endPoint: .bottomTrailing))
        .clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
        .wfShadow1()
        // The strip is a drop target too, which is what makes a hand-out reversible by
        // drag as well as by tap (web parity).
        .planningTaskDropTarget(.upForGrabs, enabled: canDrop, hovered: $dropTarget, onDrop: drop)
    }

    // MARK: - One person

    @ViewBuilder
    private func personBlock(_ person: WaffledAPI.PlanningTasksPerson,
                             board: WaffledAPI.PlanningTasksBoard) -> some View {
        WaffledCard(padding: 14) {
            VStack(alignment: .leading, spacing: 11) {
                HStack(spacing: 9) {
                    Avatar(colorHex: person.colorHex, emoji: person.avatarEmoji ?? "🙂", size: 34)
                    Text(person.name)
                        .font(.system(size: 16, weight: .bold)).foregroundStyle(WF.ink)
                    Spacer(minLength: 6)
                    Text("\(person.chores.count) this week")
                        .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
                }

                if person.chores.isEmpty {
                    Text("Nothing on \(person.name)'s week yet.")
                        .font(.system(size: 12.5)).foregroundStyle(WF.ink3)
                } else {
                    ForEach(person.chores) { chore in
                        choreCard(chore, owner: person.id, board: board)
                    }
                }

                addButton("Add for \(person.name)") { model.openAdd(personId: person.id) }

                // What they already carry — the fairness read, stated rather than scored.
                Text(model.carries[person.id] ?? "")
                    .font(.system(size: 11.5, weight: .semibold)).foregroundStyle(WF.ink3)
            }
        }
        // Drop a card anywhere on somebody's block to hand it to them — the whole block,
        // not a slot inside it, because the block IS the answer to "who's doing what".
        .planningTaskDropTarget(.person(person.id), enabled: canDrop,
                                hovered: $dropTarget, onDrop: drop)
    }

    // MARK: - One card
    //
    // FIVE regions that must never be mistaken for each other, and they are SIBLINGS,
    // not nested — so no tap has to be stopped from reaching a parent and no region can
    // swallow another's:
    //   the grip          drags the card onto a person (or the strip)
    //   the title block   opens the app's own chore editor
    //   the day chip      opens the SAME editor (one card, one editor, so a title change
    //                     and a day change can't race each other on the same chore)
    //   the faces         hand it over / take it back
    //   the reward badge  says what it's worth, and is not a control
    //
    // THE GRIP IS WHY THE CARD ITSELF ISN'T `.draggable`. Three of those regions are
    // Buttons; a drag on the card would have to win the gesture from each of them, which
    // means demoting every one to `.onTapGesture` and hoping the arbitration goes our way
    // (RecipeEditorView's ingredient rows already learned this against TextFields). A
    // grip owns one small rectangle and takes nothing away from the taps beside it.

    @ViewBuilder
    private func choreCard(_ chore: WaffledAPI.PlanningTasksChore, owner: String?,
                           board: WaffledAPI.PlanningTasksBoard) -> some View {
        let unset = model.dayUnset[chore.id] ?? false
        // Unset AND settable reads as an invitation; unset with nothing you can do about
        // it stays the calm statement of fact it was.
        let settable = canAssign && (model.daySettable[chore.id] ?? false)
        let chipText = unset && settable ? "Set a day" : (model.dayChip[chore.id] ?? "")

        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 8) {
                // The PERMISSION only — never `frozen`. See `canDrop`.
                if canAssign { grip(chore) }
                if canAssign {
                    // Editing a chore is PATCH /api/chores/:id, which the chores module
                    // gates on chore.manage — the same rule the board applies when it
                    // decides whether a card opens the editor. No looser rule here: a
                    // sheet that 403s on Save is worse than no sheet.
                    Button { model.openEdit(chore, owner: owner) } label: {
                        titleBlock(chore)
                    }
                    .buttonStyle(.plain)
                    .disabled(frozen)
                    .accessibilityLabel("Edit \(chore.title)")
                } else {
                    titleBlock(chore)
                }
            }

            HStack(spacing: 8) {
                if settable {
                    Button { model.openEdit(chore, owner: owner) } label: {
                        chip(chipText, unset: unset)
                    }
                    .buttonStyle(.plain)
                    .disabled(frozen)
                    .accessibilityLabel("Set the day for \(chore.title)")
                } else {
                    chip(chipText, unset: unset)
                }
                Spacer(minLength: 4)
                if chore.rewardAmount > 0 {
                    WaffledStatusBadge(
                        text: "\(sync.currencySymbol(chore.rewardCurrency)) \(rewardText(chore.rewardAmount))",
                        color: WF.gold)
                }
            }

            if canAssign, !board.people.isEmpty {
                ChipFlow(spacing: 8, lineSpacing: 8) {
                    // 🙌 is the undo: put it back where anybody can take it. Only on a
                    // card somebody is holding — the strip is already up for grabs.
                    if owner != nil {
                        Button { give(chore, to: nil) } label: {
                            Text("🙌").font(.system(size: 17))
                                .frame(width: 36, height: 36)
                                .background(WF.card).clipShape(Circle())
                                .overlay(Circle().strokeBorder(WF.hair, lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                        .disabled(frozen)
                        .accessibilityLabel("Put \(chore.title) back up for grabs")
                    }
                    ForEach(board.people.filter { $0.id != owner }) { person in
                        Button { give(chore, to: person.id) } label: {
                            Avatar(colorHex: person.colorHex, emoji: person.avatarEmoji ?? "🙂", size: 36)
                        }
                        .buttonStyle(.plain)
                        .disabled(frozen)
                        .accessibilityLabel("Give \(chore.title) to \(person.name)")
                    }
                }
            }
        }
        .padding(11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .wfField(radius: WF.rMD, fill: WF.panel)
        .opacity(model.savingChoreId == chore.id ? 0.55 : 1)
    }

    /// The drag handle. Same glyph the recipe editor's ingredient rows use, so "this is
    /// the bit you grab" reads the same wherever the app offers a drag.
    ///
    /// HIDDEN FROM VOICEOVER ON PURPOSE. A drag isn't a gesture VoiceOver can perform, so
    /// a labelled grip would be a dead end; the faces below the card are the accessible
    /// way to hand a task over, and they do exactly the same thing.
    private func grip(_ chore: WaffledAPI.PlanningTasksChore) -> some View {
        Image(systemName: "line.3.horizontal")
            .font(.system(size: 13, weight: .bold)).foregroundStyle(WF.ink3)
            .frame(width: 22, height: 30).contentShape(Rectangle())
            .draggable(PlanningTaskDrag(choreId: chore.id)) { dragPreview(chore) }
            .accessibilityHidden(true)
    }

    /// The floating ghost under the finger — the Chores board's own drag preview, because
    /// this is the same act on the same data and it should look like it.
    private func dragPreview(_ chore: WaffledAPI.PlanningTasksChore) -> some View {
        HStack(spacing: 6) {
            Text(chore.emoji ?? "🧹").font(.system(size: 14))
            Text(chore.title)
                .font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink).lineLimit(1)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(WF.card)
        .clipShape(Capsule())
        .overlay(Capsule().strokeBorder(WF.gold.opacity(0.5), lineWidth: 1))
    }

    private func titleBlock(_ chore: WaffledAPI.PlanningTasksChore) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("\(chore.emoji.map { "\($0) " } ?? "")\(chore.title)")
                .font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
                .multilineTextAlignment(.leading)
            Text(model.provenance[chore.id] ?? "")
                .font(.system(size: 11.5, weight: .semibold)).foregroundStyle(WF.ink3)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func chip(_ text: String, unset: Bool) -> some View {
        Text(text)
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(unset ? WF.ink3 : WF.ink2)
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(WF.card)
            .clipShape(Capsule())
            .overlay(Capsule().strokeBorder(WF.hair, lineWidth: 1))
    }

    private func addButton(_ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: "plus").font(.system(size: 12, weight: .bold))
                Text(label).font(.system(size: 13, weight: .bold))
            }
            .foregroundStyle(props.busy ? WF.ink3 : WF.ink2)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(WF.card)
            .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous)
                .strokeBorder(WF.hair, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(props.busy)
    }

    /// "3", not "3.0" — the amount is a `Double` on the wire but a whole number of stars
    /// in every household anybody has.
    private func rewardText(_ amount: Double) -> String {
        amount == amount.rounded() ? String(Int(amount)) : String(format: "%.1f", amount)
    }

    // MARK: - The app's own chore editor

    /// `.sheet(item:)` hands nil back on dismissal — which fires for a cancel and a save
    /// alike — so the model decides what that meant and reports the handoff honestly.
    private var composerBinding: Binding<PlanningTasksModel.Composer?> {
        Binding(
            get: { model.composer },
            set: { new in
                guard new == nil else { return }
                if model.composerDismissed() { reload() }
            })
    }

    @ViewBuilder
    private func editor(_ composer: PlanningTasksModel.Composer) -> some View {
        // Snapshot the sync-derived inputs HERE (read `sync` once) instead of letting the
        // sheet observe SyncManager — observing it re-lays-out the whole sheet on every
        // unrelated sync mutation, which is what hung the Chores board's editor.
        // Managers can assign to anyone; everyone else only to themselves (web parity).
        let assignable = canAssign ? sync.members : sync.members.filter { $0.id == sync.currentPersonId }

        switch composer {
        case let .add(personId, note):
            ChoreEditSheet(
                assignableMembers: assignable,
                currencies: sync.currencies,
                target: .new(personId: personId),
                // This step asks who does what, not which chores should exist — see the
                // Planning a week is mostly one-offs ("book the sitter", "return the
                // books"), and the editor already defaults a new chore to "Just once" —
                // dated to the day the SERVER picked for this session rather than to
                // whatever day this phone thinks it is.
                initialDate: DateFmt.date(model.newTaskDay ?? "", "yyyy-MM-dd", .current) ?? Date(),
                // The parked note's own words, so nobody retypes what they already wrote.
                prefillTitle: note,
                // This step asks who does what, not which chores should exist — see the
                // note on the type.
                canDelete: false,
                onSave: { choreId, body in await model.saveFromComposer(choreId: choreId, body: body) },
                onDelete: { _ in })

        case let .edit(chore, owner):
            if let instance = chore.asChoreInstance(owner: owner) {
                ChoreEditSheet(
                    assignableMembers: assignable,
                    currencies: sync.currencies,
                    target: .edit(instance),
                    initialDate: DateFmt.date(chore.dueOn ?? model.newTaskDay ?? "", "yyyy-MM-dd", .current) ?? Date(),
                    // Web parity: this step asks who does what, not which chores should
                    // exist. Deleting one reaches far outside the week being planned, and
                    // the Meals step's shopping trip is a real chore on this very board
                    // whose identity other steps resolve by id. With the button gone,
                    // `onDelete` below is unreachable — kept only to satisfy the
                    // initialiser.
                    canDelete: false,
                    onSave: { choreId, body in await model.saveFromComposer(choreId: choreId, body: body) },
                    onDelete: { choreId in
                        Task {
                            try? await WaffledAPI().deleteChore(id: choreId)
                            reload()
                        }
                    })
            }
        }
    }

    // MARK: - Plumbing

    private func give(_ chore: WaffledAPI.PlanningTasksChore, to personId: String?) {
        Task {
            if await model.give(chore, to: personId, weekStart: props.weekStart) { props.refresh() }
        }
    }

    /// A card landed on a column. The model decides what that MEANS — including that it
    /// means nothing, when the card was dropped where it already sat.
    private func drop(_ choreId: String, onto column: PlanningTaskColumn) {
        Task {
            if await model.drop(choreId: choreId, onto: column, weekStart: props.weekStart) {
                props.refresh()
            }
        }
    }

    private func reload() {
        Task {
            await model.load(weekStart: props.weekStart)
            // Chores changed under every other screen too — the tab badge, Today's
            // "Needs your OK", the kiosk board.
            sync.bumpChores()
            props.refresh()
        }
    }
}

// MARK: - A column as a drop target

private extension View {
    /// Make this surface accept a dragged task card, with the highlight ring that says
    /// so. Used by the up-for-grabs strip and by every person's block, so the two
    /// directions of a hand-out are the same piece of code — a drag can never do
    /// something the drag back can't undo.
    ///
    /// `enabled: false` attaches NO drop destination at all, rather than one that refuses
    /// on arrival: a ring that lights up for a drop that can't land is worse than no ring.
    ///
    /// Attached AFTER the surface's own background/clipShape/shadow — modifier order is
    /// load-bearing for drag and drop (see `MealPlanReviewCard`).
    ///
    /// This works ONLY because the step body is NOT a `List` — it is plain content inside
    /// the shell's own `ScrollView`. `List` silently drops `.dropDestination` with no
    /// error anywhere, so do not restructure the step into one.
    @ViewBuilder
    func planningTaskDropTarget(_ column: PlanningTaskColumn, enabled: Bool,
                                hovered: Binding<PlanningTaskColumn?>,
                                onDrop: @escaping (String, PlanningTaskColumn) -> Void) -> some View {
        if enabled {
            overlay(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous)
                .strokeBorder(hovered.wrappedValue == column ? WF.primary : .clear, lineWidth: 2))
            .dropDestination(for: PlanningTaskDrag.self) { items, _ in
                hovered.wrappedValue = nil
                guard let dragged = items.first else { return false }
                onDrop(dragged.choreId, column)
                // TRUE even when the model resolves the drop to nothing (a card dropped
                // where it already sat). It WAS a valid target; returning false fires the
                // snap-back animation, which reads as a rejection of a harmless gesture.
                return true
            } isTargeted: { over in
                withAnimation(.easeInOut(duration: 0.12)) {
                    hovered.wrappedValue = over
                        ? column
                        : (hovered.wrappedValue == column ? nil : hovered.wrappedValue)
                }
            }
        } else {
            self
        }
    }
}
