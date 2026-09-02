import type createAPI from 'lambda-api'
import type { Request } from 'lambda-api'
import { moduleRoutes, requireModule } from '../../../platform/route-guards'
import { requireCapability } from '../../../platform/permissions'
import { assertPersonInHousehold } from '../../../platform/household-refs'
import { resolveWeekStart } from '../weeklyPlanning'
import { mealsStepView, fillEmptyDinners, undoFilledDinners, parseFilledNights, parsePlanCards, setShoppingTrip } from './meals'

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
    // `choreId` is the shopping chore the client last saw — a hint, never a
    // requirement; without it the trip is still found by title + week.
    const hint = typeof req.query?.choreId === 'string' ? req.query.choreId : null
    return mealsStepView(tenant, weekStart, hint)
  }))

  // "Plan the rest for me" — fills ONLY the nights with no dinner, and hands back
  // exactly what it wrote so the same footer slot can become "Undo the three".
  //
  // `cards` is the week the family already approved in the shared "Plan my week"
  // planner. It goes through THIS route rather than POST /api/meals/plan for the two
  // things that route can't do: refuse to touch a night somebody already decided, and
  // hand back the receipt the undo checks. Omit it and the fill drafts for itself.
  api.post('/api/weekly-planning/meals/fill', tenantRoute(async (tenant, req: Request) => {
    await requireModule(tenant, 'meals')
    const body = (req.body ?? {}) as { weekStart?: unknown; cards?: unknown }
    const weekStart = await resolveWeekStart(tenant.householdId, body.weekStart)
    // Provided-but-unusable is NOT the same as absent: a caller that sent something
    // shaped wrong gets nothing written, never a week this server drafted on its own
    // and the family never approved.
    const cards = body.cards === undefined ? null : (parsePlanCards(body.cards) ?? [])
    return fillEmptyDinners(tenant, weekStart, cards)
  }))

  // The undo. It takes back what the fill wrote and nothing else: a night somebody has
  // since decided by hand is reported in `kept`, never cleared.
  api.post('/api/weekly-planning/meals/undo', tenantRoute(async (tenant, req: Request) => {
    await requireModule(tenant, 'meals')
    const body = (req.body ?? {}) as { weekStart?: unknown; filled?: unknown }
    const weekStart = await resolveWeekStart(tenant.householdId, body.weekStart)
    return undoFilledDinners(tenant, weekStart, parseFilledNights(body.filled))
  }))

  // Who's shopping, and when. The trip is a real one-off chore, so it lands on the
  // Tasks board as a genuine assignment — this route only decides which chore that is
  // and keeps it to ONE per week (see `setShoppingTrip`).
  //
  // Gated on `chores` as well as `meals`: the module that owns the record has to be on
  // for the record to exist, and the client drops the control when the view says so.
  //
  // Permissions follow the chores module's own rule rather than inventing one — a
  // carve-out, exactly as route-guards.ts describes: handing the trip to somebody
  // ELSE (or taking it off them) is `chore.manage`; putting it on yourself, or leaving
  // it up for grabs, is not.
  api.put('/api/weekly-planning/meals/shopper', tenantRoute(async (tenant, req: Request) => {
    await requireModule(tenant, 'meals')
    await requireModule(tenant, 'chores')
    const b = (req.body ?? {}) as { weekStart?: unknown; dueOn?: unknown; personId?: unknown; dueTime?: unknown; choreId?: unknown }
    const weekStart = await resolveWeekStart(tenant.householdId, b.weekStart)

    const personId = typeof b.personId === 'string' && b.personId ? b.personId : null
    if (personId) await assertPersonInHousehold(tenant.householdId, personId)
    if (personId !== null && personId !== tenant.personId) await requireCapability(tenant, 'chore.manage')

    return setShoppingTrip(tenant, weekStart, {
      dueOn: typeof b.dueOn === 'string' && b.dueOn ? b.dueOn : null,
      personId,
      dueTime: typeof b.dueTime === 'string' && /^\d{2}:\d{2}$/.test(b.dueTime) ? b.dueTime : null,
      choreId: typeof b.choreId === 'string' ? b.choreId : null,
    })
  }))
}
