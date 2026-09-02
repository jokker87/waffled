import type createAPI from 'lambda-api'
import { moduleRoutes } from '../../../platform/route-guards'

type Api = ReturnType<typeof createAPI>

// Step 2 · Calendar — DELIBERATELY REGISTERS NOTHING.
//
// The step frames the week the session is planning, and the week is the real calendar:
// it reads `GET /api/events?from&to` over weekStart…weekStart+6 and adds through
// `POST /api/events`. Both already exist, are already tenant-scoped, and are already
// what every other calendar surface uses — a `/api/weekly-planning/calendar` mirror of
// them would be a second door onto the same rows, and the two would drift.
//
// This registrar stays (see ./index.ts registers it unconditionally) so that if the step
// ever does need a read of its own, it lands here rather than in weeklyPlanning.routes.ts.
// Anything added must be gated with these guards, so it sits behind the module toggle
// like the rest of the session. Coverage of the reads this step depends on lives in
// apps/api/test/weekly-planning-calendar.integration.test.ts.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { tenantRoute, adminRoute } = moduleRoutes('weeklyPlanning')

export function registerCalendarStepRoutes(_api: Api): void {
  // Nothing — see above.
}
