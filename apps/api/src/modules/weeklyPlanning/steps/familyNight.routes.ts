import type createAPI from 'lambda-api'
import type { Request } from 'lambda-api'
import { moduleRoutes, requireModule } from '../../../platform/route-guards'
import { resolveWeekStart } from '../weeklyPlanning'
import { getFamilyNightBoard } from './familyNight'

type Api = ReturnType<typeof createAPI>

// Step 4 · Family night — the one read this step needs over the familyNight module.
//
// Read-only on purpose. Pinning a face, naming the theme and calling the week off are
// all POST /api/family-night/occurrence, which the module already ships and the Today
// card already uses; a second write path would be a second place for "who's on the
// treat" to be true. So this step stores nothing of its own.
const { tenantRoute } = moduleRoutes('weeklyPlanning')

export function registerFamilyNightStepRoutes(api: Api): void {
  // The board: the gathering inside the week being planned, its theme and status, and
  // each part's suggested-or-pinned person.
  //
  // The catalog marks this step requiresModule 'familyNight', but that only decides
  // whether the session SHOWS the step — it doesn't guard the endpoint, so assert the
  // module here too.
  //
  // `?weekStart=` goes through the shell's own resolveWeekStart, so the week boundary
  // stays server-owned (snapped and floored). A client never computes a week here, it
  // echoes the one it was given.
  api.get('/api/weekly-planning/familyNight', tenantRoute(async (tenant, req: Request) => {
    await requireModule(tenant, 'familyNight')
    const weekStart = await resolveWeekStart(tenant.householdId, req.query?.weekStart)
    return getFamilyNightBoard(tenant.householdId, weekStart)
  }))
}
