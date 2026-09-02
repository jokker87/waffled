import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import mealsStep from './MealsStep'
import type { StepBodyProps } from '../registry'
import type { PlanningMealsView } from '../../../lib/api'

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

function mockApi(opts: { view?: PlanningMealsView; recipes?: { id: string; title: string }[] } = {}) {
  calls.length = 0
  let view = opts.view ?? baseView()
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url: u, method, body })

    if (u.includes('/api/recipes')) {
      return { ok: true, json: async () => ({ recipes: opts.recipes ?? [{ id: 'r-9', title: 'Chili', emoji: '🌶️' }] }) }
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

describe('meals step · plan the rest for me', () => {
  it('offers the fill in the FOOTER, and fills only the empty nights', async () => {
    mockApi()
    draw()
    await screen.findByText('Pasta bake')

    const foot = screen.getByTestId('foot')
    const fill = within(foot).getByRole('button', { name: /plan the rest for me/i })
    // The AI action wears the app's gradient button, not a hand-rolled one.
    expect(fill.className).toContain('btn-ai')
    fireEvent.click(fill)

    await waitFor(() => expect(sent('POST', '/meals/fill')).toHaveLength(1))
    // The week it fills is the one the shell handed it.
    expect(sent('POST', '/meals/fill')[0].body).toEqual({ weekStart: WEEK })

    // The three that were empty are now filled AND marked as auto-filled; the four
    // that were already set are untouched.
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
    fireEvent.click(within(screen.getByTestId('foot')).getByRole('button', { name: /plan the rest for me/i }))

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
    fireEvent.click(within(screen.getByTestId('foot')).getByRole('button', { name: /plan the rest for me/i }))

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
    fireEvent.click(within(screen.getByTestId('foot')).getByRole('button', { name: /plan the rest for me/i }))
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
