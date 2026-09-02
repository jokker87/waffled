import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import mod from './TasksStep'
import type { PlanningStep } from '../../../lib/api'
import type { StepBodyProps } from '../registry'

// Step 8 · Tasks — "Who's doing what?"
//
// The board is the kiosk Chores layout: everything nobody has taken sits in a strip
// across the top with the member faces under it, and each column shows what that person
// is CARRYING for the week — from the server read, not from what this sitting happened
// to move. What's asserted here is that difference (a hand-out shows up because the
// board was re-read), the two answers the step records (handed over / deliberately left),
// and that "+ Add for …" opens the app's EXISTING chore modal with Who already filled
// in — a second chore form would be the bug.

const { Body } = mod

const step: PlanningStep = {
  key: 'tasks',
  number: 8,
  title: 'Tasks',
  ask: 'Who’s doing what?',
  primary: 'Handed out',
  act: 'Run the household',
  requiresModule: 'chores',
  available: true,
  status: 'pending',
  data: {},
  decidedAt: null,
}

const WEEK = '2026-09-06' // a Sunday; 09-09 is Wed, 09-12 is Sat
interface Card {
  id: string; title: string; emoji: string | null; rrule: string | null; cadence: string
  days: string[]; dueOn: string | null; dueTime: string | null; carriedOver: boolean
  rewardAmount: number; rewardCurrency: string; pendingInstanceIds: string[]
}
const chore = (over: Partial<Card> & { id: string; title: string }): Card => ({
  emoji: null, rrule: null, cadence: 'once', days: [], dueOn: null, dueTime: null,
  carriedOver: false, rewardAmount: 0, rewardCurrency: 'stars', pendingInstanceIds: [],
  ...over,
})

// Shaped like the real /api/weekly-planning/tasks payload, day chips included.
const BOARD = {
  weekStart: WEEK,
  people: [
    {
      id: 'p1', name: 'Kevin', avatarEmoji: '🧔', colorHex: '#7A5AF8', memberType: 'adult', isAdmin: true,
      recurringChores: 4,
      chores: [chore({ id: 'k1', title: 'Dishes', cadence: 'daily', rrule: 'FREQ=DAILY', days: ['2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12'] })],
    },
    {
      id: 'p2', name: 'Wally', avatarEmoji: '🐢', colorHex: '#25A368', memberType: 'kid', isAdmin: false,
      recurringChores: 1,
      chores: [chore({ id: 'w1', title: 'Vacuum upstairs', cadence: 'weekly', rrule: 'FREQ=WEEKLY;BYDAY=WE', days: ['2026-09-09'], dueTime: '18:00' })],
    },
    {
      id: 'p3', name: 'Lottie', avatarEmoji: '🦊', colorHex: '#E0653F', memberType: 'kid', isAdmin: false,
      recurringChores: 0,
      chores: [chore({ id: 'l1', title: 'Renew the passport', carriedOver: true })],
    },
  ],
  unassigned: [
    chore({ id: 'c1', title: 'Sweep the porch', emoji: '🧹', cadence: 'weekly', rrule: 'FREQ=WEEKLY;BYDAY=SU', days: [WEEK], rewardAmount: 2, pendingInstanceIds: ['i1', 'i2'] }),
    chore({ id: 'c2', title: 'Fold the towels', emoji: '🧺', rewardAmount: 1 }),
  ],
}

let calls: { url: string; method: string; body: Record<string, unknown> | null }[] = []

// A STATEFUL double: a PATCH really moves the chore out of the strip and into that
// person's column, so what the screen shows after a hand-out is the re-read — which is
// the whole point of the columns being server-owned. A double that replayed one fixture
// couldn't tell that apart from component bookkeeping.
function mockApi(opts: { capabilities?: string[]; unassigned?: unknown[] } = {}) {
  calls = []
  const state = JSON.parse(JSON.stringify(BOARD)) as typeof BOARD
  if (opts.unassigned) state.unassigned = opts.unassigned as typeof BOARD.unassigned
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url: u, method, body })

    if (u.includes('/api/weekly-planning/tasks')) return { ok: true, json: async () => JSON.parse(JSON.stringify(state)) }
    if (u.includes('/api/household')) {
      return {
        ok: true,
        json: async () => ({
          provisioned: true,
          household: { id: 'h1', name: 'Sites' },
          person: { id: 'p1', name: 'Kevin', capabilities: opts.capabilities ?? ['chore.manage'] },
        }),
      }
    }
    if (u.includes('/api/persons')) return { ok: true, json: async () => ({ persons: state.people }) }
    if (u.includes('/api/currencies')) {
      return { ok: true, json: async () => ({ currencies: [{ key: 'stars', label: 'Stars', symbol: '⭐', isDefault: true }] }) }
    }
    if (u.endsWith('/api/chores') && method === 'POST') return { ok: true, json: async () => ({ chore: { id: 'new' } }) }
    if (/\/api\/chores\/[^/]+$/.test(u) && method === 'PATCH') {
      const id = u.split('/').pop()!
      const i = state.unassigned.findIndex((c) => c.id === id)
      const target = state.people.find((p) => p.id === (body as { personId: string }).personId)
      if (i >= 0 && target) target.chores.push(...state.unassigned.splice(i, 1))
      return { ok: true, json: async () => ({ chore: { id } }) }
    }
    if (u.includes('/assign')) return { ok: true, json: async () => ({ instance: { id: 'i1', status: 'pending' } }) }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

const props = (over: Partial<StepBodyProps> = {}): StepBodyProps => ({
  step,
  sessionId: 's1',
  weekStart: WEEK,
  setDecisionData: vi.fn(),
  refresh: vi.fn(),
  busy: false,
  ...over,
})

const column = (name: string) => screen.getByTestId(`wpt-col-${name}`)
const strip = () => screen.getByTestId('wpt-strip')
const wrote = (method: string, match: string) => calls.filter((c) => c.method === method && c.url.includes(match))

describe('TasksStep', () => {
  it('lays the week out by person: what they carry, when it lands, what they already hold', async () => {
    mockApi()
    render(<Body {...props()} />)
    await waitFor(() => expect(screen.getByText(/Sweep the porch/)).toBeTruthy())

    // A column per household member, in the order the kiosk board uses.
    for (const name of ['Kevin', 'Wally', 'Lottie']) expect(column(name)).toBeTruthy()

    // The header counts what that person is holding for the week…
    expect(within(column('Kevin')).getByText('1 this week')).toBeTruthy()
    // …the card names where it came from and when it lands…
    const wally = column('Wally')
    expect(within(wally).getByText(/Vacuum upstairs/)).toBeTruthy()
    expect(within(wally).getByText('Recurring chore')).toBeTruthy()
    expect(within(wally).getByText('Wed 6pm')).toBeTruthy()
    expect(within(column('Kevin')).getByText('Every day')).toBeTruthy()
    expect(within(column('Lottie')).getByText('Carried over')).toBeTruthy()
    expect(within(column('Lottie')).getByText('Left over from before this week')).toBeTruthy()
    expect(within(strip()).getByText('Sun')).toBeTruthy()
    // …and a chore with no day says so plainly rather than inventing one.
    expect(within(strip()).getByText('No day set')).toBeTruthy()

    // Fairness is visible without anyone computing it.
    expect(within(column('Kevin')).getByText(/4 recurring chores/)).toBeTruthy()
    expect(within(column('Wally')).getByText(/1 recurring chore\b/)).toBeTruthy()
    expect(within(column('Lottie')).getByText(/No recurring chores/)).toBeTruthy()
  })

  it('tapping a face hands the chore over — and the column shows it because it re-read', async () => {
    mockApi()
    render(<Body {...props()} />)
    await waitFor(() => expect(screen.getByText(/Sweep the porch/)).toBeTruthy())
    const reads = wrote('GET', '/api/weekly-planning/tasks').length

    fireEvent.click(screen.getByRole('button', { name: 'Give Sweep the porch to Wally' }))

    // The definition covers every future occurrence…
    await waitFor(() => expect(wrote('PATCH', '/api/chores/c1')).toHaveLength(1))
    expect(wrote('PATCH', '/api/chores/c1')[0].body).toEqual({ personId: 'p2' })
    // …and EVERY day already sitting unclaimed on a board gets moved with it, not just
    // the first — otherwise the kiosk Chores screen keeps showing those up for grabs.
    expect(wrote('POST', '/api/chore-instances/i1/assign')[0].body).toEqual({ personId: 'p2' })
    await waitFor(() => expect(wrote('POST', '/api/chore-instances/i2/assign')).toHaveLength(1))
    expect(wrote('POST', '/api/chore-instances/i2/assign')[0].body).toEqual({ personId: 'p2' })

    // The board was re-read, and Wally's column now holds it: server-owned, so this
    // survives a refresh instead of living in component state.
    await waitFor(() => expect(wrote('GET', '/api/weekly-planning/tasks').length).toBeGreaterThan(reads))
    await waitFor(() => expect(within(column('Wally')).getByText(/Sweep the porch/)).toBeTruthy())
    expect(within(strip()).queryByText(/Sweep the porch/)).toBeNull()
    // Its header count grew with it.
    expect(within(column('Wally')).getByText('2 this week')).toBeTruthy()
  })

  it('a chore left alone stays up for grabs — a real answer, not an error', async () => {
    mockApi()
    const setDecisionData = vi.fn()
    render(<Body {...props({ setDecisionData })} />)
    await waitFor(() => expect(screen.getByText(/Sweep the porch/)).toBeTruthy())

    // The discriminating case is a MIXED sitting: one chore is handed over and the
    // other is deliberately left. "Nobody" has to survive the same pass that assigns.
    fireEvent.click(screen.getByRole('button', { name: 'Give Sweep the porch to Lottie' }))
    await waitFor(() => expect(within(column('Lottie')).getByText(/Sweep the porch/)).toBeTruthy())

    // The one nobody took is untouched and still on offer — no write, no flag.
    expect(wrote('PATCH', '/api/chores/c2')).toHaveLength(0)
    expect(within(strip()).getByText(/Fold the towels/)).toBeTruthy()
    expect(strip().textContent).toMatch(/up for grabs/i)
    // …and the session records it as a decision, not as a gap. Counts only: the recap
    // reads through to chores, so a copy of the rows here could only disagree.
    await waitFor(() => expect(setDecisionData).toHaveBeenLastCalledWith({ assigned: 1, leftUpForGrabs: 1 }))
  })

  it('an empty strip says everything’s handed out, and still offers the tile', async () => {
    mockApi({ unassigned: [] })
    render(<Body {...props()} />)
    await waitFor(() => expect(screen.getByText(/Everything’s handed out/)).toBeTruthy())
    expect(within(strip()).getByRole('button', { name: /Add a task/ })).toBeTruthy()
  })

  it('“+ Add for …” opens the app’s existing chore modal with Who prefilled', async () => {
    mockApi()
    render(<Body {...props()} />)
    await waitFor(() => expect(screen.getByText(/Sweep the porch/)).toBeTruthy())

    fireEvent.click(within(column('Wally')).getByRole('button', { name: /Add for Wally/ }))
    // ChoreModal, not a second chore form of our own: its own title, its own fields,
    // and its Who select pre-set to the column we added from.
    await waitFor(() => expect(screen.getByText('New chore')).toBeTruthy())
    expect(screen.getByPlaceholderText('Feed the dog')).toBeTruthy()
    await waitFor(() => expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('p2'))
  })

  it('the strip’s own “Add a task” opens the same modal with nobody prefilled', async () => {
    mockApi()
    render(<Body {...props()} />)
    await waitFor(() => expect(screen.getByText(/Sweep the porch/)).toBeTruthy())

    fireEvent.click(within(strip()).getByRole('button', { name: /Add a task/ }))
    await waitFor(() => expect(screen.getByText('New chore')).toBeTruthy())
    // '' is ChoreModal's own "— up for grabs —" option: a task nobody owns yet.
    await waitFor(() => expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe(''))
  })

  it('without chore.manage there is nothing to tap — assigning is not this viewer’s call', async () => {
    mockApi({ capabilities: [] })
    render(<Body {...props()} />)
    await waitFor(() => expect(screen.getByText(/Sweep the porch/)).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Give Sweep the porch to Wally' })).toBeNull()
  })
})
