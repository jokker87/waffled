import Foundation
import Observation

// Weekly Planning · step 7 (Meals) — the step's state, its pure formatting, and the tiny
// store that lets the BODY and the FOOTER share one of them.
//
// Ported from `apps/web/src/kiosk/planning/steps/MealsStep.tsx`.
//
// THE STEP STORES NOTHING OF ITS OWN. Everything on screen is the existing meal plan;
// deciding a night by hand goes through the meal-plan endpoints the Meals screen already
// uses. The only thing the session records is a crumb — which nights the app picked.

// MARK: - Formatting

/// Pure text, built ONCE PER LOAD (see `PlanningMealsModel.rebuildRows`) and looked up by
/// the view — the project's "keep date math out of the render path" rule, which matters
/// most on the two steps that draw seven of something.
enum PlanningMealsText {

    /// "Undo the three" is the design's own phrasing, so small counts read as words.
    static let words = ["none", "one", "two", "three", "four", "five", "six", "seven"]
    static func countWord(_ n: Int) -> String { n >= 0 && n < words.count ? words[n] : String(n) }

    /// "Sun" for a `YYYY-MM-DD`. UTC + POSIX, matching `PlanningFormat`: a week's day is a
    /// calendar LABEL, and parsing it in the device's zone hands back the day before for
    /// anybody west of Greenwich.
    static func dow(_ ymd: String) -> String {
        guard let d = isoDay.date(from: ymd) else { return ymd }
        return shortDay.string(from: d)
    }

    /// "Sep 6".
    static func monthDay(_ ymd: String) -> String {
        guard let d = isoDay.date(from: ymd) else { return ymd }
        return monthDayFmt.string(from: d)
    }

    /// A night's event clock. `allDay` says so; anything else reads in the DEVICE's zone,
    /// because `startsAt` is a real instant (the server sends an ISO timestamp) rather
    /// than a calendar label.
    static func clock(_ e: WaffledAPI.PlanningNightEvent) -> String {
        if e.allDay { return "All day" }
        guard let d = isoInstant.date(from: e.startsAt) ?? isoInstantNoFraction.date(from: e.startsAt) else {
            return ""
        }
        return clockFmt.string(from: d)
    }

    /// The dish tile's attribution line, in order of how much the app actually KNOWS:
    /// who's cooking (real, from `cook_person_id`) → that the app picked the night → that
    /// it is a whole plate → how long the recipe takes → that a takeout night involves no
    /// cooking. The design puts a short free-text note here on some nights ("uses the
    /// beef"), but those are the LLM suggestion's `note` and nothing persists them, so
    /// they are not faked.
    static func attribution(
        _ d: WaffledAPI.PlanningNightDinner, auto: Bool, eatingOut: Bool
    ) -> String? {
        if let cook = d.cookName { return "\(d.cookAvatar ?? "👤") \(cook)" }
        if auto { return "the app picked this" }
        // A plate has no recipe to read a time off, so the honest line is what it IS —
        // several dishes cooked together, not a single dish with unknown timings.
        if d.mealId != nil { return "a whole plate" }
        if let minutes = d.minutes, minutes > 0 { return "\(minutes) min" }
        if eatingOut { return "no cooking" }
        return nil
    }

    /// A PLATE IS NEVER TAKEOUT. `TonightMeal.isEatingOut` reads a recipe-less row's
    /// title, and a plate is recipe-less with the plate's NAME as its title — so a plate
    /// somebody called "Takeout Tuesday" would wear the takeout tile and claim "no
    /// cooking". `recipeId == nil && mealId != nil` is the plate branch, checked first
    /// here exactly as `MealsColumn` checks it on the web.
    static func isEatingOut(_ d: WaffledAPI.PlanningNightDinner) -> Bool {
        guard d.mealId == nil, d.recipeId == nil else { return false }
        return TonightMeal.isEatingOut(d.title)
    }

    /// The shopper pill. Assigned it names the person; planned but unassigned it SAYS so,
    /// because leaving the trip up for grabs is a real answer and not a blank.
    static func tripLabel(_ t: WaffledAPI.PlanningShoppingTrip?) -> String {
        guard let t else { return "Who's shopping?" }
        let when = dow(t.dueOn) + (t.dueTime.map { " \($0)" } ?? "")
        guard let name = t.personName else { return "Up for grabs · \(when)" }
        return "\(t.personAvatar ?? "👤") \(name) shops \(when)"
    }

    /// "two nights were left alone — Fri, Sat have been decided since."
    ///
    /// The undo only takes back what is still untouched, and the copy has to SAY which
    /// nights it walked past — otherwise "Undo the three" quietly becomes an undo of two.
    static func keptSentence(_ dates: [String]) -> String? {
        guard !dates.isEmpty else { return nil }
        let one = dates.count == 1
        return "\(countWord(dates.count)) \(one ? "night was" : "nights were") left alone — "
            + dates.map(dow).joined(separator: ", ")
            + " \(one ? "has" : "have") been decided since."
    }

    /// The grocery sub-line. MEASURED, not claimed: the count before the fill against the
    /// count after — so the line can say what just happened rather than only what is there.
    static func grocerySub(added: Int?) -> String {
        guard let added else { return "built from what's planned so far · staples skipped" }
        return "\(added) items added · staples skipped"
    }

    /// "12 items · aisle order · 3 ticked".
    static func groceryPill(_ g: WaffledAPI.PlanningMealsGroceries) -> String {
        var s = "\(g.items) items · aisle order"
        if g.checked > 0 { s += " · \(g.checked) ticked" }
        return s
    }

    /// The footer's own copy, so the one control's two states live beside each other.
    static func fillTitle(empties: Int) -> String {
        empties == 1
            ? "Fills the one empty night"
            : "Fills the \(countWord(empties)) empty nights"
    }

    // Formatters are `static let` per the project's performance rule — `dow` alone is read
    // seven times a load, and once more per kept night.
    private static let isoDay: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()
    private static let shortDay: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "EEE"
        return f
    }()
    private static let monthDayFmt: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "MMM d"
        return f
    }()
    private static let clockFmt: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "h:mm a"
        return f
    }()
    private static let isoInstant: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoInstantNoFraction = ISO8601DateFormatter()
}

// MARK: - Rows

/// One event, with its clock string already resolved.
struct PlanningMealsEventRow: Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    let clock: String
    let colorHex: String?
}

/// One of the seven nights, with every string the tile needs already built.
struct PlanningMealsNightRow: Identifiable, Equatable, Sendable {
    let date: String
    let dow: String
    let monthDay: String
    let events: [PlanningMealsEventRow]
    let dinner: WaffledAPI.PlanningNightDinner?
    /// ✨ — the app picked this night, either in this session's fill or in an earlier
    /// visit the crumb remembers.
    let auto: Bool
    let eatingOut: Bool
    let attribution: String?

    var id: String { date }
    /// The emoji the tile shows when the plan has none of its own.
    var fallbackEmoji: String { eatingOut ? "🥡" : "🍽️" }
}

// MARK: - Model

@MainActor
@Observable
final class PlanningMealsModel {
    typealias FetchView = (_ weekStart: String, _ choreId: String?) async throws -> WaffledAPI.PlanningMealsView
    typealias Fill = (_ weekStart: String, _ cards: [WaffledAPI.PlanningMealsCard]?) async throws -> WaffledAPI.PlanningMealsFill
    typealias Undo = (_ weekStart: String, _ filled: [WaffledAPI.PlanningFilledNight]) async throws -> WaffledAPI.PlanningMealsUndo
    typealias SetShopper = (
        _ weekStart: String, _ dueOn: String?, _ personId: String?, _ dueTime: String?, _ choreId: String?
    ) async throws -> WaffledAPI.PlanningMealsShopperResult
    /// A night decided by hand — the SAME `POST /api/meals/plan` the Meals screen uses.
    typealias PlanSlot = (_ date: String, _ recipeId: String?, _ title: String?) async throws -> Void
    /// A night decided as a PLATE. It cannot go through `planSlot`: scheduling a saved
    /// plate COPIES it (`POST /api/meals/:id/schedule`), which is what keeps editing next
    /// week's "BBQ Sunday" from rewriting the one that already went out.
    typealias PlanPlate = (_ date: String, _ mealId: String) async throws -> Void
    typealias ClearSlot = (_ date: String) async throws -> Void

    private(set) var view: WaffledAPI.PlanningMealsView?
    private(set) var loaded = false
    /// A write of this step's own is in flight. ONE AT A TIME — the fill, the undo, the
    /// shopper and a hand-picked night all move the same week.
    private(set) var busy = false
    /// Settable so `DismissibleErrorBanner`'s ✕ can clear it.
    var errorMessage: String?

    /// The auto-filled nights that are STILL undoable, each carrying the proof the server
    /// checks — the fill's own receipt.
    ///
    /// ONLY A FILL MAY PUT SOMETHING HERE. It is tempting to rebuild these from the
    /// session crumb on a revisit, but a claim rebuilt from the current view proves
    /// nothing: it would be compared against the very row it was read from, so the guard
    /// would always pass and "Undo the three" would happily clear a night somebody had
    /// deliberately changed in the meantime.
    private(set) var filled: [WaffledAPI.PlanningFilledNight] = []
    /// Display only: nights the crumb says were auto-filled at some point. They keep their
    /// ✨ across a revisit; they do NOT make the undo live.
    private(set) var autoMarks: [String] = []
    /// "…and one night was left alone" after an undo that hit a since-decided night.
    private(set) var kept: [String] = []
    /// How many rows the last fill put on the grocery list. Measured — the item count
    /// before the fill against the count after.
    private(set) var groceryAdded: Int?

    /// Every string the seven tiles need, rebuilt on each applied view and on every change
    /// to the ✨ set. Never recomputed in the render path.
    private(set) var rows: [PlanningMealsNightRow] = []
    /// Bumped whenever the crumb could have changed, so the body pushes it on one
    /// `onChange` rather than after each call site.
    private(set) var rev = 0

    private let fetchView: FetchView
    private let fill: Fill
    private let undo: Undo
    private let setShopperFn: SetShopper
    private let planSlot: PlanSlot
    private let planPlate: PlanPlate
    private let clearSlot: ClearSlot

    init(
        fetchView: @escaping FetchView = { weekStart, choreId in
            try await WaffledAPI().planningMeals(weekStart: weekStart, choreId: choreId)
        },
        fill: @escaping Fill = { weekStart, cards in
            try await WaffledAPI().planningMealsFill(weekStart: weekStart, cards: cards)
        },
        undo: @escaping Undo = { weekStart, filled in
            try await WaffledAPI().planningMealsUndo(weekStart: weekStart, filled: filled)
        },
        setShopper: @escaping SetShopper = { weekStart, dueOn, personId, dueTime, choreId in
            try await WaffledAPI().planningMealsSetShopper(
                weekStart: weekStart, dueOn: dueOn, personId: personId,
                dueTime: dueTime, choreId: choreId)
        },
        planSlot: @escaping PlanSlot = { date, recipeId, title in
            try await WaffledAPI().planMeal(
                date: date, mealType: PlanningMealsModel.mealType, recipeId: recipeId, title: title)
        },
        planPlate: @escaping PlanPlate = { date, mealId in
            _ = try await WaffledAPI().scheduleMeal(
                id: mealId, date: date, mealType: PlanningMealsModel.mealType)
        },
        clearSlot: @escaping ClearSlot = { date in
            try await WaffledAPI().clearMeal(date: date, mealType: PlanningMealsModel.mealType)
        }
    ) {
        self.fetchView = fetchView
        self.fill = fill
        self.undo = undo
        self.setShopperFn = setShopper
        self.planSlot = planSlot
        self.planPlate = planPlate
        self.clearSlot = clearSlot
    }

    /// The step plans DINNERS. Breakfast and lunch belong to the Meals screen — a session
    /// step that asked about twenty-one slots would be a spreadsheet, not a decision.
    static let mealType = "dinner"

    // MARK: Derived

    /// The nights wearing a ✨, whether it came from this session's fill or from the crumb
    /// of an earlier visit. The mark says "the app picked this", which stays true.
    var autoDates: Set<String> { Set(filled.map(\.date)).union(autoMarks) }

    var emptyDates: [String] { view?.emptyDates ?? [] }

    /// The crumb the session record keeps: WHICH NIGHTS THE APP PICKED, dates only.
    ///
    /// `nil` when there are none — matching the web exactly (`dates.length ? {…} : null`),
    /// because the affirmative REPLACES the step's stored data and an empty list is a
    /// claim rather than an absence. The recap reads the plan itself, so a copy of the
    /// dishes here could only ever disagree with it.
    var crumb: [String: JSONValue]? {
        let dates = autoDates.sorted()
        guard !dates.isEmpty else { return nil }
        return ["autoFilled": .array(dates.map(JSONValue.string))]
    }

    /// The chore id the view last saw — passed back on every read and every shopper write,
    /// which is what keeps a chore renamed on the Tasks board recognised as this week's
    /// trip instead of spawning a second one.
    var choreHint: String? { view?.shopping?.choreId }

    func dismissError() { errorMessage = nil }

    // MARK: Reads

    /// Arriving on the step. A FIRST visit reads; coming back to the same session and week
    /// re-reads, so the columns show what the week is now rather than what it was when you
    /// left. `seed` is the crumb's dates — see `autoMarks`.
    func enter(weekStart: String, seed: [String]) async {
        if loaded { await reread(weekStart: weekStart) } else { await load(weekStart: weekStart, seed: seed) }
    }

    /// The first read. A FAILED fetch still sets `loaded` (the loading contract in
    /// `Features/Shared/RestDomain.swift`) so the step says what went wrong rather than
    /// spinning forever.
    func load(weekStart: String, seed: [String]) async {
        do {
            let fresh = try await fetchView(weekStart, nil)
            // The crumb restores the MARKS (a night that is still planned), never the
            // undo: see `filled` for why a rebuilt claim cannot be trusted.
            let stillPlanned = Set(fresh.nights.filter { $0.dinner != nil }.map(\.date))
            autoMarks = seed.filter { stillPlanned.contains($0) }
            apply(fresh)
        } catch {
            if view == nil {
                errorMessage = "Couldn’t read this week’s meals — reload and try again."
            }
        }
        loaded = true
    }

    /// Re-read the columns. A failure leaves them exactly as they were.
    func reread(weekStart: String) async {
        if let fresh = try? await fetchView(weekStart, choreHint) { apply(fresh) }
    }

    // MARK: The two writes the footer drives

    /// "Plan the rest for me". Returns true when something was actually written, so the
    /// caller knows whether to tell the shell.
    ///
    /// THE CARDS ARE ABSENT ON iOS, and that is the endpoint's documented headless path —
    /// the server drafts the empty nights itself. The web hands over a week the family
    /// approved in the shared "Plan my week" planner; that planner (`PlanWeekSheet`)
    /// applies its own cards through `SyncManager.setMealPlan` and has no hook to hand
    /// them here, so wiring it up would mean editing a file this step does not own. Note
    /// the three-way rule in `PlanningMealsWire.fillBody`: `nil` here means the KEY IS
    /// ABSENT, never a null.
    @discardableResult
    func planTheRest(weekStart: String, cards: [WaffledAPI.PlanningMealsCard]? = nil) async -> Bool {
        // Bailing out quietly would report a week that was never written. Another write in
        // flight is the only way here, and it has to SAY so.
        guard !busy else {
            errorMessage = "Something else was still saving — the week wasn’t planned. Try again."
            return false
        }
        busy = true
        errorMessage = nil
        kept = []
        let before = view?.groceries?.items
        defer { busy = false }
        do {
            let r = try await fill(weekStart, cards)
            let fresh = Set(r.filled.map(\.date))
            let after = r.view.groceries?.items
            // Explicitly `Int?`: the item count is only knowable when the lists module was
            // on for BOTH reads, and "we don't know" is not the same claim as "0 added".
            let added: Int? = (before != nil && after != nil) ? after! - before! : nil
            filled = (filled.filter { !fresh.contains($0.date) } + r.filled)
                .sorted { $0.date < $1.date }
            // These nights now carry a live receipt, so they don't need the restored mark.
            autoMarks = autoMarks.filter { !fresh.contains($0) }
            groceryAdded = (!r.filled.isEmpty && (added ?? 0) > 0) ? added : nil
            apply(r.view)
            return true
        } catch {
            errorMessage = "That didn’t take — try again."
            return false
        }
    }

    /// "Undo the three." Only clears what is still untouched: a night somebody has decided
    /// since comes back in `kept`, leaves the undoable set WITHOUT being cleared, and the
    /// copy says so.
    @discardableResult
    func undoTheFill(weekStart: String) async -> Bool {
        guard !busy, !filled.isEmpty else { return false }
        busy = true
        errorMessage = nil
        kept = []
        groceryAdded = nil
        defer { busy = false }
        do {
            let r = try await undo(weekStart, filled)
            // A night in `kept` was decided by hand since the fill — it is no longer an
            // auto-fill, so it leaves the undoable set without being cleared.
            let settled = Set(r.cleared).union(r.kept)
            kept = r.kept
            filled = filled.filter { !settled.contains($0.date) }
            autoMarks = autoMarks.filter { !settled.contains($0) }
            apply(r.view)
            return true
        } catch {
            errorMessage = "That didn’t take — try again."
            return false
        }
    }

    // MARK: A night, decided by hand

    /// Deciding a night by hand also stops it being an auto-fill — in the live receipt AND
    /// in the restored marks.
    @discardableResult
    func planNight(weekStart: String, date: String, recipeId: String?, title: String?) async -> Bool {
        await handWrite(weekStart: weekStart, date: date, failure: "that night wasn’t planned") {
            try await self.planSlot(date, recipeId, title)
        }
    }

    @discardableResult
    func planNightAsPlate(weekStart: String, date: String, mealId: String) async -> Bool {
        await handWrite(weekStart: weekStart, date: date, failure: "that night wasn’t planned") {
            try await self.planPlate(date, mealId)
        }
    }

    @discardableResult
    func clearNight(weekStart: String, date: String) async -> Bool {
        await handWrite(weekStart: weekStart, date: date, failure: "that night wasn’t cleared") {
            try await self.clearSlot(date)
        }
    }

    /// Assign the shopping trip, move it, hand it over, or clear it with `dueOn: nil` —
    /// the same call every way, because a trip has to be undoable.
    ///
    /// A FAILED WRITE DOES NOT REFETCH AND DOES NOT MUTATE: the trip stays exactly as it
    /// was rather than being replaced by a half-applied one.
    @discardableResult
    func setShopper(
        weekStart: String, dueOn: String?, personId: String?, dueTime: String?
    ) async -> Bool {
        guard !busy else {
            errorMessage = "Something else was still saving — the trip wasn’t changed. Try again."
            return false
        }
        busy = true
        errorMessage = nil
        defer { busy = false }
        do {
            let r = try await setShopperFn(weekStart, dueOn, personId, dueTime, choreHint)
            apply(r.view)
            return true
        } catch let WaffledAPI.APIError.http(code, _) where code == 401 || code == 403 {
            errorMessage = "Only a parent can hand the shopping to somebody else."
            return false
        } catch {
            errorMessage = "That didn’t take — the trip stayed as it was."
            return false
        }
    }

    // MARK: - Internals

    /// The three by-hand writes are the same shape: refuse while busy (with a message —
    /// the picker has already closed by the time this runs, so a quiet return would report
    /// a night that was never planned), write, forget the ✨, then re-read.
    private func handWrite(
        weekStart: String, date: String, failure: String, _ work: () async throws -> Void
    ) async -> Bool {
        guard !busy else {
            errorMessage = "Something else was still saving — \(failure). Try again."
            return false
        }
        busy = true
        errorMessage = nil
        defer { busy = false }
        do {
            try await work()
        } catch {
            errorMessage = "That didn’t take — try again."
            return false
        }
        filled.removeAll { $0.date == date }
        autoMarks.removeAll { $0 == date }
        kept = []
        groceryAdded = nil
        // FORGETTING THE ✨ IS ITSELF A CHANGE, so it lands before the re-read rather than
        // riding on it. A re-read that fails keeps the previous view (the loading contract)
        // and would otherwise leave the tile still saying "the app picked this" about a
        // night somebody just decided — and, worse, leave `autoFilled` naming it in the
        // crumb, because nothing bumped `rev` for the body to push.
        rebuildRows()
        rev += 1
        await reread(weekStart: weekStart)
        return true
    }

    private func apply(_ fresh: WaffledAPI.PlanningMealsView) {
        view = fresh
        rebuildRows()
        rev += 1
    }

    /// Every per-night string, built once. `auto` is folded in here rather than passed to
    /// the tile because it changes the ATTRIBUTION line ("the app picked this"), and a
    /// view that recomputed that per render would be doing the date work seven times a
    /// frame.
    private func rebuildRows() {
        guard let view else { rows = []; return }
        let auto = autoDates
        rows = view.nights.map { night in
            let dinner = night.dinner
            let out = dinner.map(PlanningMealsText.isEatingOut) ?? false
            let isAuto = auto.contains(night.date)
            return PlanningMealsNightRow(
                date: night.date,
                dow: PlanningMealsText.dow(night.date),
                monthDay: PlanningMealsText.monthDay(night.date),
                events: night.events.map {
                    PlanningMealsEventRow(
                        id: $0.id, title: $0.title,
                        clock: PlanningMealsText.clock($0), colorHex: $0.personColor)
                },
                dinner: dinner,
                auto: isAuto,
                eatingOut: out,
                attribution: dinner.flatMap {
                    PlanningMealsText.attribution($0, auto: isAuto, eatingOut: out)
                })
        }
    }
}

// MARK: - The store the body and the footer share

/// WHY THIS EXISTS. The shell renders the step's BODY (`MealsStepView`) and its FOOTER
/// control (`MealsStepFooterExtra`) as two sibling trees, built from separate calls — and
/// the footer's fill is what puts the ✨ on the body's nights and what the body's
/// "…nights were left alone" note reports. A `@State` model in either view is invisible to
/// the other, and threading one through would mean editing `PlanningStepSeam.swift`, which
/// this step does not own. So the model lives here, module-scoped, exactly as the web's
/// `MealsStep.tsx` keeps its store module-scoped for the same reason.
///
/// KEYED BY SESSION + WEEK, and ONE AT A TIME: asking for a different key replaces the
/// model rather than accumulating them, so stepping to another week (or discarding the
/// session) cannot leave a previous week's ✨ marks — or a previous week's undo receipt —
/// behind. That single-slot rule is also why this leaks nothing.
///
/// DELIBERATELY NOT `@Observable`. Nothing observes the STORE — both views observe the
/// `PlanningMealsModel` it hands back, and SwiftUI installs observation tracking around
/// `body` regardless of whether an object arrived in `@State`. Keeping the store inert
/// means resolving a model during `body` cannot be a "modifying state during view update"
/// write.
@MainActor
final class PlanningMealsStepStore {
    static let shared = PlanningMealsStepStore()

    private var key = ""
    private var model: PlanningMealsModel?

    /// The one place the key is spelled, so the body and the footer cannot disagree about
    /// which model they are on.
    static func key(sessionId: String, weekStart: String) -> String { "\(sessionId)|\(weekStart)" }

    /// The model for this session + week, creating (or replacing) it as the key changes.
    /// `make` is the test seam: a suite can hand in a model with stubbed closures.
    func model(
        sessionId: String, weekStart: String,
        // `@MainActor` on the closure TYPE, not just the method: a default-argument
        // expression is evaluated in a non-isolated context, so an un-annotated closure
        // cannot call this model's main-actor-isolated init.
        make: @MainActor () -> PlanningMealsModel = { PlanningMealsModel() }
    ) -> PlanningMealsModel {
        let wanted = Self.key(sessionId: sessionId, weekStart: weekStart)
        if key == wanted, let model { return model }
        let fresh = make()
        key = wanted
        model = fresh
        return fresh
    }

    /// Drop whatever is held — for tests, which must not inherit the previous case's week.
    func reset() {
        key = ""
        model = nil
    }
}

/// The crumb, read back defensively. Anything in `step.data` is somebody else's shape by
/// the time it comes back, so it is filtered rather than trusted.
enum PlanningMealsCrumb {
    static func dates(_ data: [String: JSONValue]?) -> [String] {
        guard case let .array(raw)? = data?["autoFilled"] else { return [] }
        return raw.compactMap { value in
            guard case let .string(s) = value, isDay(s) else { return nil }
            return s
        }
    }

    /// `YYYY-MM-DD` and nothing else.
    private static func isDay(_ s: String) -> Bool {
        s.count == 10
            && s.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", options: .regularExpression) != nil
    }
}
