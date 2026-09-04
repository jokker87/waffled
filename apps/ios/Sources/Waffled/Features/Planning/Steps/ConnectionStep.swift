import SwiftUI

/// Weekly Planning · step 5 "Connection" — "Who gets time with whom?"
///
/// Pairings read out of event participants, time you already share counted rather than
/// replaced, and any pairing makeable from scratch.
///
/// Ported from `apps/web/src/kiosk/planning/steps/ConnectionStep.tsx`.
///
/// NOTHING NEW IS STORED FOR THIS STEP. A pairing is a query over event participants — an
/// event whose people are exactly those two — and claiming a slot writes an ORDINARY
/// CALENDAR EVENT with those participants. There is no pairing record to create, and this
/// file must never grow one: a row's state is whatever the calendar says next time you
/// look, which is why every action here RE-READS instead of bookkeeping locally. The one
/// thing that is remembered is a POINTER — which event answers which pairing.
///
/// Four rules this file must not break:
///
///  1. THE ROWS ARE A PROMPT, NOT THE LIST. The server ranks every pair in the house by
///     how long it has been; the step draws the top few. "Make a pairing" — any two
///     people, or three, any time — is a FIRST-CLASS action at full width under them.
///  2. TIME THAT ALREADY EXISTS GETS CREDIT. The honest answer is often "you're already
///     doing this together on Saturday", so a row leads with the time the week already
///     holds and offers a muted "already counts" instead of only offering to manufacture a
///     new commitment. A planning tool that can only add obligations is a worse tool.
///  3. ADDING IS THE APP'S OWN EVENT SHEET. `EventEditSheet`, opened with the pairing's
///     people prefilled and the slot's date AND INSTANT (`prefillStart`). It owns the
///     title, the duration, repeats, the location and the local-first write. What this
///     step keeps of a composer is only the half the sheet can't do: choosing who, which
///     is the input to the slot query, and picking one of the week's real gaps.
///  4. NO INVENTED TIMES. A slot is a gap the week left behind, computed server-side. A
///     day with nothing on it carries NO time at all — `startsAt == nil` means the whole
///     day is free, the label already says so, and the sheet's own picker decides the hour.
///
/// The faces are the household's REAL people (`SyncManager.members`): who a pairing is
/// between is the entire content of a row, so a stand-in family here would be worse than
/// no faces at all.
///
/// The body is content-sized: the SHELL owns the scroll view.
struct ConnectionStepView: View {
    let props: PlanningStepProps

    @Environment(SyncManager.self) private var sync
    @State private var model = PlanningConnectionModel()
    /// Which row's "Link a time" picker is open, if any.
    @State private var picking: String?
    @State private var compose: PlanningConnectionCompose?
    /// The people the open composer was opened FOR — read back in `onSaved`, so it has to
    /// outlive the sheet's item being cleared.
    @State private var composeParticipants: [String] = []

    private var tz: TimeZone { sync.householdTz }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if model.failed, model.board != nil {
                DismissibleErrorBanner(message: ConnectionCopy.readFailed) { model.clearFailed() }
            }
            content
        }
        .task(id: props.weekStart) {
            // SEED FIRST, THEN READ. The crumb carries `links`, and pushing one before the
            // seed lands would hand the shell an empty map to write back over a real one.
            model.seedLinks(from: props.step.data["links"])
            await model.load(weekStart: props.weekStart)
        }
        .onChange(of: model.revision) { _, _ in props.setDecisionData(model.decisionData) }
        // THIS STEP LENDS THE BANNER NOTHING. It has a composer, but a parked note has no
        // pairing to belong to — "Make an event" here would have to guess whose evening the
        // note was about — so the banner keeps saying "Handled". Withdrawn explicitly,
        // because the verb is the SHELL's state and would otherwise still be step 2's.
        .onAppear { props.lendVerb(nil) }
        .sheet(item: $compose, onDismiss: composeDismissed) { c in
            eventSheet(c)
        }
    }

    @ViewBuilder private var content: some View {
        if let board = model.board {
            if board.pairings.isEmpty {
                WaffledEmptyState(
                    emoji: "🫂", title: "Nobody to pair up yet",
                    message: ConnectionCopy.needsTwoPeople)
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(model.rows) { row in
                        rowCard(row)
                    }
                    PlanningMakePairing(
                        model: model, weekStart: props.weekStart, members: sync.members,
                        busy: props.busy, onCompose: { openComposer($0) })
                    Text(ConnectionCopy.note)
                        .font(.system(size: 12)).foregroundStyle(WF.ink3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        } else if model.failed {
            WaffledEmptyState(emoji: "📵", title: ConnectionCopy.readFailed)
        } else if !model.loaded {
            VStack(spacing: 8) {
                WaffledLoading(top: 24)
                Text("Looking at who’s been where…")
                    .font(.system(size: 12.5)).foregroundStyle(WF.ink3)
            }
            .frame(maxWidth: .infinity)
        }
    }

    // MARK: - One pairing

    private func rowCard(_ row: PlanningConnectionRow) -> some View {
        WaffledCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top, spacing: 10) {
                    HStack(spacing: -6) {
                        ForEach(row.personIds, id: \.self) { id in
                            face(id)
                        }
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(row.who)

                    VStack(alignment: .leading, spacing: 3) {
                        Text(row.who)
                            .font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
                        Text(row.sentence)
                            .font(.system(size: 12.5)).foregroundStyle(WF.ink2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                }

                ChipFlow(spacing: 6, lineSpacing: 6) {
                    // TIME THAT ALREADY EXISTS, first. It offers nothing new — it lets you
                    // say the week already answers this, which is a real answer to "who
                    // gets time with whom" and the only one that doesn't cost anybody an
                    // evening.
                    //
                    // AND IT NAMES THE EVENT. It used to read "Tue 8:00 PM counts", which
                    // is not something anybody can match against a week they just added
                    // to: "I dont see the event I just made (at least not by its title)".
                    // A day and an hour identify nothing on a row that can carry three
                    // credited evenings.
                    if let oneTap = row.oneTap {
                        chip(
                            "\(row.oneTapChosen ? "✓ " : "")\(oneTap.title) · \(String(oneTap.day.prefix(3)))",
                            selected: row.oneTapChosen, tint: WF.success,
                            label: "\(oneTap.title) on \(oneTap.when) "
                                + (row.oneTapChosen ? "is your time together" : "already counts")
                        ) {
                            link(row.key, oneTap.id)
                        }
                    }

                    // "I also cant link an existing time." An evening where the two of them
                    // are both there ALONGSIDE somebody else was only ever a sentence —
                    // "but it's not that" — with no way to point at it and say that IS our
                    // time. NEVER in the chosen state: exactly one chip on this row says
                    // "this is the answer", and it is the one naming the event.
                    if row.showPicker {
                        chip(
                            row.answer == nil ? "Link a time" : "Change",
                            selected: false, tint: WF.primary,
                            label: (row.answer == nil ? "Link a time" : "Change the time") + " for \(row.who)"
                        ) {
                            picking = picking == row.key ? nil : row.key
                        }
                    }

                    ForEach(row.slots) { slot in
                        chip(slot.label, selected: false, tint: WF.primary, label: slot.label) {
                            openComposer(compose(slot, participantIds: row.personIds))
                        }
                    }

                    chip(
                        "＋ Another time", selected: false, tint: WF.primary,
                        label: "Another time for \(row.who)"
                    ) {
                        openComposer(
                            PlanningConnectionCompose(
                                day: dayDate(props.weekStart), start: nil,
                                participantIds: row.personIds))
                    }
                }

                // The candidates, named by WHEN they are — two dinners in one week need
                // telling apart, and the day is the only thing that does it. Picking the one
                // already linked unlinks it: the answer stays undoable.
                if picking == row.key {
                    VStack(spacing: 6) {
                        ForEach(row.candidates) { event in
                            Button {
                                link(row.key, event.id)
                            } label: {
                                HStack(spacing: 8) {
                                    Text(event.title)
                                        .font(.system(size: 13.5, weight: .bold)).foregroundStyle(WF.ink)
                                    Spacer(minLength: 6)
                                    Text(event.when)
                                        .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
                                }
                                .padding(.horizontal, 11).padding(.vertical, 9)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .planningOptionChrome(
                                    selected: row.answer?.id == event.id, tint: WF.success)
                            }
                            .buttonStyle(.plain)
                            .disabled(props.busy)
                            .accessibilityAddTraits(row.answer?.id == event.id ? .isSelected : [])
                        }
                    }
                    .accessibilityLabel("Time \(row.who) already share")
                }
            }
        }
    }

    /// A person's face. Identity, not a control — the household's own colour and emoji,
    /// through the shared `Avatar` rather than a hand-rolled circle.
    private func face(_ personId: String) -> some View {
        let member = sync.members.first { $0.id == personId }
        return Avatar(colorHex: member?.colorHex, emoji: member?.emoji ?? "🙂", size: 30)
    }

    /// `wfChip`'s canonical selectable treatment; the padding and the label stay here, as
    /// every other chip call site in the app does it.
    private func chip(
        _ text: String, selected: Bool, tint: Color, label: String, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Text(text)
                .font(.system(size: 12.5, weight: .bold))
                .foregroundStyle(selected ? tint : WF.ink2)
                .padding(.horizontal, 11).padding(.vertical, 7)
                .wfChip(selected: selected, tint: tint)
        }
        .buttonStyle(.plain)
        .disabled(props.busy)
        .accessibilityLabel(label)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    // MARK: - Actions

    private func link(_ key: String, _ eventId: String?) {
        picking = nil
        Task { await model.link(key: key, eventId: eventId, sessionId: props.sessionId) }
    }

    /// What a slot chip hands the event sheet: the day, and the instant ONLY when there is
    /// one. `startsAt == nil` is the whole day being free, so the sheet's own picker
    /// decides — this step never names an hour the week doesn't justify.
    private func compose(
        _ slot: WaffledAPI.PlanningConnectionSlot, participantIds: [String]
    ) -> PlanningConnectionCompose {
        PlanningConnectionCompose(
            day: dayDate(slot.date),
            // `EventTime.parse` on purpose: the server sends a UTC instant WITH
            // milliseconds ("…T01:30:00.000Z"), which a bare `ISO8601DateFormatter` refuses
            // — and a nil here would silently fall back to the sheet's 5pm default, which
            // is exactly the bug `prefillStart:` exists to prevent.
            start: EventTime.parse(slot.startsAt),
            participantIds: participantIds)
    }

    private func openComposer(_ next: PlanningConnectionCompose) {
        composeParticipants = next.participantIds
        compose = next
    }

    /// `onSaved` is ASSIGNED rather than passed: it is a property on `EventEditSheet` with
    /// no matching parameter on that type's explicit initializer, and this file may not
    /// edit it.
    private func eventSheet(_ c: PlanningConnectionCompose) -> EventEditSheet {
        var sheet = EventEditSheet(
            event: nil, initialDate: c.day, prefillParticipantIds: c.participantIds,
            prefillStart: c.start)
        sheet.onSaved = { onSaved() }
        return sheet
    }

    /// Re-read rather than bookkeeping: a pairing's status IS the calendar, so the only
    /// honest way to redraw the rows is to ask again — and to keep asking until the answer
    /// includes the event that was just written. See `PlanningConnectionModel.catchup`.
    private func onSaved() {
        // No "did they save?" flag here, unlike step 2: this step lends the banner no verb,
        // so nobody is waiting to be told whether the composer was cancelled — and `onSaved`
        // firing at all IS the save.
        let participants = composeParticipants
        Task {
            await model.settleAfterSave(
                weekStart: props.weekStart, sessionId: props.sessionId,
                participantIds: participants)
        }
        props.refresh()
    }

    private func composeDismissed() {
        composeParticipants = []
    }

    private func dayDate(_ key: String) -> Date {
        DateFmt.date(key, "yyyy-MM-dd", tz) ?? Date()
    }
}

/// "＋ Make a pairing" — the first-class action, at full width under the rows.
///
/// Choosing WHO is not an event form: it is the input to the slot query (the gaps depend on
/// whose week you're looking at) and the prefill for the sheet. What and when and the save
/// all belong to `EventEditSheet`, which is why there is no title field here and no save
/// button — every chip below opens the sheet.
private struct PlanningMakePairing: View {
    let model: PlanningConnectionModel
    let weekStart: String
    let members: [SyncedMember]
    let busy: Bool
    let onCompose: (PlanningConnectionCompose) -> Void

    @Environment(SyncManager.self) private var sync
    @State private var open = false
    @State private var picked: Set<String> = []
    @State private var slots: [WaffledAPI.PlanningConnectionSlot] = []
    @State private var who = ""

    /// HOUSEHOLD ORDER, not the order they were tapped — so the same three people always
    /// ask the server the same question, and the key the composer builds matches a row's.
    private var chosen: [String] { members.filter { picked.contains($0.id) }.map(\.id) }
    /// Keyed on the ids THEMSELVES, so the slot read fires when the choice changes and not
    /// when the members array happens to be rebuilt.
    private var chosenKey: String { chosen.joined(separator: ",") }

    var body: some View {
        Group {
            if open { expanded } else { collapsed }
        }
        .task(id: chosenKey) {
            guard chosen.count >= 2 else {
                slots = []
                who = ""
                return
            }
            if let result = await model.slots(weekStart: weekStart, personIds: chosen) {
                slots = result.slots
                who = result.who
            } else {
                slots = []
                who = ""
            }
        }
    }

    private var collapsed: some View {
        Button {
            open = true
        } label: {
            HStack(spacing: 10) {
                Text("＋ Make a pairing — any two people, any time")
                    .font(.system(size: 13.5, weight: .bold)).foregroundStyle(WF.ink)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 6)
                HStack(spacing: -6) {
                    ForEach(members) { member in
                        Avatar(colorHex: member.colorHex, emoji: member.emoji ?? "🙂", size: 24)
                    }
                }
            }
            .padding(13)
            .frame(maxWidth: .infinity, alignment: .leading)
            .wfField(fill: WF.panel)
        }
        .buttonStyle(.plain)
        .disabled(busy)
    }

    private var expanded: some View {
        WaffledCard {
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    SectionLabel(text: "Who")
                    ChipFlow(spacing: 6, lineSpacing: 6) {
                        ForEach(members) { member in
                            let on = picked.contains(member.id)
                            Button {
                                if picked.contains(member.id) {
                                    picked.remove(member.id)
                                } else {
                                    picked.insert(member.id)
                                }
                            } label: {
                                HStack(spacing: 6) {
                                    Avatar(
                                        colorHex: member.colorHex, emoji: member.emoji ?? "🙂",
                                        size: 22)
                                    Text(member.name)
                                        .font(.system(size: 12.5, weight: .bold))
                                        .foregroundStyle(on ? WF.primaryD : WF.ink2)
                                }
                                .padding(.horizontal, 9).padding(.vertical, 5)
                                .wfChip(selected: on, tint: WF.primary)
                            }
                            .buttonStyle(.plain)
                            .disabled(busy)
                            .accessibilityLabel(
                                on ? "\(member.name) — take out of the pairing"
                                   : "\(member.name) — add to the pairing")
                            .accessibilityAddTraits(on ? .isSelected : [])
                        }
                    }
                    Text(who.isEmpty ? "Tap two people — or three." : "\(who) · tap to add anyone else")
                        .font(.system(size: 12)).foregroundStyle(WF.ink3)
                }

                // The same gaps a suggested row offers, for people the app didn't suggest.
                VStack(alignment: .leading, spacing: 6) {
                    SectionLabel(text: "When")
                    if chosen.count < 2 {
                        Text("Their free evenings appear once there are two of them.")
                            .font(.system(size: 12)).foregroundStyle(WF.ink3)
                    } else {
                        ChipFlow(spacing: 6, lineSpacing: 6) {
                            ForEach(slots.prefix(PlanningConnectionCopy.slotsPerRow + 1)) { slot in
                                chip(slot.label) {
                                    onCompose(
                                        PlanningConnectionCompose(
                                            day: dayDate(slot.date),
                                            start: EventTime.parse(slot.startsAt),
                                            participantIds: chosen))
                                }
                            }
                            // "Any time" has to mean any time — the week's gaps are a
                            // shortcut, not the only door. This one opens the sheet on its
                            // own picker.
                            chip("Pick a date and time") {
                                onCompose(
                                    PlanningConnectionCompose(
                                        day: dayDate(weekStart), start: nil,
                                        participantIds: chosen))
                            }
                        }
                    }
                }

                Button("Cancel") {
                    open = false
                    picked = []
                }
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(WF.ink3)
                .buttonStyle(.plain)
            }
        }
    }

    private func chip(_ text: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(text)
                .font(.system(size: 12.5, weight: .bold)).foregroundStyle(WF.ink2)
                .padding(.horizontal, 11).padding(.vertical, 7)
                .wfChip(selected: false, tint: WF.primary)
        }
        .buttonStyle(.plain)
        .disabled(busy)
    }

    private func dayDate(_ key: String) -> Date {
        DateFmt.date(key, "yyyy-MM-dd", sync.householdTz) ?? Date()
    }
}

/// What the shared event sheet is opening on. `start` is nil when the whole day is free.
struct PlanningConnectionCompose: Identifiable {
    let id = UUID().uuidString
    let day: Date
    let start: Date?
    let participantIds: [String]
}

/// The step's fixed copy, in one place so a sentence can be asserted without a view.
enum ConnectionCopy {
    static let readFailed = "Couldn’t read your week just now."
    static let needsTwoPeople =
        "This one needs more than one person in the household — add someone in Settings, and pairings appear here."
    static let note =
        "The rows above are just the pairings the app can see — they aren’t the list. "
        + "Make a pairing takes any two people and any time, and the slots offered are the gaps the "
        + "week already left behind. Either way it ends up as a normal calendar event. Add a third "
        + "person and it still lands on the calendar — it just counts as time together rather than as "
        + "time with just the two of them."
}
