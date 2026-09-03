// Weekly Planning · step 9 — Kids. "What's your week about?"
//
// THE ONE STEP THE KIDS THEMSELVES READ. A card per kid, showing their own week, and
// two questions each — and the whole point of the design is that BOTH ARE ANSWERED FROM
// THINGS THAT ALREADY EXIST. So the tests below are mostly about provenance:
//
//   · the focus options come out of that child's OWN goals, their OWN overdue chores
//     and the standing chores they already carry — never a catalog of suggestions;
//   · the look-forward-to options are events already on THEIR week — never a text box;
//   · one kid's goal / chore / event never appears on the other kid's card.
//
// The step has NO `requiresModule` in the catalog (it reads goals AND chores, which are
// separately toggleable), so a module that is off contributes nothing rather than 403ing
// the whole step — the rule looseEnds' header already states.
//
// The two answers have no other module to land in (nothing owns "Wally's one thing this
// week"), so they live on `planning_session_steps.data` — which is why they must survive
// a re-read: the read-back frame is the part the kids remember, and `setDecisionData`
// only reaches the server when the step is answered.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>

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

const kevin = mint('dev|kevin') // the driver: admin, NOT a member of the private list
const kelly = mint('dev|kelly') // adult, the private list's other member
const json = (r: { body: string }) => JSON.parse(r.body)

let householdId: string
let kevinId: string
let kellyId: string
let wallyId: string
let lottieId: string
let sessionId: string
let weekStart: string
let gRead: string      // Wally's habit — 2 of 5 this week, lifetime total much larger
let gRecital: string   // Lottie's count goal
let gSecret: string    // Wally's goal in a list PRIVATE to Kelly & Wally
let cGarage: string    // Wally's one-off, overdue
let cHomework: string  // Wally's standing weekday chore
let cVacuum: string    // Lottie's standing Saturday chore
let eSoccer: string
let ePartyId: string
let eDentist: string

interface FocusOption {
  key: string
  source: 'goal' | 'chore' | 'routine' | 'custom'
  id: string | null
  emoji: string
  label: string
  detail: string | null
  routed: boolean
  goal: { id: string; goalType: string; periodDone: number; totalProgress: number; habitTargetPerPeriod: number | null } | null
}
interface ForwardOption { key: string; eventId: string | null; emoji: string; label: string; when: string }
interface Kid {
  personId: string
  name: string
  age: number | null
  stars: number | null
  week: Array<{ id: string; title: string; when: string; allDay: boolean }>
  chores: Array<{ id: string; title: string; when: string }>
  focusOptions: FocusOption[]
  forwardOptions: ForwardOption[]
  focus: { source: string; id: string | null; label: string; detail: string | null } | null
  forward: { eventId: string | null; label: string; when: string } | null
  settled: boolean
}
interface KidsView {
  weekStart: string
  sources: { goals: boolean; chores: boolean; rewards: boolean }
  canRepeat: boolean
  kids: Kid[]
}

const view = async (token = kevin): Promise<KidsView> =>
  json(await call('GET', `/api/weekly-planning/kids?sessionId=${sessionId}`, token))
const kid = async (name: string, token = kevin): Promise<Kid> => {
  const v = await view(token)
  const k = v.kids.find((x) => x.name === name)
  if (!k) throw new Error(`${name} has no card`)
  return k
}
const labels = (o: { label: string }[]) => o.map((x) => x.label)
const titles = (o: { title: string }[]) => o.map((x) => x.title)

const answer = (personId: string, body: Record<string, unknown>) =>
  call('PUT', '/api/weekly-planning/kids/answer', kevin, { sessionId, personId, ...body })

// weekStart + n days, as a plain date. UTC math on a date string — the same rule the
// rest of the module follows, so no timezone can shift which day a fixture lands on.
const day = (n: number) => {
  const d = new Date(`${weekStart}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
// Midday UTC: safely the same calendar day in America/Chicago whatever the offset.
const at = (n: number) => `${day(n)}T18:00:00.000Z`
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const weekdayOf = (n: number) => WD[new Date(`${day(n)}T00:00:00Z`).getUTCDay()]

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  const url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  delete process.env.AUTH0_DOMAIN
  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool
  const { query } = await import('../src/platform/db')

  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'Sites', timezone: 'America/Chicago' },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'ownerpass1' },
  })
  householdId = json(setup).household.id
  kevinId = json(setup).person.id
  const identify = (personId: string, sub: string) =>
    query(
      `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password',$3,true)`,
      [householdId, personId, sub]
    )
  await identify(kevinId, 'dev|kevin')

  const born = (years: number) => new Date(Date.now() - (years * 365 + 40) * 864e5).toISOString().slice(0, 10)
  kellyId = json(await call('POST', '/api/persons', kevin, { name: 'Kelly', memberType: 'adult' })).person.id
  wallyId = json(await call('POST', '/api/persons', kevin, { name: 'Wally', memberType: 'kid', birthday: born(9) })).person.id
  lottieId = json(await call('POST', '/api/persons', kevin, { name: 'Lottie', memberType: 'kid', birthday: born(6) })).person.id
  await identify(kellyId, 'dev|kelly')

  await call('PATCH', '/api/household/modules', kevin, { weeklyPlanning: true })
  const session = json(await call('POST', '/api/weekly-planning/session', kevin)).session
  sessionId = session.id
  weekStart = session.weekStart

  // ── Goals ────────────────────────────────────────────────────────────────
  const kidsList = json(await call('POST', '/api/goal-lists', kevin, {
    name: 'Kids', emoji: '🧒', memberIds: [wallyId, lottieId],
  })).list.id
  // PRIVATE to Kelly & Wally. Kevin drives the session and is NOT a member, so nothing
  // in it may reach his read — not even on Wally's own card.
  const privateList = json(await call('POST', '/api/goal-lists', kevin, {
    name: 'Just us', emoji: '🤫', isPrivate: true, memberIds: [kellyId, wallyId],
  })).list.id
  const goal = async (body: Record<string, unknown>) => json(await call('POST', '/api/goals', kevin, body)).goal.id
  gRead = await goal({
    title: 'Read 20 minutes a day', emoji: '📖', goalListId: kidsList, goalType: 'habit',
    habitPeriod: 'week', habitTargetPerPeriod: 5, trackingMode: 'each_tracks', participantIds: [wallyId],
  })
  gRecital = await goal({
    title: 'Practice for the recital', emoji: '💃', goalListId: kidsList, goalType: 'count',
    unit: 'sessions', targetValue: 20, trackingMode: 'each_tracks', participantIds: [lottieId],
  })
  gSecret = await goal({
    title: "Mum's birthday surprise", goalListId: privateList, goalType: 'count', unit: 'steps',
    targetValue: 5, trackingMode: 'each_tracks', participantIds: [wallyId],
  })
  // A goal that belongs to the grown-ups: never a kid's focus option.
  await goal({
    title: 'Run a 10k', goalListId: kidsList, goalType: 'count', unit: 'km',
    targetValue: 10, trackingMode: 'each_tracks', participantIds: [kevinId],
  })

  // Two distinct days logged in the CURRENT household week, plus a big pile of lifetime
  // amount from long ago. The card must say "2 of 5 this week" — the habit axis — and
  // never the lifetime 99. Anchored to date_trunc so it lands right on any weekday.
  const logAt = (goalId: string, amount: number, atSql: string) =>
    query(
      `insert into goal_logs (household_id, goal_id, person_id, amount, logged_at)
       select h.id, $2::uuid, $3::uuid, $4::numeric, ${atSql} from households h where h.id = $1`,
      [householdId, goalId, wallyId, amount]
    )
  const wk = `date_trunc('week', (now() at time zone h.timezone))`
  await logAt(gRead, 1, `(${wk} + interval '2 hours') at time zone h.timezone`)
  await logAt(gRead, 1, `(${wk} + interval '1 day 2 hours') at time zone h.timezone`)
  await logAt(gRead, 97, `now() - interval '200 days'`)

  // ── Chores ───────────────────────────────────────────────────────────────
  cGarage = json(await call('POST', '/api/chores', kevin, {
    title: 'Get the garage done', emoji: '🧹', personId: wallyId, rrule: null,
  })).chore.id
  // Open since four days ago. The endpoint always dates an instance from today, so the
  // one it materialized is backdated here — the same trick looseEnds' fixtures use.
  await query(
    `update chore_instances set due_on = (now() at time zone 'America/Chicago')::date - 4, status = 'pending'
      where chore_id = $1`,
    [cGarage]
  )
  cHomework = json(await call('POST', '/api/chores', kevin, {
    title: 'Homework before screens', emoji: '🎒', personId: wallyId, rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
  })).chore.id
  cVacuum = json(await call('POST', '/api/chores', kevin, {
    title: 'Vacuum upstairs', emoji: '🧺', personId: lottieId, rrule: 'FREQ=WEEKLY;BYDAY=SA',
  })).chore.id
  // Somebody else's chore: never on a kid's card.
  await call('POST', '/api/chores', kevin, { title: 'Pay the bills', personId: kevinId, rrule: 'FREQ=WEEKLY;BYDAY=SU' })

  // ── Their week ───────────────────────────────────────────────────────────
  const event = async (body: Record<string, unknown>) => json(await call('POST', '/api/events', kevin, body)).event.id
  eSoccer = await event({ title: 'Soccer game', startsAt: at(2), participantIds: [wallyId] })
  await event({ title: 'Scouts', startsAt: at(3), participantIds: [wallyId] })
  ePartyId = await event({ title: 'Birthday party', startsAt: at(6), participantIds: [lottieId], isCountdown: true })
  // The grown-ups', and one in a later week: neither belongs on a kid's card.
  await event({ title: 'Date night', startsAt: at(5), participantIds: [kevinId, kellyId] })
  eDentist = await event({ title: 'Dentist', startsAt: at(9), participantIds: [wallyId] })

  // ── Stars ────────────────────────────────────────────────────────────────
  const stars = (personId: string, amount: number) =>
    query(
      `insert into ledger_entries (household_id, person_id, currency, amount, reason) values ($1,$2,'stars',$3,'spot_award')`,
      [householdId, personId, amount]
    )
  await stars(wallyId, 24)
  await stars(lottieId, 31)
})

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('planning · kids · gating', () => {
  it('403s while the weeklyPlanning module is off', async () => {
    await call('PATCH', '/api/household/modules', kevin, { weeklyPlanning: false })
    expect((await call('GET', `/api/weekly-planning/kids?sessionId=${sessionId}`, kevin)).statusCode).toBe(403)
    await call('PATCH', '/api/household/modules', kevin, { weeklyPlanning: true })
  })

  // The catalog gives this step no `requiresModule` — it reads TWO separately
  // toggleable modules, so gating on either would delete the step for a household that
  // only runs the other. A module that is off contributes nothing instead.
  it('still answers with goals off, and simply offers no goal-shaped options', async () => {
    await call('PATCH', '/api/household/modules', kevin, { goals: false })
    const v = await view()
    expect(v.sources.goals).toBe(false)
    const w = v.kids.find((k) => k.name === 'Wally')!
    expect(w.focusOptions.some((o) => o.source === 'goal')).toBe(false)
    // …and the chore-shaped ones are still there, because chores is still on.
    expect(w.focusOptions.some((o) => o.source === 'chore')).toBe(true)
    await call('PATCH', '/api/household/modules', kevin, { goals: true })
  })

  it('still answers with chores off, and drops their chores from the card', async () => {
    await call('PATCH', '/api/household/modules', kevin, { chores: false })
    const v = await view()
    expect(v.sources.chores).toBe(false)
    const w = v.kids.find((k) => k.name === 'Wally')!
    expect(w.chores).toEqual([])
    expect(w.focusOptions.some((o) => o.source === 'chore' || o.source === 'routine')).toBe(false)
    // Their week is the calendar, which is never gated — it survives.
    expect(titles(w.week)).toContain('Soccer game')
    // Stars are funded by chores; with chores off there is no economy to show.
    expect(w.stars).toBeNull()
    await call('PATCH', '/api/household/modules', kevin, { chores: true })
  })
})

describe('planning · kids · which week', () => {
  // A family getting in front of a trip can start a session for a week further out (the
  // plan doc says so outright). The week therefore comes off the SESSION, never off the
  // request: a client that forgets to echo `weekStart` must not be answered with the
  // default week's events and then told its perfectly real pick isn't an option.
  it('reads the week the session is about, without being told which it is', async () => {
    const later = json(await call('POST', '/api/weekly-planning/session', kevin, { weekStart: day(7) })).session
    expect(later.weekStart).toBe(day(7))
    const v: KidsView = json(await call('GET', `/api/weekly-planning/kids?sessionId=${later.id}`, kevin))
    expect(v.weekStart).toBe(day(7))
    const w = v.kids.find((k) => k.name === 'Wally')!
    // That week's event, not this week's.
    expect(labels(w.forwardOptions)).toEqual(['Dentist'])

    // …and the answer is validated against THAT week's options, again unprompted.
    const key = w.forwardOptions[0].key
    const r = await call('PUT', '/api/weekly-planning/kids/answer', kevin, {
      sessionId: later.id, personId: wallyId, forward: { key },
    })
    expect(r.statusCode).toBe(200)
    expect(json(r).kids.find((k: Kid) => k.name === 'Wally').forward).toMatchObject({ eventId: eDentist })
  })
})

describe('planning · kids · whose card is it', () => {
  it('gives a card to the children only, in household order', async () => {
    const v = await view()
    expect(v.kids.map((k) => k.name)).toEqual(['Wally', 'Lottie'])
    expect(v.weekStart).toBe(weekStart)
  })

  it('says how old they are and how many stars they have', async () => {
    expect((await kid('Wally')).age).toBe(9)
    expect((await kid('Lottie')).age).toBe(6)
    expect((await kid('Wally')).stars).toBe(24)
    expect((await kid('Lottie')).stars).toBe(31)
  })

  it('shows each kid their OWN week — events and chores, nobody else’s', async () => {
    const w = await kid('Wally')
    const l = await kid('Lottie')
    expect(titles(w.week)).toEqual(['Soccer game', 'Scouts'])
    expect(titles(l.week)).toEqual(['Birthday party'])
    // The grown-ups' evening, and an event in a later week, are on neither card.
    expect([...titles(w.week), ...titles(l.week)]).not.toContain('Date night')
    expect([...titles(w.week), ...titles(l.week)]).not.toContain('Dentist')
    // Chips read the way the week runs: the weekday, from the household's own zone.
    expect(w.week.find((e) => e.title === 'Soccer game')!.when).toContain(weekdayOf(2))

    expect(titles(w.chores)).toEqual(expect.arrayContaining(['Homework before screens', 'Get the garage done']))
    expect(titles(l.chores)).toEqual(['Vacuum upstairs'])
    expect([...titles(w.chores), ...titles(l.chores)]).not.toContain('Pay the bills')
  })
})

describe('planning · kids · the focus options come from what already exists', () => {
  it('offers a goal they are behind on, on the GOAL’S OWN axis', async () => {
    const w = await kid('Wally')
    const opt = w.focusOptions.find((o) => o.id === gRead)!
    expect(opt).toBeTruthy()
    expect(opt.source).toBe('goal')
    expect(opt.label).toBe('Read 20 minutes a day')
    expect(opt.emoji).toBe('📖')
    // A habit is THIS PERIOD's count. The lifetime 97+2 must never be what it says.
    expect(opt.detail).toBe('2 of 5 this week')
    expect(opt.detail).not.toContain('99')
    // The whole goal rides along so the client renders the number through the shared
    // display helper rather than inlining `totalProgress`.
    expect(opt.goal).toMatchObject({ id: gRead, goalType: 'habit', periodDone: 2, totalProgress: 99, habitTargetPerPeriod: 5 })
  })

  it('offers an overdue chore, and says how long it has been open', async () => {
    const opt = (await kid('Wally')).focusOptions.find((o) => o.id === cGarage)!
    expect(opt).toBeTruthy()
    expect(opt.source).toBe('chore')
    expect(opt.label).toBe('Get the garage done')
    expect(opt.detail).toMatch(/open since |days late/)
    expect(opt.goal).toBeNull()
  })

  it('offers a standing chore they already carry, with no line under it', async () => {
    const opt = (await kid('Wally')).focusOptions.find((o) => o.id === cHomework)!
    expect(opt).toBeTruthy()
    expect(opt.source).toBe('routine')
    // No detail: nothing is WRONG with it. That is the mock's third option exactly.
    expect(opt.detail).toBeNull()
  })

  it('never leaks a private goal list to a driver who is not in it', async () => {
    expect((await kid('Wally')).focusOptions.some((o) => o.id === gSecret)).toBe(false)
    // …and it is genuinely there for someone who IS a member.
    expect((await kid('Wally', kelly)).focusOptions.some((o) => o.id === gSecret)).toBe(true)
  })

  it('keeps one kid’s options off the other kid’s card', async () => {
    const l = await kid('Lottie')
    const ids = l.focusOptions.map((o) => o.id)
    expect(ids).not.toContain(gRead)
    expect(ids).not.toContain(cGarage)
    expect(ids).not.toContain(cHomework)
    expect(ids).toContain(gRecital)
    expect(ids).toContain(cVacuum)
  })

  it('promotes what step 1 sent here, and says so', async () => {
    // Step 1 routes; it does not resolve. Sending Wally's overdue chore to Kids has to
    // show up on Wally's card — the routes contract in the plan names step 9 a consumer.
    const { rows } = await (await import('../src/platform/db')).query<{ id: string }>(
      `select id from chore_instances where chore_id = $1`, [cGarage]
    )
    const routed = await call('POST', '/api/weekly-planning/loose-ends/route', kevin, {
      sessionId, kind: 'chore', id: rows[0].id, title: 'Get the garage done', source: 'notDone', to: 'kids',
    })
    expect(routed.statusCode).toBe(200)
    const w = await kid('Wally')
    expect(w.focusOptions[0].id).toBe(cGarage)
    expect(w.focusOptions[0].routed).toBe(true)
  })
})

describe('planning · kids · the look-forward-to options come from their week', () => {
  it('offers the events already on that kid’s week, and nothing invented', async () => {
    const w = await kid('Wally')
    expect(labels(w.forwardOptions)).toEqual(['Soccer game', 'Scouts'])
    expect(w.forwardOptions.every((o) => o.eventId != null)).toBe(true)
    expect(w.forwardOptions.find((o) => o.label === 'Soccer game')!.when).toContain(weekdayOf(2))

    const l = await kid('Lottie')
    expect(labels(l.forwardOptions)).toEqual(['Birthday party'])
    // A countdown event is one the family is ALREADY looking forward to.
    expect(l.forwardOptions[0].emoji).toBe('🎉')
  })
})

describe('planning · kids · answering, and reading it back', () => {
  it('records both answers and they survive a fresh read', async () => {
    const before = await kid('Wally')
    const focusKey = before.focusOptions.find((o) => o.id === gRead)!.key
    const forwardKey = before.forwardOptions.find((o) => o.eventId === eSoccer)!.key

    expect((await answer(wallyId, { focus: { key: focusKey } })).statusCode).toBe(200)
    // Half-answered is NOT settled: the read-back frame needs both.
    expect((await kid('Wally')).settled).toBe(false)

    expect((await answer(wallyId, { forward: { key: forwardKey } })).statusCode).toBe(200)
    const w = await kid('Wally')
    expect(w.settled).toBe(true)
    expect(w.focus).toMatchObject({ source: 'goal', id: gRead, label: 'Read 20 minutes a day' })
    expect(w.forward).toMatchObject({ eventId: eSoccer, label: 'Soccer game' })
    // Lottie is untouched — one card's answer never lands on the other.
    expect((await kid('Lottie')).settled).toBe(false)
  })

  it('takes free text as the escape hatch, for both questions', async () => {
    expect((await answer(lottieId, {
      focus: { text: 'Dressed before breakfast' },
      forward: { text: 'Grandma calling on Sunday' },
    })).statusCode).toBe(200)
    const l = await kid('Lottie')
    expect(l.settled).toBe(true)
    expect(l.focus).toMatchObject({ source: 'custom', id: null, label: 'Dressed before breakfast' })
    expect(l.forward).toMatchObject({ eventId: null, label: 'Grandma calling on Sunday' })
  })

  it('clears an answer with null, which un-settles the card', async () => {
    expect((await answer(lottieId, { focus: null })).statusCode).toBe(200)
    const l = await kid('Lottie')
    expect(l.focus).toBeNull()
    expect(l.settled).toBe(false)
    expect(l.forward).not.toBeNull() // the other half is left alone
    await answer(lottieId, { focus: { text: 'Dressed before breakfast' } })
  })

  it('refuses an unknown option, an adult, and a stranger', async () => {
    expect((await answer(wallyId, { focus: { key: 'goal:00000000-0000-0000-0000-000000000000' } })).statusCode).toBe(400)
    expect((await answer(kevinId, { focus: { text: 'anything' } })).statusCode).toBe(404)
    expect((await answer('00000000-0000-0000-0000-000000000000', { focus: { text: 'x' } })).statusCode).toBe(404)
  })

  it('writes to the session, not to the goals or chores modules', async () => {
    const { query } = await import('../src/platform/db')
    const { rows } = await query<{ is_featured: boolean }>(`select is_featured from goals where id = $1`, [gRead])
    // Step 6 owns `is_featured`. A kid naming their one thing is not the family pinning
    // a goal, and this step must not quietly do it for them.
    expect(rows[0].is_featured).toBe(false)
    const step = await query<{ data: { kids?: Record<string, unknown> } }>(
      `select data from planning_session_steps where session_id = $1 and step_key = 'kids'`, [sessionId]
    )
    expect(Object.keys(step.rows[0].data.kids ?? {})).toEqual(expect.arrayContaining([wallyId, lottieId]))
  })
})

describe('planning · kids · same as last week', () => {
  it('copies the previous session’s answers, dropping anything that no longer stands', async () => {
    const { query } = await import('../src/platform/db')
    // A finished session for the week BEFORE this one, holding two answers for Wally:
    // one that still resolves (his reading goal) and one that no longer does (a goal
    // that has since been deleted). Only the first may come back.
    const gone = '11111111-1111-1111-1111-111111111111'
    const prior = await query<{ id: string }>(
      `insert into planning_sessions (household_id, week_start, status, completed_at)
       values ($1, $2::date - 7, 'completed', now()) returning id`,
      [householdId, weekStart]
    )
    await query(
      `insert into planning_session_steps (session_id, step_key, status, data)
       values ($1, 'kids', 'done', $2::jsonb)`,
      [prior.rows[0].id, JSON.stringify({
        kids: {
          [wallyId]: {
            focus: { source: 'goal', id: gone, emoji: '🎯', label: 'A goal that has gone', detail: null },
            forward: { eventId: null, emoji: '✨', label: 'Cousins visiting', when: 'Sat' },
          },
          [lottieId]: {
            focus: { source: 'goal', id: gRecital, emoji: '💃', label: 'Practice for the recital', detail: null },
            forward: null,
          },
        },
      })]
    )
    expect((await view()).canRepeat).toBe(true)

    // Wipe this session's answers so the copy is unambiguous.
    await answer(wallyId, { focus: null, forward: null })
    await answer(lottieId, { focus: null, forward: null })

    expect((await call('POST', '/api/weekly-planning/kids/repeat', kevin, { sessionId })).statusCode).toBe(200)
    const w = await kid('Wally')
    // The vanished goal is dropped rather than proudly read back…
    expect(w.focus).toBeNull()
    // …while free text, which refers to nothing, copies verbatim.
    expect(w.forward).toMatchObject({ eventId: null, label: 'Cousins visiting' })
    // And a referent that still stands comes straight over.
    expect((await kid('Lottie')).focus).toMatchObject({ id: gRecital })
  })
})
