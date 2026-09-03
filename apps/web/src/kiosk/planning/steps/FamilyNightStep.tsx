import { useEffect, useState, useSyncExternalStore } from 'react'
import type { PlanningStepModule, StepBodyProps } from '../registry'
import {
  planningFamilyNightApi,
  planningFamilyNightDecision,
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
// KNOWN GAP, so nobody re-derives it from scratch: the module's rotation is a COUNT of
// occurrences, not a history of who did what, and it doesn't exclude skipped ones. So a
// week called off here still ticks the rotation forward — the design says it shouldn't,
// and the fix is one predicate in modules/familyNight/familyNight.ts, which this step
// does not own. The copy below is careful not to promise otherwise.

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
            style={{ background: `${m.colorHex ?? '#A6A29B'}22` }}
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
    </div>
  )
}

// The theme is a free-text line on the night, saved on blur (and on Enter) rather than
// per keystroke — it is a sentence somebody types, not a toggle.
function ThemeLine({ board, p, disabled }: { board: PlanningFamilyNightBoard; p: StepBodyProps; disabled: boolean }) {
  const saved = board.theme ?? ''
  const [draft, setDraft] = useState(saved)
  // Re-sync when the board comes back with a different theme (another device, or the
  // week changed under us). A draft in progress is never clobbered by its own re-read
  // because the re-read carries the value that was just saved.
  useEffect(() => { setDraft(saved) }, [saved])

  const commit = () => {
    if (draft === saved || disabled) return
    // '' clears; null would mean "leave whatever is there" to the server's upsert.
    void write(p, (date) => planningFamilyNightApi.setTheme(date, draft.trim()))
  }

  // The app's own labelled-field shape (.field > span + input), laid on its side by the
  // stylesheet — so it inherits the design system's input rather than growing a
  // hand-rolled one, and the label is the input's accessible name for free.
  return (
    <label className="field wpfn-theme">
      <span>Theme</span>
      <input
        type="text"
        value={draft}
        maxLength={120}
        disabled={disabled}
        placeholder='optional — "pizza and the new Lego set"'
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur() } }}
      />
    </label>
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
      </div>

      {skipped ? (
        <div className="wpfn-skipbar">
          <span className="wpfn-skip-emoji" aria-hidden>⏭</span>
          <div className="wpfn-skip-main">
            <div className="wpfn-skip-t">Skipped this week</div>
            <div className="wpfn-skip-s">
              The gathering is marked skipped
              {b.onCalendar && ', and the recurring calendar event is left alone'}.
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
