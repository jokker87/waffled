import SwiftUI

/// Weekly Planning · step 3 "Horizon scan" — "Anything further out you should see now?"
///
/// The month view plus one bar that parks a note — never a calendar entry — tagged for a step still ahead of you.
///
/// Ported from `apps/web/src/kiosk/planning/steps/HorizonStep.tsx`. THE MONTH YOU ALREADY
/// SHIP, PLUS ONE BAR: the grid is the calendar's own (`PlanningMonthGrid`, copied cell for
/// cell from `CalendarView` — see that file's header for why it is a copy), the day panel
/// underneath reuses `EventCard` / `CountdownCard`, and adding an event is the app's own
/// `EventEditSheet`. Nothing here is a second calendar.
///
/// Three rules this file must not break:
///
///  1. THE ＋ AND THE BAR ARE DIFFERENT THINGS. "Add an event" writes a REAL EVENT through
///     `EventEditSheet` (which already owns the time, the duration, repeats, who it's for
///     and the offline-first write). The bar parks a NOTE, which is never written onto the
///     calendar — it is the thought the month provokes, and it carries an optional tag
///     naming the step that will look at it.
///  2. NOTHING NAVIGATES. Opening an event opens the same shared sheet in edit mode; a
///     day's fuller list is the panel under the grid. The shell owns where the session is.
///  3. THE SERVER OWNS THE WEEK. `props.weekStart` decides which month opens; nothing here
///     asks the device what week it is.
///
/// The body is content-sized: the SHELL owns the scroll view, so there is no `ScrollView`
/// and no `WF.tabBarClearance` here.
struct HorizonStepView: View {
    let props: PlanningStepProps

    @Environment(SyncManager.self) private var sync
    @State private var model = PlanningHorizonModel()
    /// The countdown badges — all four sources, keyed by day, exactly as Calendar builds
    /// them. They are the anticipation markers a horizon scan exists to notice.
    @State private var countdowns = CountdownsModel()
    /// Months ahead of the planned week's own month. A horizon is what is AHEAD, so there
    /// is nowhere useful to page back to and the floor is 0.
    @State private var ahead = 0
    @State private var selectedDay = ""
    @State private var note = ""
    @FocusState private var noteFocused: Bool
    @State private var composer: HorizonComposer?
    @State private var pending: PendingComposer?
    /// Set by `EventEditSheet.onSaved`, read on dismiss — see `composerDismissed`.
    @State private var saved = false

    private var tz: TimeZone { sync.householdTz }
    /// Which day starts the week, so the grid is cut the way THIS HOUSEHOLD cuts one — the
    /// three-argument overload, never the device-region one.
    private var firstDay: HouseholdWeekStart { sync.householdWeekStart ?? .sunday }
    private var disabled: Bool { props.busy || model.parking }
    private var trimmedNote: String { note.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// The month the planned week falls in — read off the week-start STRING, so no device
    /// timezone can move it.
    private var floorMonth: (year: Int, month: Int) {
        if let m = PlanningMonth.month(of: props.weekStart) { return m }
        let c = Cal.gregorian(tz).dateComponents([.year, .month], from: Date())
        return (c.year ?? 2026, c.month ?? 1)
    }

    private var anchor: (year: Int, month: Int) {
        PlanningMonth.advance(year: floorMonth.year, month: floorMonth.month, by: ahead)
    }

    var body: some View {
        // The 42 cells, resolved ONCE per render above the grid rather than per cell (and
        // via `SyncManager.eventsByDay`, which is already indexed by day).
        let cells = PlanningMonth.cells(
            year: anchor.year, month: anchor.month, tz: tz, firstDay: firstDay,
            eventsByDay: sync.eventsByDay, countdownsByDate: countdowns.byDate,
            palette: sync.eventPalette)

        VStack(alignment: .leading, spacing: 14) {
            header

            PlanningMonthGrid(
                cells: cells, firstDay: firstDay, selectedDay: selectedDay,
                todayKey: Agenda.todayKey(tz), onSelect: { selectedDay = $0 })

            dayPanel

            parkBar

            // BELOW the pill, not inside it. Five-to-seven chips plus a button turned the
            // capture line into a cramped scroll; out here they get a row of their own —
            // and, more to the point, room for the sentence under them.
            if !trimmedNote.isEmpty {
                tagRow
                saysLine
            }

            if let message = model.errorMessage {
                DismissibleErrorBanner(message: message) { model.clearError() }
            }

            explainer

            board
        }
        .task(id: props.sessionId) { await model.load(sessionId: props.sessionId) }
        .task { await countdowns.load() }
        .onAppear {
            if selectedDay.isEmpty { selectedDay = props.weekStart }
            // A step WITH a composer lends the shell's parked-note banner its own verb.
            props.lendVerb(PlanningHandoffVerb(label: "Make an event") { text, done in
                openComposer(
                    event: nil, day: dayDate(selectedDay), prefillTitle: text, done: done)
            })
        }
        .onDisappear { props.lendVerb(nil) }
        // The panel focuses the first day of the week being planned while we are on its
        // month (that is where the family's attention already is), and the 1st of any month
        // scanned beyond it.
        .onChange(of: ahead) { _, _ in selectedDay = focusDay }
        .onChange(of: props.weekStart) { _, _ in
            ahead = 0
            selectedDay = props.weekStart
        }
        .onChange(of: model.revision) { _, _ in props.setDecisionData(model.decisionData) }
        .sheet(item: $composer, onDismiss: composerDismissed) { c in
            // The app's own event sheet — NOT a second event form. `prefillTitle` carries
            // the note somebody already wrote: retyping their own words back at them is
            // what makes an affordance feel pointless.
            EventEditSheet(event: c.event, initialDate: c.day, prefillTitle: c.prefillTitle,
                           onSaved: { saved = true })
        }
    }

    // MARK: - Month header

    private var header: some View {
        HStack(spacing: 12) {
            Button {
                ahead = max(0, ahead - 1)
            } label: {
                Image(systemName: "chevron.left").font(.system(size: 14, weight: .heavy))
            }
            .buttonStyle(.plain)
            .foregroundStyle(ahead == 0 ? WF.ink3.opacity(0.4) : WF.ink2)
            .disabled(ahead == 0 || props.busy)
            .accessibilityLabel("Previous month")

            Text(PlanningMonth.label(year: anchor.year, month: anchor.month))
                .font(WF.serif(20)).foregroundStyle(WF.ink)

            Button {
                ahead += 1
            } label: {
                Image(systemName: "chevron.right").font(.system(size: 14, weight: .heavy))
            }
            .buttonStyle(.plain)
            .foregroundStyle(WF.ink2)
            .disabled(props.busy)
            .accessibilityLabel("Next month")

            Spacer(minLength: 0)
        }
    }

    // MARK: - The selected day

    @ViewBuilder private var dayPanel: some View {
        let items = sync.eventsByDay[selectedDay] ?? []
        let dayCountdowns = countdowns.byDate[selectedDay] ?? []

        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(relativeLabel(selectedDay)).font(WF.serif(18)).foregroundStyle(WF.ink)
                Text(dateLabel(selectedDay))
                    .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(WF.ink3)
                Spacer(minLength: 0)
            }
            ForEach(items) { event in
                EventCard(event: event, tz: tz) {
                    openComposer(event: event, day: event.startsAt ?? dayDate(selectedDay))
                }
            }
            ForEach(dayCountdowns) { c in
                CountdownCard(countdown: c, sleeps: countdowns.sleeps) {
                    // An event-backed countdown opens its event, in place. A standalone or
                    // birthday one is managed where it lives (the Calendar tab, a person's
                    // profile) — the session does not navigate away from itself.
                    if c.source == "event", let ev = sync.events.first(where: { $0.id == c.id }) {
                        openComposer(event: ev, day: ev.startsAt ?? dayDate(selectedDay))
                    }
                }
            }
            Button {
                openComposer(event: nil, day: dayDate(selectedDay))
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "plus").font(.system(size: 12, weight: .heavy))
                    Text("Add an event on this day").font(.system(size: 14, weight: .semibold))
                }
                .foregroundStyle(WF.ai).padding(.vertical, 8)
            }
            .buttonStyle(.plain)
            .disabled(props.busy)
        }
    }

    // MARK: - The one thing the session adds

    private var parkBar: some View {
        HStack(spacing: 8) {
            Text("📌").font(.system(size: 15))
            // NOT disabled while the write is in flight: focus on a disabled field is a
            // silent no-op, and this bar puts the cursor back after every note.
            TextField("Park a note — “we’re going camping, we need to pack”", text: $note)
                .font(.system(size: 15))
                .focused($noteFocused)
                .submitLabel(.done)
                .onSubmit { park() }
                // The server's own cap (`parkItem`'s MAX_NOTE), so an ordinary long note is
                // stopped here rather than by a 400.
                .onChange(of: note) { _, next in
                    if next.count > 500 { note = String(next.prefix(500)) }
                }
            if trimmedNote.isEmpty {
                Text("a note, not a calendar entry")
                    .font(.system(size: 11.5, weight: .semibold)).foregroundStyle(WF.ink3)
            } else {
                Button("Park it") { park() }
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(disabled ? WF.ink3 : WF.primary)
                    .buttonStyle(.plain)
                    .disabled(disabled)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .wfField()
        .wfKeyboardDoneToolbar { noteFocused = false }
    }

    /// The tags, plus "No tag" — which is the ABSENCE of a tag and so is never a row the
    /// server sends. Only steps still ahead of this one are offered; the server already
    /// filtered, and we render what it sends.
    private var tagRow: some View {
        ChipFlow(spacing: 6, lineSpacing: 6) {
            ForEach(model.tags, id: \.stepKey) { tag in
                tagChip(
                    label: tag.label,
                    selected: model.chosenStepKey == tag.stepKey,
                    hint: tag.hint) { model.tagChoice = .step(tag.stepKey) }
            }
            tagChip(label: "No tag", selected: model.chosenStepKey == nil, hint: nil) {
                model.tagChoice = .noTag
            }
        }
        .accessibilityLabel("Which step should look at this?")
    }

    /// `.buttonStyle(.plain)` and an explicit foreground on purpose: the default button
    /// style dims and re-tints its label while pressed, and a chosen chip that loses its
    /// colours under a finger was reported as the chip "unselecting itself".
    private func tagChip(
        label: String, selected: Bool, hint: String?, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 12.5, weight: .bold))
                .foregroundStyle(selected ? WF.aiD : WF.ink2)
                .padding(.horizontal, 11).padding(.vertical, 7)
                .wfChip(selected: selected, tint: WF.ai)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .accessibilityHint(hint ?? "")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    /// "What does no tag do? where does it put it?" — a question a tooltip was never going
    /// to answer. Both outcomes are stated, and both are true: a tag is a DESTINATION, so
    /// the note is raised by that step's handoff banner when the session gets there; with
    /// no tag no step raises it at all, and it simply stays on the board.
    @ViewBuilder private var saysLine: some View {
        if let label = model.chosenLabel {
            (Text("Comes back at ") + Text(label).bold() + Text(", later in this session."))
                .font(.system(size: 12.5)).foregroundStyle(WF.ink2)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            (Text("No step will raise it.").bold()
                + Text(" It stays on the board — in tonight’s recap, and waiting at Loose ends next session."))
                .font(.system(size: 12.5)).foregroundStyle(WF.ink2)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var explainer: some View {
        (Text("Know the day it lands?").bold()
            + Text(" Tap that day on the month above and add it — you get a real calendar event. ")
            + Text("Only know it’s coming?").bold()
            + Text(" Park it in the bar: it stays off the calendar, and comes back at whichever step you tag it for — all of them still ahead of you tonight."))
            .font(.system(size: 12)).foregroundStyle(WF.ink3)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// Named, because the read deliberately returns every note parked during this session
    /// whichever bar wrote it — a note written at step 1 turning up here unlabelled would
    /// look like something the month put there.
    @ViewBuilder private var board: some View {
        if !model.parked.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel(text: "Parked in this session")
                ForEach(model.parked) { n in
                    HStack(alignment: .top, spacing: 8) {
                        Text(n.note).font(.system(size: 13.5)).foregroundStyle(WF.ink)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 6)
                        if let label = n.stepLabel {
                            WaffledStatusBadge(text: label, color: WF.ai)
                        } else {
                            WaffledStatusBadge(text: "No tag", color: WF.ink3)
                        }
                    }
                    .padding(11)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .wfField(fill: WF.panel)
                }
            }
        }
    }

    // MARK: - Actions

    private func park() {
        guard !trimmedNote.isEmpty, !disabled else { return }
        let text = trimmedNote
        Task {
            if await model.park(text, sessionId: props.sessionId) {
                note = ""
                // Parking is a BURST — somebody reads the month and empties their head into
                // the bar — so the cursor goes back rather than making you re-aim at it.
                noteFocused = true
                props.refresh()
            }
        }
    }

    /// Open the shared event sheet.
    private func openComposer(
        event: SyncedEvent?, day: Date, prefillTitle: String? = nil, done: ((Bool) -> Void)? = nil
    ) {
        saved = false
        pending = PendingComposer(isCreate: event == nil, done: done)
        composer = HorizonComposer(event: event, day: day, prefillTitle: prefillTitle)
    }

    /// Did the composer actually create something?
    ///
    /// `EventEditSheet` reports its own save through `onSaved`, which fires after the write
    /// and before the dismiss — so this is now a flag rather than a guess.
    ///
    /// It used to watch the local mirror for an id that was not there when the sheet
    /// opened, polling for ~1.5s, because the sheet had no completion. That was the honest
    /// answer available at the time and it was still wrong in one direction: a sync landing
    /// in the poll window reads as a save that never happened. The rule it exists to serve
    /// is why that mattered — A CANCELLED COMPOSER MUST REPORT FALSE, or a parked note gets
    /// settled on the strength of somebody having opened a box and closed it again.
    private func composerDismissed() {
        guard let p = pending else { return }
        pending = nil
        let created = saved && p.isCreate
        saved = false
        if created {
            model.recordEventAdded()
            // The shell's counter and its agenda sheet should agree with what just happened.
            props.refresh()
        }
        p.done?(created)
    }

    // MARK: - Small formatting

    /// The day the panel should focus: the planned week's first day while we are on its
    /// month, else the 1st of the month being scanned.
    private var focusDay: String {
        ahead == 0 ? props.weekStart : String(format: "%04d-%02d-01", anchor.year, anchor.month)
    }

    private func dayDate(_ key: String) -> Date {
        DateFmt.date(key, "yyyy-MM-dd", tz) ?? Date()
    }

    private func relativeLabel(_ key: String) -> String {
        let today = Agenda.todayKey(tz)
        if key == today { return "Today" }
        let cal = Cal.gregorian(tz)
        let tomorrow = EventTime.dayKey(cal.date(byAdding: .day, value: 1, to: Date()) ?? Date(), tz)
        if key == tomorrow { return "Tomorrow" }
        guard let d = DateFmt.date(key, "yyyy-MM-dd", tz) else { return key }
        return DateFmt.string(d, "EEEE", tz)
    }

    private func dateLabel(_ key: String) -> String {
        guard let d = DateFmt.date(key, "yyyy-MM-dd", tz) else { return "" }
        return DateFmt.string(d, "EEE · MMM d", tz)
    }
}

/// What the shared event sheet is opening on.
private struct HorizonComposer: Identifiable {
    let id = UUID().uuidString
    /// nil creates on `day`; an event edits it in place.
    let event: SyncedEvent?
    let day: Date
    let prefillTitle: String?
}

/// What we need remembered ACROSS the sheet's lifetime, so it survives the item being
/// cleared on dismissal.
private struct PendingComposer {
    /// Editing reports `false`: this step's banner verb only ever offers to MAKE an event,
    /// so an edit is not the thing a parked note was waiting for.
    let isCreate: Bool
    let done: ((Bool) -> Void)?
}
