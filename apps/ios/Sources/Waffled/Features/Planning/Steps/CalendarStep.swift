import SwiftUI

/// Weekly Planning · step 2 "Calendar" — "Here's your week. Anything missing?"
///
/// The real week, with add-in-place on a tapped day. Reads the ordinary calendar; there is
/// no planning-only event store.
///
/// Ported from `apps/web/src/kiosk/planning/steps/CalendarStep.tsx`. THE WEEK IS THE WHOLE
/// SCREEN, and it is the REAL calendar: seven DAY ROWS in one card (the web's own header
/// says "SEVEN DAY ROWS in one card, not seven columns" — and a column per day is
/// unreadable on a phone), each a weekday over a large serif date, that day's events as
/// inline chips, and a `＋` at the end of the row. A day with nothing says "Nothing on the
/// calendar" and takes a tint, so an open evening reads as an opportunity rather than as a
/// hole. Nothing here is invented: the rows are `SyncManager.eventsByDay` — the PowerSync
/// mirror, which is what `GET /api/events` is on the web — painted by the same
/// `eventPalette` every other calendar surface uses.
///
/// Four rules this file must not break:
///
///  1. THE SERVER OWNS THE WEEK. `props.weekStart` is the week; the seven days are that
///     date plus 0…6, as string arithmetic. Nothing here asks the device what week it is.
///  2. BUSY WEEKS STAY ONE SCREEN. A day over four events shows the first four and a
///     "+N more" pill that opens that day IN PLACE. Never a scrolling row, and never a
///     navigation away — the shell owns where the session is.
///  3. ADDING IS THE APP'S OWN EVENT SHEET. `EventEditSheet`, opened on the day whose `＋`
///     was tapped. It already asks the date, the time AND its duration, repeats, the
///     location and who it's for, and it already writes through the local-first path. A
///     second event form living in this step is exactly the drift the reuse rule exists to
///     prevent — and the web's inline composer, which it replaced, is what put every
///     addition at 5pm for exactly one hour.
///  4. NO INVENTED PRESENCE. There is no face row: the session is single-driver and we do
///     not track who is in the room.
///
/// The body is content-sized: the SHELL owns the scroll view, so there is no `ScrollView`
/// and no `WF.tabBarClearance` here.
struct CalendarStepView: View {
    let props: PlanningStepProps

    @Environment(SyncManager.self) private var sync
    @State private var model = PlanningCalendarModel()
    /// Days whose "+N more" has been opened. Per day, and never reset by a sync tick: a
    /// row that collapsed again under someone mid-read would be worse than a tall one.
    @State private var opened: Set<String> = []
    @State private var composer: PlanningCalendarComposer?
    @State private var pending: PendingCalendarComposer?
    /// Did `EventEditSheet` report a successful write? It fires `onSaved` BEFORE it
    /// dismisses, so this is the honest answer — never a diff of the events mirror, which
    /// a concurrent sync landing in the same window reads as a save that never happened.
    @State private var composerSaved = false

    private var tz: TimeZone { sync.householdTz }

    var body: some View {
        let days = PlanningWeekDays.days(weekStart: props.weekStart, todayKey: Agenda.todayKey(tz))
        let total = days.reduce(0) { $0 + (sync.eventsByDay[$1.key]?.count ?? 0) }
        let openDays = days.filter { (sync.eventsByDay[$0.key] ?? []).isEmpty }.map(\.full)

        VStack(alignment: .leading, spacing: 14) {
            header(total: total, openDays: openDays)
            week(days)
            routes
            notes
        }
        .onAppear {
            // The step's own persisted decisions, read BEFORE anything is pushed back:
            // the crumb replaces the row's data when the step is answered.
            model.seedRoutes(props.routes)
            // A step WITH a composer lends the shell's parked-note banner its own verb.
            props.lendVerb(PlanningHandoffVerb(label: "Make an event") { text, done in
                openComposer(dayKey: headerDay, prefillTitle: text, done: done)
            })
        }
        .onDisappear { props.lendVerb(nil) }
        .onChange(of: model.revision) { _, _ in props.setDecisionData(model.decisionData) }
        .sheet(item: $composer, onDismiss: composerDismissed) { c in
            eventSheet(c)
        }
    }

    // MARK: - Header

    private func header(total: Int, openDays: [String]) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(PlanningWeekDays.weekRangeLabel(props.weekStart))
                    .font(WF.serif(20)).foregroundStyle(WF.ink)
                Text(PlanningWeekDays.summary(total: total, openDays: openDays))
                    .font(.system(size: 12.5)).foregroundStyle(WF.ink3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            Button {
                openComposer(dayKey: headerDay)
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "plus").font(.system(size: 11, weight: .heavy))
                    Text("Add an event").font(.system(size: 13, weight: .bold))
                }
                .foregroundStyle(props.busy ? WF.ink3 : WF.primary)
            }
            .buttonStyle(.plain)
            .disabled(props.busy)
        }
    }

    /// Which day the header's button opens on: today when today is INSIDE the week being
    /// planned, and the week's first day otherwise — a session run on a Sunday is usually
    /// planning the week ahead, and "today" would be outside it.
    ///
    /// Computed rather than read off the rendered days, so the verb lent to the shell's
    /// banner on `onAppear` can't hold a week the session has since stepped away from.
    /// `YYYY-MM-DD` sorts lexicographically, which is the whole reason the week stays a
    /// string here.
    private var headerDay: String {
        let today = Agenda.todayKey(tz)
        let last = PlanningWeekDays.addDays(props.weekStart, 6)
        return (today >= props.weekStart && today <= last) ? today : props.weekStart
    }

    // MARK: - The week

    private func week(_ days: [PlanningWeekDay]) -> some View {
        WaffledCard(padding: 0) {
            VStack(spacing: 0) {
                ForEach(Array(days.enumerated()), id: \.element.id) { index, day in
                    dayRow(day)
                    if index < days.count - 1 {
                        Rectangle().fill(WF.hair).frame(height: 1)
                    }
                }
            }
        }
    }

    private func dayRow(_ day: PlanningWeekDay) -> some View {
        let list = sync.eventsByDay[day.key] ?? []
        let showAll = opened.contains(day.key) || list.count <= PlanningWeekDays.rowMax
        let shown = showAll ? list : Array(list.prefix(PlanningWeekDays.rowMax))
        let hidden = list.count - shown.count

        return HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 1) {
                Text(day.dow)
                    .font(.system(size: 10.5, weight: .heavy)).tracking(0.6)
                    .foregroundStyle(day.isToday ? WF.primary : WF.ink3)
                Text(day.date)
                    .font(WF.serif(17))
                    .foregroundStyle(day.isToday ? WF.primary : WF.ink)
            }
            .frame(width: 62, alignment: .leading)

            VStack(alignment: .leading, spacing: 5) {
                ForEach(shown) { event in
                    chip(event)
                }
                if hidden > 0 {
                    Button {
                        withAnimation { _ = opened.insert(day.key) }
                    } label: {
                        Text("+\(hidden) more")
                            .font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink2)
                            .padding(.horizontal, 9).padding(.vertical, 4)
                            .background(WF.panel).clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }
                if list.isEmpty {
                    Text("Nothing on the calendar")
                        .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(WF.ink3)
                        .padding(.vertical, 3)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Button {
                openComposer(dayKey: day.key)
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 12, weight: .heavy))
                    .foregroundStyle(props.busy ? WF.ink3.opacity(0.5) : WF.ink2)
                    .frame(width: 28, height: 28)
                    .background(WF.panel).clipShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(props.busy)
            .accessibilityLabel("Add an event on \(day.full), \(day.date)")
        }
        .padding(.horizontal, 13).padding(.vertical, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
        // An open day takes a tint so it reads as an opportunity, not as a hole.
        .background(list.isEmpty ? WF.panel.opacity(0.45) : Color.clear)
    }

    /// One event as the week draws it: a coloured time, the title, and the owner's bubble.
    ///
    /// Hand-rolled rather than `EventCard` — that is a full-width 48pt row with a shadow,
    /// and seven of those stacked four deep is a different screen. The PAINT is not
    /// hand-rolled: `eventPalette.chip(for:)` is the same fill/ink pair the month cells and
    /// the week grid use, so the household's solid-vs-tinted style and the unassigned grey
    /// both fall out of it rather than being a branch here.
    private func chip(_ event: SyncedEvent) -> some View {
        let paint = sync.eventPalette.chip(for: event)
        return HStack(spacing: 6) {
            Text(whenText(event))
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(paint.foreground.opacity(0.8))
            Text(event.title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(paint.foreground)
                .lineLimit(1)
            Spacer(minLength: 0)
            if let emoji = event.emoji {
                Avatar(colorHex: event.colorHex, emoji: emoji, size: 20)
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(paint.background)
        .clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))
    }

    /// "1:00 PM" — or a real "All day" label rather than a whispered aside.
    private func whenText(_ event: SyncedEvent) -> String {
        if event.allDay { return "All day" }
        guard let start = event.startsAt else { return "" }
        return EventTime.timeLabel(start, tz)
    }

    // MARK: - What step 1 sent here

    /// Loose ends routed to this step, offered as events rather than as a to-do list —
    /// this step's only verb is "put it on the week".
    ///
    /// Handed down via `PlanningStepProps.routes` — the array lives on step 1's own row,
    /// so only the shell can pass it across. See `PlanningCalendarModel.routes`.
    /// (The web does not surface these on the destination step; this is iOS ahead, and a
    /// away from working, and nothing about the affordance changes when it lands.
    @ViewBuilder private var routes: some View {
        if !model.openRoutes.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel(text: "Sent here from loose ends")
                ForEach(model.openRoutes, id: \.id) { route in
                    HStack(spacing: 10) {
                        Text(route.title)
                            .font(.system(size: 13.5, weight: .semibold)).foregroundStyle(WF.ink)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 6)
                        Button("Make an event") {
                            openComposer(
                                dayKey: props.weekStart, prefillTitle: route.title, route: route)
                        }
                        .font(.system(size: 12.5, weight: .bold))
                        .foregroundStyle(props.busy ? WF.ink3 : WF.primary)
                        .buttonStyle(.plain)
                        .disabled(props.busy)
                    }
                    .padding(11)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .wfField(fill: WF.panel)
                }
            }
        }
    }

    private var notes: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("This is everything your calendars already have. Add what isn’t here yet.")
                .font(.system(size: 12)).foregroundStyle(WF.ink3)
                .fixedSize(horizontal: false, vertical: true)
            Text("Busy weeks stay one screen — a day over four events shows “+N more”, which opens that day.")
                .font(.system(size: 12)).foregroundStyle(WF.ink3)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - The composer

    /// The app's own event sheet — NOT a second event form. It carries the day it was
    /// opened on and, when a note or a routed loose end opened it, the words somebody
    /// already wrote: retyping their own words back at them is what makes an affordance
    /// feel pointless.
    ///
    /// `onSaved` is ASSIGNED rather than passed: it is a property on `EventEditSheet` with
    /// no matching parameter on that type's explicit initializer, and this file may not
    /// edit it. It fires after a successful write and before the dismiss, which is what
    /// makes "saved or cancelled?" answerable at all.
    private func eventSheet(_ c: PlanningCalendarComposer) -> EventEditSheet {
        var sheet = EventEditSheet(event: nil, initialDate: c.day, prefillTitle: c.prefillTitle)
        sheet.onSaved = { onSaved() }
        return sheet
    }

    private func openComposer(
        dayKey: String,
        prefillTitle: String? = nil,
        route: WaffledAPI.LooseEndRoute? = nil,
        done: ((Bool) -> Void)? = nil
    ) {
        composerSaved = false
        pending = PendingCalendarComposer(route: route, done: done)
        composer = PlanningCalendarComposer(
            day: DateFmt.date(dayKey, "yyyy-MM-dd", tz) ?? Date(), prefillTitle: prefillTitle)
    }

    /// The sheet really wrote something.
    private func onSaved() {
        composerSaved = true
        model.recordEventAdded()
        if let route = pending?.route {
            model.recordRouteMade(kind: route.kind, id: route.id)
        }
        // The shell's counter and its agenda sheet should agree with what just happened.
        props.refresh()
    }

    /// A CANCELLED COMPOSER MUST REPORT `false`. Settling a parked note on a cancel would
    /// throw away the only record that the thing still needs doing, on the strength of
    /// somebody having opened a box and closed it again.
    private func composerDismissed() {
        let p = pending
        pending = nil
        p?.done?(composerSaved)
        composerSaved = false
    }
}

/// What the shared event sheet is opening on.
private struct PlanningCalendarComposer: Identifiable {
    let id = UUID().uuidString
    let day: Date
    let prefillTitle: String?
}

/// What must survive the sheet's item being cleared on dismissal.
private struct PendingCalendarComposer {
    /// The routed loose end this composer was opened for, if any.
    let route: WaffledAPI.LooseEndRoute?
    /// The parked-note handoff's completion, if the banner opened it.
    let done: ((Bool) -> Void)?
}
