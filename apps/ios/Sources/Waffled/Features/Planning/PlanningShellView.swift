import SwiftUI

// Weekly Planning — the session shell.
//
// The argument the design makes is that the WEEK is the content and the chrome is four
// things: a step counter, a title, the ONE question the step asks, and a 2px progress
// hair. The ten steps behind the counter are reachable from the counter itself (the
// agenda sheet) rather than a permanent rail — a rail teaches the shape of the session
// once and then costs a fifth of the display forever.
//
// Every step's BODY lives in its own file behind `planningStepBody(_:)`; this file owns
// only the chrome, the lobby, the "left for now" screen, the agenda sheet and the saved
// record. The step catalog — order, titles, questions, primary labels, which module each
// step reads — comes from the server so this screen and the web cannot drift.
//
// Ported from `apps/web/src/kiosk/WeeklyPlanning.tsx`. The one substantive difference is
// that the web keeps "which step" in the URL and this keeps it in `PlanningModel
// .askedStep`; see that model's doc comment for the full list of assignments the web
// does with `navigate`.

/// The whole session surface: lobby → session → record, plus the agenda sheet.
struct PlanningShellView: View {
    @Environment(SyncManager.self) private var sync
    /// Pops the screen for the header's own back chevron — see `sessionHeader`, which
    /// replaces the navigation bar rather than sitting under it.
    @Environment(\.dismiss) private var dismiss

    @State private var model = PlanningModel()
    @State private var sheet = false
    @State private var confirmDiscard = false
    /// The verb the step on screen has lent the parked-note banner, if it has one — and
    /// the step that lent it.
    ///
    /// Pairing them is the same trick as the model's crumb, and for the same reason: a
    /// verb whose owner is no longer on screen is simply not READ, so nothing has to
    /// clear it at the right moment. An `.onChange(of: current?.key)` that nilled it
    /// would race the incoming step's own `.task`/`.onAppear` — SwiftUI does not order a
    /// parent's change handler against a child's appearance — and losing that race
    /// leaves the banner permanently on "Handled", which the seam's own doc calls the
    /// worse of the two failures.
    @State private var handoffVerb: PlanningHandoffVerb?
    @State private var handoffVerbStepKey: String?

    private var isKiosk: Bool { DeviceExperience.current == .kiosk }

    var body: some View {
        content
            .background(WF.canvas)
            // THE NAVIGATION BAR IS GONE, and that is a deliberate ~44pt.
            //
            // It cost a full bar to render the word "Weekly planning" directly above a
            // serif "Horizon scan" — two titles for one screen, and the one that mattered
            // was the lower one. Between that bar, four header rows and a footer carrying
            // the wrong clearance, the chrome had taken over half of an iPhone 17 Pro:
            // "that is too much so that I dont even want to go through the steps."
            //
            // `sessionHeader` now carries the back chevron itself, in the same 36pt
            // circular treatment the reward shop uses for exactly this — a pushed screen
            // that draws its own header. Swipe-back still works.
            .toolbar(.hidden, for: .navigationBar)
            // Keyed on the refresh signal, not a bare `.task`: SwiftUI runs a bare one
            // once per appearance, so this screen would sit on launch-time data through
            // every pull-to-refresh. See SyncManager.refreshRev.
            .task(id: sync.refreshRev) { await model.load() }
            .sheet(isPresented: $sheet) { agendaSheet }
    }

    @ViewBuilder private var content: some View {
        if !sync.module(.weeklyPlanning) {
            // Every route under /api/weekly-planning 403s with the module off, so there
            // is nothing to load and nothing to say but where the switch is.
            WaffledEmptyState(
                emoji: "🗓️",
                title: "Weekly Planning is off",
                message: "Turn it on in Settings → Modules to run a guided session for the week ahead.")
        } else if model.view == nil {
            if model.loaded {
                WaffledEmptyState(
                    emoji: "😕",
                    title: "Couldn’t load the session",
                    message: "Pull to refresh, or check that you’re still signed in.")
            } else {
                WaffledLoading()
            }
        } else if model.hasNoRunnableSteps {
            WaffledEmptyState(
                emoji: "🧩",
                title: "Nothing to run",
                message: "Every step of the session reads a module that’s turned off. Turn one back on in Settings → Modules, or turn individual steps on under Weekly Planning.")
        } else if model.showsRecord {
            recordScreen
        } else if model.isPaused {
            pausedScreen
        } else if model.session == nil {
            lobbyScreen
        } else {
            sessionScreen
        }
    }

    // MARK: - Lobby (no session yet)

    private var lobbyScreen: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                errorBanner
                Text("\(model.sessionDayName)’s session")
                    .font(WF.serif(26, .bold)).foregroundStyle(WF.ink)
                Text("\(model.runnable.count) steps. Jump anywhere, leave whenever the week is decided.")
                    .font(.system(size: 14)).foregroundStyle(WF.ink3)
                    .fixedSize(horizontal: false, vertical: true)
                weekStepper
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(model.actGroups) { group in
                        VStack(alignment: .leading, spacing: 4) {
                            SectionLabel(text: group.act)
                            Text(group.steps.map(\.title).joined(separator: " · "))
                                .font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink2)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .padding(.vertical, 2)
                WaffledPrimaryCTA(label: "Start the session", isBusy: model.busy) {
                    Task { await model.start() }
                }
                .padding(.top, 4)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16).padding(.bottom, WF.bottomBarClearance)
        }
    }

    // MARK: - Left for now

    /// Where "Leave for now" puts you, and the answer to "I expected to leave the
    /// planning session and then go back to where I can select a week to plan for". It is
    /// the lobby's job with a session in hand: the week you were planning is OFFERED
    /// rather than forced, and the week stepper — which is only reachable through the
    /// agenda sheet once a session exists — is right here.
    private var pausedScreen: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                errorBanner
                Text("Left for now").font(WF.serif(26, .bold)).foregroundStyle(WF.ink)
                Text("\(model.weekLabel) is part-planned — \(model.settledCount) of \(model.runnable.count) steps decided. Nothing was lost; pick it up whenever.")
                    .font(.system(size: 14)).foregroundStyle(WF.ink3)
                    .fixedSize(horizontal: false, vertical: true)
                WaffledPrimaryCTA(label: "Resume the session", isBusy: model.busy) { model.resume() }
                planAnotherWeek
                discardBlock
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16).padding(.bottom, WF.bottomBarClearance)
        }
    }

    // MARK: - The record

    /// The finished session is a receipt, not a dashboard: what it decided, and a way
    /// back in. After this, Today is the surface.
    private var recordScreen: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                errorBanner
                VStack(alignment: .leading, spacing: 4) {
                    Text("The week is decided").font(WF.serif(26, .bold)).foregroundStyle(WF.ink)
                    Text(model.savedAtLabel.map { "\(model.weekLabel) · saved \($0)" } ?? model.weekLabel)
                        .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink3)
                }
                WaffledCard(padding: 4) {
                    VStack(spacing: 0) {
                        if model.decidedSteps.isEmpty {
                            Text("Nothing was decided in this session.")
                                .font(.system(size: 14)).foregroundStyle(WF.ink3)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 11).padding(.vertical, 14)
                        } else {
                            ForEach(Array(model.decidedSteps.enumerated()), id: \.element.key) { i, step in
                                if i > 0 { Divider().background(WF.hair) }
                                recordRow(step)
                            }
                        }
                    }
                }
                Button {
                    Task { await model.reopen() }
                } label: {
                    Text("Reopen the session")
                        .font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink2)
                        .frame(maxWidth: .infinity).padding(.vertical, 12)
                        .wfField()
                }
                .buttonStyle(.plain).disabled(model.busy)
                planAnotherWeek
                discardBlock
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16).padding(.bottom, WF.bottomBarClearance)
        }
    }

    private func recordRow(_ step: WaffledAPI.PlanningStep) -> some View {
        HStack(alignment: .top, spacing: 11) {
            Text(step.isDone ? "✓" : "–")
                .font(.system(size: 15, weight: .heavy))
                .foregroundStyle(step.isDone ? WF.success : WF.ink3)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(step.title).font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
                Text(step.isDone ? step.primary : "Skipped — a real answer")
                    .font(.system(size: 12.5)).foregroundStyle(WF.ink3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 6)
        }
        .padding(.horizontal, 11).padding(.vertical, 12)
    }

    // MARK: - In session

    private var sessionScreen: some View {
        VStack(spacing: 0) {
            sessionHeader
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    errorBanner
                    if let step = model.current, let sessionId = model.session?.id, let week = model.view?.weekStart {
                        let props = stepProps(step, sessionId: sessionId, weekStart: week)
                        PlanningHandoffBanner(
                            step: step,
                            // Everything that was SENT to this step now arrives in the
                            // one box at the top — parked notes and routed loose ends
                            // both. They used to come through two doors that opened in
                            // two places: "wouldnt these be in the top 'parked things'
                            // box? why are they hidden at the bottom?"
                            routes: props.routes,
                            busy: model.busy,
                            // A verb belongs to the step that lent it: a banner still
                            // offering "Make an event" two steps later would open the
                            // wrong composer.
                            verb: handoffVerbStepKey == step.key ? handoffVerb : nil,
                            resolve: { id, action in await model.resolveParked(id: id, action: action) })
                            // Per-note "hidden" state is local to the banner; a step
                            // change has to start it empty. It is ALSO what remembers
                            // which routed rows have been acted on this sitting, so the
                            // lifetime has to stay exactly this: a same-step refetch
                            // keeps it, a step change clears it.
                            .id(step.key)
                        // Keyed on the step so moving on gives the next body a clean
                        // slate rather than inheriting the last one's @State.
                        planningStepBody(props).id(step.key)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                // The footer below is fixed, so this scroll view clears IT rather than
                // the tab bar; the footer carries the bar's clearance.
                .padding(.bottom, 12)
            }
            sessionFooter
        }
    }

    /// Two rows and the step's question, where there used to be a navigation bar and
    /// four rows. Every line here earns its height:
    ///
    /// - **row 1** — back out, the step counter (the door to the agenda), and the exit.
    ///   Three controls, one row, because none of them is content.
    /// - **row 2** — the step title in serif, with the week riding the same baseline on
    ///   the right. The week is context for the title, so it costs nothing to sit beside
    ///   it instead of below it.
    /// - **the ask** — the one question the step puts to you. This is the only line of
    ///   the four that was ever the point, so it is the only one that kept its own row.
    /// "I think we have this backwards" — and it was.
    ///
    /// The screen's own name goes in the top row where a navigation title would be, with
    /// the week beside it; the session's MACHINERY — which step you're on, the way out,
    /// the progress hair — sits underneath it. The first arrangement led with the
    /// machinery and buried the name of the thing you were actually doing.
    ///
    /// - **row 1** — back out, the step's name, the week. What screen is this?
    /// - **row 2** — the counter (the door to the agenda) and the exit. Session controls,
    ///   grouped, directly above the hair that belongs with them.
    /// - **the ask** — the one question the step puts to you.
    private var sessionHeader: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 10) {
                if !isKiosk {
                    // The navigation bar's job, done in the header's own first row — so
                    // it sits with the title it used to sit above. On the kiosk this
                    // screen is a rail PAGE with nothing to pop, so no chevron there.
                    Button { dismiss() } label: {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 16, weight: .bold)).foregroundStyle(WF.ink2)
                            .frame(width: 36, height: 36).background(WF.panel).clipShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Back")
                }

                Text(model.current?.title ?? "")
                    .font(WF.serif(22, .bold)).foregroundStyle(WF.ink)
                    .lineLimit(1).minimumScaleFactor(0.8)

                Spacer(minLength: 6)

                Text(model.weekLabel)
                    .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
                    .lineLimit(1)
            }
            HStack(spacing: 10) {
                Button { sheet = true } label: {
                    // `WaffledMenuPill` is the app's "tap to change" trigger — bold text
                    // plus a down chevron — which is exactly what the counter is: the
                    // door to the agenda.
                    WaffledMenuPill(text: "\(model.position) of \(model.runnable.count)")
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Step \(model.position) of \(model.runnable.count). Open the agenda")

                Spacer(minLength: 6)

                // THE DOOR, in the chrome rather than only inside the agenda sheet. "We
                // do need some sort of exit button without going through the whole
                // thing." A ten-step surface with no visible exit reads as one you are
                // committed to finishing. The words are the sheet's, deliberately: "for
                // now" is the part that matters, because leaving keeps the session and
                // everything it has already decided.
                //
                // It stays a SEPARATE control from the chevron above it: back pops this
                // screen and leaves the session current, so re-opening Planning drops you
                // straight back in — which is the very thing "leave for now" was added to
                // fix. Same direction, different promise.
                Button { model.leave() } label: {
                    Text("Leave for now")
                        .font(.system(size: 13.5, weight: .bold)).foregroundStyle(WF.ink3)
                }
                .buttonStyle(.plain)
            }
            Text(model.current?.ask ?? "")
                .font(.system(size: 13.5)).foregroundStyle(WF.ink2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16).padding(.top, 6).padding(.bottom, 10)
        // The 2px hair — the only progress indicator the design keeps.
        .overlay(alignment: .bottom) {
            ProgressBar(value: model.progress, tint: WF.primary, track: WF.hair, height: 2)
        }
    }

    private var sessionFooter: some View {
        HStack(spacing: 10) {
            Button {
                Task { await model.answer("skipped") }
            } label: {
                Text("Skip this step")
                    .font(.system(size: 14, weight: .bold)).foregroundStyle(WF.ink3)
            }
            .buttonStyle(.plain).disabled(model.busy)

            if let step = model.current, let sessionId = model.session?.id, let week = model.view?.weekStart {
                planningStepFooterExtra(stepProps(step, sessionId: sessionId, weekStart: week))
            }

            Spacer(minLength: 8)
            primaryAnswerButton
        }
        .padding(.horizontal, 16).padding(.top, 10)
        // `fixedBarClearance`, NOT `bottomBarClearance`. This footer is pinned, not
        // scrolled, so it wants to sit flush on top of the tab bar; the scrolling figure
        // left ~46pt of bare canvas between the buttons and the bar. See WF.tabBarHeight.
        //
        // …and no clearance at all while a keyboard is docked, because `AppRoot` has taken
        // the bar away by then (KeyboardState.hidesBottomBar — one rule, read in both
        // places). Reserving for an absent bar is what stacked the footer, the tab bar and
        // the keyboard into three rows of chrome with the step squeezed above them.
        .padding(.bottom, 10 + (KeyboardState.shared.hidesBottomBar ? 0 : WF.fixedBarClearance))
        .background(WF.card)
        .overlay(alignment: .top) { Rectangle().fill(WF.hair).frame(height: 1) }
    }

    /// Hand-rolled rather than `WaffledPrimaryCTA`: that takes a single `label: String`
    /// and fills the width, and this button carries TWO weights — the step's own
    /// affirmative plus a de-emphasised "· next: <title>" — beside a Skip control.
    private var primaryAnswerButton: some View {
        Button {
            Task { await model.answer("done") }
        } label: {
            HStack(spacing: 6) {
                if model.busy { ProgressView().controlSize(.small).tint(.white) }
                Text(model.current?.primary ?? "Done")
                    .font(.system(size: 15, weight: .bold)).foregroundStyle(.white)
                    .lineLimit(1)
                // "· next: <title>" is a KIOSK affordance. On a phone the two together
                // never fit: the affirmative wrapped onto two lines and the hint truncated
                // anyway ("Nothing / missing · next: Family ni…"), which cost height AND
                // read as broken. The agenda pill one row up already answers "what's
                // next", so the phone drops the hint rather than shrinking the answer.
                if isKiosk, let next = model.next {
                    Text("· next: \(next.title)")
                        .font(.system(size: 12, weight: .semibold)).foregroundStyle(.white.opacity(0.75))
                        .lineLimit(1)
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 11)
            .background(model.busy ? WF.ink3 : WF.primary)
            .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        }
        .buttonStyle(.plain).disabled(model.busy)
    }

    // MARK: - The agenda sheet

    private var agendaSheet: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("\(model.sessionDayName)’s session")
                            .font(WF.serif(22, .bold)).foregroundStyle(WF.ink)
                        Text("\(model.runnable.count) steps. Jump anywhere, leave whenever the week is decided.")
                            .font(.system(size: 13)).foregroundStyle(WF.ink3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    weekStepper
                    ForEach(model.actGroups) { group in
                        VStack(alignment: .leading, spacing: 8) {
                            SectionLabel(text: group.act)
                            ForEach(group.steps) { step in agendaRow(step) }
                        }
                    }
                    // The sheet already promises you can "leave whenever", so it has to
                    // offer the door. Leaving keeps the session exactly where it is.
                    Button {
                        sheet = false
                        model.leave()
                    } label: {
                        Text("Leave for now")
                            .font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink2)
                            .frame(maxWidth: .infinity).padding(.vertical, 12)
                            .wfField()
                    }
                    .buttonStyle(.plain)
                    discardBlock
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
            }
            .background(WF.canvas)
            .navigationTitle("The agenda").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { closeSheet() }
                }
            }
        }
        .modifier(KioskSheetPresentation(kiosk: isKiosk))
    }

    private func agendaRow(_ step: WaffledAPI.PlanningStep) -> some View {
        let here = step.key == model.current?.key
        return Button {
            sheet = false
            Task { await model.jump(to: step.key) }
        } label: {
            HStack(spacing: 11) {
                Text(step.isDone ? "✓" : "\(model.stepNumbers[step.key] ?? 0)")
                    .font(.system(size: 13, weight: .heavy))
                    .foregroundStyle(step.isDone ? WF.success : (here ? WF.primary : WF.ink3))
                    .frame(width: 24, height: 24)
                    .background(here ? WF.primary.opacity(0.12) : WF.panel)
                    .clipShape(Circle())
                Text(step.title)
                    .font(.system(size: 15, weight: here ? .heavy : .semibold))
                    .foregroundStyle(step.isSettled && !here ? WF.ink2 : WF.ink)
                Spacer(minLength: 6)
                if here {
                    WaffledStatusBadge(text: "you’re here", color: WF.primary)
                } else if step.isDone {
                    WaffledStatusBadge(text: "decided", color: WF.success)
                } else if step.isSkipped {
                    WaffledStatusBadge(text: "skipped", color: WF.ink3)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .wfField(radius: WF.rSM, fill: here ? WF.primary.opacity(0.06) : WF.card)
        }
        .buttonStyle(.plain).disabled(model.busy)
    }

    private func closeSheet() {
        sheet = false
        confirmDiscard = false
    }

    // MARK: - Shared bits

    /// The week stepper. Offered in the lobby, in the agenda sheet, on the "left for now"
    /// screen and under the record — the four places you'd look for "no, a different
    /// week". The back arrow floors at the household's CURRENT week: a week that has
    /// finished cannot be planned.
    private var weekStepper: some View {
        HStack(spacing: 12) {
            Button { Task { await model.goPreviousWeek() } } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 13, weight: .heavy))
                    .foregroundStyle(model.canGoBack ? WF.ink2 : WF.ink3.opacity(0.4))
                    .frame(width: 34, height: 34)
                    .background(WF.panel).clipShape(Circle())
            }
            .buttonStyle(.plain).disabled(!model.canGoBack || model.busy)
            .accessibilityLabel("Plan the previous week")

            Text(model.weekLabel)
                .font(.system(size: 14, weight: .bold)).foregroundStyle(WF.ink)
                .frame(maxWidth: .infinity)

            Button { Task { await model.goNextWeek() } } label: {
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .heavy)).foregroundStyle(WF.ink2)
                    .frame(width: 34, height: 34)
                    .background(WF.panel).clipShape(Circle())
            }
            .buttonStyle(.plain).disabled(model.busy)
            .accessibilityLabel("Plan the next week")
        }
    }

    private var planAnotherWeek: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel(text: "Plan another week")
            weekStepper
        }
    }

    /// Start the week over. The lobby is otherwise unreachable once a session exists —
    /// coming back to Planning resumes — so without this a week started by mistake could
    /// never be undone. Two-tap because it can't be taken back.
    @ViewBuilder private var discardBlock: some View {
        if confirmDiscard {
            VStack(alignment: .leading, spacing: 10) {
                Text("Throw this session away and start the week over? What it already decided — events added, chores handed out — stays put; only the session is discarded.")
                    .font(.system(size: 12.5)).foregroundStyle(WF.ink2)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 10) {
                    Button { confirmDiscard = false } label: {
                        Text("Keep it").font(.system(size: 14, weight: .bold)).foregroundStyle(WF.ink2)
                            .frame(maxWidth: .infinity).padding(.vertical, 10)
                            .background(WF.panel).clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    Button {
                        confirmDiscard = false
                        sheet = false
                        Task { await model.discard() }
                    } label: {
                        Text("Start over").font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                            .frame(maxWidth: .infinity).padding(.vertical, 10)
                            .background(WF.danger).clipShape(Capsule())
                    }
                    .buttonStyle(.plain).disabled(model.busy)
                }
            }
            .padding(12)
            .background(WF.dangerT)
            .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        } else if model.session != nil {
            Button { confirmDiscard = true } label: {
                Text("Start this week over")
                    .font(.system(size: 13, weight: .bold)).foregroundStyle(WF.danger)
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 2)
        }
    }

    @ViewBuilder private var errorBanner: some View {
        if let message = model.errorMessage {
            DismissibleErrorBanner(message: message) { model.dismissError() }
        }
    }

    private func stepProps(
        _ step: WaffledAPI.PlanningStep, sessionId: String, weekStart: String
    ) -> PlanningStepProps {
        PlanningStepProps(
            step: step,
            sessionId: sessionId,
            weekStart: weekStart,
            setDecisionData: { model.setDecisionData($0) },
            refresh: { Task { await model.load() } },
            busy: model.busy,
            // Off the looseEnds step's OWN row — see the note on `PlanningStepProps.routes`.
            // A step that hasn't run yet simply has no `routes` key, hence `?? []`.
            routes: PlanningRouteSeed.decode(model.steps.first { $0.key == "looseEnds" }?.data["routes"]),
            goToStep: { model.show($0) },
            lendVerb: { verb in
                handoffVerb = verb
                handoffVerbStepKey = verb == nil ? nil : step.key
            })
    }
}
