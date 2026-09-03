import type createAPI from 'lambda-api'
import type { Request } from 'lambda-api'
import { moduleRoutes } from '../../../platform/route-guards'
import { getHorizon } from './horizon'

type Api = ReturnType<typeof createAPI>

// Step 3 · Horizon scan — ONE route, and deliberately not three.
//
// The month itself is the plain calendar (`GET /api/events?from&to` over the 42-cell
// grid window, `POST /api/events` from the app's own event modal), so there is no month
// endpoint here for the same reason `calendar.routes.ts` registers nothing at all: a
// weekly-planning mirror of the calendar would be a second door onto the same rows.
//
// And PARKING is a POST to step 1's `/api/weekly-planning/loose-ends/parked`, whose own
// header says step 3 writes through it. `planning_parked_items` and `parkItem()` were
// both written general so this step needed neither a migration nor a second writer — a
// `/horizon/park` alias here would be exactly the "second, subtly different parked-item
// path" that costs you a divergence six months from now.
//
// What is left is the read the park bar can't derive: the tags it may offer, and what
// this session has already parked. See ./horizon.ts.
const { tenantRoute } = moduleRoutes('weeklyPlanning')

export function registerHorizonStepRoutes(api: Api): void {
  api.get('/api/weekly-planning/horizon', tenantRoute(async (tenant, req: Request) =>
    getHorizon(tenant.householdId, req.query?.sessionId ?? null)
  ))
}
