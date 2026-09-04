// Weekly Planning · step 1 "Loose ends" — this step's API client and its types.
//
// STEP 1 IS INTAKE, NOT REPAIR. Its main verb is ROUTING: it decides which later step
// handles each loose end, and — as the see-all screen says out loud — "routing here
// changes nothing in your modules." Two answers are the exceptions and do write: "It's
// done already" and, on a parked note only, "Drop it".
//
// Two groups, one card. "Not done" is COMPUTED by the server from the modules that own
// the work (overdue chores, unchecked items on the household's own lists — never the
// grocery list, which rebuilds itself from the meal plan — rhythms past due, habit
// goals short for the week) — nobody typed those. "Parked" is what somebody wrote down
// during the week and exists nowhere else yet, which is why it gets a table, a capture
// bar, and Drop.
//
// THE CROSS-STEP CONTRACT lives here: `LooseEndRoute`. Routes are persisted on step
// 1's own `planning_session_steps.data` as `{ routes: [...] }`, so steps 2 / 6 / 8 / 9
// need no new endpoint and no shared file — they already receive the whole session
// view, and read:
//
//   const routes = (view.steps.find(s => s.key === 'looseEnds')?.data.routes ?? []) as LooseEndRoute[]
//   const mine = routes.filter(r => r.to === 'tasks')
//
// Import the type from here (`import type { LooseEndRoute } from '../../lib/api'`);
// this file is step 1's, but reading it is exactly what it is for.
import { apiGet, apiSend } from '../client'
import { emit } from '../bus'

export type LooseEndKind = 'chore' | 'list' | 'rhythm' | 'goal' | 'parked'

// The two answers that WRITE. Routing is not one of them — see the header.
export type LooseEndAction = 'done' | 'drop'

export interface LooseEnd {
  // Unique across kinds and stable across refetches — the list key, and what the deck
  // remembers as already answered.
  key: string
  kind: LooseEndKind
  id: string
  title: string
  emoji: string | null
  // The one line under the title ("3 days late", "on Groceries", or for a note
  // "Parked by Kevin · 2 weeks ago · passed over 3 times"). Server-composed so web and
  // iOS say the same thing.
  detail: string | null
  // Which of done/drop THIS item can take. Server-decided per item: a chore wanting
  // photo proof can't be completed from a session with no camera, and only a parked
  // note can be dropped. The client renders what it's given rather than inferring from
  // `kind`, for the same reason the step catalog is server-owned.
  actions: LooseEndAction[]
}

// Where a card can send an item. A step, with the reason under its name — filtered by
// the server to the steps this household actually runs, so the card never offers a
// destination the session skips over.
export interface LooseEndDestination {
  to: string
  label: string
  hint: string
  primary?: boolean
}

// WHAT STEP 1 DECIDED, and the shape every later step reads. Persisted on step 1's
// `planning_session_steps.data.routes`.
export interface LooseEndRoute {
  kind: LooseEndKind
  id: string
  // The title as it read when routed, so a later step can render the row without
  // re-reading four modules. A label, never a source of truth — the module still owns
  // the item.
  title: string
  // Which half of step 1 it came from.
  source: LooseEndGroup
  // The step that will handle it: a key from the server-owned catalog.
  to: string
}

export interface LooseEndsView {
  weekStart: string
  notDone: LooseEnd[]
  parked: LooseEnd[]
  // The server's own tally of each group. The card deck shows the count MINUS what has
  // been routed or set aside (which the server can't fully know, because "leave it
  // open" writes nothing), so it derives its switch badges from the lists themselves —
  // this field is for the surfaces with no local aside list: the recap, and iOS.
  counts: { notDone: number; parked: number }
  destinations: { notDone: LooseEndDestination[]; parked: LooseEndDestination[] }
  routes: LooseEndRoute[]
  // Friendly names of the modules actually read, for the cleared state's "we
  // checked…" line — so it never claims to have checked a module that is off.
  sources: string[]
}

// What each group is called on screen, plus the two lengths of explanation it needs.
// `note` is the full one, and it travels with the SWITCH — in the one-at-a-time mode
// the switch is the entire explanation of the two kinds. `caption` is the mock's
// four-word version ("Not done · already in the app"), for the see-all screen, where
// there is no switch and the section headings do the grouping themselves.
export const LOOSE_END_GROUPS = [
  {
    key: 'notDone' as const,
    label: 'Not done',
    caption: 'already in the app',
    // Says what the step DOES read, and stops. It briefly also named the grocery list
    // as left out — but that sentence only ever answered a question the bug provoked
    // ("is this pulling from ALL my lists?"), and now that groceries aren't there, a
    // screen narrating what it isn't showing is just noise. The exclusion and the
    // reasoning for it live in the server read, which is what owns the decision.
    note: 'Computed from your modules — overdue chores, unchecked items on your lists, rhythms past due, habit goals short for the week. Nobody typed these; they are simply still open.',
  },
  {
    key: 'parked' as const,
    label: 'Parked',
    caption: 'somebody wrote it down',
    note: 'What somebody wrote down during the week that exists nowhere else yet. Which is why one of the answers here is to drop it.',
  },
]
export type LooseEndGroup = (typeof LOOSE_END_GROUPS)[number]['key']

// The label each writing answer wears. Both read differently by group, because the
// same word means a different thing to a computed item and to a note.
export function looseEndActionLabel(action: LooseEndAction, kind: LooseEndKind): string {
  if (action === 'done') return kind === 'parked' ? 'Talk about it now' : "It's done already"
  return 'Drop it'
}

// And the reason under it, on the cards that show hints.
export function looseEndActionHint(action: LooseEndAction, kind: LooseEndKind): string {
  if (action === 'done') return kind === 'parked' ? 'Two minutes, then decide' : 'Just tell its module'
  return 'It was never really a thing'
}

export const looseEndsApi = {
  get: (weekStart?: string, sessionId?: string) => {
    const q = new URLSearchParams()
    if (weekStart) q.set('weekStart', weekStart)
    if (sessionId) q.set('sessionId', sessionId)
    const qs = q.toString()
    return apiGet<LooseEndsView>(`/api/weekly-planning/loose-ends${qs ? `?${qs}` : ''}`)
  },

  // THE STEP'S MAIN VERB — and it deliberately touches no module, so it emits only
  // 'weeklyPlanning' (the session view, whose step data now carries the decision).
  // `to: null` undoes the routing, which is what the trail's Undo calls.
  route: (
    sessionId: string,
    item: { kind: LooseEndKind; id: string; title: string },
    source: LooseEndGroup,
    to: string | null
  ) =>
    apiSend<{ routes: LooseEndRoute[] }>('POST', '/api/weekly-planning/loose-ends/route', {
      sessionId,
      kind: item.kind,
      id: item.id,
      title: item.title,
      source,
      to,
    }).then((r) => {
      emit('weeklyPlanning')
      return r
    }),

  // The two answers that DO write. The write lands in the thing that owns the item, so
  // every surface showing that module needs to hear about it — hence the extra topics
  // beside 'weeklyPlanning' (which the shell's own view is subscribed to).
  // `sessionId` is not for the write — it retires any route this item had, so a later
  // step is never handed something its own module already considers finished.
  resolve: (kind: LooseEndKind, id: string, action: LooseEndAction, sessionId?: string) =>
    apiSend<{ ok: true }>('POST', '/api/weekly-planning/loose-ends/resolve', { kind, id, action, sessionId }).then((r) => {
      emit('weeklyPlanning')
      if (kind === 'chore') emit('chores')
      if (kind === 'list') emit('grocery')
      if (kind === 'rhythm') emit('rhythms')
      if (kind === 'goal') emit('goals')
      return r
    }),

  // FIX WHAT YOU JUST WROTE — the words, the tag, or both. "Parked in this session — I
  // have no way to edit the item or change the category and I should."
  //
  // BOTH FIELDS ARE READ FOR PRESENCE by the server, which is why they are optional here
  // and why `stepKey` is `string | null | undefined`: omitting it leaves the tag alone,
  // and `null` is the real answer "No tag". Pass `sessionId` whenever there is one — a
  // note that step 1 ROUTED also has an entry in the session's route trail quoting its
  // words and naming its destination, and the server moves that entry with the note.
  // Without the session id the row still changes and the trail is left to disagree.
  update: (id: string, patch: { note?: string; stepKey?: string | null; sessionId?: string }) =>
    apiSend<{ item: { id: string; note: string; stepKey: string | null }; routes?: LooseEndRoute[] }>(
      'PATCH',
      `/api/weekly-planning/loose-ends/parked/${encodeURIComponent(id)}`,
      {
        ...(patch.note !== undefined ? { note: patch.note } : {}),
        ...(patch.stepKey !== undefined ? { stepKey: patch.stepKey } : {}),
        ...(patch.sessionId ? { sessionId: patch.sessionId } : {}),
      }
    ).then((r) => {
      emit('weeklyPlanning')
      return r
    }),

  // The capture bar under group B. Step 3 ("Horizon scan") calls this too, from the
  // month view, passing `stepKey: 'horizon'`.
  park: (note: string, opts?: { stepKey?: string; sessionId?: string }) =>
    apiSend<{ item: { id: string; note: string } }>('POST', '/api/weekly-planning/loose-ends/parked', {
      note,
      ...(opts?.stepKey ? { stepKey: opts.stepKey } : {}),
      ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}),
    }).then((r) => {
      emit('weeklyPlanning')
      return r
    }),
}
