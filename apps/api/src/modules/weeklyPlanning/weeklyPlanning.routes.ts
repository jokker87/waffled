// Weekly Planning — HTTP routes (/api/weekly-planning). Logic in weeklyPlanning.ts.
import createAPI, { type Request, type Response } from 'lambda-api'
import { moduleRoutes } from '../../platform/route-guards'
import {
  getView,
  getConfig,
  setConfig,
  startSession,
  patchSession,
  decideStep,
  completeSession,
  deleteSession,
  getSessionById,
  resolveSteps,
  isStepKey,
  STEPS,
  type WeeklyPlanningConfig,
} from './weeklyPlanning'
import { STEP_ROUTE_REGISTRARS } from './steps'
import { planningListCandidates } from './steps/looseEnds'

type Api = ReturnType<typeof createAPI>

// Every route here is gated by the optional `weeklyPlanning` module (403 when off).
const { tenantRoute, adminRoute } = moduleRoutes('weeklyPlanning')

export function registerWeeklyPlanningRoutes(api: Api): void {
  // Each step's own reads live in their own file and are registered here as a list, so
  // building a step never means editing this one. See ./steps/index.ts.
  for (const register of STEP_ROUTE_REGISTRARS) register(api)

  // The landing read: config, the week in question, its session and every step with
  // its availability and decision. `?weekStart=` plans a week other than the default
  // (snapped and floored server-side — see resolveWeekStart).
  api.get('/api/weekly-planning', tenantRoute(async (tenant, req: Request) => {
    return getView(tenant.householdId, req.query?.weekStart)
  }))

  // Bare config — handy for settings, which doesn't need the session.
  //
  // `lists` is the CANDIDATES, not the stored map: the settings panel needs a switch per
  // list with its name on it, and which lists are even askable is step 1's business (the
  // `list_type = 'custom'` allowlist). Serving them here means neither client has to know
  // that rule, or reach into the lists module to render the setting.
  api.get('/api/weekly-planning/config', tenantRoute(async (tenant) => {
    const [config, lists] = await Promise.all([
      getConfig(tenant.householdId),
      planningListCandidates(tenant.householdId),
    ])
    return { config, steps: STEPS, lists }
  }))

  // When the session happens, which steps this household runs. Admin-only, like the
  // other module configs.
  api.put('/api/weekly-planning/config', adminRoute(async (tenant, req: Request) => {
    const body = (req.body ?? {}) as Partial<WeeklyPlanningConfig>
    const patch: Partial<WeeklyPlanningConfig> = {}
    if (typeof body.dayOfWeek === 'number') patch.dayOfWeek = body.dayOfWeek
    // A bad time is dropped rather than 400'd — the rest of the patch is still honest.
    if (typeof body.time === 'string' && /^\d{2}:\d{2}$/.test(body.time)) patch.time = body.time
    if (typeof body.showOnToday === 'boolean') patch.showOnToday = body.showOnToday
    if (body.steps && typeof body.steps === 'object') {
      // Merge, don't replace: settings.weeklyPlanning.steps is a sparse opt-out map, so
      // a client toggling one step must not clear the others.
      const current = (await getConfig(tenant.householdId)).steps
      const next: Record<string, boolean> = { ...current }
      for (const [k, v] of Object.entries(body.steps)) if (isStepKey(k) && typeof v === 'boolean') next[k] = v
      patch.steps = next
    }
    if (body.lists && typeof body.lists === 'object') {
      // Merge, for the same reason `steps` merges: this is a sparse opt-out map and a
      // client ruling one list out must not silently rule the rest back in. `settings` is
      // merged with jsonb `||`, which is SHALLOW — a bare patch would replace the whole
      // object.
      const current = (await getConfig(tenant.householdId)).lists
      const next: Record<string, boolean> = { ...current }
      for (const [k, v] of Object.entries(body.lists)) if (k && typeof v === 'boolean') next[k] = v
      patch.lists = next
    }
    const config = await setConfig(tenant.householdId, patch)
    return { config }
  }))

  // Start a week's session, or resume the one that's already there. `weekStart` in the
  // body picks the week; absent ⇒ the default (the week ahead).
  api.post('/api/weekly-planning/session', tenantRoute(async (tenant, req: Request) => {
    const body = (req.body ?? {}) as { weekStart?: unknown }
    return { session: await startSession(tenant, body.weekStart) }
  }))

  // Move the driver between steps, or reopen/finish the session.
  api.patch('/api/weekly-planning/session/:id', tenantRoute(async (tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as { currentStep?: unknown; status?: unknown }
    const patch: Parameters<typeof patchSession>[2] = {}
    if (body.currentStep !== undefined) {
      if (!isStepKey(body.currentStep)) return res.status(400).json({ error: 'BadRequest', message: 'unknown step' })
      patch.currentStep = body.currentStep
    }
    if (body.status !== undefined) {
      if (body.status !== 'active' && body.status !== 'completed') {
        return res.status(400).json({ error: 'BadRequest', message: 'status must be active or completed' })
      }
      patch.status = body.status
    }
    const session = await patchSession(tenant.householdId, req.params.id!, patch)
    if (!session) return res.status(404).json({ error: 'NotFound', message: 'session not found' })
    return { session }
  }))

  // Record what a step decided ('skipped' is a real answer, not a failure).
  api.post('/api/weekly-planning/session/:id/step', tenantRoute(async (tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as { stepKey?: unknown; status?: unknown; data?: unknown }
    if (!isStepKey(body.stepKey)) return res.status(400).json({ error: 'BadRequest', message: 'unknown step' })
    if (body.status !== 'pending' && body.status !== 'done' && body.status !== 'skipped') {
      return res.status(400).json({ error: 'BadRequest', message: 'status must be pending, done or skipped' })
    }
    const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? (body.data as Record<string, unknown>) : {}
    const steps = await decideStep(tenant.householdId, req.params.id!, { stepKey: body.stepKey, status: body.status, data })
    if (!steps) return res.status(404).json({ error: 'NotFound', message: 'session not found' })
    return { steps }
  }))

  // Throw it away and put the week back to its lobby. Discards the session record
  // only — what the session decided lives in the modules that own it and stays put.
  api.delete('/api/weekly-planning/session/:id', tenantRoute(async (tenant, req: Request, res: Response) => {
    const removed = await deleteSession(tenant.householdId, req.params.id!)
    if (!removed) return res.status(404).json({ error: 'NotFound', message: 'session not found' })
    return { ok: true }
  }))

  // Finish it — the record gets its timestamp and Today becomes the surface again.
  api.post('/api/weekly-planning/session/:id/complete', tenantRoute(async (tenant, req: Request, res: Response) => {
    const existing = await getSessionById(tenant.householdId, req.params.id!)
    if (!existing) return res.status(404).json({ error: 'NotFound', message: 'session not found' })
    const session = await completeSession(tenant.householdId, req.params.id!)
    return { session, steps: await resolveSteps(tenant.householdId, req.params.id!) }
  }))
}
