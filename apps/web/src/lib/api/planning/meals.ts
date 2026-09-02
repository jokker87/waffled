// Step 7 · Meals — this step's API client and its types.
//
// The step's own routes are only the three it needs that don't already exist: the
// seven-column read, the fill and its undo. Everything else a night can do —
// planning a dish, clearing one, listing the library — goes through the meal-plan
// endpoints the Meals screen already uses, because this step is a *view over* the
// plan and must not grow a second way to write one.
import { apiGet, apiSend } from '../client'
import { emit } from '../bus'

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

export interface PlanningMealsView {
  // The week the SERVER named. Never recompute a week from this — pass it back.
  weekStart: string
  nights: PlanningMealsNight[]
  emptyDates: string[]
  // One line, not a panel. null ⇒ the lists module is off and there is no line.
  groceries: { items: number; checked: number } | null
}

// What a fill wrote — and everything the undo needs to prove a night is still that.
export interface PlanningFilledNight {
  date: string
  entryId: string
  recipeId: string | null
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
  get: (weekStart: string) =>
    apiGet<PlanningMealsView>(`/api/weekly-planning/meals?weekStart=${encodeURIComponent(weekStart)}`),
  // "Plan the rest for me" — fills only the nights with no dinner.
  fill: (weekStart: string) =>
    apiSend<PlanningMealsFill>('POST', '/api/weekly-planning/meals/fill', { weekStart })
      .then((r) => { emit('meals'); emit('grocery'); return r }),
  undo: (weekStart: string, filled: PlanningFilledNight[]) =>
    apiSend<PlanningMealsUndo>('POST', '/api/weekly-planning/meals/undo', { weekStart, filled })
      .then((r) => { emit('meals'); emit('grocery'); return r }),
}
