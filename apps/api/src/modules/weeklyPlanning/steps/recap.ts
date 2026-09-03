// Weekly Planning · step 10 "Recap" — read the week back, then it's over.
//
// ────────────────────────────────────────────────────────────────────────────────
// THE ONE RULE THIS FILE EXISTS TO OBEY
//
//   "Every line is a pointer rather than a copy."
//
// The finished session is a RECEIPT of what was decided; the live truth is whatever
// the modules say now. So this step STORES NOTHING. There is no recap table, no
// snapshot column, and not a single title, id or name copied at decision time. Every
// line below is resolved when somebody reads it, out of the module that owns the
// decision — which is why a decision later undone somewhere else makes the line change
// or disappear instead of making the record lie.
//
// The distinction that makes that workable, and the one to hold on to:
//
//   · A STATEMENT ABOUT THE WEEK is live ("6 tasks have an owner and a day"). It is
//     re-resolved on every read, so it is never stale. Storing one would be the copy.
//   · A STATEMENT ABOUT THE SESSION is historical ("2 events added since you started").
//     It is re-derived from PROVENANCE — `created_at >= session.started_at` on the row
//     the decision actually wrote — so it too moves when the thing is deleted. Nothing
//     is counted into a column to make it true.
//
// That second half is why this file does not read the step crumbs
// (`planning_session_steps.data`) for its tallies, even though several of them hold
// exactly the number the mock wants. The shell clears the crumb on every step change
// and only persists it when the step is ANSWERED (see StepBodyProps), so
// `{ added: 2 }` really means "2 added during the visit that happened to end in Done":
// add two events, jump to Horizon from the agenda sheet, come back and press Done, and
// the crumb says 0. A provenance query cannot go wrong that way.
//
// The crumbs it DOES read are the ones that are the decision itself and have no other
// home — the goals focus map, the kids' answers, step 1's routes. For those, the
// session row IS the owning module.
//
// ────────────────────────────────────────────────────────────────────────────────
// GROUPED BY THE MODULE THE DECISION LIVES IN
//
// The design's grouping — Calendar · Meals + Lists · Chores + Rhythms · Goals ·
// Family Night · Kids — is not cosmetic: it is what makes each line a pointer, because
// a group names the place you would go to change it. Note that three steps fold into
// Calendar (calendar, horizon and connection all write `events`), which is the grouping
// doing its job.
//
// A group with no decisions in it is ABSENT rather than zeroed — and if its step was
// answered anyway, it moves to "left alone on purpose", which is the other half of the
// design's two cards. A module that is off contributes no group at all and is never
// named (the `sources` precedent in looseEnds/kids: never claim to have read something
// you didn't).
//
// ────────────────────────────────────────────────────────────────────────────────
// WHAT IS DELIBERATELY NOT A DECISION
//
//   · An UNPINNED family-night part is the rotation's suggestion, not something anybody
//     said. Reporting it would put a name on the record the family never chose.
//   · A goal group the session has not settled carries `focusGoalId` anyway — the step
//     pre-selects an already-featured goal so nobody has to re-pick it. That is a flag
//     we found lying around, not an answer. Only `settled` counts.
//   · A step still `pending` is not "left alone on purpose", it is unreached. Only
//     `skipped` (and the deliberate non-answers) are outcomes.
import { query } from '../../../platform/db'
import { moduleEnabled, type ModuleKey } from '../../../platform/modules'
import { visibleTo } from '../../events/events'
import type { Tenant } from '../../households/households'
import { STEPS, resolveSteps, type Session } from '../weeklyPlanning'
import { mealsStepView, addDays } from './meals'
import { getTasksBoard } from './tasks'
import { getGoalsStepView } from './goals'
import { getFamilyNightBoard } from './familyNight'
import { listParked } from './looseEnds'

// A day column shows this many events before it reports the rest as a remainder. The
// strip is seven fixed columns beside two cards: a day that grows without a cap is the
// Horizon bug again (a grid child whose content pushes it past its box and paints over
// whatever is under it).
const DAY_CAP = 4
// How many items a group line names before it stops. The line is a sentence, not a list.
const DETAIL_CAP = 6
// The last call is a prompt, not an inbox. `listParked` itself caps at 200.
const LAST_CALL_CAP = 6
// Meal-plan mirrors: planning a dinner writes a real event with the household on it, so
// anything reading `events` naively reports the meal plan twice. The same exclusion
// meals.ts, kids.ts and goal-calendar.ts already make.
const MIRROR_ORIGINS = ['meal_plan', 'meal_prep']

export interface RecapDay {
  date: string
  // The dinner planned for that night, or null. Null when the meals module is off too —
  // a household that doesn't plan meals gets a week of events, not a row of blanks.
  meal: string | null
  cook: string | null
  events: { id: string; title: string; when: string; personName: string | null }[]
  // Events beyond DAY_CAP, so the column can say "+2 more" without growing.
  more: number
}

export interface RecapGroup {
  // The module the decisions live in — the client's react key and its ordering.
  key: string
  label: string
  // The tally: what the week says now, and what this session changed.
  headline: string
  // The decisions themselves, named. ' · ' separated, composed here so web and iOS
  // read the same sentence.
  detail: string
  // How many decisions this group holds. The header's one number is the sum of these.
  count: number
  // Where you go to change it. The client links the row there.
  stepKey: string | null
}

export interface RecapLastCall {
  id: string
  note: string
  // "Parked by Kevin · 2 weeks ago · passed over 3 times" — composed by listParked, so
  // this line reads identically in step 1's deck and here.
  detail: string | null
}

export interface RecapLeftAlone {
  key: string
  label: string
  detail: string
  // 'skipped' — the step was passed over on purpose; 'none' — it was answered and the
  // answer was "nothing"; 'parked' — notes waiting for a step that will look at them.
  badge: 'skipped' | 'none' | 'parked'
  stepKey: string | null
}

export interface RecapView {
  weekStart: string
  // The session's finish time, or null while it is still being decided. The shell owns
  // the saved screen; this is here so any surface reading the record can date it.
  savedAt: string | null
  days: RecapDay[]
  groups: RecapGroup[]
  lastCall: RecapLastCall[]
  lastCallMore: number
  leftAlone: RecapLeftAlone[]
  // The receipt's three numbers. Derived from the arrays above on every read — never
  // stored, never added up on the client, so the header and the cards cannot disagree.
  counts: { decisions: number; deferred: number; parked: number }
}

// ---------------------------------------------------------------------------
// Small shared bits
// ---------------------------------------------------------------------------

const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const weekdayOf = (iso: string) => WD[new Date(`${iso.slice(0, 10)}T00:00:00Z`).getUTCDay()]
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const join = (bits: (string | null | undefined)[]) => bits.filter(Boolean).join(' · ')

// "Saturday 8:00 PM" / "Saturday, all day" — household-local, the same reading
// connection.ts gives an event's `when`.
function whenLabel(at: Date | string, allDay: boolean, tz: string): string {
  const d = new Date(at)
  const day = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(d)
  if (allDay) return `${day}, all day`
  return `${day} ${new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d)}`
}

const householdRow = async (householdId: string) => {
  const { rows } = await query<{ settings: unknown; timezone: string | null }>(
    `select settings, timezone from households where id = $1`,
    [householdId]
  )
  return { settings: rows[0]?.settings ?? null, tz: (rows[0]?.timezone ?? '').trim() || 'UTC' }
}

const stepTitle = (key: string) => STEPS.find((s) => s.key === key)?.title ?? key

// ---------------------------------------------------------------------------
// Provenance: what THIS session changed
// ---------------------------------------------------------------------------

interface AddedEvent { id: string; title: string; when: string }

// Events added since the session started, still alive, that land in the planned week.
//
// PROVENANCE, NOT A COPY. `created_at >= started_at` answers "did this appear during
// the session?" every time it is asked, so deleting the event takes the line away with
// it — where a count written down at decision time would go on claiming it forever.
//
// It credits anything added during the session window, including from another screen.
// That is the deliberate trade: the alternative (a crumb) is wrong more often and in a
// worse way (it silently forgets), and "added while you were planning" is still a true
// sentence about the week.
//
// Recurring events are matched through their occurrences as well as their own start,
// because a weekly thing added on Sunday for Tuesdays has no `starts_at` in the week.
async function eventsAddedSince(
  householdId: string,
  since: string,
  weekStart: string,
  viewerPersonId: string | null,
  tz: string
): Promise<AddedEvent[]> {
  const { rows } = await query<{ id: string; title: string; starts_at: Date; all_day: boolean }>(
    `select e.id, e.title, e.starts_at, e.all_day
       from events e
       join households h on h.id = e.household_id
      where e.household_id = $1
        and e.deleted_at is null
        and e.created_at >= $2
        and coalesce(e.origin, 'manual') <> all($5::text[])
        ${visibleTo('e', '$6')}
        and (
          (e.starts_at at time zone h.timezone)::date between $3::date and $4::date
          or exists (
            select 1 from event_occurrences o
             where o.event_id = e.id and o.deleted_at is null
               and (o.starts_at at time zone h.timezone)::date between $3::date and $4::date
          )
        )
      order by e.starts_at
      limit 50`,
    [householdId, since, weekStart, addDays(weekStart, 6), MIRROR_ORIGINS, viewerPersonId]
  )
  return rows.map((r) => ({ id: r.id, title: r.title, when: whenLabel(r.starts_at, r.all_day, tz) }))
}

// Dinners planned during the session, by night. Same provenance rule on
// meal_plan_entries: un-plan the night and the line goes with it.
async function dinnersPlannedSince(householdId: string, since: string, weekStart: string): Promise<{ date: string; title: string | null }[]> {
  const { rows } = await query<{ date: string | Date; title: string | null }>(
    `select e.date, coalesce(r.title, m.name, e.title) as title
       from meal_plan_entries e
       left join recipes r on r.id = e.recipe_id and r.deleted_at is null
       left join meals m on m.id = e.meal_id and m.deleted_at is null
      where e.household_id = $1
        and e.deleted_at is null
        -- 'dinner' mirrors meals.ts's own (unexported) MEAL_TYPE. CHANGE BOTH TOGETHER:
        -- a step counting suppers while the meals step plans dinners would report a
        -- number nobody could find on the board.
        and e.meal_type = 'dinner'
        and e.created_at >= $2
        and e.date between $3::date and $4::date
      order by e.date`,
    [householdId, since, weekStart, addDays(weekStart, 6)]
  )
  return rows.map((r) => ({ date: typeof r.date === 'string' ? r.date.slice(0, 10) : r.date.toISOString().slice(0, 10), title: r.title }))
}

// Rhythms settled during the session — a completion logged, or a period deliberately
// skipped. Both are step 1's "It's done already" landing in the rhythms module, and
// both carry their own `created_at`, so both are provenance rather than bookkeeping.
async function rhythmsSettledSince(householdId: string, since: string): Promise<string[]> {
  const { rows } = await query<{ title: string }>(
    `select r.title
       from rhythm_completions c
       join rhythms r on r.id = c.rhythm_id and r.deleted_at is null
      where c.household_id = $1 and c.created_at >= $2
     union
     select r.title
       from rhythm_skips s
       join rhythms r on r.id = s.rhythm_id and r.deleted_at is null
      where s.household_id = $1 and s.created_at >= $2
      limit 50`,
    [householdId, since]
  )
  return rows.map((r) => r.title)
}

// ---------------------------------------------------------------------------
// The parking lot
// ---------------------------------------------------------------------------

// Which open notes nobody has tagged. Two reads on purpose: `listParked` composes the
// history line ("Parked by Kevin · 2 weeks ago · passed over 3 times") and this says
// which rows are untagged — so the sentence is step 1's, not a second version of it.
//
// `step_key` is always a DESTINATION step, never the step that wrote the note (see
// 0100's comment), so "untagged" is exactly "nobody has said which step will look at
// this" — which is what the last call is for.
async function parkedKeys(householdId: string): Promise<Map<string, string | null>> {
  const { rows } = await query<{ id: string; step_key: string | null }>(
    `select id, step_key from planning_parked_items where household_id = $1 and status = 'open'`,
    [householdId]
  )
  return new Map(rows.map((r) => [r.id, r.step_key]))
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

// One group's definition: which module has to be on for it to exist, and which step
// owns it (where a row links to, and whose "done with nothing to show" becomes a
// left-alone row).
interface GroupSpec {
  key: string
  stepKey: string
  requires?: ModuleKey
}
const GROUP_SPECS: GroupSpec[] = [
  // Three steps write events; one group, because one place is where you'd go to change
  // any of them.
  { key: 'calendar', stepKey: 'calendar' },
  { key: 'meals', stepKey: 'meals', requires: 'meals' },
  { key: 'tasks', stepKey: 'tasks', requires: 'chores' },
  { key: 'goals', stepKey: 'goals', requires: 'goals' },
  { key: 'familyNight', stepKey: 'familyNight', requires: 'familyNight' },
  { key: 'kids', stepKey: 'kids' },
]

export async function getRecap(tenant: Tenant, weekStart: string, session: Session | null): Promise<RecapView> {
  const householdId = tenant.householdId
  const { settings, tz } = await householdRow(householdId)
  const on = (k: ModuleKey) => moduleEnabled(settings, k)
  // No session ⇒ nothing has been decided, so every provenance window is empty. The
  // week strip still reads, which is what makes the step renderable before a session
  // exists (the same courtesy horizon.ts extends its park bar).
  const since = session?.startedAt ?? null

  const steps = await resolveSteps(householdId, session?.id ?? null)
  const byKey = new Map(steps.map((s) => [s.key, s]))

  const [week, tasks, goals, night, kids, parked, parkedTags] = await Promise.all([
    // The seven columns come from the MEALS step's own read: it is the one place that
    // already buckets a household-local day and drops the meal-plan mirrors. A second
    // week read here would be the thing to drift.
    mealsStepView(tenant, weekStart),
    on('chores') ? getTasksBoard(householdId, weekStart) : null,
    on('goals') && session ? getGoalsStepView(tenant, session.id) : null,
    on('familyNight') ? getFamilyNightBoard(householdId, weekStart) : null,
    session ? kidsReadBack(householdId, session.id) : Promise.resolve([]),
    listParked(householdId),
    parkedKeys(householdId),
  ])

  const [addedEvents, plannedNights, rhythms] = since
    ? await Promise.all([
        eventsAddedSince(householdId, since, weekStart, tenant.personId ?? null, tz),
        on('meals') ? dinnersPlannedSince(householdId, since, weekStart) : Promise.resolve([]),
        on('rhythms') ? rhythmsSettledSince(householdId, since) : Promise.resolve([]),
      ])
    : [[], [], []]

  const mealsOn = on('meals')
  const days: RecapDay[] = week.nights.map((n) => ({
    date: n.date,
    meal: mealsOn ? (n.dinner?.title ?? null) : null,
    cook: mealsOn ? (n.dinner?.cookName ?? null) : null,
    events: n.events.slice(0, DAY_CAP).map((e) => ({
      id: e.id,
      title: e.title,
      when: whenLabel(e.startsAt, e.allDay, tz),
      personName: e.personName,
    })),
    more: Math.max(0, n.events.length - DAY_CAP),
  }))

  const groups: RecapGroup[] = []
  const leftAlone: RecapLeftAlone[] = []

  // ── Calendar ───────────────────────────────────────────────────────────────
  const weekEvents = week.nights.reduce((n, d) => n + d.events.length, 0)
  if (addedEvents.length) {
    groups.push({
      key: 'calendar',
      label: 'Calendar',
      headline: join([`${plural(addedEvents.length, 'event')} added`, `${weekEvents} on the week now`]),
      detail: addedEvents.slice(0, DETAIL_CAP).map((e) => `${e.title} ${e.when}`).join(' · '),
      count: addedEvents.length,
      stepKey: 'calendar',
    })
  }

  // ── Meals + Lists ──────────────────────────────────────────────────────────
  if (mealsOn) {
    const planned = 7 - week.emptyDates.length
    const trip = week.shopping
    const count = plannedNights.length + (trip ? 1 : 0)
    if (count) {
      const tripLine = trip
        ? `${trip.personName ?? 'Nobody yet'} shops ${weekdayOf(trip.dueOn)}${trip.dueTime ? ` ${trip.dueTime}` : ''}`
        : null
      groups.push({
        key: 'meals',
        label: 'Meals + Lists',
        headline: join([
          `${planned} of 7 nights planned`,
          week.groceries ? plural(week.groceries.items, 'grocery', 'groceries') : null,
        ]),
        detail: join([
          ...plannedNights.slice(0, DETAIL_CAP).map((n) => `${weekdayOf(n.date)} · ${n.title ?? 'planned'}`),
          tripLine,
        ]),
        count,
        stepKey: 'meals',
      })
    }
  }

  // ── Chores + Rhythms ───────────────────────────────────────────────────────
  if (tasks) {
    // A chore is a decision when it has BOTH an owner and a day in the week — the
    // step's own question ("who's doing what?") answered. A carried-over one-off counts:
    // it arrives in the week without belonging to a day in it, and somebody owns it.
    const owned = tasks.people.flatMap((p) => p.chores.filter((c) => c.days.length > 0 || c.carriedOver))
    const grabs = tasks.unassigned.filter((c) => c.days.length > 0 || c.carriedOver).length
    const count = owned.length + rhythms.length
    if (count) {
      groups.push({
        key: 'tasks',
        // Only claims the modules it actually read. With rhythms off there is no rhythm
        // line and the label must not promise one.
        label: on('rhythms') ? 'Chores + Rhythms' : 'Chores',
        headline: join([
          `${plural(owned.length, 'task')} with an owner and a day`,
          rhythms.length ? `${plural(rhythms.length, 'rhythm')} settled` : null,
          grabs ? `${grabs} still up for grabs` : null,
        ]),
        detail: [...owned.map((c) => c.title), ...rhythms].slice(0, DETAIL_CAP).join(' · '),
        count,
        stepKey: 'tasks',
      })
    }
  }

  // ── Goals ──────────────────────────────────────────────────────────────────
  if (goals) {
    // `settled` is THIS session's answer. A group carrying `focusGoalId` without it is
    // showing an already-featured goal so nobody re-picks it — a flag we found, not a
    // decision, and counting it would star a tab nobody opened.
    const withFocus = goals.groups.filter((g) => g.settled && g.focusGoalId)
    const noFocus = goals.groups.filter((g) => g.settled && !g.focusGoalId)
    if (withFocus.length) {
      groups.push({
        key: 'goals',
        label: 'Goals',
        headline: `${plural(withFocus.length, 'group')} ${withFocus.length === 1 ? 'has' : 'have'} a focus`,
        detail: withFocus
          .slice(0, DETAIL_CAP)
          .map((g) => `${g.name} · ${g.goals.find((x) => x.id === g.focusGoalId)?.title ?? 'a goal'}`)
          .join(' · '),
        count: withFocus.length,
        stepKey: 'goals',
      })
    }
    // "Nothing this week" is an ANSWER — the design's own example of a deliberate
    // non-answer ("Lottie needed no goal focus").
    for (const g of noFocus) {
      leftAlone.push({
        key: `goal:${g.listId}`,
        label: g.name,
        detail: join([
          g.goals.length ? `${plural(g.goals.length, 'goal')} on the list` : 'nothing tracked yet',
          'no focus needed this week',
        ]),
        badge: 'none',
        stepKey: 'goals',
      })
    }
  }

  // ── Family Night ───────────────────────────────────────────────────────────
  if (night) {
    // Two different skips, and only one row. Calling the GATHERING off (the occurrence)
    // and skipping the STEP are independent — do both and this card would say "Family
    // night" twice and count it twice in `deferred`. The step's own skip wins, because
    // the loop below already renders it.
    if (night.status === 'skipped' && byKey.get('familyNight')?.status !== 'skipped') {
      // Called off, and that is all it says. The rotation is positional — it counts
      // occurrences, not who actually did what — so a skipped week does NOT hold
      // anybody's turn, and a line promising it would be a promise the software can't
      // keep (see familyNight.ts).
      leftAlone.push({
        key: 'familyNight:skipped',
        label: stepTitle('familyNight'),
        detail: night.onCalendar
          ? 'Called off for this week — the gathering stays on the calendar'
          : 'Called off for this week',
        badge: 'none',
        stepKey: 'familyNight',
      })
    } else {
      const pinned = night.parts.filter((p) => p.pinned && p.personName)
      const rotating = night.parts.filter((p) => !p.pinned && p.rotates).length
      if (pinned.length) {
        groups.push({
          key: 'familyNight',
          label: 'Family Night',
          headline: join([`${weekdayOf(night.date)} ${night.time}`, night.theme]),
          detail: join([
            ...pinned.slice(0, DETAIL_CAP).map((p) => `${p.label} · ${p.personName}`),
            // Named as unsettled rather than as a decision: the rotation suggests these,
            // nobody chose them, and nothing is written down.
            rotating ? `${plural(rotating, 'part')} left on rotation` : null,
          ]),
          count: pinned.length,
          stepKey: 'familyNight',
        })
      }
    }
  }

  // ── Kids ───────────────────────────────────────────────────────────────────
  if (kids.length) {
    groups.push({
      key: 'kids',
      label: 'Kids',
      headline: `${plural(kids.length, 'kid')} read back`,
      detail: kids.slice(0, DETAIL_CAP).map((k) => `${k.name}: ${k.line}`).join(' · '),
      count: kids.length,
      stepKey: 'kids',
    })
  }

  // ── Left alone on purpose ──────────────────────────────────────────────────
  // A SKIPPED step is a decision and belongs on the record. A PENDING one is simply
  // unreached, and an unavailable one was never part of this household's session — so
  // neither appears at all.
  for (const s of steps) {
    if (!s.available || s.key === 'recap') continue
    if (s.status !== 'skipped') continue
    leftAlone.push({
      key: `skip:${s.key}`,
      label: s.title,
      detail: 'Skipped — a real answer, and nothing here was changed',
      badge: 'skipped',
      stepKey: s.key,
    })
  }

  // A step ANSWERED whose group turned out to hold nothing: read, and left as it stood.
  // Only checked for steps that have a group — for the three that don't (intake, the
  // horizon scan, connection) there is no honest way to say "nothing changed", so
  // nothing is said.
  const has = new Set(groups.map((g) => g.key))
  for (const spec of GROUP_SPECS) {
    if (has.has(spec.key)) continue
    if (spec.requires && !on(spec.requires)) continue
    const s = byKey.get(spec.stepKey)
    if (!s?.available || s.status !== 'done') continue
    if (leftAlone.some((l) => l.stepKey === spec.stepKey && l.badge !== 'skipped')) continue
    leftAlone.push({
      key: `none:${spec.key}`,
      label: s.title,
      detail: NOTHING_CHANGED[spec.key] ?? 'Read back as it stood — nothing was changed',
      badge: 'none',
      stepKey: spec.stepKey,
    })
  }

  // Notes tagged for a step that will look at them: deferred on purpose, and named by
  // where they are going rather than counted as a loss.
  const tagged = new Map<string, number>()
  for (const key of parkedTags.values()) if (key) tagged.set(key, (tagged.get(key) ?? 0) + 1)
  for (const [key, n] of tagged) {
    const s = byKey.get(key)
    // A note whose step has already gone by in this session (or isn't running at all)
    // waits for the next session — which is precisely the design's "parked for next
    // Sunday". One that is still ahead is waiting at that step.
    const passed = !s?.available || s.status !== 'pending'
    leftAlone.push({
      key: `parked:${key}`,
      label: stepTitle(key),
      detail: `${plural(n, 'note')} parked for ${stepTitle(key)}${passed ? ' — waiting for the next session' : ' — still ahead of you'}`,
      badge: 'parked',
      stepKey: s?.available ? key : null,
    })
  }

  // ── The last call ──────────────────────────────────────────────────────────
  const untagged = parked.filter((p) => parkedTags.get(p.id) === null)
  const lastCall = untagged.slice(0, LAST_CALL_CAP).map((p) => ({ id: p.id, note: p.title, detail: p.detail }))

  return {
    weekStart,
    savedAt: session?.completedAt ?? null,
    days,
    groups,
    lastCall,
    lastCallMore: Math.max(0, untagged.length - lastCall.length),
    leftAlone,
    counts: {
      decisions: groups.reduce((n, g) => n + g.count, 0),
      deferred: leftAlone.length,
      parked: parkedTags.size,
    },
  }
}

// What "answered, and nothing came of it" means per group — a real outcome in the
// design's words, not an apology for an empty list.
const NOTHING_CHANGED: Record<string, string> = {
  calendar: 'Read back as it stands — nothing was added',
  meals: 'Nothing new planned tonight, and no shopping trip claimed',
  tasks: 'Nobody was given anything new — the week already had its owners',
  goals: 'No group singled out a focus',
  familyNight: 'Nobody was pinned — the rotation’s turn stands',
  kids: 'Nobody was read back tonight',
}

// ---------------------------------------------------------------------------
// Kids
// ---------------------------------------------------------------------------

// The kids' two answers, read out of the KIDS step's own `data.kids` — which is where
// they live: they refer to a goal, a chore or free text, so the answer itself has no
// module row of its own.
//
// Deliberately NOT `getKidsStepView`: that builds every card's option lists (four
// modules, the reward ledger, the week's events) to hand back the same two fields, and
// it does not drop an answer whose referent has gone — the label is a snapshot by
// design. Joining `persons` here is what keeps the line honest instead: a child who has
// left the household stops being read back.
async function kidsReadBack(householdId: string, sessionId: string): Promise<{ name: string; line: string }[]> {
  const { rows } = await query<{ data: { kids?: unknown } | null }>(
    `select data from planning_session_steps where session_id = $1 and step_key = 'kids'`,
    [sessionId]
  )
  const raw = rows[0]?.data?.kids
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const answers = raw as Record<string, { focus?: { label?: unknown } | null; forward?: { label?: unknown } | null }>
  // Both halves, or it isn't a read-back — half an answer is not the thing they'll
  // remember (the kids step's own `settled` rule).
  const settled = Object.entries(answers).filter(
    ([, v]) => typeof v?.focus?.label === 'string' && typeof v?.forward?.label === 'string'
  )
  if (!settled.length) return []
  const { rows: people } = await query<{ id: string; name: string }>(
    `select id, name from persons
      where household_id = $1 and deleted_at is null and id = any($2::uuid[])
      order by sort_order, created_at`,
    [householdId, settled.map(([id]) => id)]
  )
  const byId = new Map(settled)
  return people.map((p) => {
    const a = byId.get(p.id)!
    return { name: p.name, line: `${String(a.focus!.label)}, ${String(a.forward!.label)}` }
  })
}

// The crumb the recap hands the session record when the week is saved.
//
// INTEGERS ONLY, and that is the whole of the pointer rule applied to storage: the
// receipt may freeze how MANY decisions were made tonight — a statement about the
// session, which stays true forever — but never WHAT they were, because the things
// themselves are pointers and the modules own them. A title stored here is a copy that
// starts going stale the moment somebody edits it.
export const recapCrumb = (v: RecapView) => ({ counts: v.counts })
