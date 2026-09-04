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

// lambda-api reads the query off `queryStringParameters`, NOT off the path — a `?x=y`
// left in `path` is silently invisible to the handler. Split it here, as
// chores/meals.integration.test.ts do.
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

  it('goes back behind the gate when the module is turned off (and back)', async () => {
    await call('PATCH', '/api/household/modules', kevin, { weeklyPlanning: false })
    expect((await call('GET', '/api/weekly-planning', kevin)).statusCode).toBe(403)
    await call('PATCH', '/api/household/modules', kevin, { weeklyPlanning: true })
  })
})

// Starting a session must not be a one-way door: a week started by mistake, or one the
// family wants to run again from the top, has to be discardable.
describe('weekly planning · starting over', () => {
  it('discards the session and its decisions, putting the week back to its lobby', async () => {
    const s = json(await call('POST', '/api/weekly-planning/session', kevin)).session
    await call('POST', `/api/weekly-planning/session/${s.id}/step`, kevin, { stepKey: 'calendar', status: 'done' })
    expect(json(await call('GET', '/api/weekly-planning', kevin)).steps.find((x: { key: string }) => x.key === 'calendar').status).toBe('done')

    expect((await call('DELETE', `/api/weekly-planning/session/${s.id}`, kevin)).statusCode).toBe(200)

    const after = json(await call('GET', '/api/weekly-planning', kevin))
    expect(after.session).toBe(null)
    // The step decisions went with it — nothing is left claiming the week was decided.
    expect(after.steps.every((x: { status: string }) => x.status === 'pending')).toBe(true)

    // …and starting again is a genuinely fresh session, not the old one resurrected.
    const again = json(await call('POST', '/api/weekly-planning/session', kevin)).session
    expect(again.id).not.toBe(s.id)
    expect(again.status).toBe('active')
  })

  it('404s on a session that is not this household’s', async () => {
    expect((await call('DELETE', '/api/weekly-planning/session/11111111-1111-1111-1111-111111111111', kevin)).statusCode).toBe(404)
  })
})

// Planning further than one week out. The default is the week ahead, but a family that
// wants to get in front of a trip must be able to say so — and the SERVER still owns
// which seven days any given week key means.
describe('weekly planning · planning a week other than the default', () => {
  const addDays = (iso: string, n: number) => {
    const d = new Date(`${iso}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + n)
    return d.toISOString().slice(0, 10)
  }

  it('says which week it defaults to, and the earliest one it will plan', async () => {
    const view = json(await call('GET', '/api/weekly-planning', kevin))
    expect(view.defaultWeekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(view.minWeekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // The floor is the household's CURRENT week — a session never plans a week that has
    // already finished — and the default is that week or a later one.
    expect(view.defaultWeekStart >= view.minWeekStart).toBe(true)
    expect(view.weekStart).toBe(view.defaultWeekStart)
  })

  it('serves a later week when asked, and keeps its session separate', async () => {
    const base = json(await call('GET', '/api/weekly-planning', kevin))
    const later = addDays(base.defaultWeekStart, 14)

    const view = json(await call('GET', `/api/weekly-planning?weekStart=${later}`, kevin))
    expect(view.weekStart).toBe(later)
    // A week nobody has planned yet has no session, even though the default week does.
    expect(view.session).toBe(null)

    const started = json(await call('POST', '/api/weekly-planning/session', kevin, { weekStart: later })).session
    expect(started.weekStart).toBe(later)

    // …and it did not disturb the default week's session.
    const dflt = json(await call('GET', '/api/weekly-planning', kevin))
    expect(dflt.session.id).not.toBe(started.id)
    expect(dflt.weekStart).toBe(base.defaultWeekStart)

    // Decisions are per-week, not per-household.
    await call('POST', `/api/weekly-planning/session/${started.id}/step`, kevin, { stepKey: 'meals', status: 'done' })
    const laterAgain = json(await call('GET', `/api/weekly-planning?weekStart=${later}`, kevin))
    expect(laterAgain.steps.find((s: { key: string }) => s.key === 'meals').status).toBe('done')
    // The default week's own meals answer is untouched.
    expect(json(await call('GET', '/api/weekly-planning', kevin)).steps.find((s: { key: string }) => s.key === 'meals').status).toBe('pending')
  })

  it('snaps a mid-week date to that week rather than keying rows nothing will read', async () => {
    const base = json(await call('GET', '/api/weekly-planning', kevin))
    const midweek = addDays(base.defaultWeekStart, 3)
    const view = json(await call('GET', `/api/weekly-planning?weekStart=${midweek}`, kevin))
    expect(view.weekStart).toBe(base.defaultWeekStart)
  })

  it('refuses to plan the past — a week before the floor clamps to it', async () => {
    const base = json(await call('GET', '/api/weekly-planning', kevin))
    const longAgo = addDays(base.minWeekStart, -35)
    expect(json(await call('GET', `/api/weekly-planning?weekStart=${longAgo}`, kevin)).weekStart).toBe(base.minWeekStart)
    expect(json(await call('POST', '/api/weekly-planning/session', kevin, { weekStart: longAgo })).session.weekStart).toBe(base.minWeekStart)
  })

  it('falls back to the default week when the parameter is nonsense', async () => {
    const base = json(await call('GET', '/api/weekly-planning', kevin))
    for (const bad of ['not-a-date', '2026-13-45', '']) {
      const view = json(await call('GET', `/api/weekly-planning?weekStart=${bad}`, kevin))
      expect(view.weekStart).toBe(base.defaultWeekStart)
    }
  })
})

describe('planning · a parked note reaches the step it was tagged for', () => {
  // "I added a bunch to the park it thing, expecting to go over them in the appropriate
  // step but I never saw them again, where did they go?"
  //
  // They went into `planning_parked_items` with a `step_key`, and nothing ever read it.
  // The column is a DESTINATION — "which step is going to look at this" — written both by
  // step 1's triage and by step 3's park bar. But only three steps ever read the table:
  // step 1 (its own board), step 3 (what this session parked) and step 10 (the last
  // call). Tag a note for Meals, Tasks, Calendar, Goals, Family night or Connection and
  // that step never mentioned it — so a note tagged in one step vanished until the recap.
  //
  // The handoff belongs on the SESSION VIEW rather than in each step: it is the same
  // banner for all of them, the shell already refetches this read after every write, and
  // a step's own affordances are what actually act on the note. One implementation, ten
  // steps, and nothing for the iOS pass to build ten times.
  it('hands a tagged note to its destination step, and only to that step', async () => {
    const s = json(await call('POST', '/api/weekly-planning/session', kevin)).session
    const park = async (note: string, stepKey?: string) =>
      call('POST', '/api/weekly-planning/loose-ends/parked', kevin, { note, sessionId: s.id, ...(stepKey ? { stepKey } : {}) })

    expect((await park('buy poster board', 'tasks')).statusCode).toBe(200)
    expect((await park('no meal on friday', 'meals')).statusCode).toBe(200)
    expect((await park('something vague')).statusCode).toBe(200)

    const steps = json(await call('GET', '/api/weekly-planning', kevin)).steps as { key: string; parked: { id: string; note: string }[] }[]
    const on = (key: string) => steps.find((x) => x.key === key)!.parked.map((n) => n.note)

    expect(on('tasks')).toEqual(['buy poster board'])
    expect(on('meals')).toEqual(['no meal on friday'])
    // An UNTAGGED note is nobody's yet — it is the recap's last call, not every step's
    // problem. Handing it to all ten would make the banner noise on every screen.
    expect(on('calendar')).toEqual([])
    expect(on('goals')).toEqual([])
    // And step 1 does not get its own notes handed back to it: it already draws the board.
    expect(on('looseEnds')).toEqual([])
  })

  it('stops handing a note over once it has been dealt with', async () => {
    const s = json(await call('POST', '/api/weekly-planning/session', kevin)).session
    await call('POST', '/api/weekly-planning/loose-ends/parked', kevin, { note: 'call the dentist', sessionId: s.id, stepKey: 'tasks' })

    const before = json(await call('GET', '/api/weekly-planning', kevin)).steps as { key: string; parked: { id: string; note: string }[] }[]
    const note = before.find((x) => x.key === 'tasks')!.parked.find((n) => n.note === 'call the dentist')!
    expect(note).toBeTruthy()

    // The resolve route step 1 and step 10 already use — NOT a second mechanism.
    expect((await call('POST', '/api/weekly-planning/loose-ends/resolve', kevin, {
      kind: 'parked', id: note.id, action: 'done', sessionId: s.id,
    })).statusCode).toBe(200)

    const after = json(await call('GET', '/api/weekly-planning', kevin)).steps as { key: string; parked: { note: string }[] }[]
    expect(after.find((x) => x.key === 'tasks')!.parked.map((n) => n.note)).not.toContain('call the dentist')
  })

  it('carries a note routed by step 1’s triage, not just one parked with a tag', async () => {
    // The two producers write the SAME column, which is the whole reason one consumer is
    // enough. Routing an already-parked note has to arrive the same way.
    const s = json(await call('POST', '/api/weekly-planning/session', kevin)).session
    const made = await call('POST', '/api/weekly-planning/loose-ends/parked', kevin, { note: 'fix the gate', sessionId: s.id })
    const id = json(made).item.id

    const steps0 = json(await call('GET', '/api/weekly-planning', kevin)).steps as { key: string; parked: { note: string }[] }[]
    expect(steps0.find((x) => x.key === 'tasks')!.parked.map((n) => n.note)).not.toContain('fix the gate')

    expect((await call('POST', '/api/weekly-planning/loose-ends/route', kevin, {
      // `title` is required: a route records the words it was routed under, so step 1's
      // own board can show what went where without re-reading the note.
      sessionId: s.id, kind: 'parked', id, to: 'tasks', title: 'fix the gate',
    })).statusCode).toBe(200)

    const steps1 = json(await call('GET', '/api/weekly-planning', kevin)).steps as { key: string; parked: { note: string }[] }[]
    expect(steps1.find((x) => x.key === 'tasks')!.parked.map((n) => n.note)).toContain('fix the gate')
  })
})

describe('planning · editing a note after it has been parked', () => {
  // "parked in this session - I have no way to edit the item or change the category and
  // I should."
  //
  // A note was written once and then only answered: a typo, or the wrong destination
  // chosen in the bar, could be fixed only by dropping it and re-typing. (0100's own
  // comment says as much — "editing a parked note is not a thing the step offers" — and
  // that sentence is what this route retires.)
  //
  // THE HARD PART IS NOT THE COLUMN, IT IS THE ROUTE. Routing a note in step 1 stamps
  // `planning_parked_items.step_key` AND writes a `{ kind:'parked', id, title, to }`
  // entry on the looseEnds step's own `data.routes`. So a tag change has to move BOTH,
  // or the note's badge says one step while the trail under step 1's card says another.
  // A note parked with a tag from step 3 has no route entry at all, and must not grow
  // one — that is a state parking itself can never produce.
  const routesOf = (view: { steps: { key: string; data?: { routes?: unknown } }[] }) =>
    (view.steps.find((s) => s.key === 'looseEnds')?.data?.routes ?? []) as
      { kind: string; id: string; title: string; to: string }[]

  const park = (sessionId: string, note: string, stepKey?: string) =>
    call('POST', '/api/weekly-planning/loose-ends/parked', kevin, {
      note, sessionId, ...(stepKey ? { stepKey } : {}),
    })

  const parkedOn = (view: { steps: { key: string; parked?: { id: string; note: string }[] }[] }, key: string) =>
    (view.steps.find((s) => s.key === key)?.parked ?? []).map((n) => n.note)

  it('rewrites the words, and the route entry that quoted them', async () => {
    const s = json(await call('POST', '/api/weekly-planning/session', kevin)).session
    const id = json(await park(s.id, 'by the poster bored')).item.id
    expect((await call('POST', '/api/weekly-planning/loose-ends/route', kevin, {
      sessionId: s.id, kind: 'parked', id, to: 'tasks', title: 'by the poster bored',
    })).statusCode).toBe(200)

    const res = await call('PATCH', `/api/weekly-planning/loose-ends/parked/${id}`, kevin, {
      note: 'buy the poster board', sessionId: s.id,
    })
    expect(res.statusCode).toBe(200)
    expect(json(res).item.note).toBe('buy the poster board')

    const view = json(await call('GET', '/api/weekly-planning', kevin))
    // The gold box on step 8 says the new words…
    expect(parkedOn(view, 'tasks')).toContain('buy the poster board')
    expect(parkedOn(view, 'tasks')).not.toContain('by the poster bored')
    // …and so does step 1's own trail, which quoted the old ones.
    const route = routesOf(view).find((r) => r.id === id)!
    expect(route.title).toBe('buy the poster board')
  })

  it('moves the tag AND the route together', async () => {
    const s = json(await call('POST', '/api/weekly-planning/session', kevin)).session
    const id = json(await park(s.id, 'thaw the chicken')).item.id
    await call('POST', '/api/weekly-planning/loose-ends/route', kevin, {
      sessionId: s.id, kind: 'parked', id, to: 'tasks', title: 'thaw the chicken',
    })

    expect((await call('PATCH', `/api/weekly-planning/loose-ends/parked/${id}`, kevin, {
      stepKey: 'meals', sessionId: s.id,
    })).statusCode).toBe(200)

    const view = json(await call('GET', '/api/weekly-planning', kevin))
    expect(parkedOn(view, 'meals')).toContain('thaw the chicken')
    expect(parkedOn(view, 'tasks')).not.toContain('thaw the chicken')
    expect(routesOf(view).find((r) => r.id === id)!.to).toBe('meals')
  })

  it('clearing the tag retires the route, exactly as un-routing does', async () => {
    const s = json(await call('POST', '/api/weekly-planning/session', kevin)).session
    const id = json(await park(s.id, 'the shed door')).item.id
    await call('POST', '/api/weekly-planning/loose-ends/route', kevin, {
      sessionId: s.id, kind: 'parked', id, to: 'tasks', title: 'the shed door',
    })

    expect((await call('PATCH', `/api/weekly-planning/loose-ends/parked/${id}`, kevin, {
      stepKey: null, sessionId: s.id,
    })).statusCode).toBe(200)

    const view = json(await call('GET', '/api/weekly-planning', kevin))
    expect(parkedOn(view, 'tasks')).not.toContain('the shed door')
    // A note with no tag is nobody's — and a trail entry saying it went to Tasks would be
    // the exact disagreement this route exists to prevent.
    expect(routesOf(view).find((r) => r.id === id)).toBeUndefined()
  })

  it('does not invent a route for a note that was never routed', async () => {
    const s = json(await call('POST', '/api/weekly-planning/session', kevin)).session
    // Parked from step 3's bar WITH a tag: `step_key` set, no route entry — and retagging
    // it must not manufacture one, because parking itself never can.
    const id = json(await park(s.id, 'pack for camping', 'tasks')).item.id
    expect(routesOf(json(await call('GET', '/api/weekly-planning', kevin))).find((r) => r.id === id)).toBeUndefined()

    expect((await call('PATCH', `/api/weekly-planning/loose-ends/parked/${id}`, kevin, {
      note: 'pack for the camping trip', stepKey: 'kids', sessionId: s.id,
    })).statusCode).toBe(200)

    const view = json(await call('GET', '/api/weekly-planning', kevin))
    expect(parkedOn(view, 'kids')).toContain('pack for the camping trip')
    expect(routesOf(view).find((r) => r.id === id)).toBeUndefined()
  })

  it('keeps the trail honest even when the caller sends no session', async () => {
    // `parkedByStep` is not session-scoped, so a surface showing a note (the gold box)
    // need not know which session is running. The trail still must not be left saying
    // something the note no longer says — so with no `sessionId` the server repairs the
    // household's ACTIVE session, which is the only one that could disagree.
    const s = json(await call('POST', '/api/weekly-planning/session', kevin)).session
    const id = json(await park(s.id, 'reglue the chair')).item.id
    await call('POST', '/api/weekly-planning/loose-ends/route', kevin, {
      sessionId: s.id, kind: 'parked', id, to: 'tasks', title: 'reglue the chair',
    })

    expect((await call('PATCH', `/api/weekly-planning/loose-ends/parked/${id}`, kevin, {
      note: 'reglue the kitchen chair', stepKey: 'meals',
    })).statusCode).toBe(200)

    const view = json(await call('GET', '/api/weekly-planning', kevin))
    expect(parkedOn(view, 'meals')).toContain('reglue the kitchen chair')
    const route = routesOf(view).find((r) => r.id === id)!
    expect(route.to).toBe('meals')
    expect(route.title).toBe('reglue the kitchen chair')
  })

  it('refuses a step the household is not running, an unknown one, and step 1 itself', async () => {
    const s = json(await call('POST', '/api/weekly-planning/session', kevin)).session
    const id = json(await park(s.id, 'ask about the field trip')).item.id
    const patch = (body: Record<string, unknown>) =>
      call('PATCH', `/api/weekly-planning/loose-ends/parked/${id}`, kevin, body)

    expect((await patch({ stepKey: 'nonsense' })).statusCode).toBe(400)
    // A note addressed to the step that triages notes is a circle.
    expect((await patch({ stepKey: 'looseEnds' })).statusCode).toBe(400)
    expect((await patch({ note: '   ' })).statusCode).toBe(400)
    expect((await patch({ note: 'x'.repeat(501) })).statusCode).toBe(400)
  })

  it('will not edit a note that has already been answered', async () => {
    const s = json(await call('POST', '/api/weekly-planning/session', kevin)).session
    const id = json(await park(s.id, 'never mind this one')).item.id
    await call('POST', '/api/weekly-planning/loose-ends/resolve', kevin, {
      kind: 'parked', id, action: 'drop', sessionId: s.id,
    })
    expect((await call('PATCH', `/api/weekly-planning/loose-ends/parked/${id}`, kevin, {
      note: 'actually it mattered',
    })).statusCode).toBe(404)
  })
})
