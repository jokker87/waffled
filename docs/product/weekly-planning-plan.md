# Weekly Planning — implementation plan

Status: **in progress** — the module shell + settings have landed; the ten steps land one
at a time behind it.

Source of truth for the design is the `Weekly Planning v4 — Calendar + Meals` canvas in the
Claude Design project. v4 supersedes the v1/v2/v3 canvases: the permanent agenda rail, the
side column, the parallel "Decide" list, the will-write receipt, the capacity read and the
v1 lobby/join-code are all **deliberately gone**. Only two things are lifted from v1: the
"session due" entry point and the notion of settings, which v4 has no screen for.

## The architectural point

**Nine of the ten steps are a read over modules that already exist.** Loose ends are overdue
`chore_instances`, unchecked `list_items`, rhythms past due and short habit goals; the
calendar step is the real `events`; family night is the existing `familyNight` config and its
rotation; connection is a query over `event_participants`; goals set the existing
`is_featured` flag; meals is the existing plan; tasks is the existing chore assignment. The
session therefore stores almost nothing of its own — it *sequences decisions* that land in
the modules that own them.

Two things have no home yet and so get tables:

1. **The session record** — which week, where you are in it, what each step decided, and when
   it was finished (v4 step 10: "saving writes the session record with a timestamp").
2. **Parked items** — what somebody wrote down during the week that "exists nowhere else yet"
   (v4 step 1's *Parked* group, and step 3's "park a note" with its optional step tag).
   *Deferred to the step 1 commit*, so the shell ships no unused schema.

## Surfaces & cadence

API + web for every step, then a sign-off, then iOS parity — **all in one PR**, one commit
per step (repo convention: a batch is one PR). The session is **single-driver**: one person
runs it on one device. `planning_sessions.driver_person_id` is the seam for adding
multi-device presence later without rewriting the schema; nothing realtime ships now.

## Schema (0099)

- `planning_sessions` — one row per household per planned week (`unique (household_id,
  week_start)`), with `status`, `current_step`, `driver_person_id`, `started_at`,
  `completed_at`.
- `planning_session_steps` — `unique (session_id, step_key)`; `status` is
  `pending | done | skipped`, plus a `data` jsonb for the rare decision with no other home.

## Which week does a session plan?

The **server** owns the week boundary (the grocery/meal-planner lesson: a client that computes
its own week writes rows nothing will read again). `plannedWeekStart()` honors the household's
`week_start` and timezone: if today *is* the household's week start the session plans this
week, otherwise it plans the next one — so a Sunday session plans the week ahead in both a
Sunday-start and a Monday-start household.

## Steps and gating

The ten steps are a **server-owned catalog** (`STEPS` in `weeklyPlanning.ts`) so web and iOS
cannot drift on order, titles or the question each step asks. A step is skipped over
automatically when the module it reads is off (`requiresModule`), and a household can also
turn one off by hand (`settings.weeklyPlanning.steps`). Steps that aren't built yet are simply
absent from the catalog, which is what makes the incremental build possible.

| # | key | act | reads |
|---|-----|-----|-------|
| 1 | `looseEnds` | Intake | chores, lists, rhythms, goals |
| 2 | `calendar` | Frame the week | events |
| 3 | `horizon` | Frame the week | events (month) |
| 4 | `familyNight` | Claim the good | familyNight |
| 5 | `connection` | Claim the good | event_participants |
| 6 | `goals` | Claim the good | goals / goal_lists |
| 7 | `meals` | Run the household | meals, lists |
| 8 | `tasks` | Run the household | chores |
| 9 | `kids` | Run the household | goals, chores |
| 10 | `recap` | Close | everything above |
