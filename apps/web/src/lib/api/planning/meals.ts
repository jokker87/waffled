// Step 7 · Meals — this step's API client and its types.
//
// The step's own routes are only the three it needs that don't already exist: the
// seven-column read, the fill and its undo. Everything else a night can do —
// planning a dish, clearing one, listing the library — goes through the meal-plan
// endpoints the Meals screen already uses, because this step is a *view over* the
// plan and must not grow a second way to write one.
import { apiGet, apiSend } from '../client'
import { emit } from '../bus'
import type { PlanCard } from '../meals'

export interface PlanningNightEvent {
  id: string
  title: string
  startsAt: string
  allDay: boolean
  personName: string | null
  personColor: string | null
}

export interface PlanningNightDinner {
  entryId: string
  // What to show: the recipe's title, the plate's name, or the slot's own text.
  title: string | null
  emoji: string | null
  recipeId: string | null
  mealId: string | null
  imageUrl: string | null
  // Who's cooking (meal_plan_entries.cook_person_id) — the tile's attribution line.
  cookName: string | null
  cookAvatar: string | null
  cookColor: string | null
  // The recipe's total time, when it knows it — the tile's fallback sub-line.
  minutes: number | null
}

export interface PlanningMealsNight {
  date: string
  events: PlanningNightEvent[]
  dinner: PlanningNightDinner | null
}

// This week's shopping trip, read back off a real one-off chore — so it also shows on
// the Tasks board as a genuine assignment. null ⇒ no trip; `personId: null` ⇒ planned
// but up for grabs, which is a real answer.
export interface PlanningShoppingTrip {
  choreId: string
  personId: string | null
  personName: string | null
  personAvatar: string | null
  personColor: string | null
  dueOn: string
  dueTime: string | null
  status: string
}

export interface PlanningMealsView {
  // The week the SERVER named. Never recompute a week from this — pass it back.
  weekStart: string
  nights: PlanningMealsNight[]
  emptyDates: string[]
  // One line, not a panel. null ⇒ the lists module is off and there is no line.
  groceries: { items: number; checked: number } | null
  // False ⇒ the chores module is off, so there is nowhere for a shopping trip to
  // live: the bar shows the plain line and no control, rather than a dead affordance.
  choresOn: boolean
  shopping: PlanningShoppingTrip | null
}

// What a fill wrote — and everything the undo needs to prove a night is still that.
//
// `mealId` is part of the proof, not decoration: a slot holds a recipe, a saved plate
// or a bare title, and a plate is recipe-less with THE PLATE'S NAME as its title — so
// a night filled with the title "BBQ Sunday" and a night since hand-changed to the
// PLATE "BBQ Sunday" agree on everything else. Round-trip it untouched.
export interface PlanningFilledNight {
  date: string
  entryId: string
  recipeId: string | null
  mealId: string | null
  title: string | null
}

export interface PlanningMealsFill {
  weekStart: string
  filled: PlanningFilledNight[]
  view: PlanningMealsView
}

export interface PlanningMealsUndo {
  weekStart: string
  cleared: string[]
  // Nights left alone because somebody decided them since the fill.
  kept: string[]
  view: PlanningMealsView
}

export const planningMealsApi = {
  // `choreId` is the shopping chore the client last saw — a hint that keeps a chore
  // renamed on the Tasks board recognised as this week's trip.
  get: (weekStart: string, choreId?: string | null) =>
    apiGet<PlanningMealsView>(
      `/api/weekly-planning/meals?weekStart=${encodeURIComponent(weekStart)}${choreId ? `&choreId=${encodeURIComponent(choreId)}` : ''}`
    ),
  // "Plan the rest for me" — fills only the nights with no dinner.
  //
  // `cards` is the week the family approved in the shared "Plan my week" planner.
  // It is applied HERE rather than through POST /api/meals/plan because only this
  // route can refuse a night somebody already decided and hand back the receipt the
  // undo checks. Omitted, the server drafts the empties itself.
  fill: (weekStart: string, cards?: PlanCard[]) =>
    apiSend<PlanningMealsFill>('POST', '/api/weekly-planning/meals/fill', cards ? { weekStart, cards } : { weekStart })
      .then((r) => { emit('meals'); emit('grocery'); return r }),
  undo: (weekStart: string, filled: PlanningFilledNight[]) =>
    apiSend<PlanningMealsUndo>('POST', '/api/weekly-planning/meals/undo', { weekStart, filled })
      .then((r) => { emit('meals'); emit('grocery'); return r }),
  // Assign the shopping trip (or clear it with `dueOn: null`). One chore per week, so
  // this is an upsert however many times the family changes its mind.
  setShopper: (weekStart: string, t: { dueOn: string | null; personId: string | null; dueTime: string | null; choreId: string | null }) =>
    apiSend<{ weekStart: string; shopping: PlanningShoppingTrip | null; view: PlanningMealsView }>(
      'PUT', '/api/weekly-planning/meals/shopper', { weekStart, ...t }
    ).then((r) => { emit('chores'); return r }),
}
