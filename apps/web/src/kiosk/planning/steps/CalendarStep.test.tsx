import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import mod from './CalendarStep'
import type { PlanningStep } from '../../../lib/api'
import type { StepBodyProps } from '../registry'

// Step 2 · Calendar. The week is the whole screen and it is the REAL calendar — seven
// day columns of actual events, coloured by owner, with one action: adding what isn't
// on there yet, in place on the day you tapped.
//
// `weekStart` is pinned to a fixed Sunday rather than derived from today, because the
// whole risk in this step is date handling: `new Date('2026-09-06')` is UTC midnight
// and renders as the 5th west of Greenwich. A test that agreed with today's date would
// never catch a column shifted by one.

const WEEK_START = '2026-09-06' // a Sunday; the week runs Sun 6 -> Sat 12

const Body = mod.Body

const step: PlanningStep = {
  key: 'calendar',
  number: 2,
  title: 'Calendar',
  ask: 'Here’s your week. Anything missing?',
  primary: 'Looks right',
  act: 'Frame the week',
  available: true,
  status: 'pending',
  data: {},
  decidedAt: null,
}

const PERSONS = [
  { id: 'p1', name: 'Kevin', memberType: 'adult', isAdmin: true, avatarEmoji: '🐻', colorHex: '#2F7FED' },
  { id: 'p2', name: 'Nora', memberType: 'adult', isAdmin: false, avatarEmoji: '🦊', colorHex: '#25A368' },
]

// A timed event on `day` at local `time` — built by LOCAL parse so the fixture lands on
// the day it says it does whatever zone the test machine is in.
const at = (day: string, time: string) => new Date(`${day}T${time}`).toISOString()

const ev = (over: Record<string, unknown>) => ({
  id: 'e0',
  title: 'Something',
  startsAt: at(WEEK_START, '09:00'),
  endsAt: null,
  allDay: false,
  location: null,
  personId: 'p1',
  personName: 'Kevin',
  personColor: '#2F7FED',
  personEmoji: '🐻',
  participants: [],
  ...over,
})

// A STATEFUL double: a POSTed event really joins the week, so "adding is visible
// immediately" is what's under test rather than a canned view replayed back.
function mockApi(initial: Record<string, unknown>[]) {
  const events = [...initial]
  const reads: string[] = []
  const posts: Record<string, unknown>[] = []
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    if (u.startsWith('/api/persons')) return { ok: true, json: async () => ({ persons: PERSONS }) }
    // useEventColorSource + useHousehold both read this; no household ⇒ the device zone,
    // which is the zone the fixtures above were built in.
    if (u.startsWith('/api/household')) return { ok: true, json: async () => ({ household: null, person: null }) }
    if (u.startsWith('/api/events') && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      posts.push(body)
      const ids = (body.participantIds as string[] | undefined) ?? []
      const person = PERSONS.find((p) => p.id === ids[0])
      const created = ev({
        ...body,
        id: `new-${posts.length}`,
        personId: person?.id ?? null,
        personName: person?.name ?? null,
        personColor: person?.colorHex ?? null,
        personEmoji: person?.avatarEmoji ?? null,
      })
      events.push(created)
      return { ok: true, json: async () => ({ event: created }) }
    }
    if (u.startsWith('/api/events')) {
      reads.push(u)
      // A COPY per response, as a real `res.json()` gives. Handing the same array back
      // twice hides the add behind React's identity check — the state array would be
      // mutated in place and nothing would re-render.
      return { ok: true, json: async () => ({ from: '', to: '', events: [...events] }) }
    }
    return { ok: true, json: async () => ({}) }
  }) as unknown as typeof fetch
  return { events, reads, posts }
}

function renderStep(over: Partial<StepBodyProps> = {}) {
  const setDecisionData = vi.fn()
  const refresh = vi.fn()
  render(
    <Body
      step={step}
      sessionId="s1"
      weekStart={WEEK_START}
      setDecisionData={setDecisionData}
      refresh={refresh}
      busy={false}
      {...over}
    />
  )
  return { setDecisionData, refresh }
}

const day = (key: string) => screen.getByTestId(`wpc-day-${key}`)

// Open a day's composer and type its line. Returns the day's column.
async function compose(dayKey: string, dayName: string, text: string) {
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(`add something to ${dayName}`, 'i') }))
  const col = day(dayKey)
  fireEvent.change(within(col).getByRole('textbox', { name: /what's happening/i }), { target: { value: text } })
  return col
}

describe('Weekly planning · step 2 · Calendar', () => {
  it('shows the planned week as seven days of the real calendar, each event on its own day', async () => {
    const { reads } = mockApi([
      ev({ id: 'dentist', title: 'Dentist', startsAt: at('2026-09-08', '15:00') }),
      ev({ id: 'swim', title: 'Swim meet', startsAt: at('2026-09-12', '09:00'), personId: 'p2', personName: 'Nora', personColor: '#25A368' }),
    ])
    renderStep()

    // Seven columns, Sun 6 -> Sat 12 — the week the SERVER handed us, not one computed here.
    await waitFor(() => expect(day('2026-09-06')).toBeInTheDocument())
    for (const k of ['2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12']) {
      expect(day(k)).toBeInTheDocument()
    }
    expect(within(day('2026-09-06')).getByText('Sun')).toBeInTheDocument()
    expect(within(day('2026-09-06')).getByText('6')).toBeInTheDocument()
    expect(within(day('2026-09-12')).getByText('Sat')).toBeInTheDocument()
    expect(within(day('2026-09-12')).getByText('12')).toBeInTheDocument()

    // Real events, on their real days.
    expect(await within(day('2026-09-08')).findByText('Dentist')).toBeInTheDocument()
    expect(within(day('2026-09-12')).getByText('Swim meet')).toBeInTheDocument()
    // …and nothing invented on the days that have nothing.
    expect(within(day('2026-09-07')).getByText(/nothing yet/i)).toBeInTheDocument()

    // The window is exactly the planned week — an off-by-one here silently empties a column.
    expect(reads.some((u) => u.includes('from=2026-09-06') && u.includes('to=2026-09-12'))).toBe(true)
  })

  it('colours each event by its owner, the way the rest of the app does', async () => {
    mockApi([ev({ id: 'dentist', title: 'Dentist', startsAt: at('2026-09-08', '15:00'), personColor: '#2F7FED' })])
    renderStep()
    const row = await within(day('2026-09-08')).findByText('Dentist')
    const bar = row.closest('.wpc-ev')?.querySelector('.wpc-bar') as HTMLElement | null
    expect(bar).toBeTruthy()
    expect(bar!.style.background).toBe('rgb(47, 127, 237)')
  })

  it('opens the composer in place on the day you tapped, and nowhere else', async () => {
    mockApi([])
    renderStep()

    fireEvent.click(await screen.findByRole('button', { name: /add something to wednesday 9/i }))

    expect(within(day('2026-09-09')).getByRole('textbox', { name: /what's happening on wednesday 9/i })).toBeInTheDocument()
    // Only the tapped day composes; every other day still offers its own add tile.
    expect(within(day('2026-09-08')).queryByRole('textbox')).not.toBeInTheDocument()
    expect(within(day('2026-09-08')).getByRole('button', { name: /add something to tuesday 8/i })).toBeInTheDocument()
  })

  it('adds a real calendar event on that day, shows it straight away, and leaves a crumb', async () => {
    const { posts } = mockApi([])
    const { setDecisionData, refresh } = renderStep()

    const col = await compose('2026-09-09', 'wednesday 9', 'Soccer practice')
    fireEvent.change(within(col).getByLabelText('Time'), { target: { value: '17:00' } })
    fireEvent.click(within(col).getByRole('button', { name: 'Nora' }))
    fireEvent.click(within(col).getByRole('button', { name: /add to the week/i }))

    // A real event through the app's own create path — on the day that was tapped.
    await waitFor(() => expect(posts.length).toBe(1))
    expect(posts[0]).toMatchObject({ title: 'Soccer practice', allDay: false, participantIds: ['p2'] })
    expect(posts[0].startsAt).toBe(at('2026-09-09', '17:00'))

    // Visible immediately, on Wednesday, and ringed as something this session added.
    const line = await within(day('2026-09-09')).findByText('Soccer practice')
    expect(line.closest('.wpc-ev')).toHaveClass('new')
    // The composer closes and the day offers its add tile again.
    expect(within(day('2026-09-09')).queryByRole('textbox')).not.toBeInTheDocument()

    // The crumb is a COUNT, never a copy of the calendar — the recap reads through.
    expect(setDecisionData).toHaveBeenCalledWith({ added: 1 })
    expect(refresh).toHaveBeenCalled()
  })

  it('puts one event on more than one person — both parents is the ordinary case', async () => {
    const { posts } = mockApi([])
    renderStep()

    const col = await compose('2026-09-10', 'thursday 10', 'Parent-teacher night')
    const kevin = within(col).getByRole('button', { name: 'Kevin' })
    const nora = within(col).getByRole('button', { name: 'Nora' })
    expect(kevin).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(kevin)
    fireEvent.click(nora)
    expect(kevin).toHaveAttribute('aria-pressed', 'true')
    expect(nora).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(within(col).getByRole('button', { name: /add to the week/i }))
    await waitFor(() => expect(posts.length).toBe(1))
    expect(posts[0].participantIds).toEqual(['p1', 'p2'])
  })

  it('lets a chosen person be un-chosen again', async () => {
    const { posts } = mockApi([])
    renderStep()

    const col = await compose('2026-09-10', 'thursday 10', 'Haircut')
    const kevin = within(col).getByRole('button', { name: 'Kevin' })
    fireEvent.click(kevin)
    fireEvent.click(kevin)
    expect(kevin).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(within(col).getByRole('button', { name: /add to the week/i }))
    await waitFor(() => expect(posts.length).toBe(1))
    expect(posts[0].participantIds).toEqual([])
  })

  it('opens on a time, and the all-day chip is the other half of the pair', async () => {
    const { posts } = mockApi([])
    renderStep()

    const col = await compose('2026-09-11', 'friday 11', 'Grandma visits')
    // The pair: a time is chosen to begin with, all-day is not.
    const allDay = within(col).getByRole('button', { name: /all day/i })
    expect(allDay).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(allDay)
    expect(allDay).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(within(col).getByRole('button', { name: /add to the week/i }))

    await waitFor(() => expect(posts.length).toBe(1))
    expect(posts[0]).toMatchObject({ title: 'Grandma visits', allDay: true, endsAt: null })
    // Filed at midday, so it can't slide into the day next door.
    expect(posts[0].startsAt).toBe(at('2026-09-11', '12:00'))
  })

  it('will not add an empty line, and leaves no crumb until something is really added', async () => {
    const { posts } = mockApi([])
    const { setDecisionData } = renderStep()

    fireEvent.click(await screen.findByRole('button', { name: /add something to monday 7/i }))
    const col = day('2026-09-07')
    expect(within(col).getByRole('button', { name: /add to the week/i })).toBeDisabled()
    fireEvent.change(within(col).getByRole('textbox', { name: /what's happening/i }), { target: { value: '   ' } })
    expect(within(col).getByRole('button', { name: /add to the week/i })).toBeDisabled()
    expect(posts.length).toBe(0)
    // `{ added: 0 }` would be noise on the session record.
    expect(setDecisionData).not.toHaveBeenCalled()
  })

  it('backs out of the composer without adding anything', async () => {
    const { posts } = mockApi([])
    renderStep()

    const col = await compose('2026-09-08', 'tuesday 8', 'Never mind')
    fireEvent.click(within(col).getByRole('button', { name: /close/i }))

    expect(within(day('2026-09-08')).queryByRole('textbox')).not.toBeInTheDocument()
    expect(within(day('2026-09-08')).getByRole('button', { name: /add something to tuesday 8/i })).toBeInTheDocument()
    expect(posts.length).toBe(0)
  })

  it('says so instead of silently swallowing a refused save', async () => {
    mockApi([])
    const realFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith('/api/events') && (init?.method ?? 'GET') === 'POST') {
        return { ok: false, status: 400, json: async () => ({ error: 'BadRequest', message: 'title is required' }) }
      }
      return (realFetch as unknown as typeof fetch)(url as never, init as never)
    }) as unknown as typeof fetch

    renderStep()
    const col = await compose('2026-09-10', 'thursday 10', 'Book club')
    fireEvent.click(within(col).getByRole('button', { name: /add to the week/i }))

    expect(await within(day('2026-09-10')).findByText(/couldn't add/i)).toBeInTheDocument()
    // The line survives so it can be retried rather than retyped.
    expect(within(day('2026-09-10')).getByRole('textbox', { name: /what's happening/i })).toHaveValue('Book club')
  })

  it('names the week and says what the one action does', async () => {
    mockApi([])
    renderStep()
    // The shell hides its own week label on a phone, so the body carries it.
    expect(await screen.findByText(/Sun 6\s*-\s*Sat 12/)).toBeInTheDocument()
    expect(screen.getByText(/Tap any day to add what isn’t on here yet/i)).toBeInTheDocument()
  })

  it('stops offering the add while the session is writing', async () => {
    mockApi([])
    renderStep({ busy: true })
    expect(await screen.findByRole('button', { name: /add something to sunday 6/i })).toBeDisabled()
  })
})
