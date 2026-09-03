import type createAPI from 'lambda-api'
import type { Request, Response } from 'lambda-api'
import { moduleRoutes } from '../../../platform/route-guards'
import { resolveWeekStart, getSessionById } from '../weeklyPlanning'
import { getKidsStepView, answerKid, repeatLastWeek } from './kids'

type Api = ReturnType<typeof createAPI>

// Step 9 · Kids — the reads this step needs over goals and chores, plus the two answers
// it records. Service logic (and the reasoning behind all of it) lives in ./kids.ts.
//
// GATED ONCE, not twice — and that is deliberate. The other module-reading steps assert
// their own module too (`requireModule(tenant, 'goals')` in step 6, `'chores'` in step 8)
// because the catalog marks them `requiresModule`. This step has NO `requiresModule`,
// because it reads goals AND chores and a household toggles those separately: gating on
// either would delete the step for a family that runs the other, and a kid's week is
// still a week with neither. So the routes carry the weeklyPlanning gate only, and the
// service contributes nothing per-source when a module is off (see `sources` on the view).
//
// WHICH WEEK. When a session is named, its OWN `week_start` decides — not the query
// string, and not the default. A session may plan a week further out than the default
// (the plan doc's family getting in front of a trip), and a client that forgot to echo
// `weekStart` would otherwise be answered with a different week's events, then told its
// perfectly real pick "isn't one of this week's options". `?weekStart=` still resolves
// the sessionless read, through the shell's own resolveWeekStart so the boundary stays
// server-owned (snapped and floored). A client never computes a week here.
const { tenantRoute } = moduleRoutes('weeklyPlanning')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const uuidOrNull = (v: unknown): string | null => (typeof v === 'string' && UUID_RE.test(v) ? v : null)

export function registerKidsStepRoutes(api: Api): void {
  // The whole read: a card per child, with their week, their stars, and the two sets of
  // options — both drawn from what already exists.
  api.get('/api/weekly-planning/kids', tenantRoute(async (tenant, req: Request) => {
    const sessionId = uuidOrNull(req.query?.sessionId)
    const session = sessionId ? await getSessionById(tenant.householdId, sessionId) : null
    const weekStart = session?.weekStart ?? (await resolveWeekStart(tenant.householdId, req.query?.weekStart))
    return getKidsStepView(tenant, weekStart, session ? sessionId : null)
  }))

  // Answer one card. Each question is sent on its own (`null` clears it, an omitted key
  // leaves it alone), because the two are answered one at a time at the board and a
  // client sending half an answer must not erase the other half.
  //
  // A REAL write, not `setDecisionData`: the read-back frame is the part the kids
  // remember, so it has to survive a remount, a refresh and the iPad picking up where
  // the phone left off.
  api.put('/api/weekly-planning/kids/answer', tenantRoute(async (tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const result = await answerKid(tenant, body)
    if (!result.ok) return res.status(result.status).json({ error: result.status === 404 ? 'NotFound' : 'BadRequest', message: result.message })
    return res.status(200).json(result.view)
  }))

  // "Same as last week" — copy the previous session's answers forward, keeping only the
  // ones whose referent still stands. Additive: it never clears an answer this session
  // has already given.
  api.post('/api/weekly-planning/kids/repeat', tenantRoute(async (tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const result = await repeatLastWeek(tenant, body.sessionId)
    if (!result.ok) return res.status(result.status).json({ error: 'NotFound', message: result.message })
    return res.status(200).json(result.view)
  }))
}
