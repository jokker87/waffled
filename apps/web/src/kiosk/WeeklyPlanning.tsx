import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
} from '../lib/api'
import { STEP_MODULES, type PlanningStepModule, type StepBodyProps } from './planning/registry'
import { StepPlaceholder } from './planning/StepPlaceholder'
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

// Hoisted, NOT defined inside WeeklyPlanning. A component declared in the render body
// is a new component type on every render, so React unmounts and remounts it and
// replaces its DOM nodes — which drops focus mid-interaction and made a click land on a
// node that had already been detached. Anything with a handler belongs out here.
function WeekStepper({ weekStart, canGoBack, busy, onGo, className }: {
  weekStart: string
  canGoBack: boolean
  busy: boolean
  onGo: (week: string) => void
  className?: string
}) {
  return (
    <div className={`wp-weeknav ${className ?? ''}`}>
      <button
        type="button" className="wp-weekarrow" disabled={!canGoBack || busy}
        onClick={() => onGo(addWeeks(weekStart, -1))}
        aria-label="Plan the previous week"
      >‹</button>
      <span className="wp-weeknav-l">{weekLabel(weekStart)}</span>
      <button
        type="button" className="wp-weekarrow" disabled={busy}
        onClick={() => onGo(addWeeks(weekStart, 1))}
        aria-label="Plan the next week"
      >›</button>
    </div>
  )
}

// Offered from the agenda sheet mid-session and from the record afterwards — the two
// places you'd look for "no, do this week again".
function DiscardBlock({ confirming, setConfirming, busy, onDiscard }: {
  confirming: boolean
  setConfirming: (v: boolean) => void
  busy: boolean
  onDiscard: () => void
}) {
  return (
    <div className="wp-sheet-danger">
      {confirming ? (
        <>
          <div className="wp-sheet-danger-q">
            Throw this session away and start the week over? What it already decided —
            events added, chores handed out — stays put; only the session is discarded.
          </div>
          <div className="wp-sheet-danger-acts">
            <button type="button" className="wp-sheet-danger-no" onClick={() => setConfirming(false)}>Keep it</button>
            <button type="button" className="wp-sheet-danger-yes" disabled={busy} onClick={onDiscard}>Start over</button>
          </div>
        </>
      ) : (
        <button type="button" className="wp-sheet-danger-open" onClick={() => setConfirming(true)}>Start this week over</button>
      )}
    </div>
  )
}

export function WeeklyPlanning() {
  const { step: urlStep } = useParams<{ step?: string }>()
  const [search] = useSearchParams()
  const navigate = useNavigate()

  const weekParam = search.get('week') ?? undefined
  const { view, loading, refetch } = useWeeklyPlanning(weekParam)
  const [sheet, setSheet] = useState(false)
  const [busy, setBusy] = useState(false)
  // Two-tap confirm on discarding a session — it can't be undone, and it sits next to
  // the everyday "Close".
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  // What the current step wants kept on the record. A ref, not state: it changes as the
  // step is used and only matters at the moment the answer is sent, so re-rendering the
  // whole session on every keystroke inside a step would be waste.
  const decisionData = useRef<Record<string, unknown> | null>(null)
  const setDecisionData = useCallback((d: Record<string, unknown> | null) => { decisionData.current = d }, [])

  const steps = view?.steps ?? []
  const runnable = useMemo(() => availableSteps(steps), [steps])
  const current = useMemo(() => resolveCurrent(view ?? null, urlStep), [view, urlStep])
  const next = current ? nextStepAfter(steps, current.key) : null
  const session = view?.session ?? null
  const stepMod = useStepModule(current?.key)

  // A crumb belongs to the step that set it. Moving on must not carry it onto the next
  // step's answer.
  useEffect(() => { decisionData.current = null }, [current?.key])

  // A link to a step of a week. The week rides in the query only when it isn't the
  // default, so the everyday URL stays `/planning/calendar`.
  const hrefFor = (stepKey: string | null, week?: string) => {
    const w = week ?? view?.weekStart
    const q = w && view && w !== view.defaultWeekStart ? `?week=${w}` : ''
    return `/planning${stepKey ? `/${stepKey}` : ''}${q}`
  }

  // Is the view we're holding actually about the week the URL asks for? While a week
  // change is in flight it is NOT, and acting on a stale view here would shove the URL
  // back to the old week's step. Every correction below waits for the fresh view.
  const viewMatchesUrlWeek = !!view && view.weekStart === (weekParam ?? view.defaultWeekStart)

  // Keep the address bar honest. Corrections are driven by the VIEW, never fired
  // alongside a deliberate navigation — two routing updates racing in one tick is
  // exactly how the URL ended up back on a step the session had just left.
  //
  // `replace` throughout: a correction must never become a back-button stop.
  useEffect(() => {
    if (!view || !viewMatchesUrlWeek || !session) return
    if (session.status === 'completed') {
      // Saved: the record is the surface, so the step leaves the path.
      if (urlStep) navigate(hrefFor(null), { replace: true })
      return
    }
    if (!current) return
    // A path naming a step that can't run (or naming none at all) resumes instead. A
    // path naming a runnable step is left alone — a pasted link outranks the pointer.
    if (!runnable.some((s) => s.key === urlStep)) navigate(hrefFor(current.key), { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, viewMatchesUrlWeek, session?.id, session?.status, current?.key, urlStep])

  async function go(fn: () => Promise<unknown>) {
    if (busy) return
    setBusy(true)
    try { await fn() } finally { setBusy(false); refetch() }
  }

  const start = () => go(async () => {
    const { session: s } = await weeklyPlanningApi.startSession(view?.weekStart)
    // Defensive: a start that comes back without a session is a server problem, and
    // throwing here would take down the click handler rather than the refetch showing
    // whatever actually happened.
    if (s?.currentStep) navigate(hrefFor(s.currentStep))
  })

  // Answering a step is two writes that belong together: record the answer, then move
  // the driver on. The last step's answer is the save, which is what ends the session.
  async function answer(status: 'done' | 'skipped') {
    if (!session || !current) return
    await go(async () => {
      await weeklyPlanningApi.decideStep(session.id, current.key, status, decisionData.current ?? undefined)
      decisionData.current = null
      if (next) {
        await weeklyPlanningApi.patchSession(session.id, { currentStep: next.key })
        navigate(hrefFor(next.key))
      } else {
        // No navigate here: the effect above drops the step from the path once the
        // completed session actually arrives, so the URL can't get ahead of the state.
        await weeklyPlanningApi.complete(session.id)
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
  // ONE navigate, not a setSearch plus a navigate — two routing updates in the same tick
  // race, and the query survived the one that was meant to clear it.
  const goWeek = (week: string) => {
    setSheet(false)
    if (!view) return
    navigate(week === view.defaultWeekStart ? '/planning' : `/planning?week=${week}`)
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
  const weekNav = { weekStart: view.weekStart, canGoBack, busy, onGo: goWeek }

  const discardProps = { confirming: confirmDiscard, setConfirming: setConfirmDiscard, busy, onDiscard: discard }

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
          <div className="wp-record-week">Plan another week <WeekStepper {...weekNav} /></div>
          <DiscardBlock {...discardProps} />
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
          <WeekStepper {...weekNav} className="wp-weeknav-lobby" />
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
  const stepProps: StepBodyProps | null = current
    ? { step: current, sessionId: session.id, weekStart: view.weekStart, setDecisionData, refresh: refetch, busy }
    : null

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
        {current && (stepMod ? <stepMod.Body {...stepProps!} /> : <StepPlaceholder step={current} />)}
      </div>

      <div className="wp-foot">
        <button type="button" className="wp-skip" disabled={busy} onClick={() => answer('skipped')}>Skip this step</button>
        {stepMod?.FooterExtra && stepProps && <stepMod.FooterExtra {...stepProps} />}
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
            <WeekStepper {...weekNav} className="wp-weeknav-sheet" />
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
            <DiscardBlock {...discardProps} />
          </div>
        </div>
      )}
    </div>
  )
}

// Load the step's module from the registry. Each step is its own chunk, so reaching
// step 7 never downloaded steps 1–6, and — the reason the registry exists at all — a
// step is built by editing its own files and never this one.
function useStepModule(key: string | undefined): PlanningStepModule | null {
  const [mod, setMod] = useState<PlanningStepModule | null>(null)
  useEffect(() => {
    let alive = true
    setMod(null)
    const load = key ? STEP_MODULES[key] : undefined
    if (!load) return
    load().then((m) => { if (alive) setMod(m) }).catch(() => { /* falls back to the placeholder */ })
    return () => { alive = false }
  }, [key])
  return mod
}
