import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { ApiSendError } from '../../../lib/api/client'
import {
  looseEndsApi,
  looseEndActionLabel,
  looseEndActionHint,
  LOOSE_END_GROUPS,
  type LooseEnd,
  type LooseEndAction,
  type LooseEndDestination,
  type LooseEndGroup,
  type LooseEndRoute,
  type LooseEndsView,
} from '../../../lib/api'
import type { PlanningStepModule, StepBodyProps } from '../registry'
import '../../../styles/planning-looseEnds.css'

// Step 1 · Loose ends — a deck you work through, a switch carrying both counts, and a
// see-all list.
//
// STEP 1 ROUTES; IT DOES NOT REPAIR. Every primary choice on the card is a
// DESTINATION — the step that will handle the thing — and choosing one writes nothing
// to any module. The see-all screen says so out loud, because it is the one claim a
// user has to believe for the step to feel safe. The steps downstream do the work,
// which is why Tasks later shows rows captioned "sent here in step 1".
//
// THE DISTINCTION THE SWITCH CARRIES. "Not done" is computed from the modules that
// already own the work — nobody typed it. "Parked" is what somebody wrote down during
// the week and exists nowhere else yet, so its verbs differ (a parked thing might turn
// out to be nothing) and Drop is a real answer there. The switch is the entire
// explanation of the two kinds, so the note travels under it.
//
// THE SWITCH BELONGS TO THE DECK, NOT TO SEE-ALL. See-all lists BOTH groups under
// their own headings, so a switch there governs nothing while still looking selected —
// which read as "these are my not-done items" when it wasn't. The v4 mock's boardList
// frame settles it: two labelled sections and the disclaimer, no switch. So the switch
// renders only in card mode, where it really does pick the deck you are working
// through; the way back is the "One at a time" control that was always in the bar, and
// the group you were on survives the round trip because nothing here resets it.
//
// THREE THINGS WRITE, AND ONLY THREE. "It's done already" and "Drop it" go to the
// module / our own table; the capture bar parks a new note — and it is reachable in
// BOTH modes, since "See all" reads as the fuller screen and must not be the one place
// you cannot write something down. Everything else is either a route (recorded on the
// session) or "leave it open" / "keep it parked", which writes nothing at all — that
// is exactly what keeps per-item state out of any planning table.

const KIND_LABEL: Record<LooseEnd['kind'], string> = {
  chore: 'Chore',
  list: 'List',
  rhythm: 'Rhythm',
  goal: 'Goal',
  parked: 'Parked',
}

// One card choice: a destination, or one of the two answers that write, or the quiet
// "leave it" that writes nothing. Built here so the card renders one uniform grid
// whichever group it is showing — the design's point is that it's the SAME card.
interface Choice {
  key: string
  label: string
  hint: string
  primary?: boolean
  tone?: 'route' | 'settle' | 'quiet'
  run: () => void
}

const routeKey = (r: { kind: string; id: string }) => `${r.kind}:${r.id}`

function Deck({ item, choices, quiet, busy }: {
  item: LooseEnd
  choices: Choice[]
  quiet: Choice[]
  busy: boolean
}) {
  return (
    // Two offset layers behind the card, so it reads as a stack you are working
    // through rather than a form that happens to change.
    <div className="wp-le-stack">
      <div className="wp-le-card">
        <div className="wp-le-kind">{KIND_LABEL[item.kind]}</div>
        <div className="wp-le-t">
          {item.emoji && <span className="wp-le-emoji" aria-hidden>{item.emoji}</span>}
          {item.title}
        </div>
        {item.detail && <div className="wp-le-d">{item.detail}</div>}
        <div className="wp-le-choices">
          {choices.map((c) => (
            <button
              key={c.key}
              type="button"
              className={`wp-le-choice${c.primary ? ' primary' : ''} ${c.tone ?? 'route'}`}
              disabled={busy}
              onClick={c.run}
            >
              <b>{c.label}</b>
              <s>{c.hint}</s>
            </button>
          ))}
        </div>
        <div className="wp-le-quiet">
          {quiet.map((c) => (
            <button key={c.key} type="button" className="wp-le-quiet-b" disabled={busy} onClick={c.run}>
              {c.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function Body({ step, sessionId, weekStart, setDecisionData, busy }: StepBodyProps) {
  const [view, setView] = useState<LooseEndsView | null>(null)
  const [loading, setLoading] = useState(true)
  const [group, setGroup] = useState<LooseEndGroup>('notDone')
  const [seeAll, setSeeAll] = useState(false)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Items set aside on THIS screen ("leave it open" / "keep it parked"). Client-only by
  // design: that answer writes nothing anywhere, so it must not become a row.
  const [setAside, setSetAside] = useState<string[]>([])
  // What has been routed, seeded from the step's own persisted data so a reload
  // mid-step doesn't re-ask everything already triaged.
  const [routes, setRoutes] = useState<LooseEndRoute[]>(
    () => (Array.isArray(step.data?.routes) ? (step.data.routes as LooseEndRoute[]) : [])
  )
  const [answered, setAnswered] = useState(0)
  const [note, setNote] = useState('')
  // The see-all sections, so opening it can land on the group you were toggled to.
  const sections = useRef<Partial<Record<LooseEndGroup, HTMLElement | null>>>({})

  const load = useCallback(async () => {
    try {
      const next = await looseEndsApi.get(weekStart, sessionId)
      setView(next)
      setRoutes(next.routes)
    } catch {
      setView(null)
    } finally {
      setLoading(false)
    }
  }, [weekStart, sessionId])

  useEffect(() => { void load() }, [load])

  // A different week is a different set of loose ends, so the aside list and the tally
  // start again with it.
  useEffect(() => { setSetAside([]); setAnswered(0) }, [weekStart])

  // Opening see-all lands on the section for the group you were on. Both sections are
  // always rendered — this is a starting POSITION, not a second filter, which is the
  // distinction that matters: the whole bug was a control that looked like it filtered
  // and didn't. Guarded because jsdom has no scrollIntoView.
  useEffect(() => {
    if (!seeAll) return
    sections.current[group]?.scrollIntoView?.({ block: 'start' })
  }, [seeAll, group])

  const routedKeys = useMemo(() => new Set(routes.map(routeKey)), [routes])

  // What the deck will still show you: the group minus what has been routed and what
  // has been set aside.
  const openIn = useCallback(
    (g: LooseEndGroup): LooseEnd[] => {
      const all = g === 'notDone' ? view?.notDone : view?.parked
      return (all ?? []).filter((i) => !routedKeys.has(i.key) && !setAside.includes(i.key))
    },
    [view, routedKeys, setAside]
  )

  const remaining = useMemo(
    () => ({ notDone: openIn('notDone').length, parked: openIn('parked').length }),
    [openIn]
  )

  // THE CRUMB, and the cross-step contract in one. `routes` is what steps 2/6/8/9 read
  // off the session; the counts are the human-readable half. Never a copy of what a
  // module holds beyond the routed title, which is a label the later step renders.
  useEffect(() => {
    setDecisionData({ routes, answered, left: remaining.notDone + remaining.parked })
  }, [routes, answered, remaining.notDone, remaining.parked, setDecisionData])

  const disabled = busy || working

  const guard = useCallback(async (fn: () => Promise<unknown>) => {
    if (disabled) return
    setWorking(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(
        err instanceof ApiSendError && typeof err.body?.message === 'string'
          ? err.body.message
          : "That didn't go through — try again."
      )
    } finally {
      setWorking(false)
    }
  }, [disabled])

  const sendTo = (item: LooseEnd, source: LooseEndGroup, to: string) =>
    guard(async () => {
      const { routes: next } = await looseEndsApi.route(sessionId, item, source, to)
      setRoutes(next)
    })

  const undoRoute = (r: LooseEndRoute) =>
    guard(async () => {
      const { routes: next } = await looseEndsApi.route(sessionId, r, r.source, null)
      setRoutes(next)
    })

  const settle = (item: LooseEnd, action: LooseEndAction) =>
    guard(async () => {
      await looseEndsApi.resolve(item.kind, item.id, action, sessionId)
      setAnswered((n) => n + 1)
      await load()
      // No refresh() here: looseEndsApi.resolve emits 'weeklyPlanning', and the shell's
      // useWeeklyPlanning is already subscribed to it — calling both would fetch the
      // session view twice for every answer.
    })

  const leave = (item: LooseEnd) => {
    setError(null)
    setSetAside((keys) => (keys.includes(item.key) ? keys : [...keys, item.key]))
  }

  const park = (e: FormEvent) => {
    e.preventDefault()
    const text = note.trim()
    if (!text) return
    void guard(async () => {
      await looseEndsApi.park(text, { sessionId })
      setNote('')
      await load()
    })
  }

  // The choices a card offers: the destinations for its group, then the answers that
  // settle it here. `parked` keeps two of its four choices in the grid ("talk about it
  // now", "keep it parked") because a note might turn out to be nothing — settling it
  // is as ordinary an answer as sending it on.
  const choicesFor = (item: LooseEnd, g: LooseEndGroup): { choices: Choice[]; quiet: Choice[] } => {
    const dests: LooseEndDestination[] = (g === 'notDone' ? view?.destinations.notDone : view?.destinations.parked) ?? []
    const choices: Choice[] = dests.map((d) => ({
      key: `to:${d.to}`,
      label: d.label,
      hint: d.hint,
      primary: d.primary,
      tone: 'route',
      run: () => void sendTo(item, g, d.to),
    }))
    const quiet: Choice[] = []
    for (const a of item.actions) {
      const c: Choice = {
        key: `do:${a}`,
        label: looseEndActionLabel(a, item.kind),
        hint: looseEndActionHint(a, item.kind),
        tone: 'settle',
        run: () => void settle(item, a),
      }
      // A note's "talk about it now" is one of its four choices; everywhere else the
      // writing answers stay quiet, under the destinations.
      if (g === 'parked' && a === 'done') choices.push(c)
      else quiet.push({ ...c, tone: 'quiet' })
    }
    const leaveChoice: Choice = {
      key: 'leave',
      label: g === 'parked' ? 'Keep it parked' : 'Leave it open',
      hint: g === 'parked' ? "It isn't time yet" : 'Nothing changes anywhere',
      tone: 'quiet',
      run: () => leave(item),
    }
    if (g === 'parked') choices.push(leaveChoice)
    else quiet.unshift(leaveChoice)
    return { choices, quiet }
  }

  if (loading) return <div className="wp-le"><div className="wp-le-empty">Looking for what's still open…</div></div>
  if (!view) return <div className="wp-le"><div className="wp-le-empty">Couldn't read your loose ends — reload and try again.</div></div>

  const card = openIn(group)[0] ?? null
  const total = (group === 'notDone' ? view.notDone : view.parked).length
  const position = total - openIn(group).length + 1
  const other: LooseEndGroup = group === 'parked' ? 'notDone' : 'parked'
  const otherLabel = LOOSE_END_GROUPS.find((g) => g.key === other)!.label
  const groupNote = LOOSE_END_GROUPS.find((g) => g.key === group)!.note
  // The trail names what was just routed, most recent first, and undoes the last one.
  const trail = routes.slice(-3).reverse()
  // Step NAMES for the trail. "Not done"'s destination labels ARE the step titles
  // ("Tasks", "Calendar"); "Parked"'s are verbs ("Make it a task"), which read wrong
  // after an arrow — so the trail always uses the notDone label, falling back to the
  // key for a step whose module is off (a route can outlive the toggle).
  const stepName = (to: string) => view.destinations.notDone.find((d) => d.to === to)?.label ?? to

  // Group B captures. So step 1 does create parked items after all: the board is where
  // "one more thing" goes when it belongs to no module yet.
  //
  // Built once and rendered in BOTH modes. It used to be card-mode only, which made
  // "See all" — the screen that reads as the fuller one — the single place you could
  // not drop a note. In see-all it sits inside the Parked section rather than at the
  // foot of the screen, so what it adds to is never in question.
  const captureBar = (
    <form className="wp-le-capture" onSubmit={park}>
      <span className="wp-le-capture-p" aria-hidden>＋</span>
      <input
        className="wp-le-capture-in"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        disabled={disabled}
        placeholder="Drop something new on the board — one line is enough"
        aria-label="Park something new"
      />
      <button type="submit" className="btn btn-primary wp-le-capture-go" disabled={disabled || !note.trim()}>
        Park it
      </button>
    </form>
  )

  return (
    <div className="wp-le">
      <div className="wp-le-bar">
        {seeAll ? (
          // No switch here. See-all shows BOTH groups under their own headings, so a
          // switch would sit there looking selected while governing nothing on screen —
          // the exact thing that made this screen read as a filtered list. A plain
          // label says what you are looking at instead.
          <div className="wp-le-all-t">Everything still open</div>
        ) : (
          /* The switch carries the distinction AND both counts, so you always know what
             is left in the group you are not looking at. A cleared group shows a check
             instead of a zero. */
          <div className="wp-le-switch" role="group" aria-label="Which loose ends">
            {LOOSE_END_GROUPS.map((g) => (
              <button
                key={g.key}
                type="button"
                className={`wp-le-tab${g.key === group ? ' on' : ''}`}
                aria-pressed={g.key === group}
                onClick={() => { setGroup(g.key); setError(null) }}
              >
                {g.label}{' '}
                <span className="wp-le-n">{remaining[g.key] === 0 ? '✓' : remaining[g.key]}</span>
              </button>
            ))}
          </div>
        )}
        {/* The escape hatch for the week someone dropped twenty things — and, from
            see-all, the only way back, which is why it never moves. */}
        <button type="button" className="wp-le-seeall" aria-pressed={seeAll} onClick={() => setSeeAll((v) => !v)}>
          {seeAll ? 'One at a time' : 'See all'}
        </button>
      </div>

      {/* The switch is the entire explanation of the two kinds, so the note goes with
          it — in see-all each section carries its own caption instead. */}
      {!seeAll && <div className="wp-le-note">{groupNote}</div>}

      {error && <div className="wp-le-err" role="alert">{error}</div>}

      {seeAll ? (
        <div className="wp-le-list">
          {/* The one claim the user has to believe for this step to feel safe. */}
          <div className="wp-le-disclaimer">
            Routing here changes nothing in your modules — it only decides which step handles it.
          </div>
          {LOOSE_END_GROUPS.map((g) => (
            <section
              key={g.key}
              id={`wp-le-sec-${g.key}`}
              className="wp-le-sec"
              ref={(el) => { sections.current[g.key] = el }}
            >
              {/* With no switch above, the heading is the whole label for what follows:
                  the name, the count the switch used to carry, and the mock's four-word
                  version of what the group means. */}
              <h3 className="wp-le-sec-h">
                {g.label} <span className="wp-le-n">{remaining[g.key] === 0 ? '✓' : remaining[g.key]}</span>
                <span className="wp-le-sec-cap">· {g.caption}</span>
              </h3>
              {openIn(g.key).length === 0 ? (
                <div className="wp-le-empty wp-le-empty-sm">
                  {g.key === 'parked' ? 'Nothing parked is waiting.' : 'Nothing left open.'}
                </div>
              ) : (
                <ul className="wp-le-rows">
                  {openIn(g.key).map((item) => (
                    <li key={item.key} className="wp-le-row">
                      <span className="wp-le-emoji" aria-hidden>{item.emoji ?? '•'}</span>
                      <span className="wp-le-row-main">
                        <b>{item.title}</b>
                        {item.detail && <s>{item.detail}</s>}
                      </span>
                      <span className="wp-le-row-acts">
                        {((g.key === 'notDone' ? view.destinations.notDone : view.destinations.parked)).map((d) => (
                          <button
                            key={d.to}
                            type="button"
                            className={`wp-le-pill${d.primary ? ' primary' : ''}`}
                            disabled={disabled}
                            onClick={() => void sendTo(item, g.key, d.to)}
                          >
                            {d.label}
                          </button>
                        ))}
                        {item.actions.map((a) => (
                          <button
                            key={a}
                            type="button"
                            className="wp-le-pill quiet"
                            disabled={disabled}
                            onClick={() => void settle(item, a)}
                          >
                            {looseEndActionLabel(a, item.kind)}
                          </button>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {g.key === 'parked' && captureBar}
            </section>
          ))}
        </div>
      ) : card ? (
        <div className="wp-le-deck">
          <div className="wp-le-pos">{position} of {total}</div>
          <Deck item={card} {...choicesFor(card, group)} busy={disabled} />
        </div>
      ) : (
        // The cleared state. A group with nothing left is worth saying plainly, and
        // worth saying WHAT was looked at — "nothing's left undone" from a step that
        // never named its sources would just be a claim.
        <div className="wp-le-clear">
          <div className="wp-le-check" aria-hidden>✓</div>
          <div className="wp-le-clear-t wf-serif">
            {group === 'parked' ? "Nothing's parked" : "Nothing's left undone"}
          </div>
          <div className="wp-le-clear-s">
            {group === 'parked'
              ? 'Nobody wrote anything down this week that lives nowhere else yet.'
              : `We checked your ${view.sources.length ? view.sources.join(', ') : 'modules'}.`}
            {remaining[other] > 0
              ? ` ${remaining[other]} ${other === 'parked' ? (remaining[other] === 1 ? 'parked note is' : 'parked notes are') : (remaining[other] === 1 ? 'loose end is' : 'loose ends are')} still waiting.`
              : ' Both groups are clear.'}
          </div>
          {remaining[other] > 0 && (
            <button type="button" className="btn btn-primary wp-le-clear-go" onClick={() => setGroup(other)}>
              Go to {otherLabel}
            </button>
          )}
        </div>
      )}

      {/* The trail: what you just routed, and a way back out of the last one. */}
      {trail.length > 0 && (
        <div className="wp-le-trail">
          {/* WHAT THE ARROW MEANS, said once. "I clicked 'put it on the calendar' and
              the item moved at the bottom to the -> calendar, what does that mean?" —
              a title, an arrow and a step name is a receipt only to somebody who
              already knows the mechanism. Routing does not DO the thing; it hands the
              item to the step that will, and every destination is still ahead of this
              one tonight. That is the sentence that was missing. */}
          <span className="wp-le-trail-h" data-testid="wp-le-trail-h">
            Sent ahead — they&rsquo;ll come up at that step later tonight
          </span>
          {trail.map((r, i) => (
            <span key={routeKey(r)} className={`wp-le-trail-i${i === 0 ? ' last' : ''}`}>
              <b>{r.title}</b> → {stepName(r.to)}
            </span>
          ))}
          <button type="button" className="wp-le-undo" disabled={disabled} onClick={() => void undoRoute(trail[0])}>
            Undo
          </button>
        </div>
      )}

      {/* In card mode it belongs to group B's deck, so it shows with it. */}
      {group === 'parked' && !seeAll && captureBar}
    </div>
  )
}

const mod: PlanningStepModule = { Body }
export default mod
