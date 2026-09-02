import type createAPI from 'lambda-api'
import { moduleRoutes } from '../../../platform/route-guards'

type Api = ReturnType<typeof createAPI>

// Step 8 · Tasks — the reads this step needs over chores.
//
// THIS FILE IS YOURS, and it is already registered (see ./index.ts) — do NOT edit
// weeklyPlanning.routes.ts to add a route. Gate every route with these guards so the
// step is behind the module toggle like the rest of it. Service logic belongs in a
// sibling `tasks.ts`; integration tests in
// apps/api/test/weekly-planning-tasks.integration.test.ts.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { tenantRoute, adminRoute } = moduleRoutes('weeklyPlanning')

export function registerTasksStepRoutes(_api: Api): void {
  // e.g. _api.get('/api/weekly-planning/tasks', tenantRoute(async (tenant) => { … }))
}
