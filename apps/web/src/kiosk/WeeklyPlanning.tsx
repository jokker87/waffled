import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import {
  useWeeklyPlanning,
  weeklyPlanningApi,
  looseEndsApi,
  availableSteps,
  stepsByAct,
  resolveCurrent,
  nextStepAfter,
  planningDayName,
  addWeeks,
  type PlanningStep,
} from '../lib/api'
import { STEP_MODULES, type PlanningStepModule, type StepBodyProps } from './planning/registry'
import { StepPlaceholder } from './planning/StepPlaceholder'
import { StepErrorBoundary } from './planning/StepErrorBoundary'
import { HandoffCtx, type HandoffAction } from './planning/handoff'
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

/**
 * A parked note handed to the step it was tagged for.
 *
 * THE SHELL OWNS THIS, not the ten steps. `planning_parked_items.step_key` names a
 * DESTINATION — "which step is going to look at this" — and for a while nothing read it:
 * only steps 1, 3 and 10 touched the table, so a note tagged for Meals or Tasks was
 * never seen again until the recap's last call. It was reported exactly that way: "I
 * added a bunch to the park it thing, expecting to go over them in the appropriate step
 * but I never saw them again, where did they go?"
 *
 * It belongs here because the banner is identical on every step, because this component
 * already refetches the session view after every write (so a note dealt with anywhere
 * stops being offered everywhere), and because each step's OWN affordances are what act
 * on the note — the banner's job is to put it back in front of you at the moment it is
 * actionable, not to grow a tenth way to add a chore.
 *
 * Two answers, both of which the resolve route already understands. "Handled" resolves
 * the note (you did the thing with the step's own controls). "Drop it" says it was never
 * really a thing. Leaving it alone is the third answer and writes nothing — the note
 * stays parked and turns up again in the recap, which is what parking is for.
 *
 * …and, when the step lends one, a THIRD answer that actually does the thing: "Make a
 * task" on Tasks, "Make an event" on Calendar. Reported as "while handled vs not kind
 * of works, I feel like we should have an action relevant to the page we are on". It
 * opens the STEP'S own composer (see `./handoff`) rather than growing a composer here,
 * and the note is settled only if something was really created. A step with no composer
 * lends nothing and the banner stays as it was — a button promising an action it does
 * not perform is worse than the plain one.
 */
function Handoff({ step, sessionId, busy, onDone, action, onAct }: {
  step: PlanningStep
  sessionId: string
  busy: boolean
  onDone: () => void
  action: HandoffAction | null
  onAct: (id: string, note: string) => void
}) {
  const [working, setWorking] = useState<string | null>(null)
  const [hidden, setHidden] = useState<string[]>([])

  const answer = async (id: string, action: 'done' | 'drop') => {
    if (working) return
    setWorking(id)
    try {
      await looseEndsApi.resolve('parked', id, action, sessionId)
      // Hidden locally as well as refetched: the refetch is what makes it true, and this
      // is what makes it feel true before the round trip lands.
      setHidden((h) => [...h, id])
      onDone()
    } catch {
      // Left on screen rather than half-answered. The next refetch is authoritative.
    } finally {
      setWorking(null)
    }
  }

  const notes = (step.parked ?? []).filter((n) => !hidden.includes(n.id))
  if (notes.length === 0) return null

  return (
    <div className="wp-handoff" data-testid="wp-handoff">
      <div className="wp-handoff-h">
        <span aria-hidden>📌</span>
        {notes.length === 1 ? 'You parked this for right here' : `You parked ${notes.length} things for right here`}
      </div>
      <ul className="wp-handoff-list">
        {notes.map((n) => (
          <li key={n.id} className="wp-handoff-row" data-testid={`wp-handoff-${n.id}`}>
            <span className="wp-handoff-note">
              {n.note}
              {n.byline && <em>{n.byline}</em>}
            </span>
            <span className="wp-handoff-acts">
              {action && (
                <button
                  type="button"
                  className="btn btn-primary wp-handoff-act is-make"
                  disabled={busy || working === n.id}
                  onClick={() => onAct(n.id, n.note)}
                >
                  {action.label}
                </button>
              )}
              <button
                type="button"
                className="btn btn-ghost wp-handoff-act"
                disabled={busy || working === n.id}
                onClick={() => void answer(n.id, 'done')}
              >
                {action ? 'Already handled' : 'Handled'}
              </button>
              <button
                type="button"
                className="btn btn-ghost wp-handoff-act is-drop"
                disabled={busy || working === n.id}
                onClick={() => void answer(n.id, 'drop')}
              >
                Drop it
              </button>
            </span>
          </li>
        ))}
      </ul>
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

  // THE VERB THIS STEP LENDS THE BANNER, if it has one. See `./handoff` — the shell
  // keeps the banner and the step keeps its composer, so there is still exactly one way
  // to add a chore in this app.
  const [handoffAction, setHandoffAction] = useState<HandoffAction | null>(null)
  const register = useCallback((a: HandoffAction | null) => setHandoffAction(a), [])
  // The note whose composer is currently open. A ref, not state: nothing renders from
  // it, and it must survive the re-render the composer opening causes.
  const acting = useRef<string | null>(null)
  const sessionId = session?.id ?? null

  const onAct = useCallback(
    (id: string, note: string) => {
      acting.current = id
      handoffAction?.run(note)
    },
    [handoffAction]
  )

  const finish = useCallback(
    (created: boolean) => {
      const id = acting.current
      acting.current = null
      // A CANCELLED composer settles nothing. Ticking the note off here would throw away
      // the only record that it still needs doing, on the strength of somebody having
      // opened a box and closed it again.
      if (!created || !id || !sessionId) return
      looseEndsApi
        .resolve('parked', id, 'done', sessionId)
        .then(() => refetch())
        // Left on the banner rather than half-answered; the next refetch is the truth.
        .catch(() => {})
    },
    [sessionId, refetch]
  )

  const handoffCtx = useMemo(() => ({ register, finish }), [register, finish])


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
    <HandoffCtx.Provider value={handoffCtx}>
    <div className="wp-screen wp-in">
      <div className="wp-head">
        <button type="button" className="wp-stepchip" onClick={() => setSheet(true)} aria-expanded={sheet}>
          {pos} of {runnable.length}
          <svg viewBox="0 0 24 24" aria-hidden><path d="M6 9l6 6 6-6" /></svg>
        </button>
        <div className="wp-title wf-serif">{current?.title}</div>
        <div className="wp-ask">{current?.ask}</div>
        <div className="wp-week">{weekLabel(view.weekStart)}</div>
        {/* THE DOOR, in the chrome rather than only inside the agenda sheet.
            "We do need some sort of exit button without going through the whole thing."
            There was already a way out — but it lived behind the step counter, in a sheet
            you have to know opens, which is no use to somebody who has decided to stop
            halfway. A ten-step surface with no visible exit reads as one you are
            committed to finishing.
            The words are the sheet's, deliberately: "for now" is the part that matters,
            because leaving keeps the session and everything it has already decided. */}
        <button
          type="button"
          className="wp-exit"
          data-testid="wp-exit"
          onClick={() => navigate('/')}
        >
          Leave for now
        </button>
        {/* The 2px hair — the only progress indicator v4 keeps. */}
        <div className="wp-prog"><div style={{ width: `${pct}%` }} /></div>
      </div>

      <div className="wp-body">
        {/* `?? []` on purpose: a payload missing the field must cost the banner, never
            the whole session screen. The shell is the one component whose failure has
            nowhere to fall back to — there is no boundary above it. */}
        {current && (current.parked ?? []).length > 0 && (
          <Handoff
            step={current}
            sessionId={session.id}
            busy={busy}
            onDone={refetch}
            action={handoffAction}
            onAct={onAct}
          />
        )}
        {current && (
          // Keyed on the step so moving on retries rather than inheriting a failure.
          <StepErrorBoundary key={current.key} title={current.title}>
            {stepMod ? <stepMod.Body {...stepProps!} /> : <StepPlaceholder step={current} />}
          </StepErrorBoundary>
        )}
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
          <div className="modal-card wp-sheet" data-testid="wp-sheet" onClick={(e) => e.stopPropagation()}>
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
    </HandoffCtx.Provider>
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
