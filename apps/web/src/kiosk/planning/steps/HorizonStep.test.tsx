import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import mod from './HorizonStep'
import type { PlanningStep } from '../../../lib/api'
import type { StepBodyProps } from '../registry'

// Step 3 · Horizon scan. THE MONTH YOU ALREADY SHIP, PLUS ONE BAR.
//
// So most of what these tests assert is that the step renders the REAL month view
// (`MonthView` + `MonthDayPanel`) rather than a second calendar of its own — the mock's
// own class names (`.cal-grid`, `.cal-cell`, `.ev-tint`, `.cal-day-panel`, `.ag-row`)
// are the shipped ones, which is the design saying exactly that. A second month grid
// here would drift from the calendar's, and the whole premise of the step is that this
// IS the month the family already knows.
//
// The one thing the session adds is the park bar, and the distinction it draws is the
// point of the step: ＋ on a day writes a REAL EVENT; the bar writes a NOTE that is
// never put on the calendar.
//
// `weekStart` is pinned to a fixed Sunday rather than derived from today, because the
// risk in a calendar step is date handling: `new Date('2026-09-06')` is UTC midnight and
// renders as the 5th west of Greenwich.

const WEEK_START = '2026-09-06' // a Sunday, in September 2026
// The 42-cell grid for September 2026 on a Sunday-start household: Aug 30 … Oct 10.
const GRID_START = '2026-08-30'
const GRID_END = '2026-10-10'

const Body = mod.Body

const step: PlanningStep = {
  key: 'horizon',
  number: 3,
  title: 'Horizon scan',
  ask: 'Anything further out you should see now?',
  primary: 'Nothing missing',
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

const TAGS = [
  { stepKey: 'tasks', label: 'Tasks', hint: 'Someone owns it this week', primary: true },
  { stepKey: 'meals', label: 'Meals', hint: 'It changes what we eat' },
  { stepKey: 'calendar', label: 'Calendar', hint: 'A date to look, or a deadline' },
]

// A timed event on `day` at local `time` — LOCAL parse, so the fixture lands on the day
// it says it does whatever zone the test machine is in.
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

interface Opts {
  events?: Record<string, unknown>[]
  countdowns?: Record<string, unknown>[]
  tags?: typeof TAGS
  parked?: { id: string; note: string; stepKey: string | null; stepLabel: string | null; createdAt: string }[]
  // The server refusing a park (the reachable case is `parkItem`'s 500-character cap).
  parkFails?: { status: number; message: string }
}

// A STATEFUL double: a POSTed event really joins the month and a parked note really
// joins the board, so "it showed up" is what's under test rather than a canned view.
function mockApi(opts: Opts = {}) {
  const events = [...(opts.events ?? [])]
  const parked = [...(opts.parked ?? [])]
  const eventReads: string[] = []
  const eventPosts: Record<string, unknown>[] = []
  const parkPosts: Record<string, unknown>[] = []
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    if (u.startsWith('/api/persons')) return { ok: true, json: async () => ({ persons: PERSONS }) }
    // useEventColorSource + useHousehold both read this. No household ⇒ the device zone,
    // which is the zone the fixtures above were built in, and a Sunday-start week.
    if (u.startsWith('/api/household')) return { ok: true, json: async () => ({ household: null, person: null }) }
    if (u.startsWith('/api/countdowns')) {
      return { ok: true, json: async () => ({ countdowns: opts.countdowns ?? [], sleeps: false, birthdayHorizonDays: 30 }) }
    }
    if (u.startsWith('/api/weekly-planning/horizon')) {
      return { ok: true, json: async () => ({ tags: opts.tags ?? TAGS, parked: [...parked] }) }
    }
    if (u.startsWith('/api/weekly-planning/loose-ends/parked') && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      parkPosts.push(body)
      if (opts.parkFails) {
        return {
          ok: false,
          status: opts.parkFails.status,
          json: async () => ({ error: 'BadRequest', message: opts.parkFails!.message }),
        }
      }
      const item = {
        id: `n${parkPosts.length}`,
        note: String(body.note),
        stepKey: (body.stepKey as string | undefined) ?? null,
        stepLabel: TAGS.find((t) => t.stepKey === body.stepKey)?.label ?? null,
        createdAt: new Date().toISOString(),
      }
      parked.push(item)
      return { ok: true, json: async () => ({ item }) }
    }
    if (u.startsWith('/api/events') && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      eventPosts.push(body)
      const ids = (body.participantIds as string[] | undefined) ?? []
      const person = PERSONS.find((p) => p.id === ids[0])
      events.push(
        ev({
          ...body,
          id: `new-${eventPosts.length}`,
          personId: person?.id ?? null,
          personName: person?.name ?? null,
          personColor: person?.colorHex ?? null,
          personEmoji: person?.avatarEmoji ?? null,
        })
      )
      return { ok: true, json: async () => ({ event: events[events.length - 1] }) }
    }
    if (u.startsWith('/api/events')) {
      eventReads.push(u)
      // A COPY per response, as a real `res.json()` gives — handing the same array back
      // twice hides an add behind React's identity check.
      return { ok: true, json: async () => ({ from: '', to: '', events: [...events] }) }
    }
    // The shared event modal also reads the goals it could count toward and the Google
    // calendars it could write to. Empty is the answer, but they must be SHAPED.
    if (u.startsWith('/api/goals')) return { ok: true, json: async () => ({ goals: [] }) }
    if (u.startsWith('/api/calendar/google/status')) return { ok: true, json: async () => ({ calendars: [] }) }
    return { ok: true, json: async () => ({}) }
  }) as unknown as typeof fetch
  return { eventReads, eventPosts, parkPosts }
}

function renderStep(over: Partial<StepBodyProps> = {}) {
  const setDecisionData = vi.fn()
  const refresh = vi.fn()
  const view = render(
    <MemoryRouter>
      <Body
        step={step}
        sessionId="11111111-1111-4111-8111-111111111111"
        weekStart={WEEK_START}
        setDecisionData={setDecisionData}
        refresh={refresh}
        busy={false}
        {...over}
      />
    </MemoryRouter>
  )
  return { setDecisionData, refresh, container: view.container }
}

const cells = (c: HTMLElement) => Array.from(c.querySelectorAll('.cal-cell')) as HTMLElement[]

// The cell for a YYYY-MM-DD, by its offset from the grid's first day — the day numbers
// alone are ambiguous (there are two "1"s and two "30"s on a 42-cell grid).
function cell(c: HTMLElement, key: string): HTMLElement {
  const i = Math.round(
    (Date.parse(`${key}T00:00:00Z`) - Date.parse(`${GRID_START}T00:00:00Z`)) / 86400000
  )
  return cells(c)[i]
}

const panel = () => document.querySelector('.cal-day-panel') as HTMLElement

// The shared event modal, once it's up. `.modal-card` is the app's own — this step
// renders `EventModal`, it does not carry a second event form.
async function eventModal(name = 'New event'): Promise<HTMLElement> {
  const heading = await screen.findByText(name)
  return heading.closest('.modal-card') as HTMLElement
}

const parkInput = () => screen.getByLabelText('Park a note')
const parkIt = () => screen.getByRole('button', { name: /park it/i })

async function type(text: string) {
  fireEvent.change(await screen.findByLabelText('Park a note'), { target: { value: text } })
}

describe('Weekly planning · step 3 · Horizon scan', () => {
  it('renders the SHIPPED month view — the 42-cell grid, not a second calendar', async () => {
    const { container } = renderStep()
    mockApi()

    await waitFor(() => expect(cells(container).length).toBe(42))
    // The grid is the real one: seven weekday headings over six weeks of `.cal-cell`.
    expect(container.querySelectorAll('.cal-dow div').length).toBe(7)
    expect(container.querySelector('.cal-grid')).toBeTruthy()
    // Leading/trailing days are dimmed, September's are not — MonthView's own rule.
    expect(cell(container, GRID_START).className).toContain('dim')
    expect(cell(container, '2026-09-06').className).not.toContain('dim')
    expect(cell(container, GRID_END).className).toContain('dim')
  })

  it('shows the month the planned week is in, and fetches exactly the grid it draws', async () => {
    const { eventReads } = mockApi()
    renderStep()

    expect(await screen.findByText('September 2026')).toBeInTheDocument()
    // The window is the 42 cells, not the month — an off-by-one here silently empties
    // the first or the last row. (`monthGridStart`, shared with the calendar.)
    await waitFor(() =>
      expect(eventReads.some((u) => u.includes(`from=${GRID_START}`) && u.includes(`to=${GRID_END}`))).toBe(true)
    )
  })

  it('paints chips the way the month view paints them — owner colour, ↻, the meal dash', async () => {
    mockApi({
      events: [
        ev({ id: 'campout', title: 'Scout campout', startsAt: at('2026-09-19', '09:00'), personId: 'p2', personName: 'Nora', personColor: '#25A368', personEmoji: '🦊' }),
        ev({ id: 'trash', title: 'Bins out', startsAt: at('2026-09-21', '08:00'), occurrenceStart: at('2026-09-21', '08:00') }),
        ev({ id: 'chili', title: 'Chili', startsAt: at('2026-09-22', '18:00'), origin: 'meal_plan', personId: null, personName: null, personColor: null, personEmoji: null }),
      ],
      countdowns: [{ id: 'c1', date: '2026-09-19', title: 'Campout', emoji: '⛺', daysLeft: 13 }],
    })
    const { container } = renderStep()

    // Owner colour, resolved by lib/event-color.ts — not a second colour rule here.
    const chip = (await within(cell(container, '2026-09-19')).findByText('Scout campout')).closest('.ev') as HTMLElement
    expect(chip.className).toContain('ev-tint')
    expect(chip.style.getPropertyValue('--ev')).toBe('#25A368')

    // A repeat keeps its ↻ and a meal-plan dinner keeps its dashed edge.
    expect(within(cell(container, '2026-09-21')).getByTitle('Repeats')).toBeInTheDocument()
    const meal = within(cell(container, '2026-09-22')).getByText('Chili').closest('.ev') as HTMLElement
    expect(meal.className).toContain('ev-meal')

    // …and the countdown badge is on its day.
    expect(cell(container, '2026-09-19').querySelector('.cal-cd')).toBeTruthy()
  })

  it('a cell selects the day, and the right-hand panel is the shipped day panel', async () => {
    mockApi({
      events: [
        ev({ id: 'campout', title: 'Scout campout', startsAt: at('2026-09-19', '00:00'), allDay: true }),
        ev({ id: 'dropoff', title: 'Drop-off at the church lot', startsAt: at('2026-09-19', '08:00') }),
        ev({ id: 'other', title: 'Not this day', startsAt: at('2026-09-20', '08:00') }),
      ],
    })
    const { container } = renderStep()

    fireEvent.click(await waitFor(() => cell(container, '2026-09-19')))

    await waitFor(() => expect(within(panel()).getByText('Saturday, September 19')).toBeInTheDocument())
    // Agenda rows, all-day first — MonthDayPanel's own ordering, reused not rebuilt.
    const rows = Array.from(panel().querySelectorAll('.ag-row')) as HTMLElement[]
    expect(rows.map((r) => r.querySelector('.ag-title')!.textContent)).toEqual([
      'Scout campout',
      'Drop-off at the church lot',
    ])
    expect(within(panel()).queryByText('Not this day')).not.toBeInTheDocument()
    // The selected cell is marked as selected, as it is on the calendar screen.
    expect(cell(container, '2026-09-19').className).toContain('selected')
  })

  it('＋ on the selected day opens the APP’S OWN event modal, on that day', async () => {
    const { eventPosts } = mockApi()
    const { container, setDecisionData, refresh } = renderStep()

    fireEvent.click(await waitFor(() => cell(container, '2026-09-19')))
    fireEvent.click(await within(panel()).findByRole('button', { name: /add an event on this day/i }))

    const modal = await eventModal()
    // Prefilled to the day whose ＋ was tapped, and it already asks everything an event
    // needs — a second event form in this step is exactly the drift the reuse rule exists
    // to prevent.
    expect(within(modal).getByLabelText('Date')).toHaveValue('2026-09-19')
    expect(within(modal).getByLabelText('Duration')).toBeInTheDocument()
    expect(within(modal).getByText('Repeats')).toBeInTheDocument()

    fireEvent.change(within(modal).getByLabelText('Title'), { target: { value: 'Scout campout' } })
    fireEvent.change(within(modal).getByLabelText('Time'), { target: { value: '09:00' } })
    fireEvent.click(within(modal).getByRole('button', { name: /add event/i }))

    await waitFor(() => expect(eventPosts.length).toBe(1))
    expect(eventPosts[0]).toMatchObject({ title: 'Scout campout' })
    expect(eventPosts[0].startsAt).toBe(at('2026-09-19', '09:00'))
    // It lands on the grid straight away.
    expect(await within(cell(container, '2026-09-19')).findByText('Scout campout')).toBeInTheDocument()
    // The crumb is a COUNT, never a copy of the calendar — the recap reads through.
    await waitFor(() => expect(setDecisionData).toHaveBeenLastCalledWith({ added: 1, parked: 0 }))
    expect(refresh).toHaveBeenCalled()
  })

  it('opens an existing event IN PLACE — the session never navigates away', async () => {
    mockApi({ events: [ev({ id: 'dentist', title: 'Dentist', startsAt: at('2026-09-16', '15:00') })] })
    const { container } = renderStep()

    fireEvent.click(await within(await waitFor(() => cell(container, '2026-09-16'))).findByText('Dentist'))
    // The same shared modal, in edit mode — not a route change, because the shell owns
    // where the session is.
    const modal = await eventModal('Edit event')
    expect(within(modal).getByLabelText('Title')).toHaveValue('Dentist')
    expect(container.querySelector('.cal-grid')).toBeTruthy()
  })

  it('“+N more” opens that day in the panel rather than navigating', async () => {
    mockApi({
      events: [0, 1, 2, 3].map((i) =>
        ev({ id: `e${i}`, title: `Thing ${i}`, startsAt: at('2026-09-23', `${String(8 + i).padStart(2, '0')}:00`) })
      ),
    })
    const { container } = renderStep()

    fireEvent.click(await within(await waitFor(() => cell(container, '2026-09-23'))).findByText('+1 more'))
    await waitFor(() => expect(within(panel()).getByText('Wednesday, September 23')).toBeInTheDocument())
    expect(panel().querySelectorAll('.ag-row').length).toBe(4)
  })
})

describe('Horizon scan · the park bar', () => {
  it('parks a note and writes NOTHING to the calendar', async () => {
    const { parkPosts, eventPosts } = mockApi()
    const { setDecisionData, refresh } = renderStep()

    await type('Camping — we need to pack')
    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }))
    fireEvent.click(parkIt())

    await waitFor(() => expect(parkPosts.length).toBe(1))
    expect(parkPosts[0]).toMatchObject({
      note: 'Camping — we need to pack',
      stepKey: 'tasks',
      sessionId: '11111111-1111-4111-8111-111111111111',
    })
    // THE POINT OF THE STEP: a note is not an event and never reaches the calendar.
    expect(eventPosts.length).toBe(0)

    // It joins the board with the step that will look at it, and the bar empties.
    const board = await screen.findByTestId('wph-board')
    expect(within(board).getByText('Camping — we need to pack')).toBeInTheDocument()
    expect(within(board).getByText('Tasks')).toBeInTheDocument()
    expect(parkInput()).toHaveValue('')

    await waitFor(() => expect(setDecisionData).toHaveBeenLastCalledWith({ added: 0, parked: 1 }))
    expect(refresh).toHaveBeenCalled()
  })

  it('parks with no tag at all — “No tag” is a whole answer', async () => {
    const { parkPosts } = mockApi()
    renderStep()

    await type('Something is coming and we don’t know what')
    fireEvent.click(screen.getByRole('button', { name: 'No tag' }))
    fireEvent.click(parkIt())

    await waitFor(() => expect(parkPosts.length).toBe(1))
    expect(parkPosts[0].stepKey).toBeUndefined()
  })

  it('offers only the tags the server sent — a step this household skips is not a home', async () => {
    // The server filters to the steps that actually run; the bar renders what it is
    // given rather than hardcoding three names of its own.
    mockApi({ tags: TAGS.filter((t) => t.stepKey !== 'meals') })
    renderStep()

    await type('Sort the sleeping bags')
    expect(await screen.findByRole('button', { name: 'Tasks' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Calendar' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Meals' })).not.toBeInTheDocument()
    // "No tag" is the absence of a tag, so it is always offered.
    expect(screen.getByRole('button', { name: 'No tag' })).toBeInTheDocument()
  })

  it('brings back what this session already parked', async () => {
    // `setDecisionData` is not storage: leaving the step and coming back has to show the
    // notes again, which is why they are read from the table that owns them.
    mockApi({
      parked: [
        { id: 'n0', note: 'Book the campsite', stepKey: 'tasks', stepLabel: 'Tasks', createdAt: '2026-09-02T10:00:00Z' },
      ],
    })
    const { setDecisionData } = renderStep()

    const board = await screen.findByTestId('wph-board')
    expect(within(board).getByText('Book the campsite')).toBeInTheDocument()
    expect(within(board).getByText('Tasks')).toBeInTheDocument()
    // …and the crumb counts what's already there rather than starting from zero.
    await waitFor(() => expect(setDecisionData).toHaveBeenLastCalledWith({ added: 0, parked: 1 }))
  })

  it('will not park an empty note — and stays a plain capture line until you type', async () => {
    // Until there is something to tag, the tags and the button have nothing to act on,
    // so the bar says what it is instead. (The mock's untyped state, exactly.)
    const { parkPosts } = mockApi()
    renderStep()
    expect(await screen.findByText('a note, not a calendar entry')).toBeInTheDocument()
    await type('   ')
    expect(screen.queryByRole('button', { name: /park it/i })).not.toBeInTheDocument()
    fireEvent.submit(parkInput().closest('form') as HTMLFormElement)
    expect(parkPosts.length).toBe(0)
  })

  it('starts on the step the server marks primary — Tasks is the ordinary answer', async () => {
    // Both the mock's typed state and step 1's own `DESTINATIONS.parked` mark tasks
    // primary, so the bar opens there rather than on nothing.
    const { parkPosts } = mockApi()
    renderStep()

    await type('Sort the sleeping bags')
    expect((await screen.findByRole('button', { name: 'Tasks' })).className).toContain('on')
    expect(screen.getByRole('button', { name: 'No tag' }).className).not.toContain('on')

    fireEvent.click(parkIt())
    await waitFor(() => expect(parkPosts.length).toBe(1))
    expect(parkPosts[0].stepKey).toBe('tasks')
  })

  it('says so when a park is refused, and keeps what was typed', async () => {
    // `parkItem` caps a note at 500 characters, so this is reachable, not theoretical.
    // Losing the sentence AND saying nothing would be the worst of both.
    mockApi({ parkFails: { status: 400, message: 'a note is at most 500 characters' } })
    renderStep()

    await type('Camping — we need to pack')
    fireEvent.click(parkIt())

    expect(await screen.findByText('a note is at most 500 characters')).toBeInTheDocument()
    expect(parkInput()).toHaveValue('Camping — we need to pack')
    expect(screen.queryByTestId('wph-board')).not.toBeInTheDocument()
    // …and the bar is usable again rather than stuck mid-write.
    expect(parkIt()).toBeEnabled()
  })

  it('says out loud that the ＋ and the bar are two different things', async () => {
    mockApi()
    renderStep()
    // Asserting the DISTINCTION, not the sentence: the first wording ("＋ on a day adds a
    // real event · the bar above parks a note that isn't an event yet") named two
    // mechanisms and was reported as unreadable. What has to survive a rewrite is that
    // the screen still tells you one writes a calendar event, the other does not, and
    // where a parked note comes back.
    const note = await screen.findByText(/real\s+calendar\s+event/i)
    expect(note).toBeInTheDocument()
    expect(note.textContent).toMatch(/stays off the calendar/i)
    expect(note.textContent).toMatch(/step you tag it for/i)
  })
})

describe('Horizon scan · looking further out', () => {
  it('steps forward a month and refetches that month’s grid', async () => {
    // The step's question is "anything FURTHER OUT you should see now?", so it has to be
    // able to look past the month the planned week happens to fall in.
    const { eventReads } = mockApi()
    const { container } = renderStep()

    fireEvent.click(await screen.findByRole('button', { name: /next month/i }))
    expect(await screen.findByText('October 2026')).toBeInTheDocument()
    // October 2026 starts on a Thursday, so its Sunday-start grid runs Sep 27 … Nov 7.
    await waitFor(() =>
      expect(eventReads.some((u) => u.includes('from=2026-09-27') && u.includes('to=2026-11-07'))).toBe(true)
    )
    expect(cells(container).length).toBe(42)
  })

  it('does not scan backwards past the week being planned', async () => {
    // A horizon is what is ahead. The month the session is planning is the floor.
    mockApi()
    renderStep()
    expect(await screen.findByText('September 2026')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /previous month/i })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: /next month/i }))
    expect(await screen.findByText('October 2026')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /previous month/i })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: /previous month/i }))
    expect(await screen.findByText('September 2026')).toBeInTheDocument()
  })
})
