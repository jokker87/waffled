import type createAPI from 'lambda-api'
import type { Request, Response } from 'lambda-api'
import { getSessionById } from '../weeklyPlanning'
import { moduleRoutes, requireModule } from '../../../platform/route-guards'
import { getGoalsStepView, setGroupFocus } from './goals'

type Api = ReturnType<typeof createAPI>

// Step 6 · Goals — the reads this step needs over goals and goal lists, plus the one
// write it makes: setting a group's focus, which is the goals module's existing
// `is_featured` flag. Service logic (and the privacy rule) lives in ./goals.ts.
//
// Gated TWICE on purpose: `moduleRoutes('weeklyPlanning')` puts the routes behind the
// module like the rest of the session, and `requireModule(tenant, 'goals')` matches the
// step catalog's `requiresModule: 'goals'` — a household with goals turned off has no
// step 6, so its endpoints must not answer either.
const { tenantRoute } = moduleRoutes('weeklyPlanning')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const uuidOrNull = (v: unknown): string | null => (typeof v === 'string' && UUID_RE.test(v) ? v : null)

export function registerGoalsStepRoutes(api: Api): void {
  // The step's whole read: one group per goal list the caller may see, each with its
  // goals (full progress fields, so the client's shared display helper picks the right
  // axis) and what this session has already settled for it.
  api.get('/api/weekly-planning/goals', tenantRoute(async (tenant, req: Request) => {
    await requireModule(tenant, 'goals')
    // Ownership, not just shape. `readFocus` reads `planning_session_steps` by session id
    // alone (that table is scoped only through `planning_sessions`), so a well-formed id
    // from another household would otherwise reach their goals-step data. Less to leak here than
    // step 1 had — goal ids that cannot match this household's lists — but the same hole, and
    // the same one-line guard the recap and kids reads use.
    const asked = uuidOrNull(req.query?.sessionId)
    const session = asked ? await getSessionById(tenant.householdId, asked) : null
    return getGoalsStepView(tenant, session ? asked : null)
  }))

  // Answer one group. `goalId: null` is the real answer "nothing this week" — it clears
  // the list's focus and still marks the group settled.
  api.put('/api/weekly-planning/goals/focus', tenantRoute(async (tenant, req: Request, res: Response) => {
    await requireModule(tenant, 'goals')
    const body = (req.body ?? {}) as { sessionId?: unknown; listId?: unknown; goalId?: unknown }
    const sessionId = uuidOrNull(body.sessionId)
    const listId = uuidOrNull(body.listId)
    if (!sessionId || !listId) {
      return res.status(400).json({ error: 'BadRequest', message: 'sessionId and listId are required' })
    }
    // Anything that isn't a goal id reads as "nothing this week" — the honest default
    // for a client that sends null, '' or omits the key entirely.
    const goalId = uuidOrNull(body.goalId)
    const result = await setGroupFocus(tenant, sessionId, listId, goalId)
    // One 404 for "no such session", "not your list", "that list is private and not
    // yours" and "that goal isn't in that list" — a private list must not be
    // distinguishable from one that doesn't exist.
    if (!result.ok) return res.status(404).json({ error: 'NotFound', message: 'not found' })
    return res.status(200).json(result.view)
  }))
}
