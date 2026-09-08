import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { looseEndsApi, planningRecapApi, planningRecapDecision, type PlanningRecapView } from '../../../lib/api'
// The app's own event-colour resolver. The week strip has to agree with the calendar it
// is describing, so it uses the same one the month and week views do rather than a rule
// of its own.
import { evVars, useEventColor } from '../../../lib/event-color'
import type { PlanningStepModule, StepBodyProps } from '../registry'
import '../../../styles/planning-recap.css'

// Step 10 · Recap — read the week back, then it's over.
//
// THE BODY COMPUTES NOTHING. Every headline, every sentence, every tally arrives
// resolved from `GET /api/weekly-planning/recap`, which reads the modules that own the
// decisions. That is the design's governing line — "every line is a pointer rather than
// a copy" — kept honest at the seam: a client that re-added the counts, or reformatted a
// decision into its own words, would be a second reading of the week that could drift
// from the server's (and from iOS's). The one thing this file decides is layout.
//
// WHAT IT DELIBERATELY DOES NOT BUILD:
//
//  · A SAVED FRAME. `WeeklyPlanning.tsx` owns the finished record — the timestamp, the
//    per-step read-back, "Reopen the session" and "Start this week over" — and drops the
//    step from the URL the moment the session completes, so a saved frame here would be
//    unreachable as well as duplicated. The v4 mock's second board is the shell's, not
//    this step's. What the shell's version LACKED — the week strip, the module grouping
//    and the receipt's three numbers — was recorded here as "a shell change, raised
//    rather than made", and it was then reported: "the web recap page shows just the
//    checklist." So the shell now renders THIS panel above its tick-list, through
//    `RecapPanel` below. The frame stays the shell's; the reading is shared.
//  · A "CHANGE SOMETHING" FOOTER BUTTON. The mock puts one beside the primary, but the
//    shell's step chip already opens the agenda sheet, which jumps AND moves the
//    session's own pointer. A second control that had to guess which step you meant
//    would be strictly worse than the rows themselves being links — so each group row
//    links at the step that owns it, which is the same gesture aimed at the right place.
//  · A SECOND WAY TO ANSWER A NOTE. Dropping one is step 1's
//    `POST /loose-ends/resolve`, the writer that owns `planning_parked_items`.
//
// The week is SEVEN COLUMNS and it must stay one screen beside two cards, so a busy day
// reports its remainder rather than growing — see planning-recap.css, where the grid
// tracks are `minmax(0, 1fr)` for exactly the reason the Horizon month grid wasn't.

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** "Sun" / "6" for a YYYY-MM-DD. Parsed at noon so no zone can shift the label a day. */
function dayParts(iso: string): { name: string; num: number } {
  const d = new Date(`${iso}T12:00:00`)
  return { name: WD[d.getDay()], num: d.getDate() }
}

/** The dinner line: "Lentil soup · Lottie" when somebody is cooking it. */
export function mealLine(meal: string | null, cook: string | null): string | null {
  if (!meal) return null
  return cook ? `${meal} · ${cook}` : meal
}

function useRecap(sessionId: string) {
  const [view, setView] = useState<PlanningRecapView | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let alive = true
    setLoading(true)
    planningRecapApi
      .get(sessionId)
      .then((v) => { if (alive) setView(v) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [sessionId])
  return { view, loading, setView }
}

// The recap is rendered on TWO surfaces, and the difference between them is two props.
//
// Step 10 renders it inside a running session: rows point back at the step that owns
// them, and the copy is written for a week about to be saved. The finished-week record
// (`WeeklyPlanning.tsx`) renders the same read-back on the same payload — that was the
// report, "the web recap page shows just the checklist … on the iPhone we showed the
// actual week decisions" — and neither of those two things holds there: the shell strips
// the step from the path the moment a session completes, so a `/planning/<step>` link
// would bounce straight back, and "what tonight changed" is the wrong tense for a week
// saved on Sunday and read on Thursday.
//
// The routing prop is OPTIONAL and absent means step 10's behaviour, so the live session
// and this file's own tests are untouched by the record's existence. THE TENSE IS NOT A
// PROP: it is `savedAt` on the payload, the field the server ships for exactly this
// ("here so any surface reading the record can date it"), so the two clients cannot drift
// into describing the same week in different tenses.
export interface RecapPanelProps extends StepBodyProps {
  // Where a row naming a step should point, or null for a plain row. Absent ⇒ the step
  // inside the session.
  hrefForStep?: (stepKey: string) => string | null
}

export function RecapPanel({ sessionId, setDecisionData, busy, hrefForStep }: RecapPanelProps) {
  const { view, loading } = useRecap(sessionId)
  const [search] = useSearchParams()
  // Family colour when an event covers the household, the owner's colour otherwise, grey
  // when nobody owns it — resolved here rather than server-side so the strip cannot drift
  // from the calendar.
  const colorOf = useEventColor()
  // Notes the family walked past on purpose. Local on purpose too: "keep it parked" is
  // the answer that writes NOTHING — the note stays open and turns up in next Sunday's
  // step 1, which is the whole point of a last call rather than an inbox.
  const [kept, setKept] = useState<string[]>([])
  const [dropped, setDropped] = useState<string[]>([])
  const [working, setWorking] = useState<string | null>(null)

  // The receipt's integers, and only those. See planningRecapDecision.
  useEffect(() => { setDecisionData(planningRecapDecision(view)) }, [view, setDecisionData])

  // A link back to the step that owns a line, carrying whatever week the URL is already
  // about. The shell leaves a URL naming a runnable step alone ("a pasted link outranks
  // the pointer"), so this moves THIS browser without touching the session's own
  // `current_step` — which stays where the family is.
  const q = search.toString()
  const hrefFor = (stepKey: string): string | null =>
    hrefForStep ? hrefForStep(stepKey) : `/planning/${stepKey}${q ? `?${q}` : ''}`

  const drop = useCallback(
    async (id: string) => {
      if (working || busy) return
      setWorking(id)
      try {
        await looseEndsApi.resolve('parked', id, 'drop', sessionId)
        setDropped((d) => [...d, id])
      } finally {
        setWorking(null)
      }
    },
    [working, busy, sessionId]
  )

  if (loading && !view) return <div className="wpr-note">Reading the week back…</div>
  if (!view) return <div className="wpr-note">Couldn’t read the week back just now — the week itself is unaffected.</div>

  const lastCall = view.lastCall.filter((n) => !kept.includes(n.id) && !dropped.includes(n.id))
  const nothing = !view.groups.length && !view.leftAlone.length
  // The week is already saved, so the closing copy cannot be written for a week about to
  // be. "What tonight changed" is wrong on a Thursday reading of Sunday's session.
  const saved = !!view.savedAt

  return (
    <div className="wpr">
      {/* ── The week, one last time ─────────────────────────────────────────── */}
      <div className="wpr-week">
        {view.days.map((d) => {
          const { name, num } = dayParts(d.date)
          const meal = mealLine(d.meal, d.cook)
          return (
            <div key={d.date} className="wpr-day" data-testid={`wpr-day-${d.date}`}>
              <div className="wpr-d">{name}<span>{num}</span></div>
              {meal && <div className="wpr-line">{meal}</div>}
              {d.events.map((e) => (
                <div
                  key={e.id}
                  className="wpr-line ev ev-tint"
                  // `?? []` on purpose: this is the last screen of the session, and a
                  // payload missing one array should cost a tint, not the whole recap.
                  style={evVars(colorOf({
                    personId: e.personId ?? null,
                    personColor: e.personColor ?? null,
                    participants: (e.participantIds ?? []).map((id) => ({ id })),
                  }))}
                  title={e.when}
                >
                  {e.title}
                </div>
              ))}
              {d.more > 0 && <div className="wpr-more">+{d.more} more</div>}
            </div>
          )
        })}
      </div>

      {/* ── What changed, and what didn't ───────────────────────────────────── */}
      <div className="wpr-cols">
        <div className="wpr-card">
          <div className="wpr-h">
            {saved ? 'What the session changed' : 'What tonight changed'}
            <span>{view.counts.decisions === 1 ? '1 decision' : `${view.counts.decisions} decisions`}</span>
          </div>
          {view.groups.map((g) => {
            const inner = (
              <>
                <span className="wpr-src">{g.label}</span>
                <span className="wpr-t">
                  {g.headline}
                  <s>{g.detail}</s>
                </span>
                <span className="wpr-n">{g.count}</span>
              </>
            )
            // The row IS the way back to the decision — which is the grouping's whole
            // argument: a line names the module, and the module is where you change it.
            const href = g.stepKey ? hrefFor(g.stepKey) : null
            return href ? (
              <Link key={g.key} to={href} className="wpr-row" data-testid={`wpr-group-${g.key}`}>
                {inner}
              </Link>
            ) : (
              <div key={g.key} className="wpr-row" data-testid={`wpr-group-${g.key}`}>{inner}</div>
            )
          })}
          {nothing && (
            <div className="wpr-row">
              <span className="wpr-t">
                Nothing was decided in this session
                <s>
                  {saved
                    ? 'The week was saved as it stood — everything on the calendar, the plan and the board is exactly as it was.'
                    : 'Saving still records the week you read back — and everything on the calendar, the plan and the board stays exactly as it is.'}
                </s>
              </span>
            </div>
          )}
        </div>

        <div className="wpr-side">
          {/* HONESTY 1 — the notes nobody routed anywhere. Two answers, and the quiet
              one writes nothing: a note kept parked is still open next Sunday. */}
          {(lastCall.length > 0 || view.lastCallMore > 0) && (
            <div className="wpr-card">
              <div className="wpr-h">Still on the board<span>last call</span></div>
              {lastCall.map((n) => (
                <div key={n.id} className="wpr-row" data-testid={`wpr-parked-${n.id}`}>
                  <span className="wpr-t">
                    {n.note}
                    {n.detail && <s>{n.detail}</s>}
                  </span>
                  <span className="wpr-acts">
                    <button
                      type="button" className="btn btn-ghost wpr-act"
                      disabled={busy || working === n.id}
                      onClick={() => setKept((k) => [...k, n.id])}
                    >
                      Keep it parked
                    </button>
                    <button
                      type="button" className="btn btn-ghost wpr-act is-drop"
                      disabled={busy || working === n.id}
                      onClick={() => drop(n.id)}
                    >
                      Drop it
                    </button>
                  </span>
                </div>
              ))}
              {view.lastCallMore > 0 && (
                <div className="wpr-row"><span className="wpr-t mut">…and {view.lastCallMore} more still on the board</span></div>
              )}
            </div>
          )}

          {/* HONESTY 2 — a step that was skipped is a decision, and "nothing this week"
              is an answer. These are outcomes, so they are rendered as rows, not as
              gaps in the card above. */}
          {view.leftAlone.length > 0 && (
            <div className="wpr-card">
              <div className="wpr-h">Left alone on purpose</div>
              {view.leftAlone.map((l) => {
                const inner = (
                  <>
                    <span className="wpr-t">
                      {l.label}
                      <s>{l.detail}</s>
                    </span>
                    <span className={`wpr-n is-${l.badge}`}>{l.badge}</span>
                  </>
                )
                const href = l.stepKey ? hrefFor(l.stepKey) : null
                return href ? (
                  <Link key={l.key} to={href} className="wpr-row" data-testid={`wpr-alone-${l.key}`}>
                    {inner}
                  </Link>
                ) : (
                  <div key={l.key} className="wpr-row" data-testid={`wpr-alone-${l.key}`}>{inner}</div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      <div className="wpr-foot">
        Every line above is a <b>pointer</b>, not a copy — it is already live in Calendar,
        Meals, Lists, Chores and Goals.{' '}
        {saved
          ? 'The record was written when the week was saved: what was decided, what was deferred, what rolled over. Today is the surface now, not this session.'
          : 'Saving writes the record: what was decided, what was deferred, what rolled over, with a timestamp. After that Today is the surface, not this session.'}
      </div>
    </div>
  )
}

const mod: PlanningStepModule = { Body: RecapPanel }
export default mod
