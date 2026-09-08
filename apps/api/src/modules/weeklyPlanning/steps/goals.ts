// Step 6 · Goals — "What's each group's focus this week?"
//
// THE ARCHITECTURAL POINT (see docs/product/weekly-planning-plan.md): this step invents
// nothing. The tabs are the `goal_lists` that already exist, the goals are the real
// goals with their real progress, and picking one sets the goal's existing
// `is_featured` flag. There is no "focus" table and no parallel flag.
//
// The one thing that has no other home is WHICH GROUPS THIS SESSION HAS SETTLED —
// because "nothing this week" is a real answer and is indistinguishable from "we
// haven't got to this group yet" if you only read `is_featured`. So the session keeps a
// `{ focus: { <listId>: <goalId> | null } }` map in `planning_session_steps.data`: a key
// present means the group is settled (the ★ on its tab), and a null value means it
// settled on nothing. That map is a record of the DECISION, not a copy of module data —
// the flag itself stays the module's truth, which is what the recap reads through to.
//
// …and it is also what makes the write NON-DESTRUCTIVE. `is_featured` is the goals
// screen's user-facing "Pinned" tier, which is deliberately NOT one-per-list there: a
// family can pin four goals on purpose. So changing a group's focus un-features ONLY
// the goal this session previously set for that list (which the map records exactly),
// never every pin in the list. One-per-focus is enforced in the SESSION, where that
// rule actually belongs; `is_featured` itself stays additive, and a pin that predates
// the session survives it.
//
// PRIVACY. `goal_lists.is_private` is enforced HERE for the first time in the codebase:
// `listGoalLists` hands every list to every caller and no existing screen filters on it
// (a real pre-existing bug on the goals screen, raised separately). A private list
// belongs to its members: it is dropped from the read for anyone else, and naming it in
// a write 404s. Membership is the whole rule — an admin gets no bypass, because "the
// couple's private list" means nothing if the household owner can read it.
import type { PoolClient } from 'pg'
import { query, getPool } from '../../../platform/db'
import type { Tenant } from '../../households/households'
import { listGoalLists, listGoals, periodStartSQL } from '../../goals/goals.service'
import { getSessionById } from '../weeklyPlanning'

const STEP_KEY = 'goals'

// What the session decided per list. A key PRESENT means settled; `null` means it
// settled on "nothing this week", which the design treats as a real answer.
export type FocusMap = Record<string, string | null>

type GoalList = Awaited<ReturnType<typeof listGoalLists>>[number]
type Goal = Awaited<ReturnType<typeof listGoals>>[number]

// A goal as this step shows it: everything the goals screen has, plus how it is
// actually going (see `paceFor`).
export interface GoalsStepGoal extends Goal {
  pace: Pace | null
}

export interface GoalsStepMember {
  personId: string
  name: string
  avatarEmoji: string | null
  colorHex: string | null
  // Null when we don't know their birthday — the group's sub line then omits the age
  // rather than guessing one.
  age: number | null
}

export interface GoalsStepGroup extends Omit<GoalList, 'id' | 'goalCount' | 'members'> {
  // Named `listId` rather than `id` so a client can never confuse a tab with a goal.
  listId: string
  members: GoalsStepMember[]
  // True when the group is literally every person in the household — what lets the
  // sub line say "everyone tracks it" without the client counting people.
  isEveryone: boolean
  goals: GoalsStepGoal[]
  // True when THIS session has answered for this group — the ★ on the tab.
  settled: boolean
  // What it answered: a goal id, or null for "nothing this week".
  focusGoalId: string | null
}

export interface GoalsStepView {
  groups: GoalsStepGroup[]
}

// ---------------------------------------------------------------------------
// Pace — the second half of a goal row's subtitle ("kind · pace")
// ---------------------------------------------------------------------------
// The design wants each goal to say how it is actually GOING, in a sentence, with one
// of three tones. It is derived from real `goal_logs` activity — never invented — and
// computed SERVER-side so web and iOS read the same verdict, the same way the step
// catalog's questions are server-owned.
//
// The facts (one grouped query below): the household-local day of the first and last
// log, how many distinct days were logged in the last 7 and the last 28, the amount
// logged in the last 7, and — for habits — how many days were logged in the PREVIOUS
// habit period (the same window `period_done` uses, shifted back one, so "last week"
// here means exactly what "this week" means on the goals screen).
export type PaceTone = 'ok' | 'flat' | 'behind'
export interface Pace {
  text: string
  tone: PaceTone
}

interface ActivityRow {
  goal_id: string
  first_day: string | null
  last_day: string | null
  days_last7: number
  days_last28: number
  amount_last7: number
  prev_period_days: number
  today: string
}

export interface Activity {
  firstDay: string | null
  lastDay: string | null
  daysLast7: number
  daysLast28: number
  amountLast7: number
  prevPeriodDays: number
  today: string
}

const DAY_MS = 86400000
const dayNum = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / DAY_MS
// At most 2 decimals, trailing zeros dropped, thousands grouped — the reading
// `fmtGoalNum` gives on the client, so the sentence and the number never disagree.
const fmtNum = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 })
const fmtDay = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

// One goal's pace, or null when there is genuinely nothing to say.
export function paceFor(goal: Goal, a: Activity | undefined): Pace | null {
  if (!a) return null
  const since = a.lastDay ? dayNum(a.today) - dayNum(a.lastDay) : null

  // Never logged. Said plainly rather than dressed up as a rate.
  if (a.lastDay == null || since == null) return { text: 'nothing logged yet', tone: 'behind' }

  // Gone quiet. Three weeks reads as an absence; one or two reads as a stall, and
  // naming the date it stopped is more use than naming the size of the gap.
  if (since >= 21) return { text: `nothing logged in ${plural(Math.floor(since / 7), 'week', 'weeks')}`, tone: 'behind' }
  if (since >= 8) return { text: `stalled since ${fmtDay(a.lastDay)}`, tone: 'behind' }

  // A habit is judged on its cadence, against the cadence it set itself.
  const habitTarget = goal.goalType === 'habit' ? goal.habitTargetPerPeriod ?? goal.target ?? 0 : 0
  if (habitTarget > 0) {
    const period = goal.habitPeriod ?? 'week'
    return {
      text: `${a.prevPeriodDays} of ${fmtNum(habitTarget)} last ${period}`,
      tone: a.prevPeriodDays >= habitTarget ? 'ok' : 'behind',
    }
  }

  // The long slow burn: running two months or more, touched about once a month, and
  // touched recently. Its weekly number would be noise, so the honest reading is the
  // cadence — "roughly 1 book a month".
  const span = a.firstDay ? dayNum(a.today) - dayNum(a.firstDay) : 0
  if (span >= 56 && a.daysLast28 <= 2 && goal.totalProgress > 0) {
    const perMonth = goal.totalProgress / (span / 30.44)
    const unit = goal.unit ? ` ${goal.unit}` : ''
    return { text: `roughly ${fmtNum(Math.round(perMonth * 100) / 100)}${unit} a month`, tone: 'flat' }
  }

  // Recent and measurable. `ok` only when there is a target for it to be ok against —
  // an untargeted goal has nothing to be behind on, so its number is stated flat.
  if (a.amountLast7 > 0 && goal.unit) {
    const target = goal.goalType === 'checklist' ? goal.stepTotal : goal.target
    return { text: `${fmtNum(a.amountLast7)} ${goal.unit} last week`, tone: target ? 'ok' : 'flat' }
  }
  if (a.daysLast7 > 0) return { text: `${plural(a.daysLast7, 'day', 'days')} logged last week`, tone: 'ok' }
  return { text: `last logged ${fmtDay(a.lastDay)}`, tone: 'flat' }
}

// Every live goal's recent activity in one grouped query.
//
// `prev_period_days` is the goals module's OWN period rule, shifted back one period — it
// imports `periodStartSQL` rather than restating it, so "2 of 5 last week" is measured on
// the same clock as the "3 of 5" the goals screen shows for this week. The interval comes
// from a CASE, never from concatenating a column into a cast.
//
// Never a bare `date_trunc('week', …)`: that is MONDAY-only, so on a Sunday-start household (the
// default) Sunday's log lands in the wrong period and this disagrees with the goals screen about
// the same habit.
async function recentActivity(householdId: string): Promise<Map<string, Activity>> {
  const { rows } = await query<ActivityRow>(
    `with local as (select id, timezone, week_start, (now() at time zone timezone)::date as today
                      from households where id = $1),
          logs as (
            select gl.goal_id,
                   (gl.logged_at at time zone l.timezone)::date as day,
                   gl.amount, gl.counts_total
              from goal_logs gl join local l on l.id = gl.household_id
             where gl.household_id = $1 and gl.deleted_at is null
          )
     select g.id as goal_id,
            min(lg.day)::text as first_day,
            max(lg.day)::text as last_day,
            count(distinct lg.day) filter (where lg.day > l.today - 7) as days_last7,
            count(distinct lg.day) filter (where lg.day > l.today - 28) as days_last28,
            coalesce(sum(lg.amount) filter (where lg.day > l.today - 7 and lg.counts_total), 0)::float as amount_last7,
            (case when g.goal_type = 'habit' then (
               select count(distinct (gl2.logged_at at time zone l.timezone)::date)
                 from goal_logs gl2
                where gl2.goal_id = g.id and gl2.deleted_at is null
                  and (gl2.logged_at at time zone l.timezone)
                      >= (${periodStartSQL('l')})
                         - (case g.habit_period when 'day' then interval '1 day'
                                                when 'month' then interval '1 month'
                                                else interval '1 week' end)
                  and (gl2.logged_at at time zone l.timezone)
                      < (${periodStartSQL('l')})
             ) else 0 end) as prev_period_days,
            l.today::text as today
       from goals g
       cross join local l
       left join logs lg on lg.goal_id = g.id
      where g.household_id = $1 and g.deleted_at is null and g.is_active
      -- l.week_start joins the grouping because the correlated subquery above reads it:
      -- an aggregate query may only reference outer columns that are grouped, and Postgres
      -- infers functional dependency from a real table's primary key, never through a CTE.
      group by g.id, g.goal_type, g.habit_period, l.today, l.timezone, l.week_start`,
    [householdId]
  )
  return new Map(
    rows.map((r) => [r.goal_id, {
      firstDay: r.first_day,
      lastDay: r.last_day,
      daysLast7: Number(r.days_last7),
      daysLast28: Number(r.days_last28),
      amountLast7: Number(r.amount_last7),
      prevPeriodDays: Number(r.prev_period_days),
      today: r.today,
    }])
  )
}

// Each member's age, for the "individual · age 9" sub line the design gives a group
// card, plus the household headcount that lets a group honestly say "everyone".
async function householdPeople(householdId: string): Promise<{ ages: Map<string, number>; headcount: number }> {
  const { rows } = await query<{ id: string; age: number | null }>(
    `select p.id,
            case when p.birthday is null then null
                 else extract(year from age((now() at time zone h.timezone)::date, p.birthday))::int end as age
       from persons p join households h on h.id = p.household_id
      where p.household_id = $1 and p.deleted_at is null`,
    [householdId]
  )
  const ages = new Map<string, number>()
  for (const r of rows) if (r.age != null) ages.set(r.id, r.age)
  return { ages, headcount: rows.length }
}

function isFocusMap(v: unknown): v is FocusMap {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  return Object.values(v as Record<string, unknown>).every((x) => x === null || typeof x === 'string')
}

// `runner` is the pool for a plain read, or the transaction's client when the map is
// about to be rewritten — reading it outside the transaction that updates it is how a
// concurrent answer on another group loses its entry.
type Runner = Pick<PoolClient, 'query'> | null
async function readFocus(sessionId: string, runner: Runner = null): Promise<FocusMap> {
  const sql = `select data from planning_session_steps where session_id = $1 and step_key = $2`
  const { rows } = runner
    ? await runner.query<{ data: Record<string, unknown> | null }>(sql, [sessionId, STEP_KEY])
    : await query<{ data: Record<string, unknown> | null }>(sql, [sessionId, STEP_KEY])
  const focus = rows[0]?.data?.focus
  return isFocusMap(focus) ? focus : {}
}

// Merge the decision map onto the step row WITHOUT claiming the step is answered:
// `status` and `decided_at` are left alone (a mid-step write is not a decision about
// the step), and `jsonb_set` keeps any other crumb the step may add later.
//
// The shell's own `decideStep` REPLACES `data` when the primary is pressed, so the step
// body mirrors this map back through `setDecisionData` — otherwise pressing "Done"
// would wipe the very thing this write persisted.
async function writeFocus(client: PoolClient, sessionId: string, focus: FocusMap): Promise<void> {
  await client.query(
    `insert into planning_session_steps (session_id, step_key, status, data)
     values ($1, $2, 'pending', jsonb_build_object('focus', $3::jsonb))
     on conflict (session_id, step_key)
       do update set data = jsonb_set(coalesce(planning_session_steps.data, '{}'::jsonb), '{focus}', $3::jsonb, true)`,
    [sessionId, STEP_KEY, JSON.stringify(focus)]
  )
}

// The lists this caller may see: every shared list, plus the private ones they belong
// to. The single privacy gate — both the read and the write go through it.
async function visibleLists(tenant: Tenant): Promise<GoalList[]> {
  const lists = await listGoalLists(tenant.householdId)
  return lists.filter((l) => !l.isPrivate || l.members.some((m) => m.personId === tenant.personId))
}

export async function getGoalsStepView(tenant: Tenant, sessionId: string | null): Promise<GoalsStepView> {
  const [lists, goals, focus, activity, people] = await Promise.all([
    visibleLists(tenant),
    listGoals(tenant.householdId),
    sessionId ? readFocus(sessionId) : Promise.resolve({} as FocusMap),
    recentActivity(tenant.householdId),
    householdPeople(tenant.householdId),
  ])
  return {
    groups: lists.map((l) => {
      const { id, goalCount: _goalCount, members, ...rest } = l
      const mine = goals
        .filter((g) => g.goalListId === id)
        .map((g) => ({ ...g, pace: paceFor(g, activity.get(g.id)) }))
      const settled = Object.prototype.hasOwnProperty.call(focus, id)
      const picked = focus[id] ?? null
      const pinned = mine.filter((g) => g.isFeatured)
      return {
        ...rest,
        listId: id,
        members: members.map((m) => ({ ...m, age: people.ages.get(m.personId) ?? null })),
        isEveryone: people.headcount > 1 && members.length === people.headcount,
        goals: mine,
        // ★ ON THE TAB IS THE SESSION'S OWN ANSWER, never a flag we found lying around.
        // Adopting a pre-existing pin as "settled" would star a tab nobody had looked
        // at yet — the exact thing the ★ exists to rule out — and the recap, which
        // reads this map, would then disagree with the screen.
        settled,
        focusGoalId: settled
          // A pick whose goal has since gone (deleted, or moved to another list) is not
          // reported as this group's focus — but the group stays settled: the family did
          // answer, and re-answering is a click away.
          ? (picked && mine.some((g) => g.id === picked) ? picked : null)
          // Not answered yet, but exactly one goal in the list already carries the flag
          // — that IS the group's current focus, so show it selected rather than making
          // the family re-pick it. This is what closes the "＋ New goal for this week"
          // round trip: the editor creates the goal featured (`?featured=1`), so on the
          // way back it's already the one on screen. TWO pins is ambiguous — the family
          // pinned those by hand and the session has no business choosing between them
          // — so it adopts neither.
          : (pinned.length === 1 ? pinned[0].id : null),
      }
    }),
  }
}

export type SetFocusResult = { ok: true; view: GoalsStepView } | { ok: false }

// Answer one group. `goalId` null is the real answer "nothing this week".
//
// ONE FOCUS PER LIST, WITHOUT TRAMPLING PINS. `is_featured` is also the goals screen's
// user-facing "Pinned" tier, and pinning there is deliberately NOT one-per-list — a
// family can pin four goals on purpose. So this un-features exactly ONE goal: whichever
// one THIS session last set as the list's focus, which the session's own focus map
// records. A goal pinned before the session started keeps its pin; the session cannot
// silently undo a decision it never made. `is_spotlight` is never touched either — the
// hero is an independent flag with its own partial unique index.
export async function setGroupFocus(
  tenant: Tenant,
  sessionId: string,
  listId: string,
  goalId: string | null
): Promise<SetFocusResult> {
  const session = await getSessionById(tenant.householdId, sessionId)
  if (!session) return { ok: false }

  // Privacy AND ownership in one check: a list this caller can't see is a list they
  // can't answer for. Hiding it from the read while accepting a write on it would not
  // be privacy at all.
  const lists = await visibleLists(tenant)
  if (!lists.some((l) => l.id === listId)) return { ok: false }

  if (goalId) {
    const { rowCount } = await query(
      `select 1 from goals
        where household_id = $1 and id = $2 and goal_list_id = $3 and deleted_at is null and is_active`,
      [tenant.householdId, goalId, listId]
    )
    // Validated BEFORE anything is cleared, so a goal from another list can't cost this
    // list the focus it already had.
    if (!rowCount) return { ok: false }
  }

  const client = await getPool().connect()
  try {
    await client.query('begin')
    // Read the map first — the previous focus is the ONLY pin this write may drop.
    const focus = await readFocus(sessionId, client)
    const previous = focus[listId] ?? null
    if (previous && previous !== goalId) {
      await client.query(
        `update goals set is_featured = false
          where household_id = $1 and id = $2 and goal_list_id = $3 and deleted_at is null`,
        [tenant.householdId, previous, listId]
      )
    }
    if (goalId) {
      await client.query(
        `update goals set is_featured = true where household_id = $1 and id = $2 and goal_list_id = $3`,
        [tenant.householdId, goalId, listId]
      )
    }
    focus[listId] = goalId
    await writeFocus(client, sessionId, focus)
    await client.query('commit')
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
  return { ok: true, view: await getGoalsStepView(tenant, sessionId) }
}
