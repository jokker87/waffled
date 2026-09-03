// Weekly Planning · step 3 · Horizon scan — against a real Postgres (Testcontainers).
//
// The step is the month view the household already has, plus one bar. So almost
// everything it renders comes off endpoints that already exist and are already tested
// elsewhere: the 42-cell grid is `GET /api/events?from&to` over the month grid window,
// the ＋ on a day is the app's own event modal (`POST /api/events`), and parking a note
// is step 1's `POST /api/weekly-planning/loose-ends/parked` — general on purpose, and
// its own header says step 3 writes through it.
//
// What is NEW here, and so what this file drives out:
//
//   · `GET /api/weekly-planning/horizon` — the two things the step cannot derive for
//     itself. WHICH TAGS a note may carry (only steps this household actually runs, the
//     same rule step 1 applies to its destinations, because a tag pointing at a step the
//     session skips over addresses the note to nobody), and WHAT THIS SESSION HAS
//     PARKED so far — because `setDecisionData` is not storage, so a step that must
//     still be true on a second visit has to read it back from the table that owns it.
//
//   · THE CENTRAL CLAIM OF THE STEP: a parked note is not an event. The mock says it
//     twice ("a note, not a calendar entry", "＋ on a day adds a real event · the bar
//     below parks a note that isn't an event yet"), so it is asserted here rather than
//     left as prose: parking writes a row to planning_parked_items and NOTHING to the
//     calendar.
//
//   · The tag is the DESTINATION step ('tasks' → "it turns up at step 8 for an owner and
//     a day"), which is exactly the shape step 1 writes when somebody routes a note, so
//     the two producers leave rows a later consumer cannot tell apart. See the note on
//     `HORIZON_TAGS` in horizon.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
let ownerId: string
let sessionId: string

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

const horizon = (session?: string) =>
  call('GET', `/api/weekly-planning/horizon${session ? `?sessionId=${session}` : ''}`, kevin)

const park = (body: Record<string, unknown>) =>
  call('POST', '/api/weekly-planning/loose-ends/parked', kevin, body)

// Pure date arithmetic on a YYYY-MM-DD — UTC on purpose, because nothing here is
// rendered; it only ever adds days.
const addDays = (iso: string, n: number): string =>
  new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10)

// The household is America/Chicago; spelling the offset out keeps a fixture on the day
// it says it is on however the test machine is set.
const at = (day: string, time: string) => `${day}T${time}:00-05:00`

interface Tag { stepKey: string; label: string; hint: string; primary?: boolean }
interface Note { id: string; note: string; stepKey: string | null; stepLabel: string | null; createdAt: string }

const keys = (tags: Tag[]) => tags.map((t) => t.stepKey)
const notes = (list: Note[]) => list.map((n) => n.note)

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
  const householdId = json(setup).household.id
  ownerId = json(setup).person.id
  const { query } = await import('../src/platform/db')
  await query(
    `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|kevin',true)`,
    [householdId, ownerId]
  )
  // Weekly Planning is off by default; step 3 lives behind it. The tag list is filtered
  // by the OTHER modules, so they start on and individual tests turn one off.
  await setModules({ weeklyPlanning: true, chores: true, meals: true })
  await call('PATCH', `/api/persons/${ownerId}`, kevin, { colorHex: '#2F7FED' })
  sessionId = json(await call('POST', '/api/weekly-planning/session', kevin)).session.id
})

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('weekly planning · step 3 · horizon', () => {
  it('is a step of the session, and needs no module of its own', async () => {
    const view = json(await call('GET', '/api/weekly-planning', kevin))
    const step = view.steps.find((s: { key: string }) => s.key === 'horizon')
    // The month is not an optional module — every household has a calendar — so unlike
    // meals/goals/chores this step is never skipped over for want of one.
    expect(step).toMatchObject({ number: 3, act: 'Frame the week', available: true })
    expect(step.requiresModule).toBeUndefined()
  })

  it('is behind the weeklyPlanning toggle like the rest of the module', async () => {
    // Turn it back on BEFORE asserting: a failed expect throws, and a toggle left off
    // here would fail every test after this one for the wrong reason.
    await setModules({ weeklyPlanning: false })
    const off = await horizon(sessionId)
    await setModules({ weeklyPlanning: true })
    expect(off.statusCode).toBe(403)
    expect((await horizon(sessionId)).statusCode).toBe(200)
  })
})

describe('horizon · the tags a note can carry', () => {
  it('offers the destination steps, in the order the bar shows them', async () => {
    const view = json(await horizon(sessionId))
    // Tasks / Meals / Calendar — "No tag" is the ABSENCE of one and so is never a row
    // here; it is the client rendering `stepKey: null`.
    expect(keys(view.tags)).toEqual(['tasks', 'meals', 'calendar'])
    expect(view.tags.every((t: Tag) => t.label && t.hint)).toBe(true)
    // The label is the catalog's own title for that step, so the bar and the agenda
    // sheet can never call the same step two different things.
    expect(view.tags.find((t: Tag) => t.stepKey === 'tasks')!.label).toBe('Tasks')
    // Exactly one primary — the one the bar opens on. Tasks, for the same reason step 1's
    // `DESTINATIONS.parked` marks it primary: most of what a month provokes is something
    // somebody has to DO before the date arrives.
    expect(view.tags.filter((t: Tag) => t.primary).map((t: Tag) => t.stepKey)).toEqual(['tasks'])
  })

  it('drops a tag whose step this household does not run', async () => {
    // A tag naming a step the session skips over addresses the note to nobody — the
    // same rule step 1 applies to its routing destinations.
    await setModules({ meals: false })
    expect(keys(json(await horizon(sessionId)).tags)).toEqual(['tasks', 'calendar'])
    await setModules({ chores: false })
    const noTasks = json(await horizon(sessionId)).tags
    expect(keys(noTasks)).toEqual(['calendar'])
    // …and with Tasks gone there is no primary to fall back on, so the bar opens on no
    // tag rather than on whatever happens to be first.
    expect(noTasks.filter((t: Tag) => t.primary)).toEqual([])
    await setModules({ meals: true, chores: true })
    expect(keys(json(await horizon(sessionId)).tags)).toEqual(['tasks', 'meals', 'calendar'])
  })
})

describe('horizon · parking a note', () => {
  it('parks with a destination tag, and reads back on the step with that step’s name', async () => {
    const res = await park({ note: 'Camping — we need to pack', stepKey: 'tasks', sessionId })
    expect(res.statusCode).toBe(200)

    const view = json(await horizon(sessionId))
    const parked: Note[] = view.parked
    const mine = parked.find((n) => n.note === 'Camping — we need to pack')!
    expect(mine).toBeTruthy()
    // 'tasks', not 'horizon': the tag names the step that will LOOK at the note ("it
    // turns up at step 8 for an owner and a day"), which is the same thing step 1
    // writes when somebody routes a note there.
    expect(mine.stepKey).toBe('tasks')
    expect(mine.stepLabel).toBe('Tasks')
  })

  it('is NOT a calendar entry — the month is untouched', async () => {
    // The whole distinction the step draws: ＋ on a day writes an event, the bar does
    // not. Read a wide window so a note landing anywhere in the month would show up.
    const from = json(await call('GET', '/api/weekly-planning', kevin)).weekStart
    const window = `from=${addDays(from, -35)}&to=${addDays(from, 35)}`
    const before = json(await call('GET', `/api/events?${window}`, kevin)).events.length

    await park({ note: 'Two nights away — sort the sleeping bags', stepKey: 'tasks', sessionId })

    const after = json(await call('GET', `/api/events?${window}`, kevin)).events
    expect(after.length).toBe(before)
    expect(after.map((e: { title: string }) => e.title)).not.toContain('Two nights away — sort the sleeping bags')
  })

  it('accepts "No tag" — an untagged note is a whole answer', async () => {
    const res = await park({ note: 'Something is coming and we don’t know what', sessionId })
    expect(res.statusCode).toBe(200)
    const mine = (json(await horizon(sessionId)).parked as Note[]).find(
      (n) => n.note === 'Something is coming and we don’t know what'
    )!
    expect(mine.stepKey).toBeNull()
    expect(mine.stepLabel).toBeNull()
  })

  it('refuses a tag that is not a step', async () => {
    // Validated in the service against the server-owned catalog (there is deliberately
    // no check constraint), so a typo can't create a tag nothing will ever match.
    expect((await park({ note: 'x', stepKey: 'holidays', sessionId })).statusCode).toBe(400)
  })

  it('lists only what THIS session parked, oldest first', async () => {
    // `setDecisionData` is not storage: the list has to survive leaving the step and
    // coming back, and it must not swell with every note the household ever wrote.
    const other = json(
      await call('POST', '/api/weekly-planning/session', kevin, {
        weekStart: addDays(json(await call('GET', '/api/weekly-planning', kevin)).weekStart, 28),
      })
    ).session.id
    await park({ note: 'Parked in another session', stepKey: 'tasks', sessionId: other })
    await park({ note: 'Parked outside any session' })

    const mine = notes(json(await horizon(sessionId)).parked)
    expect(mine).not.toContain('Parked in another session')
    expect(mine).not.toContain('Parked outside any session')
    // Chronological — the order they were written, which is what step 1's own read uses.
    expect(mine.indexOf('Camping — we need to pack')).toBeLessThan(
      mine.indexOf('Two nights away — sort the sleeping bags')
    )

    // And the other session's own read sees only its own.
    expect(notes(json(await horizon(other)).parked)).toEqual(['Parked in another session'])
  })

  it('answers with an empty board when no session is named', async () => {
    const view = json(await horizon())
    expect(view.parked).toEqual([])
    // The tags still come back: the bar is renderable before a session exists.
    expect(keys(view.tags)).toEqual(['tasks', 'meals', 'calendar'])
  })

  it('drops a note off the board once step 1 settles it', async () => {
    // The board is the OPEN notes. One dropped in a later step-1 pass has been answered
    // and should stop coming back as something still to think about.
    const id = json(await park({ note: 'It was never really a thing', sessionId })).item.id
    expect(notes(json(await horizon(sessionId)).parked)).toContain('It was never really a thing')
    expect(
      (await call('POST', '/api/weekly-planning/loose-ends/resolve', kevin, { kind: 'parked', id, action: 'drop' })).statusCode
    ).toBe(200)
    expect(notes(json(await horizon(sessionId)).parked)).not.toContain('It was never really a thing')
  })

  it('the month it scans is the real calendar — events on it are the ordinary read', async () => {
    // Not a horizon endpoint: the grid is `GET /api/events` over the 42-cell window, so
    // an event added through the app's own modal is on the step the moment it exists.
    const weekStart = json(await call('GET', '/api/weekly-planning', kevin)).weekStart
    const day = addDays(weekStart, 13)
    expect(
      (await call('POST', '/api/events', kevin, { title: 'Scout campout', startsAt: at(day, '09:00'), participantIds: [ownerId] })).statusCode
    ).toBe(201)
    const events = json(await call('GET', `/api/events?from=${weekStart}&to=${addDays(weekStart, 27)}`, kevin)).events
    expect(events.map((e: { title: string }) => e.title)).toContain('Scout campout')
  })
})
