// Weekly Planning · step 7 (Meals) — the seven-column read over the week's dinners,
// the "plan the rest for me" fill and its undo, against a real Postgres.
//
// The step stores NOTHING of its own: it reads the existing meal plan, writes through
// the existing plan/clear paths, and lets the grocery list rebuild itself. So what's
// asserted here is mostly about *not* touching things — the four nights somebody
// already set must come back untouched by a fill, and an undo must clear only what the
// fill wrote.
//
// EVERY date in this file is derived from the week the SERVER named. A literal date
// would pass on the weekday it was written and fail on the others, because which week
// a session plans depends on today, the household's `week_start` and its timezone —
// the exact bug class this step was warned about.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
let householdId: string
// The week the server says this household plans, and its seven dates.
let weekStart: string
let days: string[]
let ownerId: string

function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'waffled-local', audience: 'waffled-api', expiresIn: '1h' })
}

// lambda-api reads the query off `queryStringParameters`, not off the path.
function call(method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const [rawPath, qs] = path.split('?')
  const queryStringParameters: Record<string, string> = {}
  if (qs) for (const pair of qs.split('&')) { const [k, v] = pair.split('='); queryStringParameters[k] = decodeURIComponent(v ?? '') }
  return app.run(
    { httpMethod: method, path: rawPath, headers, queryStringParameters, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false },
    {}
  ) as Promise<{ statusCode: number; body: string }>
}

const kevin = mint('dev|kevin')
const json = (r: { body: string }) => JSON.parse(r.body)

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

interface Night {
  date: string
  events: { id: string; title: string }[]
  dinner: {
    entryId: string
    title: string | null
    recipeId: string | null
    cookName: string | null
    cookAvatar: string | null
    minutes: number | null
  } | null
}
interface StepView {
  weekStart: string
  nights: Night[]
  emptyDates: string[]
  groceries: { items: number; checked: number }
}
interface Filled { date: string; entryId: string; recipeId: string | null; title: string | null }

const stepView = async (week = weekStart): Promise<StepView> =>
  json(await call('GET', `/api/weekly-planning/meals?weekStart=${week}`, kevin))

const planDinner = (date: string, body: Record<string, unknown>) =>
  call('POST', '/api/meals/plan', kevin, { date, mealType: 'dinner', ...body })

// A recipe with one ingredient, so a grocery rebuild has something to put on the list.
async function seedRecipe(title: string, ingredient: string): Promise<string> {
  const r = await call('POST', '/api/recipes', kevin, {
    title,
    servings: 4,
    ingredients: [{ name: ingredient, amount: 1, unit: 'lb' }],
  })
  expect(r.statusCode).toBe(201)
  return json(r).recipe.id
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  const url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  delete process.env.AUTH0_DOMAIN
  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool

  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'Sites', timezone: 'America/Chicago' },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'ownerpass1' },
  })
  householdId = json(setup).household.id
  ownerId = json(setup).person.id
  const { query } = await import('../src/platform/db')
  await query(
    `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|kevin',true)`,
    [householdId, ownerId]
  )
}, 180_000)

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('weekly planning · meals · the gate', () => {
  it('403s while the weeklyPlanning module is off', async () => {
    expect((await call('GET', '/api/weekly-planning/meals', kevin)).statusCode).toBe(403)
  })

  it('opens once the module is on, and the SERVER names the week', async () => {
    expect((await call('PATCH', '/api/household/modules', kevin, { weeklyPlanning: true })).statusCode).toBe(200)
    const planning = json(await call('GET', '/api/weekly-planning', kevin))
    weekStart = planning.weekStart
    days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))

    const res = await call('GET', '/api/weekly-planning/meals', kevin)
    expect(res.statusCode).toBe(200)
    // No `weekStart` asked for ⇒ the same week the session view named.
    expect(json(res).weekStart).toBe(weekStart)
    expect(json(res).nights.map((n: Night) => n.date)).toEqual(days)
  })

  it('snaps a mid-week date back to its week start rather than keying a day', async () => {
    // Wednesday of the planned week must resolve to the same seven columns.
    const view = await stepView(addDays(weekStart, 3))
    expect(view.weekStart).toBe(weekStart)
    expect(view.nights.map((n) => n.date)).toEqual(days)
  })
})

describe('weekly planning · meals · the week as it stands', () => {
  let pasta: string
  let tacos: string

  it('shows the plan as-is: four nights set, three empty', async () => {
    pasta = await seedRecipe('Pasta bake', 'rigatoni')
    tacos = await seedRecipe('Fish tacos', 'tilapia')
    // Enough of a library that the shuffle has a dish for every empty night here AND
    // for a whole second week further down, without repeating one already on the plan.
    for (const [title, ingredient] of [
      ['Chili', 'kidney beans'],
      ['Sheet-pan chicken', 'chicken thighs'],
      ['Stir fry', 'broccoli'],
      ['Soup', 'carrots'],
      ['Curry', 'coconut milk'],
      ['Burgers', 'ground beef'],
      ['Salmon', 'salmon fillet'],
      ['Risotto', 'arborio rice'],
      ['Enchiladas', 'tortillas'],
      ['Meatballs', 'ground pork'],
    ]) await seedRecipe(title, ingredient)

    expect((await planDinner(days[0], { recipeId: pasta })).statusCode).toBe(200)
    expect((await planDinner(days[1], { recipeId: tacos })).statusCode).toBe(200)
    expect((await planDinner(days[2], { title: 'Leftovers' })).statusCode).toBe(200)
    expect((await planDinner(days[4], { title: 'Eating out' })).statusCode).toBe(200)

    const view = await stepView()
    expect(view.nights.filter((n) => n.dinner).map((n) => n.date)).toEqual([days[0], days[1], days[2], days[4]])
    expect(view.emptyDates).toEqual([days[3], days[5], days[6]])
    // The dish reads through to the recipe, so the column has something to render.
    expect(view.nights[0].dinner?.title).toBe('Pasta bake')
    expect(view.nights[2].dinner?.title).toBe('Leftovers')
  })

  it("puts that night's events above the dish — but never the meal's own mirror event", async () => {
    // A real event on the empty Thursday.
    const ev = await call('POST', '/api/events', kevin, {
      title: 'Soccer practice',
      startsAt: `${days[3]}T22:30:00.000Z`,
      endsAt: `${days[3]}T23:30:00.000Z`,
    })
    expect(ev.statusCode).toBe(201)

    const view = await stepView()
    const thu = view.nights.find((n) => n.date === days[3])!
    expect(thu.events.map((e) => e.title)).toContain('Soccer practice')

    // Planning a dinner mirrors it onto the calendar (settings.meals.addToCalendar
    // defaults on). "Dinner · Pasta bake" above the Pasta bake card would be absurd,
    // so origin='meal_plan'/'meal_prep' rows are filtered out of the context.
    const monday = view.nights.find((n) => n.date === days[0])!
    expect(monday.dinner?.title).toBe('Pasta bake')
    expect(monday.events.some((e) => /pasta bake|dinner/i.test(e.title))).toBe(false)
  })

  it("names the cook when the plan has one, and the recipe's time when it doesn't", async () => {
    // A cook is real data — meal_plan_entries.cook_person_id — so the tile's
    // attribution line is sourced, not invented. Every other night reports null and
    // the client falls back to what the recipe knows.
    expect((await planDinner(days[0], { recipeId: pasta, cookPersonId: ownerId })).statusCode).toBe(200)
    const view = await stepView()
    expect(view.nights[0].dinner?.cookName).toBe('Kevin')
    expect(view.nights[1].dinner?.cookName).toBeNull()
    // The seeded recipes carry no times, so `minutes` is honestly null rather than 0.
    expect(view.nights[1].dinner?.minutes).toBeNull()
  })

  it('reports the grocery list as one number, not a panel', async () => {
    const view = await stepView()
    expect(typeof view.groceries.items).toBe('number')
    expect(typeof view.groceries.checked).toBe('number')
  })
})

describe('weekly planning · meals · plan the rest for me', () => {
  let filled: Filled[]
  // What the four already-set nights looked like before the fill.
  let before: Night[]

  it('fills ONLY the empty nights and leaves the set ones exactly as they were', async () => {
    before = (await stepView()).nights.filter((n) => n.dinner)
    const groceriesBefore = (await stepView()).groceries.items

    const res = await call('POST', '/api/weekly-planning/meals/fill', kevin, { weekStart })
    expect(res.statusCode).toBe(200)
    filled = json(res).filled
    expect(filled.map((f) => f.date)).toEqual([days[3], days[5], days[6]])

    const view: StepView = json(res).view
    expect(view.emptyDates).toEqual([])
    // The four nights somebody already decided are byte-for-byte what they were.
    const after = view.nights.filter((n) => n.dinner)
    for (const b of before) {
      const a = after.find((n) => n.date === b.date)!
      expect(a.dinner!.entryId).toBe(b.dinner!.entryId)
      expect(a.dinner!.title).toBe(b.dinner!.title)
      expect(a.dinner!.recipeId).toBe(b.dinner!.recipeId)
    }
    // Groceries build themselves off the plan, so the one line moved with it.
    expect(view.groceries.items).toBeGreaterThan(groceriesBefore)
  })

  it('has nothing left to fill once the week is full', async () => {
    const res = await call('POST', '/api/weekly-planning/meals/fill', kevin, { weekStart })
    expect(res.statusCode).toBe(200)
    expect(json(res).filled).toEqual([])
  })

  it('undoes exactly the nights it filled', async () => {
    const res = await call('POST', '/api/weekly-planning/meals/undo', kevin, { weekStart, filled })
    expect(res.statusCode).toBe(200)
    expect(json(res).cleared.sort()).toEqual([days[3], days[5], days[6]])

    const view: StepView = json(res).view
    expect(view.emptyDates).toEqual([days[3], days[5], days[6]])
    // …and the week is back to the four nights that were there before.
    expect(view.nights.filter((n) => n.dinner).map((n) => n.date)).toEqual([days[0], days[1], days[2], days[4]])
  })

  it('refuses to undo a night somebody has since changed by hand', async () => {
    const fill = await call('POST', '/api/weekly-planning/meals/fill', kevin, { weekStart })
    const wrote: Filled[] = json(fill).filled
    expect(wrote).toHaveLength(3)

    // Somebody overwrites one of the three — "overwriting a set night is a tap on that
    // night" — which makes it a decision, not an auto-fill.
    expect((await planDinner(days[5], { title: 'Grandma’s' })).statusCode).toBe(200)

    const undo = await call('POST', '/api/weekly-planning/meals/undo', kevin, { weekStart, filled: wrote })
    expect(undo.statusCode).toBe(200)
    expect(json(undo).cleared.sort()).toEqual([days[3], days[6]])
    expect(json(undo).kept).toEqual([days[5]])

    const view: StepView = json(undo).view
    expect(view.nights.find((n) => n.date === days[5])!.dinner!.title).toBe('Grandma’s')
    expect(view.emptyDates).toEqual([days[3], days[6]])

    // Put the week back for the tests below.
    await call('DELETE', `/api/meals/plan?date=${days[5]}&mealType=dinner`, kevin)
  })

  it('never fills outside the week the server named', async () => {
    const other = addDays(weekStart, 7)
    const res = await call('POST', '/api/weekly-planning/meals/fill', kevin, { weekStart: other })
    expect(res.statusCode).toBe(200)
    for (const f of json(res).filled as Filled[]) {
      expect(f.date >= other).toBe(true)
      expect(f.date <= addDays(other, 6)).toBe(true)
    }
    // This week is untouched by a fill aimed at the next one.
    expect((await stepView()).emptyDates).toEqual([days[3], days[5], days[6]])
  })

  it('ignores an undo claim for a date outside the week', async () => {
    const res = await call('POST', '/api/weekly-planning/meals/undo', kevin, {
      weekStart,
      filled: [{ date: addDays(weekStart, 30), entryId: '00000000-0000-4000-8000-000000000000', recipeId: null, title: 'nope' }],
    })
    expect(res.statusCode).toBe(200)
    expect(json(res).cleared).toEqual([])
  })
})

describe('weekly planning · meals · the meals module', () => {
  it('403s when the module this step reads is turned off', async () => {
    expect((await call('PATCH', '/api/household/modules', kevin, { meals: false })).statusCode).toBe(200)
    expect((await call('GET', '/api/weekly-planning/meals', kevin)).statusCode).toBe(403)
    expect((await call('POST', '/api/weekly-planning/meals/fill', kevin, { weekStart })).statusCode).toBe(403)
    expect((await call('POST', '/api/weekly-planning/meals/undo', kevin, { weekStart, filled: [] })).statusCode).toBe(403)
    await call('PATCH', '/api/household/modules', kevin, { meals: true })
  })
})
