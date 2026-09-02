import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
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
  extra: Partial<{ available: boolean; status: string; requiresModule: string }> = {}
) => ({
  key, number, title, act,
  ask: `${title}?`,
  primary: 'Looks right',
  available: true,
  status: 'pending',
  data: {},
  decidedAt: null,
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

function mockApi(view: Record<string, unknown>) {
  calls.length = 0
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    calls.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : null })
    if (u.includes('/api/weekly-planning') && method === 'GET') return { ok: true, json: async () => view }
    return { ok: true, json: async () => ({ ok: true, session: view.session, steps: view.steps }) }
  }) as unknown as typeof fetch
}

const baseView = (over: Record<string, unknown> = {}) => ({
  config: { dayOfWeek: 0, time: '17:00', steps: {}, showOnToday: true },
  weekStart: '2026-09-06',
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

const draw = () => render(<MemoryRouter><WeeklyPlanning /></MemoryRouter>)
const sent = (m: string, frag: string) => calls.filter((c) => c.method === m && c.url.includes(frag))

describe('weekly planning · the lobby', () => {
  it('names the session by its configured day and offers to start it', async () => {
    mockApi(baseView())
    draw()
    expect(await screen.findByText(/Sunday's session/)).toBeTruthy()
    // The unavailable step is not counted — a household with family night off is
    // running four steps, not five.
    expect(screen.getByText(/4 steps for/)).toBeTruthy()
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

describe('weekly planning · nothing to run', () => {
  it('says so when every step reads a module that is off', async () => {
    mockApi(baseView({ steps: STEPS.map((s) => ({ ...s, available: false })) }))
    draw()
    expect(await screen.findByText(/Every step of the session reads a module that's turned off/)).toBeTruthy()
  })
})
