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
  // Every day of this chore already sitting on a board with nobody on it (a one-off has
  // one; a recurring chore has one per day anybody has opened the board for). Assigning
  // the definition alone would leave those rows still showing "up for grabs", so
  // `handOut` moves all of them.
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
  people: PlanningTasksPerson[]
  unassigned: PlanningTasksChore[]
}

export const planningTasksApi = {
  // `weekStart` is the one the session view handed us — passed back, never computed.
  board: (weekStart?: string) =>
    apiGet<PlanningTasksBoard>(`/api/weekly-planning/tasks${weekStart ? `?weekStart=${weekStart}` : ''}`),

  // Give a chore to someone: the definition (which covers every future occurrence) and
  // every day of it already sitting unclaimed on a board — all of them, because moving
  // only the first would leave the rest reading "up for grabs" on the kiosk. Both are
  // the chores module's own endpoints; this step adds no write of its own.
  async handOut(chore: PlanningTasksChore, personId: string): Promise<void> {
    await choresApi.updateChore(chore.id, { personId })
    for (const instanceId of chore.pendingInstanceIds) {
      await choresApi.assignInstance(instanceId, personId)
    }
  },
}
