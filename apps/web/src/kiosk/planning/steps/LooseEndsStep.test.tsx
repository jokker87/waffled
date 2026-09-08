import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import mod from './LooseEndsStep'
import type { PlanningStep } from '../../../lib/api'
import type { StepBodyProps } from '../registry'

// Step 1 · Loose ends — the deck, the group switch, the trail and the see-all list.
//
// What's asserted here is the design's argument, not the markup:
//   · STEP 1 ROUTES; IT DOES NOT REPAIR. A card's primary choices are DESTINATIONS,
//     and choosing one must post to /route and never to /resolve — "routing here
//     changes nothing in your modules."
//   · The switch carries BOTH counts (a ✓ when a group is clear) and the one line that
//     explains the two kinds.
//   · "Leave it open" writes NOTHING. That is what keeps per-item state out of any
//     planning table, so it must not fire a request.
//   · The routes are the cross-step contract, so they ride on setDecisionData —
//     otherwise the shell's own answer would overwrite the step's data with a crumb.

const Body = mod.Body

const step = (data: Record<string, unknown> = {}): PlanningStep => ({
  key: 'looseEnds',
  number: 1,
  title: 'Loose ends',
  ask: 'Anything still open from last week?',
  primary: 'All handled',
  act: 'Intake',
  available: true,
  status: 'pending',
  data,
  decidedAt: null,
  // Step 1 never receives a handoff: it already draws the whole board, so the server
  // excludes `looseEnds` from `parkedByStep`.
  parked: [],
})

const end = (over: Partial<Record<string, unknown>> = {}) => ({
  key: 'chore:c1',
  kind: 'chore',
  id: 'c1',
  title: 'Take the bins out',
  emoji: '🗑️',
  detail: '3 days late',
  actions: ['done'],
  // Nobody by default; the fixtures that care say who.
  owner: null as { id: string; name: string; colorHex: string | null; avatarEmoji: string | null } | null,
  ...over,
})

// The person an assigned row belongs to, shaped as the server sends it — colour and
// avatar included, so the row renders the person the way the rest of the app does.
const WALLY = { id: 'p2', name: 'Wally', colorHex: '#25A368', avatarEmoji: '🐢' }

const VIEW = {
  weekStart: '2026-09-06',
  notDone: [
    // A chore somebody already has, and a list item that cannot have an owner at all.
    end({ owner: WALLY }),
    end({ key: 'list:l1', kind: 'list', id: 'l1', title: 'Return the library books', emoji: null, detail: 'on Around the house' }),
  ],
  parked: [
    end({
      key: 'parked:p1', kind: 'parked', id: 'p1', title: 'Ask about the school trip', emoji: null,
      detail: 'Parked by Kevin · 2 weeks ago · passed over 3 times', actions: ['done', 'drop'],
    }),
  ],
  counts: { notDone: 2, parked: 1 },
  destinations: {
    notDone: [
      { to: 'tasks', label: 'Tasks', hint: 'Give it an owner and a day', primary: true },
      { to: 'calendar', label: 'Calendar', hint: 'It needs an appointment slot' },
      { to: 'kids', label: 'Kids', hint: "It's really one of the kids'" },
      { to: 'goals', label: 'Goals', hint: 'It belongs to a goal' },
    ],
    parked: [
      { to: 'tasks', label: 'Make it a task', hint: 'Someone owns it this week', primary: true },
      { to: 'calendar', label: 'Put it on the calendar', hint: 'A date to look, or a deadline' },
    ],
  },
  routes: [] as { kind: string; id: string; title: string; source: string; to: string }[],
  sources: ['chores', 'lists', 'rhythms', 'goals'],
  // The lists this step could ask about, as the step's own read now carries them.
  lists: [
    { id: 'l1', name: 'Around the house', emoji: '🏠', relevant: true },
    { id: 'l2', name: 'Someday', emoji: '💭', relevant: true },
  ],
}

const calls: { url: string; method: string; body: Record<string, unknown> | null }[] = []

// A stateful double: routing really records a route and hides the item on the next
// read, and settling really removes it — because that is the point. A double that
// replayed the same view couldn't tell a route from a no-op.
function mockApi(initial: Record<string, unknown> = VIEW, opts: { capabilities?: string[] } = {}) {
  calls.length = 0
  const state = JSON.parse(JSON.stringify(initial)) as typeof VIEW & {
    lists?: { id: string; name: string; emoji: string | null; relevant: boolean }[]
  }
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url: u, method, body })

    // Who is looking. The chooser is capability-gated, so the step has to know — and the
    // fallthrough below would otherwise hand `useHousehold` the loose-ends view.
    if (u.includes('/api/household')) {
      return {
        ok: true,
        json: async () => ({
          provisioned: true,
          household: { id: 'h1', name: 'Sites' },
          person: { id: 'p1', name: 'Kevin', capabilities: opts.capabilities ?? ['planning.manage'] },
        }),
      }
    }
    // Ruling a list in or out. Merged server-side, so only the switch that moved is sent.
    if (method === 'PUT' && u.includes('/api/weekly-planning/config')) {
      for (const [id, on] of Object.entries((body?.lists ?? {}) as Record<string, boolean>)) {
        const row = (state.lists ?? []).find((l) => l.id === id)
        if (row) row.relevant = on
      }
      return { ok: true, json: async () => ({ config: { lists: body?.lists ?? {} } }) }
    }

    if (method === 'POST' && u.endsWith('/loose-ends/route')) {
      state.routes = state.routes.filter((r) => !(r.kind === body.kind && r.id === body.id))
      if (body.to != null) state.routes.push({ kind: body.kind, id: body.id, title: body.title, source: body.source, to: body.to })
      return { ok: true, json: async () => ({ routes: JSON.parse(JSON.stringify(state.routes)) }) }
    }
    if (method === 'POST' && u.endsWith('/loose-ends/resolve')) {
      const drop = (list: typeof state.notDone) => list.filter((i) => i.id !== body.id)
      state.notDone = drop(state.notDone)
      state.parked = drop(state.parked)
      state.counts = { notDone: state.notDone.length, parked: state.parked.length }
      return { ok: true, json: async () => ({ ok: true }) }
    }
    if (method === 'POST' && u.endsWith('/loose-ends/parked')) {
      const item = end({ key: `parked:new`, kind: 'parked', id: 'new', title: body.note, emoji: null, detail: 'Parked by Kevin · today', actions: ['done', 'drop'] })
      state.parked.push(item as unknown as (typeof state.parked)[number])
      state.counts = { notDone: state.notDone.length, parked: state.parked.length }
      return { ok: true, json: async () => ({ item: { id: 'new', note: body.note } }) }
    }
    // A fresh object per read, like a real response — returning the same identity
    // would let a component that never re-reads it look like it worked.
    return { ok: true, json: async () => JSON.parse(JSON.stringify(state)) }
  }) as unknown as typeof fetch
}

// jsdom has no scrollIntoView at all. Record WHICH section the component scrolls to —
// that is the behaviour ("see all opens where you were"), and the pixels are not
// something a jsdom test could speak to anyway.
const scrolled: string[] = []
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value(this: HTMLElement) { scrolled.push(this.id) },
  })
})

const setDecisionData = vi.fn()
const refresh = vi.fn()

function renderStep(over: Partial<StepBodyProps> = {}) {
  setDecisionData.mockClear()
  refresh.mockClear()
  return render(
    <Body
      step={step()}
      sessionId="s1"
      weekStart="2026-09-06"
      setDecisionData={setDecisionData}
      refresh={refresh}
      busy={false}
      {...over}
    />
  )
}

const routeCalls = () => calls.filter((c) => c.url.endsWith('/loose-ends/route'))
const resolveCalls = () => calls.filter((c) => c.url.endsWith('/loose-ends/resolve'))
const parkCalls = () => calls.filter((c) => c.url.endsWith('/loose-ends/parked'))
const configCalls = () => calls.filter((c) => c.method === 'PUT' && c.url.includes('/weekly-planning/config'))

describe('loose ends · routing, which is the step', () => {
  it('shows one card whose choices are DESTINATIONS, with the reason under each name', async () => {
    mockApi()
    renderStep()
    expect(await screen.findByText('Take the bins out')).toBeInTheDocument()
    expect(screen.getByText('3 days late')).toBeInTheDocument()
    // The read is scoped to the week AND the session — the session is where routes live.
    // Named rather than taken as `calls[0]`: the step also reads who is looking (for the
    // lists chooser), and which request lands first is not this assertion's point.
    const read = calls.find((c) => c.method === 'GET' && c.url.includes('/loose-ends'))!
    expect(read.url).toContain('weekStart=2026-09-06')
    expect(read.url).toContain('sessionId=s1')
    // One at a time: the second item is not on screen.
    expect(screen.queryByText('Return the library books')).not.toBeInTheDocument()
    for (const label of ['Tasks', 'Calendar', 'Kids', 'Goals']) {
      expect(screen.getByRole('button', { name: new RegExp(label) })).toBeInTheDocument()
    }
    expect(screen.getByText('Give it an owner and a day')).toBeInTheDocument()
  })

  it('routing posts to /route — NOT to /resolve — and advances the deck', async () => {
    mockApi()
    renderStep()
    fireEvent.click(await screen.findByRole('button', { name: /Tasks/ }))
    await waitFor(() => expect(routeCalls()).toHaveLength(1))
    expect(routeCalls()[0].body).toEqual({
      sessionId: 's1', kind: 'chore', id: 'c1', title: 'Take the bins out', source: 'notDone', to: 'tasks',
    })
    // THE CLAIM THE WHOLE STEP RESTS ON: nothing was written to any module.
    expect(resolveCalls()).toHaveLength(0)
    expect(await screen.findByText('Return the library books')).toBeInTheDocument()
  })

  it('counts down the deck and leaves a trail with an undo', async () => {
    mockApi()
    renderStep()
    expect(await screen.findByText('1 of 2')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Tasks/ }))
    await waitFor(() => expect(screen.getByText('2 of 2')).toBeInTheDocument())

    // The trail names what just went where, so a fast path still leaves a receipt.
    const trail = await screen.findByText('Take the bins out')
    expect(trail).toBeInTheDocument()
    expect(screen.getByText(/→ Tasks/)).toBeInTheDocument()
    // …and it says what the arrow MEANS. "I clicked 'put it on the calendar' and the
    // item moved at the bottom to the -> calendar, what does that mean?" — a title, an
    // arrow and a step name is a receipt only if you already know the mechanism.
    expect(screen.getByTestId('wp-le-trail-h')).toHaveTextContent(/come up at that step/i)

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(routeCalls()).toHaveLength(2))
    // Undo is the same verb with no destination.
    expect(routeCalls()[1].body).toMatchObject({ kind: 'chore', id: 'c1', to: null })
    await waitFor(() => expect(screen.getByText('1 of 2')).toBeInTheDocument())
  })

  it('seeds what was already routed from the step’s own persisted data', async () => {
    mockApi({ ...VIEW, routes: [{ kind: 'chore', id: 'c1', title: 'Take the bins out', source: 'notDone', to: 'tasks' }] })
    renderStep({ step: step({ routes: [{ kind: 'chore', id: 'c1', title: 'Take the bins out', source: 'notDone', to: 'tasks' }] }) })
    // A reload mid-step must not re-ask what has already been triaged.
    expect(await screen.findByText('Return the library books')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Not done 1/ })).toBeInTheDocument()
  })

  it('says what the server refused rather than swallowing it', async () => {
    mockApi()
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url)
      if ((init?.method ?? 'GET') === 'POST') {
        return { ok: false, status: 400, json: async () => ({ error: 'BadRequest', message: 'the tasks step is not running in this household' }) }
      }
      calls.push({ url: u, method: 'GET', body: null })
      return { ok: true, json: async () => JSON.parse(JSON.stringify(VIEW)) }
    }) as unknown as typeof fetch
    renderStep()
    fireEvent.click(await screen.findByRole('button', { name: /Tasks/ }))
    expect(await screen.findByText(/not running in this household/i)).toBeInTheDocument()
    // …and the card is still there to be sent somewhere else.
    expect(screen.getByText('Take the bins out')).toBeInTheDocument()
  })
})

describe('loose ends · the two answers that write', () => {
  it('"It’s done already" is the exception, and it does post to /resolve', async () => {
    mockApi()
    renderStep()
    await screen.findByText('Take the bins out')
    fireEvent.click(screen.getByRole('button', { name: /It's done already/ }))
    await waitFor(() => expect(resolveCalls()).toHaveLength(1))
    expect(resolveCalls()[0].body).toEqual({ kind: 'chore', id: 'c1', action: 'done', sessionId: 's1' })
  })

  it('leaves an item open without writing anything at all', async () => {
    mockApi()
    renderStep()
    fireEvent.click(await screen.findByRole('button', { name: /Leave it open/ }))
    expect(await screen.findByText('Return the library books')).toBeInTheDocument()
    // Not a request. Per-item "seen it" state has no table and no route on purpose.
    expect(routeCalls()).toHaveLength(0)
    expect(resolveCalls()).toHaveLength(0)
  })
})

describe('loose ends · the group switch', () => {
  it('carries both counts and the one line that explains the two kinds', async () => {
    mockApi()
    renderStep()
    expect(await screen.findByRole('button', { name: /Not done 2/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Parked 1/ })).toBeInTheDocument()
    // The switch is the entire explanation, so the note travels with it.
    expect(screen.getByText(/computed from your modules/i)).toBeInTheDocument()
    // And the note says what the step DOES read, not what it doesn't. The grocery
    // sentence was an answer to a question the bug provoked; with groceries gone
    // there is no question, and a screen narrating what it isn't showing is noise.
    expect(screen.queryByText(/grocery/i)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Parked 1/ }))
    expect(await screen.findByText(/exists nowhere else yet/i)).toBeInTheDocument()
  })

  it('gives group B its own verbs, and Drop it as the answer only it can take', async () => {
    mockApi()
    renderStep()
    fireEvent.click(await screen.findByRole('button', { name: /Parked 1/ }))
    expect(await screen.findByText('Ask about the school trip')).toBeInTheDocument()
    // The line that earns the Drop underneath it.
    expect(screen.getByText(/passed over 3 times/)).toBeInTheDocument()
    for (const label of ['Make it a task', 'Put it on the calendar', 'Talk about it now', 'Keep it parked']) {
      expect(screen.getByRole('button', { name: new RegExp(label) })).toBeInTheDocument()
    }
    fireEvent.click(screen.getByRole('button', { name: 'Drop it' }))
    await waitFor(() => expect(resolveCalls()).toHaveLength(1))
    expect(resolveCalls()[0].body).toEqual({ kind: 'parked', id: 'p1', action: 'drop', sessionId: 's1' })
  })

  it('shows a check instead of a count once a group is clear', async () => {
    mockApi()
    renderStep()
    fireEvent.click(await screen.findByRole('button', { name: /Tasks/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Not done 1/ })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /Tasks/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Not done ✓/ })).toBeInTheDocument())
  })

  it('parks something new from the capture bar under group B', async () => {
    mockApi()
    renderStep()
    fireEvent.click(await screen.findByRole('button', { name: /Parked 1/ }))
    const input = await screen.findByLabelText('Park something new')
    fireEvent.change(input, { target: { value: 'Renew the passports' } })
    fireEvent.click(screen.getByRole('button', { name: 'Park it' }))
    await waitFor(() => expect(parkCalls()).toHaveLength(1))
    expect(parkCalls()[0].body).toEqual({ note: 'Renew the passports', sessionId: 's1' })
    await waitFor(() => expect(screen.getByRole('button', { name: /Parked 2/ })).toBeInTheDocument())
  })
})

describe('loose ends · see all', () => {
  it('states plainly that routing changes nothing, and shows both groups labelled', async () => {
    mockApi()
    renderStep()
    fireEvent.click(await screen.findByRole('button', { name: /see all/i }))
    expect(await screen.findByText(/routing here changes nothing in your modules/i)).toBeInTheDocument()
    expect(screen.getByText('Take the bins out')).toBeInTheDocument()
    expect(screen.getByText('Return the library books')).toBeInTheDocument()
    expect(screen.getByText('Ask about the school trip')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Not done/ })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Parked/ })).toBeInTheDocument()
  })

  // THE IA BUG. The switch used to stay on screen in see-all, still looking selected,
  // while it no longer governed anything on it — so "Not done" + See all read as a
  // filtered list of not-done items when in fact BOTH groups were listed. The v4 mock's
  // boardList frame is the answer: it renders the two labelled sections and the
  // disclaimer, and no switch. In see-all the section headings ARE the grouping, so a
  // switch there is redundant AND misleading; it belongs to the one-at-a-time mode,
  // where it genuinely picks the deck you are working through.
  it('drops the group switch — in see all the section headings ARE the grouping', async () => {
    mockApi()
    renderStep()
    expect(await screen.findByRole('group', { name: /which loose ends/i })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /see all/i }))
    await screen.findByRole('heading', { name: /Not done/ })
    expect(screen.queryByRole('group', { name: /which loose ends/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Not done/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Parked/ })).not.toBeInTheDocument()
    // Nothing is lost with it: the headings carry both counts, and the way back is the
    // control that was always there.
    expect(screen.getByRole('heading', { name: /Not done 2/ })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Parked 1/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /one at a time/i }))
    expect(await screen.findByRole('group', { name: /which loose ends/i })).toBeInTheDocument()
  })

  it('comes back to the group you left it on, not to the top of the deck', async () => {
    mockApi()
    renderStep()
    fireEvent.click(await screen.findByRole('button', { name: /Parked 1/ }))
    expect(await screen.findByText('Ask about the school trip')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /see all/i }))
    await screen.findByRole('heading', { name: /Parked/ })
    fireEvent.click(screen.getByRole('button', { name: /one at a time/i }))

    expect(await screen.findByText('Ask about the school trip')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Parked 1/ })).toHaveAttribute('aria-pressed', 'true')
  })

  // Not a second filter — both sections are always there. Entering from Parked just
  // lands you on the Parked one, so the transition keeps the context you were in
  // instead of appearing to throw it away.
  it('opens on the section you were toggled to', async () => {
    scrolled.length = 0
    mockApi()
    renderStep()
    fireEvent.click(await screen.findByRole('button', { name: /Parked 1/ }))
    fireEvent.click(screen.getByRole('button', { name: /see all/i }))
    await screen.findByRole('heading', { name: /Parked/ })
    await waitFor(() => expect(scrolled).toEqual(['wp-le-sec-parked']))
  })

  // "See all" reads as the FULLER screen, so it must not be the one place you cannot
  // drop a new note. The bar is attached to the Parked section, which is what it adds
  // to — the same reason the section headings had to carry the counts.
  it('keeps the capture bar reachable, attached to the Parked section', async () => {
    mockApi()
    renderStep()
    fireEvent.click(await screen.findByRole('button', { name: /see all/i }))
    const input = await screen.findByLabelText('Park something new')
    expect(input.closest('#wp-le-sec-parked')).toBeTruthy()

    fireEvent.change(input, { target: { value: 'Renew the passports' } })
    fireEvent.click(screen.getByRole('button', { name: 'Park it' }))
    await waitFor(() => expect(parkCalls()).toHaveLength(1))
    expect(parkCalls()[0].body).toEqual({ note: 'Renew the passports', sessionId: 's1' })
    // Still on the see-all screen, with the new note counted into the section it
    // landed in — parking is not a reason to be thrown back to the deck.
    expect(await screen.findByRole('heading', { name: /Parked 2/ })).toBeInTheDocument()
  })

  // One bar, one piece of state, two places it can appear — so a half-typed note must
  // not evaporate when you change your mind about the view. That is the same class of
  // bug as the switch that looked like it filtered.
  it('carries a half-typed note across the mode switch', async () => {
    mockApi()
    renderStep()
    fireEvent.click(await screen.findByRole('button', { name: /Parked 1/ }))
    fireEvent.change(await screen.findByLabelText('Park something new'), {
      target: { value: 'Renew the pass' },
    })
    fireEvent.click(screen.getByRole('button', { name: /see all/i }))
    expect(await screen.findByLabelText('Park something new')).toHaveValue('Renew the pass')
    fireEvent.click(screen.getByRole('button', { name: /one at a time/i }))
    expect(await screen.findByLabelText('Park something new')).toHaveValue('Renew the pass')
  })

  it('routes from the list too, without leaving it', async () => {
    mockApi()
    renderStep()
    fireEvent.click(await screen.findByRole('button', { name: /see all/i }))
    const row = (await screen.findByText('Ask about the school trip')).closest('li')!
    fireEvent.click(within(row).getByRole('button', { name: 'Make it a task' }))
    await waitFor(() => expect(routeCalls()).toHaveLength(1))
    expect(routeCalls()[0].body).toMatchObject({ kind: 'parked', id: 'p1', source: 'parked', to: 'tasks' })
    expect(screen.getByRole('heading', { name: /Not done/ })).toBeInTheDocument()
  })
})

describe('loose ends · the cleared state', () => {
  it('says what was checked, how many notes still wait, and offers the other group', async () => {
    mockApi({ ...VIEW, notDone: [], counts: { notDone: 0, parked: 1 } })
    renderStep()
    expect(await screen.findByText("Nothing's left undone")).toBeInTheDocument()
    // A claim a step never backs up is just a claim, so it names its sources.
    expect(screen.getByText(/we checked your chores, lists, rhythms, goals/i)).toBeInTheDocument()
    expect(screen.getByText(/1 parked note is still waiting/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Go to Parked' }))
    expect(await screen.findByText('Ask about the school trip')).toBeInTheDocument()
  })

  it('says both groups are clear when there is nothing anywhere', async () => {
    mockApi({ ...VIEW, notDone: [], parked: [], counts: { notDone: 0, parked: 0 } })
    renderStep()
    expect(await screen.findByText("Nothing's left undone")).toBeInTheDocument()
    expect(screen.getByText(/both groups are clear/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Go to/ })).not.toBeInTheDocument()
  })
})

describe('loose ends · the crumb on the record', () => {
  it('carries the ROUTES — the contract steps 2/6/8/9 read off the session', async () => {
    mockApi()
    renderStep()
    await screen.findByText('Take the bins out')
    fireEvent.click(screen.getByRole('button', { name: /Tasks/ }))
    await waitFor(() => {
      const last = setDecisionData.mock.calls.at(-1)![0] as { routes: unknown[] }
      expect(last.routes).toHaveLength(1)
    })
    const last = setDecisionData.mock.calls.at(-1)![0] as Record<string, unknown>
    // The shell writes this into planning_session_steps.data when the step is
    // answered, so it MUST include the routes or the final write would erase them.
    expect(Object.keys(last).sort()).toEqual(['answered', 'left', 'routes'])
    expect(last.routes).toEqual([{ kind: 'chore', id: 'c1', title: 'Take the bins out', source: 'notDone', to: 'tasks' }])
  })
})

// WHICH LISTS THIS STEP ASKS ABOUT — chosen here, in the step, by whoever is running it.
//
// "I think we want the lists election to be in the weekly planning loose ends step, and it
// shouldn't be admin gated, maybe adult gated but any adult can run weekly planning and
// choose what lists should matter vs not."
//
// The friction is here: you are looking at "Learn the banjo" off a someday list for the
// fourth week running. Sending you to Settings → Modules to silence it is the ejection
// this module exists to avoid — and Settings is admin-only, which the person driving the
// session on a Sunday evening may well not be.
describe('loose ends · which lists it asks about', () => {
  const openChooser = async () => {
    fireEvent.click(await screen.findByRole('button', { name: /Which lists/i }))
    return screen.findByText('Lists it asks about')
  }

  it('lets whoever is running the session rule a list out, without leaving the step', async () => {
    mockApi()
    renderStep()
    await openChooser()

    fireEvent.click(screen.getByLabelText('Ask about Someday in the weekly planning session'))

    // Only the switch that moved: the map is sparse and the server merges it, so sending
    // the whole thing would rule other lists back in behind another device's back.
    await waitFor(() => expect(configCalls()).toHaveLength(1))
    expect(configCalls()[0].body).toEqual({ lists: { l2: false } })
  })

  it('re-reads the deck afterwards, so the cards it stops asking about actually go', async () => {
    mockApi()
    renderStep()
    await openChooser()
    fireEvent.click(screen.getByLabelText('Ask about Someday in the weekly planning session'))
    // The step's own read is what decides the deck — the chooser writes and then asks
    // again rather than guessing which cards would have gone.
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET' && c.url.includes('/loose-ends')).length)
      .toBeGreaterThan(1))
  })

  it('names each list the way the list itself is named', async () => {
    mockApi()
    renderStep()
    await openChooser()
    expect(screen.getByText(/🏠 Around the house/)).toBeTruthy()
    expect(screen.getByText(/💭 Someday/)).toBeTruthy()
  })

  // A kid running the session sees the deck and can triage it; the household-wide choice
  // is not theirs to make.
  it('is not offered to someone without the capability', async () => {
    mockApi(VIEW, { capabilities: [] })
    renderStep()
    await screen.findByText('Take the bins out')
    expect(screen.queryByRole('button', { name: /Which lists/i })).toBeNull()
  })

  // Nothing to choose between ⇒ no control, rather than an empty sheet.
  it('is absent when the household keeps no list it could ask about', async () => {
    mockApi({ ...VIEW, lists: [] })
    renderStep()
    await screen.findByText('Take the bins out')
    expect(screen.queryByRole('button', { name: /Which lists/i })).toBeNull()
  })
})

// WHERE A ROW COMES FROM, AND WHO ALREADY HAS IT.
//
// "I dont know whether its a task or goal or what (where is it coming from?)" and "some of
// these are already assigned an owner but we have no idea who."
//
// The card deck has always labelled the kind; SEE-ALL dropped it, which is the mode the
// report came from — eleven rows of bare titles, one of them a chore called "Groceries"
// sitting next to an unchecked list item. The owner was missing from both modes.
describe('loose ends · where a row comes from and who has it', () => {
  it('labels every see-all row with the source it came from', async () => {
    mockApi()
    renderStep()
    fireEvent.click(await screen.findByRole('button', { name: /See all/ }))

    const chore = await screen.findByText('Take the bins out')
    const row = chore.closest('.wp-le-row')!
    expect(within(row as HTMLElement).getByText('Chore')).toBeTruthy()

    const listItem = screen.getByText('Return the library books').closest('.wp-le-row')!
    expect(within(listItem as HTMLElement).getByText('List')).toBeTruthy()
  })

  it('names the person a see-all row already belongs to', async () => {
    mockApi()
    renderStep()
    fireEvent.click(await screen.findByRole('button', { name: /See all/ }))

    const row = (await screen.findByText('Take the bins out')).closest('.wp-le-row')!
    expect(within(row as HTMLElement).getByText('Wally')).toBeTruthy()
  })

  // The card is one item at a time, so the ambiguity is milder there — but "we have no
  // idea who" was true of it too, and it is the same payload field.
  it('names the person on the card as well', async () => {
    mockApi()
    renderStep()
    const card = (await screen.findByText('Take the bins out')).closest('.wp-le-card')!
    expect(within(card as HTMLElement).getByText('Wally')).toBeTruthy()
  })

  // Nothing rather than a placeholder: a list item cannot have an owner at all, and an
  // empty chip on every row would be noise on the mode that already has the most of it.
  it('shows no owner where there is none', async () => {
    mockApi()
    renderStep()
    fireEvent.click(await screen.findByRole('button', { name: /See all/ }))
    const row = (await screen.findByText('Return the library books')).closest('.wp-le-row')!
    expect((row as HTMLElement).querySelector('.wp-le-owner')).toBeNull()
  })
})
