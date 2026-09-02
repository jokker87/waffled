import type createAPI from 'lambda-api'
import type { Request } from 'lambda-api'
import { moduleRoutes, requireModule } from '../../../platform/route-guards'
import { resolveWeekStart } from '../weeklyPlanning'
import { getTasksBoard } from './tasks'

type Api = ReturnType<typeof createAPI>

// Step 8 · Tasks — the one read this step needs over chores.
//
// Read-only on purpose: handing a chore out is a PATCH of the existing chore
// definition (and, for a one-off, an assign of the instance it already materialized),
// both of which are existing chores endpoints. This step stores nothing of its own.
const { tenantRoute } = moduleRoutes('weeklyPlanning')

export function registerTasksStepRoutes(api: Api): void {
  // The board: a column per member holding what they carry for the planned week, plus
  // everything still up for grabs. The catalog marks this step requiresModule 'chores',
  // so the read asserts that module too — a household with chores off has no board.
  //
  // `?weekStart=` goes through the shell's own resolveWeekStart, so the week boundary
  // stays server-owned (snapped and floored) exactly as the session view's does. A
  // client never computes a week here, it echoes the one it was given.
  api.get('/api/weekly-planning/tasks', tenantRoute(async (tenant, req: Request) => {
    await requireModule(tenant, 'chores')
    const weekStart = await resolveWeekStart(tenant.householdId, req.query?.weekStart)
    return getTasksBoard(tenant.householdId, weekStart)
  }))
}
