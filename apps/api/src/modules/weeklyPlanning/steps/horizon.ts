// Weekly Planning · step 3 "Horizon scan" — the month you already have, plus one bar.
//
// The step is the SHIPPED MONTH VIEW: the 42-cell grid, owner-coloured chips, countdown
// badges and the right-hand day panel. All of that is the plain calendar read
// (`GET /api/events?from&to`) and the app's own event modal (`POST /api/events`), which
// is why there is no month endpoint here — a `/api/weekly-planning/horizon/month` mirror
// of the calendar would be a second door onto the same rows, and the two would drift.
//
// The session adds exactly one thing: PARKING A NOTE. That already has a home too —
// step 1 owns `planning_parked_items` (0100) and `POST /api/weekly-planning/loose-ends/
// parked`, both written to be general precisely so this step could use them. So this
// file does NOT re-implement parking; `parkItem` in ./looseEnds.ts is the one writer.
//
// What is left over — and all this file is — is the read the bar needs and cannot
// derive:
//
//   1. WHICH TAGS a note may carry, filtered to the steps this household actually runs.
//      A tag naming a step the session skips over addresses the note to nobody, which
//      is the same reasoning behind step 1's `availableDestinations`.
//   2. WHAT THIS SESSION HAS PARKED. `setDecisionData` is not storage — it only reaches
//      the server when the step is answered — so a step that must still be true on a
//      second visit reads it back from the table that owns it. This is the wave-1 lesson
//      (the Meals step's shopping trip) applied.
import { query } from '../../../platform/db'
import { resolveSteps, STEPS } from '../weeklyPlanning'

// ---------------------------------------------------------------------------
// The tags
// ---------------------------------------------------------------------------

// THE TAG IS THE DESTINATION STEP, not 'horizon'.
//
// `planning_parked_items.step_key` answers one question — which step is going to look
// at this? — and for a note parked here the answer is never step 3, which is the step
// that just wrote it. So a note tagged Tasks stores 'tasks', exactly as step 1 stores
// 'tasks' when somebody routes a note there ("make it a task"). One meaning for the
// column, and a later consumer cannot tell the two producers apart — which is the point:
// the mock's caption for this bar is "tagged Tasks, so it turns up at step 8 for an
// owner and a day", and step 8 should not need to know which bar the note came from.
//
// (0100's own comment sketches step 3 tagging 'horizon'. That predates the bar having a
// tag row at all; it contradicts the column's stated semantics, and the v4 mock settles
// it. Nothing reads 'horizon' today.)
//
// ONLY THE STEPS STILL AHEAD, and that is why the list is derived rather than written
// down. A tag names the step that will LOOK at the note, so a step this session has
// already walked past cannot be one: tagging Calendar from the Horizon scan addresses
// step 2 while you are standing on step 3, and the note could only resurface in a LATER
// session. Reported exactly that way — "I think its weird that I can add a parking lot
// note here and it would show on the previous step I already did? ... It could be a
// task, meal, goal, connection, or kid item but no previous/current step."
//
// The old list was three hand-kept keys (tasks/meals/calendar), correct back when only
// steps 1, 3 and 10 read `planning_parked_items` at all. The shell now raises a handoff
// banner on ANY step holding a parked note, so every step after this one is a genuine
// destination and the hand-kept list is what is holding the bar back.
//
// Derived from `STEPS` order: a step added to the catalog needs nothing done here, and
// the chips read down the session in the order you will actually meet them. A step
// earns its place by having a HINT — that is the editorial opt-in, and it is what keeps
// `recap` out, which reports the session and settles nothing.
//
// "No tag" is the ABSENCE of a tag and so is never a row here — it is the client
// sending no `stepKey` at all.
const TAG_HINTS: Record<string, string> = {
  familyNight: 'It belongs to the gathering',
  connection: 'It’s time with someone',
  goals: 'Somebody’s working on it',
  meals: 'It changes what we eat',
  tasks: 'Someone owns it this week',
  kids: 'It’s about one of the kids',
}

// The tag the bar opens on, for the same reason step 1's `DESTINATIONS.parked` marks it
// so: most of what a month provokes is something somebody has to DO before the date
// arrives. The bar opens there; "No tag" is one tap away.
const PRIMARY_TAG = 'tasks'

// The bar's own position in the session. Everything after it is a candidate; everything
// at or before it is addressed to a step you are already past.
const BAR_STEP = 'horizon'

export interface HorizonTag {
  stepKey: string
  // The catalog's own title for that step, so the bar and the agenda sheet can never
  // call the same step two different things.
  label: string
  hint: string
  // The one the bar starts on. At most one, and absent when its step is not available.
  primary?: boolean
}

export interface HorizonNote {
  id: string
  note: string
  stepKey: string | null
  // The tag as a person reads it, composed here so web and iOS say the same thing.
  stepLabel: string | null
  createdAt: string
}

export interface HorizonView {
  tags: HorizonTag[]
  parked: HorizonNote[]
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface NoteRow {
  id: string
  note: string
  step_key: string | null
  created_at: Date
}

/**
 * The bar's tags and this session's board.
 *
 * `sessionId` is optional: with none there is nothing parked yet to show, but the tags
 * still come back, so the bar is renderable before a session exists.
 */
export async function getHorizon(householdId: string, sessionId: string | null): Promise<HorizonView> {
  const steps = await resolveSteps(householdId, null)
  const live = new Map(steps.filter((s) => s.available).map((s) => [s.key, s.title]))
  const after = STEPS.slice(STEPS.findIndex((s) => s.key === BAR_STEP) + 1)
  const tags: HorizonTag[] = after.flatMap((s) => {
    const hint = TAG_HINTS[s.key]
    const label = live.get(s.key)
    return hint && label ? [{ stepKey: s.key, label, hint, ...(s.key === PRIMARY_TAG ? { primary: true } : {}) }] : []
  })

  if (!sessionId || !UUID_RE.test(sessionId)) return { tags, parked: [] }

  // Every OPEN note parked during this session, whichever bar wrote it — step 1's
  // capture bar and step 3's park bar drop the same kind of thing in the same table, so
  // a note written in step 1 half an hour ago should not be re-parked here. Resolved and
  // dropped notes fall out: they have been answered and are no longer something to
  // think about. Household-scoped as well as session-scoped — the session id alone is
  // untrusted input.
  //
  // Oldest first, which is the order they were written and the order step 1's own read
  // uses. `title` is joined from the CATALOG rather than stored, so retitling a step
  // renames every tag at once.
  const { rows } = await query<NoteRow>(
    `select id, note, step_key, created_at
       from planning_parked_items
      where household_id = $1 and session_id = $2 and status = 'open'
      order by created_at, id
      limit 200`,
    [householdId, sessionId]
  )
  const titles = new Map(steps.map((s) => [s.key, s.title]))
  return {
    tags,
    parked: rows.map((r) => ({
      id: r.id,
      note: r.note,
      stepKey: r.step_key,
      stepLabel: r.step_key ? (titles.get(r.step_key) ?? null) : null,
      createdAt: r.created_at.toISOString(),
    })),
  }
}
