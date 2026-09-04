import SwiftUI

/// Weekly Planning · step 6 "Goals" — "What's each group's focus this week?"
///
/// Ported from `apps/web/src/kiosk/planning/steps/GoalsStep.tsx`.
///
/// THE TABS ARE THE `goal_lists` THAT ALREADY EXIST: 🏡 the family one, 💛 the couple's
/// private one with its lock, one per person. Borrowing the group picker means only ONE
/// group is on screen at a time — six cards of everybody's goals is the thing this step
/// exists to avoid — and a ★ on a tab says that group has settled, so the room can see
/// what's left without reading all of them.
///
/// Picking a goal sets the goals module's own `is_featured` flag; there is no second
/// "focus" concept, and a pin somebody made by hand is never cleared. Picking NOTHING is a
/// real answer and settles the group just the same.
///
/// ANSWERING THE STEP IS SEPARATE FROM SETTING FOCUS. `/goals/focus` is a mid-step write:
/// it merges onto the step row and deliberately leaves `status` alone, so this body never
/// decides the step — the shell's affirmative does. What it must do is mirror the server's
/// own focus map back through `setDecisionData` after every read and every write, because
/// pressing that affirmative REPLACES the step's data with whatever the crumb holds.
///
/// PROGRESS GOES THROUGH `GoalDisplay`, never `totalProgress`: a habit's question is "how
/// many this period?" and it resets, so a lifetime count of 340 would read as long-since
/// done where this week's honest answer is "2 of 5".
///
/// "＋ NEW GOAL FOR THIS WEEK" OPENS THE GOALS MODULE'S OWN EDITOR AS A SHEET, not a route
/// away: leaving for the Goals screen abandons the session, and nothing brings the family
/// back, so a fifteen-second answer ejects them from the whole thing. Presented from here
/// the group is FIXED to the tab they were standing on (`lockedListId`, so it cannot be
/// answered for the wrong group by accident) and the goal is pinned on the way in
/// (`startFeatured`), which is what makes it come back as this week's focus without a
/// second trip.
struct GoalsStepView: View {
    let props: PlanningStepProps

    @Environment(SyncManager.self) private var sync
    @State private var model = PlanningGoalsStepModel()

    var body: some View {
        // NO OUTER ScrollView on purpose: the shell owns the chrome around a step, and
        // scrolling belongs with it — a second one nested inside would fight it.
        VStack(alignment: .leading, spacing: 12) {
            if !model.loaded {
                WaffledLoading()
            } else if model.view == nil {
                WaffledEmptyState(
                    emoji: "🎯",
                    title: "Couldn’t read your goals",
                    message: "Reload, or skip this step — skipping is a real answer.")
            } else if model.groups.isEmpty {
                WaffledEmptyState(
                    emoji: "🎯",
                    title: "No goal groups yet",
                    message: "Make one on the Goals screen and this step will have something to ask about. Skipping is a real answer in the meantime.")
            } else {
                tabs
                if let message = model.errorMessage {
                    DismissibleErrorBanner(message: message) { model.dismissError() }
                }
                if let active = model.active { groupCard(active) }
            }
        }
        // Keyed on the session, not a bare `.task`: stepping to another week starts a new
        // session, and this step must re-read rather than sit on the previous one's groups.
        .task(id: props.sessionId) { await reload() }
        // Mirror what the session already knows onto the crumb after EVERY fresh read AND
        // every write — not only after a tap. The shell resets the crumb on step change and
        // REPLACES the step's stored data when the affirmative is pressed, so a body that
        // only set it in its tap handler would erase its own record after a remount.
        //
        // NEVER `setDecisionData(model.crumb)` STRAIGHT THROUGH. Unlike the count-shaped
        // crumbs on Family Night and Tasks, this one is a MIRROR of server state that the
        // affirmative overwrites — so handing the shell a nil (a fetch that failed offline,
        // or 403'd because goals was toggled off mid-session) is not "no news", it is the
        // wipe: `decideStep` writes `data = excluded.data` with `input.data ?? {}`.
        .onChange(of: model.rev) {
            if let crumb = model.crumb { props.setDecisionData(crumb) }
        }
        // THIS STEP LENDS THE BANNER NOTHING, even though it now HAS a composer. The
        // banner's verb hands a parked note's words to a composer that then makes one
        // thing; this composer is scoped to the group on screen and would have to seed a
        // title as well, so "Make a goal" from the banner is a real feature and not a
        // rename of this one — tracked as a follow-up rather than half-done here.
        // Withdrawn explicitly, because the verb is the SHELL's state and would otherwise
        // still be the previous step's.
        .onAppear { props.lendVerb(nil) }
        // The goals module's REAL editor, over the week rather than instead of it —
        // presented through the goals module's OWN `.goalEditor` modifier, so it behaves
        // the way that editor behaves everywhere else (a sheet on the phone, a full-screen
        // cover on the family display) instead of growing a planning-only presentation.
        .goalEditor(isPresented: newGoalSheet) {
            if let g = model.newGoalGroup {
                GoalCreateSheet(
                    // One list, and it is the tab they were on: the sheet states the
                    // group instead of offering it, and derives `participantIds` from
                    // these members.
                    lists: [g.asGoalList],
                    defaultListId: g.listId,
                    // DELIBERATELY EMPTY. `members` only feeds the editor's "New group"
                    // sheet, which `lockedListId` removes — and handing it `sync.members`
                    // would make this presentation observe SyncManager and re-lay-out the
                    // whole editor on every unrelated sync mutation (the thing that hung
                    // the Chores board's editor; see `TasksStep.editor`).
                    members: [],
                    lockedListId: g.listId,
                    startFeatured: true
                ) { goalBody, _ in
                    // The GROUP IS CAPTURED HERE, synchronously, not read back off the
                    // model inside the task: the editor dismisses itself on submit, which
                    // clears the sheet flag before the task runs.
                    let target = g.listId
                    Task {
                        let made = await model.submitNewGoal(
                            sessionId: props.sessionId, listId: target, body: goalBody)
                        // The goal lives in the goals module, so tell the shell to
                        // re-read: the agenda sheet and the counter should agree. ONLY ON
                        // A REAL SAVE — a refresh flips the shell busy and greys the whole
                        // step out, which over a goal that never saved is a second, false
                        // failure on top of the banner.
                        if made { props.refresh() }
                    }
                }
            }
        }
    }

    /// The presentation flag, over the model's own state — the model, not the view,
    /// decides which group is being added to, so a refetch that lands mid-compose cannot
    /// move it.
    private var newGoalSheet: Binding<Bool> {
        Binding(
            get: { model.newForListId != nil },
            set: { if !$0 { model.closeNewGoal() } })
    }

    // MARK: - Tabs

    private var tabs: some View {
        VStack(alignment: .leading, spacing: 7) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(model.groups) { tab($0) }
                }
                // Room for the selected chip's 1.5pt border, which a clipped scroll view
                // would otherwise shave off the first and last tab.
                .padding(.horizontal, 2).padding(.vertical, 2)
            }
            Text("\(model.settledCount) of \(model.groups.count) settled")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(WF.ink3)
        }
    }

    private func tab(_ g: WaffledAPI.PlanningGoalGroup) -> some View {
        let on = g.listId == model.active?.listId
        return Button { model.selectTab(g.listId) } label: {
            HStack(spacing: 5) {
                Text(g.emoji ?? "🎯").font(.system(size: 14))
                Text(g.name)
                    .font(.system(size: 13.5, weight: .semibold))
                    .foregroundStyle(on ? WF.ink : WF.ink2)
                    .lineLimit(1)
                // The lock is the list's own privacy showing through — the server never
                // sent this tab to anyone outside the group in the first place.
                if g.isPrivate { Text("🔒").font(.system(size: 10)) }
                if g.settled {
                    Text("★").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.gold)
                }
            }
            // 14 rather than the usual 12: a settled tab's ★ is the last thing in the row,
            // and `wfChip` clips to a capsule whose curve eats into the ends.
            .padding(.horizontal, 14).padding(.vertical, 8)
            .wfChip(selected: on)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(g.settled ? "\(g.name), settled" : g.name)
        .accessibilityAddTraits(on ? [.isSelected] : [])
    }

    // MARK: - The group on screen

    private func groupCard(_ g: WaffledAPI.PlanningGoalGroup) -> some View {
        let frozen = model.isFrozen(shellBusy: props.busy)
        return WaffledCard(padding: 14) {
            VStack(alignment: .leading, spacing: 12) {
                header(g)

                VStack(spacing: 8) {
                    ForEach(g.goals) { goalOption($0, group: g, frozen: frozen) }
                    nothingOption(g, frozen: frozen)
                }

                Text(PlanningGoalsText.verdict(g))
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(g.settled && g.focusGoalId != nil ? WF.ink : WF.ink3)
                    .fixedSize(horizontal: false, vertical: true)

                newGoalButton(g, frozen: frozen)
            }
        }
    }

    /// The escape hatch, right under the verdict: nothing in this group is worth the
    /// week, so make the thing that is.
    ///
    /// GATED ON THE GOALS MODULE'S OWN RULE, not on nothing: `goal.manage` holders may add
    /// to any group, everybody else only to a group that is just them. Offering the editor
    /// for a group the server would refuse is show-then-403, so the button says why.
    private func newGoalButton(
        _ g: WaffledAPI.PlanningGoalGroup, frozen: Bool
    ) -> some View {
        let allowed = PlanningGoalsStepModel.canTarget(
            g, canManageGoals: sync.can("goal.manage"), personId: sync.currentPersonId)
        let off = frozen || !allowed

        return VStack(alignment: .leading, spacing: 4) {
            Button { model.openNewGoal() } label: {
                HStack(spacing: 5) {
                    Image(systemName: "plus").font(.system(size: 11, weight: .heavy))
                    Text("New goal for this week").font(.system(size: 13, weight: .bold))
                }
                .foregroundStyle(off ? WF.ink3 : WF.primary)
            }
            .buttonStyle(.plain)
            .disabled(off)

            if !allowed {
                Text("Adding a goal to \(g.name) needs permission to manage goals")
                    .font(.system(size: 11.5)).foregroundStyle(WF.ink3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func header(_ g: WaffledAPI.PlanningGoalGroup) -> some View {
        HStack(spacing: 10) {
            WaffledEmojiTile(emoji: g.emoji ?? "🎯")
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text(g.name).font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
                    if g.isPrivate { Text("🔒").font(.system(size: 11)) }
                }
                Text(PlanningGoalsText.groupSubtitle(g))
                    .font(.system(size: 12)).foregroundStyle(WF.ink3)
            }
            Spacer(minLength: 6)
            avatarStack(g.members)
        }
    }

    /// The group's people, overlapped. Four at most — beyond that the sub line already says
    /// how many there are, and a fifth face only makes the stack unreadable.
    private func avatarStack(_ members: [WaffledAPI.PlanningGoalMember]) -> some View {
        HStack(spacing: -8) {
            ForEach(members.prefix(4)) { m in
                Avatar(colorHex: m.colorHex, emoji: m.avatarEmoji ?? "🙂", size: 26)
                    .overlay(Circle().strokeBorder(WF.card, lineWidth: 1.5))
                    .accessibilityLabel(m.name)
            }
        }
    }

    // MARK: - One choosable goal

    private func goalOption(
        _ item: WaffledAPI.PlanningGoalGoal,
        group: WaffledAPI.PlanningGoalGroup,
        frozen: Bool
    ) -> some View {
        let g = item.goal
        let checked = group.focusGoalId == g.id
        // ALWAYS through the shared helper. An inline `totalProgress` here is the bug the
        // helper exists to prevent.
        let progress = GoalDisplay.progress(g)
        let target = GoalDisplay.target(g)

        return Button { pick(listId: group.listId, goalId: g.id) } label: {
            HStack(alignment: .top, spacing: 10) {
                Text(g.emoji ?? GoalStyle.emoji(g.category))
                    .font(.system(size: 19))
                    .frame(width: 26)

                VStack(alignment: .leading, spacing: 5) {
                    Text(g.title)
                        .font(.system(size: 14.5, weight: .semibold))
                        .foregroundStyle(WF.ink)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)

                    // "kind · pace": what the goal is, then how it's actually going, in the
                    // server's words and one of its three tones.
                    HStack(spacing: 4) {
                        Text(PlanningGoalsText.kindLabel(g))
                            .font(.system(size: 11.5, weight: .semibold))
                            .foregroundStyle(WF.ink3)
                        if let pace = item.pace {
                            Text("·").font(.system(size: 11.5)).foregroundStyle(WF.ink3)
                            Text(pace.text)
                                .font(.system(size: 11.5, weight: .semibold))
                                .foregroundStyle(PlanningPaceTone.color(pace.tone))
                                .lineLimit(1)
                        }
                    }

                    ProgressBar(
                        value: GoalDisplay.fraction(g),
                        tint: GoalStyle.color(g.category),
                        track: WF.panel,
                        height: 6)
                }

                VStack(alignment: .trailing, spacing: 0) {
                    HStack(alignment: .firstTextBaseline, spacing: 2) {
                        Text(GoalDisplay.number(progress))
                            .font(.system(size: 16, weight: .heavy)).foregroundStyle(WF.ink)
                        if let target {
                            Text("/ \(GoalDisplay.number(target))")
                                .font(.system(size: 11, weight: .semibold)).foregroundStyle(WF.ink3)
                        }
                    }
                    Text(PlanningGoalsText.axisLabel(g))
                        .font(.system(size: 10, weight: .semibold)).foregroundStyle(WF.ink3)
                        .lineLimit(1)
                }
                .frame(minWidth: 54, alignment: .trailing)

                Text(checked ? "★" : "")
                    .font(.system(size: 14, weight: .bold)).foregroundStyle(WF.gold)
                    .frame(width: 14)
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

    /// Not a "clear" button — an OPTION, so choosing it is as much of an answer as choosing
    /// a goal, and the tab gets its ★ either way.
    private func nothingOption(_ g: WaffledAPI.PlanningGoalGroup, frozen: Bool) -> some View {
        let checked = g.settled && g.focusGoalId == nil
        return Button { pick(listId: g.listId, goalId: nil) } label: {
            HStack(spacing: 10) {
                Text("🤍").font(.system(size: 19)).frame(width: 26)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Nothing this week")
                        .font(.system(size: 14.5, weight: .semibold)).foregroundStyle(WF.ink)
                    Text(g.goals.isEmpty
                         ? "This group has no goals yet."
                         : "No goal needs the spotlight — leave the week clear.")
                        .font(.system(size: 11.5)).foregroundStyle(WF.ink3)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 6)
                Text(checked ? "★" : "")
                    .font(.system(size: 14, weight: .bold)).foregroundStyle(WF.gold)
                    .frame(width: 14)
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

    // MARK: - Writes

    /// The read, and the crumb it produces. Set here as well as on the `rev` change: a
    /// remount whose fetch fails must not leave the shell holding a crumb it will replace
    /// the step's data with.
    private func reload() async {
        await model.load(sessionId: props.sessionId)
        if let crumb = model.crumb { props.setDecisionData(crumb) }
    }

    private func pick(listId: String, goalId: String?) {
        guard !model.isFrozen(shellBusy: props.busy) else { return }
        Task {
            await model.pick(sessionId: props.sessionId, listId: listId, goalId: goalId)
            // The flag lives in the goals module, so tell the shell to re-read: the agenda
            // sheet and the counter should agree with what just happened. (The crumb rides
            // the `rev` bump above rather than being set here twice.)
            props.refresh()
        }
    }
}
