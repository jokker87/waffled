// Weekly Planning · step 1 "Loose ends" — service logic.
//
// STEP 1 IS INTAKE, NOT REPAIR. It ROUTES things to the steps that will handle them;
// it does not do the work. The mock says it outright on the see-all screen: "Routing
// here changes nothing in your modules — it only decides which step handles it." That
// is why the Tasks step later shows rows captioned "sent here in step 1".
//
// The step asks one question ("Anything still open from last week?") over two groups,
// and the distinction between them is the whole design:
//
//   NOT DONE is COMPUTED from the modules that already own the work — overdue
//     chore_instances, unchecked list_items, rhythms past due, habit goals short for
//     the week. Nobody typed those; they are simply still open, which is why there is
//     no lookback logic anywhere and no copy of them in any planning table. Its
//     destinations are Tasks / Calendar / Kids / Goals.
//
//   PARKED is what somebody wrote down during the week and that exists nowhere else
//     yet, so it gets the one table this step owns (0100_planning_parked_items). Same
//     card, different verbs — because a parked thing might turn out to be nothing,
//     which is why Drop is a real answer there and only there.
//
// TWO ANSWERS DO WRITE, and they are the exceptions that prove the rule: "It's done
// already" (the item was finished and its module should know) and "Drop it" (a parked
// note nobody wants, and dropping it destroys nothing but the note). Everything else
// is a routing decision recorded on the SESSION.
//
// WHERE ROUTES LIVE — the cross-step contract. `planning_session_steps.data` for the
// `looseEnds` step, as `{ routes: [{ kind, id, title, source, to }] }` with `to` a step
// key. No new table, and no shared file changes: every later step already receives the
// whole view, so step 2/6/8/9 read
// `steps.find(s => s.key === 'looseEnds').data.routes` and filter to their own key.
//
// A source module that is off contributes nothing, on the read AND on the write: the
// weeklyPlanning gate says nothing about whether chores or goals are enabled, and
// planning must not be a hole that reaches into a disabled module.
import { query } from '../../../platform/db'
import { moduleEnabled, type ModuleKey } from '../../../platform/modules'
import type { Tenant } from '../../households/households'
import { earliestWeekStart, isStepKey, resolveSteps, STEPS, getSessionById } from '../weeklyPlanning'
import { completeInstance, ProofRequiredError } from '../../chores/chores.service'
import { setItemChecked, softDeleteItem } from '../../lists/lists.service'
import { listAttention, completeRhythm, skipPeriod } from '../../rhythms/rhythms'
import { listGoals, logProgress } from '../../goals/goals.service'

// ---------------------------------------------------------------------------
// The shape the step reads
// ---------------------------------------------------------------------------

export type LooseEndKind = 'chore' | 'list' | 'rhythm' | 'goal' | 'parked'
export type LooseEndGroup = 'notDone' | 'parked'

// The two answers that actually WRITE. Routing is not one of them — it goes to the
// session, not to a module. Which of these an item offers is decided here, per item,
// rather than by the client guessing from `kind`: a chore that demands photo proof
// can't be completed from a session with no camera, and only a parked note can be
// dropped. A third answer, "leave it open" / "keep it parked", writes nothing at all
// and so lives entirely in the client — which is what keeps per-item state out of any
// planning table.
export type LooseEndAction = 'done' | 'drop'

export interface LooseEnd {
  // Stable across refetches, and unique across kinds — the client's list key and what
  // the deck remembers as already answered.
  key: string
  kind: LooseEndKind
  id: string
  title: string
  emoji: string | null
  // The one line under the title: how late, which list, how short, or — for a parked
  // note — who wrote it, how long ago, and how many sessions have passed it over.
  // Composed here so web and iOS say the same thing.
  detail: string | null
  actions: LooseEndAction[]
}

// A destination is a STEP, and the catalog of them is server-owned for the same reason
// the step catalog is: the label and the reason under it are the other half of the
// question, and a client copy would drift the moment one platform reworded it. A step
// whose module is off is filtered out here, so the card never offers a destination the
// session will skip over anyway.
export interface LooseEndDestination {
  to: string
  label: string
  hint: string
  primary?: boolean
}

// What step 1 routed, and where. Persisted on the session (see the header note); the
// shape later steps read.
export interface LooseEndRoute {
  kind: LooseEndKind
  id: string
  // The title AS IT READ WHEN ROUTED, so a later step can render the row without
  // re-reading four modules. A label, never a source of truth — the module still owns
  // the item, and the recap reads through to it.
  title: string
  // Which half of step 1 it came from.
  source: LooseEndGroup
  // The step that will handle it: a key from the server-owned catalog.
  to: string
}

export interface LooseEndsView {
  // The week being planned (already snapped and floored by the caller).
  weekStart: string
  notDone: LooseEnd[]
  parked: LooseEnd[]
  // The server's own tally of each group.
  counts: { notDone: number; parked: number }
  // Where each group's card can send an item, filtered to steps this household runs.
  destinations: { notDone: LooseEndDestination[]; parked: LooseEndDestination[] }
  // What has been routed in THIS session so far (empty without a session).
  routes: LooseEndRoute[]
  // Friendly names of the modules actually read, for the cleared state's "we checked…"
  // line. Reflects the household's toggles, so it never claims to have checked a
  // module that is off.
  sources: string[]
}

// A defensive ceiling per source. The step is a deck with a see-all escape hatch, so
// twenty items is by design — two thousand is a runaway module, and paging a deck is
// not a thing anyone asked for.
const PER_SOURCE_LIMIT = 200

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function householdSettings(householdId: string): Promise<unknown> {
  const { rows } = await query<{ settings: unknown }>(`select settings from households where id = $1`, [householdId])
  return rows[0]?.settings
}

const enabled = (settings: unknown, key: ModuleKey) => moduleEnabled(settings, key)

// Today, in the household's own zone. Every "is it late?" comparison below is against
// this and never the server's date — the same rule the rest of the codebase follows.
async function todayLocal(householdId: string): Promise<string> {
  const { rows } = await query<{ today: string }>(
    `select (now() at time zone timezone)::date::text as today from households where id = $1`,
    [householdId]
  )
  return rows[0]?.today ?? new Date().toISOString().slice(0, 10)
}

const daysBetween = (fromIso: string, toIso: string) =>
  Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000)

const lateBy = (n: number) => (n <= 0 ? 'Due today' : n === 1 ? '1 day late' : `${n} days late`)

function agoLabel(days: number): string {
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 14) return `${days} days ago`
  const weeks = Math.floor(days / 7)
  return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`
}

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

// Same card, different verbs. Group A is triage ("which step owns this?"); group B is
// a note that might still turn out to be nothing, so two of its four choices settle it
// here rather than sending it anywhere.
const DESTINATIONS: Record<LooseEndGroup, LooseEndDestination[]> = {
  notDone: [
    { to: 'tasks', label: 'Tasks', hint: 'Give it an owner and a day', primary: true },
    { to: 'calendar', label: 'Calendar', hint: 'It needs an appointment slot' },
    { to: 'kids', label: 'Kids', hint: "It's really one of the kids'" },
    { to: 'goals', label: 'Goals', hint: 'It belongs to a goal' },
  ],
  parked: [
    { to: 'tasks', label: 'Make it a task', hint: 'Someone owns it this week', primary: true },
    { to: 'calendar', label: 'Put it on the calendar', hint: 'A date to look, or a deadline' },
  ],
}

// Only steps this household actually runs. A destination pointing at a step the
// session skips over would route things into a void.
async function availableDestinations(
  householdId: string
): Promise<{ notDone: LooseEndDestination[]; parked: LooseEndDestination[] }> {
  const steps = await resolveSteps(householdId, null)
  const live = new Set(steps.filter((s) => s.available).map((s) => s.key))
  return {
    notDone: DESTINATIONS.notDone.filter((d) => live.has(d.to)),
    parked: DESTINATIONS.parked.filter((d) => live.has(d.to)),
  }
}

// ---------------------------------------------------------------------------
// "Not done" · the four reads
// ---------------------------------------------------------------------------

// Overdue chore instances. `awaiting` is excluded on purpose — it has been done and is
// sitting in the approvals queue, which is the approver's business, not the week's.
async function overdueChores(householdId: string, today: string): Promise<LooseEnd[]> {
  const { rows } = await query<{
    id: string
    due_on: string
    requires_photo: boolean
    title: string
    emoji: string | null
  }>(
    `select ci.id, ci.due_on::text as due_on, ci.requires_photo, c.title, c.emoji
       from chore_instances ci
       join chores c on c.id = ci.chore_id and c.deleted_at is null
      where ci.household_id = $1
        and ci.deleted_at is null
        and ci.status in ('pending','expired')
        and ci.due_on < $2::date
      order by ci.due_on
      limit ${PER_SOURCE_LIMIT}`,
    [householdId, today]
  )
  return rows.map((r) => ({
    key: `chore:${r.id}`,
    kind: 'chore' as const,
    id: r.id,
    title: r.title,
    emoji: r.emoji,
    detail: lateBy(daysBetween(r.due_on, today)),
    // No "it's done already" when the chore demands a photo: there is no camera in a
    // planning session, and completeInstance would (rightly) refuse. Route it instead.
    actions: (r.requires_photo ? [] : ['done']) as LooseEndAction[],
  }))
}

// Unchecked list items that were ALREADY open before this week began.
//
// The anchor is the household's CURRENT week start, not the week being planned. That
// distinction is load-bearing: the planned week is always today or later, so nothing
// that exists now was created after it — anchoring there filters nothing and the read
// floods with every unchecked row in the household. Anchored at the current week,
// "typed this week" is the week you are living in and "still unchecked from before it"
// is exactly what the step's question asks about.
async function staleListItems(householdId: string, currentWeek: string, plannedWeek: string): Promise<LooseEnd[]> {
  const { rows } = await query<{
    id: string
    name: string
    week_start: string | null
    list_name: string
    emoji: string | null
  }>(
    `select li.id, li.name, li.week_start::text as week_start, l.name as list_name, l.emoji
       from list_items li
       join lists l on l.id = li.list_id and l.deleted_at is null
       join households h on h.id = li.household_id
      where li.household_id = $1
        and li.deleted_at is null
        and li.checked = false
        -- 'suggested' rows are a proposal nobody has accepted; they are not open work.
        and li.status = 'active'
        and li.created_at < ($2::date::timestamp at time zone h.timezone)
        -- A grocery row keyed to the week being planned (or a later one) is this
        -- week's shopping, not last week's leftover. NULL = a global/manual row,
        -- which belongs to no week and so is judged on its age alone.
        and (li.week_start is null or li.week_start < $3::date)
      order by li.created_at
      limit ${PER_SOURCE_LIMIT}`,
    [householdId, currentWeek, plannedWeek]
  )
  return rows.map((r) => ({
    key: `list:${r.id}`,
    kind: 'list' as const,
    id: r.id,
    title: r.name,
    emoji: r.emoji,
    detail: `on ${r.list_name}`,
    actions: ['done'] as LooseEndAction[],
  }))
}

// Rhythms past due, straight off the rhythms module's own attention query — the one
// place that knows how period boundaries tile ("Today passes a one-day window, the
// weekly planner passes a week"). The horizon here is today: a rhythm that is not late
// yet is not a loose end, it is next week's problem.
async function rhythmsPastDue(householdId: string, today: string): Promise<LooseEnd[]> {
  const attention = await listAttention(householdId, today)
  const out: LooseEnd[] = []
  for (const item of attention) {
    if (item.kind === 'due') {
      if (!item.overdue) continue
      out.push({
        key: `rhythm:${item.rhythm.id}`,
        kind: 'rhythm',
        id: item.rhythm.id,
        title: item.rhythm.title,
        emoji: item.rhythm.emoji,
        detail: lateBy(daysBetween(item.dueAt.slice(0, 10), today)),
        actions: ['done'],
      })
    } else {
      out.push({
        key: `rhythm:${item.rhythm.id}`,
        kind: 'rhythm',
        id: item.rhythm.id,
        title: item.rhythm.title,
        emoji: item.rhythm.emoji,
        detail: 'Nothing booked for this period',
        // "It's done already" on an unbooked period means the period is settled —
        // which in the rhythms module is a period skip, not a completion.
        actions: ['done'],
      })
    }
  }
  return out.slice(0, PER_SOURCE_LIMIT)
}

// Habit goals short for the week. `periodDone` is the goals module's own read of the
// CURRENT period (distinct days logged), so nothing is recomputed here — see the
// "goal display axis" rule: a habit is this period's count, never a lifetime total.
async function shortHabits(householdId: string): Promise<LooseEnd[]> {
  const goals = await listGoals(householdId)
  return goals
    .filter((g) => g.goalType === 'habit' && g.habitPeriod === 'week')
    .filter((g) => g.periodDone < Math.max(1, g.habitTargetPerPeriod ?? 1))
    .slice(0, PER_SOURCE_LIMIT)
    .map((g) => ({
      key: `goal:${g.id}`,
      kind: 'goal' as const,
      id: g.id,
      title: g.title,
      emoji: g.emoji,
      detail: `${g.periodDone} of ${Math.max(1, g.habitTargetPerPeriod ?? 1)} this week`,
      actions: ['done'] as LooseEndAction[],
    }))
}

// ---------------------------------------------------------------------------
// "Parked" · the one group with a table
// ---------------------------------------------------------------------------

export interface ParkedItem {
  id: string
  note: string
  stepKey: string | null
  status: 'open' | 'resolved' | 'dropped'
  sessionId: string | null
  createdAt: string
}

interface ParkedRow {
  id: string
  note: string
  step_key: string | null
  status: string
  session_id: string | null
  created_at: Date
}

const toParked = (r: ParkedRow): ParkedItem => ({
  id: r.id,
  note: r.note,
  stepKey: r.step_key,
  status: r.status === 'resolved' ? 'resolved' : r.status === 'dropped' ? 'dropped' : 'open',
  sessionId: r.session_id,
  createdAt: r.created_at.toISOString(),
})

export async function listParked(householdId: string): Promise<LooseEnd[]> {
  const { rows } = await query<ParkedRow & { parker: string | null; age_days: number; passed_over: number }>(
    `select pi.id, pi.note, pi.step_key, pi.status, pi.session_id, pi.created_at,
            p.name as parker,
            greatest(0, (now()::date - pi.created_at::date)) as age_days,
            -- "Passed over N times": how many planning sessions have FINISHED since
            -- somebody wrote this down. Derived rather than counted into a column —
            -- a counter would need something to advance it, and nothing here runs on
            -- a timer (the same reasoning as the rhythms period grid).
            (select count(*) from planning_sessions s
              where s.household_id = pi.household_id
                and s.status = 'completed'
                and s.completed_at > pi.created_at) as passed_over
       from planning_parked_items pi
       left join persons p on p.id = pi.created_by and p.deleted_at is null
      where pi.household_id = $1 and pi.status = 'open'
      order by pi.created_at
      limit ${PER_SOURCE_LIMIT}`,
    [householdId]
  )
  return rows.map((r) => {
    const bits = [r.parker ? `Parked by ${r.parker}` : 'Parked', agoLabel(Number(r.age_days))]
    const passed = Number(r.passed_over)
    // The line has to earn the "Drop it" underneath it: a note three sessions have
    // walked past is the strongest argument that it was never really a thing.
    if (passed > 0) bits.push(passed === 1 ? 'passed over once' : `passed over ${passed} times`)
    return {
      key: `parked:${r.id}`,
      kind: 'parked' as const,
      id: r.id,
      title: r.note,
      emoji: null,
      detail: bits.join(' · '),
      // 'done' is "Talk about it now" — two minutes and it is settled here; 'drop' is
      // the answer only this group can take, because the note exists nowhere else.
      actions: ['done', 'drop'] as LooseEndAction[],
    }
  })
}

export interface ParkInput {
  note?: unknown
  // Optional tag naming the step this note belongs to. Step 1's capture bar leaves it
  // null; step 3 ("Horizon scan") parks with 'horizon'; routing a parked note sets it
  // to the step that will handle it. Validated against the server-owned catalog so a
  // typo can't create a tag nothing will ever match.
  stepKey?: unknown
  // The session it was parked during, if any. Optional, and the row survives that
  // session being discarded (on delete set null) — see the migration.
  sessionId?: unknown
}

export type ParkResult =
  | { ok: true; item: ParkedItem }
  | { ok: false; status: 400; error: string; message: string }

const MAX_NOTE = 500

// Park a note. Step 1's capture bar writes here ("Drop something new on the board —
// one line is enough"), and so does step 3, which parks from the month view with a
// `stepKey`. The table and this function are deliberately general so a later surface
// can write to them without a migration or a change to this file.
export async function parkItem(tenant: Tenant, input: ParkInput): Promise<ParkResult> {
  const note = typeof input.note === 'string' ? input.note.trim() : ''
  if (!note) return { ok: false, status: 400, error: 'BadRequest', message: 'a parked item needs a note' }
  if (note.length > MAX_NOTE) {
    return { ok: false, status: 400, error: 'BadRequest', message: `a note is at most ${MAX_NOTE} characters` }
  }
  let stepKey: string | null = null
  if (input.stepKey !== undefined && input.stepKey !== null) {
    if (!isStepKey(input.stepKey)) return { ok: false, status: 400, error: 'BadRequest', message: 'unknown step' }
    stepKey = input.stepKey
  }
  let sessionId: string | null = null
  if (input.sessionId !== undefined && input.sessionId !== null) {
    if (typeof input.sessionId !== 'string' || !UUID_RE.test(input.sessionId)) {
      return { ok: false, status: 400, error: 'BadRequest', message: 'sessionId must be a session id' }
    }
    // Household-scoped: a session id from somewhere else must not be recorded here.
    if (!(await getSessionById(tenant.householdId, input.sessionId))) {
      return { ok: false, status: 400, error: 'BadRequest', message: 'session not found' }
    }
    sessionId = input.sessionId
  }
  const { rows } = await query<ParkedRow>(
    `insert into planning_parked_items (household_id, note, step_key, session_id, created_by)
     values ($1, $2, $3, $4, $5)
     returning id, note, step_key, status, session_id, created_at`,
    [tenant.householdId, note, stepKey, sessionId, tenant.personId]
  )
  return { ok: true, item: toParked(rows[0]) }
}

// ---------------------------------------------------------------------------
// Routes — the cross-step contract
// ---------------------------------------------------------------------------

const isRoute = (v: unknown): v is LooseEndRoute => {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return typeof r.kind === 'string' && typeof r.id === 'string' && typeof r.to === 'string'
}

// Read what step 1 has routed in this session. Later steps get the same array off the
// session view (`steps.find(s => s.key === 'looseEnds').data.routes`) and never call
// this — it exists so step 1's own read is self-contained.
export async function listRoutes(sessionId: string): Promise<LooseEndRoute[]> {
  const { rows } = await query<{ data: { routes?: unknown } | null }>(
    `select data from planning_session_steps where session_id = $1 and step_key = 'looseEnds'`,
    [sessionId]
  )
  const raw = rows[0]?.data?.routes
  return Array.isArray(raw) ? raw.filter(isRoute) : []
}

// Replace the whole array on the step's `data`, preserving any other key the shell put
// there. Single-driver by design (v4 dropped the lobby and join code), so a
// read-modify-write here is safe; `planning_sessions.driver_person_id` is the seam if
// that ever stops being true.
async function writeRoutes(sessionId: string, routes: LooseEndRoute[]): Promise<void> {
  await query(
    `insert into planning_session_steps (session_id, step_key, status, data, decided_at)
     values ($1, 'looseEnds', 'pending', jsonb_build_object('routes', $2::jsonb), now())
     on conflict (session_id, step_key)
       -- Only the routes key. The step's STATUS is the shell's to set when somebody
       -- answers the step, and clobbering it here would mark a step decided that
       -- nobody has finished.
       do update set data = coalesce(planning_session_steps.data, '{}'::jsonb)
                            || jsonb_build_object('routes', $2::jsonb)`,
    [sessionId, JSON.stringify(routes)]
  )
}

export interface RouteInput {
  sessionId?: unknown
  kind?: unknown
  id?: unknown
  title?: unknown
  source?: unknown
  // The step that will handle it — or null to undo the routing.
  to?: unknown
}

export type RouteResult =
  | { ok: true; routes: LooseEndRoute[] }
  | { ok: false; status: 400 | 404; error: string; message: string }

const KINDS: LooseEndKind[] = ['chore', 'list', 'rhythm', 'goal', 'parked']
const GROUPS: LooseEndGroup[] = ['notDone', 'parked']

// Route an item to the step that will handle it — or un-route it (`to: null`), which
// is what the undo trail under the card calls.
//
// THIS WRITES NOTHING TO ANY MODULE. The overdue chore stays overdue, the unchecked
// item stays unchecked; all that changes is which step will be looking at it. The one
// exception is a PARKED note, whose `step_key` is set here — that column names the step
// a note belongs to, and this is the other half of what it is for.
export async function routeLooseEnd(tenant: Tenant, input: RouteInput): Promise<RouteResult> {
  const bad400 = (message: string): RouteResult => ({ ok: false, status: 400, error: 'BadRequest', message })

  if (typeof input.sessionId !== 'string' || !UUID_RE.test(input.sessionId)) return bad400('sessionId must be a session id')
  const session = await getSessionById(tenant.householdId, input.sessionId)
  if (!session) return { ok: false, status: 404, error: 'NotFound', message: 'session not found' }

  const kind = KINDS.find((k) => k === input.kind)
  if (!kind) return bad400('kind must be one of chore, list, rhythm, goal, parked')
  if (typeof input.id !== 'string' || !UUID_RE.test(input.id)) return bad400('id must be a uuid')
  const id = input.id

  const routes = (await listRoutes(session.id)).filter((r) => !(r.kind === kind && r.id === id))

  // Undo: drop the entry, and give a parked note its tag back.
  if (input.to === null || input.to === undefined) {
    await writeRoutes(session.id, routes)
    if (kind === 'parked') await setParkedStepKey(tenant.householdId, id, null)
    return { ok: true, routes }
  }

  if (!isStepKey(input.to)) return bad400('unknown step')
  const to = input.to
  if (to === 'looseEnds') return bad400('a loose end cannot be routed to the step it came from')
  const steps = await resolveSteps(tenant.householdId, null)
  if (!steps.some((s) => s.key === to && s.available)) {
    return bad400(`the ${to} step is not running in this household`)
  }
  const source = GROUPS.find((g) => g === input.source) ?? (kind === 'parked' ? 'parked' : 'notDone')
  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim().slice(0, MAX_NOTE) : ''
  if (!title) return bad400('a route needs the title it was routed under')

  if (kind === 'parked' && !(await setParkedStepKey(tenant.householdId, id, to))) {
    return { ok: false, status: 404, error: 'NotFound', message: 'loose end not found' }
  }

  const next = [...routes, { kind, id, title, source, to }]
  await writeRoutes(session.id, next)
  return { ok: true, routes: next }
}

async function setParkedStepKey(householdId: string, id: string, stepKey: string | null): Promise<boolean> {
  const { rowCount } = await query(
    `update planning_parked_items set step_key = $3 where household_id = $1 and id = $2 and status = 'open'`,
    [householdId, id, stepKey]
  )
  return !!rowCount
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

// Friendly names for the cleared state's "we checked…" line, in read order.
const SOURCE_LABELS: [ModuleKey, string][] = [
  ['chores', 'chores'],
  ['lists', 'lists'],
  ['rhythms', 'rhythms'],
  ['goals', 'goals'],
]

export async function getLooseEnds(householdId: string, weekStart: string, sessionId?: string | null): Promise<LooseEndsView> {
  const [settings, today, currentWeek, destinations] = await Promise.all([
    householdSettings(householdId),
    todayLocal(householdId),
    earliestWeekStart(householdId),
    availableDestinations(householdId),
  ])
  const [chores, lists, rhythms, goals, parked, routes] = await Promise.all([
    enabled(settings, 'chores') ? overdueChores(householdId, today) : Promise.resolve([]),
    enabled(settings, 'lists') ? staleListItems(householdId, currentWeek, weekStart) : Promise.resolve([]),
    enabled(settings, 'rhythms') ? rhythmsPastDue(householdId, today) : Promise.resolve([]),
    enabled(settings, 'goals') ? shortHabits(householdId) : Promise.resolve([]),
    listParked(householdId),
    sessionId ? listRoutes(sessionId) : Promise.resolve([]),
  ])
  // Chores first, then the week's shopping, then the slow-burning maintenance, then
  // the habits: roughly most-urgent to least, which is the order the deck walks.
  const notDone = [...chores, ...lists, ...rhythms, ...goals]
  return {
    weekStart,
    notDone,
    parked,
    counts: { notDone: notDone.length, parked: parked.length },
    destinations,
    routes,
    sources: SOURCE_LABELS.filter(([k]) => enabled(settings, k)).map(([, label]) => label),
  }
}

// ---------------------------------------------------------------------------
// The two answers that write
// ---------------------------------------------------------------------------

export interface ResolveInput {
  kind?: unknown
  id?: unknown
  action?: unknown
  // Optional, and it exists to keep the routes contract honest: an item that has been
  // settled must not stay in `data.routes`, or a later step would render a row for a
  // chore its own module already considers done. Given a session, the item's route
  // entry is retired here. Absent (a resolve from outside a session) there is nothing
  // to retire.
  sessionId?: unknown
}

export type ResolveResult =
  | { ok: true; kind: LooseEndKind; id: string; action: LooseEndAction }
  | { ok: false; status: 400 | 403 | 404; error: string; message: string }

const ACTIONS: LooseEndAction[] = ['done', 'drop']

// Which optional module owns each kind. `parked` has none — it is ours, and it is the
// only kind that needs no second gate.
const OWNER: Record<LooseEndKind, ModuleKey | null> = {
  chore: 'chores',
  list: 'lists',
  rhythm: 'rhythms',
  goal: 'goals',
  parked: null,
}

const bad = (message: string): ResolveResult => ({ ok: false, status: 400, error: 'BadRequest', message })
const missing = (): ResolveResult => ({ ok: false, status: 404, error: 'NotFound', message: 'loose end not found' })
const wrongAction = (kind: string, action: string): ResolveResult =>
  ({ ok: false, status: 400, error: 'BadRequest', message: `a ${kind} cannot be resolved with "${action}"` })

// The exceptions to "step 1 changes nothing": "It's done already" (`done`) and, for a
// parked note only, "Drop it" (`drop`). Both are writes into the thing that owns the
// item — the module for a computed one, our own table for a note.
export async function resolveLooseEnd(tenant: Tenant, input: ResolveInput): Promise<ResolveResult> {
  const kind = KINDS.find((k) => k === input.kind)
  if (!kind) return bad('kind must be one of chore, list, rhythm, goal, parked')
  const action = ACTIONS.find((a) => a === input.action)
  if (!action) return bad('action must be one of done, drop')
  if (typeof input.id !== 'string' || !UUID_RE.test(input.id)) return bad('id must be a uuid')
  const id = input.id
  if (action === 'drop' && kind !== 'parked') {
    // Dropping a computed item would mean deleting another module's data, which is
    // exactly what routing exists to avoid.
    return wrongAction(kind, 'drop')
  }

  // The module gate, again. `moduleRoutes('weeklyPlanning')` says only that planning is
  // on; it says nothing about chores or goals, and a session that could write into a
  // module the household turned off would be a hole straight through the toggle.
  const owner = OWNER[kind]
  if (owner && !enabled(await householdSettings(tenant.householdId), owner)) {
    return { ok: false, status: 403, error: 'Forbidden', message: `The ${owner} module is not enabled` }
  }

  // A settled item is finished, so it stops being routed anywhere. Doing this on the
  // WRITE side rather than asking every consumer to re-check four modules is the whole
  // reason the routes array is a decision log and not a queue.
  const retire = async (): Promise<ResolveResult> => {
    if (typeof input.sessionId === 'string' && UUID_RE.test(input.sessionId)) {
      const session = await getSessionById(tenant.householdId, input.sessionId)
      if (session) {
        const routes = await listRoutes(session.id)
        const next = routes.filter((r) => !(r.kind === kind && r.id === id))
        if (next.length !== routes.length) await writeRoutes(session.id, next)
      }
    }
    return { ok: true, kind, id, action }
  }

  switch (kind) {
    case 'chore':
      return (await resolveChore(tenant, id)) ?? (await retire())
    case 'list':
      return (await resolveListItem(tenant, id)) ?? (await retire())
    case 'rhythm':
      return (await resolveRhythm(tenant, id)) ?? (await retire())
    case 'goal':
      return (await resolveGoal(tenant, id)) ?? (await retire())
    case 'parked':
      return (await resolveParked(tenant, id, action)) ?? (await retire())
  }
}

// Each helper returns a ResolveResult only when something went wrong; null means "the
// module took the write" and the caller reports success.

async function resolveChore(tenant: Tenant, id: string): Promise<ResolveResult | null> {
  const { rows } = await query<{ id: string }>(
    `select id from chore_instances where household_id = $1 and id = $2 and deleted_at is null`,
    [tenant.householdId, id]
  )
  if (!rows[0]) return missing()
  try {
    return (await completeInstance(tenant, id)) ? null : missing()
  } catch (err) {
    // A chore that wants photo proof can't be completed from here — there is no camera
    // in a planning session. The read already withholds the answer for these; this is
    // the honest reply when something asks anyway.
    if (err instanceof ProofRequiredError) {
      return { ok: false, status: 400, error: 'ProofRequired', message: 'this chore needs a photo — complete it on the Tasks board' }
    }
    throw err
  }
}

async function resolveListItem(tenant: Tenant, id: string): Promise<ResolveResult | null> {
  return (await setItemChecked(tenant, id, true)) ? null : missing()
}

async function resolveRhythm(tenant: Tenant, id: string): Promise<ResolveResult | null> {
  const { rows } = await query<{ satisfied_by: string }>(
    `select satisfied_by from rhythms where household_id = $1 and id = $2 and deleted_at is null`,
    [tenant.householdId, id]
  )
  if (!rows[0]) return missing()
  if (rows[0].satisfied_by === 'completion') {
    return (await completeRhythm(tenant.householdId, id, tenant.personId, null, null)) ? null : missing()
  }

  // A scheduling rhythm is satisfied by an event existing, so "it's done already" on an
  // unbooked period means the period is settled — a skip. skipPeriod validates the
  // boundary hard and a date that is not one silences nothing while still reporting
  // success, so the period start is re-derived from the rhythms module's own tiling and
  // never taken from a client, whose idea of the boundary may be a render old.
  const today = await todayLocal(tenant.householdId)
  const attention = await listAttention(tenant.householdId, today)
  const item = attention.find((a) => a.kind === 'unscheduled' && a.rhythm.id === id)
  if (!item || item.kind !== 'unscheduled') {
    return { ok: false, status: 400, error: 'nothing-to-settle', message: 'this rhythm has no open period to settle' }
  }
  await skipPeriod(tenant.householdId, id, item.periodStart, tenant.personId)
  return null
}

async function resolveGoal(tenant: Tenant, id: string): Promise<ResolveResult | null> {
  const { rows } = await query<{ id: string }>(
    `select id from goals where household_id = $1 and id = $2 and deleted_at is null and is_active`,
    [tenant.householdId, id]
  )
  if (!rows[0]) return missing()
  // One, against the household (no person) — the same amount a habit tick is worth
  // anywhere else. `source` says where it came from so the goal's activity feed can
  // tell a planning catch-up from a tap on the card.
  await logProgress(tenant, id, 1, [null], null, { source: 'weekly_planning' })
  return null
}

async function resolveParked(tenant: Tenant, id: string, action: LooseEndAction): Promise<ResolveResult | null> {
  // 'done' is the card's "Talk about it now" — two minutes in the session and the note
  // is answered. 'drop' is "it was never really a thing".
  const status = action === 'done' ? 'resolved' : 'dropped'
  const { rowCount } = await query(
    `update planning_parked_items
        set status = $3, resolved_at = now(), resolved_by = $4
      where household_id = $1 and id = $2 and status = 'open'`,
    [tenant.householdId, id, status, tenant.personId]
  )
  return rowCount ? null : missing()
}
