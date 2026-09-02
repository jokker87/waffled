// Weekly Planning — the session that walks a household through deciding its week.
//
// The module owns almost no data. Nine of its ten steps READ modules that already
// exist (chores, lists, rhythms, events, familyNight, goals, meals) and write their
// decisions back into those modules; `planning_sessions` records only which week was
// planned, where the driver is, what each step answered and when it was finished.
// See docs/product/weekly-planning-plan.md.
//
// Config lives in households.settings.weeklyPlanning.
import { query } from '../../platform/db'
import { moduleEnabled, type ModuleKey } from '../../platform/modules'
import { householdWeekStart, snapToWeekStart, type FirstDayOfWeek } from '../lists/lists.service'
import type { Tenant } from '../households/households'

// ---------------------------------------------------------------------------
// The step catalog
// ---------------------------------------------------------------------------

// THE definition of the session: order, titles, the act each step belongs to, and the
// single question it asks. Server-owned on purpose — web and iOS both render this, and
// a client-side copy would drift the moment one platform reworded a question.
//
// Steps that aren't built yet are simply absent, which is what makes the module
// shippable one step at a time.
export interface StepDef {
  key: string
  title: string
  // The one question the step exists to answer, shown under the title.
  ask: string
  // The affirmative answer to `ask`, on the primary button ("Looks right", "Done").
  // Part of the catalog rather than the client because it is the other half of the
  // question — a step whose button says something the question didn't ask is a bug.
  primary: string
  // Grouping shown in the agenda sheet ("Act 2 · Frame the week").
  act: string
  // The optional module this step reads. When it's off the step has nothing to show,
  // so the session steps over it without anyone configuring that.
  requiresModule?: ModuleKey
}

export const STEPS: StepDef[] = [
  { key: 'looseEnds', title: 'Loose ends', ask: 'Anything still open from last week?', primary: 'All handled', act: 'Intake' },
  { key: 'calendar', title: 'Calendar', ask: 'Here’s your week. Anything missing?', primary: 'Looks right', act: 'Frame the week' },
  { key: 'horizon', title: 'Horizon scan', ask: 'Anything further out you should see now?', primary: 'Nothing missing', act: 'Frame the week' },
  { key: 'familyNight', title: 'Family night', ask: 'Accept the rotation, or change it?', primary: 'Accept', act: 'Claim the good', requiresModule: 'familyNight' },
  { key: 'connection', title: 'Connection', ask: 'Who gets time with whom?', primary: 'Done', act: 'Claim the good' },
  { key: 'goals', title: 'Goals', ask: 'What’s each group’s focus this week?', primary: 'Done', act: 'Claim the good', requiresModule: 'goals' },
  { key: 'meals', title: 'Meals', ask: 'What’s planned, and what’s still open?', primary: 'Done', act: 'Run the household', requiresModule: 'meals' },
  { key: 'tasks', title: 'Tasks', ask: 'Who’s doing what?', primary: 'Handed out', act: 'Run the household', requiresModule: 'chores' },
  { key: 'kids', title: 'Kids', ask: 'What’s your week about?', primary: 'Done', act: 'Run the household' },
  { key: 'recap', title: 'Recap', ask: 'Here’s the week you just decided.', primary: 'Save the week', act: 'Close' },
]

const STEP_KEYS = new Set(STEPS.map((s) => s.key))
export const isStepKey = (k: unknown): k is string => typeof k === 'string' && STEP_KEYS.has(k)

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface WeeklyPlanningConfig {
  // When the session happens. 0=Sunday … 6=Saturday. Drives the "session due" prompt;
  // it does NOT decide which week is planned (the server does — see plannedWeekStart).
  dayOfWeek: number
  time: string // 'HH:MM' local
  // Per-step opt-out, keyed by catalog key. Absent ⇒ on. A step whose module is off is
  // unavailable regardless of what's in here.
  steps: Record<string, boolean>
  // Show the "Sunday's session" prompt on Today (independent of the module toggle).
  showOnToday: boolean
}

const DEFAULT_CONFIG: WeeklyPlanningConfig = {
  dayOfWeek: 0, // Sunday — the session plans the week ahead
  time: '17:00',
  steps: {},
  showOnToday: true,
}

const clampDow = (n: number) => ((Math.trunc(n) % 7) + 7) % 7

export async function getConfig(householdId: string): Promise<WeeklyPlanningConfig> {
  const { rows } = await query<{ settings: { weeklyPlanning?: Partial<WeeklyPlanningConfig> } | null }>(
    `select settings from households where id = $1`,
    [householdId]
  )
  const c = rows[0]?.settings?.weeklyPlanning ?? {}
  const steps: Record<string, boolean> = {}
  if (c.steps && typeof c.steps === 'object') {
    for (const [k, v] of Object.entries(c.steps)) if (isStepKey(k) && typeof v === 'boolean') steps[k] = v
  }
  return {
    dayOfWeek: typeof c.dayOfWeek === 'number' ? clampDow(c.dayOfWeek) : DEFAULT_CONFIG.dayOfWeek,
    time: typeof c.time === 'string' && /^\d{2}:\d{2}$/.test(c.time) ? c.time : DEFAULT_CONFIG.time,
    steps,
    showOnToday: typeof c.showOnToday === 'boolean' ? c.showOnToday : DEFAULT_CONFIG.showOnToday,
  }
}

// Merge a patch into households.settings.weeklyPlanning (other settings keys preserved).
export async function setConfig(householdId: string, patch: Partial<WeeklyPlanningConfig>): Promise<WeeklyPlanningConfig> {
  await query(
    `update households
        set settings = coalesce(settings, '{}'::jsonb)
                       || jsonb_build_object('weeklyPlanning', coalesce(settings->'weeklyPlanning', '{}'::jsonb) || $2::jsonb)
      where id = $1`,
    [householdId, JSON.stringify(patch)]
  )
  return getConfig(householdId)
}

// ---------------------------------------------------------------------------
// Which week does a session plan?
// ---------------------------------------------------------------------------

// A planning session is about the week AHEAD, and the server owns that boundary: the
// household's first-day-of-week and timezone decide it, exactly as they do for grocery
// weeks and the meal planner.
//
// The rule: if today IS the household's week start, plan the week that begins today;
// otherwise plan the next one. So a Sunday session plans the seven days ahead whether
// the household starts its week on Sunday (this week) or Monday (tomorrow's week).
export async function plannedWeekStart(householdId: string): Promise<string> {
  const thisWeek = await householdWeekStart(householdId)
  const { rows } = await query<{ week_start: string; timezone: string | null }>(
    `select week_start, timezone from households where id = $1`,
    [householdId]
  )
  const firstDay: FirstDayOfWeek = rows[0]?.week_start === 'monday' ? 'monday' : 'sunday'
  const tz = (rows[0]?.timezone ?? '').trim() || 'UTC'
  const todayLocal = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  if (snapToWeekStart(todayLocal, firstDay) === todayLocal) return thisWeek
  return addDays(thisWeek, 7)
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

export interface SessionStep extends StepDef {
  number: number // 1-based position in the catalog (what "2 of 10" counts)
  // False ⇒ the step's module is off, or the household turned the step off. The
  // session steps over it and the agenda sheet doesn't list it.
  available: boolean
  status: 'pending' | 'done' | 'skipped'
  data: Record<string, unknown>
  decidedAt: string | null
}

export interface Session {
  id: string
  weekStart: string
  status: 'active' | 'completed'
  currentStep: string | null
  driverPersonId: string | null
  startedAt: string
  completedAt: string | null
}

export interface WeeklyPlanningView {
  config: WeeklyPlanningConfig
  // The week a session would plan right now (or the open session's own week).
  weekStart: string
  session: Session | null
  steps: SessionStep[]
}

interface SessionRow {
  id: string
  week_start: string | Date
  status: string
  current_step: string | null
  driver_person_id: string | null
  started_at: Date
  completed_at: Date | null
}

const isoDate = (v: string | Date) => (typeof v === 'string' ? v.slice(0, 10) : v.toISOString().slice(0, 10))

const toSession = (r: SessionRow): Session => ({
  id: r.id,
  weekStart: isoDate(r.week_start),
  status: r.status === 'completed' ? 'completed' : 'active',
  currentStep: r.current_step,
  driverPersonId: r.driver_person_id,
  startedAt: r.started_at.toISOString(),
  completedAt: r.completed_at ? r.completed_at.toISOString() : null,
})

async function findSession(householdId: string, weekStart: string): Promise<Session | null> {
  const { rows } = await query<SessionRow>(
    `select * from planning_sessions where household_id = $1 and week_start = $2`,
    [householdId, weekStart]
  )
  return rows[0] ? toSession(rows[0]) : null
}

export async function getSessionById(householdId: string, id: string): Promise<Session | null> {
  const { rows } = await query<SessionRow>(
    `select * from planning_sessions where household_id = $1 and id = $2`,
    [householdId, id]
  )
  return rows[0] ? toSession(rows[0]) : null
}

// Which steps this household actually runs, in catalog order. A step is available
// unless its module is off or the household opted out of it.
export async function resolveSteps(householdId: string, sessionId: string | null): Promise<SessionStep[]> {
  const [config, settingsRow, decisions] = await Promise.all([
    getConfig(householdId),
    query<{ settings: unknown }>(`select settings from households where id = $1`, [householdId]).then((r) => r.rows[0]?.settings),
    sessionId
      ? query<{ step_key: string; status: string; data: Record<string, unknown>; decided_at: Date }>(
          `select step_key, status, data, decided_at from planning_session_steps where session_id = $1`,
          [sessionId]
        ).then((r) => r.rows)
      : Promise.resolve([]),
  ])
  const byKey = new Map(decisions.map((d) => [d.step_key, d]))
  return STEPS.map((s, i) => {
    const moduleOn = s.requiresModule ? moduleEnabled(settingsRow, s.requiresModule) : true
    const turnedOff = config.steps[s.key] === false
    const d = byKey.get(s.key)
    return {
      ...s,
      number: i + 1,
      available: moduleOn && !turnedOff,
      status: d ? (d.status as SessionStep['status']) : 'pending',
      data: d?.data ?? {},
      decidedAt: d ? d.decided_at.toISOString() : null,
    }
  })
}

export const firstAvailableStep = (steps: SessionStep[]): string | null => steps.find((s) => s.available)?.key ?? null

// The read behind the module's landing screen: config, the week in question, the open
// session (if any) and every step with its availability and what it has decided.
export async function getView(householdId: string): Promise<WeeklyPlanningView> {
  const week = await plannedWeekStart(householdId)
  const session = await findSession(householdId, week)
  const [config, steps] = await Promise.all([getConfig(householdId), resolveSteps(householdId, session?.id ?? null)])
  return { config, weekStart: session ? session.weekStart : week, session, steps }
}

// Start the session for the planned week — or hand back the one that already exists,
// finished or not. Idempotent on purpose: "run the session" is a button somebody taps
// twice, and a second row for the same seven days would split the week's record.
export async function startSession(tenant: Tenant): Promise<Session> {
  const week = await plannedWeekStart(tenant.householdId)
  const existing = await findSession(tenant.householdId, week)
  if (existing) return existing
  const steps = await resolveSteps(tenant.householdId, null)
  const { rows } = await query<SessionRow>(
    `insert into planning_sessions (household_id, week_start, current_step, driver_person_id)
     values ($1, $2, $3, $4)
     on conflict (household_id, week_start) do update set current_step = planning_sessions.current_step
     returning *`,
    [tenant.householdId, week, firstAvailableStep(steps), tenant.personId]
  )
  return toSession(rows[0])
}

export interface SessionPatch {
  currentStep?: string
  status?: 'active' | 'completed'
}

// Move the driver, or reopen/finish the session. Reopening clears completed_at so the
// record never claims a finish time for a week still being decided.
export async function patchSession(householdId: string, id: string, patch: SessionPatch): Promise<Session | null> {
  const sets: string[] = []
  const params: unknown[] = [householdId, id]
  if (patch.currentStep !== undefined) {
    params.push(patch.currentStep)
    sets.push(`current_step = $${params.length}`)
  }
  if (patch.status !== undefined) {
    params.push(patch.status)
    sets.push(`status = $${params.length}`)
    sets.push(patch.status === 'completed' ? `completed_at = coalesce(completed_at, now())` : `completed_at = null`)
  }
  if (!sets.length) return getSessionById(householdId, id)
  const { rows } = await query<SessionRow>(
    `update planning_sessions set ${sets.join(', ')} where household_id = $1 and id = $2 returning *`,
    params
  )
  return rows[0] ? toSession(rows[0]) : null
}

export interface StepDecision {
  stepKey: string
  status: 'pending' | 'done' | 'skipped'
  data?: Record<string, unknown>
}

// Record what a step decided. Re-deciding overwrites: walking back to a step and
// answering differently is normal, and the session should hold one answer per step.
export async function decideStep(householdId: string, sessionId: string, input: StepDecision): Promise<SessionStep[] | null> {
  const session = await getSessionById(householdId, sessionId)
  if (!session) return null
  await query(
    `insert into planning_session_steps (session_id, step_key, status, data, decided_at)
     values ($1, $2, $3, $4::jsonb, now())
     on conflict (session_id, step_key)
       do update set status = excluded.status, data = excluded.data, decided_at = now()`,
    [sessionId, input.stepKey, input.status, JSON.stringify(input.data ?? {})]
  )
  return resolveSteps(householdId, sessionId)
}

// Finish the session. v4 step 10: "saving writes the session record with a timestamp;
// after that Today is the surface, not this session."
export async function completeSession(householdId: string, id: string): Promise<Session | null> {
  return patchSession(householdId, id, { status: 'completed' })
}
