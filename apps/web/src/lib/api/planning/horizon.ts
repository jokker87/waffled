// Weekly Planning · step 3 "Horizon scan" — this step's API client and its types.
//
// DELIBERATELY SMALL, because almost nothing about this step is new. The month is the
// real calendar (`useEventsRange` + `useCountdowns`), adding a day's event is the app's
// own `EventModal`, and PARKING A NOTE is step 1's `looseEndsApi.park` — whose own
// comment says step 3 calls it. None of those belong here: a second way to talk to the
// calendar is how the offline path and the REST path drift apart, and a second parked-
// item path is how two writers end up leaving rows a later step can't read the same way.
//
// What's left is the one read the park bar can't derive for itself: which tags it may
// offer (only steps this household actually runs), and what THIS SESSION has already
// parked — because `setDecisionData` is not storage, so anything that must still be true
// on a second visit is read back from the table that owns it.
import { apiGet } from '../client'

export interface HorizonTag {
  // A step key from the server-owned catalog. It is the step that will LOOK at the note
  // ('tasks' → "it turns up at step 8 for an owner and a day"), never 'horizon'.
  stepKey: string
  // The catalog's own title for that step, so the bar and the agenda sheet can never
  // call the same step two different things.
  label: string
  hint: string
  // The one the bar starts on, when the step it names is available.
  primary?: boolean
}

export interface HorizonNote {
  id: string
  note: string
  stepKey: string | null
  stepLabel: string | null
  createdAt: string
}

export interface HorizonView {
  // "No tag" is the ABSENCE of a tag, so it is never in this list — the client renders
  // it as the option that sends no `stepKey` at all.
  tags: HorizonTag[]
  // Every OPEN note parked during this session, whichever bar wrote it: step 1's capture
  // bar and step 3's park bar drop the same kind of thing in the same table.
  parked: HorizonNote[]
}

export const horizonApi = {
  get: (sessionId?: string) =>
    apiGet<HorizonView>(`/api/weekly-planning/horizon${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`),
}
