// Weekly Planning · step 8 (Tasks) — "Who's doing what?"
//
// The board is the kiosk Chores layout: a strip of everything nobody has taken, and a
// column per household member showing what that person is actually carrying for the
// week being planned. Each column's footer names the recurring load they already hold,
// so fairness is visible without anyone computing a score.
//
// THE UNIT IS THE CHORE DEFINITION, NOT THE INSTANCE. A chore_instance is one day; the
// session plans a whole week. Assigning next Wednesday's instance of a recurring chore
// would say nothing about Thursday's, and reading a week instance-by-instance would
// side-effect-materialize seven days of rows (ensureTodayInstances writes). So a card is
// one definition, and the days it lands on inside the week are computed here — one
// place, so web and iOS can't disagree about which day a chore falls on.
//
// The columns are SERVER-OWNED for the same reason the week boundary is: a column is
// what someone is carrying, not a log of what this sitting happened to move, so it has
// to survive a refresh, a remount and the iPad picking up where the phone left off.
//
// The step stores nothing of its own: every write goes through the existing chores
// endpoints, so this file is read-only.
import { query } from '../../../platform/db'
import { householdTz, todayDate } from '../../chores/chores.service'
import type { QueryResultRow } from 'pg'

// How often a chore comes round, in the app's own words (ChoreModal's segmented
// control), so the same chore isn't described two ways on two screens.
export type Cadence = 'daily' | 'weekly' | 'once'

export function cadenceOf(rrule: string | null): Cadence {
  if (!rrule) return 'once'
  if (/FREQ=WEEKLY/i.test(rrule)) return 'weekly'
  if (/FREQ=DAILY/i.test(rrule)) return 'daily'
  return 'once'
}

const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

// The seven dates of the week being planned. UTC math on a plain date, so no timezone
// can shift which day a chore is shown on.
export function weekDates(weekStart: string): string[] {
  const out: string[] = []
  const d = new Date(`${weekStart}T00:00:00Z`)
  for (let i = 0; i < 7; i++) {
    out.push(d.toISOString().slice(0, 10))
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}

// Which of the week's days a recurring chore lands on. Mirrors the rule
// ensureTodayInstances materializes by (DAILY every day; WEEKLY on its BYDAY codes) —
// deliberately the same rule, so the board can't promise a day the chores module won't
// actually produce. A WEEKLY rrule with no BYDAY lands nowhere, and says so.
export function recurringDays(rrule: string, dates: string[]): string[] {
  if (/FREQ=DAILY/i.test(rrule)) return [...dates]
  if (!/FREQ=WEEKLY/i.test(rrule)) return []
  const byDay = rrule.match(/BYDAY=([A-Z,]+)/i)?.[1]?.toUpperCase() ?? ''
  if (!byDay) return []
  const wanted = new Set(byDay.split(','))
  return dates.filter((d) => wanted.has(WEEKDAY_CODES[new Date(`${d}T00:00:00Z`).getUTCDay()]))
}

export interface TasksBoardChore {
  id: string
  title: string
  emoji: string | null
  rrule: string | null
  cadence: Cadence
  // The days inside the planned week this chore lands on (YYYY-MM-DD). Seven ⇒ every
  // day; empty ⇒ no day inside the week (see dueOn / carriedOver).
  days: string[]
  // A one-off's own date, which may sit outside the planned week. null for recurring.
  dueOn: string | null
  dueTime: string | null
  // A one-off whose day has actually PASSED, that is still open, and that rolls
  // forward — so it arrives in the week without belonging to a day in it. NOT merely
  // "dated before the week": a session usually plans NEXT week, so that would brand
  // everything made today a leftover.
  carriedOver: boolean
  rewardAmount: number
  rewardCurrency: string | null
  // Every day of this chore already sitting on a board still open — whoever is (or
  // isn't) on it. updateChore only cascades to instances from today forward, so the
  // days already behind us have to be moved by hand or the kiosk board keeps
  // disagreeing with this one. EVERY such day comes back, not just the first: a
  // one-off has exactly one, but a recurring chore has one per day anybody has opened
  // the board for. They come back for an OWNED chore too — that is what makes handing
  // one out reversible (back up for grabs, or on to somebody else).
  pendingInstanceIds: string[]
}

export interface TasksBoardPerson {
  id: string
  name: string
  avatarEmoji: string | null
  colorHex: string | null
  memberType: string
  isAdmin: boolean
  // What this person already carries: active chores that repeat. One-offs are not a
  // standing commitment, so they don't inflate the fairness read. NOT an occurrence
  // count — four recurring chores, however often each comes round.
  recurringChores: number
  // What they are actually holding for the week being planned, drawn from the chores
  // they own rather than from whatever this session happened to move.
  chores: TasksBoardChore[]
}

export interface TasksBoard {
  weekStart: string
  // The day a task ADDED during this session should land on. Server-owned for the same
  // reason the week boundary is: a client that picked its own would use the browser's
  // today, and "add a task" during a Wednesday session planning next week would quietly
  // date it to the Wednesday. The week being planned if it's still ahead of us; today
  // when the session is planning the week today falls in.
  newTaskDay: string
  people: TasksBoardPerson[]
  unassigned: TasksBoardChore[]
}

interface ChoreRowForBoard extends QueryResultRow {
  id: string
  title: string
  emoji: string | null
  person_id: string | null
  rrule: string | null
  rollover: boolean
  reward_amount: number
  reward_currency: string | null
  due_time: string | null
  instance_due_on: string | null
  instance_status: string | null
}

// Every active chore, with the one instance that decides where a ONE-OFF sits (it has
// exactly one). One query rather than a per-chore lookup, and no write anywhere in it.
async function choreRows(householdId: string): Promise<ChoreRowForBoard[]> {
  const { rows } = await query<ChoreRowForBoard>(
    `select c.id, c.title, c.emoji, c.person_id, c.rrule, c.rollover,
            c.reward_amount, c.reward_currency, c.due_time::text as due_time,
            i.due_on::text as instance_due_on, i.status as instance_status
       from chores c
       left join lateral (
         select ci.due_on, ci.status
           from chore_instances ci
          where ci.chore_id = c.id and ci.deleted_at is null
          order by (ci.status = 'pending') desc, ci.due_on
          limit 1
       ) i on true
      where c.household_id = $1 and c.is_active and c.deleted_at is null
      order by c.title`,
    [householdId]
  )
  return rows
}

// Every materialized instance still open, per chore. A separate aggregate rather than
// the lateral above (which picks the single row a one-off is placed by) — these are ALL
// the days a hand-out has to fix, and all the days taking it back has to fix again.
// Deliberately not filtered by person_id: a move is reversible, so the days of a chore
// somebody already holds matter as much as the days of one nobody has taken. Only
// 'pending' rows — a day somebody completed keeps its owner, for ledger integrity.
async function pendingInstanceIds(householdId: string): Promise<Map<string, string[]>> {
  const { rows } = await query<{ chore_id: string; ids: string[] }>(
    `select ci.chore_id, array_agg(ci.id order by ci.due_on) as ids
       from chore_instances ci
       join chores c on c.id = ci.chore_id and c.deleted_at is null
      where ci.household_id = $1
        and ci.status = 'pending' and ci.deleted_at is null
        -- Only days that AGREE with the definition: unclaimed, or on whoever owns the
        -- chore. A day somebody claimed for themselves off an up-for-grabs chore is
        -- their own doing, and this board has no business handing it to someone else.
        and (ci.person_id is null or ci.person_id is not distinct from c.person_id)
      group by ci.chore_id`,
    [householdId]
  )
  return new Map(rows.map((r) => [r.chore_id, r.ids]))
}

function present(
  r: ChoreRowForBoard,
  days: string[],
  carriedOver: boolean,
  pendingInstanceIds: string[]
): TasksBoardChore {
  return {
    id: r.id,
    title: r.title,
    emoji: r.emoji,
    rrule: r.rrule,
    cadence: cadenceOf(r.rrule),
    days,
    dueOn: r.rrule ? null : r.instance_due_on,
    dueTime: r.due_time ? String(r.due_time).slice(0, 5) : null,
    carriedOver,
    rewardAmount: Number(r.reward_amount ?? 0),
    rewardCurrency: r.reward_currency,
    pendingInstanceIds,
  }
}

// Where a chore sits relative to the week being planned. null ⇒ it has nothing to do
// with this week (a one-off already done, or dated past it) and doesn't belong on the
// board at all.
//
// `today` is the household's own today, and it — not the week start — is what decides
// "carried over". A session normally plans NEXT week, so every one-off made during this
// week is dated before the week being planned; judging by the week start alone told the
// family a task they had just written down was left over from a week they hadn't
// planned yet. A day is carried over only once it has actually passed.
function placeInWeek(
  r: ChoreRowForBoard,
  dates: string[],
  today: string
): { days: string[]; carriedOver: boolean } | null {
  if (r.rrule) return { days: recurringDays(r.rrule, dates), carriedOver: false }
  const due = r.instance_due_on
  // A one-off with no instance at all can still be handed out — it just has no day.
  if (!due) return { days: [], carriedOver: false }
  if (dates.includes(due)) return { days: [due], carriedOver: false }
  if (due < dates[0]) {
    // Already done (or awaiting a parent): settled, not this week's business.
    if (r.instance_status !== 'pending') return null
    // Its day has passed and it's still open: it rolls into the week (when it rolls
    // over at all) without belonging to a day in it.
    if (due < today) return r.rollover ? { days: [], carriedOver: true } : null
    // Still ahead of us, just before the week starts — a task made today, typically.
    // It belongs on the board saying its own date, and it is nobody's leftover.
    return { days: [], carriedOver: false }
  }
  // After the week: a real chore, just not this week's business.
  return null
}

export async function getTasksBoard(householdId: string, weekStart: string): Promise<TasksBoard> {
  const dates = weekDates(weekStart)
  // The household's own today — the line between "left over" and "not yet". Taken from
  // the chores module rather than computed here, so the two screens agree about which
  // day it is (a chore day rolls at household-local midnight, not UTC's).
  const today = todayDate(await householdTz(householdId))
  const [{ rows: personRows }, chores, pending] = await Promise.all([
    query<QueryResultRow>(
      `select p.id, p.name, p.avatar_emoji, p.color_hex, p.member_type, p.is_admin
         from persons p
        where p.household_id = $1 and p.deleted_at is null
        order by p.sort_order, p.created_at`,
      [householdId]
    ),
    choreRows(householdId),
    pendingInstanceIds(householdId),
  ])

  const byPerson = new Map<string, TasksBoardChore[]>()
  const recurring = new Map<string, number>()
  const unassigned: TasksBoardChore[] = []

  for (const r of chores) {
    // The fairness footer counts every standing chore this person owns, whether or not
    // it happens to land inside the week on screen.
    if (r.person_id && r.rrule) recurring.set(r.person_id, (recurring.get(r.person_id) ?? 0) + 1)

    if (r.person_id == null) {
      // The strip is everything nobody has taken — deliberately NOT week-scoped. An
      // up-for-grabs chore is up for grabs until someone takes it, and its card says
      // plainly which day (or which date outside the week) it is for.
      const place = placeInWeek(r, dates, today) ?? { days: [], carriedOver: false }
      unassigned.push(present(r, place.days, place.carriedOver, pending.get(r.id) ?? []))
      continue
    }
    const place = placeInWeek(r, dates, today)
    if (!place) continue
    const list = byPerson.get(r.person_id) ?? []
    // Its open days come back here too: handing a chore over is reversible, and taking
    // it back has to fix the same days handing it out did.
    list.push(present(r, place.days, place.carriedOver, pending.get(r.id) ?? []))
    byPerson.set(r.person_id, list)
  }

  // One column per member, ordered exactly as the kiosk Chores board orders them, so
  // the two screens never disagree about who sits where.
  const people: TasksBoardPerson[] = personRows.map((p) => ({
    id: p.id,
    name: p.name,
    avatarEmoji: p.avatar_emoji,
    colorHex: p.color_hex,
    memberType: p.member_type,
    isAdmin: p.is_admin,
    recurringChores: recurring.get(p.id) ?? 0,
    // Earliest day first, then title — a column reads the way the week runs.
    chores: (byPerson.get(p.id) ?? []).sort(
      (a, b) => (a.days[0] ?? '9999').localeCompare(b.days[0] ?? '9999') || a.title.localeCompare(b.title)
    ),
  }))

  // Inside the week, always: today when today is in it, otherwise the day it starts.
  const newTaskDay = today >= dates[0] && today <= dates[6] ? today : dates[0]

  return { weekStart, newTaskDay, people, unassigned }
}
