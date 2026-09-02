import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { mealsApi, planningMealsApi, type Recipe } from '../../../lib/api'
import { isEatingOut } from '../../components/MealsColumn'
import type {
  PlanningMealsView,
  PlanningMealsNight,
  PlanningNightDinner,
  PlanningNightEvent,
  PlanningFilledNight,
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
  recipes: Recipe[] | null
}

const EMPTY: StepState = { key: '', view: null, loading: true, error: null, busy: false, filled: [], autoMarks: [], kept: [], groceryAdded: null, recipes: null }

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
  set({ ...EMPTY, key, recipes: state.recipes })
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
  const view = await planningMealsApi.get(weekStart)
  if (state.key === key) set({ view })
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

async function runFill(weekStart: string, refresh: () => void) {
  if (state.busy) return
  set({ busy: true, error: null, kept: [] })
  const groceriesBefore = state.view?.groceries?.items ?? null
  try {
    const r = await planningMealsApi.fill(weekStart)
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
  if (state.busy) return
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

async function clearNight(weekStart: string, date: string, refresh: () => void) {
  if (state.busy) return
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
  if (d.minutes) return `${d.minutes} min`
  if (out) return 'no cooking'
  return null
}

// "Undo the three" is the design's own phrasing, so small counts read as words.
const WORDS = ['none', 'one', 'two', 'three', 'four', 'five', 'six', 'seven']
const countWord = (n: number) => WORDS[n] ?? String(n)

// ── Body ─────────────────────────────────────────────────────────────────────────

function Body(p: StepBodyProps) {
  const s = useMealsStep(p, true)
  const [editing, setEditing] = useState<string | null>(null)
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

  // The week changed under us — close a modal that names a night in the old one.
  useEffect(() => { setEditing(null) }, [s.key])

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
        </div>
      )}

      {s.kept.length > 0 && (
        <div className="wpm-note">
          {countWord(s.kept.length)} {s.kept.length === 1 ? 'night was' : 'nights were'} left alone — {s.kept.map(dow).join(', ')}{' '}
          {s.kept.length === 1 ? 'has' : 'have'} been decided since.
        </div>
      )}
      {s.error && <div className="wpm-note wpm-note-bad">{s.error}</div>}

      {night && (
        <NightModal
          // Keyed by the night so switching nights starts with a fresh text field
          // rather than carrying the last night's half-typed dish across.
          key={night.date}
          night={night}
          recipes={s.recipes}
          busy={s.busy}
          onClose={() => setEditing(null)}
          onPick={(slot) => { setEditing(null); void planNight(p.weekStart, night.date, slot, p.refresh) }}
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
  const out = !!d && isEatingOut({ recipeId: d.recipeId, title: d.title })
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

// "Overwriting a set night is a tap on that night." Deliberately the smallest thing
// that can be: the library, a free-text dish (leftovers, eating out), and a way to
// empty the slot. The Meals screen is where a week gets built; this is where one night
// gets fixed.
function NightModal({ night, recipes, busy, onClose, onPick, onClear }: {
  night: PlanningMealsNight
  recipes: Recipe[] | null
  busy: boolean
  onClose: () => void
  onPick: (slot: { recipeId?: string | null; title?: string | null }) => void
  onClear: () => void
}) {
  const [title, setTitle] = useState('')

  useEffect(() => {
    if (recipes) return
    let alive = true
    mealsApi.recipes().then((r) => { if (alive) set({ recipes: r.recipes }) }).catch(() => { if (alive) set({ recipes: [] }) })
    return () => { alive = false }
  }, [recipes])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card wpm-modal" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        <div className="wpm-modal-t wf-serif">{dow(night.date)} dinner</div>
        <div className="wpm-modal-s">
          {night.dinner ? `Currently ${night.dinner.title}.` : 'Nothing planned yet.'} {dayNum(night.date)}
        </div>

        <label className="field">
          <span>Something simple</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Leftovers, eating out, breakfast for dinner…"
            onKeyDown={(e) => { if (e.key === 'Enter' && title.trim()) onPick({ title: title.trim(), recipeId: null }) }}
          />
        </label>

        <div className="wpm-modal-h">From your recipes</div>
        <div className="wpm-recipes">
          {recipes === null && <div className="wpm-msg">Loading…</div>}
          {recipes?.length === 0 && <div className="wpm-msg">No recipes yet — type a dish above instead.</div>}
          {recipes?.map((r) => (
            <button key={r.id} type="button" className="wpm-recipe" disabled={busy} onClick={() => onPick({ recipeId: r.id, title: null })}>
              <span aria-hidden>{r.emoji ?? '🍽️'}</span>
              {r.title}
            </button>
          ))}
        </div>

        <div className="wpm-modal-f">
          {night.dinner && (
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClear}>Clear this night</button>
          )}
          <div className="wpm-modal-sp" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy || !title.trim()} onClick={() => onPick({ title: title.trim(), recipeId: null })}>
            Plan it
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
      onClick={() => void runFill(p.weekStart, p.refresh)}
    >
      <span aria-hidden>✨</span> Plan the rest for me
    </button>
  )
}

const mod: PlanningStepModule = { Body, FooterExtra }
export default mod
