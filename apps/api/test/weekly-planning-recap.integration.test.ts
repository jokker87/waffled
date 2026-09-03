// Weekly Planning · step 10 · Recap — against a real Postgres (Testcontainers).
//
// The step reads what every other step decided, and the design's governing sentence is
// "every line is a pointer rather than a copy". So what this file mostly drives out is
// a NEGATIVE: the recap must not become a second, stale copy of the household's data.
//
// Concretely, three rules it asserts over and over:
//
//   1. EVERY LINE RESOLVES AT READ TIME. Nothing is counted into a column, nothing is
//      copied at decision time. Undo a decision somewhere else and the line changes or
//      disappears — it never keeps claiming the old answer.
//   2. A SUGGESTION IS NOT A DECISION. The family-night rotation suggests a host and
//      the goals step pre-selects an already-featured goal; neither is something the
//      family said, so neither may be reported as a decision.
//   3. A DELIBERATE NON-ANSWER IS AN OUTCOME. A skipped step and a group that settled
//      on "nothing this week" both belong on the record as real answers ("left alone on
//      purpose") — while a step nobody has reached yet belongs nowhere at all.
//
// Everything else the step shows is somebody else's read, already tested in its own
// file, so this one asserts the JOIN rather than re-testing the sources.
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
let ownerId: string
let wallyId: string
let lottieId: string
let sessionId: string
let weekStart: string
let days: string[]

function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'waffled-local', audience: 'waffled-api', expiresIn: '1h' })
}

// lambda-api reads the query off `queryStringParameters`, NOT off the path — a `?x=y`
// left in `path` is silently invisible to the handler.
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
const setModules = (mods: Record<string, boolean>) => call('PATCH', '/api/household/modules', kevin, mods)

// Pure date arithmetic on a YYYY-MM-DD — UTC on purpose, because nothing here is
// rendered; it only ever adds days.
const addDays = (iso: string, n: number): string =>
  new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10)

// The household is America/Chicago; spelling the offset out keeps a fixture on the day
// it says it is on however the test machine is set.
const at = (day: string, time: string) => `${day}T${time}:00-05:00`

interface Group { key: string; label: string; headline: string; detail: string; count: number; stepKey: string | null }
// The event carries the COLOUR INPUTS, never a resolved colour: `eventColor` is the
// client's decision and lives next to the calendar the strip has to match.
interface DayEvent {
  id: string; title: string; when: string
  personId: string | null; personName: string | null; personColor: string | null
  participantIds: string[]
}
interface Day { date: string; meal: string | null; cook: string | null; events: DayEvent[]; more: number }
interface LastCall { id: string; note: string; detail: string | null }
interface LeftAlone { key: string; label: string; detail: string; badge: string; stepKey: string | null }
interface Recap {
  weekStart: string
  savedAt: string | null
  days: Day[]
  groups: Group[]
  lastCall: LastCall[]
  lastCallMore: number
  leftAlone: LeftAlone[]
  counts: { decisions: number; deferred: number; parked: number }
}

const recap = async (session = sessionId): Promise<Recap> =>
  json(await call('GET', `/api/weekly-planning/recap?sessionId=${session}`, kevin))

const group = (r: Recap, key: string) => r.groups.find((g) => g.key === key)
const alone = (r: Recap, label: string) => r.leftAlone.find((l) => l.label === label)
const titles = (r: Recap, i: number) => r.days[i].events.map((e) => e.title)

const decide = (stepKey: string, status: 'done' | 'skipped', data?: Record<string, unknown>) =>
  call('POST', `/api/weekly-planning/session/${sessionId}/step`, kevin, { stepKey, status, data })

const park = (body: Record<string, unknown>) =>
  call('POST', '/api/weekly-planning/loose-ends/parked', kevin, { sessionId, ...body })

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
  const kids = await query<{ id: string; name: string }>(
    `insert into persons (household_id, name, member_type, sort_order)
     values ($1,'Wally','kid',1), ($1,'Lottie','kid',2) returning id, name`,
    [householdId]
  )
  wallyId = kids.rows.find((r) => r.name === 'Wally')!.id
  lottieId = kids.rows.find((r) => r.name === 'Lottie')!.id
})

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('planning · recap · gating', () => {
  it('403s while the weeklyPlanning module is off, and answers once it is on', async () => {
    expect((await call('GET', '/api/weekly-planning/recap', kevin)).statusCode).toBe(403)
    await setModules({ weeklyPlanning: true })
    expect((await call('GET', '/api/weekly-planning/recap', kevin)).statusCode).toBe(200)
  })

  // The catalog gives `recap` no `requiresModule` — it reads across every module, and
  // gating it on any one of them would delete the close of the session for a household
  // that runs the others. So it must answer, and render, with every optional module off.
  // (What it says with real decisions behind it is the last describe in this file — this
  // one only proves the route survives a household that runs almost nothing.)
  it('answers at all with every optional module off, and before any session exists', async () => {
    await setModules({ chores: false, meals: false, goals: false, familyNight: false, lists: false })
    const r = await recap('')
    expect(r.days).toHaveLength(7)
    expect(r.groups).toEqual([])
    expect(r.counts.decisions).toBe(0)
  })
})

describe('planning · recap · the week, read back', () => {
  // EVERYTHING HERE IS SEEDED BEFORE THE SESSION STARTS. The week the recap reads back
  // is mostly not the session's doing — it is the household's calendar and meal plan —
  // and keeping the fixtures on that side of `started_at` is what lets the group tests
  // below assert on what THIS session changed without the scenery counting as a
  // decision.
  beforeAll(async () => {
    await setModules({ chores: true, meals: true, goals: true, familyNight: true, lists: true })
    weekStart = json(await call('GET', '/api/weekly-planning', kevin)).defaultWeekStart
    days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
    await call('POST', '/api/events', kevin, { title: 'Dance', startsAt: at(days[2], '16:00'), personId: lottieId })
    // A genuinely busy Friday — six things on one day.
    for (let i = 0; i < 6; i++) {
      await call('POST', '/api/events', kevin, { title: `Thing ${i}`, startsAt: at(days[5], `0${i + 3}:00`), personId: ownerId })
    }
    await call('POST', '/api/recipes', kevin, { title: 'Crockpot chili', servings: 4, ingredients: [{ name: 'beans', amount: 1, unit: 'lb' }] })
    await call('POST', '/api/meals/plan', kevin, { date: days[1], mealType: 'dinner', title: 'Crockpot chili' })
    // The wave-2 defect that unit tests could not see: planning a dinner MIRRORS it onto
    // the calendar as a real event, so a week strip that reads events naively says
    // "Dinner · chili" beside the chili it already shows.
    const { query } = await import('../src/platform/db')
    await query(
      `insert into events (household_id, title, starts_at, timezone, origin) values ($1,'Dinner · chili',$2,'America/Chicago','meal_plan')`,
      [householdId, at(days[1], '18:00')]
    )
    sessionId = json(await call('POST', '/api/weekly-planning/session', kevin)).session.id
  })

  it('gives seven days in order, each with its dinner and its events', async () => {
    const r = await recap()
    expect(r.weekStart).toBe(weekStart)
    expect(r.days.map((d) => d.date)).toEqual(days)
    expect(r.days[1].meal).toBe('Crockpot chili')
    expect(titles(r, 2)).toEqual(['Dance'])
    expect(r.savedAt).toBeNull()
  })

  it('keeps meal-plan mirror events out of the day columns', async () => {
    expect(titles(await recap(), 1)).toEqual([])
  })

  // Retrofitted alongside the web change that needed it (the web test came first): a
  // contract guard, because iOS parity will paint the same strip from this payload.
  //
  // The colour INPUTS travel, never a resolved colour. Whether an event paints in the
  // household's family colour or its owner's is the client's `eventColor` decision, and
  // it lives next to the calendar it has to match — resolving it here would give the
  // recap strip and the month view two rules free to drift apart.
  it('carries what a client needs to colour an event the way the calendar does', async () => {
    const r = await recap()
    const dance = r.days[2].events.find((e) => e.title === 'Dance')!
    expect(dance.personId).toBe(lottieId)
    expect(Array.isArray(dance.participantIds)).toBe(true)
    // Present, and null when the person has no colour of their own — which is a real
    // answer the client turns into the unassigned grey, not a missing field.
    expect(dance).toHaveProperty('personColor')
    // No resolved colour on the wire — that is the whole point.
    expect(dance).not.toHaveProperty('colorHex')
  })

  // A genuinely busy day must not push the column past its neighbours — the strip caps
  // and reports the remainder rather than growing.
  it('caps a busy day and says how many it is holding back', async () => {
    const r = await recap()
    expect(r.days[5].events.length).toBeLessThanOrEqual(4)
    expect(r.days[5].more).toBeGreaterThan(0)
    expect(r.days[5].events.length + r.days[5].more).toBe(6)
  })
})

describe('planning · recap · grouped by the module the decision lives in', () => {
  it('counts the events added since the session started, and drops them again if deleted', async () => {
    const added = json(await call('POST', '/api/events', kevin, {
      title: 'Date night', startsAt: at(days[6], '20:00'), personId: ownerId,
    }))
    const cal = group(await recap(), 'calendar')!
    expect(cal.label).toBe('Calendar')
    expect(cal.count).toBe(1)
    expect(cal.detail).toMatch(/Date night/)
    expect(cal.stepKey).toBe('calendar')

    // THE POINTER RULE. Undone elsewhere, the line stops claiming it — a stored count
    // would still say 1.
    await call('DELETE', `/api/events/${added.event.id}`, kevin)
    expect(group(await recap(), 'calendar')).toBeUndefined()
  })

  it('reads the meal plan and the grocery line back off the modules that own them', async () => {
    await call('POST', '/api/meals/plan', kevin, { date: days[3], mealType: 'dinner', title: 'Sheet-pan chicken' })
    const g = group(await recap(), 'meals')!
    expect(g.label).toBe('Meals + Lists')
    expect(g.headline).toMatch(/nights planned/)
    expect(g.detail).toMatch(/Sheet-pan chicken/)
    expect(g.stepKey).toBe('meals')
  })

  it('counts only chores that have BOTH an owner and a day in the week', async () => {
    await call('POST', '/api/chores', kevin, { title: 'Furnace filter', personId: wallyId, rrule: 'FREQ=DAILY' })
    // Nobody has taken this one: it is not a decision yet.
    await call('POST', '/api/chores', kevin, { title: 'Gate latch', personId: null, rrule: 'FREQ=DAILY' })
    const g = group(await recap(), 'tasks')!
    // The rhythms module is off in this household, so the label does not claim it —
    // the same rule as the module-off test above. With rhythms on it reads
    // "Chores + Rhythms".
    expect(g.label).toBe('Chores')
    expect(g.count).toBe(1)
    expect(g.detail).toMatch(/Furnace filter/)
    expect(g.detail).not.toMatch(/Gate latch/)
    expect(g.headline).toMatch(/up for grabs/)
  })

  it('counts a rhythm settled tonight, and only then claims the label', async () => {
    // Rhythms is off by default, so the group must not promise a module it didn't read.
    expect(group(await recap(), 'tasks')!.label).toBe('Chores')

    await setModules({ rhythms: true })
    const made = await call('POST', '/api/rhythms', kevin, {
      title: 'Air filter', satisfiedBy: 'completion', every: '3 months', nextDueAt: '2027-01-01T00:00:00Z',
    })
    expect(made.statusCode).toBe(201)
    // Creating one is not settling it: the group still says nothing about rhythms.
    expect(group(await recap(), 'tasks')!.headline).not.toMatch(/rhythm/)

    expect((await call('POST', `/api/rhythms/${json(made).rhythm.id}/complete`, kevin)).statusCode).toBe(200)
    const g = group(await recap(), 'tasks')!
    expect(g.label).toBe('Chores + Rhythms')
    expect(g.headline).toMatch(/1 rhythm settled/)
    expect(g.detail).toMatch(/Air filter/)
    await setModules({ rhythms: false })
  })

  it('counts a goal group only once THIS session has answered for it', async () => {
    const listRes = await call('POST', '/api/goal-lists', kevin, { name: "Wally's goals", memberIds: [wallyId] })
    expect(listRes.statusCode).toBeLessThan(300)
    const listId = json(listRes).list.id
    const goalRes = await call('POST', '/api/goals', kevin, {
      title: 'Read every night', goalListId: listId, goalType: 'habit', habitPeriod: 'week',
      habitTargetPerPeriod: 3, trackingMode: 'each_tracks', participantIds: [wallyId], isFeatured: true,
    })
    expect(goalRes.statusCode).toBeLessThan(300)
    const goalId = json(goalRes).goal.id

    // A PIN THE SESSION MERELY FOUND is not a decision — the goals step pre-selects it
    // so the family doesn't have to re-pick it, and the recap must not read that
    // pre-selection back as an answer.
    expect(group(await recap(), 'goals')).toBeUndefined()

    expect((await call('PUT', '/api/weekly-planning/goals/focus', kevin, { sessionId, listId, goalId })).statusCode).toBe(200)
    const g = group(await recap(), 'goals')!
    expect(g.count).toBe(1)
    expect(g.detail).toMatch(/Read every night/)
  })

  it('reports only PINNED family-night parts, never the rotation’s suggestion', async () => {
    // Nobody has touched the week: every part is a suggestion, so there is no decision
    // to report and the group is absent.
    expect(group(await recap(), 'familyNight')).toBeUndefined()

    // Pinning is the familyNight module's own write, exactly as the step does it.
    const board = json(await call('GET', `/api/weekly-planning/familyNight?weekStart=${weekStart}`, kevin))
    await call('POST', '/api/family-night/occurrence', kevin, {
      date: board.date, assignments: [{ partId: board.parts[0].partId, personId: lottieId }],
    })
    const g = group(await recap(), 'familyNight')!
    expect(g.count).toBe(1)
    expect(g.detail).toMatch(/Lottie/)
    // The other parts are still the rotation's guess, so the line says so rather than
    // naming whoever the rotation happens to point at.
    expect(g.detail).toMatch(/rotation/)
  })

  it('reads a kid back only when both of their questions are answered', async () => {
    expect((await call('PUT', '/api/weekly-planning/kids/answer', kevin, {
      sessionId, personId: wallyId, focus: { text: 'Reading' },
    })).statusCode).toBe(200)
    // Half an answer is not a read-back.
    expect(group(await recap(), 'kids')).toBeUndefined()

    expect((await call('PUT', '/api/weekly-planning/kids/answer', kevin, {
      sessionId, personId: wallyId, forward: { text: 'Soccer game' },
    })).statusCode).toBe(200)
    const g = group(await recap(), 'kids')!
    expect(g.count).toBe(1)
    expect(g.detail).toMatch(/Wally/)
    expect(g.detail).toMatch(/Reading/)
  })

  it('adds the group counts up into the header’s one number', async () => {
    const r = await recap()
    expect(r.counts.decisions).toBe(r.groups.reduce((n, g) => n + g.count, 0))
    expect(r.counts.decisions).toBeGreaterThan(0)
  })
})

describe('planning · recap · left alone on purpose', () => {
  it('renders a SKIPPED step as an outcome and a pending one not at all', async () => {
    await decide('connection', 'skipped')
    const r = await recap()
    expect(alone(r, 'Connection')!.badge).toBe('skipped')
    // Nobody has reached the horizon scan: not a decision, so not on the record.
    expect(alone(r, 'Horizon scan')).toBeUndefined()
  })

  it('renders "nothing this week" as a real answer for a goal group', async () => {
    const list = json(await call('POST', '/api/goal-lists', kevin, { name: "Lottie's goals", memberIds: [lottieId] }))
    const listId = list.list?.id ?? list.id
    await call('PUT', '/api/weekly-planning/goals/focus', kevin, { sessionId, listId, goalId: null })
    const row = alone(await recap(), "Lottie's goals")!
    expect(row.badge).toBe('none')
    expect(row.detail).toMatch(/no focus/i)
    expect(row.stepKey).toBe('goals')
  })

  it('counts a step answered with nothing changed as read-and-left-alone', async () => {
    await decide('calendar', 'done')
    const row = alone(await recap(), 'Calendar')!
    expect(row.badge).toBe('none')
    expect(row.stepKey).toBe('calendar')
  })

  it('reports notes tagged for a later step as parked, naming that step', async () => {
    await park({ note: 'Kelly’s parents in October?', stepKey: 'tasks' })
    const r = await recap()
    const row = r.leftAlone.find((l) => /parked/i.test(l.badge))!
    expect(row.detail).toMatch(/Tasks/)
    expect(r.counts.deferred).toBe(r.leftAlone.length)
  })
})

describe('planning · recap · a last call on what nobody tagged', () => {
  it('lists only OPEN, UNTAGGED notes — a tagged one is somebody’s already', async () => {
    await park({ note: 'Look into summer camps' })
    const r = await recap()
    expect(r.lastCall.map((l) => l.note)).toEqual(['Look into summer camps'])
    expect(r.counts.parked).toBeGreaterThanOrEqual(2) // tagged + untagged are both parked
  })

  it('says how long a note has waited, and how many sessions walked past it', async () => {
    const { query } = await import('../src/platform/db')
    // Written a fortnight ago, and one session has FINISHED since. "Passed over" is
    // derived from completed sessions, never counted into a column — so it can only say
    // this once a session has actually finished.
    const older = json(await park({ note: 'Fix the fence' })).item.id
    await query(`update planning_parked_items set created_at = now() - interval '14 days' where id = $1`, [older])
    const before = (await recap()).lastCall.find((l) => l.note === 'Fix the fence')!
    expect(before.detail).toMatch(/2 weeks ago/)
    expect(before.detail).not.toMatch(/passed over/)

    const other = json(await call('POST', '/api/weekly-planning/session', kevin, { weekStart: addDays(weekStart, 7) })).session.id
    await call('POST', `/api/weekly-planning/session/${other}/complete`, kevin)

    const after = (await recap()).lastCall.find((l) => l.note === 'Fix the fence')!
    expect(after.detail).toMatch(/passed over once/)
  })

  it('drops a note out of the last call once it is answered', async () => {
    const r = await recap()
    const camp = r.lastCall.find((l) => l.note === 'Look into summer camps')!
    await call('POST', '/api/weekly-planning/loose-ends/resolve', kevin, { kind: 'parked', id: camp.id, action: 'drop', sessionId })
    expect((await recap()).lastCall.map((l) => l.note)).not.toContain('Look into summer camps')
  })
})

describe('planning · recap · the saved record', () => {
  it('carries the finish timestamp once the session is complete', async () => {
    expect((await recap()).savedAt).toBeNull()
    await call('POST', `/api/weekly-planning/session/${sessionId}/complete`, kevin)
    expect((await recap()).savedAt).not.toBeNull()
  })

  // THE CASE ONLY THIS STEP CAN REACH. `recap` has no `requiresModule`, so a household
  // that turns everything off still arrives here — and the record must then be honest by
  // subtraction: the gated groups go, the ungated ones stay, and nothing left on screen
  // names a module that wasn't read.
  it('drops exactly the groups whose module went off, and keeps the rest', async () => {
    const before = await recap()
    expect(before.groups.map((g) => g.key)).toEqual(expect.arrayContaining(['meals', 'tasks', 'goals', 'kids']))

    await setModules({ chores: false, meals: false, goals: false, familyNight: false, lists: false })
    const off = await recap()
    expect(off.groups.map((g) => g.key)).not.toEqual(expect.arrayContaining(['meals', 'tasks', 'goals', 'familyNight']))
    // Kids and the calendar are never gated, so they survive — and the week strip is
    // still the week, just without the dinners.
    expect(off.groups.map((g) => g.key)).toContain('kids')
    expect(off.days).toHaveLength(7)
    expect(off.days.every((d) => d.meal === null)).toBe(true)
    expect(JSON.stringify(off.groups)).not.toMatch(/grocer|nights planned|owner and a day/i)
    expect(off.counts.decisions).toBe(off.groups.reduce((n, g) => n + g.count, 0))

    await setModules({ chores: true, meals: true, goals: true, familyNight: true, lists: true })
    expect((await recap()).groups.map((g) => g.key)).toEqual(before.groups.map((g) => g.key))
  })

  it('still resolves every line after the session is closed — the record is a pointer', async () => {
    const before = await recap()
    await call('POST', '/api/chores', kevin, { title: 'Passport', personId: lottieId, rrule: 'FREQ=DAILY' })
    const after = await recap()
    expect(group(after, 'tasks')!.count).toBe(group(before, 'tasks')!.count + 1)
  })
})
