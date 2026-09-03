// Weekly Planning · step 8 (Tasks) — this step's API client and its types.
//
// The board is a read; handing a chore out is a write to the CHORES module, because
// that is where a chore lives. So the only new endpoint here is the read, and
// `handOut` composes the two existing chores endpoints — which is why this step
// stores nothing of its own.
import { apiGet } from '../client'
import { choresApi } from '../chores'

export type PlanningChoreCadence = 'daily' | 'weekly' | 'once'

export interface PlanningTasksChore {
  id: string
  title: string
  emoji: string | null
  rrule: string | null
  cadence: PlanningChoreCadence
  // The days inside the planned week this chore lands on (YYYY-MM-DD), computed by the
  // server from the same rule the chores module materializes by. Seven ⇒ every day;
  // empty ⇒ no day inside the week (see dueOn / carriedOver).
  days: string[]
  // A one-off's own date, which may sit outside the planned week. null for recurring.
  dueOn: string | null
  dueTime: string | null
  // A one-off from before the week that's still open and rolls forward.
  carriedOver: boolean
  rewardAmount: number
  rewardCurrency: string | null
  // Not drawn on the card, but carried so the chore editor opened from it prefills
  // honestly — ChoreModal reads a missing flag as false, which would turn approval or
  // photo proof off the moment somebody fixed a typo.
  requiresApproval: boolean
  requiresPhoto: boolean
  // Every day of this chore already sitting on a board still open (a one-off has one; a
  // recurring chore has one per day anybody has opened the board for), whoever is or
  // isn't on it. PATCHing the definition alone only reaches the days from today
  // forward, so `handOut` moves all of these too — in BOTH directions, which is what
  // keeps a take-back from leaving the kiosk board showing a name this board doesn't.
  pendingInstanceIds: string[]
}

export interface PlanningTasksPerson {
  id: string
  name: string
  avatarEmoji: string | null
  colorHex: string | null
  memberType: string
  isAdmin: boolean
  // The standing load this person already carries — active chores that repeat. What
  // makes the fairness read visible without anyone computing a score.
  recurringChores: number
  // What they're actually holding for the week being planned. Server-owned, so the
  // column is the week rather than a log of this sitting and survives a refresh.
  chores: PlanningTasksChore[]
}

export interface PlanningTasksBoard {
  // The week the server resolved (snapped and floored) — echoed so nothing client-side
  // has to do week arithmetic of its own.
  weekStart: string
  // The day a task added during this session should land on — inside the week being
  // planned, and today when today is inside it. Server-owned, so adding a task on a
  // Wednesday while planning next week can't quietly date it to that Wednesday.
  newTaskDay: string
  people: PlanningTasksPerson[]
  unassigned: PlanningTasksChore[]
}

export const planningTasksApi = {
  // `weekStart` is the one the session view handed us — passed back, never computed.
  board: (weekStart?: string) =>
    apiGet<PlanningTasksBoard>(`/api/weekly-planning/tasks${weekStart ? `?weekStart=${weekStart}` : ''}`),

  // Move a chore: to `personId`, or back up for grabs when that's null — the same call
  // both ways, because handing a chore over has to be undoable. It writes the
  // definition (which covers every future occurrence) and every open day of it already
  // sitting on a board: all of them, because moving only some would leave the kiosk
  // Chores screen disagreeing with this board about who has it. Both are the chores
  // module's own endpoints; this step adds no write of its own.
  async handOut(chore: PlanningTasksChore, personId: string | null): Promise<void> {
    await choresApi.updateChore(chore.id, { personId })
    for (const instanceId of chore.pendingInstanceIds) {
      await choresApi.assignInstance(instanceId, personId)
    }
  },

  // Say which day a one-off lands on. `dueOn` is a chore PATCH like any other; the
  // chores module moves the day's instance with it (and leaves a day somebody already
  // finished alone). Recurring chores ignore it — their days come from the rrule, which
  // belongs to the chore editor, not to a chip on a board.
}
