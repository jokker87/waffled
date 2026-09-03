// Weekly Planning · step 10 "Recap" — this step's API client and its types.
//
// ONE READ, AND NO WRITE AT ALL. Saving the week is the shell's
// `POST /session/:id/complete`; every line the recap shows is already live in the module
// that owns it. A write here would be the last step making a second copy of somebody
// else's decision, which is the one thing the design forbids: "every line is a pointer
// rather than a copy."
//
// So the client is deliberately thin. All of the joining — six modules, nine steps'
// decisions, the parking lot — happens on the server, for the same reason the step
// catalog and every step's sentences are server-owned: web and iOS must not each invent
// their own reading of what the week decided.
import { apiGet } from '../client'

export interface PlanningRecapDay {
  date: string
  /** The dinner planned for that night. Null with the meals module off, too. */
  meal: string | null
  cook: string | null
  events: { id: string; title: string; when: string; personName: string | null }[]
  /** Events the column is holding back, so a busy day says "+2 more" instead of growing. */
  more: number
}

export interface PlanningRecapGroup {
  /** The module the decisions live in — and the ordering of the card. */
  key: string
  label: string
  /** The tally: what the week says now, and what this session changed. */
  headline: string
  /** The decisions themselves, named, ' · ' separated. Composed server-side. */
  detail: string
  /** How many decisions this group holds. The header's number is the sum of these. */
  count: number
  /** Where you go to change it — the row links to that step. */
  stepKey: string | null
}

export interface PlanningRecapLastCall {
  id: string
  note: string
  /** "Parked by Kevin · 2 weeks ago · passed over 3 times" — step 1's own line. */
  detail: string | null
}

export interface PlanningRecapLeftAlone {
  key: string
  label: string
  detail: string
  /** 'skipped' — passed over on purpose · 'none' — answered with nothing · 'parked'. */
  badge: 'skipped' | 'none' | 'parked'
  stepKey: string | null
}

export interface PlanningRecapView {
  weekStart: string
  /** The session's finish time, or null while the week is still being decided. */
  savedAt: string | null
  days: PlanningRecapDay[]
  groups: PlanningRecapGroup[]
  lastCall: PlanningRecapLastCall[]
  lastCallMore: number
  leftAlone: PlanningRecapLeftAlone[]
  counts: { decisions: number; deferred: number; parked: number }
}

export const planningRecapApi = {
  get: (sessionId: string) =>
    apiGet<PlanningRecapView>(`/api/weekly-planning/recap?sessionId=${encodeURIComponent(sessionId)}`),
}

// The crumb the step hands the session record when the week is saved.
//
// INTEGERS ONLY — the pointer rule applied to storage. The receipt may freeze how MANY
// decisions were made tonight (a statement about the session, and so true forever); it
// must never freeze WHAT they were, because the things themselves live in the modules
// and a title copied here starts going stale the moment somebody edits it.
export const planningRecapDecision = (view: PlanningRecapView | null) =>
  view ? { counts: view.counts } : null
