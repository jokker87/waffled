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
import { createChore, updateChore, softDeleteChore } from '../../chores/chores.service'
import { groceryBoard, rebuildGroceryFromWeek } from '../../lists/lists.service'
import type { PlanCard } from '../../meals/meals.types'

// The step plans dinners. Breakfast and lunch belong to the Meals screen — a session
// step that asked about twenty-one slots would be a spreadsheet, not a decision.
const MEAL_TYPE = 'dinner'

// A meal's own mirror event (origin='meal_plan') and its thaw reminder
// (origin='meal_prep') are the *output* of this plan, so showing them as the night's
// context would put "Dinner · Pasta bake" directly above the Pasta bake card.
const MIRROR_ORIGINS = new Set(['meal_plan', 'meal_prep'])

// The shopping trip is a REAL chore, so it shows up on the Tasks board as a genuine
// assignment ("Groceries · from the Meals step · Sat 9am") rather than as a label this
// step invented. It gets no table and no column of its own — the chore IS the record.
//
// WHICH chore, then? Identity is server-side and derived, because a crumb on the
// session can't be trusted to be there: it is only persisted when the step is
// ANSWERED, so assigning a shopper and walking away would lose the pointer and the
// next visit would create a second trip. The key is:
//
//   the household's non-deleted, ONE-OFF (rrule is null) chore titled exactly
//   GROCERY_CHORE_TITLE whose single instance is due inside the planned week.
//
// A caller may also pass the `choreId` the view just handed it, which wins when it
// still resolves to a one-off chore of this household — so renaming the chore on the
// Tasks board doesn't orphan it and cause a duplicate. Between the two, revisiting the
// step, changing the shopper and changing the day all land on the same one row.
const GROCERY_CHORE_TITLE = 'Groceries'
const GROCERY_CHORE_EMOJI = '🛒'

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
  // Whether the shopping trip can be assigned at all. Meals is gated on `meals`, not
  // `chores`, so a household with the chores module off gets the plain grocery line
  // and NO control — the same rule that kept an unsourced shopper pill off the bar.
  choresOn: boolean
  // This week's shopping trip, read back off the chore. null ⇒ no trip planned;
  // `personId: null` ⇒ planned but up for grabs, which is a real answer.
  shopping: ShoppingTrip | null
}

export interface ShoppingTrip {
  choreId: string
  personId: string | null
  personName: string | null
  personAvatar: string | null
  personColor: string | null
  dueOn: string
  dueTime: string | null
  status: string
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

const moduleOn = async (householdId: string, key: 'lists' | 'chores'): Promise<boolean> => {
  const { rows } = await query<{ settings: unknown }>(`select settings from households where id = $1`, [householdId])
  return moduleEnabled(rows[0]?.settings, key)
}
const listsOn = (householdId: string) => moduleOn(householdId, 'lists')
const choresOn = (householdId: string) => moduleOn(householdId, 'chores')

const householdTz = async (householdId: string): Promise<string> => {
  const { rows } = await query<{ timezone: string | null }>(`select timezone from households where id = $1`, [householdId])
  return (rows[0]?.timezone ?? '').trim() || 'UTC'
}

// Which of the household's local days an event belongs to. Deliberately the same
// reading as `rangeEvents`' own `(starts_at at time zone h.timezone)::date` filter —
// bucketing in any other zone would drop an evening event off the night it happens on.
const localDay = (at: Date | string, tz: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at))

// This week's shopping trip, if there is one. `hintChoreId` is the id the client last
// saw; it wins when it still names a one-off chore of this household, so a chore
// renamed on the Tasks board is still found. Otherwise the title+week key finds it.
export async function findShoppingTrip(householdId: string, weekStart: string, hintChoreId?: string | null): Promise<ShoppingTrip | null> {
  const weekEnd = addDays(weekStart, 6)
  const { rows } = await query<{
    chore_id: string
    person_id: string | null
    person_name: string | null
    person_avatar: string | null
    person_color: string | null
    due_on: string
    due_time: string | null
    status: string
    is_hint: boolean
  }>(
    `select c.id as chore_id, ci.person_id, p.name as person_name, p.avatar_emoji as person_avatar,
            p.color_hex as person_color, to_char(ci.due_on,'YYYY-MM-DD') as due_on,
            to_char(c.due_time,'HH24:MI') as due_time, ci.status,
            (c.id = $4::uuid) as is_hint
       from chores c
       join chore_instances ci on ci.chore_id = c.id and ci.deleted_at is null
       left join persons p on p.id = ci.person_id and p.deleted_at is null
      where c.household_id = $1 and c.deleted_at is null and c.rrule is null
        and (c.id = $4::uuid or (lower(c.title) = lower($5) and ci.due_on between $2::date and $3::date))
      order by is_hint desc, ci.due_on
      limit 1`,
    [householdId, weekStart, weekEnd, hintChoreId && UUID_RE.test(hintChoreId) ? hintChoreId : null, GROCERY_CHORE_TITLE]
  )
  const r = rows[0]
  if (!r) return null
  return {
    choreId: r.chore_id,
    personId: r.person_id,
    personName: r.person_name,
    personAvatar: r.person_avatar,
    personColor: r.person_color,
    dueOn: r.due_on,
    dueTime: r.due_time,
    status: r.status,
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The seven columns for `weekStart`: that night's calendar events, then its dinner.
export async function mealsStepView(tenant: Tenant, weekStart: string, hintChoreId?: string | null): Promise<MealsStepView> {
  const weekEnd = addDays(weekStart, 6)
  const [entries, events, tz, groceries, chores] = await Promise.all([
    weekEntries(tenant.householdId, weekStart, 7),
    rangeEvents(tenant.householdId, weekStart, weekEnd, tenant.personId ?? null),
    householdTz(tenant.householdId),
    groceryLine(tenant, weekStart),
    choresOn(tenant.householdId),
  ])
  // Only read the trip when the module that owns it is on — otherwise the bar shows
  // the plain line and the control is absent rather than dead.
  const shopping = chores ? await findShoppingTrip(tenant.householdId, weekStart, hintChoreId) : null

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
    choresOn: chores,
    shopping,
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
//
// `chosen` is a week the family already APPROVED — the cards the shared "Plan my
// week" planner (apps/web/src/kiosk/components/PlanWeek.tsx) drafted and they hit
// "Add week" on. Passing them here rather than applying them through
// POST /api/meals/plan is what keeps the fill's two guarantees intact: only the empty
// nights are written, and the caller gets back the `FilledNight` receipt the undo
// guard checks (the stored title is deliberately not on the view's wire, so a client
// cannot build a trustworthy claim of its own).
//
// Without `chosen` this still drafts for itself — the headless fill, which is what
// iOS parity and any non-interactive caller needs.
export async function fillEmptyDinners(tenant: Tenant, weekStart: string, chosen?: PlanCard[] | null): Promise<FillResult> {
  const view = await mealsStepView(tenant, weekStart)
  const targets = new Set(view.emptyDates)
  if (!targets.size) return { weekStart, filled: [], view }

  const cards = chosen ?? (await suggestFor(tenant, weekStart, [...targets]))
  const plan = await getOrCreateActivePlan(tenant)
  const filled: FilledNight[] = []

  for (const card of cards) {
    if (!targets.has(card.date)) continue
    // This step plans DINNERS. A card naming another meal is dropped rather than
    // quietly rewritten into a dinner — silently moving somebody's lunch to 6pm is
    // worse than not planning it.
    if (card.mealType && card.mealType !== MEAL_TYPE) continue
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

// ── The shopping trip ────────────────────────────────────────────────────────────

export class ShoppingDayOutOfWeekError extends Error {
  statusCode = 400
  constructor() {
    super('the shopping day must be inside the week being planned')
    this.name = 'BadRequest'
  }
}

export interface ShoppingTripInput {
  // The day of the trip. null ⇒ there is no trip: the chore is removed rather than
  // left behind as an orphan on somebody's Tasks board.
  dueOn: string | null
  // Who's going. null ⇒ up for grabs, which is a real answer — the same thing the
  // Tasks step means by "nobody".
  personId: string | null
  dueTime: string | null
  // The chore id the client last saw, so a chore renamed on the Tasks board is still
  // recognised as this week's trip.
  choreId: string | null
}

export interface ShoppingResult {
  weekStart: string
  shopping: ShoppingTrip | null
  view: MealsStepView
}

// Create, move, reassign or remove the week's shopping trip — always the SAME chore.
// Every path here goes through the chores service (createChore / updateChore /
// softDeleteChore); the one direct write is moving the pending instance's due_on,
// which updateChore has no field for and which mirrors what it already does to
// instances when the assignee changes.
export async function setShoppingTrip(tenant: Tenant, weekStart: string, input: ShoppingTripInput): Promise<ShoppingResult> {
  const weekEnd = addDays(weekStart, 6)
  const existing = await findShoppingTrip(tenant.householdId, weekStart, input.choreId)

  // No day ⇒ no trip. Clearing removes the chore instead of leaving one nobody
  // planned sitting on the board.
  if (!input.dueOn) {
    if (existing) await softDeleteChore(tenant.householdId, existing.choreId)
    return finish(tenant, weekStart, null)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dueOn) || input.dueOn < weekStart || input.dueOn > weekEnd) {
    // Silently moving somebody's shopping day would be worse than refusing it.
    throw new ShoppingDayOutOfWeekError()
  }

  if (!existing) {
    const chore = await createChore(tenant, {
      title: GROCERY_CHORE_TITLE,
      emoji: GROCERY_CHORE_EMOJI,
      personId: input.personId,
      dueOn: input.dueOn,
      dueTime: input.dueTime,
      rrule: null,
      // A shopping trip that didn't happen still needs doing, so it carries forward.
      rollover: true,
    })
    return finish(tenant, weekStart, chore.id)
  }

  // Reassigning follows through to the pending instance inside updateChore.
  if (existing.personId !== input.personId || existing.dueTime !== input.dueTime) {
    await updateChore(tenant.householdId, existing.choreId, { personId: input.personId, dueTime: input.dueTime })
  }
  // Moving the day. Only a PENDING instance moves: a trip somebody already did is
  // history, and rewriting its date would say the shopping happened on a day it
  // didn't. The (chore_id, due_on) unique index is safe here — a one-off has one.
  if (existing.dueOn !== input.dueOn) {
    await query(
      `update chore_instances set due_on = $3::date
        where household_id = $1 and chore_id = $2 and deleted_at is null and status = 'pending'`,
      [tenant.householdId, existing.choreId, input.dueOn]
    )
  }
  return finish(tenant, weekStart, existing.choreId)
}

async function finish(tenant: Tenant, weekStart: string, choreId: string | null): Promise<ShoppingResult> {
  const view = await mealsStepView(tenant, weekStart, choreId)
  return { weekStart, shopping: view.shopping, view }
}

// The approved week off the wire, shaped into plan cards. Only the four fields the
// fill actually writes are read — the rest of a PlanCard is display, and trusting a
// client's `servings` or `note` would be storing a claim nobody checks.
export function parsePlanCards(raw: unknown): PlanCard[] | null {
  if (!Array.isArray(raw)) return null
  const out: PlanCard[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const c = item as Record<string, unknown>
    if (typeof c.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(c.date)) continue
    out.push({
      date: c.date,
      mealType: typeof c.mealType === 'string' ? c.mealType : MEAL_TYPE,
      title: typeof c.title === 'string' ? c.title : '',
      recipeId: typeof c.recipeId === 'string' && c.recipeId ? c.recipeId : null,
      emoji: null,
      minutes: null,
      servings: 0,
      note: null,
    })
  }
  return out
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
