// Weekly Planning · step 5 (Connection) — "Who gets time with whom?"
//
// THE STEP STORES NOTHING, AND THAT IS THE WHOLE DESIGN. A pairing is not a record: it
// is a QUERY over event_participants for an event whose people are exactly those two.
// Picking one of the slots below writes an ordinary calendar event with those
// participants — through the app's own event modal — so it shows up in the week view,
// on both phones, and in the Meals step as an evening that is already taken. There is
// no `pairings` table, no migration, and no write route in this module. If a future
// change here starts to want one, that is the signal that the step has been misread.
//
// Two rules this file exists to keep honest:
//
//  1. TIME THAT ALREADY EXISTS GETS CREDIT. Often the true answer to "who gets time
//     with whom" is "you're already doing this on Saturday". A planning tool that can
//     only add obligations is a worse tool, so `alreadyThisWeek` is computed first and
//     is what the row leads with. Saturday's yard work is usually a RECURRING series,
//     which lives in event_occurrences rather than in `events` — hence rangeEvents()
//     rather than a bare select, which is also what keeps this step and the Calendar
//     step (step 2) agreeing about what is on the week.
//  2. NO INVENTED TIMES. A slot is a gap the week left behind: it opens when the day's
//     last event ends. A day with nothing on it produces a slot with NO time at all —
//     the event modal's own picker decides that. A default "evening is 7pm" constant
//     here would be exactly the arbitrary clock time the design forbids.
import { DateTime } from 'luxon'
import { query } from '../../../platform/db'
import { rangeEvents, type EventRow } from '../../events/events'
import { householdTz, todayDate } from '../../chores/chores.service'

// How far back "the last time it was just the two of you" looks. Bounded by the
// recurrence expansion window (expansion.service PAST_MONTHS = 3): occurrences older
// than that have aged out of event_occurrences, so asking for more would quietly drop
// recurring history and report a wrong date. Falling off the end reads as "never",
// which overstates the staleness rather than understating it — the safe direction.
const LOOKBACK_DAYS = 90

// A gap that opens after this hour isn't an evening anybody can use. Not a suggested
// time — a floor under what counts as a gap at all.
const LATEST_START_HOUR = 22

// "Wed after Scouts" reads better than "Wed after 8:30 PM" — but only while the name
// still fits on a chip. Past this, the time is the more useful half.
const SHORT_TITLE = 18

export interface ConnectionSlot {
  /** The day inside the planned week (YYYY-MM-DD, household-local). */
  date: string
  /**
   * When the gap opens, or null for a day with nothing on it. NULL IS NOT "unknown":
   * it means the whole day is free and the event modal's time picker should decide,
   * rather than this file naming an hour nothing in the week justifies.
   */
  startsAt: string | null
  kind: 'after' | 'open'
  /** The event the gap opens after ('after' only) — what makes the label a sentence. */
  afterTitle: string | null
  /** "Wed after Scouts" / "Tue after 8:30 PM" / "Sun · open". Built server-side so web and iOS say it the same way. */
  label: string
}

export interface ConnectionEvent {
  id: string
  title: string
  startsAt: string
  endsAt: string | null
  allDay: boolean
  /** Length in minutes, when the event has an end. "two hours of Kevin and Wally". */
  minutes: number | null
  /** "Saturday" — household-local. Split out because the row's sentence needs the possessive ("Saturday's yard work"). */
  day: string
  /** "1:00 PM", or null on an all-day row. */
  time: string | null
  /** "Saturday 1:00 PM" — one place, so nothing formats a household-local time twice. */
  when: string
}

export interface ConnectionPairing {
  /** Exactly the pairing's people, in household order. */
  personIds: string[]
  /** "Kevin and Kelly" — the row's title, and the sentence's subject. */
  who: string
  /** The most recent event before the planned week whose people were exactly these two. */
  lastTogetherOn: string | null
  lastTogetherTitle: string | null
  /** Events in the planned week whose people are EXACTLY these two — the credit. */
  alreadyThisWeek: ConnectionEvent[]
  /** Events in the week with both of them AND somebody else: "you're both there, and it still isn't that". */
  togetherThisWeek: ConnectionEvent[]
  /** Ranked gaps, roomiest first. All of them — how many chips fit is a layout decision. */
  slots: ConnectionSlot[]
}

export interface ConnectionBoard {
  /** The week the server resolved (snapped and floored). Echoed so no client does week arithmetic. */
  weekStart: string
  /**
   * Every pair in the household, ranked. The step draws the top three — "the three rows
   * are only the pairings the app can already see, they are not the list" — but the cut
   * is the client's, so the two platforms can't disagree about the ranking while
   * disagreeing about how many rows fit.
   */
  pairings: ConnectionPairing[]
}

interface Person { id: string; name: string }

/**
 * Who an event is actually with. Participants when it has them; otherwise its owner
 * alone (the modal writes participants, but a Google/ICS import or an older row may
 * only carry person_id). An event with neither belongs to the household as a whole,
 * which is nobody in particular — it can never be a pairing, but it does occupy the
 * evening, so it still closes a gap.
 */
function peopleOf(e: EventRow): string[] {
  const ids = (e.participants ?? []).map((p) => p.id)
  if (ids.length) return [...new Set(ids)]
  return e.person_id ? [e.person_id] : []
}

const sameSet = (a: string[], b: Set<string>) => a.length === b.size && a.every((id) => b.has(id))

function minutesOf(e: EventRow): number | null {
  if (!e.ends_at || e.all_day) return null
  return Math.round((new Date(e.ends_at).getTime() - new Date(e.starts_at).getTime()) / 60000)
}

function present(e: EventRow, tz: string): ConnectionEvent {
  const start = DateTime.fromJSDate(new Date(e.starts_at), { zone: tz })
  return {
    id: e.id,
    title: e.title,
    startsAt: new Date(e.starts_at).toISOString(),
    endsAt: e.ends_at ? new Date(e.ends_at).toISOString() : null,
    allDay: e.all_day,
    minutes: minutesOf(e),
    day: start.toFormat('cccc'),
    time: e.all_day ? null : start.toFormat('h:mm a'),
    when: e.all_day ? `${start.toFormat('cccc')}, all day` : start.toFormat('cccc h:mm a'),
  }
}

/** "Kevin and Kelly"; "Kevin, Wally and Lottie" for a three. */
export function whoLabel(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * The gaps a set of people have left in the planned week.
 *
 * A day is considered busy for the set if ANY of them is on a timed event that day
 * (plus household-wide events, which are everybody's). All-day rows are deliberately
 * ignored: they have no end to open a gap after, and most of them are birthdays and
 * notes rather than something that actually occupies the evening. A day where the last
 * of those events ends past LATEST_START_HOUR offers nothing at all.
 */
export function slotsFor(
  weekStart: string,
  events: EventRow[],
  people: string[],
  tz: string,
  now: Date
): ConnectionSlot[] {
  const set = new Set(people)
  const today = todayDate(tz)
  const byDay = new Map<string, EventRow[]>()
  for (const e of events) {
    if (e.all_day) continue
    const who = peopleOf(e)
    // A household event (nobody named) occupies everyone's evening.
    if (who.length && !who.some((id) => set.has(id))) continue
    const key = DateTime.fromJSDate(new Date(e.starts_at), { zone: tz }).toISODate()!
    const list = byDay.get(key)
    if (list) list.push(e)
    else byDay.set(key, [e])
  }

  const out: ConnectionSlot[] = []
  for (let i = 0; i < 7; i++) {
    const d = DateTime.fromISO(weekStart, { zone: tz }).plus({ days: i })
    const date = d.toISODate()!
    if (date < today) continue // a gap that has already gone by is not an offer
    const dow = d.toFormat('EEE')
    const onDay = byDay.get(date) ?? []

    if (!onDay.length) {
      out.push({ date, startsAt: null, kind: 'open', afterTitle: null, label: `${dow} · open` })
      continue
    }
    // The gap opens when the LAST thing on the day ends (an event with no end is
    // treated as an hour, which is what the event modal defaults a new one to).
    let after: EventRow | null = null
    let end = 0
    for (const e of onDay) {
      const t = e.ends_at ? new Date(e.ends_at).getTime() : new Date(e.starts_at).getTime() + 3600_000
      if (t > end) { end = t; after = e }
    }
    const opens = DateTime.fromMillis(end, { zone: tz })
    if (opens.hour >= LATEST_START_HOUR || opens.toMillis() <= now.getTime()) continue
    const title = after!.title
    out.push({
      date,
      startsAt: opens.toUTC().toISO()!,
      kind: 'after',
      afterTitle: title,
      label: title.length <= SHORT_TITLE ? `${dow} after ${title}` : `${dow} after ${opens.toFormat('h:mm a')}`,
    })
  }

  // Roomiest first: a whole free day beats a sliver at the end of a busy one, and an
  // evening that opens at 5 beats one that opens at 8:30. Date breaks the tie, so the
  // order is stable across refreshes.
  return out.sort((a, b) => {
    const ra = a.kind === 'open' ? -1 : DateTime.fromISO(a.startsAt!, { zone: tz }).hour * 60 + DateTime.fromISO(a.startsAt!, { zone: tz }).minute
    const rb = b.kind === 'open' ? -1 : DateTime.fromISO(b.startsAt!, { zone: tz }).hour * 60 + DateTime.fromISO(b.startsAt!, { zone: tz }).minute
    return ra - rb || a.date.localeCompare(b.date)
  })
}

export async function householdPeople(householdId: string): Promise<Person[]> {
  const { rows } = await query<{ id: string; name: string }>(
    `select p.id, p.name
       from persons p
      where p.household_id = $1 and p.deleted_at is null
      order by p.sort_order, p.created_at, p.id`,
    [householdId]
  )
  return rows
}

/**
 * The week's events as this step reads them.
 *
 * `viewerPersonId` is the DRIVER's person, not null: `visibleTo` hides personal-
 * visibility events from everyone but their owner, so reading as nobody would hide the
 * driver's own personal calendar and offer a slot in a gap step 2 draws as full. The
 * two steps have to agree about what is on the week or the whole "the slots are the
 * gaps step 2 left behind" claim is a lie.
 */
async function weekAndHistory(householdId: string, weekStart: string, viewerPersonId: string) {
  const start = DateTime.fromISO(weekStart)
  const [week, history] = await Promise.all([
    rangeEvents(householdId, weekStart, start.plus({ days: 6 }).toISODate()!, viewerPersonId),
    rangeEvents(householdId, start.minus({ days: LOOKBACK_DAYS }).toISODate()!, start.minus({ days: 1 }).toISODate()!, viewerPersonId),
  ])
  return { week, history }
}

export async function getConnectionBoard(
  householdId: string,
  weekStart: string,
  viewerPersonId: string,
  now = new Date()
): Promise<ConnectionBoard> {
  const [tz, people] = await Promise.all([householdTz(householdId), householdPeople(householdId)])
  const { week, history } = await weekAndHistory(householdId, weekStart, viewerPersonId)

  const pairings: ConnectionPairing[] = []
  for (let i = 0; i < people.length; i++) {
    for (let j = i + 1; j < people.length; j++) {
      const a = people[i]
      const b = people[j]
      const set = new Set([a.id, b.id])

      const already: ConnectionEvent[] = []
      const together: ConnectionEvent[] = []
      for (const e of week) {
        const who = peopleOf(e)
        if (sameSet(who, set)) already.push(present(e, tz))
        else if (set.size && [...set].every((id) => who.includes(id))) together.push(present(e, tz))
      }

      // The last exclusive one before the week. rangeEvents orders ascending, so the
      // last match is the most recent.
      let last: EventRow | null = null
      for (const e of history) if (sameSet(peopleOf(e), set)) last = e

      pairings.push({
        personIds: [a.id, b.id],
        who: whoLabel([a.name, b.name]),
        lastTogetherOn: last ? DateTime.fromJSDate(new Date(last.starts_at), { zone: tz }).toISODate() : null,
        lastTogetherTitle: last?.title ?? null,
        alreadyThisWeek: already,
        togetherThisWeek: together,
        slots: slotsFor(weekStart, week, [a.id, b.id], tz, now),
      })
    }
  }

  // Longest since it was just the two of them, first. "Never" outranks any date — it is
  // the whole reason to prompt. Ties break on how much the week already throws them
  // together WITHOUT it being that (the mock's "you're in the car together twice this
  // week"), then on household order, so the list is stable across refreshes.
  const staleness = (p: ConnectionPairing) =>
    p.lastTogetherOn === null
      ? Number.MAX_SAFE_INTEGER
      : Math.round(DateTime.fromISO(weekStart).diff(DateTime.fromISO(p.lastTogetherOn), 'days').days)
  // Keyed by ids, NOT by `who`: two people can share a first name (a Jr., two Sams),
  // and a name-keyed map would collapse two pairings into one and shuffle the order.
  const order = new Map(pairings.map((p, idx) => [p.personIds.join('-'), idx]))
  pairings.sort(
    (x, y) =>
      staleness(y) - staleness(x) ||
      y.togetherThisWeek.length - x.togetherThisWeek.length ||
      order.get(x.personIds.join('-'))! - order.get(y.personIds.join('-'))!
  )

  return { weekStart, pairings }
}

/**
 * Slots for an arbitrary set of people — what "Make a pairing" needs, because a pairing
 * the app can't already see still deserves the week's real gaps rather than a blank
 * date picker. Same computation as a suggested row's, on purpose.
 */
export async function getConnectionSlots(
  householdId: string,
  weekStart: string,
  viewerPersonId: string,
  personIds: string[],
  now = new Date()
): Promise<{ weekStart: string; personIds: string[]; who: string; slots: ConnectionSlot[] }> {
  const [tz, people] = await Promise.all([householdTz(householdId), householdPeople(householdId)])
  const wanted = new Set(personIds)
  // Household order, not the order they were typed — so two clients asking for the same
  // people get the same answer, and an id from another household simply isn't here.
  const chosen = people.filter((p) => wanted.has(p.id))
  if (chosen.length !== wanted.size || chosen.length < 2) {
    throw new InvalidPairingError('a pairing needs at least two people from this household')
  }
  const week = await rangeEvents(
    householdId,
    weekStart,
    DateTime.fromISO(weekStart).plus({ days: 6 }).toISODate()!,
    viewerPersonId
  )
  const ids = chosen.map((p) => p.id)
  return { weekStart, personIds: ids, who: whoLabel(chosen.map((p) => p.name)), slots: slotsFor(weekStart, week, ids, tz, now) }
}

export class InvalidPairingError extends Error {}
