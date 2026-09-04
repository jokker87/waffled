import Foundation

// Weekly Planning · step 7 "Meals" — this step's wire types, its ONE read and its three
// writes. Ported from `apps/web/src/lib/api/planning/meals.ts`.
//
// THE STEP OWNS NO DATA. Everything it shows is the existing meal plan and the existing
// grocery board; deciding a night by hand goes through the meal-plan endpoints the Meals
// screen already uses (`planMeal` / `clearMeal` / `scheduleMeal`). The only routes that
// are this step's own are the three that cannot be composed from those: the seven-column
// read, the fill, and the fill's undo — because only the fill can refuse a night somebody
// already decided AND hand back the receipt the undo checks.
//
// Property names are camelCase and 1:1 with the server (`WaffledAPI.decoder` has no key
// strategy), and every date/time is a `String`: `weekStart`, a night's `date` and a
// trip's `dueOn` are household-local calendar labels that must never round-trip through a
// device `Date`.
extension WaffledAPI {

    /// One calendar event on a night — the CONTEXT above the dish, which on this screen is
    /// the only thing about the day that matters.
    ///
    /// `personId`/`participantIds` are on the wire (the server sends the colour INPUTS,
    /// never a colour) and are decoded so nothing is silently dropped, but this step paints
    /// its dot from `personColor` exactly as the web step does. The family-aware
    /// `EventPalette` rule is deliberately NOT applied here: the web's Meals step uses the
    /// owner's raw colour, and a dot that resolved differently on the phone than in the
    /// browser would be the two platforms disagreeing about the same night.
    struct PlanningNightEvent: Decodable, Identifiable, Sendable, Equatable {
        let id: String
        let title: String
        /// An ISO instant (`2026-09-09T22:30:00.000Z`), not a day.
        let startsAt: String
        let allDay: Bool
        let personId: String?
        let personName: String?
        /// A real `persons.color_hex` — data, so `Color(hexString:)`, never a `WF` token.
        let personColor: String?
        let participantIds: [String]

        /// `?? []` / `?? false` on purpose: a payload missing one field must cost that
        /// field, never the whole week. Swift is stricter than the web here — a missing
        /// non-optional array THROWS, which would fail the entire `PlanningMealsView`
        /// decode and blank a step that had seven perfectly good nights.
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
            startsAt = try c.decodeIfPresent(String.self, forKey: .startsAt) ?? ""
            allDay = try c.decodeIfPresent(Bool.self, forKey: .allDay) ?? false
            personId = try c.decodeIfPresent(String.self, forKey: .personId)
            personName = try c.decodeIfPresent(String.self, forKey: .personName)
            personColor = try c.decodeIfPresent(String.self, forKey: .personColor)
            participantIds = try c.decodeIfPresent([String].self, forKey: .participantIds) ?? []
        }

        private enum CodingKeys: String, CodingKey {
            case id, title, startsAt, allDay, personId, personName, personColor, participantIds
        }
    }

    /// The dish on a night, already resolved for display: a recipe-backed slot reads its
    /// recipe's title, a plate-backed one its plate's name, and a placeholder
    /// ("Leftovers", "Eating out") its own text.
    struct PlanningNightDinner: Decodable, Sendable, Equatable {
        let entryId: String
        let title: String?
        let emoji: String?
        let recipeId: String?
        /// A Meal Builder plate in the slot. `recipeId == nil && mealId != nil` is the
        /// PLATE branch, and checking it first is what stops a plate called "Takeout
        /// Tuesday" wearing the takeout tile and claiming "no cooking".
        let mealId: String?
        let imageUrl: String?
        /// Who's cooking (`meal_plan_entries.cook_person_id`) — real data, so it is the
        /// tile's attribution line whenever it is there.
        let cookName: String?
        let cookAvatar: String?
        let cookColor: String?
        /// The recipe's total time, when it knows it. The tile's fallback sub-line.
        let minutes: Int?
    }

    /// One of the seven columns: that night's events, then its dinner.
    struct PlanningMealsNight: Decodable, Identifiable, Sendable, Equatable {
        let date: String
        let events: [PlanningNightEvent]
        let dinner: PlanningNightDinner?

        var id: String { date }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            date = try c.decode(String.self, forKey: .date)
            events = try c.decodeIfPresent([PlanningNightEvent].self, forKey: .events) ?? []
            dinner = try c.decodeIfPresent(PlanningNightDinner.self, forKey: .dinner)
        }

        private enum CodingKeys: String, CodingKey { case date, events, dinner }
    }

    /// The grocery line — ONE line, not a panel: the board already builds itself from this
    /// plan. `nil` on the view ⇒ the lists module is off and there is no line at all.
    struct PlanningMealsGroceries: Decodable, Sendable, Equatable {
        let items: Int
        let checked: Int
    }

    /// This week's shopping trip, read back off a real one-off chore — so it also shows on
    /// the Tasks board as a genuine assignment. `nil` ⇒ no trip; `personId == nil` ⇒
    /// planned but up for grabs, which is a real answer and not a blank.
    struct PlanningShoppingTrip: Decodable, Sendable, Equatable {
        let choreId: String
        let personId: String?
        let personName: String?
        let personAvatar: String?
        let personColor: String?
        let dueOn: String
        let dueTime: String?
        let status: String
    }

    struct PlanningMealsView: Decodable, Sendable, Equatable {
        /// The week the SERVER named — snapped and floored. ECHO IT; never recompute a
        /// week on the device (that is the bug this whole module was written after).
        let weekStart: String
        let nights: [PlanningMealsNight]
        /// The nights with no dinner, in order. What the fill is allowed to touch, and
        /// nothing else.
        let emptyDates: [String]
        let groceries: PlanningMealsGroceries?
        /// False ⇒ the chores module is off, so there is nowhere for a shopping trip to
        /// live: show the plain line and NO control rather than a dead affordance.
        let choresOn: Bool
        let shopping: PlanningShoppingTrip?

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            weekStart = try c.decodeIfPresent(String.self, forKey: .weekStart) ?? ""
            nights = try c.decodeIfPresent([PlanningMealsNight].self, forKey: .nights) ?? []
            emptyDates = try c.decodeIfPresent([String].self, forKey: .emptyDates) ?? []
            groceries = try c.decodeIfPresent(PlanningMealsGroceries.self, forKey: .groceries)
            choresOn = try c.decodeIfPresent(Bool.self, forKey: .choresOn) ?? false
            shopping = try c.decodeIfPresent(PlanningShoppingTrip.self, forKey: .shopping)
        }

        private enum CodingKeys: String, CodingKey {
            case weekStart, nights, emptyDates, groceries, choresOn, shopping
        }
    }

    /// What a fill wrote — and everything the undo needs to prove a night is still that.
    ///
    /// `mealId` IS PART OF THE PROOF, not decoration. A slot holds a recipe, a saved plate
    /// or a bare title, and a plate is recipe-less with THE PLATE'S NAME as its title — so
    /// a night filled with the title "BBQ Sunday" and a night since hand-changed to the
    /// PLATE "BBQ Sunday" agree on `entryId`, `recipeId` and `title` (upsert keeps the row
    /// id). Round-trip every field untouched; `json` below is why it can be.
    struct PlanningFilledNight: Decodable, Identifiable, Sendable, Equatable {
        let date: String
        let entryId: String
        let recipeId: String?
        let mealId: String?
        let title: String?

        var id: String { date }

        /// The claim, back on the wire. EXPLICIT `.null` for every absent field: the
        /// server normalizes both sides to null before comparing, and a body that simply
        /// omitted `mealId` would still compare equal — but building it by hand with
        /// `if let` is how the field quietly stops travelling at all, which is the one
        /// dimension that tells a filled title from a hand-picked plate of that name.
        var json: JSONValue {
            .object([
                "date": .string(date),
                "entryId": .string(entryId),
                "recipeId": recipeId.map(JSONValue.string) ?? .null,
                "mealId": mealId.map(JSONValue.string) ?? .null,
                "title": title.map(JSONValue.string) ?? .null,
            ])
        }
    }

    struct PlanningMealsFill: Decodable, Sendable, Equatable {
        let weekStart: String
        let filled: [PlanningFilledNight]
        let view: PlanningMealsView

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            weekStart = try c.decodeIfPresent(String.self, forKey: .weekStart) ?? ""
            filled = try c.decodeIfPresent([PlanningFilledNight].self, forKey: .filled) ?? []
            view = try c.decode(PlanningMealsView.self, forKey: .view)
        }

        private enum CodingKeys: String, CodingKey { case weekStart, filled, view }
    }

    struct PlanningMealsUndo: Decodable, Sendable, Equatable {
        let weekStart: String
        /// Nights actually cleared.
        let cleared: [String]
        /// Nights left alone because somebody decided them since the fill. An undo has no
        /// business overwriting a decision, so these are reported rather than taken back.
        let kept: [String]
        let view: PlanningMealsView

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            weekStart = try c.decodeIfPresent(String.self, forKey: .weekStart) ?? ""
            cleared = try c.decodeIfPresent([String].self, forKey: .cleared) ?? []
            kept = try c.decodeIfPresent([String].self, forKey: .kept) ?? []
            view = try c.decode(PlanningMealsView.self, forKey: .view)
        }

        private enum CodingKeys: String, CodingKey { case weekStart, cleared, kept, view }
    }

    struct PlanningMealsShopperResult: Decodable, Sendable, Equatable {
        let weekStart: String
        let shopping: PlanningShoppingTrip?
        let view: PlanningMealsView

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            weekStart = try c.decodeIfPresent(String.self, forKey: .weekStart) ?? ""
            shopping = try c.decodeIfPresent(PlanningShoppingTrip.self, forKey: .shopping)
            view = try c.decode(PlanningMealsView.self, forKey: .view)
        }

        private enum CodingKeys: String, CodingKey { case weekStart, shopping, view }
    }

    // MARK: - The read and the three writes

    /// The seven columns for the week the shell handed us. `choreId` is the shopping chore
    /// the client last saw — a HINT that keeps a chore renamed on the Tasks board
    /// recognised as this week's trip instead of spawning a second one.
    func planningMeals(weekStart: String, choreId: String? = nil) async throws -> PlanningMealsView {
        var path = "/api/weekly-planning/meals?weekStart=\(PlanningQuery.esc(weekStart))"
        if let choreId, !choreId.isEmpty { path += "&choreId=\(PlanningQuery.esc(choreId))" }
        return try await getJSON(path, as: PlanningMealsView.self)
    }

    /// "Plan the rest for me" — fills ONLY the nights with no dinner and hands back the
    /// receipt the undo checks. See `PlanningMealsWire.fillBody` for why `cards` is
    /// three-way and why iOS sends it absent.
    func planningMealsFill(
        weekStart: String, cards: [PlanningMealsCard]? = nil
    ) async throws -> PlanningMealsFill {
        try await sendReturning(
            "POST", "/api/weekly-planning/meals/fill",
            body: PlanningMealsWire.fillBody(weekStart: weekStart, cards: cards),
            as: PlanningMealsFill.self)
    }

    /// Take back what the fill wrote — and nothing else.
    func planningMealsUndo(
        weekStart: String, filled: [PlanningFilledNight]
    ) async throws -> PlanningMealsUndo {
        try await sendReturning(
            "POST", "/api/weekly-planning/meals/undo",
            body: PlanningMealsWire.undoBody(weekStart: weekStart, filled: filled),
            as: PlanningMealsUndo.self)
    }

    /// Assign the shopping trip, or clear it with `dueOn: nil`. ONE chore per week, so
    /// this is an upsert however many times the family changes its mind.
    ///
    /// The server refuses a `dueOn` outside the week (400) and requires `chore.manage` to
    /// put the trip on anybody other than yourself (403) — see
    /// `PlanningMealsShopper.mayAssign`, which is the same rule stated client-side so the
    /// picker doesn't offer a tap that is going to bounce.
    func planningMealsSetShopper(
        weekStart: String, dueOn: String?, personId: String?, dueTime: String?, choreId: String?
    ) async throws -> PlanningMealsShopperResult {
        try await sendReturning(
            "PUT", "/api/weekly-planning/meals/shopper",
            body: PlanningMealsWire.shopperBody(
                weekStart: weekStart, dueOn: dueOn, personId: personId,
                dueTime: dueTime, choreId: choreId),
            as: PlanningMealsShopperResult.self)
    }

    /// One night of a week the family approved in the shared "Plan my week" planner.
    ///
    /// Only the four fields the fill actually writes: the rest of a plan card is display,
    /// and trusting a client's `servings` or `note` would be storing a claim nobody checks
    /// (the server's `parsePlanCards` reads exactly these and drops the rest).
    struct PlanningMealsCard: Sendable, Equatable {
        let date: String
        /// The step plans DINNERS. A card naming another meal is DROPPED server-side
        /// rather than quietly rewritten — silently moving somebody's lunch to 6pm is
        /// worse than not planning it.
        var mealType: String = "dinner"
        var title: String = ""
        var recipeId: String?

        var json: JSONValue {
            .object([
                "date": .string(date),
                "mealType": .string(mealType),
                "title": .string(title),
                "recipeId": recipeId.map(JSONValue.string) ?? .null,
            ])
        }
    }
}

/// The three bodies as PURE FUNCTIONS, so the one that is easy to get catastrophically
/// wrong can be asserted without a network.
enum PlanningMealsWire {

    /// `cards` IS THREE-WAY, and the three cases are genuinely different writes:
    ///
    ///   · **absent** (`nil` here ⇒ the key is not in the body at all) — the server drafts
    ///     the empty nights itself. This is the "headless fill" `meals.ts` names as what
    ///     iOS parity needs, and it is what this app sends.
    ///   · **a real array** — apply the week the family approved, and only onto the empty
    ///     nights.
    ///   · **present but not a usable list** (a `null`, a string, an empty array) — the
    ///     server writes NOTHING. `body.cards === undefined ? null : (parsePlanCards(...)
    ///     ?? [])`, and an empty `chosen` skips the drafting branch entirely, so the fill
    ///     loop has nothing to iterate.
    ///
    /// Which is why this must never be written as `body["cards"] = cards.map(...) ?? .null`
    /// : sending an explicit null to mean "you choose" writes nothing at all, and the
    /// footer would report a week it never planned. An EMPTY array is passed through as a
    /// present empty array rather than collapsed to absent, for the same reason — a caller
    /// that genuinely approved nothing must not silently get a server-drafted week.
    static func fillBody(
        weekStart: String, cards: [WaffledAPI.PlanningMealsCard]?
    ) -> [String: JSONValue] {
        var body: [String: JSONValue] = ["weekStart": .string(weekStart)]
        if let cards { body["cards"] = .array(cards.map(\.json)) }
        return body
    }

    /// The undo's claims, each round-tripped untouched — see `PlanningFilledNight.json`.
    static func undoBody(
        weekStart: String, filled: [WaffledAPI.PlanningFilledNight]
    ) -> [String: JSONValue] {
        ["weekStart": .string(weekStart), "filled": .array(filled.map(\.json))]
    }

    /// EXPLICIT NULLS, all three of them. `dueOn: null` is "there is no trip this week"
    /// (the chore is removed rather than orphaned on somebody's board), `personId: null` is
    /// "up for grabs", and `dueTime: null` is "no set time" — none of them is "leave it as
    /// it was", so an `if let` body would turn every clear into a silent no-op.
    static func shopperBody(
        weekStart: String, dueOn: String?, personId: String?, dueTime: String?, choreId: String?
    ) -> [String: JSONValue] {
        [
            "weekStart": .string(weekStart),
            "dueOn": dueOn.map(JSONValue.string) ?? .null,
            "personId": personId.map(JSONValue.string) ?? .null,
            "dueTime": dueTime.map(JSONValue.string) ?? .null,
            "choreId": choreId.map(JSONValue.string) ?? .null,
        ]
    }
}

/// Who may be handed the shopping trip, stated client-side so the picker never offers a
/// tap the server is going to refuse.
///
/// The rule is the CHORES module's own, not one this step invented: putting the trip on
/// yourself, or leaving it up for grabs, is anybody's; putting it on somebody ELSE (or
/// taking it off them) is `chore.manage`. `meals.routes.ts` enforces exactly this, and
/// `TasksStep` gates its face row the same way.
enum PlanningMealsShopper {
    static func mayAssign(personId: String?, myPersonId: String?, canManage: Bool) -> Bool {
        if canManage { return true }
        // Up for grabs is a real answer and needs no capability.
        guard let personId else { return true }
        // A device with no person of its own (a kiosk identity) cannot claim "that's me".
        guard let myPersonId else { return false }
        return personId == myPersonId
    }
}
