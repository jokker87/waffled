import SwiftUI

/// Weekly Planning · step 7 "Meals" — "What's planned, and what's still open?"
///
/// Ported from `apps/web/src/kiosk/planning/steps/MealsStep.tsx`.
///
/// SEVEN NIGHTS, EACH WITH ITS EVENTS ABOVE ITS DISH — because on this screen the events
/// are the reason a night is easy or hard, and nothing else about the day matters here.
/// The web draws them as seven columns "so it reads as the same week as Calendar"; a phone
/// has no room for that, so they are seven stacked cards in the same order, which is the
/// same reading. (The iPad shares this body — see `apps/ios/CLAUDE.md`'s note that Today
/// is two view trees; Planning is one, and the shell is what differs.)
///
/// THE STEP OWNS NO DATA. The plan already in the app is shown as-is; overwriting a set
/// night is a tap on that night, and that tap goes through the same `/api/meals/plan` the
/// Meals screen uses. The only thing the session records is a crumb — which nights the app
/// picked — and the recap reads the plan itself, so a copy of the dishes would only ever
/// disagree with it.
///
/// THE FILL LIVES IN THE FOOTER (`MealsStepFooterExtra`), which is why this step's state
/// sits in `PlanningMealsStepStore` rather than in `@State`: the footer's fill is what puts
/// the ✨ on these nights and what the "…nights were left alone" note below reports.
struct MealsStepView: View {
    let props: PlanningStepProps

    @Environment(SyncManager.self) private var sync

    /// Which night's picker is open.
    @State private var editing: String?
    @State private var shopping = false

    /// The library the planner's manual-pick sheet browses. Owned here (the planner takes
    /// one rather than making its own) and loaded only when the planner actually opens —
    /// the seven nights don't need it.
    @State private var plannerRecipes = RecipesModel()

    /// Resolved from the shared store on every body pass rather than held in `@State`:
    /// `@State` would capture the first model forever, and stepping to another week must
    /// land on that week's model. The model is `@Observable`, so reading its properties
    /// here still registers the dependency.
    private var model: PlanningMealsModel {
        PlanningMealsStepStore.shared.model(sessionId: props.sessionId, weekStart: props.weekStart)
    }

    private var storeKey: String {
        PlanningMealsStepStore.key(sessionId: props.sessionId, weekStart: props.weekStart)
    }

    /// Any write in flight — the shell's or this step's.
    private var frozen: Bool { props.busy || model.busy }

    var body: some View {
        // NO OUTER ScrollView: the shell owns the chrome and the scrolling around a step,
        // and a second one nested inside would fight it.
        VStack(alignment: .leading, spacing: 12) {
            if let message = model.errorMessage {
                DismissibleErrorBanner(message: message) { model.dismissError() }
            }

            if !model.loaded {
                WaffledLoading()
            } else if model.view == nil {
                WaffledEmptyState(
                    emoji: "🍽️",
                    title: "Couldn’t read this week’s meals",
                    message: "Reload, or skip this step — skipping is a real answer.")
            } else {
                ForEach(model.rows) { night($0) }
                groceryLine
                if let sentence = PlanningMealsText.keptSentence(model.kept) {
                    Text(sentence)
                        .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(WF.ink2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        // Keyed on session + week: a different week is a different model in the store, and
        // this step must re-read rather than sit on the previous one's nights. Coming back
        // to the same key re-reads too (`enter`), so the columns show what the week IS.
        .task(id: storeKey) {
            await model.enter(weekStart: props.weekStart, seed: PlanningMealsCrumb.dates(props.step.data))
        }
        // ONE push, after every applied read and every landed write. The shell REPLACES
        // the step's stored data when the affirmative is pressed, so a body that only set
        // the crumb in a tap handler would erase its own record after a remount.
        //
        // `nil` is passed straight through here — unlike Goals, where nil is a wipe. For
        // this step nil is the real answer "the app picked nothing", exactly as the web
        // sends `dates.length ? {…} : null`.
        .onChange(of: model.rev) { props.setDecisionData(model.crumb) }
        // The week changed under us — close a modal that names a night in the old one.
        .onChange(of: storeKey) {
            editing = nil
            shopping = false
        }
        // THIS STEP LENDS THE BANNER NOTHING. Its own affordances are recipe-shaped — a
        // parked note reading "ask Grandma for the lasagne recipe" is not a dinner — and a
        // button that merely ticked the note off would promise an action it does not
        // perform. Withdrawn explicitly, because the verb is the SHELL's state and would
        // otherwise still be the previous step's.
        .onAppear {
            props.lendVerb(nil)
            // AND RE-HAND THE CRUMB. The store outlives this view, so coming back to the
            // step (the shell clears the crumb on every step change) would otherwise land
            // with ✨ nights on screen and nothing recorded — until the next read happened
            // to bump `rev`, and never at all if that read failed.
            props.setDecisionData(model.crumb)
        }
        .fullScreenCover(item: editingBinding) { target in
            MealsStepNightPicker(
                night: target,
                onPickRecipe: { recipeId in
                    write { await model.planNight(weekStart: props.weekStart, date: target.date, recipeId: recipeId, title: nil) }
                },
                onPickPlate: { mealId in
                    write { await model.planNightAsPlate(weekStart: props.weekStart, date: target.date, mealId: mealId) }
                },
                onPickTitle: { title in
                    write { await model.planNight(weekStart: props.weekStart, date: target.date, recipeId: nil, title: title) }
                },
                onClear: {
                    write { await model.clearNight(weekStart: props.weekStart, date: target.date) }
                })
        }
        .sheet(isPresented: $shopping) {
            MealsStepShopperSheet(
                weekStart: props.weekStart,
                nights: model.rows,
                trip: model.view?.shopping,
                people: sync.members,
                myPersonId: sync.currentPersonId,
                canManage: sync.can("chore.manage"),
                busy: frozen,
                onSave: { dueOn, personId, dueTime in
                    write {
                        await model.setShopper(
                            weekStart: props.weekStart, dueOn: dueOn,
                            personId: personId, dueTime: dueTime)
                    }
                })
        }
        // THE PLANNER IS PRESENTED HERE, from the BODY, even though the button that opens
        // it is in the footer. That is the whole reason `plannerOpen` sits on the shared
        // model: the shell builds the body and the footer as two sibling trees, and the
        // footer's own body renders NOTHING until the week is read and swaps to "Undo the
        // three" the moment a fill lands — a `.sheet` attached there would be hung off a
        // control that legitimately disappears. `MealsStep.tsx` renders its planner from
        // `Body` for the same reason.
        .sheet(isPresented: plannerBinding) { plannerSheet }
    }

    /// The app's OWN "Plan my week" planner, narrowed to this step's promise in the two
    /// ways the web narrows it: the only day chips are the EMPTY nights, and applying
    /// hands the approved cards to the step's fill endpoint — which is what keeps them
    /// marked, undoable, and unable to overwrite a night somebody already decided.
    ///
    /// A second, step-shaped planner would be a worse copy of a screen that already has
    /// the guardrails, the preferences box, reshuffle, swap, lock and a manual pick.
    private var plannerSheet: some View {
        PlanWeekSheet(
            start: props.weekStart,
            weekLabel: PlanningFormat.weekLabel(props.weekStart),
            // Noon in the HOUSEHOLD's zone — see `PlanningMealsPlan.plannerDays` for why
            // the hour and the zone are both load-bearing.
            weekDays: PlanningMealsPlan.plannerDays(model.emptyDates, tz: sync.householdTz),
            familySize: max(1, sync.members.count),
            recipes: plannerRecipes,
            mealTypes: [PlanningMealsModel.mealType],
            initialDays: model.emptyDates,
            note: PlanningMealsText.plannerNote(model.emptyDates.count),
            onApply: { cards in
                let landed = await model.applyPlan(weekStart: props.weekStart, approved: cards)
                if landed { props.refresh() }
                return landed
            },
            onApplied: {})
            // Loaded when the planner opens, not with the seven nights: the library is
            // only needed by the planner's manual-pick sheet.
            .task { await plannerRecipes.load() }
    }

    /// Two-way, so the planner's own Cancel (and a swipe-down) close it: `dismiss()`
    /// inside a sheet writes `false` back through this binding.
    private var plannerBinding: Binding<Bool> {
        Binding(get: { model.plannerOpen }, set: { model.setPlanner($0) })
    }

    /// Every write goes through here, so `props.refresh()` is called on LANDED writes only
    /// — a refetch of the shell's session view after a failure would be asking it to
    /// re-read something that cannot have changed.
    private func write(_ work: @escaping () async -> Bool) {
        Task { if await work() { props.refresh() } }
    }

    /// The picker is presented on the ROW, not on a bare date, so switching nights starts
    /// on a fresh search rather than carrying the last night's half-typed query across.
    private var editingBinding: Binding<PlanningMealsNightRow?> {
        Binding(
            get: { model.rows.first { $0.date == editing } },
            set: { editing = $0?.date })
    }

    // MARK: - One night

    private func night(_ row: PlanningMealsNightRow) -> some View {
        WaffledCard(padding: 13) {
            VStack(alignment: .leading, spacing: 9) {
                HStack(spacing: 7) {
                    Text(row.dow).font(.system(size: 15, weight: .heavy)).foregroundStyle(WF.ink)
                    Text(row.monthDay).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(WF.ink3)
                    Spacer(minLength: 4)
                }

                // The events come FIRST — they are the context that decides the night.
                if row.events.isEmpty {
                    Text("Nothing on").font(.system(size: 12.5)).foregroundStyle(WF.ink3)
                } else {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(row.events) { event in
                            HStack(spacing: 7) {
                                Circle()
                                    .fill(Color(hexString: event.colorHex) ?? WF.ink3)
                                    .frame(width: 7, height: 7)
                                Text(event.title)
                                    .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(WF.ink2)
                                    .lineLimit(1)
                                Spacer(minLength: 6)
                                Text(event.clock)
                                    .font(.system(size: 11.5, weight: .semibold)).foregroundStyle(WF.ink3)
                            }
                        }
                    }
                }

                dish(row)
            }
        }
    }

    /// The dish tile has four states and each has to be legible at a glance: planned,
    /// empty, auto-filled, and eating out.
    private func dish(_ row: PlanningMealsNightRow) -> some View {
        Button { editing = row.date } label: {
            HStack(spacing: 11) {
                if let dinner = row.dinner {
                    // NEVER `AsyncImage` in a list — `CachedImage` serves a decoded hit
                    // synchronously, which is what keeps seven of these from re-decoding
                    // on every scroll tick.
                    CachedImage(dinner.imageUrl, contentMode: .fill) {
                        WaffledEmojiTile(emoji: dinner.emoji ?? row.fallbackEmoji, size: 22, frame: 44)
                    }
                    .frame(width: 44, height: 44)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

                    VStack(alignment: .leading, spacing: 2) {
                        Text(dinner.title ?? "Planned")
                            .font(.system(size: 14.5, weight: .bold)).foregroundStyle(WF.ink)
                            .lineLimit(2).multilineTextAlignment(.leading)
                        if let attribution = row.attribution {
                            Text(attribution)
                                .font(.system(size: 12)).foregroundStyle(WF.ink3).lineLimit(1)
                        }
                    }
                    Spacer(minLength: 6)
                    if row.auto {
                        WaffledStatusBadge(text: "✨ auto", color: WF.ai)
                    }
                } else {
                    WaffledEmojiTile(emoji: "＋", size: 20, frame: 44)
                    Text("Nothing planned")
                        .font(.system(size: 14.5, weight: .semibold)).foregroundStyle(WF.ink2)
                    Spacer(minLength: 6)
                }
            }
            .padding(10)
            .planningOptionChrome(selected: row.auto, tint: WF.ai)
        }
        .buttonStyle(.plain)
        .disabled(frozen)
        .accessibilityLabel(
            row.dinner.map { "\($0.title ?? "Planned") on \(row.dow) — change it" }
                ?? "Plan \(row.dow)")
    }

    // MARK: - Groceries

    /// ONE LINE, not a panel: the board already builds itself from this plan, and a panel
    /// here would re-litigate a screen that already exists.
    @ViewBuilder private var groceryLine: some View {
        if let groceries = model.view?.groceries {
            WaffledCard(padding: 13) {
                VStack(alignment: .leading, spacing: 9) {
                    HStack(spacing: 10) {
                        Text("🛒").font(.system(size: 17))
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Groceries")
                                .font(.system(size: 14.5, weight: .bold)).foregroundStyle(WF.ink)
                            Text(PlanningMealsText.grocerySub(added: model.groceryAdded))
                                .font(.system(size: 12)).foregroundStyle(WF.ink3)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 6)
                    }
                    Pill(text: PlanningMealsText.groceryPill(groceries))

                    // The shopper pill is only here because the trip is REAL — a one-off
                    // chore that shows on the Tasks board. With the chores module off
                    // there is nowhere for it to live, so the control GOES AWAY rather
                    // than sitting there dead.
                    if model.view?.choresOn == true {
                        Button { shopping = true } label: {
                            Text(PlanningMealsText.tripLabel(model.view?.shopping))
                                .font(.system(size: 13, weight: .bold))
                                .foregroundStyle(model.view?.shopping == nil ? WF.primary : WF.ink)
                                .padding(.horizontal, 13).padding(.vertical, 8)
                                .wfChip(selected: model.view?.shopping != nil)
                        }
                        .buttonStyle(.plain)
                        .disabled(frozen)
                    }
                }
            }
        }
    }
}
