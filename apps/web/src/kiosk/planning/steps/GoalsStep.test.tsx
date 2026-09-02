import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router'
import mod from './GoalsStep'
import type { StepBodyProps } from '../registry'

// Step 6 · Goals — "What's each group's focus this week?"
//
// The tabs ARE the goal lists (a private one wears its lock), only one group is on
// screen at a time, and picking a goal sets the goals module's existing `is_featured`
// flag. Picking NOTHING is a real answer: it settles the group and puts the ★ on its
// tab just the same. The fetch double is stateful so what's asserted is the step's
// reaction to the server's fresh answer, not to an optimistic guess.

const goal = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'g1',
  goalListId: 'l-family',
  title: 'Water the garden',
  emoji: '🪴',
  category: 'physical',
  goalType: 'habit',
  unit: null,
  habitPeriod: 'week',
  habitTargetPerPeriod: 5,
  trackingMode: 'each_tracks',
  participantMode: 'count_once',
  targetBasis: 'family',
  logMethod: 'quick_log',
  autoFromCalendar: false,
  deadline: null,
  isFeatured: false,
  isSpotlight: false,
  hasRewards: false,
  target: null,
  // A habit is shown on THIS period's count — the lifetime 99 must never be what the
  // card says, which is exactly what the shared display helper is for.
  totalProgress: 99,
  milestoneTotal: 0,
  milestoneReached: 0,
  periodDone: 3,
  stepTotal: 0,
  stepDone: 0,
  streakDays: 0,
  loggedTodayBy: [],
  participants: [],
  // `kind · pace` — the pace half is the server's sentence and its tone; the client
  // renders it, it never composes one.
  pace: { text: '2 of 5 last week', tone: 'behind' },
  ...over,
})

const member = (id: string, name: string, age: number | null = null) =>
  ({ personId: id, name, avatarEmoji: '🙂', colorHex: '#25A368', age })

const group = (over: Partial<Record<string, unknown>> = {}) => ({
  listId: 'l-family',
  name: 'Family',
  emoji: '🏡',
  colorHex: null,
  isPrivate: false,
  sortOrder: 0,
  members: [member('p1', 'Kevin'), member('p2', 'Kelly')],
  isEveryone: true,
  goals: [goal()],
  settled: false,
  focusGoalId: null as string | null,
  ...over,
})

const VIEW = () => ({
  groups: [
    group(),
    group({
      listId: 'l-couple',
      name: 'Mom & Dad',
      emoji: '💛',
      isPrivate: true,
      sortOrder: 1,
      isEveryone: false,
      goals: [goal({ id: 'g-date', goalListId: 'l-couple', title: 'Date night', goalType: 'count', unit: 'nights', target: 12, totalProgress: 4, periodDone: 0, pace: { text: '8 hours last week', tone: 'ok' } })],
    }),
    group({
      listId: 'l-lottie',
      name: 'Lottie',
      emoji: '🦊',
      sortOrder: 2,
      isEveryone: false,
      members: [member('p3', 'Lottie', 9)],
      goals: [goal({ id: 'g-book', goalListId: 'l-lottie', title: 'Finish the dragon book', goalType: 'checklist', stepTotal: 4, stepDone: 1, periodDone: 0, totalProgress: 40, pace: null })],
    }),
  ],
})

const calls: { url: string; method: string; body: Record<string, unknown> | null }[] = []

function mockApi(view = VIEW()) {
  calls.length = 0
  const state = JSON.parse(JSON.stringify(view)) as ReturnType<typeof VIEW>
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url: u, method, body })
    if (u.includes('/api/household')) {
      return { ok: true, json: async () => ({ household: { id: 'h1', name: 'Sites' }, person: { id: 'p1', name: 'Kevin', capabilities: ['goal.manage'] }, memberships: [], pendingInvites: [] }) }
    }
    if (u.includes('/api/weekly-planning/goals/focus')) {
      // The server really answers the group: it settles, and the flag moves.
      const g = state.groups.find((x) => x.listId === body.listId)!
      g.settled = true
      g.focusGoalId = body.goalId ?? null
      for (const x of g.goals) x.isFeatured = x.id === body.goalId
      return { ok: true, json: async () => JSON.parse(JSON.stringify(state)) }
    }
    return { ok: true, json: async () => JSON.parse(JSON.stringify(state)) }
  }) as unknown as typeof fetch
}

const step = {
  key: 'goals', number: 6, title: 'Goals', ask: 'What’s each group’s focus this week?',
  primary: 'Done', act: 'Claim the good', requiresModule: 'goals',
  available: true, status: 'pending' as const, data: {}, decidedAt: null,
}

function Loc() {
  const l = useLocation()
  return <div data-testid="loc">{l.pathname + l.search}</div>
}

function renderStep(over: Partial<StepBodyProps> = {}) {
  const setDecisionData = vi.fn()
  const props: StepBodyProps = {
    step, sessionId: 's1', weekStart: '2026-09-06',
    setDecisionData, refresh: vi.fn(), busy: false, ...over,
  }
  render(
    <MemoryRouter initialEntries={['/planning/goals']}>
      <Routes>
        <Route path="/planning/goals" element={<><mod.Body {...props} /><Loc /></>} />
        <Route path="/goals/new" element={<Loc />} />
      </Routes>
    </MemoryRouter>
  )
  return { setDecisionData }
}

const tab = (name: string) => screen.getByRole('tab', { name: new RegExp(name) })

beforeEach(() => mockApi())

describe('GoalsStep · the tabs are the goal lists', () => {
  it('shows one tab per group and only the selected group’s goals', async () => {
    renderStep()
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(3))
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('Family'), expect.stringContaining('Mom & Dad'), expect.stringContaining('Lottie')])
    )
    // One group on screen at a time — that's the whole point of borrowing the picker.
    expect(screen.getByText('Water the garden')).toBeInTheDocument()
    expect(screen.queryByText('Date night')).not.toBeInTheDocument()

    fireEvent.click(tab('Mom & Dad'))
    expect(await screen.findByText('Date night')).toBeInTheDocument()
    expect(screen.queryByText('Water the garden')).not.toBeInTheDocument()
  })

  it('marks the private list’s tab with a lock', async () => {
    renderStep()
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(3))
    expect(tab('Mom & Dad')).toHaveAttribute('data-private', 'true')
    expect(tab('Family')).not.toHaveAttribute('data-private', 'true')
  })
})

describe('GoalsStep · the group card says what the group is', () => {
  it('heads the card with the group’s name, what it is, and who’s in it', async () => {
    renderStep()
    const card = await screen.findByRole('tabpanel')
    // "shared · everyone tracks it" — from the server's isEveryone, not a headcount
    // the client guessed at.
    expect(within(card).getByText('shared · everyone tracks it')).toBeInTheDocument()
    // One avatar per member, using the app's own .avstack/.av design-system classes.
    expect(card.querySelectorAll('.avstack .av')).toHaveLength(2)
  })

  it('describes a private couple’s list and an individual’s differently', async () => {
    renderStep()
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(3))
    fireEvent.click(tab('Mom & Dad'))
    expect(await screen.findByText('private · just the two of you')).toBeInTheDocument()
    fireEvent.click(tab('Lottie'))
    // The age comes from the member's own birthday; with none on file it's omitted.
    expect(await screen.findByText('individual · age 9')).toBeInTheDocument()
  })

  it('says where the group stands under the options', async () => {
    renderStep()
    expect(await screen.findByText(/No focus this week/)).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('radio', { name: /Water the garden/ }))
    expect(await screen.findByText(/This week · Water the garden/)).toBeInTheDocument()
  })

  // Coming back from "＋ New goal for this week": the editor created the goal already
  // featured, so the server reports it as the group's focus while `settled` stays
  // false. It must read as "already pinned, confirm it" — not as a decision the
  // session made on the family's behalf.
  it('shows an already-featured goal as the focus, but does not claim the group settled', async () => {
    const view = VIEW()
    view.groups[0].focusGoalId = 'g1'
    view.groups[0].goals[0].isFeatured = true
    mockApi(view)
    renderStep()
    expect(await screen.findByRole('radio', { name: /Water the garden/ })).toBeChecked()
    expect(screen.getByText(/Pinned already · Water the garden/)).toBeInTheDocument()
    // No ★ on the tab: the session hasn't answered for this group yet.
    expect(tab('Family')).not.toHaveAttribute('data-settled', 'true')
  })
})

describe('GoalsStep · the pace line', () => {
  it('renders the server’s sentence with its tone, and composes none of its own', async () => {
    renderStep()
    const card = await screen.findByRole('radio', { name: /Water the garden/ })
    // "kind · pace" — Habit, then how it's actually going.
    const pace = within(card).getByText('2 of 5 last week')
    expect(pace).toHaveAttribute('data-tone', 'behind')
    expect(within(card).getByText(/^Habit/)).toBeInTheDocument()
  })

  it('carries the ok tone through untouched', async () => {
    renderStep()
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(3))
    fireEvent.click(tab('Mom & Dad'))
    const card = await screen.findByRole('radio', { name: /Date night/ })
    expect(within(card).getByText('8 hours last week')).toHaveAttribute('data-tone', 'ok')
  })

  it('says nothing when the server has nothing honest to say', async () => {
    renderStep()
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(3))
    fireEvent.click(tab('Lottie'))
    const card = await screen.findByRole('radio', { name: /dragon book/ })
    expect(within(card).getByText('Checklist')).toBeInTheDocument()
    expect(card.querySelector('.wpg-pace')).toBe(null)
  })
})

describe('GoalsStep · progress is shown on the goal’s own axis', () => {
  it('reads a habit as this period’s count, not the lifetime total', async () => {
    renderStep()
    const card = await screen.findByRole('radio', { name: /Water the garden/ })
    expect(within(card).getByText('3')).toBeInTheDocument()
    expect(within(card).getByText('/ 5')).toBeInTheDocument()
    expect(within(card).queryByText('99')).not.toBeInTheDocument()
  })

  it('reads a checklist as its steps', async () => {
    renderStep()
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(3))
    fireEvent.click(tab('Lottie'))
    const card = await screen.findByRole('radio', { name: /dragon book/ })
    expect(within(card).getByText('1')).toBeInTheDocument()
    expect(within(card).getByText('/ 4')).toBeInTheDocument()
  })
})

describe('GoalsStep · picking the week’s focus', () => {
  it('sets the goal’s existing is_featured flag and stars the tab', async () => {
    renderStep()
    fireEvent.click(await screen.findByRole('radio', { name: /Water the garden/ }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true))
    const put = calls.find((c) => c.method === 'PUT')!
    expect(put.url).toContain('/api/weekly-planning/goals/focus')
    expect(put.body).toEqual({ sessionId: 's1', listId: 'l-family', goalId: 'g1' })
    await waitFor(() => expect(tab('Family')).toHaveAttribute('data-settled', 'true'))
    expect(await screen.findByRole('radio', { name: /Water the garden/ })).toBeChecked()
  })

  it('takes "nothing this week" as a real answer — a null pick that still settles', async () => {
    renderStep()
    fireEvent.click(await screen.findByRole('radio', { name: /Nothing this week/ }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true))
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ sessionId: 's1', listId: 'l-family', goalId: null })
    await waitFor(() => expect(tab('Family')).toHaveAttribute('data-settled', 'true'))
    expect(await screen.findByRole('radio', { name: /Nothing this week/ })).toBeChecked()
  })

  it('hands the session record what each group settled on', async () => {
    const { setDecisionData } = renderStep()
    fireEvent.click(await screen.findByRole('radio', { name: /Water the garden/ }))
    await waitFor(() =>
      expect(setDecisionData).toHaveBeenCalledWith({ focus: { 'l-family': 'g1' } })
    )
  })
})

describe('GoalsStep · when the honest answer does not exist yet', () => {
  it('opens the app’s own goal editor with the group preselected and the goal pre-pinned', async () => {
    renderStep()
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(3))
    fireEvent.click(tab('Lottie'))
    fireEvent.click(await screen.findByRole('button', { name: /New goal for this week/ }))
    // `featured=1` is why the new goal comes back as the week's focus instead of
    // needing a second trip through the picker.
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/goals/new?list=l-lottie&featured=1'))
  })
})
