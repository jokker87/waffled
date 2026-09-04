import type createAPI from 'lambda-api'
import type { Request, Response } from 'lambda-api'
import { moduleRoutes } from '../../../platform/route-guards'
import { getSessionById, resolveWeekStart } from '../weeklyPlanning'
import { getConnectionBoard, getConnectionSlots, writeConnectionLinks, InvalidPairingError } from './connection'

type Api = ReturnType<typeof createAPI>

// Step 5 · Connection — TWO READS, AND NOTHING ELSE.
//
// Nothing new is stored for this step. A pairing's status is a query over
// event_participants; claiming a slot writes an ORDINARY CALENDAR EVENT through the
// app's own event modal, i.e. `POST /api/events` with those participants. There is
// deliberately no route here that creates an event: a `/api/weekly-planning/connection`
// mirror of the events endpoint would be a second door onto the same rows, and the two
// would drift (the same argument calendar.routes.ts makes for registering nothing).
//
// The ONE write is `/links`, and it holds the line: it stores a POINTER from a pairing to
// an event that already exists — no event, no pairing, no time — because a link is the
// answer to a pairing and has to outlive the render that made it.
//
// NOTE the guard list. The catalog gives `connection` no `requiresModule` — a household
// with chores, goals or meals switched off still has people in it — so these routes are
// gated on the weeklyPlanning module and nothing else. Do not copy tasks.routes.ts's
// extra `requireModule(tenant, 'chores')` in here; it would 4xx the step wherever an
// unrelated module happened to be off.
const { tenantRoute } = moduleRoutes('weeklyPlanning')

const idsFrom = (raw: unknown): string[] =>
  typeof raw === 'string' ? raw.split(',').map((s) => s.trim()).filter(Boolean) : []

export function registerConnectionStepRoutes(api: Api): void {
  // The board: every pair in the household, ranked by how long it has been since it was
  // just the two of them, each with the time that already exists and the gaps the week
  // left behind. `?weekStart=` goes through the shell's resolveWeekStart so the week
  // boundary stays server-owned (snapped and floored) — a client echoes the week it was
  // given, it never computes one.
  api.get('/api/weekly-planning/connection', tenantRoute(async (tenant, req: Request) => {
    const weekStart = await resolveWeekStart(tenant.householdId, req.query?.weekStart)
    // The DRIVER's person, not null: personal-visibility events are hidden from everyone
    // but their owner, and reading as nobody would offer a slot in a gap step 2 draws as
    // full. Same viewer the events route itself uses.
    return getConnectionBoard(tenant.householdId, weekStart, tenant.personId)
  }))

  // The same gap computation for a set of people the app didn't suggest — what makes
  // "Make a pairing" (any two people, or three) a first-class action rather than a blank
  // date picker bolted onto the side of the step.
  api.get('/api/weekly-planning/connection/slots', tenantRoute(async (tenant, req: Request, res: Response) => {
    const weekStart = await resolveWeekStart(tenant.householdId, req.query?.weekStart)
    try {
      return await getConnectionSlots(tenant.householdId, weekStart, tenant.personId, idsFrom(req.query?.people))
    } catch (err) {
      if (err instanceof InvalidPairingError) return res.status(400).json({ error: 'BadRequest', message: err.message })
      throw err
    }
  }))

  // Which event answers which pairing. A mid-step write: it merges onto the step's row
  // and deliberately does NOT settle the step — see `writeConnectionLinks`.
  api.put('/api/weekly-planning/connection/links', tenantRoute(async (tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as { sessionId?: unknown; links?: unknown }
    if (typeof body.sessionId !== 'string') {
      return res.status(400).json({ error: 'BadRequest', message: 'sessionId is required' })
    }
    // A map of pairing key → event id, and nothing else in it. Validated rather than
    // trusted: this lands in a jsonb column the recap reads back.
    const raw = body.links
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return res.status(400).json({ error: 'BadRequest', message: 'links must be an object' })
    }
    const links: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v !== 'string') return res.status(400).json({ error: 'BadRequest', message: 'each link must be an event id' })
      links[k] = v
    }
    // The session must be THIS household's — the step row is reachable by id alone.
    const session = await getSessionById(tenant.householdId, body.sessionId)
    if (!session) return res.status(404).json({ error: 'NotFound', message: 'session not found' })

    await writeConnectionLinks(session.id, links)
    return { ok: true }
  }))
}
