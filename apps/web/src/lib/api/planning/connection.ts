// Weekly Planning · step 5 (Connection) — this step's API client and its types.
//
// TWO READS, NO WRITE. Nothing new is stored for this step: a pairing's status is a
// query over event_participants (an event whose people are exactly those two), and
// claiming a slot writes an ORDINARY CALENDAR EVENT with those participants — through
// the app's own `EventModal`, which already owns the local-first write path. A `create
// pairing` call here would be a second door onto the events table, and the two would
// drift, so there deliberately isn't one.
import { apiGet, apiSend } from '../client'

export interface PlanningConnectionSlot {
  /** The day inside the planned week (YYYY-MM-DD, household-local). */
  date: string
  /**
   * When the gap opens, or null for a day with nothing on it. NULL IS NOT "unknown": it
   * means the whole day is free, and the event modal's own time picker decides — the
   * step never names an hour the week doesn't justify.
   */
  startsAt: string | null
  kind: 'after' | 'open'
  /** The event the gap opens after ('after' only). */
  afterTitle: string | null
  /** "Wed after Scouts" / "Tue after 8:30 PM" / "Sun · free all day". Built server-side so iOS says it the same way. */
  label: string
}

export interface PlanningConnectionEvent {
  id: string
  title: string
  startsAt: string
  endsAt: string | null
  allDay: boolean
  /** Length in minutes, when the event has an end. */
  minutes: number | null
  /** "Saturday" — the row's sentence needs the possessive ("Saturday's yard work"). */
  day: string
  /** "1:00 PM", or null on an all-day row. */
  time: string | null
  /** "Saturday 1:00 PM" — formatted in the household's zone, server-side. */
  when: string
}

export interface PlanningConnectionPairing {
  /** Exactly the pairing's people, in household order. */
  personIds: string[]
  /** "Kevin and Kelly". */
  who: string
  /** The last event before the planned week whose people were exactly these two. */
  lastTogetherOn: string | null
  lastTogetherTitle: string | null
  /** Events this week whose people are EXACTLY these two — time that already exists. */
  alreadyThisWeek: PlanningConnectionEvent[]
  /** Events this week with both of them AND someone else: "you're both there, and it still isn't that". */
  togetherThisWeek: PlanningConnectionEvent[]
  /** Ranked gaps, roomiest first — ALL of them. How many chips fit is this step's call. */
  slots: PlanningConnectionSlot[]
}

export interface PlanningConnectionBoard {
  /** The week the server resolved (snapped and floored) — echoed, never computed here. */
  weekStart: string
  /** Every pair in the household, ranked by how long it has been. The step draws the top few. */
  pairings: PlanningConnectionPairing[]
}

export interface PlanningConnectionSlots {
  weekStart: string
  personIds: string[]
  who: string
  slots: PlanningConnectionSlot[]
}

export const planningConnectionApi = {
  // `weekStart` is the one the session view handed us — passed back, never computed.
  board: (weekStart?: string) =>
    apiGet<PlanningConnectionBoard>(`/api/weekly-planning/connection${weekStart ? `?weekStart=${weekStart}` : ''}`),

  // The same gaps, for people the app didn't suggest — what makes "Make a pairing" a
  // first-class action instead of a blank date picker.
  slotsFor: (weekStart: string, personIds: string[]) =>
    apiGet<PlanningConnectionSlots>(
      `/api/weekly-planning/connection/slots?weekStart=${weekStart}&people=${personIds.join(',')}`
    ),

  // WHICH EVENT ANSWERS EACH PAIRING, keyed by the pairing's people. The step's one
  // write, and it stores a POINTER — no event, no pairing, no time — because a link is
  // the answer to a pairing and has to outlive the render that made it.
  //
  // A MID-STEP write: it merges onto the step's row and deliberately does not settle the
  // step. Not `decideStep`, which stamps `decided_at = now()` on every write and would
  // move when a settled step was settled.
  saveLinks: (sessionId: string, links: Record<string, string>) =>
    apiSend<{ ok: true }>('PUT', '/api/weekly-planning/connection/links', { sessionId, links }),
}
