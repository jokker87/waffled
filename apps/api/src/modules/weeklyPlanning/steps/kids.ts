// Weekly Planning · step 9 (Kids) — "What's your week about?"
//
// THE ONE STEP THE KIDS THEMSELVES READ. A nine-year-old and a six-year-old are standing
// at the board, so there is a card each — both on one screen, no per-kid navigation for a
// family of two — and two questions on it: one thing to focus on, and one thing to look
// forward to.
//
// BOTH ANSWERS ARE PICKED FROM THINGS THAT ALREADY EXIST. That is the design, and it is
// the whole reason this file is (nearly) a read:
//
//   · the FOCUS options come out of that child's own goals, their own overdue chores and
//     the standing chores they already carry. "＋ Something else" is the escape hatch, not
//     the main path — a kid should recognise their week in the list, not have to invent it.
//   · the LOOK-FORWARD-TO options are events already on their week. Never a text box first.
//   · the card also shows their week and their star count, because the kid at the board
//     wants to see their own week.
//
// The mock's third focus option ("Homework before screens", "Dressed before breakfast")
// carries NO line under it, and that is the tell: it is a standing chore they already own.
// Nothing is late about it and nothing is behind — so there is nothing to say. There is no
// catalog of age-appropriate suggestions here and there must not be one: the moment this
// step invents an option it stops being a read over the family's own week.
//
// WHAT IT WRITES. Nothing in any module. Nothing owns "Wally's one thing this week" —
// setting `is_featured` would be step 6 speaking for step 9, and a chore is not completed
// by being named — so the two answers live on `planning_session_steps.data` as
// `{ kids: { <personId>: { focus, forward } } }`. No new table (see the plan doc), and a
// REAL route write rather than `setDecisionData`, because the second frame is the
// read-back and it has to survive a remount, a refresh and the iPad picking up where the
// phone left off.
//
// NO `requiresModule` IN THE CATALOG, deliberately: the step reads goals AND chores, which
// a household toggles separately, so gating on either would delete the step for a family
// that runs the other. A module that is off contributes nothing instead — the same rule
// looseEnds' header states. Events are never gated; stars follow `rewardsEnabled`.
import type { PoolClient } from 'pg'
import { query, getPool } from '../../../platform/db'
import { moduleEnabled, rewardsEnabled, type ModuleKey } from '../../../platform/modules'
import type { Tenant } from '../../households/households'
import { listGoalLists, listGoals } from '../../goals/goals.service'
import { rangeEvents, presentEvent } from '../../events/events'
import { balancesSummary } from '../../rewards/rewards'
import { getTasksBoard, type TasksBoardChore } from './tasks'
import { getSessionById } from '../weeklyPlanning'
import { listRoutes } from './looseEnds'

const STEP_KEY = 'kids'

// ---------------------------------------------------------------------------
// The shape the step reads
// ---------------------------------------------------------------------------

type Goal = Awaited<ReturnType<typeof listGoals>>[number]

// Where an option came from. `routine` is a standing chore they already carry — the one
// with nothing under it. `custom` is what somebody typed into the escape hatch.
export type KidsFocusSource = 'goal' | 'chore' | 'routine' | 'custom'

export interface KidsFocusOption {
  // Stable across refetches and unique across sources — the client's list key and what a
  // write names. A routed chore and the same chore found overdue share one key on
  // purpose, so step 1's triage promotes the row rather than duplicating it.
  key: string
  source: KidsFocusSource
  // The referent in its own module (a goal id, a chore id). null for free text.
  id: string | null
  emoji: string
  label: string
  // The one line under the label, composed here so web and iOS say the same thing. NULL
  // is meaningful: a standing chore has nothing wrong with it, so it gets no line.
  detail: string | null
  // Sent here by step 1's triage — the routes contract in the plan doc names step 9 a
  // consumer. Promoted to the top of the list.
  routed: boolean
  // The whole goal, for a goal-sourced option, so the CLIENT reads its number through the
  // shared display helper (a habit is this period's count, a checklist is steps, anything
  // else the lifetime total) instead of inlining `totalProgress`. `detail` above says the
  // same thing in words, for iOS and for the read-back.
  goal: Goal | null
}

export interface KidsForwardOption {
  key: string
  // The event it names, or null for free text.
  eventId: string | null
  emoji: string
  label: string
  // The day, in the household's own zone ("Sat"). The read-back reads
  // "<when> — the bit to look forward to".
  when: string
}

export interface KidsWeekEvent {
  id: string
  title: string
  // "Tue 4:00 PM", or just the weekday for an all-day event.
  when: string
  startsAt: string
  allDay: boolean
}

export interface KidsWeekChore {
  id: string
  title: string
  emoji: string | null
  // "every day" · "Sat" · "open since Wednesday". Composed here for the same reason.
  when: string
  late: boolean
}

// What a card settled on. A SNAPSHOT of the label as it read when chosen — the module
// still owns the item, exactly as `LooseEndRoute.title` is a label and not a truth. That
// is what lets the read-back render without re-reading four modules, and what lets free
// text (which refers to nothing at all) live in the same field.
export interface KidsFocusAnswer {
  source: KidsFocusSource
  id: string | null
  emoji: string
  label: string
  detail: string | null
}
export interface KidsForwardAnswer {
  eventId: string | null
  emoji: string
  label: string
  when: string
}

export interface KidsCard {
  personId: string
  name: string
  avatarEmoji: string | null
  colorHex: string | null
  // Null when we have no birthday on file — the card drops the age rather than guessing.
  age: number | null
  // Null when the reward economy is off (it is funded by chores, so chores off ⇒ off).
  stars: number | null
  starsSymbol: string | null
  week: KidsWeekEvent[]
  chores: KidsWeekChore[]
  focusOptions: KidsFocusOption[]
  forwardOptions: KidsForwardOption[]
  focus: KidsFocusAnswer | null
  forward: KidsForwardAnswer | null
  // Both answered. Only then does the card flip to its read-back face — half an answer
  // is not the thing they'll remember.
  settled: boolean
}

export interface KidsStepView {
  weekStart: string
  kids: KidsCard[]
  // Which modules actually contributed, so an empty card can say why rather than looking
  // broken. Never a claim to have read a module that is off.
  sources: { goals: boolean; chores: boolean; rewards: boolean }
  // A previous session left answers that could be copied forward ("Same as last week").
  canRepeat: boolean
}

// ---------------------------------------------------------------------------
// Small shared bits
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_TEXT = 120
// Three is the mock's shape; four leaves room for step 1's triage to promote something
// without pushing a real option off the card. Beyond that a picker stops being readable
// to a six-year-old, which is the constraint this whole step is built around.
const MAX_FOCUS_OPTIONS = 4
const MAX_FORWARD_OPTIONS = 6

const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const WD_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const weekdayOf = (iso: string, short = true) =>
  (short ? WD_SHORT : WD)[new Date(`${iso.slice(0, 10)}T00:00:00Z`).getUTCDay()]

const fmtNum = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 })

const daysBetween = (fromIso: string, toIso: string) =>
  Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000)

async function householdPrefs(householdId: string): Promise<{ settings: unknown; timezone: string; today: string }> {
  const { rows } = await query<{ settings: unknown; timezone: string | null; today: string }>(
    `select settings, timezone, (now() at time zone timezone)::date::text as today
       from households where id = $1`,
    [householdId]
  )
  return {
    settings: rows[0]?.settings,
    timezone: (rows[0]?.timezone ?? '').trim() || 'UTC',
    today: rows[0]?.today ?? new Date().toISOString().slice(0, 10),
  }
}

const enabled = (settings: unknown, key: ModuleKey) => moduleEnabled(settings, key)

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Who is a kid
// ---------------------------------------------------------------------------

interface KidPerson {
  id: string
  name: string
  avatarEmoji: string | null
  colorHex: string | null
  age: number | null
}

// `member_type = 'kid'` is how the persons module says "child" (adult | teen | kid) — the
// age on the card is decoration, never the test, so a household that hasn't filled in a
// birthday still gets its cards. Teens are deliberately NOT here: type sized to be read
// by a six-year-old is the wrong screen for a fifteen-year-old, and including them is a
// one-line change if a family asks.
async function kidsOf(householdId: string): Promise<KidPerson[]> {
  const { rows } = await query<{
    id: string; name: string; avatar_emoji: string | null; color_hex: string | null; age: number | null
  }>(
    `select p.id, p.name, p.avatar_emoji, p.color_hex,
            case when p.birthday is null then null
                 else extract(year from age((now() at time zone h.timezone)::date, p.birthday))::int end as age
       from persons p join households h on h.id = p.household_id
      where p.household_id = $1 and p.deleted_at is null and p.member_type = 'kid'
      order by p.sort_order, p.created_at`,
    [householdId]
  )
  return rows.map((r) => ({ id: r.id, name: r.name, avatarEmoji: r.avatar_emoji, colorHex: r.color_hex, age: r.age }))
}

// ---------------------------------------------------------------------------
// Their week — events
// ---------------------------------------------------------------------------

// The week's events, once, then partitioned per kid. THE VIEWER IS THE DRIVER, never the
// kid: `visibleTo` is the calendar's privacy gate, and passing a kid's id would serve
// their personal-visibility events to whoever happens to be running the session.
async function weekEvents(householdId: string, weekStart: string, viewerPersonId: string | null) {
  const rows = await rangeEvents(householdId, weekStart, addDays(weekStart, 6), viewerPersonId)
  return rows.map(presentEvent).filter((e) => !MIRROR_ORIGINS.has(e.origin ?? ''))
}

// Planning a dinner mirrors it onto the calendar as a real event with the household on
// it, so without this every kid's week read "Dinner · chicken, Dinner · Spaghetti, …"
// and their look-forward-to options became the meal plan. Nobody is looking forward to
// Wednesday's spaghetti, and the Meals step already owns the week's dinners. The same
// exclusion `goal-calendar.ts` makes when it picks calendar events for a goal.
const MIRROR_ORIGINS = new Set(['meal_plan', 'meal_prep'])

type PresentedEvent = ReturnType<typeof presentEvent>

const eventIsFor = (e: PresentedEvent, personId: string) =>
  e.personId === personId || (e.participants ?? []).some((p) => p.id === personId)

// "Tue 4:00 PM" — the household's own zone, so a chip never names a day the family isn't
// living in. An all-day event has no time to give.
function eventWhen(e: PresentedEvent, timezone: string): string {
  const d = new Date(e.startsAt)
  const day = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(d)
  if (e.allDay) return day
  const time = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' }).format(d)
  return `${day} ${time}`
}

const eventDay = (e: PresentedEvent, timezone: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(new Date(e.startsAt))

// ---------------------------------------------------------------------------
// Their week — chores
// ---------------------------------------------------------------------------

// How a chore chip reads. Straight off the days the TASKS step already computed for this
// week, so the two boards can't disagree about which day a chore lands on.
function choreWhen(c: TasksBoardChore): string {
  if (c.days.length >= 7) return 'every day'
  if (c.days.length > 0) return c.days.map((d) => weekdayOf(d)).join(', ')
  if (c.carriedOver) return 'carried over'
  return c.dueOn ? weekdayOf(c.dueOn) : 'no day yet'
}

interface OverdueChore {
  choreId: string
  instanceId: string
  title: string
  emoji: string | null
  dueOn: string
}

// A kid's own chores that are STILL OPEN from before today. The predicate is deliberately
// the same one `overdueChores` uses in looseEnds.ts — pending or expired, not deleted,
// due before the household's own today, and 'awaiting' excluded because it has been done
// and is sitting in the approvals queue. Keep the two in sync: a kid seeing a different
// set of "still open" here than step 1 showed the grown-ups is the bug this note exists
// to prevent. What is NOT shared is the attribution — looseEnds reads the household, this
// reads one child, which is why it is a query and not an import.
async function overdueFor(householdId: string, today: string): Promise<Map<string, OverdueChore[]>> {
  const { rows } = await query<{
    person_id: string; instance_id: string; chore_id: string; title: string; emoji: string | null; due_on: string
  }>(
    `select coalesce(ci.person_id, c.person_id) as person_id,
            ci.id as instance_id, c.id as chore_id, c.title, c.emoji, ci.due_on::text as due_on
       from chore_instances ci
       join chores c on c.id = ci.chore_id and c.deleted_at is null
      where ci.household_id = $1
        and ci.deleted_at is null
        and ci.status in ('pending','expired')
        and ci.due_on < $2::date
        and coalesce(ci.person_id, c.person_id) is not null
      order by ci.due_on`,
    [householdId, today]
  )
  const out = new Map<string, OverdueChore[]>()
  for (const r of rows) {
    const list = out.get(r.person_id) ?? []
    list.push({ choreId: r.chore_id, instanceId: r.instance_id, title: r.title, emoji: r.emoji, dueOn: r.due_on })
    out.set(r.person_id, list)
  }
  return out
}

// "open since Wednesday" reads to a nine-year-old the way "4 days late" doesn't — but a
// weekday name stops being a date once it could mean either of two Wednesdays, so past a
// week it falls back to counting.
function lateLabel(dueOn: string, today: string): string {
  const n = daysBetween(dueOn, today)
  if (n <= 0) return 'due today'
  if (n === 1) return 'open since yesterday'
  if (n < 7) return `open since ${weekdayOf(dueOn, false)}`
  return `${n} days late`
}

// ---------------------------------------------------------------------------
// Their goals
// ---------------------------------------------------------------------------

// The goal's own axis, in words. Mirrors `goalDisplayProgress` / `goalDisplayTarget` on
// the client exactly — a habit is THIS PERIOD's count (which resets), a checklist is its
// steps, everything else the lifetime total. A sentence built off `totalProgress` for a
// habit would tell a kid they've read 99 times this week.
function goalDetail(g: Goal): string {
  if (g.goalType === 'habit') {
    const target = g.habitTargetPerPeriod ?? g.target ?? null
    const period = g.habitPeriod ?? 'week'
    const when = period === 'day' ? 'today' : `this ${period}`
    return target != null ? `${g.periodDone} of ${fmtNum(target)} ${when}` : `${g.periodDone} ${when}`
  }
  if (g.goalType === 'checklist') return `${g.stepDone} of ${g.stepTotal} steps`
  const unit = g.unit ? ` ${g.unit}` : ''
  if (g.target != null) return `${fmtNum(g.totalProgress)} of ${fmtNum(g.target)}${unit}`
  return `${fmtNum(g.totalProgress)}${unit} so far`
}

// 0..1 on the same axis, used only to sort the ones they're furthest behind on to the top.
function goalFraction(g: Goal): number {
  const p = g.goalType === 'habit' ? g.periodDone : g.goalType === 'checklist' ? g.stepDone : g.totalProgress
  const t = g.goalType === 'habit'
    ? (g.habitTargetPerPeriod ?? g.target)
    : g.goalType === 'checklist'
      ? (g.stepTotal || null)
      : g.target
  return t != null && t > 0 ? Math.min(p / t, 1) : 0
}

// The goals a kid may be shown, on THIS driver's screen. Two filters, and the second is
// the one that isn't obvious: `listGoals` does not enforce `goal_lists.is_private` (the
// goals step is the first place in the codebase that does), so a kid's goal sitting in a
// list private to the other parent would leak straight onto this card.
async function goalsPerKid(tenant: Tenant, kids: KidPerson[]): Promise<Map<string, Goal[]>> {
  const [lists, goals] = await Promise.all([listGoalLists(tenant.householdId), listGoals(tenant.householdId)])
  const visible = new Set(
    lists.filter((l) => !l.isPrivate || l.members.some((m) => m.personId === tenant.personId)).map((l) => l.id)
  )
  const out = new Map<string, Goal[]>()
  for (const k of kids) {
    const mine = goals
      .filter((g) => g.goalListId == null || visible.has(g.goalListId))
      .filter((g) => g.participants.some((p: { personId: string }) => p.personId === k.id))
      .sort((a, b) => goalFraction(a) - goalFraction(b) || a.title.localeCompare(b.title))
    out.set(k.id, mine)
  }
  return out
}

// ---------------------------------------------------------------------------
// What this session decided — the only thing the step stores
// ---------------------------------------------------------------------------

interface StoredAnswer {
  focus: KidsFocusAnswer | null
  forward: KidsForwardAnswer | null
}
type AnswerMap = Record<string, StoredAnswer>

const isFocusAnswer = (v: unknown): v is KidsFocusAnswer => {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return typeof r.label === 'string' && typeof r.source === 'string'
}
const isForwardAnswer = (v: unknown): v is KidsForwardAnswer => {
  if (!v || typeof v !== 'object') return false
  return typeof (v as Record<string, unknown>).label === 'string'
}

function parseAnswers(data: unknown): AnswerMap {
  const raw = (data as { kids?: unknown } | null)?.kids
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: AnswerMap = {}
  for (const [personId, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!UUID_RE.test(personId) || !v || typeof v !== 'object') continue
    const r = v as Record<string, unknown>
    out[personId] = {
      focus: isFocusAnswer(r.focus) ? r.focus : null,
      forward: isForwardAnswer(r.forward) ? r.forward : null,
    }
  }
  return out
}

// `runner` is the pool for a plain read, or the transaction's client when the map is
// about to be rewritten — reading it outside the transaction that updates it is how one
// kid's answer loses the other's (the same reasoning as the goals step's readFocus).
type Runner = Pick<PoolClient, 'query'> | null
async function readAnswers(sessionId: string, runner: Runner = null): Promise<AnswerMap> {
  const sql = `select data from planning_session_steps where session_id = $1 and step_key = $2`
  const { rows } = runner
    ? await runner.query<{ data: unknown }>(sql, [sessionId, STEP_KEY])
    : await query<{ data: unknown }>(sql, [sessionId, STEP_KEY])
  return parseAnswers(rows[0]?.data)
}

// Merge onto the step row WITHOUT claiming the step is answered: `status` and
// `decided_at` stay the shell's to set when somebody presses the primary, and `jsonb_set`
// keeps any other crumb the step may grow later.
//
// The shell REPLACES `data` when the primary is pressed, so the body mirrors this map
// back through `setDecisionData` — otherwise "Done" would wipe what this write persisted.
async function writeAnswers(client: Pick<PoolClient, 'query'>, sessionId: string, answers: AnswerMap): Promise<void> {
  await client.query(
    `insert into planning_session_steps (session_id, step_key, status, data)
     values ($1, $2, 'pending', jsonb_build_object('kids', $3::jsonb))
     on conflict (session_id, step_key)
       do update set data = jsonb_set(coalesce(planning_session_steps.data, '{}'::jsonb), '{kids}', $3::jsonb, true)`,
    [sessionId, STEP_KEY, JSON.stringify(answers)]
  )
}

// ---------------------------------------------------------------------------
// Building the options
// ---------------------------------------------------------------------------

const focusFromGoal = (g: Goal, routed: boolean): KidsFocusOption => ({
  key: `goal:${g.id}`,
  source: 'goal',
  id: g.id,
  emoji: g.emoji ?? '🎯',
  label: g.title,
  detail: goalDetail(g),
  routed,
  goal: g,
})

const focusFromOverdue = (c: OverdueChore, today: string, routed: boolean): KidsFocusOption => ({
  key: `chore:${c.choreId}`,
  source: 'chore',
  id: c.choreId,
  emoji: c.emoji ?? '🧹',
  label: c.title,
  detail: lateLabel(c.dueOn, today),
  routed,
  goal: null,
})

// A standing chore they already carry. NO detail line, on purpose — nothing is late and
// nothing is behind, so there is nothing to say. This is the mock's third option.
const focusFromRoutine = (c: TasksBoardChore, routed: boolean): KidsFocusOption => ({
  key: `chore:${c.id}`,
  source: 'routine',
  id: c.id,
  emoji: c.emoji ?? '🎒',
  label: c.title,
  detail: null,
  routed,
  goal: null,
})

// A countdown event is one the family has ALREADY said it is looking forward to — the
// calendar's own signal, so the card doesn't have to guess which of a kid's four
// commitments is the treat. Events carry no emoji of their own (see the report), so the
// rest get the same neutral marker rather than an invented one.
const forwardFromEvent = (e: PresentedEvent, timezone: string): KidsForwardOption => ({
  key: `event:${e.id}`,
  eventId: e.id,
  emoji: e.isCountdown ? '🎉' : '📅',
  label: e.title,
  when: eventDay(e, timezone),
})

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

export async function getKidsStepView(
  tenant: Tenant,
  weekStart: string,
  sessionId: string | null
): Promise<KidsStepView> {
  return (await buildKidsStep(tenant, weekStart, sessionId)).view
}

// The same read, plus the UNCAPPED set of ids that could legitimately be each kid's one
// thing. Only "same as last week" needs that second half — see `pool` below.
async function buildKidsStep(
  tenant: Tenant,
  weekStart: string,
  sessionId: string | null
): Promise<{ view: KidsStepView; allKeys: Map<string, Set<string>> }> {
  const { settings, timezone, today } = await householdPrefs(tenant.householdId)
  const goalsOn = enabled(settings, 'goals')
  const choresOn = enabled(settings, 'chores')
  const starsOn = rewardsEnabled(settings)

  const kids = await kidsOf(tenant.householdId)
  const allKeys = new Map<string, Set<string>>()
  if (kids.length === 0) {
    return {
      view: { weekStart, kids: [], sources: { goals: goalsOn, chores: choresOn, rewards: starsOn }, canRepeat: false },
      allKeys,
    }
  }

  const [events, board, overdue, goalsByKid, balances, answers, routes, canRepeat] = await Promise.all([
    weekEvents(tenant.householdId, weekStart, tenant.personId),
    choresOn ? getTasksBoard(tenant.householdId, weekStart) : Promise.resolve(null),
    choresOn ? overdueFor(tenant.householdId, today) : Promise.resolve(new Map<string, OverdueChore[]>()),
    goalsOn ? goalsPerKid(tenant, kids) : Promise.resolve(new Map<string, Goal[]>()),
    starsOn ? balancesSummary(tenant.householdId) : Promise.resolve(null),
    sessionId ? readAnswers(sessionId) : Promise.resolve({} as AnswerMap),
    sessionId ? listRoutes(sessionId) : Promise.resolve([]),
    priorAnswersExist(tenant.householdId, weekStart),
  ])

  // Step 1 routes; it does not resolve. What it sent HERE is a chore instance or a goal,
  // and both resolve to a person — a parked note or a list row does not, so those can't
  // be put on any one kid's card (see the report). Resolving to a `key` rather than to a
  // new option is what makes a route a PROMOTION: the row was already going to be there.
  const routedKeys = await resolveRoutedKeys(tenant.householdId, routes)
  const defaultSymbol = balances?.currencies.find((c) => c.isDefault)?.symbol ?? '⭐'

  const cards: KidsCard[] = kids.map((k) => {
    const mine = events.filter((e) => eventIsFor(e, k.id))
    const held = board?.people.find((p) => p.id === k.id)?.chores ?? []
    const late = overdue.get(k.id) ?? []
    const goals = goalsByKid.get(k.id) ?? []

    // Their week: what they're holding for it, plus what is still open from before it.
    // An overdue chore is as much a part of a kid's week as a scheduled one.
    const heldIds = new Set(held.map((c) => c.id))
    const chores: KidsWeekChore[] = [
      ...held.map((c) => ({ id: c.id, title: c.title, emoji: c.emoji, when: choreWhen(c), late: false })),
      ...late
        .filter((c) => !heldIds.has(c.choreId))
        .map((c) => ({ id: c.choreId, title: c.title, emoji: c.emoji, when: lateLabel(c.dueOn, today), late: true })),
    ]

    // EVERYTHING that could honestly be this kid's one thing, in priority order. The
    // card only ever shows the first few — a wall of options is unreadable to a
    // six-year-old — but the full list is what "same as last week" is validated
    // against, or a perfectly live goal would be dropped on the way forward just for
    // having slipped to third place this week.
    const pool = [
      ...goals.map((g) => focusFromGoal(g, routedKeys.has(`goal:${g.id}`))),
      ...late.map((c) => focusFromOverdue(c, today, routedKeys.has(`chore:${c.choreId}`))),
      ...held
        .filter((c) => c.cadence !== 'once' && !late.some((l) => l.choreId === c.id))
        .map((c) => focusFromRoutine(c, routedKeys.has(`chore:${c.id}`))),
    ]
    const seen = new Set<string>()
    const all = pool.filter((o) => (seen.has(o.key) ? false : (seen.add(o.key), true)))
    allKeys.set(k.id, new Set(all.map((o) => o.id).filter((id): id is string => id != null)))
    // What the card SHOWS: two from each of the two "something's up" sources and one
    // standing commitment — the mock's shape — with whatever step 1 triaged here pulled
    // to the top, so it isn't the option they have to scroll to.
    const focusOptions = [
      ...all.filter((o) => o.source === 'goal').slice(0, 2),
      ...all.filter((o) => o.source === 'chore').slice(0, 2),
      ...all.filter((o) => o.source === 'routine').slice(0, 1),
    ]
      .sort((a, b) => Number(b.routed) - Number(a.routed))
      .slice(0, MAX_FOCUS_OPTIONS)

    const forwardOptions = mine.slice(0, MAX_FORWARD_OPTIONS).map((e) => forwardFromEvent(e, timezone))

    const stored = answers[k.id]
    const focus = stored?.focus ?? null
    const forward = stored?.forward ?? null
    return {
      personId: k.id,
      name: k.name,
      avatarEmoji: k.avatarEmoji,
      colorHex: k.colorHex,
      age: k.age,
      stars: balances ? (balances.people.find((p) => p.personId === k.id)?.stars ?? 0) : null,
      starsSymbol: balances ? defaultSymbol : null,
      week: mine.map((e) => ({
        id: e.id,
        title: e.title,
        when: eventWhen(e, timezone),
        startsAt: e.startsAt instanceof Date ? e.startsAt.toISOString() : String(e.startsAt),
        allDay: e.allDay,
      })),
      chores,
      focusOptions,
      forwardOptions,
      focus,
      forward,
      settled: focus != null && forward != null,
    }
  })

  return {
    view: { weekStart, kids: cards, sources: { goals: goalsOn, chores: choresOn, rewards: starsOn }, canRepeat },
    allKeys,
  }
}

// A routed chore names a chore INSTANCE (that is what step 1's rows are), so it has to be
// mapped back to its definition before it can meet the option built from the same chore.
// Goals are already named by id. Everything else step 1 can route — a parked note, a list
// row, a rhythm — belongs to no particular child, and is left alone rather than shown on
// every card.
async function resolveRoutedKeys(
  householdId: string,
  routes: Awaited<ReturnType<typeof listRoutes>>
): Promise<Set<string>> {
  const mine = routes.filter((r) => r.to === STEP_KEY)
  const out = new Set<string>()
  const instanceIds: string[] = []
  for (const r of mine) {
    if (r.kind === 'goal') out.add(`goal:${r.id}`)
    else if (r.kind === 'chore' && UUID_RE.test(r.id)) instanceIds.push(r.id)
  }
  if (instanceIds.length) {
    const { rows } = await query<{ chore_id: string }>(
      `select chore_id from chore_instances where household_id = $1 and id = any($2::uuid[])`,
      [householdId, instanceIds]
    )
    for (const r of rows) out.add(`chore:${r.chore_id}`)
  }
  return out
}

// ---------------------------------------------------------------------------
// The write
// ---------------------------------------------------------------------------

// `{ key }` picks one of the offered options; `{ text }` is the "＋ Something else"
// escape hatch; `null` clears the answer; ABSENT leaves it alone (the two questions are
// answered one at a time, and a client sending only one must not erase the other).
export interface KidsAnswerInput {
  sessionId?: unknown
  personId?: unknown
  focus?: unknown
  forward?: unknown
}

export type KidsAnswerResult =
  | { ok: true; view: KidsStepView }
  | { ok: false; status: 400 | 404; message: string }

type Pick_ = { kind: 'clear' } | { kind: 'key'; key: string } | { kind: 'text'; text: string } | { kind: 'absent' }

function readPick(v: unknown): Pick_ | { kind: 'bad'; message: string } {
  if (v === undefined) return { kind: 'absent' }
  if (v === null) return { kind: 'clear' }
  if (!v || typeof v !== 'object') return { kind: 'bad', message: 'an answer is null, { key } or { text }' }
  const r = v as Record<string, unknown>
  if (typeof r.key === 'string' && r.key) return { kind: 'key', key: r.key }
  if (typeof r.text === 'string') {
    const text = r.text.trim()
    if (!text) return { kind: 'bad', message: 'that needs some words' }
    if (text.length > MAX_TEXT) return { kind: 'bad', message: `at most ${MAX_TEXT} characters` }
    return { kind: 'text', text }
  }
  return { kind: 'bad', message: 'an answer is null, { key } or { text }' }
}

export async function answerKid(tenant: Tenant, input: KidsAnswerInput): Promise<KidsAnswerResult> {
  const bad = (message: string): KidsAnswerResult => ({ ok: false, status: 400, message })
  if (typeof input.sessionId !== 'string' || !UUID_RE.test(input.sessionId)) return bad('sessionId must be a session id')
  if (typeof input.personId !== 'string' || !UUID_RE.test(input.personId)) return bad('personId must be a person id')
  const sessionId = input.sessionId
  const personId = input.personId

  const focusPick = readPick(input.focus)
  if (focusPick.kind === 'bad') return bad(focusPick.message)
  const forwardPick = readPick(input.forward)
  if (forwardPick.kind === 'bad') return bad(forwardPick.message)

  // THE WEEK COMES OFF THE SESSION, never off the request. A session may plan a week
  // further out than the default (the plan doc's family getting in front of a trip), and
  // a caller that omitted `weekStart` would then have its answer validated against a
  // different week's options — a perfectly real event rejected as "not one of this
  // week's". The session already knows which week it is about; nothing else may say.
  const session = await getSessionById(tenant.householdId, sessionId)
  if (!session) return { ok: false, status: 404, message: 'session not found' }
  const weekStart = session.weekStart

  // The view is what the write is validated against: an option this driver was never
  // offered (a private list's goal, another kid's chore) must not be settable by naming
  // its key. It also gives us the label snapshot to store.
  const view = await getKidsStepView(tenant, weekStart, sessionId)
  const card = view.kids.find((k) => k.personId === personId)
  // Same 404 for "no such person", "an adult" and "someone else's household" — this step
  // has nothing to say about anybody who isn't a child here.
  if (!card) return { ok: false, status: 404, message: 'no card for that person' }

  let focus: KidsFocusAnswer | null | undefined
  if (focusPick.kind === 'clear') focus = null
  else if (focusPick.kind === 'text') focus = { source: 'custom', id: null, emoji: '✨', label: focusPick.text, detail: null }
  else if (focusPick.kind === 'key') {
    const o = card.focusOptions.find((x) => x.key === focusPick.key)
    if (!o) return bad('that isn’t one of this week’s options')
    focus = { source: o.source, id: o.id, emoji: o.emoji, label: o.label, detail: o.detail }
  }

  let forward: KidsForwardAnswer | null | undefined
  if (forwardPick.kind === 'clear') forward = null
  else if (forwardPick.kind === 'text') forward = { eventId: null, emoji: '✨', label: forwardPick.text, when: '' }
  else if (forwardPick.kind === 'key') {
    const o = card.forwardOptions.find((x) => x.key === forwardPick.key)
    if (!o) return bad('that isn’t one of this week’s options')
    forward = { eventId: o.eventId, emoji: o.emoji, label: o.label, when: o.when }
  }

  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('begin')
    const answers = await readAnswers(sessionId, client)
    const current = answers[personId] ?? { focus: null, forward: null }
    answers[personId] = {
      focus: focus === undefined ? current.focus : focus,
      forward: forward === undefined ? current.forward : forward,
    }
    await writeAnswers(client, sessionId, answers)
    await client.query('commit')
  } catch (e) {
    await client.query('rollback')
    throw e
  } finally {
    client.release()
  }
  return { ok: true, view: await getKidsStepView(tenant, weekStart, sessionId) }
}

// ---------------------------------------------------------------------------
// "Same as last week"
// ---------------------------------------------------------------------------

// The most recent session BEFORE this week that left kids answers. Deliberately not
// `weekStart - 7`: a family that skips a week (or plans two ahead in one sitting) still
// has a last week, and it is whichever one they actually sat down for.
async function priorAnswers(householdId: string, weekStart: string): Promise<AnswerMap> {
  const { rows } = await query<{ data: unknown }>(
    `select st.data
       from planning_session_steps st
       join planning_sessions s on s.id = st.session_id
      where s.household_id = $1 and s.week_start < $2::date and st.step_key = $3
        and st.data ? 'kids'
      order by s.week_start desc
      limit 1`,
    [householdId, weekStart, STEP_KEY]
  )
  return rows[0] ? parseAnswers(rows[0].data) : {}
}

async function priorAnswersExist(householdId: string, weekStart: string): Promise<boolean> {
  return Object.values(await priorAnswers(householdId, weekStart)).some((a) => a.focus || a.forward)
}

export type KidsRepeatResult = { ok: true; view: KidsStepView } | { ok: false; status: 404; message: string }

// Copy last week's answers forward — but only the ones that still STAND. An answer naming
// a goal that has since been finished (or a chore already done, or an event that moved out
// of the week) would have the read-back proudly telling a kid to do something that is
// over, which is the one thing this frame must never do. Free text refers to nothing, so
// it copies verbatim.
export async function repeatLastWeek(tenant: Tenant, sessionId: unknown): Promise<KidsRepeatResult> {
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) {
    return { ok: false, status: 404, message: 'session not found' }
  }
  // The week is the SESSION's, for the same reason it is in `answerKid`.
  const session = await getSessionById(tenant.householdId, sessionId)
  if (!session) return { ok: false, status: 404, message: 'session not found' }
  const weekStart = session.weekStart

  const [prior, built] = await Promise.all([
    priorAnswers(tenant.householdId, weekStart),
    buildKidsStep(tenant, weekStart, sessionId),
  ])
  const { view, allKeys } = built

  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('begin')
    const answers = await readAnswers(sessionId, client)
    for (const card of view.kids) {
      const was = prior[card.personId]
      if (!was) continue
      const current = answers[card.personId] ?? { focus: null, forward: null }
      const focus = was.focus && stillStands(was.focus, allKeys.get(card.personId)) ? was.focus : null
      const forward = was.forward && (was.forward.eventId == null
        || card.forwardOptions.some((o) => o.eventId === was.forward!.eventId)) ? was.forward : null
      // ADDITIVE, strictly: a slot this session has already answered wins. The button is
      // a shortcut for the blank card, not a way to overwrite what a kid just said.
      answers[card.personId] = { focus: current.focus ?? focus, forward: current.forward ?? forward }
    }
    await writeAnswers(client, sessionId, answers)
    await client.query('commit')
  } catch (e) {
    await client.query('rollback')
    throw e
  } finally {
    client.release()
  }
  return { ok: true, view: await getKidsStepView(tenant, weekStart, sessionId) }
}

// Free text always stands (it names nothing that could have gone). Anything else has to
// still be one of the kid's own things — the same check as "is it still open?", because
// the options are built from what is open.
//
// Checked against the UNCAPPED set, not the four the card shows: a goal that is still
// live but has slipped to third place this week is not gone, and dropping it would have
// "same as last week" quietly report that last week decided nothing.
const stillStands = (focus: KidsFocusAnswer, all: Set<string> | undefined): boolean =>
  focus.source === 'custom' || (focus.id != null && !!all?.has(focus.id))
