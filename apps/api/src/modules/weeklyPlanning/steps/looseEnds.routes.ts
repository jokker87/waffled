import type createAPI from 'lambda-api'
import type { Request, Response } from 'lambda-api'
import { moduleRoutes } from '../../../platform/route-guards'
import { resolveWeekStart } from '../weeklyPlanning'
import { getLooseEnds, parkItem, resolveLooseEnd, routeLooseEnd } from './looseEnds'

type Api = ReturnType<typeof createAPI>

// Step 1 · Loose ends — the reads this step needs over chores, lists, rhythms and
// goals, plus the one table it owns (planning_parked_items).
//
// Four routes and no more. The step is INTAKE: its main verb is `route`, which writes
// nothing to any module and only records — on the session — which step will handle the
// item. `resolve` is the two exceptions ("It's done already", and "Drop it" on a
// parked note); `parked` is the capture bar. There is no per-item "seen it" route on
// purpose — leaving something open writes nothing, so it lives in the client and never
// becomes a row here.
//
// Registered from ./index.ts; weeklyPlanning.routes.ts is never edited to add a route.
// Every route is behind the module gate; the resolve path checks the SOURCE module's
// own toggle as well (see resolveLooseEnd) so planning can't write into a module the
// household turned off.
const { tenantRoute } = moduleRoutes('weeklyPlanning')

export function registerLooseEndsStepRoutes(api: Api): void {
  // Both groups for the week being planned, the destinations each group can send an
  // item to, and what this session has routed so far. `?weekStart=` goes through the
  // same one gate as the rest of the module (snapped to a household week start,
  // floored at the current week) so a step can never be asked about a week the session
  // can't plan. `?sessionId=` is what makes the read self-contained — the shell also
  // hands the step its persisted `data`, but a route that can answer for itself is far
  // easier to reason about and to test.
  api.get('/api/weekly-planning/loose-ends', tenantRoute(async (tenant, req: Request) => {
    const weekStart = await resolveWeekStart(tenant.householdId, req.query?.weekStart)
    return getLooseEnds(tenant.householdId, weekStart, req.query?.sessionId ?? null)
  }))

  // THE STEP'S MAIN VERB. Send an item to the step that will handle it — or `to: null`
  // to undo, which is what the trail under the card calls. Routing changes nothing in
  // any module: it decides which step handles the item, and that decision lives in
  // planning_session_steps.data.routes for the `looseEnds` step.
  api.post('/api/weekly-planning/loose-ends/route', tenantRoute(async (tenant, req: Request, res: Response) => {
    const result = await routeLooseEnd(tenant, (req.body ?? {}) as Record<string, unknown>)
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message })
    return { routes: result.routes }
  }))

  // The two answers that DO write: `done` ("It's done already") on any kind, and
  // `drop` ("Drop it") on a parked note only — dropping a computed item would mean
  // deleting another module's data, which is what routing exists to avoid.
  api.post('/api/weekly-planning/loose-ends/resolve', tenantRoute(async (tenant, req: Request, res: Response) => {
    const result = await resolveLooseEnd(tenant, (req.body ?? {}) as Record<string, unknown>)
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message })
    return result
  }))

  // The capture bar under group B ("Drop something new on the board — one line is
  // enough"). Step 3 ("Horizon scan") parks here too, from the month view, with
  // `stepKey: 'horizon'`; the route and the table are general on purpose so it needs
  // neither a migration nor a change to this file.
  api.post('/api/weekly-planning/loose-ends/parked', tenantRoute(async (tenant, req: Request, res: Response) => {
    const result = await parkItem(tenant, (req.body ?? {}) as Record<string, unknown>)
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message })
    return { item: result.item }
  }))
}
