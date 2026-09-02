import type createAPI from 'lambda-api'
import type { Request } from 'lambda-api'
import { moduleRoutes, requireModule } from '../../../platform/route-guards'
import { resolveWeekStart } from '../weeklyPlanning'
import { mealsStepView, fillEmptyDinners, undoFilledDinners, parseFilledNights } from './meals'

type Api = ReturnType<typeof createAPI>

// Step 7 · Meals — the reads and the two writes this step needs over the meal plan.
//
// Registered from ./index.ts, so weeklyPlanning.routes.ts is never edited. Every route
// is gated on the `weeklyPlanning` module by the guards below AND asserts the `meals`
// module inside, because that's the module these routes actually read: a household with
// meals off has no plan to show, and the step catalog already marks the step
// unavailable there — the routes have to agree.
const { tenantRoute } = moduleRoutes('weeklyPlanning')

export function registerMealsStepRoutes(api: Api): void {
  // THE WEEK IS THE SERVER'S. `resolveWeekStart` is the one gate: it rejects nonsense
  // (→ the default week), SNAPS a mid-week date to its week start and clamps to the
  // floor. A client that computed its own seven days would write meal and grocery rows
  // onto a key nothing reads again — the bug this module was built after.
  api.get('/api/weekly-planning/meals', tenantRoute(async (tenant, req: Request) => {
    await requireModule(tenant, 'meals')
    const weekStart = await resolveWeekStart(tenant.householdId, req.query?.weekStart)
    return mealsStepView(tenant, weekStart)
  }))

  // "Plan the rest for me" — fills ONLY the nights with no dinner, and hands back
  // exactly what it wrote so the same footer slot can become "Undo the three".
  api.post('/api/weekly-planning/meals/fill', tenantRoute(async (tenant, req: Request) => {
    await requireModule(tenant, 'meals')
    const body = (req.body ?? {}) as { weekStart?: unknown }
    const weekStart = await resolveWeekStart(tenant.householdId, body.weekStart)
    return fillEmptyDinners(tenant, weekStart)
  }))

  // The undo. It takes back what the fill wrote and nothing else: a night somebody has
  // since decided by hand is reported in `kept`, never cleared.
  api.post('/api/weekly-planning/meals/undo', tenantRoute(async (tenant, req: Request) => {
    await requireModule(tenant, 'meals')
    const body = (req.body ?? {}) as { weekStart?: unknown; filled?: unknown }
    const weekStart = await resolveWeekStart(tenant.householdId, body.weekStart)
    return undoFilledDinners(tenant, weekStart, parseFilledNights(body.filled))
  }))
}
