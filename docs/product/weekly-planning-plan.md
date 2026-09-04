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
- **The recipe picker can build a plate, not just write a recipe.** `RecipeBrowser` grew a
  **＋ New meal** button beside ＋ New recipe, gated on `onPickMeal` exactly as the plate cards
  are. It hosts `MealBuilderBody` — the Meal Builder screen split into a routing wrapper plus a
  router-free body, the same split `RecipeEditor` / `RecipeEditorBody` already uses, and for the
  same reason. The body's optional callbacks are render contracts: no `onOpenDish` means dish
  rows aren't tappable (there is nowhere to open them to), and supplying `onUse` takes Schedule
  and Add-plate-to-list off the bar, because inside a picker the destination is already decided
  by the slot. New plates are created `isSaved: true` — the library is the symmetric reading of
  "＋ New meal", and being saved is also what makes scheduling copy the plate. **Cancel
  must delete the plate**: the builder creates lazily on the first *dish*, so by the time
  anybody changes their mind a real, saved, empty "New meal" is already in the library —
  the picker holds the id `onIdChange` reports and removes it on close. Verified against
  the live library, not a mock, because a mock cannot show you a leak.

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

**Wave 1 landed:** `looseEnds`, `calendar`, `goals`, `meals`, `tasks`.
**Wave 2 landed:** `horizon`, `familyNight`, `connection`, `kids` — four agents in four
worktrees, merged with zero conflicts. **`recap` landed last**, because it reads what every
other step decided. **All ten steps are built on web.** What remains for the module is iOS
parity.

### The recap stores nothing, and why that is the whole design

The record is **a receipt of what was decided, not a copy of it** — "every line is a pointer".
So step 10 writes no snapshot: `GET /api/weekly-planning/recap` resolves every line at read
time, and the distinction that makes it safe is worth keeping:

- **A statement about the WEEK is live** — "6 tasks with an owner and a day" is re-resolved on
  every read, so it cannot go stale. Storing that number *is* the copy the design forbids.
- **A statement about the SESSION is provenance** — "2 events added since you started" is
  `created_at >= session.started_at` on the row the decision actually wrote. Delete the event
  and the line goes with it. Historical *and* re-derivable, which is what lets one receipt be
  both a delta and a pointer.

**The step crumbs are deliberately NOT used for tallies**, even though several hold exactly the
numbers the mock wants. `setDecisionData` is cleared on every step change and persisted only
when a step is *answered*, so `{ added: 2 }` really means "2 added during the visit that
happened to end in Done" — leave the step and come back and it reads 0. A provenance query
cannot fail that way. The crumbs recap *does* read are the ones that ARE the decision and have
no module row: the goals focus map and the kids' answers.

### The parked-note handoff belongs to the shell

`planning_parked_items.step_key` names a DESTINATION — "which step is going to look at
this" — and both producers write it: step 1's triage when it routes a loose end, and step
3's park bar when somebody tags a note. For a while nothing read it. Only steps 1, 3 and
10 touched the table at all, so a note tagged for Meals or Tasks was never seen again
until the recap's last call, which is *after* the step that could have acted on it. It was
reported exactly that way: "I added a bunch to the park it thing, expecting to go over
them in the appropriate step but I never saw them again, where did they go?"

(Kids looks like a counter-example and isn't. It honours the ROUTES contract, but
`resolveRoutedKeys` maps only goals and chore instances, and its own comment says a parked
note "belongs to no particular child" and is left alone. Free text reached nothing.)

**The banner is the shell's, not each step's** — `Handoff` in `WeeklyPlanning.tsx`, fed by
`SessionStep.parked` on the session view:

- it is identical on all ten steps, so ten copies would be nine chances to drift;
- the shell already refetches the session view after every write, so a note dealt with
  anywhere stops being offered everywhere for free;
- each step's OWN affordances are what act on the note. The banner's job is to put it back
  in front of you at the moment it is actionable, not to become a tenth way to add a chore.

It rides on the session view rather than a new endpoint, and both answers go through the
resolve route steps 1 and 10 already use — no second mechanism for either half. **iOS
parity gets this for free from the shell**; there is nothing per-step to build.

Three exclusions are deliberate: `looseEnds` (it already draws the whole board — handing
its own notes back would double every row), a NULL tag (an untagged note is nobody's yet,
which is precisely the recap's last call; giving it to all ten steps would put the same
unanswered note on every screen), and anything past six on one step (a nudge, not an
inbox). It is **not** scoped to the session either: surviving the session that wrote it is
what parking is FOR.

### Family night grew two columns, and one of them is subtler than it looks

`assignments.detail` is the obvious half: the tables recorded only WHO had a part, and
`occurrences.notes` is one note for the whole gathering, so three parts sharing it meant
three answers in one field with nowhere to render each beside its person.

`assignments.person_set` is the half worth remembering. Writing what a part IS says nothing
about whose turn it is, so a detail-only write must leave the rotation's suggestion
standing — and `person_id IS NULL` could not carry that, because it already means
"pinned to nobody", the result of taking a pin back off, which the module deliberately
keeps distinct from snapping back to the rotation's guess. Hence a third column, defaulting
TRUE so every existing row keeps reading as pinned, and sticky on update so a later
detail-only write can't hand a claimed part back to the rotation.

That distinction runs to the wire: **presence is the message.** The occurrence route copies
each field only when the caller sent it, and the client sends a detail with no `personId`
key at all. The route used to do `{ partId, personId: a.personId ?? null }`, which would
have turned "I named the treat" into "…and nobody has it".

`occurrences.event_id` is this week's calendar event, distinct from
`settings.familyNight.eventId`'s standing recurring series — one field for every week, set
in Settings, which cannot express "this week it's the movie night already on Friday".
Creating one is a SERVER call (`createOccurrenceEvent`, modelled on the existing
`scheduleEvent`) and deliberately not a create-then-adopt round trip: the web app writes
events LOCALLY first and PowerSync uploads afterwards, so an id handed back by the client
may not exist server-side yet and the link would 404 on a race nobody could reproduce.

### Where a kid's focus is visible, and why it is a read

The Kids step's answers live in `planning_session_steps.data.kids` and were read by
exactly two things: the step itself, which shows them back, and the recap. So a child said
what their one thing was on planning night and never saw it again — asked directly during
validation ("where would I be able to see that focus outside of the weekly planning?").

It surfaces on **that child's Family profile** (`/person/:id`), which is where "what
they're working on" already lives beside their goals, streak and stars — rather than
becoming a fourth place to look. `focusForPerson()` in the Kids step is the read;
`GET /api/persons/:id/overview` calls it behind a `weeklyPlanning` module gate.

Two things about it worth keeping:

- **It is a READ, never a copy.** The session record stays the single place the answer is
  stored, exactly as the recap treats its own lines. Nothing to keep in sync, and editing
  the answer changes both screens at once.
- **The week is found by CONTAINMENT** (`week_start <= today < week_start + 7`), not by
  computing a boundary in the query. A session run on Sunday plans the week *ahead*, so by
  Wednesday the focus somebody is living with belongs to the session whose week contains
  today — and containment gets that right without needing to know how the household cuts a
  week (`week_start` is per-household SUNDAY or MONDAY, and a boundary computed here could
  disagree with the one the session was created under).

The card is presence-gated: module off, no session covering this week, and nobody answered
all collapse to `null`, because all three mean "nothing to say" to a reader.

### What the second validation pass changed, and the two rules it settled

Ten items, and the two worth keeping as rules rather than as fixes:

- **A tag is a DESTINATION, so it can only name a step still ahead.** The Horizon bar
  offered Calendar — step 2, from step 3 — which addressed a note to a step you had
  already walked past; it could only resurface in a LATER session. The list is now derived
  from `STEPS` order rather than hand-kept, so a step added to the catalog needs nothing
  done, and a step opts in by having a hint (which is what keeps `recap` out: it reports
  the session and settles nothing). The old three-key list was correct when only steps 1,
  3 and 10 read `planning_parked_items`; the shell's handoff banner is what made every
  later step a real destination.

- **A local-first write and a server read are not the same clock.** `EventModal` saves
  through PowerSync and uploads afterwards, so a step that re-reads the SERVER at
  `onSaved` asks before the server has been told. Connection did exactly that, and the
  failure was the worst shape available: the event appeared on the calendar (which renders
  the local mirror) while the pairing underneath went on saying nothing was there. It now
  re-reads on a widening ladder until the credit count moves. **Any step that writes an
  event through the shared modal and then reads the server has this problem** — the fix is
  the timing, not a second source of truth; crediting from the local mirror would move the
  row's sentence (title, duration, the household's clock) onto the device, which is the
  thing this module composes server-side on purpose.

Also settled: the parked-note banner now borrows the step's own verb ("Make a task",
"Make an event") and opens that step's EXISTING composer via `useHandoffAction` — a step
with no composer lends nothing and keeps "Handled", because a button promising an action
it does not perform is worse than the plain one. And Connection's acknowledgement became
a real **link** (which event answers this pairing), persisted through the step's own
record at its current status — an id is a pointer, not a copy, so it sits beside the
counts without breaching the "crumbs are counts, never module data" rule.

### What wave 2 found, and what is still open

Building a step against a shipped module is also an audit of it. Three findings survived:

- **Skipping a family night advances the rotation — SETTLED, and it stays.** `rotationIndex()`
  counts every occurrence regardless of status, so calling a week off moves everybody on a
  place. The design's draft said the opposite ("marks the occurrence skipped *without
  advancing the rotation*"); raised as a bug, it was settled the other way as a product
  call. If a skipped week cost nothing, the same person would be up again next week and
  again the week after, for as long as the family kept skipping — nobody did the part, but
  the turn passed. The skip bar now says the turn moved on, since a rotation that shifts
  silently is the confusing part. `weekly-planning-familyNight.integration.test.ts` pins
  the rule; **do not add `and status <> 'skipped'` to `rotationIndex()`.**
- **The rotation is positional, not historical** — it never reads `family_night_assignments`,
  so pinning someone who was already next means they can come up twice. The mock's line
  "worked out from who did what last time" was rewritten to "each part taken in turn, in your
  family's order", because the original is a promise the software can't keep.
- **A parked note's `step_key` is the DESTINATION step, never `'horizon'`.** 0100's comment
  sketched step 3 tagging its own name; that contradicts the column's own stated semantics
  ("which step is going to look at this?" — never the step that wrote it) and would make a
  note parked at the horizon invisible to the step meant to act on it. Corrected in the
  migration's comment.

Two defects the unit tests structurally could not see, both found by driving :8081:

- **The month grid overflowed its box in Horizon** and painted over the park bar. `.cal` is a
  grid item, so its default `min-height: auto` refused to shrink below six rows of content;
  the calendar page never shows this because its own ancestors already zero that out.
- **The meal plan filled the kids' cards.** Planning a dinner mirrors it onto the calendar as
  a real event with the household on it, so every kid's week read "Dinner · chicken, Dinner ·
  Spaghetti…" and their look-forward-to options became the meal plan. Mirror origins are now
  excluded, the same exclusion `goal-calendar.ts` already makes.

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
