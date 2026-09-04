import Foundation
import Observation

/// One act of the agenda and the steps under it — `PlanningFormat.stepsByAct`'s tuples,
/// given a name so `ForEach` has something `Identifiable` to hold. The id is the act
/// name plus the first step's key, because two separated runs CAN share an act name
/// (the grouping is consecutive-runs-only, deliberately) and a duplicated id inside one
/// `ForEach` makes SwiftUI reuse the wrong rows.
struct PlanningActGroup: Identifiable, Equatable {
    let act: String
    let steps: [WaffledAPI.PlanningStep]
    var id: String { act + "\u{1}" + (steps.first?.key ?? "") }
}

/// Weekly Planning — the session shell's model.
///
/// A port of `apps/web/src/kiosk/WeeklyPlanning.tsx`'s state, with ONE substantive
/// translation: the web keeps "which step am I looking at" in the URL (`/planning/:step`)
/// and "which week" in the query. There is no URL here, so both become fields —
/// `askedStep` and `requestedWeek` — and every place the web navigates, this model
/// assigns. The list is short and it is the whole port, so it is worth naming:
///
///   * `jump(to:)`        sets `askedStep`, then moves the session's own pointer.
///   * `answer(_:)`       sets `askedStep` to the next step, or clears it and completes.
///   * `resume()`         sets `askedStep` to the session's pointer and drops the pause.
///   * `leave()`          clears `askedStep` and records the pause.
///   * `goWeek(_:)`       clears `askedStep` — a step key belongs to ITS week's session.
///   * `discard()`        clears both.
///
/// The session's own `currentStep` stays the cross-DEVICE resume pointer; `askedStep` is
/// only where THIS screen is, exactly as the URL was on the web.
///
/// Every network call is an injected closure with a `WaffledAPI()`-backed default — the
/// test seam, and the reason `PlanningModelTests` can drive the whole session without a
/// server.
@MainActor
@Observable
final class PlanningModel {

    // MARK: - The seam

    typealias FetchView = (_ weekStart: String?) async throws -> WaffledAPI.WeeklyPlanningView
    typealias FetchConfig = () async throws -> WaffledAPI.WeeklyPlanningConfigView
    typealias SaveConfig = (
        _ dayOfWeek: Int?, _ time: String?, _ showOnToday: Bool?, _ steps: [String: Bool]?
    ) async throws -> WaffledAPI.WeeklyPlanningConfig
    typealias StartSession = (_ weekStart: String?) async throws -> WaffledAPI.PlanningSession
    typealias PatchSession = (
        _ id: String, _ currentStep: String?, _ status: String?
    ) async throws -> WaffledAPI.PlanningSession
    typealias DecideStep = (
        _ sessionId: String, _ stepKey: String, _ status: String, _ data: [String: JSONValue]?
    ) async throws -> [WaffledAPI.PlanningStep]
    typealias CompleteSession = (_ id: String) async throws -> WaffledAPI.WeeklyPlanningCompletion
    typealias DiscardSession = (_ id: String) async throws -> Void
    typealias ResolveLooseEnd = (
        _ kind: String, _ id: String, _ action: String, _ sessionId: String?
    ) async throws -> Void

    private let fetchView: FetchView
    private let fetchConfig: FetchConfig
    private let saveConfigCall: SaveConfig
    private let startSessionCall: StartSession
    private let patchSessionCall: PatchSession
    private let decideStepCall: DecideStep
    private let completeSessionCall: CompleteSession
    private let discardSessionCall: DiscardSession
    private let resolveLooseEndCall: ResolveLooseEnd

    /// Where the per-device "I've stepped out" intent is kept. See `leave()`.
    private let defaults: UserDefaults

    init(
        fetchView: @escaping FetchView = { weekStart in
            try await WaffledAPI().weeklyPlanning(weekStart: weekStart)
        },
        fetchConfig: @escaping FetchConfig = {
            try await WaffledAPI().weeklyPlanningConfig()
        },
        saveConfig: @escaping SaveConfig = { dayOfWeek, time, showOnToday, steps in
            try await WaffledAPI().setWeeklyPlanningConfig(
                dayOfWeek: dayOfWeek, time: time, showOnToday: showOnToday, steps: steps)
        },
        startSession: @escaping StartSession = { weekStart in
            try await WaffledAPI().startWeeklyPlanningSession(weekStart: weekStart)
        },
        patchSession: @escaping PatchSession = { id, currentStep, status in
            try await WaffledAPI().patchWeeklyPlanningSession(
                id: id, currentStep: currentStep, status: status)
        },
        decideStep: @escaping DecideStep = { sessionId, stepKey, status, data in
            try await WaffledAPI().decideWeeklyPlanningStep(
                sessionId: sessionId, stepKey: stepKey, status: status, data: data)
        },
        completeSession: @escaping CompleteSession = { id in
            try await WaffledAPI().completeWeeklyPlanningSession(id: id)
        },
        discardSession: @escaping DiscardSession = { id in
            try await WaffledAPI().discardWeeklyPlanningSession(id: id)
        },
        resolveLooseEnd: @escaping ResolveLooseEnd = { kind, id, action, sessionId in
            try await WaffledAPI().resolveWeeklyPlanningLooseEnd(
                kind: kind, id: id, action: action, sessionId: sessionId)
        },
        defaults: UserDefaults = .standard
    ) {
        self.fetchView = fetchView
        self.fetchConfig = fetchConfig
        self.saveConfigCall = saveConfig
        self.startSessionCall = startSession
        self.patchSessionCall = patchSession
        self.decideStepCall = decideStep
        self.completeSessionCall = completeSession
        self.discardSessionCall = discardSession
        self.resolveLooseEndCall = resolveLooseEnd
        self.defaults = defaults
        self.pausedSessionId = defaults.string(forKey: Self.pausedKey)
    }

    // MARK: - State

    private(set) var view: WaffledAPI.WeeklyPlanningView?
    /// A fetch has completed at least once. A FAILED fetch keeps the previous `view` and
    /// still sets this — the `RestDomain` contract, so the screen never flashes "couldn't
    /// load" over data it already had, and never sits on "Loading…" forever.
    private(set) var loaded = false
    /// A write is in flight — every control in the shell disables on it.
    private(set) var busy = false
    private(set) var errorMessage: String?

    /// The week the NEXT fetch asks for. `nil` means "the server's default week", which
    /// is what keeps the everyday case following the calendar forward instead of pinning
    /// whichever week happened to be default when the app launched.
    private(set) var requestedWeek: String?

    /// The step this screen is looking at, or `nil` to follow the session's own pointer.
    /// The iOS stand-in for the web's `/planning/:step`.
    private(set) var askedStep: String?

    /// The session this DEVICE has stepped out of. See `leave()`.
    private(set) var pausedSessionId: String?

    // Precomputed once per load — date math must never run in the render path.
    private(set) var weekLabel = ""
    private(set) var sessionDayName = ""
    /// "Sep 2, 5:32 PM" for the completed record's byline, or nil while there is none.
    private(set) var savedAtLabel: String?
    private(set) var actGroups: [PlanningActGroup] = []
    /// Every runnable step's 1-based position, keyed by step key.
    ///
    /// NOT `PlanningStep.number`: the server sets that from the CATALOG index
    /// (`STEPS.map((s, i) => ({ number: i + 1 }))`), so with a module off it skips —
    /// "4 of 9" with no step 3. The web counts positions off the runnable list and so
    /// does this.
    private(set) var stepNumbers: [String: Int] = [:]

    // The crumb the current step wants kept on the record, and the step that set it.
    //
    // Pairing the two is what makes "a crumb belongs to the step that set it" structural
    // rather than a `.onChange` somebody can forget: a crumb whose owner is no longer on
    // screen simply isn't read. It is only ever PERSISTED when the step is answered, so a
    // step that is used and walked away from loses it — by design.
    private var decisionData: [String: JSONValue]?
    private var decisionStepKey: String?

    // MARK: - Derived

    var steps: [WaffledAPI.PlanningStep] { view?.steps ?? [] }
    /// The steps that actually run — what the counter counts and the sheet lists.
    var runnable: [WaffledAPI.PlanningStep] { PlanningFormat.availableSteps(steps) }
    var session: WaffledAPI.PlanningSession? { view?.session }
    var config: WaffledAPI.WeeklyPlanningConfig? { view?.config }

    var current: WaffledAPI.PlanningStep? { PlanningFormat.resolveCurrent(view, asked: askedStep) }
    var next: WaffledAPI.PlanningStep? {
        guard let key = current?.key else { return nil }
        return PlanningFormat.nextStepAfter(steps, key: key)
    }

    /// 1-based position of the step on screen, or 0 when there isn't one.
    var position: Int { current.flatMap { stepNumbers[$0.key] } ?? 0 }
    /// The 2px hair — POSITION over total, which is what `WeeklyPlanning.tsx` draws.
    ///
    /// Settled-over-available was the other candidate and reads better in isolation, but
    /// the two definitions agree only at the ends of a session: jump ahead from the agenda
    /// sheet and they diverge. A bar that fills differently on the phone than on the kiosk
    /// for the SAME session is worse than either definition, so this matches the web.
    /// (`PlanningFormat.settledFraction` is the other one, and the Today card wants it.)
    var progress: Double { PlanningFormat.hairFraction(steps, currentKey: current?.key) }

    /// The stepper's floor: a week that has already finished cannot be planned.
    var canGoBack: Bool {
        guard let view else { return false }
        return view.weekStart > view.minWeekStart
    }

    /// Every step reads a module that's off (or was turned off by hand) — there is no
    /// session to run.
    var hasNoRunnableSteps: Bool { loaded && view != nil && runnable.isEmpty }

    /// The finished record is the surface. Checked BEFORE the paused screen, as on the
    /// web: a completed session is a receipt whether or not somebody once stepped out.
    ///
    /// `askedStep` overrides it, for the same reason it overrides `isPaused` directly
    /// below: **asking for a step by name is asking to be in the session.** That became
    /// load-bearing when the record started showing the recap read-back, because the
    /// recap's rows are POINTERS — each names the step whose module owns that decision —
    /// and without this they were buttons that did nothing. "Leave for now" clears
    /// `askedStep` again, so the record is still reachable from inside.
    ///
    /// It yields only to a step that can actually RUN. `resolveCurrent` falls back to the
    /// first runnable step when the asked-for one isn't available, so without that guard
    /// following a pointer to a step whose module has since been turned off would leave
    /// the record and silently dump you on step 1 — which looks like the app losing your
    /// place rather than declining to go somewhere that no longer exists.
    var showsRecord: Bool {
        guard session?.isCompleted == true else { return false }
        guard let asked = askedStep else { return true }
        return !runnable.contains { $0.key == asked }
    }

    /// "Left for now": this device stepped out of THIS session and hasn't asked for a
    /// step since. An explicitly-asked-for step overrides it — asking for a step by name
    /// is asking to be in the session.
    var isPaused: Bool {
        guard let session, session.isActive else { return false }
        return pausedSessionId == session.id && askedStep == nil
    }

    /// The steps this session actually decided, for the record.
    var decidedSteps: [WaffledAPI.PlanningStep] { runnable.filter(\.isSettled) }
    var settledCount: Int { decidedSteps.count }

    // MARK: - Loading

    /// Re-read the session view.
    ///
    /// A failure keeps the last good view and still marks the model loaded — the screen
    /// must not blank out because one refresh lost the network.
    func load() async {
        if let latest = try? await fetchView(requestedWeek) {
            apply(latest)
        }
        loaded = true
    }

    private func apply(_ latest: WaffledAPI.WeeklyPlanningView) {
        view = latest
        weekLabel = PlanningFormat.weekLabel(latest.weekStart)
        sessionDayName = PlanningFormat.planningDayName(latest.config.dayOfWeek)
        actGroups = PlanningFormat.stepsByAct(latest.steps)
            .map { PlanningActGroup(act: $0.act, steps: $0.steps) }
        var numbers: [String: Int] = [:]
        for (i, s) in PlanningFormat.availableSteps(latest.steps).enumerated() { numbers[s.key] = i + 1 }
        stepNumbers = numbers
        savedAtLabel = latest.session.flatMap { s in
            s.isCompleted ? Self.savedLabel(s.completedAt ?? s.startedAt) : nil
        }
    }

    /// The bare config plus the SERVER-OWNED catalog (`key/title/ask/primary/act/
    /// requiresModule` — no availability, no status). Cheaper than the full view when
    /// only the day/time is wanted.
    func loadConfigCatalog() async -> WaffledAPI.WeeklyPlanningConfigView? {
        try? await fetchConfig()
    }

    // MARK: - Writes

    /// The web's `go()`: one write at a time, and ALWAYS refetch afterwards — the
    /// server's answer, not the optimistic guess, is what the counter and the agenda
    /// sheet render from.
    private func go(_ work: () async throws -> Void) async {
        guard !busy else { return }
        busy = true
        do {
            try await work()
        } catch {
            errorMessage = APIErrorText.message(
                for: error, fallback: "That didn’t stick. Check your connection and try again.")
        }
        busy = false
        await load()
    }

    func dismissError() { errorMessage = nil }

    /// Start this week's session — or resume the one already there; the route does both.
    func start() async {
        let week = view?.weekStart
        await go {
            let session = try await startSessionCall(week)
            askedStep = session.currentStep
            // Pressing Start is being in the session; a pause recorded for this very
            // session id would otherwise bounce straight back to "Left for now".
            if pausedSessionId == session.id { writePaused(nil) }
        }
    }

    /// Answer the step on screen. Two writes that belong together: record the answer,
    /// then move the driver on — and when there is no next step, the answer IS the save.
    func answer(_ status: String) async {
        guard let session, let step = current else { return }
        let crumb = crumbForCurrentStep
        let following = PlanningFormat.nextStepAfter(steps, key: step.key)
        await go {
            _ = try await decideStepCall(session.id, step.key, status, crumb)
            clearCrumb()
            if let following {
                _ = try await patchSessionCall(session.id, following.key, nil)
                askedStep = following.key
            } else {
                _ = try await completeSessionCall(session.id)
                askedStep = nil
                // The session is finished, so an old "not right now" is stale: without
                // this, reopening the record and then coming back to the feature would
                // land on "Left for now" instead of the session.
                if pausedSessionId == session.id { writePaused(nil) }
            }
        }
    }

    /// Land on a step from the agenda sheet, and move the session's pointer with you so
    /// another device resumes in the same place.
    func jump(to key: String) async {
        askedStep = key
        guard let session else { return }
        await go { _ = try await patchSessionCall(session.id, key, nil) }
    }

    /// SHOW a step without claiming the session moved there.
    ///
    /// The difference from `jump(to:)` is the whole point, and it is not cosmetic:
    /// `jump` is the agenda sheet's gesture and it PATCHes `currentStep`, which is the
    /// cross-DEVICE resume pointer. The recap's rows are links — on the web they are
    /// literally `<Link to="/planning/<step>">`, which changes the address and nothing
    /// else, and the URL-sync effect there leaves a path naming a runnable step alone
    /// ("a pasted link outranks the pointer").
    ///
    /// So following a recap row must not tell the kiosk in the kitchen that the family
    /// went back to step 4. `askedStep` is this device's view; `currentStep` is the
    /// session's.
    func show(_ key: String) {
        askedStep = key
    }

    /// Reopen a saved session. `status` is the only field sent — `currentStep` is omitted
    /// so the server leaves the pointer exactly where the session ended.
    func reopen() async {
        guard let session else { return }
        await go {
            let updated = try await patchSessionCall(session.id, nil, "active")
            askedStep = updated.currentStep
        }
    }

    /// Throw the session away and put the week back to its lobby. What it decided lives
    /// in the modules that own it and stays put.
    func discard() async {
        guard let session else { return }
        await go {
            try await discardSessionCall(session.id)
            askedStep = nil
            clearCrumb()
            writePaused(nil)
        }
    }

    /// Move the stepper. Drops the step: that week has its own session (or none), and
    /// carrying this week's step across would name a step of a different record.
    func goWeek(_ week: String) async {
        askedStep = nil
        clearCrumb()
        // `nil` when it IS the default, so the everyday case keeps following the calendar
        // forward rather than pinning today's default week for the life of the process.
        requestedWeek = (week == view?.defaultWeekStart) ? nil : week
        await load()
    }

    func goPreviousWeek() async {
        guard let view, canGoBack else { return }
        await goWeek(PlanningFormat.addWeeks(view.weekStart, -1))
    }

    func goNextWeek() async {
        guard let view else { return }
        await goWeek(PlanningFormat.addWeeks(view.weekStart, 1))
    }

    // MARK: - Leaving, and coming back

    /// "I've stepped out of this session" — remembered on THIS DEVICE only.
    ///
    /// Opening Planning resumes the active session on purpose: it is what lets another
    /// device pick a session up mid-way. But that also made leaving meaningless — the
    /// button did no more than the tab bar already does. So leaving records the intent.
    ///
    /// **`UserDefaults`, not memory and not the server.** Not memory, because the intent
    /// has to survive leaving the feature and tapping back into it — which is precisely
    /// the gesture it exists to answer, and which throws away every `@State` this screen
    /// owns. Not the server, because "not right now" is one person at one screen, and
    /// writing it to the session row would reach into the very device the resume feature
    /// exists for. The session itself is untouched: still active, still exactly where it
    /// was. The key holds a session id, so a value left behind by a session that has
    /// since been discarded is inert — it can never match again.
    func leave() {
        guard let id = session?.id else { return }
        askedStep = nil
        clearCrumb()
        writePaused(id)
    }

    /// Pick it back up. Drops the pause and lands on the session's own pointer.
    func resume() {
        writePaused(nil)
        askedStep = session?.currentStep
    }

    private static let pausedKey = "waffled.planning.pausedSession"

    private func writePaused(_ id: String?) {
        pausedSessionId = id
        if let id {
            defaults.set(id, forKey: Self.pausedKey)
        } else {
            defaults.removeObject(forKey: Self.pausedKey)
        }
    }

    // MARK: - The step's crumb

    /// `PlanningStepProps.setDecisionData`. Held, never written on its own — see
    /// `decisionData`.
    func setDecisionData(_ data: [String: JSONValue]?) {
        decisionData = data
        decisionStepKey = data == nil ? nil : current?.key
    }

    /// The crumb, but only if the step that set it is still the step on screen.
    var crumbForCurrentStep: [String: JSONValue]? {
        guard let key = current?.key, decisionStepKey == key else { return nil }
        return decisionData
    }

    private func clearCrumb() {
        decisionData = nil
        decisionStepKey = nil
    }

    // MARK: - Parked notes (the shell's handoff banner)

    /// Settle one parked note. Returns true when the server took it, so the banner can
    /// hide the row before the refetch lands — the refetch is what makes it true, this is
    /// what makes it FEEL true.
    ///
    /// A failure leaves the note on screen rather than half-answered; the next refetch is
    /// authoritative either way.
    @discardableResult
    func resolveParked(id: String, action: String) async -> Bool {
        guard let sessionId = session?.id else { return false }
        do {
            try await resolveLooseEndCall("parked", id, action, sessionId)
            await load()
            return true
        } catch {
            return false
        }
    }

    // MARK: - Config (Settings)

    /// Save part of the config. Pass ONLY what changed: `steps` is merged server-side
    /// onto the household's existing opt-out map, so sending a whole map built from this
    /// client's snapshot would clobber every step another device had just turned off.
    func saveConfig(
        dayOfWeek: Int? = nil, time: String? = nil, showOnToday: Bool? = nil, steps: [String: Bool]? = nil
    ) async {
        await go {
            _ = try await saveConfigCall(dayOfWeek, time, showOnToday, steps)
        }
    }

    // MARK: - Formatting

    // `static let`, per the project's formatter rule. Two of them because the server's
    // timestamps carry fractional seconds in some payloads and not others, and a
    // `DateFormatter` that expects one and gets the other returns nil rather than
    // tolerating it.
    private static let isoFractional: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSSXXXXX"
        return f
    }()
    private static let isoPlain: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ssXXXXX"
        return f
    }()

    /// "Sep 2, 5:32 PM" in the device's zone, or the raw string when it parses as
    /// neither — an unrecognized timestamp must cost the prettiness, not the record.
    static func savedLabel(_ iso: String) -> String {
        guard let d = isoFractional.date(from: iso) ?? isoPlain.date(from: iso) else { return iso }
        return DateFmt.localizedString(d, "MMM d, h:mm a", .current)
    }
}
