import { render, screen, fireEvent, waitFor } from '@testing-library/react'
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
    if (method === 'PATCH' && u.includes('/session/')) {
      const patch = init?.body ? JSON.parse(String(init.body)) : {}
      state.session = { ...(state.session as object), ...patch, ...(patch.status === 'active' ? { completedAt: null } : {}) }
    }
    return { ok: true, json: async () => ({ ok: true, session: state.session, steps: state.steps }) }
  }) as unknown as typeof fetch
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
    fireEvent.click(screen.getByRole('button', { name: /Leave for now/ }))
    await waitFor(() => expect(where()).toBe('/'))
    // Leaving is not deleting.
    expect(sent('DELETE', '/session/s1').length).toBe(0)
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
})

// The URL is the state. Leaving the module and coming back has to land you where you
// were — and so does a refresh, the back button, and a link someone pasted.
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
})
