import Foundation
import Observation

/// Weekly Planning · step 9 "Kids" — the step's state, with no view in it.
///
/// Every network op is an injected closure with a `WaffledAPI()`-backed default (the test
/// seam this project uses everywhere — see `FamilyNightModel`), so `PlanningKidsStepTests`
/// drives the whole step, drafts included, without a server.
///
/// THE LOADING CONTRACT (`Features/Shared/RestDomain.swift`): a FAILED fetch keeps the
/// previous value and still sets `loaded`; a failed write does not refetch and does not
/// mutate. The answers here are a REAL write, never `setDecisionData` — the crumb only
/// reaches the server when the step is ANSWERED, so a family that reads the cards out and
/// walks away without pressing Done would lose the very thing they came here to say.
@MainActor
@Observable
final class PlanningKidsStepModel {
    typealias FetchKids = (
        _ sessionId: String, _ weekStart: String?
    ) async throws -> WaffledAPI.PlanningKidsView
    typealias AnswerKid = (
        _ sessionId: String, _ personId: String, _ weekStart: String?,
        _ focus: PlanningKidPick, _ forward: PlanningKidPick
    ) async throws -> WaffledAPI.PlanningKidsView
    /// Named `RepeatAnswers`, not `RepeatLastWeek`: a stored closure sharing a name with
    /// the method that calls it resolves to the method, which is an infinite recursion the
    /// compiler is happy to accept.
    typealias RepeatAnswers = (
        _ sessionId: String, _ weekStart: String?
    ) async throws -> WaffledAPI.PlanningKidsView

    /// Which of a card's two questions a box or a chip belongs to.
    enum Question: String, Hashable, Sendable {
        case focus
        case forward
    }

    /// Which escape hatch is open, if any.
    struct TypeTarget: Equatable, Sendable {
        let personId: String
        let which: Question
    }

    /// The sentinel `saving` carries while "Same as last week" is in flight — it belongs to
    /// no one card, but it freezes every one of them just the same.
    static let repeatToken = "repeat"

    private(set) var view: WaffledAPI.PlanningKidsView?
    private(set) var loaded = false
    /// The card a write is in flight for. One at a time: two answers landing together would
    /// race two read-modify-writes of the same session crumb.
    private(set) var saving: String?
    private(set) var errorMessage: String?
    /// Which card the phone is showing. Irrelevant on the iPad, where every card is up.
    private(set) var activePersonId: String?
    /// "Change something" — the read-back put away by hand, until they answer again.
    private(set) var changing = false
    private(set) var typing: TypeTarget?
    /// Bumped every time a read or a write lands, so the view can push the crumb on ONE
    /// `onChange` instead of after each call site — the convention the other steps follow.
    /// A failed write never bumps it, which is what keeps a half-applied answer out of the
    /// session record.
    private(set) var rev = 0

    /// WHAT THEY TYPED BUT NEVER SAVED, keyed `<personId>:<which>`.
    ///
    /// "I added a custom 'something else' and then clicked an existing one and the one I
    /// wrote disappeared, is that expected?" Half of it was: picking an existing option IS
    /// a change of answer, and only one option can be the chosen one. The other half was
    /// not — the typing had been saved nowhere, so an empty box said it was gone for good.
    ///
    /// KEPT OUT OF `view` ON PURPOSE: a draft is not an answer, it never reaches the
    /// server, and it lives exactly as long as the step is on screen.
    private(set) var drafts: [String: String] = [:]

    private let fetchKids: FetchKids
    private let answerKid: AnswerKid
    private let repeatAnswers: RepeatAnswers

    init(
        fetchKids: @escaping FetchKids = { sessionId, weekStart in
            try await WaffledAPI().planningKids(sessionId: sessionId, weekStart: weekStart)
        },
        answerKid: @escaping AnswerKid = { sessionId, personId, weekStart, focus, forward in
            try await WaffledAPI().planningKidsAnswer(
                sessionId: sessionId, personId: personId, weekStart: weekStart,
                focus: focus, forward: forward)
        },
        repeatAnswers: @escaping RepeatAnswers = { sessionId, weekStart in
            try await WaffledAPI().planningKidsRepeat(sessionId: sessionId, weekStart: weekStart)
        }
    ) {
        self.fetchKids = fetchKids
        self.answerKid = answerKid
        self.repeatAnswers = repeatAnswers
    }

    var kids: [WaffledAPI.PlanningKidCard] { view?.kids ?? [] }

    var canRepeat: Bool { view?.canRepeat ?? false }

    var activeCard: WaffledAPI.PlanningKidCard? {
        kids.first { $0.personId == activePersonId } ?? kids.first
    }

    /// The second frame: once EVERY card has BOTH answers, the step stops being a picker
    /// and becomes the two sentences, large — "the part they'll actually remember".
    var isReadBack: Bool {
        !changing && !kids.isEmpty && kids.allSatisfy(\.settled)
    }

    func isFrozen(shellBusy: Bool) -> Bool { shellBusy || saving != nil }

    /// See `PlanningKidsCrumb` for why this mirrors the server's map rather than
    /// summarising it.
    ///
    /// NIL UNTIL A READ HAS ACTUALLY LANDED. An empty map is not "nobody answered", it is
    /// a claim — and since the shell REPLACES the step's data when the primary is pressed,
    /// handing one up after a failed fetch would erase every answer the kids gave.
    var crumb: [String: JSONValue]? {
        guard view != nil else { return nil }
        return PlanningKidsCrumb.decision(view)
    }

    /// "Wally and Lottie" — the step's own heading. The catalog says "Kids" and is
    /// server-owned (web and iOS must not drift on it), so the names live here instead.
    var heading: String {
        let names = kids.map(\.name)
        guard names.count > 1 else { return names.first ?? "Kids" }
        return names.dropLast().joined(separator: ", ") + " and " + (names.last ?? "")
    }

    func load(sessionId: String, weekStart: String?) async {
        if let latest = try? await fetchKids(sessionId, weekStart) { apply(latest) }
        loaded = true
    }

    func select(personId: String) {
        guard kids.contains(where: { $0.personId == personId }) else { return }
        activePersonId = personId
    }

    func beginChanging() { changing = true }

    func dismissError() { errorMessage = nil }

    // MARK: The escape hatch and its draft

    func beginTyping(personId: String, which: Question) {
        typing = TypeTarget(personId: personId, which: which)
    }

    func cancelTyping() { typing = nil }

    func isTyping(personId: String, which: Question) -> Bool {
        typing == TypeTarget(personId: personId, which: which)
    }

    /// Called ONCE, as the box goes away, with whatever was in it — never per keystroke.
    /// A draft written on every character would re-render every card in the step just to
    /// move a cursor.
    func recordDraft(personId: String, which: Question, text: String) {
        drafts[Self.draftKey(personId, which)] = text
    }

    /// What the box opens with. THE UNSAVED DRAFT WINS: type into "something else", change
    /// your mind and tap an existing option, and coming back to the hatch must still show
    /// the words they said — even though the existing option is now the answer and is the
    /// only chip reading as chosen. Falling back to their own saved custom answer is the
    /// other half: reopening a chosen custom answer shows what they said, not an empty box.
    func typeInSeed(_ card: WaffledAPI.PlanningKidCard, _ which: Question) -> String {
        if let draft = drafts[Self.draftKey(card.personId, which)] { return draft }
        switch which {
        case .focus:
            return PlanningKidsChoice.focusIsCustom(card) ? (card.focus?.label ?? "") : ""
        case .forward:
            return PlanningKidsChoice.forwardIsCustom(card) ? (card.forward?.label ?? "") : ""
        }
    }

    static func draftKey(_ personId: String, _ which: Question) -> String {
        "\(personId):\(which.rawValue)"
    }

    // MARK: Writes

    /// Answer one question on one card. The other question is `.absent` by default, which
    /// puts NO key in the body — sending half an answer must not erase the other half.
    func answer(
        sessionId: String,
        personId: String,
        weekStart: String?,
        focus: PlanningKidPick = .absent,
        forward: PlanningKidPick = .absent
    ) async {
        guard saving == nil else { return }
        saving = personId
        errorMessage = nil
        // The box goes away as the answer lands — and its `onDisappear` is what records
        // whatever was half-typed in it, so nothing they said is lost by changing their
        // mind.
        typing = nil
        defer { saving = nil }
        do {
            let latest = try await answerKid(sessionId, personId, weekStart, focus, forward)
            apply(latest)
            // Answering again is how you get OUT of "Change something": the frame follows
            // the answers once they're fresh, rather than waiting to be told twice.
            changing = false
        } catch {
            // Leave the last good answer on screen rather than a half-applied one.
            errorMessage = "That didn’t take — try again."
        }
    }

    /// "Same as last week". Additive server-side, and gated by `canRepeat` at the call site.
    func repeatLastWeek(sessionId: String, weekStart: String?) async {
        guard saving == nil, canRepeat else { return }
        saving = Self.repeatToken
        errorMessage = nil
        defer { saving = nil }
        do {
            apply(try await repeatAnswers(sessionId, weekStart))
            changing = false
        } catch {
            errorMessage = "Couldn’t copy last week — pick this week’s instead."
        }
    }

    private func apply(_ latest: WaffledAPI.PlanningKidsView) {
        view = latest
        rev += 1
        // Keep the card they're standing at across a refetch; land on the first one only
        // when the current pick is gone (or was never made).
        if let activePersonId, latest.kids.contains(where: { $0.personId == activePersonId }) {
            return
        }
        activePersonId = latest.kids.first?.personId
    }
}
