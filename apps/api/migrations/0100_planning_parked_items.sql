-- Up Migration
-- Weekly Planning · step 1 "Loose ends" — the PARKED half of the step
-- (docs/product/weekly-planning-plan.md).
--
-- Step 1 is INTAKE: it ROUTES loose ends to the steps that will handle them rather
-- than fixing them itself ("routing here changes nothing in your modules — it only
-- decides which step handles it"). Those routing decisions live on the session, in the
-- `data` jsonb 0099 already reserves, as { routes: [{ kind, id, title, source, to }] }.
--
-- So of the step's two groups, only one needs a table at all:
--
--   "Not done"  is COMPUTED from the modules that already own the work — overdue
--               chore_instances, unchecked list_items, rhythms past due, habit goals
--               short for the week. Nobody typed those; they are simply still open,
--               which is why there is no lookback log anywhere and no copy of them
--               here.
--
--   "Parked"    is what somebody WROTE DOWN during the week and that exists nowhere
--               else yet. It has no owning module, so it lives here — and it is the
--               one group where Drop is a real answer, because dropping it destroys
--               nothing but the note.
--
-- Deliberately general, because step 1 is not its only writer. Step 3 ("Horizon scan")
-- parks a note from the month view, and any later surface that wants a "remember this
-- for the session" scratchpad can insert here without a migration: the table knows
-- nothing about who parked a note beyond the tag and the session.

create table planning_parked_items (
  id uuid primary key default gen_random_uuid(),

  -- Household-scoped, not session-scoped: see session_id below. A note outlives any
  -- one session, so the household is what owns it.
  household_id uuid not null references households(id) on delete cascade,

  -- The note itself, as typed. Free text on purpose — the whole point of the group is
  -- that the thing has no shape yet; giving it one would push it into a module.
  note text not null,

  -- Optional tag naming the STEP THIS NOTE BELONGS TO, and it is written from both
  -- ends of the session: step 3 ("Horizon scan") parks a note tagged 'horizon', and
  -- step 1 sets it when somebody ROUTES the note ("make it a task" → 'tasks'). Either
  -- way it answers the same question — which step is going to look at this? — so one
  -- column serves both, and a later step can find the notes addressed to it.
  --
  -- Deliberately NOT a foreign key or a check constraint: the step catalog (STEPS in
  -- weeklyPlanning.ts) grows one step per commit and is validated in the service,
  -- exactly as planning_session_steps.step_key is. Null = nobody has said yet.
  step_key text,

  -- 'open' until somebody answers it in step 1: 'resolved' when the family talked it
  -- through there and then ("two minutes, then decide"), 'dropped' when it turned out
  -- not to matter. 'dropped' is a real answer, not a failure — and it is only ever a
  -- real answer HERE, because dropping a computed "not done" item would mean deleting
  -- another module's data, which planning has no business doing.
  --
  -- A ROUTED note stays 'open': routing only says which step will look at it, and the
  -- note is still unanswered until that step (or a later session) settles it. That is
  -- also what makes the card's "passed over N times" line true — it counts the
  -- sessions that have finished since the note was written.
  status text not null default 'open' check (status in ('open','resolved','dropped')),

  -- Which session parked it, when one did. NULLABLE, and `on delete set null` rather
  -- than cascade: "Start this week over" discards the session record and (by cascade)
  -- its step decisions, but everything the session produced stays where it landed —
  -- the event that got added, the chore that got assigned, and a note somebody wrote
  -- down. Losing the note with the session would be the destructive surprise that
  -- deleteSession() exists to avoid. Null also covers a note parked outside any
  -- session at all.
  session_id uuid references planning_sessions(id) on delete set null,

  created_by uuid references persons(id) on delete set null,
  created_at timestamptz not null default now(),

  -- The state change worth recording. No `updated_at` (and so no trigger): editing a
  -- parked note is not a thing the step offers — a note is written once and then
  -- answered — and resolved_at/resolved_by is the only history anyone reads.
  resolved_at timestamptz,
  resolved_by uuid references persons(id) on delete set null
);

-- The step's one read: this household's open notes, oldest first (a note that has been
-- waiting longest is the one most worth answering). Partial on status so the index
-- stays the size of the open set rather than of every note ever answered.
create index planning_parked_items_open_idx
  on planning_parked_items (household_id, created_at)
  where status = 'open';

-- Down Migration
drop table if exists planning_parked_items;
