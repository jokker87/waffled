import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import mealsStep from './MealsStep'
import type { StepBodyProps } from '../registry'
import type { PlanningMealsView, PlanningShoppingTrip } from '../../../lib/api'

// Step 7 · Meals — seven columns for the week, each night's events above its dish,
// "Plan the rest for me" in the footer and the undo that replaces it.
//
// The shell puts `Body` in the body and `FooterExtra` in the footer, so they are two
// separate React trees over one piece of state. Every test below mounts BOTH, because
// the interesting behaviour — a fill in the footer marking nights in the body — only
// exists between them.
//
// EVERY date here comes from the `weekStart` prop. The server owns the week boundary;
// a step that derived its own seven days is the bug this module was built after.

const WEEK = '2026-09-06' // a Sunday
const day = (i: number) => {
  const d = new Date(`${WEEK}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + i)
  return d.toISOString().slice(0, 10)
}

const dinner = (over: Record<string, unknown> = {}) => ({
  entryId: 'e-1',
  title: 'Pasta bake',
  emoji: '🍝',
  recipeId: 'r-1',
  mealId: null,
  imageUrl: null,
  cookName: null,
  cookAvatar: null,
  cookColor: null,
  minutes: 35,
  ...over,
})

// Four nights set, three empty — the state the design describes.
const baseView = (): PlanningMealsView => ({
  weekStart: WEEK,
  nights: [
    { date: day(0), events: [], dinner: dinner({ entryId: 'e-0', title: 'Pasta bake', recipeId: 'r-1', cookName: 'Kevin', cookAvatar: '🐻' }) },
    {
      date: day(1),
      events: [{ id: 'ev-1', title: 'Soccer practice', startsAt: `${day(1)}T22:30:00.000Z`, allDay: false, personName: 'Ada', personColor: '#7c5cff' }],
      dinner: dinner({ entryId: 'e-1', title: 'Fish tacos', emoji: '🌮', recipeId: 'r-2' }),
    },
    { date: day(2), events: [], dinner: dinner({ entryId: 'e-2', title: 'Leftovers', emoji: null, recipeId: null }) },
    { date: day(3), events: [{ id: 'ev-2', title: 'Parent night', startsAt: `${day(3)}T00:00:00.000Z`, allDay: true, personName: null, personColor: null }], dinner: null },
    { date: day(4), events: [], dinner: dinner({ entryId: 'e-4', title: 'Eating out', emoji: null, recipeId: null }) },
    { date: day(5), events: [], dinner: null },
    { date: day(6), events: [], dinner: null },
  ],
  emptyDates: [day(3), day(5), day(6)],
  groceries: { items: 24, checked: 3 },
  choresOn: true,
  shopping: null,
})

const trip = (over: Partial<PlanningShoppingTrip> = {}): PlanningShoppingTrip => ({
  choreId: 'ch-1',
  personId: 'p-kelly',
  personName: 'Kelly',
  personAvatar: '🦊',
  personColor: '#e07a3f',
  dueOn: day(6),
  dueTime: '09:00',
  status: 'pending',
  ...over,
})

// The view after a fill: the three empties now hold auto-picked dishes.
const filledView = () => {
  const v = baseView()
  const picks: Record<string, string> = { [day(3)]: 'Chili', [day(5)]: 'Stir fry', [day(6)]: 'Soup' }
  v.nights = v.nights.map((n) =>
    picks[n.date] ? { ...n, dinner: dinner({ entryId: `auto-${n.date}`, title: picks[n.date], emoji: '🥘', recipeId: `rr-${n.date}` }) } : n
  )
  v.emptyDates = []
  v.groceries = { items: 31, checked: 3 }
  return v
}

const FILLED = [day(3), day(5), day(6)].map((d) => ({ date: d, entryId: `auto-${d}`, recipeId: `rr-${d}`, title: null }))

const calls: { url: string; method: string; body: Record<string, unknown> | null }[] = []

// A title-only recipe: every other field is null/absent, exactly as a recipe somebody
// has just typed a name for arrives. The picker's search must still find it — a
// predicate over one of those nulls is what silently dropped the row.
const titleOnly = (id: string, title: string) => ({ id, title })

// What the shared planner drafts. Keyed by date so the mock answers for whichever
// nights the planner asked about — never a fixed week of its own.
const PICKS: Record<string, string> = { [day(3)]: 'Chili', [day(5)]: 'Stir fry', [day(6)]: 'Soup' }

function mockApi(opts: { view?: PlanningMealsView; recipes?: { id: string; title: string }[] | (() => { id: string; title: string }[]) } = {}) {
  calls.length = 0
  let view = opts.view ?? baseView()
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url: u, method, body })

    // The shared "Plan my week" planner, drafting for exactly the dates it asked
    // about — which this step narrows to the empty nights.
    if (u.includes('/api/meals/plan-week')) {
      const dates = (body?.dates as string[]) ?? []
      return {
        ok: true,
        json: async () => ({
          start: WEEK,
          mealType: 'dinner',
          via: 'test',
          suggestions: dates.map((d) => ({
            date: d, mealType: 'dinner', title: PICKS[d] ?? 'Something', recipeId: `rr-${d}`,
            emoji: '🥘', minutes: 30, servings: 4, note: null,
          })),
        }),
      }
    }
    if (u.includes('/api/recipes')) {
      const r = typeof opts.recipes === 'function' ? opts.recipes() : opts.recipes
      return { ok: true, json: async () => ({ recipes: r ?? [titleOnly('r-9', 'Chili')] }) }
    }
    if (u.includes('/api/persons')) {
      return { ok: true, json: async () => ({ persons: [{ id: 'p-kelly', name: 'Kelly', avatarEmoji: '🦊' }, { id: 'p-kevin', name: 'Kevin', avatarEmoji: '🐻' }] }) }
    }
    if (u.includes('/api/weekly-planning/meals/shopper')) {
      view = { ...view, shopping: body?.dueOn ? trip({ dueOn: body.dueOn as string, personId: (body.personId as string) ?? null, personName: body.personId ? 'Kelly' : null }) : null }
      return { ok: true, json: async () => ({ weekStart: WEEK, shopping: view.shopping, view }) }
    }
    if (u.includes('/api/weekly-planning/meals/fill')) {
      view = filledView()
      return { ok: true, json: async () => ({ weekStart: WEEK, filled: FILLED, view }) }
    }
    if (u.includes('/api/weekly-planning/meals/undo')) {
      view = baseView()
      return { ok: true, json: async () => ({ weekStart: WEEK, cleared: [day(3), day(5), day(6)], kept: [], view }) }
    }
    if (u.includes('/api/weekly-planning/meals')) return { ok: true, json: async () => view }
    // Planning a night by hand, then the step's re-read.
    return { ok: true, json: async () => ({ ok: true }) }
  }) as unknown as typeof fetch
}

let seq = 0
const setDecisionData = vi.fn()

function props(over: Partial<StepBodyProps> = {}): StepBodyProps {
  return {
    step: {
      key: 'meals', number: 7, title: 'Meals', ask: 'What’s planned, and what’s still open?',
      primary: 'Done', act: 'Run the household', requiresModule: 'meals',
      available: true, status: 'pending', data: {}, decidedAt: null,
    },
    // A fresh session per test: the step's state is keyed by session+week, so a new
    // id is what makes each test a clean mount rather than a shared cache.
    sessionId: `s-${++seq}`,
    weekStart: WEEK,
    setDecisionData,
    refresh: vi.fn(),
    busy: false,
    ...over,
  }
}

// The shell renders Body and FooterExtra in two places; so does this.
function draw(p: StepBodyProps = props()) {
  const { Body, FooterExtra } = mealsStep
  return render(
    <div>
      <div data-testid="body"><Body {...p} /></div>
      <div data-testid="foot">{FooterExtra ? <FooterExtra {...p} /> : null}</div>
    </div>
  )
}

const sent = (m: string, frag: string) => calls.filter((c) => c.method === m && c.url.includes(frag))
const nights = () => Array.from(document.querySelectorAll('.wpm-night'))

// "Plan the rest for me" no longer drafts silently — it opens the SHARED week
// planner (apps/web/src/kiosk/components/PlanWeek.tsx), which is where the
// guardrails and the preferences box live. So every fill in these tests is the same
// three moves the family makes: open it, draft, approve.
const openPlanner = async () => {
  fireEvent.click(within(screen.getByTestId('foot')).getByRole('button', { name: /plan the rest for me/i }))
  return (await screen.findByRole('dialog', { name: /plan the rest of the week/i })) as HTMLElement
}
async function planAndApply() {
  const planner = await openPlanner()
  fireEvent.click(within(planner).getByRole('button', { name: /^plan my week$/i }))
  const apply = await within(planner).findByRole('button', { name: /add week & build list/i })
  fireEvent.click(apply)
}

beforeEach(() => setDecisionData.mockClear())

describe('meals step · the week as it stands', () => {
  it('shows the same seven columns as the calendar, in order', async () => {
    mockApi()
    draw()
    await screen.findByText('Pasta bake')
    expect(nights()).toHaveLength(7)
    // The read asks the server for the week it was handed — it never derives one.
    expect(sent('GET', '/api/weekly-planning/meals')[0].url).toContain(`weekStart=${WEEK}`)
  })

  it("puts the night's events above its dish", async () => {
    mockApi()
    draw()
    await screen.findByText('Fish tacos')
    const monday = nights()[1]
    const evs = monday.querySelector('.wpm-events')!
    const dish = monday.querySelector('.wpm-dish')!
    expect(within(monday as HTMLElement).getByText('Soccer practice')).toBeTruthy()
    // "Events above the dish, because that's the only context that matters here."
    expect(evs.compareDocumentPosition(dish) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows the plan as-is — four nights set, three empty', async () => {
    mockApi()
    draw()
    await screen.findByText('Pasta bake')
    expect(document.querySelectorAll('.wpm-dish.empty')).toHaveLength(3)
    expect(screen.getByText('Leftovers')).toBeTruthy()
    expect(screen.getByText('Eating out')).toBeTruthy()
  })

  it('keeps groceries to one bar — where it came from, and what is on it', async () => {
    mockApi()
    draw()
    await screen.findByText('Pasta bake')
    const line = document.querySelectorAll('.wpm-gro')
    expect(line).toHaveLength(1)
    // The sub-note explains the list rather than just counting it. Both halves are
    // claims the data supports: the rebuild really does drop pantry staples.
    expect(line[0].querySelector('.wpm-gro-s')!.textContent).toMatch(/planned so far.*staples skipped/)
    // …and the pill says what's on it. Every board row carries an aisle.
    expect(line[0].querySelector('.wpm-gro-pill')!.textContent).toContain('24 items')
    expect(line[0].querySelector('.wpm-gro-pill')!.textContent).toContain('aisle order')
  })

  it('names who is cooking when the plan knows', async () => {
    mockApi()
    draw()
    await screen.findByText('Pasta bake')
    // A cook is real data (meal_plan_entries.cook_person_id), so it is shown with the
    // person's own avatar — not invented for the nights that have none.
    expect(nights()[0].querySelector('.wpm-dish-c')!.textContent).toMatch(/🐻\s*Kevin/)
    // A night with no cook falls back to what the recipe itself knows.
    expect(nights()[1].querySelector('.wpm-dish-c')!.textContent).toContain('35 min')
  })

  it('gives the dish tile a distinct state for planned, empty and eating out', async () => {
    mockApi()
    draw()
    await screen.findByText('Pasta bake')
    // Planned: no modifier. Leftovers is a cooked-at-home night, not takeout.
    expect(nights()[0].querySelector('.wpm-dish')!.className).toBe('wpm-dish')
    expect(nights()[2].querySelector('.wpm-dish')!.className).toBe('wpm-dish')
    // Empty: the big + is the whole tile.
    expect(nights()[3].querySelector('.wpm-dish.empty')).toBeTruthy()
    expect(nights()[3].querySelector('.wpm-dish-plus')).toBeTruthy()
    // Eating out, classified by the SAME helper the Meals screen uses — a night must
    // not read as takeout on one screen and a cooked dinner on another.
    expect(nights()[4].querySelector('.wpm-dish.out')).toBeTruthy()
  })

  it('renders "nothing on" so the seven dish tiles line up', async () => {
    mockApi()
    draw()
    await screen.findByText('Pasta bake')
    // Five of the seven nights have no events; each still gets its context line, and
    // every column carries the events block that keeps the dishes on one line.
    expect(document.querySelectorAll('.wpm-ev-none')).toHaveLength(5)
    expect(document.querySelectorAll('.wpm-night > .wpm-events')).toHaveLength(7)
  })
})

describe('meals step · who is shopping', () => {
  it('offers the trip as a control, and names the person once it is assigned', async () => {
    mockApi()
    draw()
    await screen.findByText('Pasta bake')
    // Unassigned it reads as an invitation, not a fabricated shopper.
    const pill = within(screen.getByTestId('body')).getByRole('button', { name: /who's shopping/i })
    expect(pill.className).toContain('wpm-shop')
    fireEvent.click(pill)

    const card = document.querySelector('.modal-card') as HTMLElement
    fireEvent.click(await within(card).findByRole('button', { name: /kelly/i }))
    fireEvent.click(within(card).getByRole('button', { name: /sat/i }))
    fireEvent.click(within(card).getByRole('button', { name: /add it to tasks/i }))

    await waitFor(() => expect(sent('PUT', '/meals/shopper')).toHaveLength(1))
    // One chore per week, so the client always hands back the id it last saw.
    expect(sent('PUT', '/meals/shopper')[0].body).toMatchObject({ weekStart: WEEK, personId: 'p-kelly', dueOn: day(6), choreId: null })
    // …and the pill now renders from the chore.
    expect(await screen.findByRole('button', { name: /Kelly shops/ })).toBeTruthy()
  })

  it('says so when the trip is planned but up for grabs', async () => {
    mockApi({ view: { ...baseView(), shopping: trip({ personId: null, personName: null, personAvatar: null }) } })
    draw()
    await screen.findByText('Pasta bake')
    expect(screen.getByRole('button', { name: /up for grabs/i })).toBeTruthy()
  })

  it('passes the chore id back so a renamed chore is not duplicated', async () => {
    mockApi({ view: { ...baseView(), shopping: trip() } })
    draw()
    await screen.findByText('Pasta bake')
    fireEvent.click(screen.getByRole('button', { name: /Kelly shops/ }))
    const card = document.querySelector('.modal-card') as HTMLElement
    fireEvent.click(await within(card).findByRole('button', { name: /update the trip/i }))
    await waitFor(() => expect(sent('PUT', '/meals/shopper')).toHaveLength(1))
    expect(sent('PUT', '/meals/shopper')[0].body).toMatchObject({ choreId: 'ch-1' })
  })

  it('clears the trip rather than leaving an orphan chore', async () => {
    mockApi({ view: { ...baseView(), shopping: trip() } })
    draw()
    await screen.findByText('Pasta bake')
    fireEvent.click(screen.getByRole('button', { name: /Kelly shops/ }))
    const card = document.querySelector('.modal-card') as HTMLElement
    fireEvent.click(await within(card).findByRole('button', { name: /no trip this week/i }))
    await waitFor(() => expect(sent('PUT', '/meals/shopper')).toHaveLength(1))
    expect(sent('PUT', '/meals/shopper')[0].body).toMatchObject({ dueOn: null, personId: null })
    await waitFor(() => expect(screen.getByRole('button', { name: /who's shopping/i })).toBeTruthy())
  })

  it('drops the control entirely when the chores module is off', async () => {
    mockApi({ view: { ...baseView(), choresOn: false } })
    draw()
    await screen.findByText('Pasta bake')
    // No dead affordance — and the plain grocery line is still there.
    expect(document.querySelector('.wpm-shop')).toBeNull()
    expect(document.querySelector('.wpm-gro-pill')!.textContent).toContain('24 items')
  })
})

describe('meals step · plan the rest for me', () => {
  it('reuses the shared week planner rather than drafting behind a bare button', async () => {
    mockApi()
    draw()
    await screen.findByText('Pasta bake')

    const foot = screen.getByTestId('foot')
    const fill = within(foot).getByRole('button', { name: /plan the rest for me/i })
    // The AI action wears the app's gradient button, not a hand-rolled one.
    expect(fill.className).toContain('btn-ai')
    fireEvent.click(fill)

    // What opens is PlanWeek itself — proved by the things this step never built:
    // the guardrails and the free-text preferences box.
    const planner = await screen.findByRole('dialog', { name: /plan the rest of the week/i })
    expect(within(planner).getByText(/keep in mind/i)).toBeTruthy()
    expect(within(planner).getByPlaceholderText(/lottie skips spicy/i)).toBeTruthy()
    expect(within(planner).getByRole('switch', { name: /try something new/i })).toBeTruthy()
    // Nothing is written just by opening it.
    expect(sent('POST', '/meals/fill')).toHaveLength(0)
  })

  it('offers the planner ONLY the empty nights, and asks the model for just those', async () => {
    mockApi()
    draw()
    await screen.findByText('Pasta bake')
    const planner = await openPlanner()

    // Three empty nights ⇒ three day chips. A chip for a night somebody already
    // decided would draft a dish the fill then refuses to write — a silent no-op.
    expect(planner.querySelectorAll('.plan-day-chip')).toHaveLength(3)
    expect(within(planner).getByText(/three empty nights/i)).toBeTruthy()
    // Dinner is the only meal this step plans, so the meal segment is gone rather
    // than offering a Lunch that could never be written.
    expect(planner.querySelector('.seg-plantype')).toBeNull()

    fireEvent.click(within(planner).getByRole('button', { name: /^plan my week$/i }))
    await waitFor(() => expect(sent('POST', '/api/meals/plan-week')).toHaveLength(1))
    expect(sent('POST', '/api/meals/plan-week')[0].body).toMatchObject({
      start: WEEK, mealType: 'dinner', dates: [day(3), day(5), day(6)],
    })
  })

  it("applies the approved week through the step's own fill, and marks what it filled", async () => {
    mockApi()
    draw()
    await screen.findByText('Pasta bake')
    await planAndApply()

    // NOT through POST /api/meals/plan: only the step's fill can refuse a night
    // somebody already decided AND hand back the receipt the undo checks.
    await waitFor(() => expect(sent('POST', '/meals/fill')).toHaveLength(1))
    expect(calls.filter((c) => c.method === 'POST' && /\/api\/meals\/plan$/.test(c.url))).toHaveLength(0)
    const body = sent('POST', '/meals/fill')[0].body!
    expect(body.weekStart).toBe(WEEK)
    expect((body.cards as { date: string }[]).map((c) => c.date)).toEqual([day(3), day(5), day(6)])

    // The planner closes back onto the week, the three that were empty are now
    // filled AND marked, and the four already set are untouched.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /plan the rest of the week/i })).toBeNull())
    await screen.findByText('Chili')
    expect(document.querySelectorAll('.wpm-dish.auto')).toHaveLength(3)
    expect(screen.getByText('Pasta bake')).toBeTruthy()
    expect(screen.getByText('Leftovers')).toBeTruthy()
    // The grocery line moves with the plan and says what just happened — a MEASURED
    // delta (31 - 24), never a claim about items nobody counted.
    await waitFor(() => expect(document.querySelector('.wpm-gro-s')!.textContent).toContain('7 items added'))
    expect(document.querySelector('.wpm-gro-pill')!.textContent).toContain('31 items')
  })

  it('turns the same footer slot into "Undo the three"', async () => {
    mockApi()
    draw()
    await screen.findByText('Pasta bake')
    await planAndApply()

    const undo = await within(screen.getByTestId('foot')).findByRole('button', { name: /undo the three/i })
    // One control, not two: the fill is gone while there is something to undo.
    expect(within(screen.getByTestId('foot')).queryByRole('button', { name: /plan the rest for me/i })).toBeNull()

    fireEvent.click(undo)
    await waitFor(() => expect(sent('POST', '/meals/undo')).toHaveLength(1))
    // The undo proves which nights it wrote, so a night decided since survives.
    expect(sent('POST', '/meals/undo')[0].body).toEqual({ weekStart: WEEK, filled: FILLED })

    await waitFor(() => expect(document.querySelectorAll('.wpm-dish.empty')).toHaveLength(3))
    expect(within(screen.getByTestId('foot')).getByRole('button', { name: /plan the rest for me/i })).toBeTruthy()
  })

  it('records the crumb the session should keep — the dates, never the meals', async () => {
    mockApi()
    draw()
    await screen.findByText('Pasta bake')
    await planAndApply()

    await waitFor(() => expect(setDecisionData).toHaveBeenCalledWith({ autoFilled: [day(3), day(5), day(6)] }))
    fireEvent.click(await within(screen.getByTestId('foot')).findByRole('button', { name: /undo the three/i }))
    await waitFor(() => expect(setDecisionData).toHaveBeenLastCalledWith(null))
  })

  it('has nothing to offer once every night is planned', async () => {
    mockApi({ view: filledView() })
    draw()
    await screen.findByText('Chili')
    const fill = within(screen.getByTestId('foot')).getByRole('button', { name: /plan the rest for me/i })
    expect((fill as HTMLButtonElement).disabled).toBe(true)
  })

  it('restores the MARKS from the session crumb on a revisit — but not the undo', async () => {
    mockApi({ view: filledView() })
    draw(props({ step: { ...props().step, status: 'done', data: { autoFilled: [day(3), day(5), day(6)] } } }))
    await screen.findByText('Chili')
    expect(document.querySelectorAll('.wpm-dish.auto')).toHaveLength(3)

    // The crumb is DATES — it cannot prove what the fill wrote, and a claim rebuilt
    // from the current view would be checked against the very row it came from. So a
    // revisit shows what the app picked and offers no batch undo; a night is taken
    // back one tap at a time, which is the only honest option left.
    const foot = within(screen.getByTestId('foot'))
    expect(foot.queryByRole('button', { name: /undo the/i })).toBeNull()
    expect((foot.getByRole('button', { name: /plan the rest for me/i }) as HTMLButtonElement).disabled).toBe(true)
  })
})

// The bug the family hit: "why didn't this pull from my recipes? I added one and
// started typing and nothing happened." Two things were wrong and both are covered
// here — the field never filtered anything, and the library was cached behind a
// truthy empty array so a recipe added afterwards never appeared.
describe('meals step · picking a dish from the library', () => {
  const library = () => [titleOnly('r-9', 'Chili'), titleOnly('r-8', 'Fish tacos'), titleOnly('r-7', 'Soup')]

  const openNight = async (i: number) => {
    fireEvent.click(nights()[i].querySelector('.wpm-dish')!)
    const card = document.querySelector('.modal-card') as HTMLElement
    await within(card).findByRole('button', { name: /chili/i })
    return card
  }

  it('filters the library as you type, and picking one plans that night', async () => {
    mockApi({ recipes: library() })
    draw()
    await screen.findByText('Pasta bake')
    const card = await openNight(5)
    expect(card.querySelectorAll('.wpm-recipe')).toHaveLength(3)

    // One field, two jobs — so it has to actually narrow the list.
    fireEvent.change(within(card).getByLabelText(/search your recipes/i), { target: { value: 'chi' } })
    expect(card.querySelectorAll('.wpm-recipe')).toHaveLength(1)
    expect(within(card).getByRole('button', { name: /chili/i })).toBeTruthy()

    fireEvent.click(within(card).getByRole('button', { name: /chili/i }))
    await waitFor(() => expect(sent('POST', '/api/meals/plan')).toHaveLength(1))
    // Picking a recipe beats the text: the night is the recipe, not "chi".
    expect(sent('POST', '/api/meals/plan')[0].body).toMatchObject({ date: day(5), mealType: 'dinner', recipeId: 'r-9' })
    expect(sent('POST', '/api/meals/plan')[0].body!.title).toBeNull()
  })

  it('finds a recipe that has nothing but a title', async () => {
    // Every other field is absent, which is how a just-created recipe arrives — the
    // search must filter the nulls out rather than let one drop the row.
    mockApi({ recipes: [titleOnly('r-1', 'Dummy recipe')] })
    draw()
    await screen.findByText('Pasta bake')
    fireEvent.click(nights()[5].querySelector('.wpm-dish')!)
    const card = document.querySelector('.modal-card') as HTMLElement
    await within(card).findByRole('button', { name: /dummy recipe/i })
    fireEvent.change(within(card).getByLabelText(/search your recipes/i), { target: { value: 'dumm' } })
    expect(within(card).getByRole('button', { name: /dummy recipe/i })).toBeTruthy()
  })

  it('picks up a recipe added since the step was first opened', async () => {
    // The old picker cached the list in module state behind `if (recipes) return` —
    // and an EMPTY library is a truthy `[]`, so a household that opened the picker
    // before adding its first recipe was told "no recipes yet" for good.
    let lib: { id: string; title: string }[] = []
    mockApi({ recipes: () => lib })
    draw()
    await screen.findByText('Pasta bake')

    fireEvent.click(nights()[5].querySelector('.wpm-dish')!)
    let card = document.querySelector('.modal-card') as HTMLElement
    expect(await within(card).findByText(/recipe library is empty/i)).toBeTruthy()
    fireEvent.click(within(card).getByRole('button', { name: /^cancel$/i }))

    lib = [titleOnly('r-1', 'Dummy recipe')]
    fireEvent.click(nights()[6].querySelector('.wpm-dish')!)
    card = document.querySelector('.modal-card') as HTMLElement
    expect(await within(card).findByRole('button', { name: /dummy recipe/i })).toBeTruthy()
  })

  it('says the library is empty plainly, and still plans what you type', async () => {
    mockApi({ recipes: [] })
    draw()
    await screen.findByText('Pasta bake')
    fireEvent.click(nights()[5].querySelector('.wpm-dish')!)
    const card = document.querySelector('.modal-card') as HTMLElement

    // Plain, and it says what to do instead — not a bare "nothing here".
    expect(await within(card).findByText(/your recipe library is empty/i)).toBeTruthy()
    fireEvent.change(within(card).getByLabelText(/search your recipes/i), { target: { value: 'Leftovers' } })
    fireEvent.click(within(card).getByRole('button', { name: /plan it/i }))
    await waitFor(() => expect(sent('POST', '/api/meals/plan')).toHaveLength(1))
    expect(sent('POST', '/api/meals/plan')[0].body).toMatchObject({ date: day(5), title: 'Leftovers', recipeId: null })
  })

  it('distinguishes "no match" from "no recipes", and still plans the typed dish', async () => {
    mockApi({ recipes: library() })
    draw()
    await screen.findByText('Pasta bake')
    const card = await openNight(5)

    fireEvent.change(within(card).getByLabelText(/search your recipes/i), { target: { value: 'zzz' } })
    // A household with three recipes must never be told it has none.
    expect(within(card).queryByText(/library is empty/i)).toBeNull()
    expect(within(card).getByText(/no recipe matches/i)).toBeTruthy()
    expect(card.querySelectorAll('.wpm-recipe')).toHaveLength(0)

    fireEvent.click(within(card).getByRole('button', { name: /plan it/i }))
    await waitFor(() => expect(sent('POST', '/api/meals/plan')).toHaveLength(1))
    expect(sent('POST', '/api/meals/plan')[0].body).toMatchObject({ date: day(5), title: 'zzz', recipeId: null })
  })
})

describe('meals step · overwriting a set night', () => {
  it('is a tap on that night, and writes through the existing meal-plan endpoint', async () => {
    mockApi()
    draw()
    await screen.findByText('Pasta bake')

    fireEvent.click(nights()[5].querySelector('.wpm-dish')!)
    const card = document.querySelector('.modal-card')!
    expect(card).toBeTruthy()

    // The library loads when the modal opens.
    fireEvent.click(await within(card as HTMLElement).findByRole('button', { name: /chili/i }))
    await waitFor(() => expect(sent('POST', '/api/meals/plan')).toHaveLength(1))
    expect(sent('POST', '/api/meals/plan')[0].body).toMatchObject({ date: day(5), mealType: 'dinner', recipeId: 'r-9' })
  })

  it('clears a night through the existing endpoint too', async () => {
    mockApi()
    draw()
    await screen.findByText('Pasta bake')

    fireEvent.click(nights()[0].querySelector('.wpm-dish')!)
    fireEvent.click(within(document.querySelector('.modal-card') as HTMLElement).getByRole('button', { name: /clear this night/i }))
    await waitFor(() => expect(sent('DELETE', '/api/meals/plan')).toHaveLength(1))
    expect(sent('DELETE', '/api/meals/plan')[0].url).toContain(`date=${day(0)}`)
  })

  it('stops calling a hand-decided night auto-filled', async () => {
    mockApi()
    draw()
    await screen.findByText('Pasta bake')
    await planAndApply()
    await screen.findByText('Chili')
    expect(document.querySelectorAll('.wpm-dish.auto')).toHaveLength(3)

    // Overwrite one of the three by hand — it is now a decision, not an auto-fill.
    // (`filledView()` still marks it, so this proves the mark is dropped too.)
    fireEvent.click(nights()[5].querySelector('.wpm-dish')!)
    const modal = document.querySelector('.modal-card') as HTMLElement
    fireEvent.click(await within(modal).findByRole('button', { name: /chili/i }))

    await waitFor(() => expect(setDecisionData).toHaveBeenLastCalledWith({ autoFilled: [day(3), day(6)] }))
    expect(await within(screen.getByTestId('foot')).findByRole('button', { name: /undo the two/i })).toBeTruthy()
  })
})
