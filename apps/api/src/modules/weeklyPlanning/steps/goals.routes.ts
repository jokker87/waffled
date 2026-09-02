import type createAPI from 'lambda-api'
import { moduleRoutes } from '../../../platform/route-guards'

type Api = ReturnType<typeof createAPI>

// Step 6 · Goals — the reads this step needs over goals and goal lists.
//
// THIS FILE IS YOURS, and it is already registered (see ./index.ts) — do NOT edit
// weeklyPlanning.routes.ts to add a route. Gate every route with these guards so the
// step is behind the module toggle like the rest of it. Service logic belongs in a
// sibling `goals.ts`; integration tests in
// apps/api/test/weekly-planning-goals.integration.test.ts.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { tenantRoute, adminRoute } = moduleRoutes('weeklyPlanning')

export function registerGoalsStepRoutes(_api: Api): void {
  // e.g. _api.get('/api/weekly-planning/goals', tenantRoute(async (tenant) => { … }))
}
