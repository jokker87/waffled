// Weekly Planning · step 7 (Meals) — service logic. Routes in ./meals.routes.ts.
//
// THIS STEP STORES NOTHING OF ITS OWN. It is a read over the existing meal plan and
// the existing grocery board, and its two writes go through the same paths the Meals
// screen uses. The only thing the session records is a crumb on
// planning_session_steps.data ("these three nights were auto-filled and can still be
// undone"), which the client sets — never a copy of the plan.
//
// The design's argument for this shape: "Same seven columns as Calendar, so it reads as
// the same week. Each night shows the events above the dish, because that's the only
// context that matters here."
import { query } from '../../../platform/db'
import { moduleEnabled } from '../../../platform/modules'
import { assertRecipeInHousehold } from '../../../platform/household-refs'
import { getAiConfig, availability } from '../../../platform/llm'
import type { Tenant } from '../../households/households'
import {
  getOrCreateActivePlan,
  upsertEntry,
  clearEntry,
  weekEntries,
  planWeek,
  shuffleWeek,
} from '../../meals/meals.service'
import {
  syncMealEventForEntry,
  removeMealEventForEntry,
  syncPrepReminderForEntry,
  removePrepReminderForEntry,
} from '../../meals/meal-events'
import { rangeEvents } from '../../events/events'
import { groceryBoard, rebuildGroceryFromWeek } from '../../lists/lists.service'
import type { PlanCard } from '../../meals/meals.types'

// The step plans dinners. Breakfast and lunch belong to the Meals screen — a session
// step that asked about twenty-one slots would be a spreadsheet, not a decision.
const MEAL_TYPE = 'dinner'

// A meal's own mirror event (origin='meal_plan') and its thaw reminder
// (origin='meal_prep') are the *output* of this plan, so showing them as the night's
// context would put "Dinner · Pasta bake" directly above the Pasta bake card.
const MIRROR_ORIGINS = new Set(['meal_plan', 'meal_prep'])

export const addDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export interface NightEvent {
  id: string
  title: string
  startsAt: string
  allDay: boolean
  personName: string | null
  personColor: string | null
}

// The dish on a night, already resolved for display: a recipe-backed slot reads its
// recipe's title, a plate-backed one its plate's name, and a placeholder
// ("Leftovers", "Eating out") its own text.
export interface NightDinner {
  entryId: string
  // What to SHOW: the recipe's title, the plate's name, or the slot's own text. The
  // slot's STORED title is deliberately not on the wire: the only thing that compares
  // it is the undo guard, and a claim a client rebuilt from this view would be checked
  // against the very row it was read from — proving nothing.
  title: string | null
  emoji: string | null
  recipeId: string | null
  mealId: string | null
  imageUrl: string | null
  // Who's cooking — meal_plan_entries.cook_person_id, so this is real data, not a
  // guess. It's the dish tile's attribution line when it's there.
  cookName: string | null
  cookAvatar: string | null
  cookColor: string | null
  // Total hands-on + cook time, when the recipe knows it. The tile's fallback
  // sub-line: the design puts a short note there ("uses the beef"), but those come
  // from the LLM's transient suggestion and the plan stores none, so the honest
  // substitute is what the recipe itself says.
  minutes: number | null
}

export interface MealsNight {
  date: string
  events: NightEvent[]
  dinner: NightDinner | null
}

export interface MealsStepView {
  // The week these seven columns are about — the server's, snapped and floored.
  weekStart: string
  nights: MealsNight[]
  // The nights with no dinner, in order. What "plan the rest for me" fills, and the
  // only thing it is allowed to touch.
  emptyDates: string[]
  // Groceries are ONE LINE, not a panel: the board already builds itself from this
  // plan. null when the lists module is off (then there is no line to show).
  groceries: { items: number; checked: number } | null
}

// What a fill wrote, and everything an undo needs to prove the night is still the one
// it wrote. `entryId` alone is not enough: upsertEntry's `on conflict do update`
// preserves the row id, so a hand-edit keeps it — the dish itself is the evidence.
export interface FilledNight {
  date: string
  entryId: string
  recipeId: string | null
  title: string | null
}

const listsOn = async (householdId: string): Promise<boolean> => {
  const { rows } = await query<{ settings: unknown }>(`select settings from households where id = $1`, [householdId])
  return moduleEnabled(rows[0]?.settings, 'lists')
}

const householdTz = async (householdId: string): Promise<string> => {
  const { rows } = await query<{ timezone: string | null }>(`select timezone from households where id = $1`, [householdId])
  return (rows[0]?.timezone ?? '').trim() || 'UTC'
}

// Which of the household's local days an event belongs to. Deliberately the same
// reading as `rangeEvents`' own `(starts_at at time zone h.timezone)::date` filter —
// bucketing in any other zone would drop an evening event off the night it happens on.
const localDay = (at: Date | string, tz: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at))

// The seven columns for `weekStart`: that night's calendar events, then its dinner.
export async function mealsStepView(tenant: Tenant, weekStart: string): Promise<MealsStepView> {
  const weekEnd = addDays(weekStart, 6)
  const [entries, events, tz, groceries] = await Promise.all([
    weekEntries(tenant.householdId, weekStart, 7),
    rangeEvents(tenant.householdId, weekStart, weekEnd, tenant.personId ?? null),
    householdTz(tenant.householdId),
    groceryLine(tenant, weekStart),
  ])

  const dinnerByDate = new Map<string, NightDinner>()
  for (const e of entries) {
    if (e.mealType !== MEAL_TYPE) continue
    dinnerByDate.set(e.date, {
      entryId: e.id,
      title: e.recipe?.title ?? e.meal?.name ?? e.title ?? null,
      emoji: e.recipe?.emoji ?? null,
      recipeId: e.recipeId,
      mealId: e.mealId,
      imageUrl: e.recipe?.imageUrl ?? null,
      cookName: e.cook?.name ?? null,
      cookAvatar: e.cook?.avatarEmoji ?? null,
      cookColor: e.cook?.colorHex ?? null,
      minutes: (e.recipe?.prepTimeMinutes ?? 0) + (e.recipe?.cookTimeMinutes ?? 0) || null,
    })
  }

  const eventsByDate = new Map<string, NightEvent[]>()
  for (const e of events) {
    if (e.origin && MIRROR_ORIGINS.has(e.origin)) continue
    const day = localDay(e.starts_at, tz)
    const list = eventsByDate.get(day) ?? eventsByDate.set(day, []).get(day)!
    list.push({
      id: e.id,
      title: e.title,
      startsAt: new Date(e.starts_at).toISOString(),
      allDay: !!e.all_day,
      personName: e.person_name ?? null,
      personColor: e.person_color ?? null,
    })
  }
  // All-day first, then by clock — the reading order of a day, matching todayEvents.
  for (const list of eventsByDate.values()) {
    list.sort((a, b) => (a.allDay === b.allDay ? a.startsAt.localeCompare(b.startsAt) : a.allDay ? -1 : 1))
  }

  const nights: MealsNight[] = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(weekStart, i)
    return { date, events: eventsByDate.get(date) ?? [], dinner: dinnerByDate.get(date) ?? null }
  })

  return {
    weekStart,
    nights,
    emptyDates: nights.filter((n) => !n.dinner).map((n) => n.date),
    groceries,
  }
}

async function groceryLine(tenant: Tenant, weekStart: string): Promise<{ items: number; checked: number } | null> {
  if (!(await listsOn(tenant.householdId))) return null
  const board = await groceryBoard(tenant, weekStart)
  const items = board.items as { checked?: boolean }[]
  return { items: items.length, checked: items.filter((i) => i.checked).length }
}

// The grocery list is derived from the plan, so a fill or an undo that changed the
// plan has to leave the one line true rather than stale. Rebuild keeps existing
// checks (clear-checks is the destructive one), and it is scoped to this week.
async function rebuildGroceries(tenant: Tenant, weekStart: string): Promise<void> {
  if (!(await listsOn(tenant.householdId))) return
  await rebuildGroceryFromWeek(tenant, weekStart).catch((err) => console.error('planning meals grocery rebuild failed', err))
}

// Suggestions for exactly these nights. Mirrors POST /api/meals/plan-week's own
// fallback: the household's LLM when it has a usable one, the library shuffle
// otherwise — and the shuffle again if the model call falls over, because a step whose
// one AI button can fail open is better than one that can fail shut.
async function suggestFor(tenant: Tenant, weekStart: string, dates: string[]): Promise<PlanCard[]> {
  const input = { start: weekStart, mealType: MEAL_TYPE, dates }
  const ai = await getAiConfig(tenant.householdId)
  if (ai.provider !== 'heuristic' && availability()[ai.provider]) {
    try {
      const out = await planWeek(tenant, input)
      if (out.suggestions.length) return out.suggestions
    } catch (err) {
      console.error('planning meals planWeek failed, shuffling instead', err)
    }
  }
  return (await shuffleWeek(tenant, input)).suggestions
}

const plannedDinner = async (householdId: string, date: string) => {
  const { rows } = await query<{ id: string; recipe_id: string | null; title: string | null }>(
    `select id, recipe_id, title from meal_plan_entries
      where household_id = $1 and date = $2 and meal_type = $3 and deleted_at is null`,
    [householdId, date, MEAL_TYPE]
  )
  return rows[0] ?? null
}

export interface FillResult {
  weekStart: string
  filled: FilledNight[]
  view: MealsStepView
}

// "Plan the rest for me fills only the empties and marks them so you can undo;
// overwriting a set night is a tap on that night." So this writes a dinner for every
// night with none and refuses to touch one that has one — checked once against the
// view and again immediately before each write, because the suggestion round-trip is
// the window in which somebody else's tap could land.
export async function fillEmptyDinners(tenant: Tenant, weekStart: string): Promise<FillResult> {
  const view = await mealsStepView(tenant, weekStart)
  const targets = new Set(view.emptyDates)
  if (!targets.size) return { weekStart, filled: [], view }

  const cards = await suggestFor(tenant, weekStart, [...targets])
  const plan = await getOrCreateActivePlan(tenant)
  const filled: FilledNight[] = []

  for (const card of cards) {
    if (!targets.has(card.date)) continue
    targets.delete(card.date) // one dish per night, however many the model offered

    // The suggestion may name a library recipe; a bogus id degrades to its title
    // rather than 400ing the whole fill.
    let recipeId: string | null = card.recipeId ?? null
    if (recipeId) {
      try {
        await assertRecipeInHousehold(tenant.householdId, recipeId)
      } catch {
        recipeId = null
      }
    }
    // A slot points at ONE thing — the same either/or POST /api/meals/plan enforces.
    const title = recipeId ? null : (card.title ?? '').trim() || null
    if (!recipeId && !title) continue
    if (await plannedDinner(tenant.householdId, card.date)) continue

    const entry = await upsertEntry(plan.id, tenant, {
      date: card.date,
      mealType: MEAL_TYPE,
      recipeId,
      mealId: null,
      title,
      cookPersonId: null,
    })
    // The same mirroring POST /api/meals/plan does — without it an auto-filled dinner
    // would be the one night of the week missing from the calendar.
    await syncMealEventForEntry(tenant, entry.id).catch((err) => console.error('meal event sync failed', err))
    await syncPrepReminderForEntry(tenant, entry.id).catch((err) => console.error('prep reminder sync failed', err))
    filled.push({ date: entry.date, entryId: entry.id, recipeId: entry.recipe_id, title: entry.title })
  }

  if (filled.length) await rebuildGroceries(tenant, weekStart)
  filled.sort((a, b) => a.date.localeCompare(b.date))
  return { weekStart, filled, view: await mealsStepView(tenant, weekStart) }
}

export interface UndoResult {
  weekStart: string
  // Nights actually cleared.
  cleared: string[]
  // Nights left alone because they are no longer what the fill wrote — somebody
  // decided them since, and an undo has no business overwriting a decision.
  kept: string[]
  view: MealsStepView
}

export async function undoFilledDinners(tenant: Tenant, weekStart: string, claims: FilledNight[]): Promise<UndoResult> {
  const weekEnd = addDays(weekStart, 6)
  const cleared: string[] = []
  const kept: string[] = []
  const seen = new Set<string>()

  for (const claim of claims) {
    if (typeof claim?.date !== 'string' || claim.date < weekStart || claim.date > weekEnd) continue
    if (seen.has(claim.date)) continue
    seen.add(claim.date)

    const row = await plannedDinner(tenant.householdId, claim.date)
    if (!row) continue // already gone — nothing to undo and nothing kept
    const same =
      row.id === claim.entryId &&
      (row.recipe_id ?? null) === (claim.recipeId ?? null) &&
      (row.title ?? null) === (claim.title ?? null)
    if (!same) {
      kept.push(claim.date)
      continue
    }
    // Drop the mirror event and thaw reminder BEFORE clearing the slot, in the order
    // DELETE /api/meals/plan uses — they're found by the entry that is about to go.
    await removeMealEventForEntry(tenant.householdId, row.id).catch((err) => console.error('meal event remove failed', err))
    await removePrepReminderForEntry(tenant.householdId, row.id).catch((err) => console.error('prep reminder remove failed', err))
    if (await clearEntry(tenant, claim.date, MEAL_TYPE)) cleared.push(claim.date)
  }

  if (cleared.length) await rebuildGroceries(tenant, weekStart)
  cleared.sort()
  kept.sort()
  return { weekStart, cleared, kept, view: await mealsStepView(tenant, weekStart) }
}

// Whatever came off the wire, shaped into undo claims. A claim naming no date is
// dropped here rather than probed against the plan.
export function parseFilledNights(raw: unknown): FilledNight[] {
  if (!Array.isArray(raw)) return []
  const out: FilledNight[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const c = item as Record<string, unknown>
    if (typeof c.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(c.date)) continue
    out.push({
      date: c.date,
      entryId: typeof c.entryId === 'string' ? c.entryId : '',
      recipeId: typeof c.recipeId === 'string' ? c.recipeId : null,
      title: typeof c.title === 'string' ? c.title : null,
    })
  }
  return out
}
