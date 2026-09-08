import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router'
import { WeeklyPlanning } from './WeeklyPlanning'

// The session shell: the lobby, the chrome each step hangs off, the agenda sheet
// behind the step counter, and the saved record. The step BODIES land one at a time;
// what's asserted here is the frame they all share.
//
// The step catalog is server-owned, so every fixture below is shaped like the real
// /api/weekly-planning payload — including a step whose module is off, which is the
// case that decides what "3 of 9" counts.

const step = (
  key: string,
  number: number,
  title: string,
  act: string,
  extra: Partial<{
    available: boolean; status: string; requiresModule: string
    parked: { id: string; note: string; byline: string | null }[]
  }> = {}
) => ({
  key, number, title, act,
  ask: `${title}?`,
  primary: 'Looks right',
  available: true,
  status: 'pending',
  data: {},
  decidedAt: null,
  // Parked notes tagged for THIS step — the handoff the shell renders above the body.
  parked: [],
  ...extra,
})

const STEPS = [
  step('looseEnds', 1, 'Loose ends', 'Intake'),
  step('calendar', 2, 'Calendar', 'Frame the week'),
  step('horizon', 3, 'Horizon scan', 'Frame the week'),
  // Off because its module is off — it must not be counted or listed anywhere.
  step('familyNight', 4, 'Family night', 'Claim the good', { available: false, requiresModule: 'familyNight' }),
  step('recap', 5, 'Recap', 'Close'),
]

// Leaving a session is remembered PER DEVICE (see `PAUSED_KEY` in the shell), so it has
// to be cleared between tests or one test's "leave" would put the next one in the lobby.
// Deliberately not in `mockApi`: a test that re-renders mid-way is simulating coming back
// to the tab, and that must see the flag that was set before it.
beforeEach(() => { sessionStorage.clear() })

const calls: { url: string; method: string; body: Record<string, unknown> | null }[] = []

// A STATEFUL double: completing really flips the session to completed and discarding
// really removes it, so the screen's reaction to the *fresh* view is what's under test.
// A double that always replayed the same view couldn't catch the URL getting ahead of
// the state, which is precisely the bug this pass fixed.
function mockApi(view: Record<string, unknown>) {
  calls.length = 0
  const state = JSON.parse(JSON.stringify(view)) as Record<string, unknown>
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    calls.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : null })

    // The recap read, ANSWERED BEFORE the generic weekly-planning GET below — both are
    // GETs under /api/weekly-planning, and handing the shell's own view to a surface
    // expecting days/groups/counts is how the record's read-back came back empty.
    if (u.includes('/api/weekly-planning/recap') && method === 'GET') {
      return { ok: true, json: async () => (state.recap ?? RECAP) }
    }
    if (u.includes('/api/weekly-planning') && method === 'GET') return { ok: true, json: async () => state }
    // Real step bodies now load in place of the stubs, and they read other modules.
    // The shell's tests aren't about their content, but they must not crash on a reply
    // shaped like nothing — a step body that throws is covered separately, below.
    if (method === 'GET') {
      return { ok: true, json: async () => ({ events: [], persons: [], chores: [], instances: [], items: [], goals: [], groups: [], meals: [], entries: [], recipes: [] }) }
    }
    if (method === 'POST' && u.endsWith('/complete')) {
      state.session = { ...(state.session as object), status: 'completed', completedAt: '2026-09-06T17:40:00.000Z' }
    }
    if (method === 'DELETE' && u.includes('/session/')) state.session = null
    // Starting really creates a session for the week on screen.
    if (method === 'POST' && u.endsWith('/api/weekly-planning/session')) {
      state.session = session({ weekStart: state.weekStart as string, currentStep: 'looseEnds' })
    }
    // Correcting a parked note from the gold box. Matched before the session PATCH below
    // — both are PATCHes under /api/weekly-planning — and it answers with the ROW, which
    // is what the editor reads back.
    if (method === 'PATCH' && u.includes('/loose-ends/parked/')) {
      const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>
      const id = decodeURIComponent(u.split('/').pop()!)
      return {
        ok: true,
        json: async () => ({
          item: { id, note: body.note ?? 'book the campsite', stepKey: body.stepKey ?? 'calendar' },
        }),
      }
    }
    if (method === 'PATCH' && u.includes('/session/')) {
      const patch = init?.body ? JSON.parse(String(init.body)) : {}
      state.session = { ...(state.session as object), ...patch, ...(patch.status === 'active' ? { completedAt: null } : {}) }
    }
    return { ok: true, json: async () => ({ ok: true, session: state.session, steps: state.steps }) }
  }) as unknown as typeof fetch
}

// What `GET /api/weekly-planning/recap` answers with: the week read back. Shaped like
// the real payload — a day with a dinner and an event, a module group that names the step
// that owns it, and a step whose honest answer was "nothing this week".
const RECAP = {
  weekStart: '2026-09-06',
  savedAt: '2026-09-06T17:40:00.000Z',
  days: [
    {
      date: '2026-09-06', meal: 'Lentil soup', cook: 'Lottie',
      events: [{ id: 'e1', title: 'Swim lesson', when: '9:00 AM', personId: 'p1', personName: 'Ada', personColor: '#38bdf8', participantIds: ['p1'] }],
      more: 0,
    },
    { date: '2026-09-07', meal: null, cook: null, events: [], more: 2 },
  ],
  groups: [
    { key: 'calendar', label: 'Calendar', headline: '6 things on the week', detail: 'Swim lesson · Dentist', count: 2, stepKey: 'calendar' },
  ],
  lastCall: [],
  lastCallMore: 0,
  leftAlone: [
    { key: 'none:goals', label: 'Goals', detail: 'Nothing changed this week', badge: 'none', stepKey: 'goals' },
  ],
  counts: { decisions: 2, deferred: 1, parked: 0 },
}

const baseView = (over: Record<string, unknown> = {}) => ({
  config: { dayOfWeek: 0, time: '17:00', steps: {}, showOnToday: true },
  weekStart: '2026-09-06',
  defaultWeekStart: '2026-09-06',
  // The floor: this household's current week is the one before the default.
  minWeekStart: '2026-08-30',
  session: null,
  steps: STEPS,
  ...over,
})

const session = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  weekStart: '2026-09-06',
  status: 'active',
  currentStep: 'calendar',
  driverPersonId: 'p1',
  startedAt: '2026-09-06T17:00:00.000Z',
  completedAt: null,
  ...over,
})

// The URL is part of this screen's state, so the tests mount the real routes and read
// the location back — asserting on component state alone would miss the address bar
// going stale, which is the whole point of `/planning/:step`.
function Where() {
  const l = useLocation()
  return <div data-testid="where">{l.pathname}{l.search}</div>
}

const drawAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Where />
      <Routes>
        <Route path="/planning" element={<WeeklyPlanning />} />
        <Route path="/planning/:step" element={<WeeklyPlanning />} />
      </Routes>
    </MemoryRouter>
  )

const draw = () => drawAt('/planning')
const where = () => screen.getByTestId('where').textContent
const sent = (m: string, frag: string) => calls.filter((c) => c.method === m && c.url.includes(frag))

describe('weekly planning · the lobby', () => {
  it('names the session by its configured day and offers to start it', async () => {
    mockApi(baseView())
    draw()
    expect(await screen.findByText(/Sunday's session/)).toBeTruthy()
    // The unavailable step is not counted — a household with family night off is
    // running four steps, not five.
    expect(screen.getByText(/4 steps\./)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Start the session/ }))
    await waitFor(() => expect(sent('POST', '/api/weekly-planning/session').length).toBe(1))
  })

  it('lists the acts, and never a step whose module is off', async () => {
    mockApi(baseView())
    draw()
    expect(await screen.findByText('Frame the week')).toBeTruthy()
    expect(screen.getByText(/Calendar · Horizon scan/)).toBeTruthy()
    expect(screen.queryByText('Claim the good')).toBeNull()
    expect(screen.queryByText(/Family night/)).toBeNull()
  })
})

describe('weekly planning · the session chrome', () => {
  it('shows the counter, the title and the one question the step asks', async () => {
    mockApi(baseView({ session: session() }))
    draw()
    // Calendar is the 2nd AVAILABLE step of 4 — the counter skips the disabled one.
    expect(await screen.findByRole('button', { name: /2 of 4/ })).toBeTruthy()
    expect(screen.getByText('Calendar')).toBeTruthy()
    expect(screen.getByText('Calendar?')).toBeTruthy()
  })

  it('names the next step on the primary button', async () => {
    mockApi(baseView({ session: session() }))
    draw()
    expect(await screen.findByText(/next: Horizon scan/)).toBeTruthy()
  })

  it('records the answer and moves to the next step', async () => {
    mockApi(baseView({ session: session() }))
    draw()
    fireEvent.click(await screen.findByRole('button', { name: /Looks right/ }))
    await waitFor(() => expect(sent('POST', '/session/s1/step').length).toBe(1))
    expect(sent('POST', '/session/s1/step')[0].body).toMatchObject({ stepKey: 'calendar', status: 'done' })
    await waitFor(() => expect(sent('PATCH', '/session/s1')[0].body).toMatchObject({ currentStep: 'horizon' }))
  })

  it('treats a skip as its own answer, not a failure', async () => {
    mockApi(baseView({ session: session() }))
    draw()
    fireEvent.click(await screen.findByRole('button', { name: /Skip this step/ }))
    await waitFor(() => expect(sent('POST', '/session/s1/step')[0].body).toMatchObject({ stepKey: 'calendar', status: 'skipped' }))
  })

  it('finishes the session on the last step instead of advancing', async () => {
    mockApi(baseView({ session: session({ currentStep: 'recap' }) }))
    draw()
    fireEvent.click(await screen.findByRole('button', { name: /Looks right/ }))
    await waitFor(() => expect(sent('POST', '/session/s1/complete').length).toBe(1))
  })

  it('falls back to the first available step when the driver is on a step that got turned off', async () => {
    mockApi(baseView({ session: session({ currentStep: 'familyNight' }) }))
    draw()
    // Not stranded on a step with nothing to show.
    expect(await screen.findByText('Loose ends')).toBeTruthy()
  })
})

describe('weekly planning · the agenda sheet', () => {
  it('keeps the ten steps behind the counter rather than on screen', async () => {
    mockApi(baseView({ session: session() }))
    draw()
    expect(screen.queryByText('Intake')).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: /2 of 4/ }))
    expect(screen.getByText('Intake')).toBeTruthy()
    expect(screen.getByText("you're here")).toBeTruthy()
  })

  it('jumps to a step that was tapped', async () => {
    mockApi(baseView({ session: session() }))
    draw()
    fireEvent.click(await screen.findByRole('button', { name: /2 of 4/ }))
    fireEvent.click(screen.getByRole('button', { name: /Loose ends/ }))
    await waitFor(() => expect(sent('PATCH', '/session/s1')[0].body).toMatchObject({ currentStep: 'looseEnds' }))
  })
})

// Coming back to Planning always RESUMES (that's what lets another device pick the
// session up), which means the lobby is otherwise unreachable once a week is started.
// So the session needs both doors: leave, and start over.
describe('weekly planning · leaving and starting over', () => {
  it('offers a way out of the session, without discarding it', async () => {
    mockApi(baseView({ session: session() }))
    draw()
    fireEvent.click(await screen.findByRole('button', { name: /2 of 4/ }))
    fireEvent.click(within(screen.getByTestId('wp-sheet')).getByRole('button', { name: /Leave for now/ }))
    // Both doors land in the same place — the planning lobby, not Today.
    await waitFor(() => expect(screen.getByTestId('wp-paused')).toBeTruthy())
    expect(sent('DELETE', '/session/s1').length).toBe(0)
  })

  it('leaves you where you can pick a week, and STAYS left', async () => {
    // "leave for now just takes me out of the planning tab, but if I tap the planning tab
    // it brings me right back. I expected to leave the planning session and then go back
    // to where I can select a week to plan for."
    //
    // Two faults in one sentence. The button dropped you on Today, which the nav rail
    // already does — so it was decoration. And coming back to Planning resumes, by
    // design (it is what lets another device pick a session up), so leaving changed
    // nothing at all.
    mockApi(baseView({ session: session() }))
    draw()
    fireEvent.click(await screen.findByTestId('wp-exit'))

    // WHERE YOU LAND: the planning lobby, with the session offered rather than forced,
    // and the week stepper that was previously buried in the agenda sheet.
    const paused = await screen.findByTestId('wp-paused')
    expect(within(paused).getByRole('button', { name: /Resume/i })).toBeInTheDocument()
    expect(within(paused).getByText(/Plan another week/i)).toBeInTheDocument()
    // Still not a deletion, and still not an answer to the step you were standing on.
    expect(sent('DELETE', '/session/s1').length).toBe(0)
    expect(sent('POST', '/session/s1/step').length).toBe(0)

    // AND IT STAYS LEFT. Rendering /planning again — which is what tapping the nav tab
    // does — must not drop you back into step 5.
    cleanup()
    mockApi(baseView({ session: session() }))
    draw()
    expect(await screen.findByTestId('wp-paused')).toBeTruthy()
  })

  it('resumes from the lobby, and then stops offering to', async () => {
    mockApi(baseView({ session: session() }))
    draw()
    fireEvent.click(await screen.findByTestId('wp-exit'))
    fireEvent.click(within(await screen.findByTestId('wp-paused')).getByRole('button', { name: /Resume/i }))
    await waitFor(() => expect(where()).toBe('/planning/calendar'))

    // Resuming is the opposite intent, so coming back resumes again as it always did —
    // the pause is one device saying "not right now", not a new session state.
    cleanup()
    mockApi(baseView({ session: session() }))
    draw()
    await waitFor(() => expect(screen.queryByTestId('wp-paused')).toBeNull())
  })

  it('puts the door in the session chrome, not only inside the agenda sheet', async () => {
    // "We do need some sort of exit button without going through the whole thing."
    //
    // There WAS a way out, and that is the problem: it lived behind the step counter, in
    // a sheet you have to know opens. Someone halfway through a session who wants to stop
    // is not going to go looking for it in a menu — and a decision surface with no visible
    // way out reads as a surface you are committed to finishing.
    mockApi(baseView({ session: session() }))
    draw()

    // On screen without opening anything.
    const exit = await screen.findByTestId('wp-exit')
    expect(screen.queryByTestId('wp-sheet')).toBeNull()

    fireEvent.click(exit)
    // The step leaves the path, and you land on Planning rather than on Today — leaving
    // the session is not the same as leaving the app.
    await waitFor(() => expect(where()).toBe('/planning'))
    expect(await screen.findByTestId('wp-paused')).toBeTruthy()
    // Leaving is not deleting, and it is not answering the step you were standing on.
    expect(sent('DELETE', '/session/s1').length).toBe(0)
    expect(sent('POST', '/session/s1/step').length).toBe(0)
    expect(sent('POST', '/session/s1/complete').length).toBe(0)
  })

  it('confirms before throwing a session away', async () => {
    mockApi(baseView({ session: session() }))
    draw()
    fireEvent.click(await screen.findByRole('button', { name: /2 of 4/ }))
    fireEvent.click(screen.getByRole('button', { name: /Start this week over/ }))
    // Says plainly what survives, so "start over" doesn't read as "undo my week".
    expect(screen.getByText(/stays put; only the session is discarded/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /^Keep it$/ }))
    expect(sent('DELETE', '/session/s1').length).toBe(0)
  })

  it('discards the session and lands back on the lobby', async () => {
    mockApi(baseView({ session: session() }))
    draw()
    fireEvent.click(await screen.findByRole('button', { name: /2 of 4/ }))
    fireEvent.click(screen.getByRole('button', { name: /Start this week over/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Start over$/ }))
    await waitFor(() => expect(sent('DELETE', '/session/s1').length).toBe(1))
    await waitFor(() => expect(where()).toBe('/planning'))
  })

  it('offers the same door on a finished session', async () => {
    mockApi(baseView({ session: session({ status: 'completed', completedAt: '2026-09-06T17:40:00.000Z' }) }))
    draw()
    expect(await screen.findByText('The week is decided')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Start this week over/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Start over$/ }))
    await waitFor(() => expect(sent('DELETE', '/session/s1').length).toBe(1))
  })
})

describe('weekly planning · the record', () => {
  it('reads back what was decided, and offers a way back in', async () => {
    mockApi(baseView({
      session: session({ status: 'completed', completedAt: '2026-09-06T17:40:00.000Z' }),
      steps: [
        step('looseEnds', 1, 'Loose ends', 'Intake', { status: 'done' }),
        step('calendar', 2, 'Calendar', 'Frame the week', { status: 'skipped' }),
        step('recap', 3, 'Recap', 'Close'),
      ],
    }))
    draw()
    expect(await screen.findByText('The week is decided')).toBeTruthy()
    expect(screen.getByText('Loose ends')).toBeTruthy()
    expect(screen.getByText(/Skipped — a real answer/)).toBeTruthy()
    // A step nobody answered isn't listed as an outcome.
    expect(screen.queryByText('Recap')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Reopen the session/ }))
    await waitFor(() => expect(sent('PATCH', '/session/s1')[0].body).toMatchObject({ status: 'active' }))
  })

  // "the web recap page shows just the checklist. On the iPhone recap page we had a
  // better experience where we showed the actual week decisions."
  //
  // The record used to be ten green ticks against ten step names — which says the session
  // finished and nothing whatever about the week it decided. It leads with the week now:
  // the same read-back step 10 shows, on the same payload, on both clients.
  it('leads with the week itself, not only a tick-list of steps', async () => {
    mockApi(baseView({
      session: session({ status: 'completed', completedAt: '2026-09-06T17:40:00.000Z' }),
      steps: [
        step('looseEnds', 1, 'Loose ends', 'Intake', { status: 'done' }),
        step('calendar', 2, 'Calendar', 'Frame the week', { status: 'skipped' }),
        step('recap', 3, 'Recap', 'Close'),
      ],
    }))
    draw()
    expect(await screen.findByText('The week is decided')).toBeTruthy()

    // The week strip, the module grouping and the receipt's numbers — the three things
    // the shell's own comment recorded as missing.
    expect(await screen.findByTestId('wpr-day-2026-09-06')).toBeTruthy()
    expect(screen.getByText('Lentil soup · Lottie')).toBeTruthy()
    expect(screen.getByTestId('wpr-group-calendar')).toBeTruthy()
    expect(screen.getByText('6 things on the week')).toBeTruthy()
    expect(screen.getByText('2 decisions')).toBeTruthy()
    expect(screen.getByTestId('wpr-alone-none:goals')).toBeTruthy()

    // …and the per-step list survives underneath, because it is the only record of what
    // was skipped ON PURPOSE. Both readings of the week, in the order that reads best.
    expect(screen.getByText(/Skipped — a real answer/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Reopen the session/ })).toBeTruthy()
  })

  // The week is SAVED here, so the copy cannot be written in the tense step 10 uses.
  it('reads the record in the past tense, not "what tonight changed"', async () => {
    mockApi(baseView({ session: session({ status: 'completed', completedAt: '2026-09-06T17:40:00.000Z' }) }))
    draw()
    expect(await screen.findByText('What the session changed')).toBeTruthy()
    expect(screen.queryByText('What tonight changed')).toBeNull()
  })

  // A row on the record cannot point at /planning/<step>: the shell strips the step from
  // the path the moment the session completes, so such a link would bounce straight back.
  // It points at the module the decisions actually live in — which is what the recap's
  // own footnote has always claimed ("already live in Calendar, Meals, Lists, …").
  it('sends a row to the module that owns it, not back into the finished session', async () => {
    mockApi(baseView({ session: session({ status: 'completed', completedAt: '2026-09-06T17:40:00.000Z' }) }))
    draw()
    const row = await screen.findByTestId('wpr-group-calendar')
    expect(row.getAttribute('href')).toBe('/calendar')
    fireEvent.click(row)
    await waitFor(() => expect(where()).toBe('/calendar'))
  })

  // A step with no module of its own gets a plain row: "a row that looks tappable and
  // isn't is worse than a plain one."
  it('leaves a row plain when there is no module to send it to', async () => {
    mockApi(baseView({
      session: session({ status: 'completed', completedAt: '2026-09-06T17:40:00.000Z' }),
      recap: { ...RECAP, groups: [{ key: 'connection', label: 'Connection', headline: 'One check-in', detail: 'Ada', count: 1, stepKey: 'connection' }] },
    }))
    draw()
    const row = await screen.findByTestId('wpr-group-connection')
    expect(row.getAttribute('href')).toBeNull()
  })
})

// The URL is the state. Leaving the module and coming back has to land you where you
// were — and so does a refresh, the back button, and a link someone pasted.
// A FAILED WRITE HAS TO SAY SO.
//
// `go()` was `try { await fn() } finally { setBusy(false); refetch() }` — no catch, and both
// call sites float the promise. So a `complete()` that failed rejected unhandled, nothing
// appeared on screen, and the refetch redrew the session as though the week had been saved
// while it was still active. iOS's `PlanningModel` sets an `errorMessage` for exactly this,
// so the asymmetry was a gap rather than a decision.
describe('weekly planning · a write that fails', () => {
  it('says so instead of redrawing as if it worked', async () => {
    mockApi(baseView({ session: session({ currentStep: 'recap' }), steps: STEPS }))
    // Let everything through except the save.
    const inner = globalThis.fetch as unknown as typeof fetch
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/complete')) throw new Error('offline')
      return (inner as (u: string, i?: RequestInit) => Promise<unknown>)(url, init)
    }) as unknown as typeof fetch

    drawAt('/planning/recap')
    fireEvent.click(await screen.findByRole('button', { name: /Looks right/ }))

    expect(await screen.findByRole('alert')).toBeTruthy()
    // And it must NOT claim the week is decided.
    expect(screen.queryByText('The week is decided')).toBeNull()
  })
})

describe('weekly planning · the URL', () => {
  it('rewrites bare /planning to the step the session resumed at', async () => {
    mockApi(baseView({ session: session({ currentStep: 'horizon' }) }))
    drawAt('/planning')
    await waitFor(() => expect(where()).toBe('/planning/horizon'))
  })

  it('opens the step named in the path, over the session pointer', async () => {
    // The session says 'calendar'; the link says 'recap'. The link wins — otherwise a
    // pasted URL or a back-button press silently snaps you elsewhere.
    mockApi(baseView({ session: session({ currentStep: 'calendar' }) }))
    drawAt('/planning/recap')
    expect(await screen.findByText('Recap')).toBeTruthy()
    expect(where()).toBe('/planning/recap')
  })

  it('falls back to the resume step when the path names a step that cannot run', async () => {
    mockApi(baseView({ session: session({ currentStep: 'calendar' }) }))
    drawAt('/planning/familyNight')
    // familyNight's module is off, so it is not a place you can be.
    expect(await screen.findByText('Calendar')).toBeTruthy()
    await waitFor(() => expect(where()).toBe('/planning/calendar'))
  })

  it('advances the path as the session advances', async () => {
    mockApi(baseView({ session: session({ currentStep: 'calendar' }) }))
    drawAt('/planning/calendar')
    fireEvent.click(await screen.findByRole('button', { name: /Looks right/ }))
    await waitFor(() => expect(where()).toBe('/planning/horizon'))
  })

  it('drops the step from the path when the session is saved', async () => {
    mockApi(baseView({ session: session({ currentStep: 'recap' }) }))
    drawAt('/planning/recap')
    fireEvent.click(await screen.findByRole('button', { name: /Looks right/ }))
    await waitFor(() => expect(sent('POST', '/session/s1/complete').length).toBe(1))
    await waitFor(() => expect(where()).toBe('/planning'))
  })
})

// Planning further ahead than the default week.
describe('weekly planning · choosing the week', () => {
  it('names the week and steps forward, carrying it in the query', async () => {
    mockApi(baseView())
    draw()
    expect(await screen.findByText('6 Sun – 12 Sat')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Plan the next week' }))
    await waitFor(() => expect(where()).toBe('/planning?week=2026-09-13'))
    // …and the view for that week is what gets fetched.
    await waitFor(() => expect(sent('GET', 'weekStart=2026-09-13').length).toBeGreaterThan(0))
  })

  it('will not step back past the household’s current week', async () => {
    // weekStart === minWeekStart ⇒ there is no earlier week left to plan.
    mockApi(baseView({ weekStart: '2026-08-30', defaultWeekStart: '2026-09-06' }))
    draw()
    const back = await screen.findByRole('button', { name: 'Plan the previous week' })
    expect(back.hasAttribute('disabled')).toBe(true)
  })

  it('starts the session on the week being shown, not the default', async () => {
    mockApi(baseView({ weekStart: '2026-09-20', defaultWeekStart: '2026-09-06' }))
    drawAt('/planning?week=2026-09-20')
    fireEvent.click(await screen.findByRole('button', { name: /Start the session/ }))
    await waitFor(() => expect(sent('POST', '/api/weekly-planning/session').length).toBe(1))
    expect(sent('POST', '/api/weekly-planning/session')[0].body).toMatchObject({ weekStart: '2026-09-20' })
  })

  it('keeps the everyday URL clean — stepping back to the default drops the query', async () => {
    mockApi(baseView({ weekStart: '2026-09-13', defaultWeekStart: '2026-09-06' }))
    drawAt('/planning?week=2026-09-13')
    fireEvent.click(await screen.findByRole('button', { name: 'Plan the previous week' }))
    await waitFor(() => expect(where()).toBe('/planning'))
  })
})

describe('weekly planning · nothing to run', () => {
  it('says so when every step reads a module that is off', async () => {
    mockApi(baseView({ steps: STEPS.map((s) => ({ ...s, available: false })) }))
    draw()
    expect(await screen.findByText(/Every step of the session reads a module that's turned off/)).toBeTruthy()
  })
})

describe('the parked-note handoff', () => {
  // "I added a bunch to the park it thing, expecting to go over them in the appropriate
  // step but I never saw them again, where did they go?"
  //
  // The SHELL renders this, not the ten steps: the banner is identical on all of them,
  // this component already refetches the session view after every write, and each step's
  // own affordances are what actually act on the note. One implementation, ten steps.
  const withNote = () =>
    STEPS.map((st) =>
      st.key === 'calendar'
        ? step('calendar', 2, 'Calendar', 'Frame the week', {
            parked: [{ id: 'pk1', note: 'book the campsite', byline: 'Kevin · 2 weeks ago' }],
          })
        : st
    )

  it('puts the note back in front of you on the step it was tagged for', async () => {
    mockApi(baseView({ steps: withNote(), session: session({ currentStep: 'calendar' }) }))
    draw()
    const banner = await screen.findByTestId('wp-handoff')
    expect(banner.textContent).toMatch(/book the campsite/)
    // Who parked it and when — what makes an old note answerable.
    expect(banner.textContent).toMatch(/Kevin · 2 weeks ago/)
  })

  it('is absent on a step nothing was tagged for', async () => {
    mockApi(baseView({ steps: withNote(), session: session({ currentStep: 'horizon' }) }))
    draw()
    // The title and the ask both say it, so wait on the chrome rather than the words.
    await waitFor(() => expect(screen.getByText(/3 of/)).toBeTruthy())
    expect(screen.queryByTestId('wp-handoff')).toBeNull()
  })

  it('answers through the resolve route step 1 and step 10 already use', async () => {
    mockApi(baseView({ steps: withNote(), session: session({ currentStep: 'calendar' }) }))
    draw()
    await screen.findByTestId('wp-handoff')
    fireEvent.click(screen.getByRole('button', { name: /handled/i }))

    await waitFor(() => {
      const post = calls.find((c) => c.url.includes('/loose-ends/resolve'))
      expect(post).toBeTruthy()
      expect(post!.body).toMatchObject({ kind: 'parked', id: 'pk1', action: 'done' })
    })
    // And it goes away without waiting for the refetch to come back.
    await waitFor(() => expect(screen.queryByTestId('wp-handoff-pk1')).toBeNull())
  })

  it('drops a note that was never really a thing', async () => {
    mockApi(baseView({ steps: withNote(), session: session({ currentStep: 'calendar' }) }))
    draw()
    await screen.findByTestId('wp-handoff')
    fireEvent.click(screen.getByRole('button', { name: /drop it/i }))

    await waitFor(() => {
      const post = calls.find((c) => c.url.includes('/loose-ends/resolve'))
      expect(post!.body).toMatchObject({ id: 'pk1', action: 'drop' })
    })
  })

  it('leaves a note alone when nobody answers it — that writes nothing', async () => {
    // The third answer, and the one parking exists for: walk past it and the note stays
    // open, turning up again in the recap's last call.
    mockApi(baseView({ steps: withNote(), session: session({ currentStep: 'calendar' }) }))
    draw()
    await screen.findByTestId('wp-handoff')
    expect(calls.some((c) => c.url.includes('/loose-ends/resolve'))).toBe(false)
  })

  // "I have no way to edit the item or change the category and I should." A note reaches
  // this box BECAUSE of its tag, so the box is the other place the mistake is visible —
  // and until this, the only repair was Drop, which is supposed to mean something else.
  it('fixes the words without dropping the note', async () => {
    mockApi(baseView({ steps: withNote(), session: session({ currentStep: 'calendar' }) }))
    draw()
    await screen.findByTestId('wp-handoff')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))

    fireEvent.change(await screen.findByLabelText('Edit this note'), {
      target: { value: 'book the campsite for Friday' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH' && c.url.includes('/loose-ends/parked/pk1'))
      expect(patch).toBeTruthy()
      expect(patch!.body).toMatchObject({ note: 'book the campsite for Friday', sessionId: 's1' })
    })
    // Nothing was resolved: an edit is not an answer.
    expect(calls.some((c) => c.url.includes('/loose-ends/resolve'))).toBe(false)
  })

  it('re-addresses the note to another step this household runs', async () => {
    mockApi(baseView({ steps: withNote(), session: session({ currentStep: 'calendar' }) }))
    draw()
    await screen.findByTestId('wp-handoff')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))

    const editor = await screen.findByTestId('wp-pne-pk1')
    // The step it is ON is the chip it opens on — that is why the box raised it.
    expect(within(editor).getByRole('button', { name: 'Calendar' })).toHaveAttribute('aria-pressed', 'true')
    // …and step 1 is never offered: the server refuses "the step it came from" as a circle.
    expect(within(editor).queryByRole('button', { name: 'Loose ends' })).toBeNull()
    // Nor is a step whose module the household turned off.
    expect(within(editor).queryByRole('button', { name: 'Family night' })).toBeNull()

    fireEvent.click(within(editor).getByRole('button', { name: 'Horizon scan' }))
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH' && c.url.includes('/loose-ends/parked/pk1'))
      expect(patch!.body).toMatchObject({ stepKey: 'horizon', sessionId: 's1' })
    })
  })
})
