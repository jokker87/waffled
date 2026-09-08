import { useEffect, useState, useSyncExternalStore } from 'react'
import { avTint } from '../../components/Avatar'
import { addDays, ymd } from '../../components/cal-utils'
import type { PlanningStepModule, StepBodyProps } from '../registry'
import {
  planningFamilyNightApi,
  planningFamilyNightDecision,
  useEventsRange,
  weekdayName,
  type PlanningFamilyNightBoard,
  type PlanningFamilyNightPart,
} from '../../../lib/api'
import '../../../styles/planning-familyNight.css'

// Step 4 · Family night — "Accept the rotation, or change it?"
//
// THREE ROWS AND A THEME LINE, and the fast path is reading them and moving on. The
// rotation has already worked out whose turn each part is, and most weeks it is right,
// so the affirmative is an acknowledgement: pressing it writes nothing at all.
//
// Everything that IS a decision goes through the familyNight module's own occurrence
// endpoint, because that is where a gathering lives:
//   · tap a face  → an assignment on the OCCURRENCE. Pinned for this week only; next
//     week comes back on rotation. It also materializes the occurrence, and the
//     occurrence count is what the rotation counts — which is how a pin "shifts next
//     week's turn" without anybody editing the household's standing agenda.
//   · the theme   → free text on the same occurrence.
//   · Skip this week → status 'skipped' on the same occurrence. It calls off the
//     GATHERING, not the recurring calendar event behind it, which is left alone.
//
// A SKIPPED WEEK STILL TAKES ITS TURN, and that is the intended rule — settled as a
// product call after it was raised as a bug. The module's rotation is a COUNT of
// occurrences and does not exclude skipped ones, so calling a week off moves everybody
// on a place: nobody did the part, but the turn passed. The alternative — a skipped week
// costing nothing — means the same person is up again next week and again the week after
// for as long as the family keeps skipping, which is the worse of the two behaviours.
//
// So do NOT "fix" `rotationIndex()` to exclude skipped occurrences. The skip bar below
// says out loud that the turn moved on, because a rotation that shifts silently is the
// part that would actually confuse somebody.

interface StepState {
  key: string
  board: PlanningFamilyNightBoard | null
  loading: boolean
  error: string | null
  busy: boolean
}

const EMPTY: StepState = { key: '', board: null, loading: true, error: null, busy: false }

// Body and FooterExtra are SIBLING trees under the shell — "Skip this week" lives in the
// footer and what it does is drawn in the body — so the state has to outlive both. Same
// module-scoped store the Meals step uses, and for the same reason.
let state: StepState = EMPTY
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const snapshot = () => state
function set(patch: Partial<StepState>) {
  state = { ...state, ...patch }
  for (const l of [...listeners]) l()
}

async function load(key: string, weekStart: string) {
  set({ ...EMPTY, key })
  try {
    const board = await planningFamilyNightApi.board(weekStart)
    if (state.key !== key) return // a later week won the race
    set({ board, loading: false })
  } catch {
    if (state.key !== key) return
    set({ loading: false, error: "Couldn't read this week's family night — reload and try again." })
  }
}

async function reread(weekStart: string) {
  // Never over a write in flight: that read left before the write landed, so applying it
  // would put the pre-write board back on screen. `write` re-reads anyway.
  if (state.busy) return
  const key = state.key
  const board = await planningFamilyNightApi.board(weekStart)
  if (state.key === key && !state.busy) set({ board })
}

// Every write is followed by a re-read rather than a local patch: the server owns which
// parts are on rotation, so guessing here is how this screen and the Today card start
// naming different people for the same night.
async function write(p: StepBodyProps, run: (date: string) => Promise<unknown>) {
  const board = state.board
  const key = state.key
  if (!board || state.busy) return
  set({ busy: true, error: null })
  try {
    await run(board.date)
    const fresh = await planningFamilyNightApi.board(p.weekStart)
    if (state.key !== key) return // the week moved on under us; that board isn't this one
    set({ board: fresh, busy: false })
  } catch {
    if (state.key === key) set({ busy: false, error: "That didn't take — try again." })
  }
  p.refresh()
}

// Both components read the same store; `primary` (only Body passes it) says which one
// owns the fetching, so a remount doesn't fire two reads. The store outlives the
// components, so coming back to the step re-reads rather than showing what it was when
// you left — the Today card writes to the same night.
function useFamilyNightStep(p: StepBodyProps, primary = false): StepState {
  const key = `${p.sessionId}|${p.weekStart}`
  useEffect(() => {
    if (state.key !== key) void load(key, p.weekStart)
    else if (primary && !state.loading) void reread(p.weekStart).catch(() => { /* the card simply stays as it was */ })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const s = useSyncExternalStore(subscribe, snapshot)
  // The crumb: what this sitting decided, kept in step with every read and write so the
  // affirmative writes back what is already true instead of erasing it.
  useEffect(() => {
    if (primary && s.board) p.setDecisionData(planningFamilyNightDecision(s.board))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primary, s.board])
  return s
}

// ── Bits ─────────────────────────────────────────────────────────────────────────

// "Wednesday, Sep 9". Built off the plain date with a fixed noon, so no timezone can
// shift the gathering onto the day before.
function longDate(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
}

// "5:00 PM" from the config's 'HH:MM'.
function clockTime(time: string): string {
  const [h, m] = time.split(':').map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return time
  const d = new Date(2000, 0, 1, h, m)
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function PartRow({ part, board, p, disabled }: {
  part: PlanningFamilyNightPart
  board: PlanningFamilyNightBoard
  p: StepBodyProps
  disabled: boolean
}) {
  const sub = part.personName === null
    ? 'nobody yet'
    : part.pinned
      ? `pinned for this week · ${part.personName}`
      : `suggested · ${part.personName}, next in the rotation`

  return (
    <div className="wpfn-row" data-testid={`wpfn-row-${part.label}`}>
      <div className="wpfn-emoji" aria-hidden>{part.emoji}</div>
      <div className="wpfn-main">
        <div className="wpfn-label">{part.label}</div>
        <div className={`wpfn-sug${part.pinned ? ' pinned' : ''}`}>{sub}</div>
      </div>
      <div className="wpfn-faces">
        {board.members.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`wpfn-face${m.id === part.personId ? ' on' : ''}`}
            style={{ background: avTint(m.colorHex) }}
            // A face with no accessible name is unaddressable, and "🦄" is not a name.
            // The label is always the ACTION, because tapping the suggested person is a
            // real one: it turns the rotation's guess into a decision.
            aria-label={`Pin ${part.label} to ${m.name}`}
            // Only a PIN is a pressed state. The rotation's suggestion is drawn as
            // current (.on) but nobody chose it, and the row's own line says so.
            aria-pressed={part.pinned && m.id === part.personId}
            title={`${m.name} takes ${part.label.toLowerCase()}`}
            disabled={disabled}
            onClick={() => void write(p, (date) => planningFamilyNightApi.pin(date, part.partId, m.id))}
          >
            {m.avatarEmoji ?? '🙂'}
          </button>
        ))}
      </div>

      {/* WHAT the part is, as opposed to whose turn it is. Sent without `personId`, so
          naming the treat leaves whoever has it alone and the rotation's suggestion
          stands (the server reads presence — see setDetail). */}
      <CommitLine
        className="wpfn-detail"
        label="What"
        srLabel={`What is the ${part.label.toLowerCase()}?`}
        value={part.detail ?? ''}
        placeholder={DETAIL_HINTS[part.partId] ?? `optional — what's the ${part.label.toLowerCase()}?`}
        maxLength={200}
        disabled={disabled}
        onCommit={(text) => void write(p, (date) => planningFamilyNightApi.setDetail(date, part.partId, text))}
      />
    </div>
  )
}

// Placeholders for the three parts every household starts with. Keyed by the DEFAULT
// slugs only — a household that renames or adds parts falls through to the generic
// question, which is built from its own label.
const DETAIL_HINTS: Record<string, string> = {
  activity: 'optional — "charades, kids vs parents"',
  treat: 'optional — "the good ice cream"',
  checkin: 'optional — "how was school, actually"',
}

/**
 * A free-text line saved on blur (and on Enter) rather than per keystroke — it is a
 * sentence somebody types, not a toggle. Shared by the theme and by every part's detail,
 * which behave identically: same clearing rule ('' clears, a null would mean "leave it"),
 * same re-sync, same design-system `.field`.
 */
function CommitLine({ label, srLabel, value, placeholder, maxLength, disabled, onCommit, className }: {
  label: string
  /**
   * The accessible name, when the visible label is too terse to stand alone. Three rows
   * each showing "What" need three distinct names, and the visible word cannot repeat
   * the part's own label — "Activity … Activity" reads as a mistake on screen.
   */
  srLabel?: string
  value: string
  placeholder: string
  maxLength: number
  disabled: boolean
  onCommit: (text: string) => void
  className: string
}) {
  const [draft, setDraft] = useState(value)
  // Re-sync when the board comes back with a different value (another device, or the week
  // changed under us). A draft in progress is never clobbered by its own re-read, because
  // the re-read carries the value that was just saved.
  useEffect(() => { setDraft(value) }, [value])

  const commit = () => {
    if (draft === value || disabled) return
    onCommit(draft.trim())
  }

  // The app's own labelled-field shape (.field > span + input), laid on its side by the
  // stylesheet — so it inherits the design system's input rather than growing a
  // hand-rolled one, and the label is the input's accessible name for free.
  return (
    <label className={`field ${className}`}>
      <span>{label}</span>
      <input
        type="text"
        {...(srLabel ? { 'aria-label': srLabel } : {})}
        value={draft}
        maxLength={maxLength}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur() } }}
      />
    </label>
  )
}

// The theme is a free-text line on the night, saved on blur (and on Enter) rather than
// per keystroke — it is a sentence somebody types, not a toggle.
function ThemeLine({ board, p, disabled }: { board: PlanningFamilyNightBoard; p: StepBodyProps; disabled: boolean }) {
  return (
    <CommitLine
      className="wpfn-theme"
      label="Theme"
      value={board.theme ?? ''}
      placeholder='optional — "pizza and the new Lego set"'
      maxLength={120}
      disabled={disabled}
      // '' clears; null would mean "leave whatever is there" to the server's upsert.
      onCommit={(text) => void write(p, (date) => planningFamilyNightApi.setTheme(date, text))}
    />
  )
}

/**
 * The week's events, to point one at. Its own component so the FETCH only happens when
 * somebody opens the picker — a hook can't be called conditionally, so the way to not
 * pay for a list nobody asked for is to not mount the thing that reads it.
 */
function EventPicker({ weekStart, disabled, onPick }: {
  weekStart: string
  disabled: boolean
  onPick: (eventId: string) => void
}) {
  // The last day of the week the SERVER handed us — whole days stepped off that
  // boundary, never a week computed here.
  const { events } = useEventsRange(weekStart, ymd(addDays(new Date(`${weekStart}T00:00:00`), 6)))
  // A meal-plan mirror is not something anybody would call family night, and offering one
  // would put a dinner where an evening should be.
  const linkable = events.filter((e) => e.origin !== 'meal_plan' && e.origin !== 'meal_prep')

  return (
    <ul className="wpfn-cal-list" aria-label="Events on this week">
      {linkable.length === 0 && <li className="wpfn-cal-empty">Nothing on the week to point at yet.</li>}
      {linkable.map((e) => (
        <li key={e.id}>
          <button
            type="button"
            className="wpfn-cal-pick"
            disabled={disabled}
            onClick={() => onPick(e.id)}
          >
            {e.title}
          </button>
        </li>
      ))}
    </ul>
  )
}

/**
 * This week's gathering on the calendar.
 *
 * TWO different things live here, and the step has to keep them apart:
 *
 *  · `onCalendar` is the STANDING recurring series (settings.familyNight.eventId), set
 *    once in Settings by an admin. Every week inherits it.
 *  · `eventId` is the event THIS gathering points at — the one a planning session can
 *    decide, which is the same reason a pinned person lives on the occurrence.
 *
 * Neither button opens an event form. "Add to calendar" is one server call that creates
 * the event for this date and links it atomically — a create-then-adopt round trip from
 * here could not be made safe, because the web app writes events LOCALLY first and the
 * id would not exist server-side yet. "Link an event" adopts something the week already
 * has, which is the half a recurring series could never express: "this week it's the
 * movie night that's already on Friday".
 */
function CalendarLine({ board, p, disabled }: {
  board: PlanningFamilyNightBoard
  p: StepBodyProps
  disabled: boolean
}) {
  const [picking, setPicking] = useState(false)

  if (board.eventId) {
    return (
      <div className="wpfn-cal" data-testid="wpfn-cal">
        <span className="wpfn-cal-emoji" aria-hidden>📅</span>
        <div className="wpfn-cal-main">
          <div className="wpfn-cal-t">{board.eventTitle}</div>
          <div className="wpfn-cal-s">{board.eventWhen} · on the calendar for this week</div>
        </div>
        <button
          type="button"
          className="btn btn-ghost wpfn-cal-act"
          disabled={disabled}
          // Unlinks ONLY. Deleting the event is the calendar's job, and "this isn't
          // family night after all" must never delete Friday.
          onClick={() => void write(p, (date) => planningFamilyNightApi.linkEvent(date, null))}
        >
          Unlink
        </button>
      </div>
    )
  }

  return (
    <div className="wpfn-cal" data-testid="wpfn-cal">
      <span className="wpfn-cal-emoji" aria-hidden>📅</span>
      <div className="wpfn-cal-main">
        <div className="wpfn-cal-t">Not on the calendar this week</div>
        <div className="wpfn-cal-s">
          {board.onCalendar
            ? 'The standing weekly event still stands — this is for a one-off, or to point at something already on the week.'
            : 'Add it as an event, or point at something already on the week.'}
        </div>
        <div className="wpfn-cal-acts">
          <button
            type="button"
            className="btn btn-ghost wpfn-cal-act"
            disabled={disabled}
            onClick={() => { setPicking(false); void write(p, (date) => planningFamilyNightApi.addEvent(date)) }}
          >
            Add to calendar
          </button>
          <button
            type="button"
            className="btn btn-ghost wpfn-cal-act"
            disabled={disabled}
            aria-expanded={picking}
            onClick={() => setPicking((v) => !v)}
          >
            {picking ? 'Never mind' : 'Link an event'}
          </button>
        </div>

        {picking && (
          <EventPicker
            weekStart={board.weekStart}
            disabled={disabled}
            onPick={(eventId) => { setPicking(false); void write(p, (date) => planningFamilyNightApi.linkEvent(date, eventId)) }}
          />
        )}
      </div>
    </div>
  )
}

// ── Body ─────────────────────────────────────────────────────────────────────────

function Body(p: StepBodyProps) {
  const s = useFamilyNightStep(p, true)
  const disabled = p.busy || s.busy

  if (s.loading) return <div className="wp-empty">Reading this week's family night…</div>
  if (!s.board) return <div className="wp-empty">{s.error ?? "Couldn't read this week's family night."}</div>

  const b = s.board
  const skipped = b.status === 'skipped'

  return (
    <div className="wpfn">
      <div className={`wpfn-card${skipped ? ' skipped' : ''}`}>
        <div className="wpfn-h">
          <div className="wpfn-t">🏡 Family Night</div>
          <div className="wpfn-rec">every {weekdayName(b.dayOfWeek)}</div>
          <div className="wpfn-when">{longDate(b.date)} · {clockTime(b.time)}</div>
        </div>

        <ThemeLine board={b} p={p} disabled={disabled || skipped} />

        {b.parts.map((part) => (
          <PartRow key={part.partId} part={part} board={b} p={p} disabled={disabled || skipped} />
        ))}

        {b.members.length === 0 && (
          <div className="wpfn-note">Add family members and the rotation has somebody to offer.</div>
        )}

        <CalendarLine board={b} p={p} disabled={disabled || skipped} />
      </div>

      {skipped ? (
        <div className="wpfn-skipbar">
          <span className="wpfn-skip-emoji" aria-hidden>⏭</span>
          <div className="wpfn-skip-main">
            <div className="wpfn-skip-t">Skipped this week</div>
            <div className="wpfn-skip-s">
              The gathering is marked skipped{b.onCalendar && ', and the recurring calendar event is left alone'}.
              Everyone&rsquo;s turn still moves on, so next week is the next person up.
            </div>
          </div>
          <button
            type="button"
            className="btn btn-ghost wpfn-undo"
            disabled={disabled}
            onClick={() => void write(p, (date) => planningFamilyNightApi.setStatus(date, 'planned'))}
          >
            Undo
          </button>
        </div>
      ) : (
        // Deliberately NOT the mock's "worked out from who did what last time": the
        // module's rotation is a COUNT of gatherings taken against the family's order,
        // and it never reads who was actually assigned. Promising more than that would
        // be a sentence the software can't keep.
        <div className="wpfn-note">
          These are <b>rotation suggestions</b> — each part taken in turn, in your family's order.
          Leave them and they stand; tap a face and it's pinned for this week only, which is what
          shifts next week's turn.
        </div>
      )}

      {s.error && <div className="wpfn-err">{s.error}</div>}
    </div>
  )
}

// ── FooterExtra ──────────────────────────────────────────────────────────────────
// "Skip this week" — beside the shell's own "Skip this step", and deliberately a
// different thing: skipping the STEP decides nothing, skipping the WEEK calls the
// gathering off. Once the week is off, the way back is Undo on the skip bar, where the
// consequence is written down — so this slot empties rather than becoming a second undo
// at the far end of the screen from the thing it undoes.

function FooterExtra(p: StepBodyProps) {
  const s = useFamilyNightStep(p)
  if (!s.board || s.board.status === 'skipped') return null
  return (
    <button
      type="button"
      className="btn btn-ghost wpfn-skip"
      disabled={p.busy || s.busy}
      onClick={() => void write(p, (date) => planningFamilyNightApi.setStatus(date, 'skipped'))}
    >
      Skip this week
    </button>
  )
}

const mod: PlanningStepModule = { Body, FooterExtra }
export default mod
