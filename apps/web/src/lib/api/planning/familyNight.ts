// Step 4 · Family night — this step's API client and its types.
//
// ONE read, and NO write of its own. Pinning a face, naming the theme and calling the
// week off are all `familyNightApi.saveOccurrence` — the familyNight module's own
// endpoint, the same one the Today card's picker calls. A parallel write path here
// would be a second place for "who's on the treat" to be true, and the two would
// eventually disagree in front of the family.
//
// What each write means is worth stating once, because the design's three promises all
// rest on it:
//   · a pin is `{ date, assignments: [...] }` — scoped to the DATE, so it is pinned for
//     this week only and next week comes back on rotation;
//   · the write materializes the occurrence, and the occurrence count is what the
//     module's rotation counts, so pinning is also what shifts next week's turn;
//   · calling the week off is `{ date, status: 'skipped' }` — a status on the night,
//     which touches neither the rotation's parts nor the recurring calendar event.
import { apiGet } from '../client'
import { emit } from '../bus'
import { familyNightApi } from '../familyNight'

export interface PlanningFamilyNightMember {
  id: string
  name: string
  avatarEmoji: string | null
  colorHex: string | null
}

export interface PlanningFamilyNightPart {
  partId: string
  label: string
  emoji: string
  // False ⇒ the rotation never auto-fills this part (a fixed host, say). It still takes
  // a pin: "nobody suggested" is not "nobody allowed".
  rotates: boolean
  /**
   * What this part IS this week ("the good ice cream", "charades") — a different question
   * from whose turn it is. Null = nobody has said. Writing one does NOT pin the person:
   * the rotation's suggestion stands until somebody names a face.
   */
  detail: string | null
  personId: string | null
  personName: string | null
  // True ⇒ somebody chose this, for this week, and it is written on the occurrence.
  // False ⇒ it is the rotation's suggestion and nothing is written down yet. Telling
  // those two apart is the screen's entire job.
  pinned: boolean
}

export interface PlanningFamilyNightBoard {
  // The week the server resolved — echoed, never recomputed here.
  weekStart: string
  date: string // the gathering's date inside that week
  dayOfWeek: number
  time: string // 'HH:MM' local
  occurrenceId: string | null
  theme: string | null
  status: 'planned' | 'done' | 'skipped'
  // There is a recurring calendar event behind this. Only then may the step promise
  // that calling one week off leaves it alone.
  onCalendar: boolean
  /**
   * THIS week's own calendar event, if the gathering has adopted one — separate from
   * `onCalendar`'s standing series. A household can have the series and no answer for
   * this week, or "it's the movie night already on Friday" and no series at all.
   */
  eventId: string | null
  eventTitle: string | null
  eventWhen: string | null
  members: PlanningFamilyNightMember[]
  parts: PlanningFamilyNightPart[]
}

// Every write re-emits `weeklyPlanning` on top of the module's own `familyNight`, so the
// session view (the counter, the agenda sheet) refetches alongside the Today card.
const alsoPlanning = <T,>(p: Promise<T>): Promise<T> => p.then((r) => { emit('weeklyPlanning'); return r })

export const planningFamilyNightApi = {
  // `weekStart` is the one the session view handed us — passed back, never computed.
  board: (weekStart?: string) =>
    apiGet<PlanningFamilyNightBoard>(`/api/weekly-planning/familyNight${weekStart ? `?weekStart=${weekStart}` : ''}`),

  // Tap a face. `personId: null` clears the part instead — note that clearing writes an
  // assignment row too, so the part reads "nobody yet" rather than falling back to the
  // rotation's guess. There is no un-pin: the module's upsert can write an assignment
  // but never delete one.
  pin: (date: string, partId: string, personId: string | null) =>
    alsoPlanning(familyNightApi.saveOccurrence({ date, assignments: [{ partId, personId }] })),

  // '' clears the theme; null would mean "leave whatever is there", which is not the
  // same thing and is how a cleared box quietly keeps its old text.
  setTheme: (date: string, theme: string) =>
    alsoPlanning(familyNightApi.saveOccurrence({ date, theme })),

  // Call the week off, or put it back on. One call both ways — a skip has to be
  // undoable, and "planned" is the module's own word for a night that is still on.
  setStatus: (date: string, status: 'planned' | 'skipped') =>
    alsoPlanning(familyNightApi.saveOccurrence({ date, status })),

  // What a part IS. Sent WITHOUT `personId`, on purpose: the server reads presence, so
  // including it would turn "I named the treat" into "…and nobody has it". '' clears,
  // for the same reason the theme line clears with '' — a null means "leave it alone".
  setDetail: (date: string, partId: string, detail: string) =>
    alsoPlanning(familyNightApi.saveOccurrence({ date, assignments: [{ partId, detail }] })),

  // Point this week's gathering at an event that already exists (or `null` to unlink,
  // which leaves the event on the calendar). There is no create-an-event call here: the
  // step opens the app's own EventModal and adopts what it writes, so there stays one
  // way to make an event.
  linkEvent: (date: string, eventId: string | null) =>
    alsoPlanning(familyNightApi.saveOccurrence({ date, eventId })),

  // "Add this week to the calendar": ONE call that creates the event for the gathering's
  // date and links it, server-side. Not a create-then-adopt round trip — the web app
  // writes events locally first (PowerSync uploads afterwards), so an id from here may
  // not exist server-side yet and the link would 404 on an unreproducible race. Returns
  // the existing link untouched if the week already has one, so a double tap can't leave
  // a stray event on the calendar.
  addEvent: (date: string) =>
    alsoPlanning(familyNightApi.saveOccurrence({ date, createEvent: true })),
}

// The crumb this step hands the session record: what it DECIDED, not a copy of the
// module. Which parts somebody chose by hand, and whether the week was called off — the
// recap reads the rest through to familyNight itself.
export function planningFamilyNightDecision(board: PlanningFamilyNightBoard | null): {
  pinned: string[]
  skipped: boolean
} {
  return {
    pinned: (board?.parts ?? []).filter((p) => p.pinned).map((p) => p.partId),
    skipped: board?.status === 'skipped',
  }
}
