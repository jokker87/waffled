// Weekly Planning · step 5 (Connection) — "Who gets time with whom?"
//
// THE STEP STORES NOTHING. A pairing is a *query* over event_participants: an event
// whose people are exactly those two. Picking a slot writes an ordinary calendar event
// through the app's own event modal, so there is no write route here at all — only two
// reads, and everything they say has to be true of the real calendar.
//
// Three things these tests exist to pin down, because each is a way the step could look
// right and be wrong:
//
//  1. EXACTLY THOSE TWO. An event with the two of them *and someone else* is not their
//     time together. It is the mock's "Friday's dinner at the Hales is you both, but
//     it's not that" — reported separately (`togetherThisWeek`) so the row can say so.
//  2. TIME THAT ALREADY EXISTS GETS CREDIT, INCLUDING A RECURRING ONE. Saturday's yard
//     work is a weekly series, so it lives in event_occurrences, not in `events`. A
//     bare `select … from events` would miss it and the step would offer to manufacture
//     a commitment the family already keeps. The fixture creates it through
//     POST /api/events (which expands the master) rather than by hand, so a regression
//     that stops reading occurrences actually fails here.
//  3. THE SLOTS ARE THE GAPS THE WEEK LEFT BEHIND. Never a clock time this file made
//     up: a slot either opens when the day's last event ends, or the day is empty and
//     the slot carries no time at all (the event modal's own picker decides).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import jwt from 'jsonwebtoken'
import { DateTime } from 'luxon'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'
const TZ = 'America/Chicago'

let pg: StartedPostgreSqlContainer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
let householdId: string
let kevinId: string
let kellyId: string
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

interface Slot { date: string; startsAt: string | null; kind: 'after' | 'open'; afterTitle: string | null; label: string }
interface ConnEvent { id: string; title: string; startsAt: string; endsAt: string | null; allDay: boolean; minutes: number | null; day: string; time: string | null; when: string }
interface Pairing {
  personIds: string[]
  who: string
  lastTogetherOn: string | null
  lastTogetherTitle: string | null
  alreadyThisWeek: ConnEvent[]
  togetherThisWeek: ConnEvent[]
  slots: Slot[]
}
interface Board { weekStart: string; pairings: Pairing[] }

// The week under test. Deliberately TWO weeks past the session's default so every
// fixture day is in the future: slots on a day that has already gone by are dropped,
// and a test whose week straddles "now" would pass or fail depending on the clock.
let week: string
const day = (i: number) => DateTime.fromISO(week, { zone: TZ }).plus({ days: i }).toISODate()!
/** An instant on one of the week's days, in the HOUSEHOLD's zone, not the runner's. */
const at = (i: number, hhmm: string) => DateTime.fromISO(`${day(i)}T${hhmm}`, { zone: TZ }).toISO()!

async function addEvent(input: Record<string, unknown>): Promise<string> {
  const res = await call('POST', '/api/events', kevin, input)
  if (res.statusCode >= 300) throw new Error(`${JSON.stringify(input)} -> ${res.statusCode} ${res.body}`)
  return json(res).event.id as string
}

const board = async (qs = ''): Promise<Board> =>
  json(await call('GET', `/api/weekly-planning/connection?weekStart=${week}${qs}`, kevin)) as Board
const find = (b: Board, who: string) => b.pairings.find((p) => p.who === who)!

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  const url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  delete process.env.AUTH0_DOMAIN
  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool

  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'Sites', timezone: TZ },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'ownerpass1' },
  })
  householdId = json(setup).household.id
  kevinId = json(setup).person.id
  const { query } = await import('../src/platform/db')
  await query(
    `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|kevin',true)`,
    [householdId, kevinId]
  )
  // A pairing needs more than one person. /api/persons doesn't create logins, so seed
  // them directly (as the Tasks step's test does).
  const rest = await query<{ id: string; name: string }>(
    `insert into persons (household_id, name, member_type, sort_order)
     values ($1,'Kelly','adult',1), ($1,'Wally','kid',2), ($1,'Lottie','kid',3) returning id, name`,
    [householdId]
  )
  kellyId = rest.rows.find((r) => r.name === 'Kelly')!.id
  wallyId = rest.rows.find((r) => r.name === 'Wally')!.id
  lottieId = rest.rows.find((r) => r.name === 'Lottie')!.id

  // The session lives behind its own module toggle, like every other planning route.
  expect((await call('PATCH', '/api/household/modules', kevin, { weeklyPlanning: true })).statusCode).toBe(200)

  // Learn the session's default week from the server (never compute one here), then
  // plan two weeks past it.
  const first = json(await call('GET', '/api/weekly-planning/connection', kevin)) as Board
  week = DateTime.fromISO(first.weekStart, { zone: TZ }).plus({ weeks: 2 }).toISODate()!

  // ── The week ────────────────────────────────────────────────────────────────
  // Mon: the near miss — both of them, and Wally too. Not a pairing.
  await addEvent({ title: 'Dinner at the Hales', startsAt: at(1, '18:00'), endsAt: at(1, '20:30'), participantIds: [kevinId, kellyId, wallyId] })
  // Wed: Wally alone. Opens a gap for any pairing that includes him, none for the others.
  await addEvent({ title: 'Scouts', startsAt: at(3, '18:30'), endsAt: at(3, '19:30'), participantIds: [wallyId] })
  // Thu: Kevin is out past the cutoff, so Thursday offers nothing to a pair with him in it.
  await addEvent({ title: 'Late meeting', startsAt: at(4, '19:00'), endsAt: at(4, '22:30'), participantIds: [kevinId] })
  // Sat: the important one — a WEEKLY series whose people are exactly Kevin and Wally.
  // Created through the route so the master really expands into event_occurrences.
  await addEvent({
    title: 'Yard work', startsAt: at(6, '13:00'), endsAt: at(6, '15:00'),
    rrule: 'FREQ=WEEKLY;BYDAY=SA', participantIds: [kevinId, wallyId],
  })
  // A one-person event: an owner and no participants. Never a pairing, whoever else is free.
  await addEvent({ title: 'Haircut', startsAt: at(5, '09:00'), endsAt: at(5, '10:00'), personId: kellyId })

  // ── History ─────────────────────────────────────────────────────────────────
  // The last time it was just the two of them, well before the planned week.
  await addEvent({
    title: 'Date night',
    startsAt: DateTime.fromISO(`${week}T19:00`, { zone: TZ }).minus({ days: 45 }).toISO()!,
    endsAt: DateTime.fromISO(`${week}T21:00`, { zone: TZ }).minus({ days: 45 }).toISO()!,
    participantIds: [kevinId, kellyId],
  })
})

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('weekly planning · connection', () => {
  it('answers with the week it was asked for, and a pairing for every pair in the house', async () => {
    const b = await board()
    expect(b.weekStart).toBe(week)
    // Four people ⇒ six pairs. The step DRAWS three; the server ranks them all and lets
    // the client take the top of the list, so "which three" is a layout decision rather
    // than something the API quietly decides for both platforms.
    expect(b.pairings).toHaveLength(6)
    expect(find(b, 'Kevin and Kelly').personIds).toEqual([kevinId, kellyId])
  })

  it('snaps a mid-week ?weekStart= rather than keying off the day somebody named', async () => {
    const wednesday = DateTime.fromISO(week, { zone: TZ }).plus({ days: 3 }).toISODate()!
    const b = json(await call('GET', `/api/weekly-planning/connection?weekStart=${wednesday}`, kevin)) as Board
    expect(b.weekStart).toBe(week)
  })

  it('does not count an event that has a third person on it', async () => {
    const p = find(await board(), 'Kevin and Kelly')
    expect(p.alreadyThisWeek).toHaveLength(0)
    // …but it is reported, because "you're both there and it still isn't that" is the
    // most useful thing the row can say.
    expect(p.togetherThisWeek.map((e) => e.title)).toEqual(['Dinner at the Hales'])
  })

  it('gives credit for time that already exists, including a recurring occurrence', async () => {
    const p = find(await board(), 'Kevin and Wally')
    expect(p.alreadyThisWeek.map((e) => e.title)).toEqual(['Yard work'])
    expect(p.alreadyThisWeek[0].minutes).toBe(120)
    expect(p.alreadyThisWeek[0].when).toBe('Saturday 1:00 PM')
    // Split out because the row's sentence needs the possessive: "Saturday's yard work".
    expect(p.alreadyThisWeek[0].day).toBe('Saturday')
    expect(p.alreadyThisWeek[0].time).toBe('1:00 PM')
  })

  it('never reads a one-person event as a pairing', async () => {
    const b = await board()
    for (const p of b.pairings) {
      expect(p.alreadyThisWeek.map((e) => e.title)).not.toContain('Haircut')
      expect(p.togetherThisWeek.map((e) => e.title)).not.toContain('Haircut')
    }
  })

  it('remembers the last time it was just the two of them', async () => {
    const b = await board()
    const kk = find(b, 'Kevin and Kelly')
    expect(kk.lastTogetherOn).toBe(DateTime.fromISO(week, { zone: TZ }).minus({ days: 45 }).toISODate())
    expect(kk.lastTogetherTitle).toBe('Date night')
    // Nobody else has ever had time alone together, and the row has to be able to say so.
    expect(find(b, 'Kevin and Lottie').lastTogetherOn).toBeNull()
  })

  it('ranks the pairings by how long it has been, not by who is on the calendar most', async () => {
    const b = await board()
    // Never-alone-together outranks 45-days-ago; among the never pairs, the ones the
    // week already throws together (Monday's dinner) come first.
    expect(b.pairings.map((p) => p.who)).toEqual([
      'Kevin and Wally',
      'Kelly and Wally',
      'Kevin and Lottie',
      'Kelly and Lottie',
      'Wally and Lottie',
      'Kevin and Kelly',
    ])
  })

  it('offers the gaps the week left behind, and no clock time it invented', async () => {
    const p = find(await board(), 'Kevin and Kelly')
    const byDate = new Map(p.slots.map((s) => [s.date, s]))

    // Sunday has nothing on it: an open day, and NO time — the event modal's own
    // picker decides that, rather than this file guessing an evening.
    expect(byDate.get(day(0))).toMatchObject({ kind: 'open', startsAt: null })
    expect(byDate.get(day(0))!.label).toBe(`${DateTime.fromISO(day(0)).toFormat('EEE')} · open`)

    // Monday's gap opens when Monday's last event ends.
    expect(byDate.get(day(1))).toMatchObject({ kind: 'after', afterTitle: 'Dinner at the Hales' })
    expect(Date.parse(byDate.get(day(1))!.startsAt!)).toBe(Date.parse(at(1, '20:30')))

    // Thursday: Kevin is out until 10:30pm. There is no evening left to offer.
    expect(byDate.has(day(4))).toBe(false)

    // A whole free day beats a sliver at the end of a busy one.
    expect(p.slots[0].kind).toBe('open')
  })

  it("names the gap after the thing it follows when the thing has a short name", async () => {
    const p = find(await board(), 'Kevin and Wally')
    const wed = p.slots.find((s) => s.date === day(3))!
    expect(wed.label).toBe(`${DateTime.fromISO(day(3)).toFormat('EEE')} after Scouts`)
    // The same evening is wide open for a pairing Wally isn't in.
    const kk = find(await board(), 'Kevin and Kelly')
    expect(kk.slots.find((s) => s.date === day(3))!.kind).toBe('open')
  })

  it('computes slots for any set of people, so "make a pairing" offers the same gaps', async () => {
    const res = await call('GET', `/api/weekly-planning/connection/slots?weekStart=${week}&people=${kevinId},${lottieId},${wallyId}`, kevin)
    expect(res.statusCode).toBe(200)
    const out = json(res) as { weekStart: string; personIds: string[]; slots: Slot[] }
    expect(out.weekStart).toBe(week)
    expect(out.personIds).toEqual([kevinId, wallyId, lottieId]) // household order, not the order typed
    // Wednesday is Wally's Scouts night for this trio too.
    expect(out.slots.find((s) => s.date === day(3))).toMatchObject({ kind: 'after', afterTitle: 'Scouts' })
  })

  it('refuses a pairing of fewer than two people, or of somebody else’s household', async () => {
    const one = await call('GET', `/api/weekly-planning/connection/slots?weekStart=${week}&people=${kevinId}`, kevin)
    expect(one.statusCode).toBe(400)
    const stranger = await call('GET', `/api/weekly-planning/connection/slots?weekStart=${week}&people=${kevinId},00000000-0000-4000-8000-000000000000`, kevin)
    expect(stranger.statusCode).toBe(400)
  })

  it('runs in a household with the optional modules off — it has no requiresModule', async () => {
    // The catalog gives `connection` no requiresModule: a household with chores, goals
    // and meals switched off still has people in it. Pinned here because the neighbouring
    // steps DO gate on a second module, and copying one of them would break this.
    await call('PATCH', '/api/household/modules', kevin, { chores: false, goals: false, meals: false })
    try {
      expect((await call('GET', `/api/weekly-planning/connection?weekStart=${week}`, kevin)).statusCode).toBe(200)
    } finally {
      await call('PATCH', '/api/household/modules', kevin, { chores: true, goals: true, meals: true })
    }
  })

  it('is behind the weeklyPlanning toggle like the rest of the session', async () => {
    await call('PATCH', '/api/household/modules', kevin, { weeklyPlanning: false })
    try {
      expect((await call('GET', '/api/weekly-planning/connection', kevin)).statusCode).toBe(403)
      expect((await call('GET', '/api/weekly-planning/connection/slots', kevin)).statusCode).toBe(403)
    } finally {
      await call('PATCH', '/api/household/modules', kevin, { weeklyPlanning: true })
    }
  })
})
