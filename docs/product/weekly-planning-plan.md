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
   Landed with step 1 as `planning_parked_items` (**0100**), so the shell shipped no unused
   schema. `session_id` is nullable `on delete set null`: discarding a session must not delete
   a note somebody wrote down.

### Step 1 routes; it does not resolve

The one refinement wave 1 made to the claim above. v4's see-all screen says it outright —
*"Routing here changes nothing in your modules — it only decides which step handles it"* — so
**step 1 is triage**: an overdue chore is sent to *Tasks*, an appointment to *Calendar*, a kid's
thing to *Kids*. The step that owns the work does it later, which is why the Tasks mock captions
items "sent here in step 1". Only two of its actions write to a module: "It's done already" and
"Drop it".

**The routes contract** (read by steps 2, 6, 8, 9 and eventually 10): step 1 records
`{ routes: [{ kind, id, title, source, to }] }` in its own `planning_session_steps.data`, where
`to` is a step key. Every step already receives the whole view, so a consumer reads
`view.steps.find(s => s.key === 'looseEnds')?.data.routes` and filters on its own key — no new
table, and no shared file to edit. `LooseEndRoute` is exported from
`apps/web/src/lib/api/planning/looseEnds.ts`. Re-routing replaces rather than stacks, `to: null`
un-routes, and **a route is retired when its item is settled**, so a later step is never handed
something its own module already considers done. The array is a decision *log*, not a queue.

## Surfaces & cadence

API + web for every step, then a sign-off, then iOS parity — **all in one PR**, one commit
per step (repo convention: a batch is one PR). The session is **single-driver**: one person
runs it on one device. `planning_sessions.driver_person_id` is the seam for adding
multi-device presence later without rewriting the schema; nothing realtime ships now.

### Changes outside the step seams that iOS parity must mirror

A step is allowed to want something from a component it doesn't own. When that happens the
change lands in the shared component, not in a copy — and it has to be carried to iOS too,
so it is written down here rather than discovered during the parity pass:

- **`ChoreModal` offers a one-off's day on edit, not just on create** (and the Tasks step's
  inline date picker is gone — the day chip opens that same editor). `PATCH /api/chores/:id`
  already moved the pending instance; the modal simply sends it. Two things not to lose in
  translation: `ChoreDraft.dueOn` is **required**, because the form falls back to today and an
  omitted day is indistinguishable from "move it to now"; and the day is **not floored at
  today when editing**, because a carried-over task is dated in the past and is the likeliest
  thing anyone opens here.
- **The recipe picker can write a new plate, not just a new recipe** — see the Meals step.

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

That's only the **default**. A family getting in front of a trip can plan further out:
`GET /api/weekly-planning?weekStart=` and `POST /session { weekStart }` take any week, and
`resolveWeekStart()` is the one gate in front of them — it rejects nonsense (→ the default),
**snaps** a mid-week date to its week start (naming "the Wednesday of the trip" must not key a
session to a day), and clamps to the floor. The floor is the household's *current* week: a week
that has already finished has nothing left to decide. The view returns `weekStart`,
`defaultWeekStart` and `minWeekStart` so a client can render a stepper without doing any week
arithmetic of its own.

## The URL is the state (web)

`/planning/:step`, with `?week=` when it isn't the default week. Leaving the module and coming
back, a refresh, the back button and a pasted link all land on the right step. Bare `/planning`
is the entry point: it shows the lobby, or rewrites itself (`replace`) to the step the session
resumed at, and a path naming a step that can't run falls back rather than stranding on a blank
screen.

This is deliberately **two** pointers, and they answer different questions: the URL is where
*this browser* is, and `planning_sessions.current_step` is where the *family* is — which is what
lets the iPad resume where the phone left off. Answering a step writes both.

## Both doors out of a session

Because returning to Planning always **resumes**, the lobby is otherwise unreachable once a week
has a session — so the session has to offer two exits, and both live in the agenda sheet (the
"where am I" surface) rather than the step chrome:

- **Leave for now** — go to Today; the session stays exactly where it is. The sheet already
  promises you can "leave whenever the week is decided", so it has to offer the door.
- **Start this week over** — `DELETE /session/:id`, which discards the session record and (by
  cascade) its step decisions, putting the week back to its lobby. It confirms in place first,
  and says plainly what survives: **everything the session decided stays where it landed** — the
  event that got added, the chore that got assigned, the goal that got featured. The session
  sequences decisions into other modules; it has no business deleting their data. Also offered on
  the finished record, which is the other place you'd look for "do this week again".

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

## Building the steps in parallel

The shell is finished and the seams are cut, so steps can be built concurrently. **The rule is
one file per step per side — nobody edits a shared file.**

Building step `<key>` (`<Pascal>`) means touching only:

| What | Where |
|---|---|
| The step body | `apps/web/src/kiosk/planning/steps/<Pascal>Step.tsx` |
| Its styles | `apps/web/src/styles/planning-<key>.css` (new file, imported by the body) |
| Its API client | `apps/web/src/lib/api/planning/<key>.ts` |
| Its routes | `apps/api/src/modules/weeklyPlanning/steps/<key>.routes.ts` |
| Its service logic | `apps/api/src/modules/weeklyPlanning/steps/<key>.ts` |
| Its tests | `apps/api/test/weekly-planning-<key>.integration.test.ts`, `apps/web/src/kiosk/planning/steps/<Pascal>Step.test.tsx` |

All of those are already created and **already wired up**, which is the point:

- `apps/web/src/kiosk/planning/registry.ts` maps all ten keys to all ten files and defines
  `StepBodyProps` — the contract between the shell and a step. A step exports
  `{ Body, FooterExtra? }` as its default; `FooterExtra` puts one more control in the footer
  beside Skip and the affirmative (v4 uses it for Meals' "✨ Plan the rest for me").
- `apps/api/src/modules/weeklyPlanning/steps/index.ts` lists all ten route registrars, so
  `weeklyPlanning.routes.ts` never needs editing.
- `apps/web/src/lib/api/planning/index.ts` re-exports all ten clients, so `lib/api/index.ts`
  never needs editing.

**Do not edit** `WeeklyPlanning.tsx`, `planning.css`, `weeklyPlanning.routes.ts`,
`weeklyPlanning.ts`, `lib/api/weeklyPlanning.ts`, `registry.ts` or either `index.ts`. If a step
seems to need a change there, that's a shell change — raise it rather than editing, because ten
branches editing the shell is exactly what these seams exist to prevent.

### Sequencing

Three steps aren't free to go in any order:

1. ~~**`looseEnds` goes first**~~ — **done.** It owns `planning_parked_items` (**0100**) and the
   routes contract above. `horizon`'s "park a note" writes to the same table and can now start.
2. **`recap` goes last** — it reads what every other step decided, including step 1's routes.
3. Everything else (`familyNight`, `connection`, `kids`) is independent.

**Wave 1 landed:** `looseEnds`, `calendar`, `goals`, `meals`, `tasks`. Remaining: `horizon`,
`familyNight`, `connection`, `kids`, then `recap`.

### Two things wave 1 taught, worth knowing before writing a step

- **`setDecisionData` is not storage.** It only reaches the server when the step is *answered*,
  so anything a step must find again on a later visit has to be derived from the module that owns
  it, with the crumb as a hint at most. The Meals step's shopping trip is the worked example.
- **A step body that throws costs only that step.** `StepErrorBoundary` wraps each body, so the
  counter, the agenda sheet and both footer controls survive — don't add defensive try/catch
  around a whole body to protect the session.

**Migration numbers are assigned centrally, never picked by a step** — CI's migration-hygiene job
fails the PR on a collision. Only `looseEnds` has one (0100). Any other step that turns out to
need schema asks for a number first.

### What a step agent runs, and what it doesn't

Each agent runs **only its own tests**: its one API integration file (one testcontainer Postgres)
and its one web test file. It does **not** run the full suites, and it does **not** run Playwright
— `playwright.config.ts` pins the preview server to port 4178, so two concurrent e2e runs collide
on that port no matter which worktree they're in. The full suites, the e2e pass and the live check
on the demo stack happen once per merge, on the feature branch.

### Branching

Steps land as **one commit each on the single feature branch** (repo convention: a batch is one
PR). An agent working in its own worktree branches from the **feature branch**, not `origin/main`
— the shell isn't on main — and its commit is cherry-picked over, which keeps the history one
linear commit per step instead of a fan of merge commits.
