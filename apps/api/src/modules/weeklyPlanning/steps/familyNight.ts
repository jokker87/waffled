// Weekly Planning · step 4 (Family night) — "Accept the rotation, or change it?"
//
// Three rows and a theme line. The whole step is ONE READ over the familyNight module:
// its `config.parts` (emoji, label, and a `rotates` flag), the rotation's suggestion for
// each part, and the occurrence's theme and status. Every WRITE — pinning a face, naming
// the theme, calling the week off — goes through the module's own
// POST /api/family-night/occurrence, so this step owns no write route and no table.
//
// WHY THIS FILE EXISTS AT ALL, given the module already has a view: `getView()` answers
// "the next gathering on or after today", and a session usually plans NEXT week. Run a
// session on a Saturday and the module's view is about a gathering that already belongs
// to the week you just finished. The board below is scoped to the week the SERVER handed
// the step instead, which is the only week this session is allowed to decide.
//
// A pin is therefore scoped to an occurrence (a date), never to households.settings —
// which is exactly what makes "pinned for this week only" true rather than aspirational.
import { DateTime } from 'luxon'
import { query } from '../../../platform/db'
import { householdTz } from '../../chores/chores.service'
import {
  getConfig,
  listMembers,
  nextFamilyNightDate,
  type FamilyNightConfig,
  type Member,
} from '../../familyNight/familyNight'

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
  // a pin — "nobody suggested" is not "nobody allowed".
  rotates: boolean
  /**
   * What this part IS this week ("the good ice cream", "charades") — the answer to a
   * different question from `personId`, which is whose turn it is. Null = nobody has
   * said. Writing one does NOT pin the person: the rotation's suggestion stands until
   * somebody actually names a face.
   */
  detail: string | null
  personId: string | null
  personName: string | null
  // True ⇒ somebody chose this, for this week, and it is stored on the occurrence.
  // False ⇒ it is the rotation's suggestion and nothing is written down yet. The
  // module calls the same distinction `suggested`; this is its inverse, in the design's
  // own word, because the screen's whole job is telling the two apart.
  pinned: boolean
}

export interface PlanningFamilyNightBoard {
  // The week the shell resolved (snapped and floored) — echoed so nothing client-side
  // has to do week arithmetic of its own.
  weekStart: string
  // The gathering's date INSIDE that week (YYYY-MM-DD).
  date: string
  dayOfWeek: number
  time: string // 'HH:MM' local
  // Null until somebody touches the week: the board is a pure read, so opening the step
  // and moving on writes nothing.
  occurrenceId: string | null
  theme: string | null
  status: 'planned' | 'done' | 'skipped'
  // The gathering is on the calendar as a recurring event. Carried so the step can
  // promise, truthfully, that calling one week off leaves that event alone — a promise
  // that would be a lie in a household that never put it on the calendar.
  onCalendar: boolean
  /**
   * THIS week's own calendar event, if the gathering has adopted one. Distinct from
   * `onCalendar`, which reports the STANDING recurring series set in Settings: a
   * household can have the series and no answer for this week, or an answer for this
   * week ("it's the movie night already on Friday") and no series at all.
   */
  eventId: string | null
  /** The adopted event's title, so the step can name it without a second fetch. */
  eventTitle: string | null
  /** Its start, household-local ("Friday 7:00 PM"), composed here for web and iOS alike. */
  eventWhen: string | null
  members: PlanningFamilyNightMember[]
  parts: PlanningFamilyNightPart[]
}

// ---------------------------------------------------------------------------
// The rotation, mirrored
// ---------------------------------------------------------------------------
// MIRRORS `rotationIndex()` and `suggest()` in modules/familyNight/familyNight.ts, which
// are private there. They can't be reused as they stand because the module always asks
// them about "the next gathering on or after today" and this step asks about the week
// being planned. CHANGE BOTH TOGETHER — if these two drift, the planning step and the
// Today card will name different people for the same night, which is the one bug nobody
// would think to look for. (Exporting them from the module is the real fix; it is a
// one-word change in a file this step does not own.)

// How many gatherings have happened before `date`. The occurrence COUNT is the whole of
// the rotation's memory — it never reads who actually did what — so the rotation only
// moves when a week is written down, and a week is only written down when somebody
// touches it. That is precisely why "tap a face and it's pinned for this week only,
// which is what shifts next week's turn" is a true sentence.
async function rotationIndex(householdId: string, date: string): Promise<number> {
  const { rows } = await query<{ n: string }>(
    `select count(*)::text as n from family_night_occurrences where household_id = $1 and deleted_at is null and date < $2`,
    [householdId, date]
  )
  return Number(rows[0]?.n ?? 0)
}

function suggest(config: FamilyNightConfig, members: Member[], idx: number): Map<string, string | null> {
  const order = config.rotationOrder && config.rotationOrder.length
    ? config.rotationOrder.filter((id) => members.some((m) => m.id === id))
    : members.map((m) => m.id)
  const out = new Map<string, string | null>()
  // `rot` advances only for parts that rotate, so a fixed part doesn't silently eat
  // somebody's turn at the parts either side of it.
  let rot = 0
  for (const part of config.parts) {
    if (part.rotates && order.length) {
      out.set(part.id, order[(idx + rot) % order.length])
      rot++
    } else {
      out.set(part.id, null)
    }
  }
  return out
}

// ---------------------------------------------------------------------------

interface OccRow {
  id: string
  theme: string | null
  status: string
  event_id: string | null
}

const STATUSES = new Set(['planned', 'done', 'skipped'])

export async function getFamilyNightBoard(householdId: string, weekStart: string): Promise<PlanningFamilyNightBoard> {
  const [config, members] = await Promise.all([getConfig(householdId), listMembers(householdId)])
  // `nextFamilyNightDate` walks 0–6 days forward from a date, so starting it at the
  // household's own week start always lands inside that week — including day 0, when
  // family night IS the first day of the week.
  const date = nextFamilyNightDate(weekStart, config.dayOfWeek)

  const [idx, occ] = await Promise.all([
    rotationIndex(householdId, date),
    query<OccRow>(
      `select id, theme, status, event_id from family_night_occurrences
        where household_id = $1 and date = $2 and deleted_at is null`,
      [householdId, date]
    ).then((r) => r.rows[0] ?? null),
  ])

  // `person_set`, not "a row exists": a row written to hold only a DETAIL makes no claim
  // about whose turn it is, so the rotation's suggestion has to survive it. Mirrors
  // `resolveAssignments` in the module — see the header note about keeping the two in
  // step.
  const stored = new Map<string, { personId: string | null; personSet: boolean; detail: string | null }>()
  if (occ) {
    const { rows } = await query<{ part_id: string; person_id: string | null; person_set: boolean; detail: string | null }>(
      `select part_id, person_id, person_set, detail from family_night_assignments where occurrence_id = $1`,
      [occ.id]
    )
    for (const r of rows) stored.set(r.part_id, { personId: r.person_id, personSet: r.person_set, detail: r.detail })
  }

  // The adopted event, named so the step can say WHICH event this week points at without
  // a second round trip. Read through the events module's own presenter rather than a
  // bare select, so a recurring master and a one-off read the same way.
  const linked = occ?.event_id
    ? await query<{ title: string; starts_at: Date; all_day: boolean }>(
        `select title, starts_at, all_day from events
          where household_id = $1 and id = $2 and deleted_at is null`,
        [householdId, occ.event_id]
      ).then((r) => r.rows[0] ?? null)
    : null
  const tz = await householdTz(householdId)

  const suggested = suggest(config, members, idx)
  const nameOf = (id: string | null) => (id ? members.find((m) => m.id === id)?.name ?? null : null)

  return {
    weekStart,
    date,
    dayOfWeek: config.dayOfWeek,
    time: config.time,
    occurrenceId: occ?.id ?? null,
    // '' is how the module's upsert is told to CLEAR a theme (a null there means "leave
    // it alone"), so it can genuinely be stored. Both readings are "no theme yet".
    theme: occ?.theme ? occ.theme : null,
    status: (occ && STATUSES.has(occ.status) ? occ.status : 'planned') as PlanningFamilyNightBoard['status'],
    onCalendar: !!config.eventId,
    // Null when the event was deleted since: `on delete set null` means the link goes
    // with it, so the step reports "not on the calendar" rather than a dangling id.
    eventId: linked ? occ!.event_id : null,
    eventTitle: linked?.title ?? null,
    eventWhen: linked
      ? DateTime.fromJSDate(new Date(linked.starts_at), { zone: tz }).toFormat(
          linked.all_day ? 'cccc' : 'cccc h:mm a'
        )
      : null,
    members: members.map((m) => ({ id: m.id, name: m.name, avatarEmoji: m.emoji, colorHex: m.color })),
    parts: config.parts.map((part) => {
      const row = stored.get(part.id) ?? null
      const pinned = !!row?.personSet
      const personId = pinned ? row!.personId : suggested.get(part.id) ?? null
      return {
        partId: part.id,
        label: part.label,
        emoji: part.emoji,
        rotates: part.rotates,
        detail: row?.detail ?? null,
        personId,
        personName: nameOf(personId),
        pinned,
      }
    }),
  }
}
