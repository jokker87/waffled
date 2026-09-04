import CoreTransferable
import Foundation
import Observation
import UniformTypeIdentifiers

// Weekly Planning · step 8 (Tasks) — the step's model and its pure formatting.
//
// Ported from `apps/web/src/kiosk/planning/steps/TasksStep.tsx`.
//
// A COLUMN IS THE WEEK, NOT THE SITTING. Its contents come from the server read — what
// that person is carrying for the week being planned — never from local "what I just
// moved" state, so a refresh, a remount or the iPad picking up where the phone left off
// all show the same board. Handing a chore out therefore re-reads rather than
// bookkeeping in the view.
//
// The unit is the chore DEFINITION, not the day's instance: the session plans a week,
// and an instance is one day. Every write is an EXISTING chores endpoint, so this step
// writes nothing of its own.

// MARK: - Formatting

/// Pure strings, built ONCE PER LOAD (see `PlanningTasksModel.apply`) and looked up O(1)
/// by the view — the project's "keep date math out of the render path" rule.
enum PlanningTasksFormat {

    /// "9am", "9:30am" — the day chip is a glance, not a schedule.
    static func shortTime(_ hhmm: String?) -> String {
        guard let hhmm else { return "" }
        let parts = hhmm.split(separator: ":")
        guard parts.count == 2, let h = Int(parts[0]), let m = Int(parts[1]) else { return "" }
        let ampm = h < 12 ? "am" : "pm"
        let h12 = h % 12 == 0 ? 12 : h % 12
        return m == 0 ? "\(h12)\(ampm)" : "\(h12):\(String(format: "%02d", m))\(ampm)"
    }

    /// When this chore lands, in as few words as the chip can hold. EVERY BRANCH IS A
    /// FACT THE SERVER HANDED US — nothing here guesses a day.
    static func dayChip(_ c: WaffledAPI.PlanningTasksChore) -> String {
        let time = shortTime(c.dueTime)
        func withTime(_ s: String) -> String { time.isEmpty ? s : "\(s) \(time)" }
        if c.carriedOver { return withTime("Carried over") }
        if c.days.count >= 7 { return withTime("Every day") }
        if !c.days.isEmpty { return withTime(c.days.map(weekdayOf).joined(separator: ", ")) }
        // A one-off whose date is outside the week still says which day it is for.
        if let dueOn = c.dueOn { return withTime(monthDay(dueOn)) }
        return "No day set"
    }

    /// Where a card came from, as far as the chores module can honestly say.
    static func provenance(_ c: WaffledAPI.PlanningTasksChore) -> String {
        if c.carriedOver { return "Left over from before this week" }
        return c.cadence == "once" ? "One-off task" : "Recurring chore"
    }

    /// The fairness read, stated rather than scored.
    static func carriesLabel(_ n: Int) -> String {
        n == 0 ? "No recurring chores yet" : "Carries \(n) recurring chore\(n == 1 ? "" : "s")"
    }

    /// A one-off's day can be moved; a recurring chore's days come from its rrule and
    /// belong to the chore editor, not to a chip on a board.
    static func dayIsSettable(_ c: WaffledAPI.PlanningTasksChore) -> Bool { c.cadence == "once" }

    /// A card with no day at all — an invitation when it can be set, and a calm
    /// statement of fact when it can't.
    static func dayIsUnset(_ c: WaffledAPI.PlanningTasksChore) -> Bool {
        c.days.isEmpty && c.dueOn == nil && !c.carriedOver
    }

    // UTC on both, matching the server: a `days` entry is a calendar label, and parsing
    // it in the device's zone lands a chore on the day before for anyone west of UTC.
    static func weekdayOf(_ iso: String) -> String {
        guard let d = isoDay.date(from: iso) else { return iso }
        return shortDay.string(from: d)
    }
    static func monthDay(_ iso: String) -> String {
        guard let d = isoDay.date(from: iso) else { return iso }
        return monthDayFmt.string(from: d)
    }

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
}

// MARK: - Dragging a card onto a person

/// Where a card sits, in the SAME two-way vocabulary the web uses for its `data-colkey`
/// (`'unassigned'` + a person id) and the Chores board uses for its columns. A drop
/// target names one of these, and so does the place a card came from — which is what
/// makes "did this drop actually move anything?" a comparison rather than a special case.
enum PlanningTaskColumn: Hashable {
    case upForGrabs
    case person(String)
}

/// The custom drag payload for handing a task out by dragging it.
///
/// A `.draggable(String)` payload is offered to EVERY text field in the app, so the
/// dragged id gets pasted into whatever the finger lands near — this bit us on the recipe
/// ingredient rows. A private UTType conforming to `public.data` (**not** `public.text`,
/// and declared in `project.yml` under `UTExportedTypeDeclarations`) means only this
/// step's drop targets will take it.
extension UTType {
    static let waffledPlanningTask = UTType(exportedAs: "app.waffled.planning-task")
}

/// IT CARRIES AN ID AND NOTHING ELSE — deliberately. The chore, and above all *who has
/// it*, are read back off the current board at drop time (`PlanningTasksModel.drop`): a
/// column is the week and the server owns it, so a payload minted at drag start and
/// resolved a re-read later must not be the authority on anything.
struct PlanningTaskDrag: Transferable, Codable {
    let choreId: String

    static var transferRepresentation: some TransferRepresentation {
        CodableRepresentation(contentType: .waffledPlanningTask)
    }
}

// MARK: - Model

@MainActor
@Observable
final class PlanningTasksModel {
    /// Every network op injected as a closure with a `WaffledAPI()`-backed default.
    typealias FetchBoard = (_ weekStart: String) async throws -> WaffledAPI.PlanningTasksBoard
    /// Hand a chore over, or take it back with `nil`. The default composes the two
    /// chores endpoints — the PATCH **and** an assign for every open instance.
    typealias HandOut = (_ chore: WaffledAPI.PlanningTasksChore, _ personId: String?) async throws -> Void
    /// Save a chore from the app's own editor: `nil` id creates, an id edits.
    typealias SaveChore = (_ choreId: String?, _ body: [String: JSONValue]) async throws -> Void

    /// What the chore editor is open on. `.add(personId: nil)` is the strip's own
    /// "Add a task" — nobody prefilled, which is not the same as adding to a column.
    enum Composer: Identifiable {
        case add(personId: String?, note: String?)
        case edit(chore: WaffledAPI.PlanningTasksChore, owner: String?)

        var id: String {
            switch self {
            case let .add(personId, _): return "add:\(personId ?? "")"
            case let .edit(chore, _):   return "edit:\(chore.id)"
            }
        }
    }

    private(set) var board: WaffledAPI.PlanningTasksBoard?
    private(set) var loaded = false
    /// The chore id currently being handed over — one at a time, and the card says so.
    private(set) var savingChoreId: String?
    /// The NET number of chores this sitting handed over. The only thing worth
    /// remembering locally, because the board itself can no longer tell you what moved
    /// today. A take-back undoes its own tally, or the recap would over-report.
    private(set) var assigned = 0
    /// Bumped on every applied board, so the view knows when to re-hand the shell its crumb.
    private(set) var rev = 0
    /// Settable so `DismissibleErrorBanner`'s ✕ can clear it.
    var errorMessage: String?

    private(set) var composer: Composer?
    /// True once the open composer actually SAVED something — read on dismissal, which
    /// fires for a cancel and a save alike.
    private var composerSaved = false
    /// The parked note this composer was opened for, and the shell's completion. Held on
    /// the MODEL rather than in view `@State` because the lent verb's closure is captured
    /// by the shell: a struct `View`'s captured `self` reads stale state, an
    /// `@Observable` never does.
    private var handoffDone: ((Bool) -> Void)?

    // Derived once per load — never recomputed in the render path.
    private(set) var dayChip: [String: String] = [:]
    private(set) var provenance: [String: String] = [:]
    private(set) var daySettable: [String: Bool] = [:]
    private(set) var dayUnset: [String: Bool] = [:]
    private(set) var carries: [String: String] = [:]

    private let fetchBoard: FetchBoard
    private let handOut: HandOut
    private let saveChore: SaveChore

    init(
        fetchBoard: @escaping FetchBoard = { weekStart in
            try await WaffledAPI().planningTasksBoard(weekStart: weekStart)
        },
        handOut: @escaping HandOut = { chore, personId in
            try await WaffledAPI().planningHandOutChore(chore, to: personId)
        },
        saveChore: @escaping SaveChore = { choreId, body in
            let api = WaffledAPI()
            if let choreId { try await api.updateChore(id: choreId, body) }
            else { try await api.createChore(body) }
        }
    ) {
        self.fetchBoard = fetchBoard
        self.handOut = handOut
        self.saveChore = saveChore
    }

    /// The crumb kept on the session record: COUNTS ONLY. The recap reads through to
    /// chores for the detail, so copying chore rows here would just let the two disagree.
    var crumb: [String: JSONValue] {
        ["assigned": .int(assigned),
         "leftUpForGrabs": .int(board?.unassigned.count ?? 0)]
    }

    /// The day a task added during this session lands on — server-owned, so adding a task
    /// on a Wednesday while planning next week can't quietly date it to that Wednesday.
    var newTaskDay: String? { board?.newTaskDay }

    /// Read the board. A FAILED fetch keeps whatever was already on screen but still
    /// counts as loaded.
    func load(weekStart: String) async {
        do {
            apply(try await fetchBoard(weekStart))
        } catch {
            if board == nil {
                errorMessage = "Couldn't load the chores board — try again in a moment."
            }
        }
        loaded = true
    }

    /// Move a chore to a person, or (nil) back up for grabs. ONE path for the face row
    /// and the 🙌, so a hand-out can never do something a take-back can't undo.
    ///
    /// Returns true when it landed, so the caller knows whether to tell the shell.
    /// A FAILED HAND-OUT DOES NOT REFETCH AND DOES NOT MUTATE — nothing moved, so the
    /// chore stays exactly where it was and the tally is untouched.
    @discardableResult
    func give(_ chore: WaffledAPI.PlanningTasksChore, to personId: String?, weekStart: String) async -> Bool {
        guard savingChoreId == nil else { return false }
        savingChoreId = chore.id
        errorMessage = nil
        defer { savingChoreId = nil }
        do {
            try await handOut(chore, personId)
        } catch {
            errorMessage = "That didn't take — the task stayed where it was."
            return false
        }
        assigned = personId != nil ? assigned + 1 : max(0, assigned - 1)
        // Re-read rather than bookkeeping: the column is the week, and the server owns it.
        if let fresh = try? await fetchBoard(weekStart) { apply(fresh) }
        return true
    }

    // MARK: Dragging a card onto a person

    /// Which column a card sits in RIGHT NOW, or nil when the board no longer has it.
    ///
    /// The board is the only authority here — the drag payload carries an id, not an
    /// owner, so a re-read landing mid-drag can't leave a drop acting on a stale idea of
    /// who had the task.
    func column(ofChore choreId: String) -> PlanningTaskColumn? { located(choreId)?.column }

    /// A card was dropped on a column. THE THIRD CALLER OF `give`, not a fourth write
    /// path — dragging has to be undoable by exactly the same means as tapping a face.
    ///
    /// Two gestures resolve to nothing and must not spend a write:
    ///
    ///  * **A card dropped where it already sits.** `give` tallies unconditionally, so
    ///    letting this through would both PATCH the chore to the name it already has and
    ///    inflate `assigned` — the crumb the recap reports — for a move that never
    ///    happened.
    ///  * **A card the board no longer holds** (deleted mid-drag, or a payload minted
    ///    against a board this step has since replaced). There is nothing to PATCH, and
    ///    guessing would move the wrong task.
    ///
    /// Returns true only when a write really landed, so the caller knows whether to tell
    /// the shell. The DROP ITSELF still succeeds either way — see the view: a harmless
    /// gesture is not an error, and bouncing the card back reads like one.
    @discardableResult
    func drop(choreId: String, onto column: PlanningTaskColumn, weekStart: String) async -> Bool {
        guard let found = located(choreId), found.column != column else { return false }
        switch column {
        case .upForGrabs:            return await give(found.chore, to: nil, weekStart: weekStart)
        case let .person(personId):  return await give(found.chore, to: personId, weekStart: weekStart)
        }
    }

    /// The card AND the column it sits in, in one pass — "is it still here?" and "where
    /// did it come from?" are the same question asked of the same two collections, and a
    /// drop needs both answers to agree with each other.
    private func located(_ choreId: String)
        -> (chore: WaffledAPI.PlanningTasksChore, column: PlanningTaskColumn)? {
        if let hit = board?.unassigned.first(where: { $0.id == choreId }) { return (hit, .upForGrabs) }
        for person in board?.people ?? [] {
            if let hit = person.chores.first(where: { $0.id == choreId }) {
                return (hit, .person(person.id))
            }
        }
        return nil
    }

    // MARK: The chore editor

    func openAdd(personId: String?) {
        composerSaved = false
        composer = .add(personId: personId, note: nil)
    }

    func openEdit(_ chore: WaffledAPI.PlanningTasksChore, owner: String?) {
        composerSaved = false
        composer = .edit(chore: chore, owner: owner)
    }

    /// The shell's parked-note banner lent this step a verb. Open the app's OWN chore
    /// editor seeded with the note's words — the banner grows no composer of its own,
    /// which is what keeps one way to add a chore in this app.
    func beginHandoff(note: String, done: @escaping (Bool) -> Void) {
        // A second note arriving while one is still open must not strand the first
        // completion — report it unfinished, because it genuinely is.
        handoffDone?(false)
        handoffDone = done
        composerSaved = false
        composer = .add(personId: nil, note: note)
    }

    /// Persist whatever the editor built. Returns nil on success, else the message the
    /// sheet shows in place (so a failed save keeps the sheet open instead of dismissing
    /// on a silent failure).
    func saveFromComposer(choreId: String?, body: [String: JSONValue]) async -> String? {
        do {
            try await saveChore(choreId, body)
            composerSaved = true
            return nil
        } catch let WaffledAPI.APIError.http(code, _) where code == 401 || code == 403 {
            return "Only a parent can add or edit tasks. Switch to a parent to make changes."
        } catch {
            return "Couldn't save this task — please try again."
        }
    }

    /// The editor closed. Reports the handoff honestly: A CANCELLED COMPOSER REPORTS
    /// `false`, because settling the note would throw away the only record that the thing
    /// still needs doing — on the strength of somebody having opened a box and closed it
    /// again. Returns true when something was really created or edited, so the caller
    /// knows to re-read.
    @discardableResult
    func composerDismissed() -> Bool {
        let saved = composerSaved
        composerSaved = false
        composer = nil
        if let done = handoffDone {
            handoffDone = nil
            done(saved)
        }
        return saved
    }

    /// Withdraw a still-open handoff when the step goes away — the note is unfinished,
    /// and the banner must be told so rather than left waiting on a completion that will
    /// never come.
    func abandonHandoff() {
        if let done = handoffDone {
            handoffDone = nil
            done(false)
        }
    }

    private func apply(_ fresh: WaffledAPI.PlanningTasksBoard) {
        board = fresh
        var chips: [String: String] = [:]
        var prov: [String: String] = [:]
        var settable: [String: Bool] = [:]
        var unset: [String: Bool] = [:]
        var carried: [String: String] = [:]
        func index(_ c: WaffledAPI.PlanningTasksChore) {
            chips[c.id] = PlanningTasksFormat.dayChip(c)
            prov[c.id] = PlanningTasksFormat.provenance(c)
            settable[c.id] = PlanningTasksFormat.dayIsSettable(c)
            unset[c.id] = PlanningTasksFormat.dayIsUnset(c)
        }
        for c in fresh.unassigned { index(c) }
        for p in fresh.people {
            carried[p.id] = PlanningTasksFormat.carriesLabel(p.recurringChores)
            for c in p.chores { index(c) }
        }
        dayChip = chips
        provenance = prov
        daySettable = settable
        dayUnset = unset
        carries = carried
        rev += 1
    }
}

// MARK: - Bridging a board card into the app's chore editor

extension WaffledAPI.PlanningTasksChore {
    /// The app's `ChoreEditSheet` edits a `WaffledAPI.ChoreInstanceDTO`, which has no
    /// memberwise initializer (a custom `init(from:)` suppresses it) and lives in a file
    /// this step does not own. So the card is re-encoded and decoded through the same
    /// `WaffledAPI.decoder` the network path uses — one editor for the whole app, and no
    /// edit to a shared file.
    ///
    /// `owner` is the column the card sits in: a chore's "Who" is not on the board
    /// payload, and the column IS that fact.
    ///
    /// `rewardAmount` is written as an **int**. The DTO decodes it with
    /// `(try? decode(Int.self)) ?? 0`, so encoding a `.double` would silently decode as
    /// zero — and the editor would open showing no stars, then wipe the reward on Save.
    ///
    /// `requiresApproval` / `requiresPhoto` are carried for the same reason the server
    /// bothers to send them: the editor reads a missing flag as false, so leaving them
    /// out would quietly switch approval (or photo proof) off the first time anybody
    /// fixed a typo here.
    func asChoreInstance(owner: String?) -> WaffledAPI.ChoreInstanceDTO? {
        var fields: [String: JSONValue] = [
            // No instance is involved — a card is a DEFINITION — so the id is the
            // chore's own. It is only ever read back as the editor's identity.
            "id": .string(id),
            "choreId": .string(id),
            "choreTitle": .string(title),
            "status": .string("pending"),
            "personId": owner.map(JSONValue.string) ?? .null,
            "rewardAmount": .int(Int(rewardAmount.rounded())),
            "requiresApproval": .bool(requiresApproval),
            "requiresPhoto": .bool(requiresPhoto),
            "streak": .int(0),
            "hadProof": .bool(false),
        ]
        if let emoji { fields["emoji"] = .string(emoji) }
        if let rrule { fields["rrule"] = .string(rrule) }
        // The day the editor opens on, so tapping the chip lands on the day the card was
        // showing. Omitting it would silently move the chore to today.
        if let dueOn { fields["dueOn"] = .string(dueOn) }
        if let dueTime { fields["dueTime"] = .string(dueTime) }
        if let rewardCurrency { fields["rewardCurrency"] = .string(rewardCurrency) }
        guard let data = try? JSONEncoder().encode(fields) else { return nil }
        return try? WaffledAPI.decoder.decode(WaffledAPI.ChoreInstanceDTO.self, from: data)
    }
}
