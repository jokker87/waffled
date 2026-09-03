import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import mod from './FamilyNightStep'
import type { PlanningStep } from '../../../lib/api'
import type { StepBodyProps } from '../registry'

// Step 4 · Family night — "Accept the rotation, or change it?"
//
// Three rows and a theme line, and the fast path is reading them and moving on. So what
// this file guards is mostly that the step stays SMALL and that the three sentences the
// design calls requirements are true of the calls it actually makes:
//
//   · a pin goes to the OCCURRENCE (a date), never to the household config — so the
//     test watches for a config PUT that must never happen;
//   · every write is the familyNight module's own endpoint, because a second write path
//     would be a second place for "who's on the treat" to be true;
//   · calling the week off is a status on the occurrence and touches no event.
//
// The fetch double is stateful for the same reason the Tasks step's is: what the screen
// shows after a pin has to be the RE-READ, not component bookkeeping, or the step would
// look right in a test and disagree with the Today card in the house.

const { Body } = mod
// The footer control is this step's, so the tests render it beside the body exactly as
// the shell does — two sibling trees over one store.
const FooterExtra = mod.FooterExtra!

const step: PlanningStep = {
  key: 'familyNight',
  number: 4,
  title: 'Family night',
  ask: 'Accept the rotation, or change it?',
  primary: 'Accept',
  act: 'Claim the good',
  requiresModule: 'familyNight',
  available: true,
  status: 'pending',
  data: {},
  decidedAt: null,
}

const WEEK = '2026-09-06' // a Sunday
const DATE = '2026-09-09' // the Wednesday inside it

const MEMBERS = [
  { id: 'p1', name: 'Kevin', avatarEmoji: '🐻', colorHex: '#7A5AF8' },
  { id: 'p2', name: 'Kelly', avatarEmoji: '🦊', colorHex: '#E0653F' },
  { id: 'p3', name: 'Wally', avatarEmoji: '🐢', colorHex: '#25A368' },
  { id: 'p4', name: 'Lottie', avatarEmoji: '🦄', colorHex: '#C2410C' },
]

interface Part {
  partId: string; label: string; emoji: string; rotates: boolean
  personId: string | null; personName: string | null; pinned: boolean
}
interface Board {
  weekStart: string; date: string; dayOfWeek: number; time: string
  occurrenceId: string | null; theme: string | null; status: string; onCalendar: boolean
  members: typeof MEMBERS; parts: Part[]
}

const BOARD: Board = {
  weekStart: WEEK,
  date: DATE,
  dayOfWeek: 3,
  time: '17:00',
  occurrenceId: null,
  theme: null,
  status: 'planned',
  onCalendar: true,
  members: MEMBERS,
  parts: [
    { partId: 'activity', label: 'Activity', emoji: '🎲', rotates: true, personId: 'p3', personName: 'Wally', pinned: false },
    { partId: 'treat', label: 'Treat', emoji: '🍪', rotates: true, personId: 'p4', personName: 'Lottie', pinned: false },
    { partId: 'checkin', label: 'Check-in', emoji: '💬', rotates: true, personId: 'p2', personName: 'Kelly', pinned: false },
  ],
}

let calls: { url: string; method: string; body: Record<string, unknown> | null }[] = []

function mockApi(over: Partial<Board> = {}) {
  calls = []
  const state = { ...JSON.parse(JSON.stringify(BOARD)), ...JSON.parse(JSON.stringify(over)) } as Board
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url: u, method, body })

    if (u.includes('/api/weekly-planning/familyNight')) {
      return { ok: true, json: async () => JSON.parse(JSON.stringify(state)) }
    }
    // The module's own upsert — the ONLY write this step makes. Modelled the way the
    // server actually behaves: a partial assignment list writes only the parts named,
    // a null theme means "leave it alone" (only '' clears), and a status is a status.
    if (u.includes('/api/family-night/occurrence') && method === 'POST') {
      const b = (body ?? {}) as { date?: string; theme?: string | null; status?: string; assignments?: { partId: string; personId: string | null }[] }
      state.occurrenceId = state.occurrenceId ?? 'occ1'
      if (typeof b.theme === 'string') state.theme = b.theme || null
      if (b.status) state.status = b.status
      for (const a of b.assignments ?? []) {
        const part = state.parts.find((p) => p.partId === a.partId)
        if (!part) continue
        part.personId = a.personId
        part.personName = MEMBERS.find((m) => m.id === a.personId)?.name ?? null
        part.pinned = true
      }
      return { ok: true, json: async () => ({ id: state.occurrenceId }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
  return state
}

// The step's store is module-scoped (Body and FooterExtra are sibling trees), so it
// outlives a render. A fresh session id per test is what makes each one start clean —
// the same thing that makes stepping to another week reload the board in the app.
let seq = 0
const props = (over: Partial<StepBodyProps> = {}): StepBodyProps => ({
  step,
  sessionId: `s-${++seq}`,
  weekStart: WEEK,
  setDecisionData: vi.fn(),
  refresh: vi.fn(),
  busy: false,
  ...over,
})

const row = (label: string) => screen.getByTestId(`wpfn-row-${label}`)
const wrote = (match: string) => calls.filter((c) => c.method === 'POST' && c.url.includes(match))
const face = (label: string, name: string) => within(row(label)).getByRole('button', { name: new RegExp(name) })

describe('FamilyNightStep', () => {
  it('is three rows and a theme line: the night, and who the rotation suggests', async () => {
    mockApi()
    render(<Body {...props()} />)
    await waitFor(() => expect(screen.getByText(/Activity/)).toBeTruthy())

    // The header answers "when", from the household's own config — no second calendar.
    expect(screen.getByText(/every Wednesday/i)).toBeTruthy()
    expect(screen.getByText(/Wednesday, Sep 9/)).toBeTruthy()
    expect(screen.getByText(/5:00 PM/)).toBeTruthy()

    // Three rows, each naming its part and the person the rotation is offering.
    expect(within(row('Activity')).getByText(/suggested/i).textContent).toMatch(/Wally/)
    expect(within(row('Treat')).getByText(/suggested/i).textContent).toMatch(/Lottie/)
    expect(within(row('Check-in')).getByText(/suggested/i).textContent).toMatch(/Kelly/)

    // Reading it and moving on writes NOTHING. The affirmative is an acknowledgement.
    expect(wrote('/api/family-night')).toHaveLength(0)
  })

  it('says "nobody yet" for a part the rotation has no one for', async () => {
    mockApi({
      parts: [
        { partId: 'activity', label: 'Activity', emoji: '🎲', rotates: true, personId: 'p3', personName: 'Wally', pinned: false },
        { partId: 'treat', label: 'Treat', emoji: '🍪', rotates: true, personId: 'p4', personName: 'Lottie', pinned: false },
        // A fixed part (rotates: false) is never auto-filled — but it still takes a pin.
        { partId: 'checkin', label: 'Check-in', emoji: '💬', rotates: false, personId: null, personName: null, pinned: false },
      ],
    })
    render(<Body {...props()} />)
    await waitFor(() => expect(screen.getByText(/Check-in/)).toBeTruthy())
    expect(within(row('Check-in')).getByText(/nobody yet/i)).toBeTruthy()
    expect(within(row('Check-in')).getByRole('button', { name: /Wally/ })).toBeTruthy()
  })

  it('pins a face for this week — on the occurrence, never on the household config', async () => {
    mockApi()
    render(<Body {...props()} />)
    await waitFor(() => expect(screen.getByText(/Activity/)).toBeTruthy())

    fireEvent.click(face('Activity', 'Lottie'))
    await waitFor(() => expect(within(row('Activity')).getByText(/pinned for this week/i)).toBeTruthy())
    expect(within(row('Activity')).getByText(/pinned for this week/i).textContent).toMatch(/Lottie/)

    // ONE write, and it is the familyNight module's own occurrence endpoint, keyed by
    // the DATE — which is the whole of "pinned for this week only".
    const posts = wrote('/api/family-night/occurrence')
    expect(posts).toHaveLength(1)
    expect(posts[0].body).toEqual({ date: DATE, assignments: [{ partId: 'activity', personId: 'p4' }] })

    // The config is the household's standing agenda. A pin must never reach it.
    expect(calls.some((c) => c.url.includes('/api/family-night/config'))).toBe(false)
    expect(calls.every((c) => c.method !== 'PUT')).toBe(true)

    // The other two rows stay on rotation — pinning one part decides one part.
    expect(within(row('Treat')).getByText(/suggested/i)).toBeTruthy()
    expect(within(row('Check-in')).getByText(/suggested/i)).toBeTruthy()
  })

  it('re-reads the board after a pin rather than trusting its own bookkeeping', async () => {
    mockApi()
    const refresh = vi.fn()
    render(<Body {...props({ refresh })} />)
    await waitFor(() => expect(screen.getByText(/Activity/)).toBeTruthy())
    const readsBefore = calls.filter((c) => c.url.includes('/api/weekly-planning/familyNight')).length

    fireEvent.click(face('Treat', 'Kevin'))
    await waitFor(() => expect(within(row('Treat')).getByText(/pinned/i)).toBeTruthy())
    expect(calls.filter((c) => c.url.includes('/api/weekly-planning/familyNight')).length).toBeGreaterThan(readsBefore)
    // …and the session view, so the agenda sheet agrees with what just happened.
    expect(refresh).toHaveBeenCalled()
  })

  it('keeps a free-text theme on the night, and can take it back off', async () => {
    mockApi()
    render(<Body {...props()} />)
    const theme = await screen.findByLabelText(/theme/i)
    expect((theme as HTMLInputElement).placeholder).toMatch(/pizza and the new Lego set/i)

    fireEvent.change(theme, { target: { value: 'Pizza and the new Lego set' } })
    fireEvent.blur(theme)
    await waitFor(() => expect(wrote('/api/family-night/occurrence')).toHaveLength(1))
    expect(wrote('/api/family-night/occurrence')[0].body).toEqual({ date: DATE, theme: 'Pizza and the new Lego set' })

    // Clearing sends '' rather than null: the server reads a null theme as "leave it
    // alone", so null would silently keep the old one.
    fireEvent.change(theme, { target: { value: '' } })
    fireEvent.blur(theme)
    await waitFor(() => expect(wrote('/api/family-night/occurrence')).toHaveLength(2))
    expect(wrote('/api/family-night/occurrence')[1].body).toEqual({ date: DATE, theme: '' })
  })

  it('does not re-save a theme nobody changed', async () => {
    mockApi({ theme: 'Pizza and the new Lego set' })
    render(<Body {...props()} />)
    const theme = await screen.findByLabelText(/theme/i)
    fireEvent.focus(theme)
    fireEvent.blur(theme)
    expect(wrote('/api/family-night/occurrence')).toHaveLength(0)
  })

  it('calls the week off from the footer: a status on the night, and nothing else', async () => {
    mockApi()
    const p = props()
    render(<><Body {...p} /><FooterExtra {...p} /></>)
    await waitFor(() => expect(screen.getByText(/Activity/)).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /Skip this week/i }))
    await waitFor(() => expect(screen.getByText(/Skipped this week/i)).toBeTruthy())

    expect(wrote('/api/family-night/occurrence')[0].body).toEqual({ date: DATE, status: 'skipped' })
    // (3) The recurring calendar event is left alone — no event call of any kind.
    expect(calls.some((c) => c.url.includes('/api/events'))).toBe(false)
    // And the module's schedule endpoints, which are what would unpick it.
    expect(calls.some((c) => c.url.includes('/api/family-night/schedule'))).toBe(false)

    // Undo lives on the skip bar, not in the footer — the footer's extra is gone.
    expect(screen.queryByRole('button', { name: /Skip this week/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Undo/i }))
    await waitFor(() => expect(screen.queryByText(/Skipped this week/i)).toBeNull())
    expect(wrote('/api/family-night/occurrence')[1].body).toEqual({ date: DATE, status: 'planned' })
  })

  it('only promises the calendar event is untouched when there IS one', async () => {
    mockApi({ status: 'skipped', occurrenceId: 'occ1', onCalendar: false })
    render(<Body {...props()} />)
    await waitFor(() => expect(screen.getByText(/Skipped this week/i)).toBeTruthy())
    expect(screen.queryByText(/calendar event/i)).toBeNull()
  })

  it('hands the session a crumb of what it decided, not a copy of the module', async () => {
    mockApi()
    const setDecisionData = vi.fn()
    render(<Body {...props({ setDecisionData })} />)
    await waitFor(() => expect(screen.getByText(/Activity/)).toBeTruthy())
    expect(setDecisionData).toHaveBeenCalledWith({ pinned: [], skipped: false })

    fireEvent.click(face('Activity', 'Lottie'))
    await waitFor(() => expect(setDecisionData).toHaveBeenCalledWith({ pinned: ['activity'], skipped: false }))
  })

  it('freezes its own controls while the shell has a write in flight', async () => {
    mockApi()
    const p = props({ busy: true })
    render(<><Body {...p} /><FooterExtra {...p} /></>)
    await waitFor(() => expect(screen.getByText(/Activity/)).toBeTruthy())
    expect((face('Activity', 'Lottie') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: /Skip this week/i }) as HTMLButtonElement).disabled).toBe(true)
  })
})
