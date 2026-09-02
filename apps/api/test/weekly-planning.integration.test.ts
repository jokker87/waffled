// Weekly Planning — the module shell: gating, the server-owned step catalog, config,
// and the session record (start/resume, per-step decisions, completion), against a real
// Postgres (Testcontainers). The ten steps' own content lands one commit at a time; this
// file covers the chrome they all hang off.
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

function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'waffled-local', audience: 'waffled-api', expiresIn: '1h' })
}

function call(method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  return app.run(
    { httpMethod: method, path, headers, queryStringParameters: {}, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false },
    {}
  ) as Promise<{ statusCode: number; body: string }>
}

const kevin = mint('dev|kevin')
const json = (r: { body: string }) => JSON.parse(r.body)

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
  const ownerId = json(setup).person.id
  const { query } = await import('../src/platform/db')
  await query(
    `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|kevin',true)`,
    [householdId, ownerId]
  )
})

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('weekly planning · module gate', () => {
  it('is gated off by default (403)', async () => {
    expect((await call('GET', '/api/weekly-planning', kevin)).statusCode).toBe(403)
  })

  it('enables the module', async () => {
    expect((await call('PATCH', '/api/household/modules', kevin, { weeklyPlanning: true })).statusCode).toBe(200)
    expect((await call('GET', '/api/weekly-planning', kevin)).statusCode).toBe(200)
  })
})

describe('weekly planning · the step catalog', () => {
  it('serves the ten steps in order, each with its act and the question it asks', async () => {
    const view = json(await call('GET', '/api/weekly-planning', kevin))
    expect(view.steps.map((s: { key: string }) => s.key)).toEqual([
      'looseEnds', 'calendar', 'horizon', 'familyNight', 'connection', 'goals', 'meals', 'tasks', 'kids', 'recap',
    ])
    const calendar = view.steps.find((s: { key: string }) => s.key === 'calendar')
    // The question is server-owned so web and iOS can't drift on it.
    expect(calendar).toMatchObject({ number: 2, title: 'Calendar', act: 'Frame the week' })
    expect(typeof calendar.ask).toBe('string')
    expect(calendar.ask.length).toBeGreaterThan(0)
  })

  it('marks a step unavailable when the module it reads is off', async () => {
    // familyNight is defaultOn:false, so step 4 has nothing to show.
    const view = json(await call('GET', '/api/weekly-planning', kevin))
    const fn = view.steps.find((s: { key: string }) => s.key === 'familyNight')
    expect(fn.requiresModule).toBe('familyNight')
    expect(fn.available).toBe(false)
    // …and one with no module requirement is always available.
    expect(view.steps.find((s: { key: string }) => s.key === 'calendar').available).toBe(true)
  })

  it('lets a household turn an available step off by hand', async () => {
    await call('PUT', '/api/weekly-planning/config', kevin, { steps: { horizon: false } })
    const view = json(await call('GET', '/api/weekly-planning', kevin))
    expect(view.steps.find((s: { key: string }) => s.key === 'horizon').available).toBe(false)
    await call('PUT', '/api/weekly-planning/config', kevin, { steps: { horizon: true } })
    const back = json(await call('GET', '/api/weekly-planning', kevin))
    expect(back.steps.find((s: { key: string }) => s.key === 'horizon').available).toBe(true)
  })
})

describe('weekly planning · config', () => {
  it('defaults to a Sunday session and round-trips a change', async () => {
    const view = json(await call('GET', '/api/weekly-planning', kevin))
    expect(view.config.dayOfWeek).toBe(0)
    expect(view.config.time).toMatch(/^\d{2}:\d{2}$/)

    const put = await call('PUT', '/api/weekly-planning/config', kevin, { dayOfWeek: 4, time: '18:30' })
    expect(put.statusCode).toBe(200)
    expect(json(put).config).toMatchObject({ dayOfWeek: 4, time: '18:30' })

    // Persisted, and other settings keys survive the merge.
    const after = json(await call('GET', '/api/weekly-planning', kevin))
    expect(after.config).toMatchObject({ dayOfWeek: 4, time: '18:30' })
    const mods = json(await call('GET', '/api/household', kevin))
    expect(mods.household.settings.modules.weeklyPlanning).toBe(true)

    await call('PUT', '/api/weekly-planning/config', kevin, { dayOfWeek: 0, time: '17:00' })
  })

  it('rejects a nonsense time', async () => {
    const before = json(await call('GET', '/api/weekly-planning', kevin)).config.time
    await call('PUT', '/api/weekly-planning/config', kevin, { time: 'half seven' })
    expect(json(await call('GET', '/api/weekly-planning', kevin)).config.time).toBe(before)
  })
})

describe('weekly planning · the session record', () => {
  let sessionId: string

  it('has no session before one is started', async () => {
    expect(json(await call('GET', '/api/weekly-planning', kevin)).session).toBe(null)
  })

  it('starts a session on the week the SERVER decides, at the first available step', async () => {
    const res = await call('POST', '/api/weekly-planning/session', kevin)
    expect(res.statusCode).toBe(200)
    const s = json(res).session
    sessionId = s.id
    expect(s.status).toBe('active')
    expect(s.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // A session plans a week that hasn't finished yet, and never a past one.
    const todayish = new Date().toISOString().slice(0, 10)
    expect(s.weekStart >= todayish || todayish <= new Date(new Date(s.weekStart + 'T00:00:00Z').getTime() + 6 * 864e5).toISOString().slice(0, 10)).toBe(true)
    expect(s.currentStep).toBe('looseEnds')
    // Single driver now; the seam for multi-device later.
    expect(s.driverPersonId).toBeTruthy()
  })

  it('resumes rather than starting a second session for the same week', async () => {
    const again = json(await call('POST', '/api/weekly-planning/session', kevin)).session
    expect(again.id).toBe(sessionId)
    expect(again.status).toBe('active')
  })

  it('records a step as decided, with the data that has no other home', async () => {
    const res = await call('POST', `/api/weekly-planning/session/${sessionId}/step`, kevin, {
      stepKey: 'calendar', status: 'done', data: { added: 1 },
    })
    expect(res.statusCode).toBe(200)
    const view = json(await call('GET', '/api/weekly-planning', kevin))
    const cal = view.steps.find((s: { key: string }) => s.key === 'calendar')
    expect(cal.status).toBe('done')
    expect(cal.data).toEqual({ added: 1 })
    expect(cal.decidedAt).toBeTruthy()
  })

  it('records a skip as its own answer, and re-deciding a step overwrites it', async () => {
    await call('POST', `/api/weekly-planning/session/${sessionId}/step`, kevin, { stepKey: 'goals', status: 'skipped' })
    let view = json(await call('GET', '/api/weekly-planning', kevin))
    expect(view.steps.find((s: { key: string }) => s.key === 'goals').status).toBe('skipped')

    await call('POST', `/api/weekly-planning/session/${sessionId}/step`, kevin, { stepKey: 'goals', status: 'done' })
    view = json(await call('GET', '/api/weekly-planning', kevin))
    expect(view.steps.find((s: { key: string }) => s.key === 'goals').status).toBe('done')
  })

  it('refuses a step key that is not in the catalog', async () => {
    const res = await call('POST', `/api/weekly-planning/session/${sessionId}/step`, kevin, { stepKey: 'lobby', status: 'done' })
    expect(res.statusCode).toBe(400)
  })

  it('moves the driver between steps', async () => {
    const res = await call('PATCH', `/api/weekly-planning/session/${sessionId}`, kevin, { currentStep: 'meals' })
    expect(res.statusCode).toBe(200)
    expect(json(await call('GET', '/api/weekly-planning', kevin)).session.currentStep).toBe('meals')
  })

  it('completes with a timestamp, and reopening is a real answer', async () => {
    const done = await call('POST', `/api/weekly-planning/session/${sessionId}/complete`, kevin)
    expect(done.statusCode).toBe(200)
    let view = json(await call('GET', '/api/weekly-planning', kevin))
    expect(view.session.status).toBe('completed')
    expect(view.session.completedAt).toBeTruthy()
    // Decisions survive completion — the recap is a pointer, not a copy.
    expect(view.steps.find((s: { key: string }) => s.key === 'calendar').status).toBe('done')

    // Starting again on the same week hands back the finished record rather than a
    // second one; reopening is an explicit act.
    expect(json(await call('POST', '/api/weekly-planning/session', kevin)).session.id).toBe(sessionId)
    await call('PATCH', `/api/weekly-planning/session/${sessionId}`, kevin, { status: 'active' })
    view = json(await call('GET', '/api/weekly-planning', kevin))
    expect(view.session.status).toBe('active')
    expect(view.session.completedAt).toBe(null)
  })

  it('goes back behind the gate when the module is turned off', async () => {
    await call('PATCH', '/api/household/modules', kevin, { weeklyPlanning: false })
    expect((await call('GET', '/api/weekly-planning', kevin)).statusCode).toBe(403)
    await call('PATCH', '/api/household/modules', kevin, { weeklyPlanning: true })
  })
})
