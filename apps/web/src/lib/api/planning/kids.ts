// Step 9 · Kids — this step's API client and its types.
//
// The step is a read over the kids' OWN goals, chores and calendar, plus two answers
// that have no other module to land in. Nothing here invents an option: the focus comes
// out of their goals / their overdue chores / the standing chores they already carry,
// and the thing to look forward to is picked off their real week.
//
// A goal-sourced option carries `goal` — the same shape the goals screen gets — so the
// card renders its number through the SHARED display helpers (goalDisplayProgress /
// goalDisplayTarget), which is what keeps a habit reading as this period's count rather
// than a lifetime total. `detail` is the server's own sentence for the same fact, so iOS
// and the read-back say it identically.
//
// The answers are a REAL write (see kids.routes.ts), not `setDecisionData`: the second
// frame is the read-back, and it has to survive a remount, a refresh and the iPad
// picking up where the phone left off.
import { apiGet, apiSend } from '../client'
import { emit } from '../bus'
import type { Goal } from '../goals'

// Where an option came from. `routine` is a standing chore they already carry — the one
// with nothing under it, because nothing is wrong with it. `custom` is free text.
export type PlanningKidFocusSource = 'goal' | 'chore' | 'routine' | 'custom'

export interface PlanningKidFocusOption {
  // Stable across refetches and unique across sources; what a write names. A chore step 1
  // routed here and the same chore found overdue share one key on purpose — triage
  // promotes the row rather than duplicating it.
  key: string
  source: PlanningKidFocusSource
  // The referent in its own module (a goal id, a chore id); null for free text.
  id: string | null
  emoji: string
  label: string
  // The one line under the label, composed server-side. NULL is meaningful: a standing
  // chore has nothing late or behind about it, so it gets no line.
  detail: string | null
  // Sent here by step 1's triage (the routes contract). Shown first.
  routed: boolean
  // The whole goal, for a goal-sourced option — so the number is read through the shared
  // display helper instead of an inline `totalProgress`.
  goal: Goal | null
}

export interface PlanningKidForwardOption {
  key: string
  // The event it names; null for free text.
  eventId: string | null
  emoji: string
  label: string
  // The day, in the household's own zone ("Sat").
  when: string
}

export interface PlanningKidEvent {
  id: string
  title: string
  // "Tue 4:00 PM", or just the weekday for an all-day event.
  when: string
  startsAt: string
  allDay: boolean
}

export interface PlanningKidChore {
  id: string
  title: string
  emoji: string | null
  // "every day" · "Sat" · "open since Wednesday".
  when: string
  late: boolean
}

// What a card settled on — a SNAPSHOT of the label as it read when chosen. The module
// still owns the item; this is what lets the read-back render without re-reading four
// modules, and what lets free text (which names nothing) live in the same field.
export interface PlanningKidFocus {
  source: PlanningKidFocusSource
  id: string | null
  emoji: string
  label: string
  detail: string | null
}
export interface PlanningKidForward {
  eventId: string | null
  emoji: string
  label: string
  when: string
}

export interface PlanningKidCard {
  personId: string
  name: string
  avatarEmoji: string | null
  colorHex: string | null
  // Null when there's no birthday on file — the card drops the age rather than guessing.
  age: number | null
  // Null when the reward economy is off (it's funded by chores, so chores off ⇒ off).
  stars: number | null
  starsSymbol: string | null
  week: PlanningKidEvent[]
  chores: PlanningKidChore[]
  focusOptions: PlanningKidFocusOption[]
  forwardOptions: PlanningKidForwardOption[]
  focus: PlanningKidFocus | null
  forward: PlanningKidForward | null
  // Both answered. Only then does the card flip to its read-back face.
  settled: boolean
}

export interface PlanningKidsView {
  weekStart: string
  kids: PlanningKidCard[]
  // Which modules actually contributed, so an empty card can say why rather than looking
  // broken. Never a claim to have read a module that's off.
  sources: { goals: boolean; chores: boolean; rewards: boolean }
  // A previous session left answers worth copying forward ("Same as last week").
  canRepeat: boolean
}

// One answer, on the wire. `null` clears it; an OMITTED key leaves it alone — the two
// questions are answered one at a time at the board, and sending half must not erase
// the other half.
export type PlanningKidPick = { key: string } | { text: string } | null

export const planningKidsApi = {
  get: (sessionId: string, weekStart?: string) =>
    apiGet<PlanningKidsView>(
      `/api/weekly-planning/kids?sessionId=${encodeURIComponent(sessionId)}` +
        (weekStart ? `&weekStart=${encodeURIComponent(weekStart)}` : '')
    ),
  // Emits `weeklyPlanning` only: the answer lands on the SESSION, not in goals or chores
  // — naming your one thing is not the family pinning a goal, and nothing in another
  // module went stale.
  answer: (
    sessionId: string,
    personId: string,
    body: { focus?: PlanningKidPick; forward?: PlanningKidPick },
    weekStart?: string
  ) =>
    apiSend<PlanningKidsView>('PUT', '/api/weekly-planning/kids/answer', { sessionId, personId, weekStart, ...body })
      .then((r) => { emit('weeklyPlanning'); return r }),
  // "Same as last week" — additive, and it only copies answers whose referent still
  // stands, so the read-back can't proudly name something that's already over.
  repeat: (sessionId: string, weekStart?: string) =>
    apiSend<PlanningKidsView>('POST', '/api/weekly-planning/kids/repeat', { sessionId, weekStart })
      .then((r) => { emit('weeklyPlanning'); return r }),
}

// The crumb this step hands the session record: what each kid settled on. Rebuilt from
// the server's answer after every read and write, and mirrored through `setDecisionData`
// so pressing the primary (which REPLACES the step's data) writes back exactly what is
// already there instead of erasing it.
export function planningKidsDecision(view: PlanningKidsView | null): {
  kids: Record<string, { focus: PlanningKidFocus | null; forward: PlanningKidForward | null }>
} {
  const kids: Record<string, { focus: PlanningKidFocus | null; forward: PlanningKidForward | null }> = {}
  for (const k of view?.kids ?? []) {
    if (k.focus || k.forward) kids[k.personId] = { focus: k.focus, forward: k.forward }
  }
  return { kids }
}
