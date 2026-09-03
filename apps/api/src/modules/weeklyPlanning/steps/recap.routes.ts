import type createAPI from 'lambda-api'
import type { Request } from 'lambda-api'
import { moduleRoutes } from '../../../platform/route-guards'
import { resolveWeekStart, getSessionById } from '../weeklyPlanning'
import { getRecap } from './recap'

type Api = ReturnType<typeof createAPI>

// Step 10 · Recap — ONE read, and it writes nothing at all.
//
// There is no recap endpoint that changes anything, because the step changes nothing:
// saving the week is the SHELL's `POST /session/:id/complete`, and every line the recap
// shows is already live in the module that owns it. A write here would be the step
// making a second copy of somebody else's decision, which is the exact thing the design
// forbids ("every line is a pointer rather than a copy").
//
// GATED ONCE, like step 9 and for the same reason. The catalog gives `recap` no
// `requiresModule` — it reads ACROSS the modules, so gating it on any single one would
// delete the close of the session for a household that runs the others, and a week is
// still a week with all of them off. So the routes carry the weeklyPlanning gate only,
// and the service simply contributes no group for a module that is off (it never claims
// to have read one — the `sources` rule step 1 and step 9 both follow).
//
// WHICH WEEK. When a session is named, its OWN `week_start` decides — not the query
// string and not the default. A session may plan a week further out than the default,
// and answering with a different week's events would have the last screen of the
// session read back a week nobody planned. `?weekStart=` still resolves the sessionless
// read, through the shell's `resolveWeekStart` so the boundary stays server-owned
// (snapped and floored). A client never computes a week here.
const { tenantRoute } = moduleRoutes('weeklyPlanning')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const uuidOrNull = (v: unknown): string | null => (typeof v === 'string' && UUID_RE.test(v) ? v : null)

export function registerRecapStepRoutes(api: Api): void {
  api.get('/api/weekly-planning/recap', tenantRoute(async (tenant, req: Request) => {
    const sessionId = uuidOrNull(req.query?.sessionId)
    // Household-scoped: a session id from somewhere else must resolve to no session at
    // all rather than to another family's week.
    const session = sessionId ? await getSessionById(tenant.householdId, sessionId) : null
    const weekStart = session?.weekStart ?? (await resolveWeekStart(tenant.householdId, req.query?.weekStart))
    return getRecap(tenant, weekStart, session)
  }))
}
