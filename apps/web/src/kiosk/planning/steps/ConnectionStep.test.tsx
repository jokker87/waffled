import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import mod, { pairingSentence } from './ConnectionStep'
import type { PlanningStep } from '../../../lib/api'
import type { StepBodyProps } from '../registry'

// Step 5 · Connection. Three things this file is here to hold in place, because each is
// a way the step could look right and be wrong:
//
//  1. THE ROWS ARE A PROMPT, NOT THE LIST. The server ranks every pair in the house;
//     the step draws three and "Make a pairing" takes any two people — or three — and
//     asks the server for THEIR gaps. If the composer ever becomes a corner affordance
//     rather than a first-class one, these tests should be what notices.
//  2. TIME THAT ALREADY EXISTS GETS CREDIT. The row whose week already has the two of
//     them must be able to say "you're already doing this on Saturday" instead of only
//     offering to manufacture a new commitment.
//  3. ADDING IS THE APP'S OWN EVENT MODAL. Picking a slot opens `EventModal` with those
//     exact participants and that time — it does not open a who/what/when form of this
//     step's own. The assertions go through the modal's real DOM ("New event", its
//     Title field, its Add button) and the real POST body, so a hand-rolled composer
//     would fail them.

const WEEK_START = '2026-09-06' // a Sunday; the week runs Sun Sep 6 -> Sat Sep 12

const Body = mod.Body

const step: PlanningStep = {
  key: 'connection',
  number: 5,
  title: 'Connection',
  ask: 'Who gets time with whom?',
  primary: 'Done',
  act: 'Claim the good',
  available: true,
  status: 'pending',
  data: {},
  decidedAt: null,
  // The shell renders the parked-note handoff, not the step — see Handoff in
  // WeeklyPlanning.tsx. A step test mounts `Body` alone, so there is never one here.
  parked: [],
}

// The household's REAL people, from /api/persons. Nothing in this step may render a
// hardcoded family: who the pairing is between is the entire content of a row.
const PERSONS = [
  { id: 'p1', name: 'Kevin', memberType: 'adult', isAdmin: true, avatarEmoji: '🐻', colorHex: '#2F7FED' },
  { id: 'p2', name: 'Kelly', memberType: 'adult', isAdmin: false, avatarEmoji: '🦊', colorHex: '#25A368' },
  { id: 'p3', name: 'Wally', memberType: 'kid', isAdmin: false, avatarEmoji: '🐢', colorHex: '#C2410C' },
  { id: 'p4', name: 'Lottie', memberType: 'kid', isAdmin: false, avatarEmoji: '🦄', colorHex: '#9333EA' },
]

const evt = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  title: 'Yard work',
  startsAt: '2026-09-12T18:00:00.000Z',
  endsAt: '2026-09-12T20:00:00.000Z',
  allDay: false,
  minutes: 120,
  day: 'Saturday',
  time: '1:00 PM',
  when: 'Saturday 1:00 PM',
  ...over,
})

// A gap's instant, built by LOCAL parse — the modal renders it back through the
// device's zone, so a UTC literal here would assert a different clock time on a machine
// outside America/Chicago.
const atLocal = (d: string, t: string) => new Date(`${d}T${t}`).toISOString()

const slot = (over: Record<string, unknown> = {}) => ({
  date: '2026-09-08',
  startsAt: atLocal('2026-09-08', '20:30'),
  kind: 'after' as const,
  afterTitle: 'Dinner at the Hales',
  label: 'Tue after 8:30 PM',
  ...over,
})

const BOARD = {
  weekStart: WEEK_START,
  pairings: [
    {
      personIds: ['p1', 'p2'],
      who: 'Kevin and Kelly',
      lastTogetherOn: '2026-08-08',
      lastTogetherTitle: 'Date night',
      alreadyThisWeek: [],
      togetherThisWeek: [evt({ id: 'hales', title: 'Dinner at the Hales', day: 'Friday', time: '6:00 PM', when: 'Friday 6:00 PM', minutes: 150 })],
      slots: [slot(), slot({ date: '2026-09-12', kind: 'open', startsAt: null, afterTitle: null, label: 'Sat · free all day' })],
    },
    {
      personIds: ['p1', 'p3'],
      who: 'Kevin and Wally',
      lastTogetherOn: null,
      lastTogetherTitle: null,
      alreadyThisWeek: [evt()],
      togetherThisWeek: [],
      slots: [slot({ date: '2026-09-09', label: 'Wed after Scouts', afterTitle: 'Scouts', startsAt: atLocal('2026-09-09', '19:30') })],
    },
    {
      personIds: ['p2', 'p4'],
      who: 'Kelly and Lottie',
      lastTogetherOn: null,
      lastTogetherTitle: null,
      alreadyThisWeek: [],
      togetherThisWeek: [evt({ id: 'd1', title: 'Dance', day: 'Tuesday' }), evt({ id: 'd2', title: 'Dance', day: 'Thursday' })],
      slots: [slot({ date: '2026-09-10', kind: 'open', startsAt: null, afterTitle: null, label: 'Thu · free all day' })],
    },
    {
      // A fourth pair the server ranked but the step does not draw — the rows are a
      // prompt, not the list.
      personIds: ['p3', 'p4'],
      who: 'Wally and Lottie',
      lastTogetherOn: null,
      lastTogetherTitle: null,
      alreadyThisWeek: [],
      togetherThisWeek: [],
      slots: [],
    },
  ],
}

// A stateful-enough double: the board is served as given, `/slots` answers for whoever
// was asked about, and a POSTed event is recorded so "it lands as an ordinary event
// with those participants" is what's under test rather than a canned view replayed back.
function mockApi(board: unknown = BOARD) {
  const posts: Record<string, unknown>[] = []
  const slotCalls: string[] = []
  const boardReads: number[] = []
  // A supplier, so a test can serve a board that CHANGES between reads — which is what
  // the server does while a local-first write is still uploading.
  const boardNow = () => (typeof board === 'function' ? (board as () => unknown)() : board)
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    if (u.startsWith('/api/persons')) return { ok: true, json: async () => ({ persons: PERSONS }) }
    if (u.startsWith('/api/household')) return { ok: true, json: async () => ({ household: null, person: null }) }
    // Order matters: /connection/slots is a prefix match away from /connection.
    if (u.startsWith('/api/weekly-planning/connection/slots')) {
      slotCalls.push(u)
      return {
        ok: true,
        json: async () => ({
          weekStart: WEEK_START,
          personIds: ['p1', 'p4'],
          who: 'Kevin and Lottie',
          slots: [slot({ date: '2026-09-11', label: 'Fri after breakfast', afterTitle: 'breakfast' })],
        }),
      }
    }
    if (u.startsWith('/api/weekly-planning/connection')) {
      boardReads.push(Date.now())
      return { ok: true, json: async () => boardNow() }
    }
    if (u.startsWith('/api/events') && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      posts.push(body)
      return { ok: true, json: async () => ({ event: { ...body, id: `new-${posts.length}`, participants: [] } }) }
    }
    // The shared event modal also reads the goals it could count toward and the Google
    // calendars it could write to. Empty is the answer — but SHAPED, not `{}`.
    if (u.startsWith('/api/goals')) return { ok: true, json: async () => ({ goals: [] }) }
    if (u.startsWith('/api/calendar/google/status')) return { ok: true, json: async () => ({ calendars: [] }) }
    return { ok: true, json: async () => ({}) }
  }) as unknown as typeof fetch
  return { posts, slotCalls, boardReads }
}

function renderStep(over: Partial<StepBodyProps> = {}) {
  const setDecisionData = vi.fn()
  const refresh = vi.fn()
  render(
    <MemoryRouter>
      <Body step={step} sessionId="s1" weekStart={WEEK_START} setDecisionData={setDecisionData} refresh={refresh} busy={false} {...over} />
    </MemoryRouter>
  )
  return { setDecisionData, refresh }
}

const row = async (ids: string) => (await screen.findByTestId(`wpn-pair-${ids}`)) as HTMLElement

// The shared event modal, once it's up. It is the app's own `.modal-card` — this step
// renders `EventModal`, it does not carry a second event form of its own.
async function eventModal(): Promise<HTMLElement> {
  const heading = await screen.findByText('New event')
  return heading.closest('.modal-card') as HTMLElement
}

/** Fill the modal's real Title field and submit it. */
async function nameItAndSave(modal: HTMLElement, title: string) {
  fireEvent.change(within(modal).getByLabelText('Title'), { target: { value: title } })
  fireEvent.click(within(modal).getByRole('button', { name: 'Add event' }))
}

describe('Weekly planning · step 5 · Connection', () => {
  it('draws the top pairings from the board, with the household’s real faces', async () => {
    mockApi()
    renderStep()

    expect(await screen.findByText('Kevin and Kelly')).toBeInTheDocument()
    expect(screen.getByText('Kevin and Wally')).toBeInTheDocument()
    expect(screen.getByText('Kelly and Lottie')).toBeInTheDocument()
    // The rows are a PROMPT, not the list: the server ranked four, the step draws three.
    expect(screen.queryByText('Wally and Lottie')).not.toBeInTheDocument()

    // Real people from /api/persons — never a hardcoded design-era family.
    const kk = await row('p1-p2')
    expect(within(kk).getByRole('img', { name: 'Kevin and Kelly' })).toHaveTextContent('🐻')
    expect(within(kk).getByRole('img', { name: 'Kevin and Kelly' })).toHaveTextContent('🦊')
  })

  it('says how long it has been, and names the thing that is nearly it but isn’t', async () => {
    mockApi()
    renderStep()
    const kk = await row('p1-p2')
    expect(within(kk).getByText(/Nothing on the calendar with just the two of you since Aug 8/)).toBeInTheDocument()
    expect(within(kk).getByText(/Friday’s Dinner at the Hales is you both, but it’s not that/)).toBeInTheDocument()
  })

  it('gives credit for time that already exists instead of manufacturing a commitment', async () => {
    mockApi()
    renderStep()
    const kw = await row('p1-p3')
    expect(within(kw).getByText(/Saturday’s Yard work is the two of you for 2 hours — that may already be it/)).toBeInTheDocument()
    // The muted chip that says the week already answers this. It is NOT a slot: it
    // offers nothing new, it acknowledges what is there.
    expect(within(kw).getByRole('button', { name: /Yard work.*already counts/i })).toBeInTheDocument()
  })

  it('lets you say the time you already have counts, and counts that in the crumb', async () => {
    mockApi()
    const { setDecisionData } = renderStep()
    const kw = await row('p1-p3')
    fireEvent.click(within(kw).getByRole('button', { name: /Yard work.*already counts/i }))

    expect(await within(kw).findByText(/Nothing new — Saturday’s Yard work already is it, and you said so out loud/)).toBeInTheDocument()
    // A crumb is a hint for the recap, never storage — so counts, never module data.
    expect(setDecisionData).toHaveBeenLastCalledWith({ added: 0, alreadyCounted: 1 })
  })

  it('picks a slot by opening the app’s own event modal with those two people and that time', async () => {
    const { posts } = mockApi()
    const { refresh } = renderStep()
    const kk = await row('p1-p2')
    fireEvent.click(within(kk).getByRole('button', { name: /Tue after 8:30 PM/ }))

    const modal = await eventModal()
    // The date and time came from the gap, and both of them are already on it.
    expect(within(modal).getByLabelText('Date')).toHaveValue('2026-09-08')
    expect(within(modal).getByLabelText('Time')).toHaveValue('20:30')
    await nameItAndSave(modal, 'Date night')

    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].title).toBe('Date night')
    expect(posts[0].participantIds).toEqual(['p1', 'p2'])
    // The rows and the shell's counter should both agree with what just happened.
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it('keeps asking until the board has caught up with the event just saved', async () => {
    // THE WRITE IS LOCAL-FIRST and this board is a SERVER read. `EventModal` saves
    // through PowerSync (`createEventLocal`) and uploads afterwards, so at the instant
    // `onSaved` fires the server has not been told yet. Asking once, immediately, asked
    // too early — and the failure was invisible in the worst way: the event WAS on the
    // calendar (which renders the local mirror) while the pairing underneath it still
    // read "Nothing on the calendar with just the two of you".
    //
    // Reported twice. The first round blamed the ranking, which was a real but
    // different bug; this is the one that was actually costing the row.
    let reads = 0
    const caughtUp = {
      ...BOARD,
      pairings: BOARD.pairings.map((p) =>
        p.personIds.join(',') === 'p1,p2'
          ? { ...p, alreadyThisWeek: [evt({ id: 'fresh', title: 'Date night', day: 'Tuesday', when: 'Tuesday 8:30 PM' })] }
          : p
      ),
    }
    // The first read after the save still predates the upload; the next one has it.
    const { posts } = mockApi(() => (++reads > 2 ? caughtUp : BOARD))

    renderStep()
    const kk = await row('p1-p2')
    fireEvent.click(within(kk).getByRole('button', { name: /Tue after 8:30 PM/ }))
    await nameItAndSave(await eventModal(), 'Date night')
    await waitFor(() => expect(posts).toHaveLength(1))

    // The row tells the truth without anybody leaving the step and coming back.
    expect(await within(await row('p1-p2')).findByText(/Date night/, {}, { timeout: 5000 })).toBeInTheDocument()
  }, 15000)

  it('leaves the time to the modal’s own picker when the whole day is open', async () => {
    mockApi()
    renderStep()
    const kk = await row('p1-p2')
    fireEvent.click(within(kk).getByRole('button', { name: /Sat · free all day/ }))
    const modal = await eventModal()
    expect(within(modal).getByLabelText('Date')).toHaveValue('2026-09-12')
    // No invented evening: the modal's default stands, whatever it is.
    expect(within(modal).getByLabelText('Time')).toHaveValue('17:00')
  })

  it('offers another time for a pairing whose suggested gaps do not suit', async () => {
    mockApi()
    renderStep()
    const kk = await row('p1-p2')
    fireEvent.click(within(kk).getByRole('button', { name: /Another time.*Kevin and Kelly/i }))
    const modal = await eventModal()
    expect(within(modal).getByLabelText('Date')).toHaveValue(WEEK_START)
  })

  it('makes a pairing of any two people — or three — and offers THEIR gaps', async () => {
    const { slotCalls, posts } = mockApi()
    renderStep()
    fireEvent.click(await screen.findByRole('button', { name: /Make a pairing/i }))

    const maker = screen.getByTestId('wpn-make')
    // Every person in the house is offered, by name.
    for (const p of PERSONS) {
      expect(within(maker).getByRole('button', { name: new RegExp(`${p.name}`, 'i') })).toBeInTheDocument()
    }
    fireEvent.click(within(maker).getByRole('button', { name: /Kevin/i }))
    fireEvent.click(within(maker).getByRole('button', { name: /Lottie/i }))

    // Two people chosen ⇒ ask the server for the gaps THIS pairing has, in the week the
    // server gave us. Never a gap computed on the device.
    await waitFor(() => expect(slotCalls.some((u) => u.includes('people=p1,p4') && u.includes(`weekStart=${WEEK_START}`))).toBe(true))
    expect(await within(maker).findByRole('button', { name: /Fri after breakfast/ })).toBeInTheDocument()

    // A third person is welcome — "any two people (or three)".
    fireEvent.click(within(maker).getByRole('button', { name: /Wally/i }))
    await waitFor(() => expect(slotCalls.some((u) => u.includes('people=p1,p3,p4') || u.includes('people=p1,p4,p3'))).toBe(true))

    fireEvent.click(within(maker).getByRole('button', { name: /Fri after breakfast/ }))
    const modal = await eventModal()
    await nameItAndSave(modal, 'Doughnuts before school')
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].title).toBe('Doughnuts before school')
    expect(posts[0].participantIds).toEqual(['p1', 'p3', 'p4'])
  })

  it('can always pick a date and time itself, for a pairing with no gap the app can see', async () => {
    mockApi()
    renderStep()
    fireEvent.click(await screen.findByRole('button', { name: /Make a pairing/i }))
    const maker = screen.getByTestId('wpn-make')
    fireEvent.click(within(maker).getByRole('button', { name: /Kevin/i }))
    fireEvent.click(within(maker).getByRole('button', { name: /Lottie/i }))
    fireEvent.click(await within(maker).findByRole('button', { name: /Pick a date and time/i }))
    expect(await eventModal()).toBeInTheDocument()
  })

  it('says plainly that the rows are not the list — without promising a count', async () => {
    mockApi()
    renderStep()
    expect(
      await screen.findByText(/The rows above are just the pairings the app can see — they aren’t the list/)
    ).toBeInTheDocument()
  })

  it('reads right for a household with exactly one pairing', async () => {
    // A couple with no kids has ONE pair. The footnote must not claim three rows, and
    // "Make a pairing" is still the offer — it is the only way to reach anybody else.
    mockApi({ weekStart: WEEK_START, pairings: [BOARD.pairings[0]] })
    renderStep()
    expect(await screen.findByText('Kevin and Kelly')).toBeInTheDocument()
    expect(screen.queryByText(/three rows/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Make a pairing/i })).toBeInTheDocument()
  })

  it('says so rather than drawing an empty board when there is nobody to pair', async () => {
    mockApi({ weekStart: WEEK_START, pairings: [] })
    renderStep()
    expect(await screen.findByText(/needs more than one person/i)).toBeInTheDocument()
  })
})

describe('pairingSentence', () => {
  // The row's whole job in one function, so the wording is testable without a DOM.
  const base = { personIds: ['p1', 'p2'], who: 'A and B', lastTogetherOn: null, lastTogetherTitle: null, alreadyThisWeek: [], togetherThisWeek: [], slots: [] }

  it('leads with the time that already exists', () => {
    expect(pairingSentence({ ...base, alreadyThisWeek: [evt()] }, false)).toMatch(
      /^Saturday’s Yard work is the two of you for 2 hours/
    )
  })

  it('changes once somebody says out loud that it counts', () => {
    expect(pairingSentence({ ...base, alreadyThisWeek: [evt()] }, true)).toBe(
      'Nothing new — Saturday’s Yard work already is it, and you said so out loud.'
    )
  })

  it('counts the times the week throws them together without it being that', () => {
    const twice = [evt({ day: 'Tuesday', title: 'Dance' }), evt({ day: 'Thursday', title: 'Dance' })]
    expect(pairingSentence({ ...base, togetherThisWeek: twice }, false)).toBe(
      'Nothing on the calendar with just the two of you. You’re both at 2 things this week, but none of them is that.'
    )
  })

  it('never claims a date it does not have', () => {
    expect(pairingSentence(base, false)).toBe('Nothing on the calendar with just the two of you.')
  })
})

describe('Connection · a pairing with time on it is never hidden', () => {
  // "I added a custom time and it pre-filled the people … but then when I saved nothing
  // showed up on the connection page. Actually, I went and checked the calendar tab, the
  // events did save but they didn't populate on the connection tab."
  //
  // The event saved and the client DOES re-read the board. What hid it was `slice(0, 3)`:
  // the rows are ranked by how long it has been since it was just those two, and that
  // ranking reads only history BEFORE the planned week — so giving a pairing time inside
  // the week does not move it up, and a pairing ranked 4th stays invisible no matter what
  // you just did for it.
  //
  // Three rows is still the right PROMPT. But a pairing with time already on the week is
  // not a prompt, it is a fact about the week, and the step's own design leads with
  // "time that already exists gets credit".
  it('draws a pairing that already has time this week even below the prompt cap', async () => {
    const withCredit = {
      ...BOARD,
      pairings: [
        ...BOARD.pairings.slice(0, 3),
        { ...BOARD.pairings[3], alreadyThisWeek: [evt({ id: 'made', title: 'Just us', day: 'Thursday', time: '7:00 PM', when: 'Thursday 7:00 PM' })] },
      ],
    }
    mockApi(withCredit)
    renderStep()
    expect(await row('p3-p4')).toBeTruthy()
    // And it says why it is there.
    expect((await row('p3-p4')).textContent).toMatch(/counts/i)
  })

  it('still caps the pairings it is only SUGGESTING at three', async () => {
    // The fourth pairing has nothing on the week, so it stays a suggestion the step
    // declines to make — otherwise a six-person household reads fifteen rows.
    mockApi()
    renderStep()
    await row('p1-p2')
    expect(screen.queryByTestId('wpn-pair-p3-p4')).toBeNull()
  })

  it('never drops a pairing with credit, even past the cap', async () => {
    // The rule: three is a cap on what the step SUGGESTS. A pairing with time already on
    // the week is not a suggestion, so all four are drawn here and no suggestion is —
    // there is nothing left to prompt about.
    const allWithCredit = {
      ...BOARD,
      pairings: BOARD.pairings.map((p, i) => ({
        ...p,
        alreadyThisWeek: [evt({ id: `a${i}`, title: 'Just us', day: 'Thursday', time: '7:00 PM', when: 'Thursday 7:00 PM' })],
      })),
    }
    mockApi(allWithCredit)
    renderStep()
    await row('p1-p2')
    expect(screen.getAllByTestId(/^wpn-pair-/)).toHaveLength(4)
  })

  it('keeps the server’s ranking rather than floating credit rows to the top', async () => {
    // The board is ordered by how long it has been since it was just those two, and that
    // order is the step's argument. Surfacing a hidden row must not reorder the rest.
    mockApi()
    renderStep()
    await row('p1-p2')
    const drawn = screen.getAllByTestId(/^wpn-pair-/).map((el) => el.getAttribute('data-testid'))
    expect(drawn).toEqual(['wpn-pair-p1-p2', 'wpn-pair-p1-p3', 'wpn-pair-p2-p4'])
  })
})
