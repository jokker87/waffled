// Step 6 · Goals — this step's API client and its types.
//
// The step is a read over the goal lists you already have plus ONE write: picking a
// group's focus, which sets that goal's existing `is_featured` flag. Nothing here
// invents a "focus" record — `settled` / `focusGoalId` are the SESSION's memory of what
// it decided (so "nothing this week" can be a real answer and put a ★ on the tab),
// while `goals[].isFeatured` stays the goals module's own truth.
//
// `goals` is the same shape the goals screen gets, so the shared display helpers
// (goalDisplayProgress / goalDisplayTarget / goalFraction) work on it unchanged — a
// habit reads as this period's count, a checklist as its steps, everything else as the
// lifetime total.
import { apiGet, apiSend } from '../client'
import { emit } from '../bus'
import type { Goal, GoalListMember } from '../goals'

// How a goal is actually GOING, in a sentence, with one of three tones — derived
// server-side from real logged activity so web and iOS read the same verdict (and so
// no client is tempted to make a phrase up for a goal it knows nothing about).
export type PaceTone = 'ok' | 'flat' | 'behind'
export interface GoalPace {
  text: string
  tone: PaceTone
}

export interface PlanningGoalGoal extends Goal {
  // Null when there is genuinely nothing honest to say about the goal's pace.
  pace: GoalPace | null
}

export interface PlanningGoalMember extends GoalListMember {
  // Null when we have no birthday on file — the group's sub line drops the age rather
  // than guessing one.
  age: number | null
}

export interface PlanningGoalGroup {
  listId: string
  name: string
  emoji: string | null
  colorHex: string | null
  // A private list is only ever served to its own members — the tab wears a lock.
  isPrivate: boolean
  sortOrder: number
  members: PlanningGoalMember[]
  // The group is literally every person in the household — what lets the card's sub
  // line say "everyone tracks it" without the client counting people.
  isEveryone: boolean
  goals: PlanningGoalGoal[]
  // True once THIS session has answered for the group — the ★ on its tab. Never set by
  // a flag the session merely found: a pre-existing pin does not star a tab.
  settled: boolean
  // The goal that IS this group's focus. When settled, what the session answered (null
  // for the real answer "nothing this week"). When not settled, the list's one already-
  // featured goal if it has exactly one — which is how a goal created through
  // "＋ New goal for this week" is already selected on the way back.
  focusGoalId: string | null
}

export interface PlanningGoalsView {
  groups: PlanningGoalGroup[]
}

export const planningGoalsApi = {
  get: (sessionId: string) =>
    apiGet<PlanningGoalsView>(`/api/weekly-planning/goals?sessionId=${encodeURIComponent(sessionId)}`),
  // `goalId: null` is "nothing this week" — a settled answer, not an absence of one.
  // Emits `goals` as well as `weeklyPlanning`: the flag it sets is the goals module's,
  // so the goals screen and the Today spotlight card are now stale.
  setFocus: (sessionId: string, listId: string, goalId: string | null) =>
    apiSend<PlanningGoalsView>('PUT', '/api/weekly-planning/goals/focus', { sessionId, listId, goalId })
      .then((r) => { emit('goals'); emit('weeklyPlanning'); return r }),
}

// The crumb this step hands the session record: which group settled on what. Rebuilt
// from the server's answer after every read and write, and mirrored through
// `setDecisionData` so pressing the primary (which REPLACES the step's data) writes
// back exactly what is already there instead of erasing it.
export function planningGoalsDecision(view: PlanningGoalsView | null): { focus: Record<string, string | null> } {
  const focus: Record<string, string | null> = {}
  for (const g of view?.groups ?? []) if (g.settled) focus[g.listId] = g.focusGoalId
  return { focus }
}
