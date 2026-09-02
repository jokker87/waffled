-- Up Migration
-- Weekly Planning — the session record (docs/product/weekly-planning-plan.md).
--
-- The module is a *sequencer*, not a store: nine of its ten steps are a read over
-- modules that already exist, and every decision they take lands in the module that
-- owns it (an event, a chore assignment, goals.is_featured, the meal plan). So the
-- only thing with no other home is the session itself — which week it planned, where
-- the driver is in it, what each step answered, and when it was finished.
--
-- Parked items (the one other thing that "exists nowhere else yet") deliberately do
-- NOT live here: they arrive with step 1, so the shell ships no unused schema.

create table planning_sessions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,

  -- The week being PLANNED, always a household week start (the server snaps it — a
  -- client that computes its own week boundary writes rows nothing will read again;
  -- see the grocery week_start lesson in apps/api/CLAUDE.md's neighbours).
  week_start date not null,

  status text not null default 'active' check (status in ('active','completed')),

  -- Where the driver is. A step key from the server-owned catalog in
  -- weeklyPlanning.ts, not an index — steps a household has turned off are skipped
  -- over, so ordinals would drift between households.
  current_step text,

  -- Single-driver by design (v4 dropped v1's lobby and join code). This column is the
  -- seam for adding multi-device presence later: a planning_session_participants table
  -- can join here without rewriting anything above.
  driver_person_id uuid references persons(id) on delete set null,

  started_at timestamptz not null default now(),
  completed_at timestamptz,

  -- One session per household per planned week. Re-running the session resumes this
  -- row (and reopening a finished one clears completed_at) rather than accumulating
  -- half-finished duplicates for the same seven days.
  unique (household_id, week_start)
);

create index planning_sessions_household_week_idx on planning_sessions (household_id, week_start desc);

create table planning_session_steps (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references planning_sessions(id) on delete cascade,

  -- Catalog key ('calendar', 'meals', …). Validated in the service against STEPS, not
  -- by a check constraint here: the catalog grows one step per commit, and a new step
  -- key must not need a migration.
  step_key text not null,

  -- 'skipped' is a real answer, not a failure — the design leans on that.
  status text not null check (status in ('pending','done','skipped')),

  -- The rare crumb a step decides that no module owns (e.g. "3 nights were auto-filled
  -- and can still be undone"). Never a copy of module data: the recap reads through to
  -- the modules, so duplicating here would let the two disagree.
  data jsonb not null default '{}'::jsonb,

  decided_at timestamptz not null default now(),

  unique (session_id, step_key)
);

-- Down Migration
drop table if exists planning_session_steps;
drop table if exists planning_sessions;
