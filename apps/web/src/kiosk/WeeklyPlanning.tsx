import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import {
  useWeeklyPlanning,
  weeklyPlanningApi,
  availableSteps,
  stepsByAct,
  resolveCurrent,
  nextStepAfter,
  planningDayName,
  addWeeks,
  type PlanningStep,
} from '../lib/api'
import '../styles/planning.css'

// Weekly Planning — the session shell.
//
// v4's whole argument is that the week is the content and the chrome is four things:
// a step counter, a title, the ONE question the step asks, and a 2px progress hair.
// The ten steps behind the counter are reachable from the counter itself (the agenda
// sheet) rather than a permanent rail — a rail teaches the shape of the session once
// and then costs a fifth of the display forever.
//
// Every step's BODY lives in its own component, landing one commit at a time; this
// file owns only the chrome, the lobby, the agenda sheet and the saved record. The
// step catalog (order, titles, questions, primary labels, which module each step
// reads) comes from the server so this screen and iOS cannot drift.
//
// THE URL IS THE STATE. `/planning/:step` names the step and `?week=` names the week,
// so refresh, back and a pasted link all land where you were — and the session's own
// `currentStep` stays the cross-DEVICE resume pointer. Both matter: the URL is where
// *this* browser is, the session row is where the *family* is.

// "Mon 31 – Sun 6" for the week being planned. This sits where v4's mock put the
// presence faces: the session is single-driver, so showing a row of avatars would be
// inventing presence we don't track — the week itself is the honest thing to name.
function weekLabel(weekStart: string): string {
  const start = new Date(`${weekStart}T00:00:00`)
  const end = new Date(start)
  end.setDate(end.getDate() + 6)
  const f = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })
  return `${f(start)} – ${f(end)}`
}

export function WeeklyPlanning() {
  const { step: urlStep } = useParams<{ step?: string }>()
  const [search, setSearch] = useSearchParams()
  const navigate = useNavigate()

  const weekParam = search.get('week') ?? undefined
  const { view, loading, refetch } = useWeeklyPlanning(weekParam)
  const [sheet, setSheet] = useState(false)
  const [busy, setBusy] = useState(false)
  // Two-tap confirm on discarding a session — it can't be undone, and it sits next to
  // the everyday "Close".
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const steps = view?.steps ?? []
  const runnable = useMemo(() => availableSteps(steps), [steps])
  const current = useMemo(() => resolveCurrent(view ?? null, urlStep), [view, urlStep])
  const next = current ? nextStepAfter(steps, current.key) : null
  const session = view?.session ?? null

  // A link to a step of a week. The week rides in the query only when it isn't the
  // default, so the everyday URL stays `/planning/calendar`.
  const hrefFor = (stepKey: string | null, week?: string) => {
    const w = week ?? view?.weekStart
    const q = w && view && w !== view.defaultWeekStart ? `?week=${w}` : ''
    return `/planning${stepKey ? `/${stepKey}` : ''}${q}`
  }

  // Keep the address bar honest: an active session with no step in the URL (someone
  // opened /planning, or came back from Today) rewrites to the step it resumed at.
  // `replace` so this correction never becomes a back-button stop.
  useEffect(() => {
    if (!view || !session || session.status === 'completed' || !current) return
    if (urlStep === current.key) return
    navigate(hrefFor(current.key), { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, session?.id, session?.status, current?.key, urlStep])

  async function go(fn: () => Promise<unknown>) {
    if (busy) return
    setBusy(true)
    try { await fn() } finally { setBusy(false); refetch() }
  }

  const start = () => go(async () => {
    const { session: s } = await weeklyPlanningApi.startSession(view?.weekStart)
    if (s.currentStep) navigate(hrefFor(s.currentStep))
  })

  // Answering a step is two writes that belong together: record the answer, then move
  // the driver on. The last step's answer is the save, which is what ends the session.
  async function answer(status: 'done' | 'skipped') {
    if (!session || !current) return
    await go(async () => {
      await weeklyPlanningApi.decideStep(session.id, current.key, status)
      if (next) {
        await weeklyPlanningApi.patchSession(session.id, { currentStep: next.key })
        navigate(hrefFor(next.key))
      } else {
        await weeklyPlanningApi.complete(session.id)
        navigate(hrefFor(null), { replace: true })
      }
    })
  }

  const jump = (key: string) => {
    setSheet(false)
    if (!session) return
    navigate(hrefFor(key))
    go(() => weeklyPlanningApi.patchSession(session.id, { currentStep: key }))
  }

  // Start the week over. The lobby is otherwise unreachable once a session exists —
  // coming back to Planning always resumes — so without this a week started by mistake
  // could never be undone.
  const discard = () => {
    if (!session) return
    setSheet(false)
    setConfirmDiscard(false)
    go(async () => {
      await weeklyPlanningApi.discard(session.id)
      navigate(hrefFor(null), { replace: true })
    })
  }

  const closeSheet = () => { setSheet(false); setConfirmDiscard(false) }

  // Moving to another week drops the step: that week has its own session (or none),
  // and carrying this week's step across would name a step of a different record.
  const goWeek = (week: string) => {
    setSheet(false)
    if (!view) return
    if (week === view.defaultWeekStart) { setSearch({}, { replace: false }); navigate('/planning') }
    else navigate(`/planning?week=${week}`)
  }

  if (loading) return <div className="wp-screen"><div className="wp-empty">Loading…</div></div>
  if (!view) return <div className="wp-screen"><div className="wp-empty">Couldn't load the session — reload or sign in again.</div></div>

  if (!runnable.length) {
    return (
      <div className="wp-screen">
        <div className="wp-empty">
          Every step of the session reads a module that's turned off. Turn one back on in
          Settings → Modules, or turn individual steps on under Weekly Planning.
        </div>
      </div>
    )
  }

  const canGoBack = view.weekStart > view.minWeekStart
  const WeekStepper = ({ className }: { className?: string }) => (
    <div className={`wp-weeknav ${className ?? ''}`}>
      <button
        type="button" className="wp-weekarrow" disabled={!canGoBack || busy}
        onClick={() => goWeek(addWeeks(view.weekStart, -1))}
        aria-label="Plan the previous week"
      >‹</button>
      <span className="wp-weeknav-l">{weekLabel(view.weekStart)}</span>
      <button
        type="button" className="wp-weekarrow" disabled={busy}
        onClick={() => goWeek(addWeeks(view.weekStart, 1))}
        aria-label="Plan the next week"
      >›</button>
    </div>
  )

  // Reachable from the agenda sheet mid-session and from the record afterwards — the
  // two places you'd look for "no, do this week again".
  const DiscardBlock = () => (
    <div className="wp-sheet-danger">
      {confirmDiscard ? (
        <>
          <div className="wp-sheet-danger-q">
            Throw this session away and start the week over? What it already decided —
            events added, chores handed out — stays put; only the session is discarded.
          </div>
          <div className="wp-sheet-danger-acts">
            <button type="button" className="wp-sheet-danger-no" onClick={() => setConfirmDiscard(false)}>Keep it</button>
            <button type="button" className="wp-sheet-danger-yes" disabled={busy} onClick={discard}>Start over</button>
          </div>
        </>
      ) : (
        <button type="button" className="wp-sheet-danger-open" onClick={() => setConfirmDiscard(true)}>Start this week over</button>
      )}
    </div>
  )

  // ── Saved: the record ────────────────────────────────────────────────────────
  // v4 step 10: "after that Today is the surface, not this session." So the finished
  // session is a receipt, not a dashboard — what it decided, and a way back in.
  if (session?.status === 'completed') {
    const decided = runnable.filter((s) => s.status !== 'pending')
    return (
      <div className="wp-screen">
        <div className="wp-record">
          <div className="wp-record-h">
            <div className="wp-record-t wf-serif">The week is decided</div>
            <div className="wp-record-s">
              {weekLabel(view.weekStart)} · saved {new Date(session.completedAt ?? session.startedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
            </div>
          </div>
          <div className="wp-record-list">
            {decided.map((s) => (
              <div key={s.key} className={`wp-record-row ${s.status}`}>
                <div className="wp-record-n">{s.status === 'done' ? '✓' : '–'}</div>
                <div className="wp-record-main">
                  <b>{s.title}</b>
                  <s>{s.status === 'done' ? s.primary : 'Skipped — a real answer'}</s>
                </div>
              </div>
            ))}
            {!decided.length && <div className="wp-record-row"><div className="wp-record-main"><s>Nothing was decided in this session.</s></div></div>}
          </div>
          <div className="wp-record-f">
            <button
              type="button" className="btn btn-ghost" disabled={busy}
              onClick={() => go(async () => {
                await weeklyPlanningApi.patchSession(session.id, { status: 'active' })
                if (session.currentStep) navigate(hrefFor(session.currentStep))
              })}
            >
              Reopen the session
            </button>
          </div>
          <div className="wp-record-week">Plan another week <WeekStepper /></div>
          <DiscardBlock />
        </div>
      </div>
    )
  }

  // ── Lobby: no session yet ────────────────────────────────────────────────────
  if (!session) {
    return (
      <div className="wp-screen">
        <div className="wp-lobby">
          <div className="wp-lobby-t wf-serif">{planningDayName(view.config.dayOfWeek)}'s session</div>
          <div className="wp-lobby-s">{runnable.length} steps. Jump anywhere, leave whenever the week is decided.</div>
          <WeekStepper className="wp-weeknav-lobby" />
          <div className="wp-lobby-acts">
            {stepsByAct(steps).map((a) => (
              <div key={a.act} className="wp-lobby-act">
                <div className="wp-lobby-act-h">{a.act}</div>
                <div className="wp-lobby-act-steps">{a.steps.map((s) => s.title).join(' · ')}</div>
              </div>
            ))}
          </div>
          <button type="button" className="btn btn-primary wp-lobby-go" disabled={busy} onClick={start}>
            Start the session
          </button>
        </div>
      </div>
    )
  }

  // ── In session ───────────────────────────────────────────────────────────────
  const pos = runnable.findIndex((s) => s.key === current?.key) + 1
  const pct = Math.round((pos / runnable.length) * 100)

  return (
    <div className="wp-screen wp-in">
      <div className="wp-head">
        <button type="button" className="wp-stepchip" onClick={() => setSheet(true)} aria-expanded={sheet}>
          {pos} of {runnable.length}
          <svg viewBox="0 0 24 24" aria-hidden><path d="M6 9l6 6 6-6" /></svg>
        </button>
        <div className="wp-title wf-serif">{current?.title}</div>
        <div className="wp-ask">{current?.ask}</div>
        <div className="wp-week">{weekLabel(view.weekStart)}</div>
        {/* The 2px hair — the only progress indicator v4 keeps. */}
        <div className="wp-prog"><div style={{ width: `${pct}%` }} /></div>
      </div>

      <div className="wp-body">
        {current && <StepBody step={current} />}
      </div>

      <div className="wp-foot">
        <button type="button" className="wp-skip" disabled={busy} onClick={() => answer('skipped')}>Skip this step</button>
        <div className="wp-foot-sp" />
        <button type="button" className="btn btn-primary wp-primary" disabled={busy} onClick={() => answer('done')}>
          {current?.primary}
          {next && <span className="wp-next">· next: {next.title}</span>}
        </button>
      </div>

      {sheet && (
        <div className="modal-overlay" onClick={closeSheet}>
          <div className="modal-card wp-sheet" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="modal-close" onClick={closeSheet} aria-label="Close">×</button>
            <div className="wp-sheet-t wf-serif">{planningDayName(view.config.dayOfWeek)}'s session</div>
            <div className="wp-sheet-s">{runnable.length} steps. Jump anywhere, leave whenever the week is decided.</div>
            <WeekStepper className="wp-weeknav-sheet" />
            {stepsByAct(steps).map((a) => (
              <div key={a.act}>
                <div className="wp-sheet-act">{a.act}</div>
                {a.steps.map((s) => {
                  const here = s.key === current?.key
                  const n = runnable.findIndex((x) => x.key === s.key) + 1
                  return (
                    <button
                      key={s.key}
                      type="button"
                      className={`wp-sheet-step${here ? ' on' : ''}${s.status === 'done' ? ' done' : ''}${s.status === 'skipped' ? ' skipped' : ''}`}
                      onClick={() => jump(s.key)}
                    >
                      <span className="wp-sheet-n">{s.status === 'done' ? '✓' : n}</span>
                      <span className="wp-sheet-name">{s.title}</span>
                      {here && <span className="wp-sheet-m">you're here</span>}
                      {!here && s.status === 'done' && <span className="wp-sheet-m">decided</span>}
                      {!here && s.status === 'skipped' && <span className="wp-sheet-m">skipped</span>}
                    </button>
                  )
                })}
              </div>
            ))}
            <div className="wp-sheet-f">
              <button type="button" className="btn btn-ghost" onClick={closeSheet}>Close</button>
              {/* The sheet already promises you can "leave whenever" — so it has to
                  offer the door. Leaving keeps the session exactly where it is. */}
              <button type="button" className="btn btn-ghost" onClick={() => { closeSheet(); navigate('/') }}>Leave for now</button>
            </div>
            <DiscardBlock />
          </div>
        </div>
      )}
    </div>
  )
}

// Each step's real body arrives in its own commit and registers here. Until then the
// step is honest about being chrome only — it still records an answer, so the session
// and the record work end to end today.
function StepBody({ step }: { step: PlanningStep }) {
  return (
    <div className="wp-placeholder">
      <div className="wp-placeholder-t">{step.title} is next up to be built</div>
      <div className="wp-placeholder-s">
        This step will read {step.requiresModule ? `your ${step.requiresModule} module` : 'what the app already knows'} —
        nothing here is typed twice. The session, its record and every other step already work,
        so you can walk the whole shape now.
      </div>
    </div>
  )
}
