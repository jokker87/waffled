import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { mealBuilderApi, mealsApi, personsApi, planningMealsApi, useRecipes, type Meal, type Person } from '../../../lib/api'
import { isEatingOut } from '../../components/MealsColumn'
import { PlanWeek } from '../../components/PlanWeek'
import { RecipeBrowser } from '../../components/RecipeBrowser'
import type {
  PlanCard,
  PlanningMealsView,
  PlanningMealsNight,
  PlanningNightDinner,
  PlanningNightEvent,
  PlanningFilledNight,
  PlanningShoppingTrip,
} from '../../../lib/api'
import type { PlanningStepModule, StepBodyProps } from '../registry'
import '../../../styles/planning-meals.css'

// Step 7 · Meals — "Same seven columns as Calendar, so it reads as the same week. Each
// night shows the events above the dish, because that's the only context that matters
// here. The plan already in the app is shown as-is. Plan the rest for me fills only the
// empties and marks them so you can undo; overwriting a set night is a tap on that
// night. Groceries stay one line — they already build themselves."
//
// The step OWNS NO DATA. Everything on screen is the existing meal plan, and both edits
// go through the endpoints the Meals screen already uses; the only thing the session
// records is a crumb (which nights were auto-filled), set via `setDecisionData`.
//
// WHY THERE IS A STORE IN THIS FILE. The shell renders `Body` in the body and
// `FooterExtra` in the footer — two sibling trees — and the footer's fill is what marks
// nights in the body. A context provider would mean editing the shell, so the state
// lives here, module-scoped and keyed by session+week so stepping to another week (or
// discarding the session) can't leave a previous week's marks behind.

const MEAL_TYPE = 'dinner'

interface StepState {
  key: string
  view: PlanningMealsView | null
  loading: boolean
  error: string | null
  busy: boolean
  // The auto-filled nights that are STILL undoable, each carrying the proof the server
  // checks — the fill's own receipt. A night decided by hand since drops out of here.
  //
  // ONLY the fill can put something here. It is tempting to rebuild these from the
  // session crumb on a revisit, but a claim rebuilt from the current view proves
  // nothing: it would be compared against the very row it was read from, so the guard
  // would always pass and "Undo the three" would happily clear a night somebody had
  // deliberately changed in the meantime.
  filled: PlanningFilledNight[]
  // Display only: nights the crumb says were auto-filled at some point. They keep
  // their ✨ mark across a revisit; they do not make the undo live.
  autoMarks: string[]
  // "…and 1 night was left alone" after an undo that hit a since-decided night.
  kept: string[]
  // How many rows the last fill put on the grocery list, so the one line can say what
  // just happened rather than only what is there. Measured, not claimed: the item
  // count before the fill against the count after.
  groceryAdded: number | null
  // The household, for the shopper picker. Loaded on demand.
  people: Person[] | null
  // Whether the shared "Plan my week" planner is open over the step. It lives HERE
  // and not in a `useState` because the button that opens it is in `FooterExtra` and
  // the planner renders from `Body` — two sibling trees, same store.
  planner: boolean
}

const EMPTY: StepState = { key: '', view: null, loading: true, error: null, busy: false, filled: [], autoMarks: [], kept: [], groceryAdded: null, people: null, planner: false }

let state: StepState = EMPTY
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const snapshot = () => state
function set(patch: Partial<StepState>) {
  state = { ...state, ...patch }
  for (const l of [...listeners]) l()
}

// The crumb the session kept from a previous visit: dates only. Anything else in there
// is somebody else's shape, so it is read defensively rather than trusted.
function crumbDates(data: Record<string, unknown> | undefined): string[] {
  const raw = data?.autoFilled
  if (!Array.isArray(raw)) return []
  return raw.filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
}

async function load(key: string, weekStart: string, seed: string[]) {
  set({ ...EMPTY, key, people: state.people })
  try {
    const view = await planningMealsApi.get(weekStart)
    if (state.key !== key) return // a later week won the race
    // The crumb restores the MARKS (a night that is still planned), never the undo:
    // see `filled` above for why a rebuilt claim can't be trusted.
    const stillPlanned = new Set(view.nights.filter((n) => n.dinner).map((n) => n.date))
    set({ view, loading: false, autoMarks: seed.filter((d) => stillPlanned.has(d)) })
  } catch {
    if (state.key !== key) return
    set({ loading: false, error: "Couldn't read this week's meals — reload and try again." })
  }
}

async function reread(weekStart: string) {
  const key = state.key
  // Pass the trip's chore id back: it is what keeps a chore renamed on the Tasks
  // board recognised as this week's trip instead of spawning a second one.
  const view = await planningMealsApi.get(weekStart, state.view?.shopping?.choreId ?? null)
  if (state.key === key) set({ view })
}

async function setShopper(weekStart: string, t: { dueOn: string | null; personId: string | null; dueTime: string | null }, refresh: () => void) {
  if (state.busy) return
  set({ busy: true, error: null })
  try {
    const r = await planningMealsApi.setShopper(weekStart, { ...t, choreId: state.view?.shopping?.choreId ?? null })
    set({ view: r.view, busy: false })
  } catch {
    set({ busy: false, error: "That didn't take — try again." })
  }
  refresh()
}

// A date is settled by hand (or taken back): it is no longer an auto-fill, in either
// the live receipt or the restored marks.
const forget = (date: string) => ({
  filled: state.filled.filter((f) => f.date !== date),
  autoMarks: state.autoMarks.filter((d) => d !== date),
})

// Both components read the same state; `primary` (only Body passes it) says which one
// owns the fetching, so a remount doesn't fire two reads. The store outlives the
// components, so coming back to the step with the same session and week refreshes the
// columns rather than showing what they were when you left.
function useMealsStep(p: StepBodyProps, primary = false): StepState {
  const key = `${p.sessionId}|${p.weekStart}`
  const seed = useMemo(() => crumbDates(p.step.data), [p.step.data])
  useEffect(() => {
    if (state.key !== key) void load(key, p.weekStart, seed)
    else if (primary && !state.loading) void reread(p.weekStart).catch(() => { /* the columns simply stay as they were */ })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return useSyncExternalStore(subscribe, snapshot)
}

// ── The two writes the footer drives ─────────────────────────────────────────────

// The week the family approved in the planner, applied. It goes through the step's
// own fill endpoint rather than the planner's usual per-slot writes for the two
// things only that endpoint can do: refuse a night somebody already decided, and
// hand back the receipt the undo checks (see `filled` above — a claim the client
// rebuilt from the view proves nothing).
async function applyPlan(weekStart: string, cards: PlanCard[], refresh: () => void) {
  // The planner closes as soon as this resolves, so bailing out quietly would report
  // a week that was never written. Another write being in flight (a shopper being
  // assigned, a night being planned) is the only way here, and it has to SAY so.
  if (state.busy) {
    set({ error: "Something else was still saving — the week wasn't planned. Try again." })
    return
  }
  set({ busy: true, error: null, kept: [] })
  const groceriesBefore = state.view?.groceries?.items ?? null
  try {
    const r = await planningMealsApi.fill(weekStart, cards)
    const fresh = new Set(r.filled.map((f) => f.date))
    const after = r.view.groceries?.items ?? null
    const added = groceriesBefore !== null && after !== null ? after - groceriesBefore : null
    set({
      view: r.view,
      busy: false,
      filled: [...state.filled.filter((f) => !fresh.has(f.date)), ...r.filled].sort((a, b) => a.date.localeCompare(b.date)),
      // These nights now carry a live receipt, so they don't need the restored mark.
      autoMarks: state.autoMarks.filter((d) => !fresh.has(d)),
      groceryAdded: r.filled.length && added !== null && added > 0 ? added : null,
    })
  } catch {
    set({ busy: false, error: "That didn't take — try again." })
  }
  refresh()
}

async function runUndo(weekStart: string, refresh: () => void) {
  if (state.busy || !state.filled.length) return
  set({ busy: true, error: null, kept: [], groceryAdded: null })
  try {
    const r = await planningMealsApi.undo(weekStart, state.filled)
    // A night in `kept` was decided by hand since the fill — it is no longer an
    // auto-fill, so it leaves the undoable set without being cleared.
    const settled = new Set([...r.cleared, ...r.kept])
    set({
      view: r.view,
      busy: false,
      kept: r.kept,
      filled: state.filled.filter((f) => !settled.has(f.date)),
      autoMarks: state.autoMarks.filter((d) => !settled.has(d)),
    })
  } catch {
    set({ busy: false, error: "That didn't take — try again." })
  }
  refresh()
}

// ── A night, decided by hand ─────────────────────────────────────────────────────
// Through /api/meals/plan and /api/meals/plan?date=…, exactly as the Meals screen
// does. Deciding a night by hand also stops it being an auto-fill.

async function planNight(weekStart: string, date: string, slot: { recipeId?: string | null; title?: string | null }, refresh: () => void) {
  // The picker has already closed by the time this runs, so a quiet return would
  // report a night that was never planned. Only another write in flight gets here.
  if (state.busy) {
    set({ error: "Something else was still saving — that night wasn't planned. Try again." })
    return
  }
  set({ busy: true, error: null })
  try {
    await mealsApi.planSlot({ date, mealType: MEAL_TYPE, ...slot })
    set({ ...forget(date), kept: [], groceryAdded: null })
    await reread(weekStart)
    set({ busy: false })
  } catch {
    set({ busy: false, error: "That didn't take — try again." })
  }
  refresh()
}

// A night can also be a PLATE — one of the household's saved meals, dropped whole
// onto the night. It cannot go through `planSlot` with the other four: a plate is
// scheduled by POST /api/meals/:id/schedule, which is where the copy-on-schedule
// lives (editing next week's BBQ Sunday must not rewrite the one that already went
// out). That endpoint writes through the SAME `upsertEntry` the fill uses and fires
// the same mirror-event and prep-reminder syncs, so a plate night is an ordinary
// planned night in every way the rest of this step cares about — including the undo,
// which now compares meal_id.
async function planPlate(weekStart: string, date: string, mealId: string, refresh: () => void) {
  if (state.busy) {
    set({ error: "Something else was still saving — that night wasn't planned. Try again." })
    return
  }
  set({ busy: true, error: null })
  try {
    await mealBuilderApi.schedule(mealId, { date, mealType: MEAL_TYPE })
    set({ ...forget(date), kept: [], groceryAdded: null })
    await reread(weekStart)
    set({ busy: false })
  } catch {
    set({ busy: false, error: "That didn't take — try again." })
  }
  refresh()
}

async function clearNight(weekStart: string, date: string, refresh: () => void) {
  if (state.busy) {
    set({ error: "Something else was still saving — that night wasn't cleared. Try again." })
    return
  }
  set({ busy: true, error: null })
  try {
    await mealsApi.clearSlot(date, MEAL_TYPE)
    set({ ...forget(date), kept: [], groceryAdded: null })
    await reread(weekStart)
    set({ busy: false })
  } catch {
    set({ busy: false, error: "That didn't take — try again." })
  }
  refresh()
}

// ── Formatting ───────────────────────────────────────────────────────────────────
// Noon, not midnight: a bare YYYY-MM-DD parses as UTC and would render the previous
// weekday west of Greenwich. Matches PlanWeek.tsx.
const at = (date: string) => new Date(`${date}T12:00:00`)
const dow = (date: string) => at(date).toLocaleDateString(undefined, { weekday: 'short' })
const dayNum = (date: string) => at(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
const clock = (e: PlanningNightEvent) =>
  e.allDay ? 'All day' : new Date(e.startsAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

// The dish tile's attribution line, in order of how much the app actually knows:
// who's cooking (real, from cook_person_id) → that the app picked the night → how long
// the recipe takes → that a takeout night involves no cooking. The design puts a short
// free-text note here on some nights ("uses the beef", "after the party"), but those
// are the LLM suggestion's `note` and nothing persists them, so they are not faked.
function attribution(d: PlanningNightDinner, auto: boolean, out: boolean): ReactNode {
  if (d.cookName) {
    return (
      <>
        <span aria-hidden>{d.cookAvatar ?? '👤'}</span> {d.cookName}
      </>
    )
  }
  if (auto) return 'the app picked this'
  // A plate has no recipe to read a time off, so the honest line is what it IS —
  // several dishes cooked together, not a single dish with unknown timings.
  if (d.mealId) return 'a whole plate'
  if (d.minutes) return `${d.minutes} min`
  if (out) return 'no cooking'
  return null
}

// The shopper pill. Assigned it names the person; planned but unassigned it says so,
// because leaving the trip up for grabs is a real answer and not a blank.
function tripLabel(t: PlanningShoppingTrip | null): string {
  if (!t) return "Who's shopping?"
  const when = `${dow(t.dueOn)}${t.dueTime ? ` ${t.dueTime}` : ''}`
  if (!t.personName) return `Up for grabs · ${when}`
  return `${t.personAvatar ?? '\u{1F464}'} ${t.personName} shops ${when}`
}

// "Undo the three" is the design's own phrasing, so small counts read as words.
const WORDS = ['none', 'one', 'two', 'three', 'four', 'five', 'six', 'seven']
const countWord = (n: number) => WORDS[n] ?? String(n)

// ── Body ─────────────────────────────────────────────────────────────────────────

function Body(p: StepBodyProps) {
  const s = useMealsStep(p, true)
  const [editing, setEditing] = useState<string | null>(null)
  const [shopping, setShopping] = useState(false)
  // A night is marked whether its ✨ came from this session's fill or from the crumb
  // of an earlier visit — the mark says "the app picked this", which stays true.
  const autoDates = useMemo(
    () => new Set([...s.filled.map((f) => f.date), ...s.autoMarks]),
    [s.filled, s.autoMarks]
  )

  // The crumb the session record keeps: which nights the app picked. Dates only — the
  // recap reads the plan itself, so a copy here could only ever disagree with it.
  useEffect(() => {
    const dates = [...autoDates].sort()
    p.setDecisionData(dates.length ? { autoFilled: dates } : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoDates])

  // The week changed under us — close a modal that names a night in the old one,
  // and the planner, which was drafting the week we just left.
  useEffect(() => { setEditing(null); setShopping(false); if (state.planner) set({ planner: false }) }, [s.key])

  // The nights the planner is allowed to touch. Noon-local, like every other date on
  // this screen: a bare YYYY-MM-DD parses as UTC and PlanWeek reads the day back with
  // local getters, which west of Greenwich would offer the wrong weekday.
  const emptyDays = useMemo(() => (s.view?.emptyDates ?? []).map(at), [s.view?.emptyDates])

  if (s.loading) return <div className="wpm-msg">Reading the week…</div>
  if (!s.view) return <div className="wpm-msg">{s.error ?? "Couldn't read this week's meals."}</div>

  const night = editing ? s.view.nights.find((n) => n.date === editing) ?? null : null

  return (
    <div className="wpm">
      <div className="wpm-week">
        {s.view.nights.map((n) => (
          <NightColumn key={n.date} night={n} auto={autoDates.has(n.date)} disabled={p.busy || s.busy} onOpen={() => setEditing(n.date)} />
        ))}
      </div>

      {/* Groceries stay ONE LINE: the board already builds itself from this plan, and
          a panel here would re-litigate a screen that already exists. The sub-note
          says where the list came from; the pill says what's on it. */}
      {s.view.groceries && (
        <div className="wpm-gro">
          <span className="wpm-gro-i" aria-hidden>🛒</span>
          <div className="wpm-gro-m">
            <b>Groceries</b>
            <span className="wpm-gro-s">
              {s.groceryAdded !== null
                ? `${s.groceryAdded} items added · staples skipped`
                : "built from what's planned so far · staples skipped"}
            </span>
          </div>
          <span className="wpm-gro-pill">
            {s.view.groceries.items} items · aisle order
            {s.view.groceries.checked > 0 ? ` · ${s.view.groceries.checked} ticked` : ''}
          </span>
          {/* The shopper pill is only here because the trip is REAL — a one-off chore
              that shows on the Tasks board as "Groceries · from the Meals step". With
              the chores module off there is nowhere for it to live, so the control
              goes away rather than sitting there dead. */}
          {s.view.choresOn && (
            <button
              type="button"
              className={`wpm-gro-pill wpm-shop${s.view.shopping ? '' : ' open'}`}
              disabled={p.busy || s.busy}
              onClick={() => setShopping(true)}
            >
              {tripLabel(s.view.shopping)}
            </button>
          )}
        </div>
      )}

      {shopping && s.view.choresOn && (
        <ShopperModal
          weekStart={p.weekStart}
          nights={s.view.nights}
          trip={s.view.shopping}
          people={s.people}
          busy={s.busy}
          onClose={() => setShopping(false)}
          onSave={(t) => { setShopping(false); void setShopper(p.weekStart, t, p.refresh) }}
        />
      )}

      {s.kept.length > 0 && (
        <div className="wpm-note">
          {countWord(s.kept.length)} {s.kept.length === 1 ? 'night was' : 'nights were'} left alone — {s.kept.map(dow).join(', ')}{' '}
          {s.kept.length === 1 ? 'has' : 'have'} been decided since.
        </div>
      )}
      {s.error && <div className="wpm-note wpm-note-bad">{s.error}</div>}

      {/* "Plan the rest for me" opens the planner the Meals screen already has —
          the guardrails, the preferences box, reshuffle, swap and lock — rather than
          a second, worse one. It is narrowed to this step's promise in two ways: the
          only day chips are the EMPTY nights, and applying hands the approved cards
          to the step's own fill endpoint, which is what keeps them marked, undoable
          and unable to overwrite a night somebody already decided. */}
      {s.planner && (
        <div className="wpm-planner" role="dialog" aria-label="Plan the rest of the week">
          <div className="wpm-planner-head">
            <button type="button" className="pill wpm-planner-back" onClick={() => set({ planner: false })}>
              ‹ Back to the week
            </button>
            <span className="wpm-planner-n">
              Planning the {countWord(emptyDays.length)} empty {emptyDays.length === 1 ? 'night' : 'nights'} — the rest stay as they are
            </span>
          </div>
          <PlanWeek
            startStr={p.weekStart}
            days={emptyDays}
            initialDays={s.view.emptyDates}
            mealTypes={['dinner']}
            onClose={() => set({ planner: false })}
            onApplied={() => {}}
            onApply={(cards) => applyPlan(p.weekStart, cards, p.refresh)}
          />
        </div>
      )}

      {/* Never both: the two overlays are the same surface, and the planner is the
          one that was opened from a footer the picker would be covering. */}
      {night && !s.planner && (
        <NightPicker
          // Keyed by the night so switching nights starts on a fresh search rather
          // than carrying the last night's half-typed query across.
          key={night.date}
          night={night}
          onClose={() => setEditing(null)}
          // Close FIRST, write second: `planNight` refuses to run while another
          // write is in flight, and a picker still on screen would invite the second
          // tap that hits exactly that.
          onPick={(slot) => { setEditing(null); void planNight(p.weekStart, night.date, slot, p.refresh) }}
          onPickMeal={(meal) => { setEditing(null); void planPlate(p.weekStart, night.date, meal.id, p.refresh) }}
          onClear={() => { setEditing(null); void clearNight(p.weekStart, night.date, p.refresh) }}
        />
      )}
    </div>
  )
}

// The dish tile has four states and each has to be legible at a glance across seven
// columns: planned, empty, auto-filled, and eating out. `isEatingOut` is the classifier
// the Meals screen already uses on recipe-less placeholder rows — the same night must
// not read as takeout on one screen and a cooked dinner on another.
function NightColumn({ night, auto, disabled, onOpen }: {
  night: PlanningMealsNight
  auto: boolean
  disabled: boolean
  onOpen: () => void
}) {
  const d = night.dinner
  // A PLATE IS NEVER TAKEOUT. `isEatingOut` reads a recipe-less row's title, and a
  // plate is recipe-less with the plate's NAME as its title — so a plate somebody
  // called "Takeout Tuesday" would wear the takeout tile and claim "no cooking".
  // `!recipeId && mealId` is the plate branch MealsColumn checks first; same here.
  const out = !!d && !d.mealId && isEatingOut({ recipeId: d.recipeId, title: d.title })
  const cls = d ? (auto ? ' auto' : out ? ' out' : '') : ' empty'
  const attrib = d ? attribution(d, auto, out) : null
  return (
    <div className="wpm-night">
      <div className="wpm-night-h">
        <b>{dow(night.date)}</b>
        <span>{dayNum(night.date)}</span>
      </div>

      {/* The events come FIRST — on this screen they are the reason a night is easy
          or hard, and nothing else about the day matters here. */}
      <ul className="wpm-events">
        {night.events.map((e) => (
          <li key={e.id} className="wpm-ev">
            <i className="wpm-ev-dot" style={e.personColor ? { background: e.personColor } : undefined} aria-hidden />
            <span className="wpm-ev-t">{e.title}</span>
            <span className="wpm-ev-c">{clock(e)}</span>
          </li>
        ))}
        {!night.events.length && <li className="wpm-ev wpm-ev-none">Nothing on</li>}
      </ul>

      <button
        type="button"
        className={`wpm-dish${cls}`}
        disabled={disabled}
        onClick={onOpen}
        aria-label={d ? `${d.title} on ${dow(night.date)} — change it` : `Plan ${dow(night.date)}`}
      >
        {d ? (
          <>
            <span className="wpm-dish-e" aria-hidden>{d.emoji ?? (out ? '🥡' : '🍽️')}</span>
            <span className="wpm-dish-t">{d.title}</span>
            {/* The attribution line. A cook is REAL data (cook_person_id); the mock's
                free-text notes ("uses the beef") are the LLM suggestion's `note`,
                which the plan doesn't store — so the fallback is what the recipe
                itself knows rather than an invented sentence. */}
            {attrib && <span className="wpm-dish-c">{attrib}</span>}
            {auto && <span className="wpm-auto">✨ auto</span>}
          </>
        ) : (
          <>
            <span className="wpm-dish-plus" aria-hidden>+</span>
            <span className="wpm-dish-t">Nothing planned</span>
          </>
        )}
      </button>
    </div>
  )
}

// "Overwriting a set night is a tap on that night." What that tap opens is the app's
// OWN recipe browser — the same `RecipeBrowser` behind the Meals screen's "Add a
// dinner · Sun Aug 30" screen, PlanMonth's manual swap and Cook-from-pantry. It was
// always the right component; this step drew a flat chip list instead, which worked
// at one recipe and fell apart at fifty: a search that only narrowed a wrapping row
// of pills, no meal-type tabs, no View, no way to write a recipe without leaving, and
// a free-text field approximating the three recipe-less nights the browser already
// has proper cards for.
//
// FULL-SCREEN over the step rather than inside the 520px modal, because the browser
// IS a four-up card grid with its own search and filter rows — and because a night
// picked here should look like a night picked on the Meals screen.
//
// THE THREE PLACEHOLDER CARDS are the point of the swap. "Eating out", "Leftovers"
// and "Try something new" write exactly the literals Meals.tsx writes, which are
// exactly what `isEatingOut` / `isLeftovers` / `isTryNew` classify — so a night
// planned here and the same night planned on the Meals screen are the same row, and
// the dish tile's `out` state above keeps agreeing with the rest of the app.
//
// The library still comes through `useRecipes` — the hook fetches when the picker
// mounts and refetches on the `recipes` bus topic. That is deliberate and must stay:
// It must NOT be cached in this file's module state behind `if (recipes) return`: an EMPTY
// library is a truthy `[]`, so a household that opened the picker before adding its first recipe
// would be told "no recipes yet" for the rest of the page's life.
function NightPicker({ night, onClose, onPick, onPickMeal, onClear }: {
  night: PlanningMealsNight
  onClose: () => void
  onPick: (slot: { recipeId?: string | null; title?: string | null }) => void
  onPickMeal: (meal: Meal) => void
  onClear: () => void
}) {
  const { recipes, loading, error } = useRecipes()

  return (
    <div className="wpm-picker" role="dialog" aria-label={`Plan ${dow(night.date)} dinner`}>
      <div className="wpm-picker-head">
        <button type="button" className="pill wpm-planner-back" onClick={onClose}>‹ Back to the week</button>
        <span className="wpm-picker-t wf-serif">{dow(night.date)} dinner · {dayNum(night.date)}</span>
        <span className="wpm-picker-n">
          {error
            ? "Couldn't read your recipes — reload and try again."
            : night.dinner
              ? `Currently ${night.dinner.title}`
              : 'Nothing planned yet'}
        </span>
        {/* Emptying the slot has nowhere else to live once the body is the browser,
            so it sits with the night it is about rather than in the grid. */}
        {night.dinner && (
          <button type="button" className="btn btn-ghost wpm-picker-clear" onClick={onClear}>Clear this night</button>
        )}
      </div>
      <RecipeBrowser
        recipes={recipes}
        loading={loading}
        // Dinner is what this step plans, so the browser opens on the dinner tab —
        // which still shows every untagged recipe, and "All" is one tap away.
        slot="dinner"
        onPick={(r) => onPick({ recipeId: r.id, title: null })}
        // Plates only appear when a caller can say WHERE one goes — the date lives
        // in this closure, never in the browser. Supplying it is the whole of plate
        // parity: the grid then lists the household's saved meals beside its
        // recipes, searched server-side, exactly as the Meals screen's picker does.
        onPickMeal={onPickMeal}
        // The same three literals the Meals screen writes, so the classifiers that
        // render them agree across both screens.
        onEatingOut={() => onPick({ title: 'Eating out', recipeId: null })}
        onLeftovers={() => onPick({ title: 'Leftovers', recipeId: null })}
        onTrySomething={() => onPick({ title: 'Try something new', recipeId: null })}
        // KEPT, and only this: the three cards cover the canonical recipe-less
        // nights and "＋ New recipe" covers "put it in my library", but neither
        // covers the one-off named dish nobody wants to write a recipe for —
        // "Grandma's lasagne", "breakfast for dinner", which the step's own design
        // copy names. It rides the browser's search box, so there is still one field.
        onFreeText={(text) => onPick({ title: text, recipeId: null })}
        // Names the night on the View preview's confirm button. The grid cards say
        // plain "Select" — that's the browser's own copy and the Meals screen's too,
        // so it is deliberately left alone rather than diverged here.
        selectLabel={`Plan for ${dow(night.date)}`}
      />
    </div>
  )
}

// Who's shopping, and when. Saving writes a real one-off chore, so this is the same
// decision the Tasks step would make — taken here because this is where you can see
// what the week needs bought.
function ShopperModal({ weekStart, nights, trip, people, busy, onClose, onSave }: {
  weekStart: string
  nights: PlanningMealsNight[]
  trip: PlanningShoppingTrip | null
  people: Person[] | null
  busy: boolean
  onClose: () => void
  onSave: (t: { dueOn: string | null; personId: string | null; dueTime: string | null }) => void
}) {
  const [personId, setPersonId] = useState<string | null>(trip?.personId ?? null)
  // Default to the last night of the week: a trip that hasn't been decided is more
  // useful pencilled in than blank, and the day is one tap to change.
  const [dueOn, setDueOn] = useState<string>(trip?.dueOn ?? nights[nights.length - 1]?.date ?? weekStart)
  const [dueTime, setDueTime] = useState<string>(trip?.dueTime ?? '')

  useEffect(() => {
    if (people) return
    let alive = true
    personsApi.persons().then((r) => { if (alive) set({ people: r.persons }) }).catch(() => { if (alive) set({ people: [] }) })
    return () => { alive = false }
  }, [people])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card wpm-modal" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        <div className="wpm-modal-t wf-serif">The shopping trip</div>
        <div className="wpm-modal-s">
          It lands on the Tasks board as a real assignment — leaving it up for grabs is a real answer.
        </div>

        <div className="wpm-modal-h">Who's going</div>
        <div className="wpm-picks">
          <button
            type="button"
            className={`wpm-pick${personId === null ? ' on' : ''}`}
            onClick={() => setPersonId(null)}
          >
            Up for grabs
          </button>
          {people === null && <div className="wpm-msg">Loading…</div>}
          {people?.map((pp) => (
            <button
              key={pp.id}
              type="button"
              className={`wpm-pick${personId === pp.id ? ' on' : ''}`}
              onClick={() => setPersonId(pp.id)}
            >
              <span aria-hidden>{pp.avatarEmoji ?? '\u{1F464}'}</span> {pp.name}
            </button>
          ))}
        </div>

        <div className="wpm-modal-h">Which day</div>
        <div className="wpm-picks">
          {nights.map((n) => (
            <button
              key={n.date}
              type="button"
              className={`wpm-pick${dueOn === n.date ? ' on' : ''}`}
              onClick={() => setDueOn(n.date)}
            >
              {dow(n.date)}
            </button>
          ))}
        </div>

        <label className="field">
          <span>What time (optional)</span>
          <input type="time" value={dueTime} onChange={(e) => setDueTime(e.target.value)} />
        </label>

        <div className="wpm-modal-f">
          {trip && (
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => onSave({ dueOn: null, personId: null, dueTime: null })}>
              No trip this week
            </button>
          )}
          <div className="wpm-modal-sp" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            type="button" className="btn btn-primary" disabled={busy}
            onClick={() => onSave({ dueOn, personId, dueTime: dueTime || null })}
          >
            {trip ? 'Update the trip' : 'Add it to Tasks'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── FooterExtra ──────────────────────────────────────────────────────────────────
// One control, in the footer beside Skip and the affirmative — and it is the SAME slot
// before and after: "Plan the rest for me" becomes "Undo the three".

function FooterExtra(p: StepBodyProps) {
  const s = useMealsStep(p)
  if (!s.view) return null
  const disabled = p.busy || s.busy

  if (s.filled.length) {
    return (
      <button type="button" className="btn btn-ghost wpm-act" disabled={disabled} onClick={() => void runUndo(p.weekStart, p.refresh)}>
        Undo the {countWord(s.filled.length)}
      </button>
    )
  }

  const empties = s.view.emptyDates.length
  return (
    <button
      type="button"
      className="btn btn-ai wpm-act"
      disabled={disabled || !empties}
      title={empties ? `Fills the ${countWord(empties)} empty ${empties === 1 ? 'night' : 'nights'}` : 'Every night is planned'}
      // Opens the week planner rather than drafting silently: the same screen the
      // Meals tab uses, so the guardrails and the preferences box are here too.
      onClick={() => set({ planner: true })}
    >
      <span aria-hidden>✨</span> Plan the rest for me
    </button>
  )
}

const mod: PlanningStepModule = { Body, FooterExtra }
export default mod
