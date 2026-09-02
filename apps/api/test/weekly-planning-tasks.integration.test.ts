// Weekly Planning · step 8 (Tasks) — "Who's doing what?"
//
// The step is a read over CHORE DEFINITIONS, not chore instances: an instance is one
// day and the session plans a whole week, so assigning next Wednesday's instance of a
// recurring chore would say nothing about Thursday's (and reading a week to build the
// board would side-effect-materialize seven days of instances). The board therefore
// shows unassigned chore *definitions* in a strip, one column per household member, and
// each column's footer states the recurring load that person already carries.
//
// It stores nothing of its own: every write goes through the existing chores endpoints.
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

function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'waffled-local', audience: 'waffled-api', expiresIn: '1h' })
}

// lambda-api reads the query off `queryStringParameters`, NOT off the path — a `?x=y`
// left in `path` is silently invisible to the handler. Split it here, as the shell's
// weekly-planning.integration.test.ts does.
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

interface BoardChore { id: string; title: string; cadence: string; days: string[]; carriedOver: boolean; pendingInstanceIds: string[] }
interface BoardPerson { id: string; name: string; recurringChores: number; chores: BoardChore[] }
const board = async () => json(await call('GET', '/api/weekly-planning/tasks', kevin)) as { weekStart: string; people: BoardPerson[]; unassigned: BoardChore[] }
const strip = (b: { unassigned: BoardChore[] }) => b.unassigned.map((c) => c.title)
const who = (b: { people: BoardPerson[] }, name: string) => b.people.find((p) => p.name === name)!

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
  // The board is one column per member, so the fixture needs more than the owner.
  // /api/persons doesn't create logins, so seed the people directly (as
  // chores.integration.test.ts does).
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

describe('planning · tasks · gating', () => {
  it('403s while the weeklyPlanning module is off', async () => {
    expect((await call('GET', '/api/weekly-planning/tasks', kevin)).statusCode).toBe(403)
  })

  it('403s when chores — the module this step reads — is off', async () => {
    expect((await call('PATCH', '/api/household/modules', kevin, { weeklyPlanning: true })).statusCode).toBe(200)
    await call('PATCH', '/api/household/modules', kevin, { chores: false })
    expect((await call('GET', '/api/weekly-planning/tasks', kevin)).statusCode).toBe(403)
    await call('PATCH', '/api/household/modules', kevin, { chores: true })
    expect((await call('GET', '/api/weekly-planning/tasks', kevin)).statusCode).toBe(200)
  })
})

describe('planning · tasks · the board', () => {
  it('gives every member a column and states the recurring load they already carry', async () => {
    // Wally already carries two standing chores; Lottie one; Kevin none.
    await call('POST', '/api/chores', kevin, { title: 'Feed the dog', personId: wallyId, rrule: 'FREQ=DAILY' })
    await call('POST', '/api/chores', kevin, { title: 'Trash out', personId: wallyId, rrule: 'FREQ=WEEKLY;BYDAY=TU' })
    await call('POST', '/api/chores', kevin, { title: 'Water plants', personId: lottieId, rrule: 'FREQ=WEEKLY;BYDAY=SA' })
    // A one-off is not a standing commitment, so it must not inflate the footer.
    await call('POST', '/api/chores', kevin, { title: 'Post the letter', personId: lottieId, rrule: null })

    const b = await board()
    expect(b.people.map((p) => p.name)).toEqual(['Kevin', 'Wally', 'Lottie'])
    expect(who(b, 'Wally').recurringChores).toBe(2)
    expect(who(b, 'Lottie').recurringChores).toBe(1)
    expect(who(b, 'Kevin').recurringChores).toBe(0)
  })

  it('puts everything unassigned in the strip, with the cadence it repeats on', async () => {
    await call('POST', '/api/chores', kevin, { title: 'Sweep the porch', personId: null, rrule: 'FREQ=WEEKLY;BYDAY=SU' })
    await call('POST', '/api/chores', kevin, { title: 'Fold the towels', personId: null, rrule: 'FREQ=DAILY' })

    const b = await board()
    expect(strip(b)).toEqual(expect.arrayContaining(['Sweep the porch', 'Fold the towels']))
    expect(b.unassigned.find((c) => c.title === 'Sweep the porch')!.cadence).toBe('weekly')
    expect(b.unassigned.find((c) => c.title === 'Fold the towels')!.cadence).toBe('daily')
    // A chore that already has someone is never in the strip.
    expect(strip(b)).not.toContain('Feed the dog')
  })

  it('tapping a face assigns the chore — it leaves the strip and joins that column', async () => {
    const before = await board()
    const chore = before.unassigned.find((c) => c.title === 'Sweep the porch')!

    // The write is the existing chores endpoint; this step adds none of its own.
    expect((await call('PATCH', `/api/chores/${chore.id}`, kevin, { personId: lottieId })).statusCode).toBe(200)

    const after = await board()
    expect(strip(after)).not.toContain('Sweep the porch')
    // Lottie's footer grows by the one she just took on.
    expect(who(after, 'Lottie').recurringChores).toBe(who(before, 'Lottie').recurringChores + 1)
  })

  it('nobody is a real answer — the untaken chore survives the pass that assigned the other', async () => {
    // The previous test handed 'Sweep the porch' to Lottie in the same sitting; the
    // one nobody took has to come back unchanged rather than being swept up with it.
    const b = await board()
    expect(strip(b)).not.toContain('Sweep the porch')
    expect(strip(b)).toContain('Fold the towels')
    // Still genuinely unowned — no column absorbed it.
    const { query } = await import('../src/platform/db')
    const { rows } = await query<{ person_id: string | null }>(
      `select person_id from chores where household_id = $1 and title = 'Fold the towels'`,
      [householdId]
    )
    expect(rows[0].person_id).toBe(null)
  })
})

describe('planning · tasks · one-offs already on the kiosk board', () => {
  it('surfaces the pending instance so assigning also fixes the day it already landed on', async () => {
    // A one-off materializes its single instance at create time, snapshotting
    // person_id — so PATCHing only the definition would leave today's kiosk board
    // still showing it up for grabs. The read hands back that instance id.
    const created = await call('POST', '/api/chores', kevin, { title: 'Return the library books', personId: null, rrule: null })
    expect(created.statusCode).toBe(201)
    const choreId = json(created).chore.id

    const b = await board()
    const row = b.unassigned.find((c) => c.title === 'Return the library books')!
    expect(row.cadence).toBe('once')
    expect(row.pendingInstanceIds).toEqual([expect.any(String)])

    // Both writes are existing chores endpoints.
    await call('PATCH', `/api/chores/${choreId}`, kevin, { personId: wallyId })
    expect((await call('POST', `/api/chore-instances/${row.pendingInstanceIds[0]}/assign`, kevin, { personId: wallyId })).statusCode).toBe(200)

    // The kiosk Chores board — the same layout this step mirrors — now shows it
    // under Wally rather than up for grabs.
    const day = json(await call('GET', '/api/chore-instances/today', kevin))
    const inst = day.instances.find((i: { choreTitle: string }) => i.choreTitle === 'Return the library books')
    expect(inst.personId).toBe(wallyId)
    expect(strip(await board())).not.toContain('Return the library books')
  })

  it('hands back EVERY unclaimed day, not just the first', async () => {
    // A recurring chore can already be sitting on several days: anyone who opened the
    // kiosk board on Monday and again on Tuesday materialized both. Assigning only the
    // earliest would leave the rest up for grabs there while this board shows an owner.
    const created = await call('POST', '/api/chores', kevin, { title: 'Wipe the counters', personId: null, rrule: 'FREQ=DAILY' })
    const choreId = json(created).chore.id
    const soon = (n: number) => {
      const d = new Date()
      d.setUTCDate(d.getUTCDate() + n)
      return d.toISOString().slice(0, 10)
    }
    // Two different days of the board — two materialized, unclaimed instances.
    await call('GET', `/api/chore-instances/today?date=${soon(1)}`, kevin)
    await call('GET', `/api/chore-instances/today?date=${soon(2)}`, kevin)

    const row = (await board()).unassigned.find((c) => c.title === 'Wipe the counters')!
    expect(row.pendingInstanceIds.length).toBeGreaterThanOrEqual(2)

    await call('PATCH', `/api/chores/${choreId}`, kevin, { personId: lottieId })
    for (const id of row.pendingInstanceIds) {
      expect((await call('POST', `/api/chore-instances/${id}/assign`, kevin, { personId: lottieId })).statusCode).toBe(200)
    }

    // Both days now read as Lottie's on the kiosk board, not just the first.
    for (const d of [soon(1), soon(2)]) {
      const day = json(await call('GET', `/api/chore-instances/today?date=${d}`, kevin))
      expect(day.instances.find((i: { choreTitle: string }) => i.choreTitle === 'Wipe the counters').personId).toBe(lottieId)
    }
  })

  it('does the same for a recurring chore whose instance for today already exists', async () => {
    // Anyone opening the kiosk board today materialized today's instances, unassigned
    // ones included — so a recurring chore can have one waiting too. Handing it out
    // fixes today as well as every day after (the definition covers those).
    const b = await board()
    const towels = b.unassigned.find((c) => c.title === 'Fold the towels')!
    expect(towels.cadence).toBe('daily')
    expect(towels.pendingInstanceIds.length).toBeGreaterThan(0)

    await call('PATCH', `/api/chores/${towels.id}`, kevin, { personId: ownerId })
    await call('POST', `/api/chore-instances/${towels.pendingInstanceIds[0]}/assign`, kevin, { personId: ownerId })

    const day = json(await call('GET', '/api/chore-instances/today', kevin))
    expect(day.instances.find((i: { choreTitle: string }) => i.choreTitle === 'Fold the towels').personId).toBe(ownerId)
    const after = await board()
    expect(strip(after)).not.toContain('Fold the towels')
    expect(who(after, 'Kevin').recurringChores).toBe(1)
  })
})

// A column is what someone is CARRYING for the week — drawn from the chores they own,
// not from whatever this sitting happened to move. That's the difference that makes the
// board survive a refresh, and it's what these cover.
describe('planning · tasks · the week each person is carrying', () => {
  let weekStart: string
  // Nth day of the planned week (0 = the week start), as a plain UTC date.
  const day = (n: number) => {
    const d = new Date(`${weekStart}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + n)
    return d.toISOString().slice(0, 10)
  }
  const held = (b: { people: BoardPerson[] }, name: string) => who(b, name).chores

  it('names the week it resolved, and snaps a mid-week date to that week’s start', async () => {
    const b = await board()
    weekStart = b.weekStart
    expect(weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // The server owns the boundary: naming the Wednesday of a week must not key the
    // board to a Wednesday (the grocery/meal-planner lesson).
    const mid = json(await call('GET', `/api/weekly-planning/tasks?weekStart=${day(3)}`, kevin))
    expect(mid.weekStart).toBe(weekStart)
  })

  it('fills a column from what that person holds, with the days each chore lands on', async () => {
    // A standing chore on one weekday, a daily one, and a one-off inside the week.
    await call('POST', '/api/chores', kevin, { title: 'Vacuum upstairs', personId: lottieId, rrule: `FREQ=WEEKLY;BYDAY=${['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][new Date(`${day(3)}T00:00:00Z`).getUTCDay()]}` })
    await call('POST', '/api/chores', kevin, { title: 'Dishes', personId: lottieId, rrule: 'FREQ=DAILY' })
    await call('POST', '/api/chores', kevin, { title: 'Gift for the party', personId: lottieId, rrule: null, dueOn: day(5) })

    const mine = held(await board(), 'Lottie')
    const titles = mine.map((c) => c.title)
    expect(titles).toEqual(expect.arrayContaining(['Vacuum upstairs', 'Dishes', 'Gift for the party']))
    // The day chip's data: one weekday, every day, and the one-off's own date.
    expect(mine.find((c) => c.title === 'Vacuum upstairs')!.days).toEqual([day(3)])
    expect(mine.find((c) => c.title === 'Dishes')!.days).toHaveLength(7)
    expect(mine.find((c) => c.title === 'Gift for the party')!.days).toEqual([day(5)])
    // The header count is what they're holding this week.
    expect(mine.length).toBe(titles.length)
  })

  it('leaves out a one-off that belongs to a different week', async () => {
    await call('POST', '/api/chores', kevin, { title: 'Renew the passport', personId: lottieId, rrule: null, dueOn: day(30) })
    expect(held(await board(), 'Lottie').map((c) => c.title)).not.toContain('Renew the passport')
    // …and it is genuinely on a later week's board, not lost. (Assert the week we got
    // back really is the later one — otherwise this could pass by reading the default.)
    const later = json(await call('GET', `/api/weekly-planning/tasks?weekStart=${day(28)}`, kevin))
    expect(later.weekStart).toBe(day(28))
    const lottie = later.people.find((p: BoardPerson) => p.name === 'Lottie')
    expect(lottie.chores.map((c: BoardChore) => c.title)).toContain('Renew the passport')
  })

  it('the column is the week, not the sitting — a fresh read shows what was handed out', async () => {
    const created = await call('POST', '/api/chores', kevin, { title: 'Garage sweep', personId: null, rrule: null, dueOn: day(2) })
    const choreId = json(created).chore.id
    expect(strip(await board())).toContain('Garage sweep')

    await call('PATCH', `/api/chores/${choreId}`, kevin, { personId: wallyId })

    // A brand-new request — nothing carried over from the one that assigned it.
    const fresh = await board()
    const wally = held(fresh, 'Wally').find((c) => c.title === 'Garage sweep')!
    expect(wally.days).toEqual([day(2)])
    expect(strip(fresh)).not.toContain('Garage sweep')
  })

  it('a chore carried over from before the week arrives without a day of its own', async () => {
    const { query } = await import('../src/platform/db')
    const created = await call('POST', '/api/chores', kevin, { title: 'Fix the gate', personId: wallyId, rrule: null, dueOn: day(0) })
    // Backdate its single instance to before the week — a rollover one-off still open.
    await query(`update chore_instances set due_on = $2::date where chore_id = $1`, [json(created).chore.id, day(-6)])

    const gate = held(await board(), 'Wally').find((c) => c.title === 'Fix the gate')!
    expect(gate.carriedOver).toBe(true)
    expect(gate.days).toEqual([])
  })
})

describe('planning · tasks · the step decision', () => {
  it('records counts, not a copy of the chores it handed out', async () => {
    const start = await call('POST', '/api/weekly-planning/session', kevin, {})
    const sessionId = json(start).session.id
    const res = await call('POST', `/api/weekly-planning/session/${sessionId}/step`, kevin, {
      stepKey: 'tasks',
      status: 'done',
      data: { assigned: 2, leftUpForGrabs: 1 },
    })
    expect(res.statusCode).toBe(200)
    const step = json(res).steps.find((s: { key: string }) => s.key === 'tasks')
    expect(step.status).toBe('done')
    expect(step.data).toEqual({ assigned: 2, leftUpForGrabs: 1 })
  })
})
