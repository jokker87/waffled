import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  horizonApi,
  looseEndsApi,
  useCountdowns,
  useEventsRange,
  useHousehold,
  type AgendaEvent,
  type Countdown,
  type HorizonNote,
  type HorizonTag,
} from '../../../lib/api'
// Not re-exported from lib/api — step 1 imports it from the same place, for the same
// reason: a refused park's message is the useful half of the failure.
import { ApiSendError } from '../../../lib/api/client'
import { EventModal } from '../../components/EventModal'
import { MonthView } from '../../components/MonthView'
import { MONTHS, addDays, monthGridStart, ymd } from '../../components/cal-utils'
import type { PlanningStepModule, StepBodyProps } from '../registry'
import { ParkedNoteEditor } from '../ParkedNoteEditor'
import '../../../styles/planning-horizon.css'

// Step 3 · Horizon scan — THE MONTH YOU ALREADY SHIP, PLUS ONE BAR.
//
// This file renders `MonthView`. It does not draw a calendar. The mock's own class names
// (`.cal-grid`, `.cal-cell`, `.ev-tint`, `.cal-day-panel`, `.ag-row`) are the shipped
// month view's, which is the design saying as loudly as it can: reuse it. So the 42-cell
// grid, the owner-colour resolution (`lib/event-color.ts` — family colour for a
// whole-household event, grey for unassigned), the ↻ on a repeat, the dashed edge on a
// meal-plan dinner, the countdown badges and the right-hand day panel all come for free
// and, more importantly, stay identical to the calendar the family already knows. A
// second month grid here would drift from that one, and then this step would be showing
// a month nobody recognises.
//
// Three rules this file must not break:
//
//  1. THE ＋ AND THE BAR ARE DIFFERENT THINGS. ＋ on a day writes a REAL EVENT through
//     the app's own `EventModal` (which already owns the time, the duration, repeats,
//     the location, who it's for and the local-first write). The bar parks a NOTE, which
//     is never written onto the calendar — it is the thought the month provokes, and it
//     carries an optional tag naming the step that will look at it.
//  2. NOTHING NAVIGATES. Opening an event opens the same shared modal in edit mode, and
//     "+N more" opens that day in the panel. The shell owns where the session is.
//  3. THE SERVER OWNS THE WEEK. `weekStart` is a prop; nothing here asks the device what
//     week it is. The month shown is the one that week falls in.

// The board's notes and the bar's tags, read back from `planning_parked_items` rather
// than kept on the session: `setDecisionData` only reaches the server when the step is
// ANSWERED, so a step used and then left would lose them (the wave-1 Meals lesson).
function useHorizon(sessionId: string) {
  const [tags, setTags] = useState<HorizonTag[]>([])
  const [parked, setParked] = useState<HorizonNote[]>([])
  useEffect(() => {
    let alive = true
    horizonApi.get(sessionId).then((v) => {
      if (!alive) return
      setTags(v.tags ?? [])
      setParked(v.parked ?? [])
    })
    return () => {
      alive = false
    }
  }, [sessionId])
  return { tags, parked, setParked }
}

/** "September 2026" — the label between the month arrows. */
export function monthLabel(year: number, month: number): string {
  return `${MONTHS[month]} ${year}`
}

function Body({ weekStart, sessionId, setDecisionData, refresh, busy }: StepBodyProps) {
  const { household } = useHousehold()
  // Which day starts the week, so the grid is cut the way this household cuts a week —
  // the same read `Calendar` does. Never a bare Monday assumption.
  const firstDay = household?.weekStart === 'monday' ? 1 : 0
  const tz = household?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

  // The month the planned week falls in, and the floor for scanning: a horizon is what
  // is AHEAD, so there is nowhere useful to page back to.
  const floor = useMemo(() => {
    const d = new Date(`${weekStart}T00:00:00`)
    return { year: d.getFullYear(), month: d.getMonth() }
  }, [weekStart])
  const [ahead, setAhead] = useState(0)
  const anchor = useMemo(() => new Date(floor.year, floor.month + ahead, 1), [floor, ahead])
  const year = anchor.getFullYear()
  const month = anchor.getMonth()

  // The fetch window is the 42 cells the grid draws, via the SAME `monthGridStart` the
  // grid uses — these were separate copies of the formula once, and a window cut one day
  // off from its grid loses the events on its last row.
  const gridStart = useMemo(() => monthGridStart(year, month, firstDay), [year, month, firstDay])
  const { events, refetch } = useEventsRange(ymd(gridStart), ymd(addDays(gridStart, 41)))

  // Countdown badges, all four sources, keyed by target day — exactly as Calendar builds
  // them. They are the anticipation markers a horizon scan exists to notice.
  const { countdowns } = useCountdowns()
  const countdownsByDate = useMemo(() => {
    const m: Record<string, Countdown[]> = {}
    for (const c of countdowns) (m[c.date] ??= []).push(c)
    return m
  }, [countdowns])

  // The panel focuses the first day of the week being planned while we're on its month
  // (that is where the family's attention already is), and the 1st of any month scanned
  // beyond it.
  const [selectedDay, setSelectedDay] = useState(weekStart)
  useEffect(() => {
    setSelectedDay(ahead === 0 ? weekStart : ymd(new Date(year, month, 1)))
  }, [ahead, weekStart, year, month])

  // The shared event modal: `{ date }` creates on that day, `{ event }` edits in place.
  const [modal, setModal] = useState<{ date?: string; event?: AgendaEvent } | null>(null)

  const { tags, parked, setParked } = useHorizon(sessionId)
  const [note, setNote] = useState('')
  // Which step this note is for. THREE states, not two: `undefined` is "nobody has
  // chosen", which resolves to the server's primary tag (Tasks), while `null` is the
  // deliberate answer "No tag". Collapsing them would make the default unrepresentable.
  // The tag names the step that will LOOK at the note — the same thing step 1 writes
  // when it routes one.
  const [tag, setTag] = useState<string | null | undefined>(undefined)
  const chosen = tag === undefined ? (tags.find((t) => t.primary)?.stepKey ?? null) : tag
  const [parking, setParking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [added, setAdded] = useState(0)
  // Which board row is being corrected, if any. One at a time.
  const [editing, setEditing] = useState<string | null>(null)
  // Parking is a BURST — somebody reads the month and empties their head into the bar —
  // so the cursor goes back after each note rather than making you re-aim at the input.
  const inputRef = useRef<HTMLInputElement>(null)
  const wantFocus = useRef(false)

  // The crumb: two counts, and only counts. The recap reads through to the calendar and
  // to the parked table, so copying either onto the session record would give the two
  // something to disagree about.
  useEffect(() => {
    setDecisionData({ added, parked: parked.length })
  }, [added, parked.length, setDecisionData])

  function onSaved() {
    setAdded((n) => n + 1)
    // The grid and the shell's counter should both agree with what just happened.
    refetch()
    refresh()
  }

  function park(e: FormEvent) {
    e.preventDefault()
    const text = note.trim()
    if (!text || parking) return
    setParking(true)
    setError(null)
    // Step 1's writer, on purpose: `planning_parked_items` and `parkItem()` were both
    // written general so this bar needed no migration and no second parked-item path.
    looseEndsApi
      .park(text, { ...(chosen ? { stepKey: chosen } : {}), sessionId })
      .then((r) => {
        setParked((cur) => [
          ...cur,
          {
            id: r.item.id,
            note: text,
            stepKey: chosen,
            stepLabel: tags.find((t) => t.stepKey === chosen)?.label ?? null,
            createdAt: new Date().toISOString(),
          },
        ])
        setNote('')
        setTag(undefined)
        wantFocus.current = true
        refresh()
      })
      // KEEP THE SENTENCE. `parkItem` caps a note at 500 characters, so a refusal is
      // reachable rather than theoretical, and a bar that silently swallowed both the
      // error and what somebody just wrote is the worse half of the failure.
      .catch((err: unknown) =>
        setError(
          err instanceof ApiSendError && typeof err.body?.message === 'string'
            ? err.body.message
            : "That didn't go through — try again."
        )
      )
      .finally(() => setParking(false))
  }

  const disabled = busy || parking

  // Restored in an EFFECT rather than in the `.then`, because the bar is still
  // `disabled` while the write is in flight and `focus()` on a disabled input does
  // nothing at all — silently, which is how this passed a first reading. Waits for the
  // re-enable, then puts the cursor back exactly once.
  useEffect(() => {
    if (!wantFocus.current || disabled) return
    wantFocus.current = false
    inputRef.current?.focus()
  }, [disabled])

  return (
    <div className="wph">
      <header className="wph-head">
        <button
          type="button"
          className="wph-nav"
          aria-label="Previous month"
          disabled={ahead === 0 || busy}
          onClick={() => setAhead((n) => Math.max(0, n - 1))}
        >
          ‹
        </button>
        <div className="wph-month wf-serif">{monthLabel(year, month)}</div>
        <button
          type="button"
          className="wph-nav"
          aria-label="Next month"
          disabled={busy}
          onClick={() => setAhead((n) => n + 1)}
        >
          ›
        </button>
      </header>

      {/* THE SHIPPED MONTH VIEW. Grid + day panel, unchanged. */}
      <div className="wph-cal">
        <MonthView
          year={year}
          month={month}
          firstDay={firstDay}
          // Two, not three. The parked board underneath has to stay on screen, and a chip
          // is never allowed to shrink to make room — that squash is what this step was
          // reported for, twice. Drawing one fewer is the only honest saving.
          maxChips={2}
          events={events}
          tz={tz}
          countdownsByDate={countdownsByDate}
          selectedDay={selectedDay}
          onSelectDay={setSelectedDay}
          // In place, both of them: the shell owns where the session is, so tapping an
          // event opens the shared modal in edit mode rather than the detail route, and
          // "+N more" selects that day so the panel lists all of it.
          onOpenEvent={(e) => setModal({ event: e })}
          onMore={setSelectedDay}
          onCreateOnDay={(date) => setModal({ date })}
        />
      </div>

      {/* THE ONE THING THE SESSION ADDS. */}
      <form className="wph-park" onSubmit={park}>
        <span className="wph-park-pin" aria-hidden>
          📌
        </span>
        <input
          ref={inputRef}
          className="wph-park-in"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={disabled}
          // The server's own cap (`parkItem`'s MAX_NOTE), so the ordinary long note is
          // stopped here rather than by a 400.
          maxLength={500}
          placeholder={'Park a note — “we’re going camping, we need to pack”'}
          aria-label="Park a note"
        />
        {note.trim() ? (
          <button type="submit" className="btn btn-primary wph-park-go" disabled={disabled || !note.trim()}>
            Park it
          </button>
        ) : (
          <span className="wph-park-hint">a note, not a calendar entry</span>
        )}
      </form>

      {/* BELOW the pill, not inside it. The tag list is now every step still ahead of
          this one rather than three hand-picked names, and five-to-seven chips plus a
          button turned the capture line into a cramped scroll. Out here they get a row
          of their own — and, more to the point, room for the sentence under them. */}
      {note.trim() && (
        <div className="wph-park-tagrow">
          <div className="wph-tags" role="group" aria-label="Which step should look at this?">
            {tags.map((t) => (
              <button
                key={t.stepKey}
                type="button"
                className={`wph-tag${chosen === t.stepKey ? ' on' : ''}`}
                title={t.hint}
                disabled={disabled}
                onClick={() => setTag(t.stepKey)}
              >
                {t.label}
              </button>
            ))}
            <button
              type="button"
              className={`wph-tag${chosen === null ? ' on' : ''}`}
              disabled={disabled}
              onClick={() => setTag(null)}
            >
              No tag
            </button>
          </div>
          {/* "What does no tag do? where does it put it?" — a question a `title`
              attribute was never going to answer. Both outcomes are stated, and both
              are true: a tag is a DESTINATION, so the note is raised by that step's
              handoff banner when the session gets there; with no tag no step raises it
              at all, and it simply stays on the board. */}
          <p className="wph-park-says" data-testid="wph-park-says">
            {chosen ? (
              <>
                Comes back at <b>{tags.find((t) => t.stepKey === chosen)?.label}</b>, later in this
                session.
              </>
            ) : (
              <>
                <b>No step will raise it.</b> It stays on the board — in tonight&rsquo;s recap, and
                waiting at Loose ends next session.
              </>
            )}
          </p>
        </div>
      )}

      {error && (
        <p className="wph-err" role="alert">
          {error}
        </p>
      )}

      <p className="wph-note">
        <b>Know the day it lands?</b> Tap that day on the month above and add it — you get a real
        calendar event. <b>Only know it&rsquo;s coming?</b> Park it in the bar: it stays off the
        calendar, and comes back at whichever step you tag it for &mdash; all of them still ahead
        of you tonight.
      </p>

      {parked.length > 0 && (
        <>
          {/* Named, because the read deliberately returns every note parked during this
              session whichever bar wrote it — a note written at step 1 turning up here
              unlabelled would look like something the month put there. */}
          <h3 className="wph-board-h">Parked in this session</h3>
          <ul className="wph-board" data-testid="wph-board">
            {parked.map((n) => (
              <li key={n.id} className="wph-parked">
                {editing === n.id ? (
                  // "Parked in this session — I have no way to edit the item or change the
                  // category and I should." The same editor the shell's gold box uses, so a
                  // correction reads the same wherever you catch the mistake — and offered
                  // the SAME tags the bar above offered, since re-tagging here and tagging
                  // here are the same choice.
                  <ParkedNoteEditor
                    id={n.id}
                    note={n.note}
                    stepKey={n.stepKey}
                    tags={tags}
                    sessionId={sessionId}
                    busy={busy}
                    onCancel={() => setEditing(null)}
                    onSaved={(next) => {
                      setEditing(null)
                      setParked((cur) =>
                        cur.map((p) =>
                          p.id !== next.id
                            ? p
                            : {
                                ...p,
                                note: next.note,
                                stepKey: next.stepKey,
                                // The label is joined from the catalog, never stored — the
                                // same rule the server's own read follows.
                                stepLabel: tags.find((t) => t.stepKey === next.stepKey)?.label ?? null,
                              }
                        )
                      )
                      // The gold box further down the session quotes this note; the shell
                      // is what refetches it.
                      refresh()
                    }}
                  />
                ) : (
                  <>
                    <span className="wph-parked-note">{n.note}</span>
                    {n.stepLabel ? (
                      <span className="wph-parked-tag">{n.stepLabel}</span>
                    ) : (
                      <span className="wph-parked-tag is-unset">No tag</span>
                    )}
                    <button
                      type="button"
                      className="wph-parked-edit"
                      disabled={disabled}
                      onClick={() => setEditing(n.id)}
                      aria-label={`Edit “${n.note}”`}
                    >
                      Edit
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {/* The app's own event modal — NOT a second event form. Creating carries the day
          whose ＋ was tapped; editing carries the event that was opened. */}
      {modal && (
        <EventModal
          date={modal.date}
          event={modal.event}
          onClose={() => setModal(null)}
          onSaved={onSaved}
        />
      )}
    </div>
  )
}

// No FooterExtra: the shell already owns Skip and the affirmative, and the mock's footer
// is exactly those two.
const mod: PlanningStepModule = { Body }
export default mod
