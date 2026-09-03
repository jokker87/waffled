-- Up Migration
-- Family Night, two things the weekly-planning step needs and the module never had.
--
-- 1. A PART CAN SAY WHAT IT ACTUALLY IS. `family_night_assignments` recorded only WHO
--    had a part ("Kramer has the treat") and there was nowhere to put WHAT it is ("the
--    good ice cream"). `family_night_occurrences.notes` is one note for the whole
--    gathering, so three parts sharing it means three answers in one text field with no
--    way to render them beside the people they belong to.
--
-- 2. THIS WEEK'S GATHERING CAN POINT AT A CALENDAR EVENT. `settings.familyNight.eventId`
--    already links a RECURRING event created from the configured day and time — that is
--    a standing arrangement, set once in Settings by an admin. It cannot answer "this
--    week we're doing it Friday, and it's the movie night that's already on the
--    calendar": there is one config field for all weeks, and `scheduleEvent()` always
--    creates a fresh series rather than adopting an event that exists.
--
--    So the link belongs on the occurrence, which is the same reasoning that already
--    puts a pinned person there: an occurrence is one dated gathering, which is what
--    makes "this week only" true rather than aspirational. The two live side by side —
--    config.eventId is the standing series, occurrences.event_id is this week's answer.
--
-- `on delete set null`, not cascade: deleting the calendar event must not delete the
-- gathering or its assignments. The gathering happened; it just is not on the calendar
-- any more.

alter table family_night_assignments
  add column detail text,
  -- Whether anybody has made a statement about WHO has this part.
  --
  -- `person_id IS NULL` already means something else — "explicitly nobody yet", the
  -- result of taking a pin back off, which the module deliberately keeps distinct from
  -- snapping back to the rotation's guess. So it cannot also mean "unset", and a row
  -- that exists only to hold a detail needs a way to say the rotation still decides who.
  --
  -- Defaults TRUE because every row that exists today was created by a person write, so
  -- the backfill has to keep reading as pinned.
  add column person_set boolean not null default true;

comment on column family_night_assignments.detail is
  'What this part IS this week ("the good ice cream", "charades"), free text, alongside person_id which says who has it. Null = nobody has said; the API clears it with an empty string, since a null on the way in means "leave it alone".';

comment on column family_night_assignments.person_set is
  'False = this row holds only a detail and WHO still comes from the rotation. Needed because person_id IS NULL already means "pinned to nobody".';

alter table family_night_occurrences
  add column event_id uuid references events(id) on delete set null;

comment on column family_night_occurrences.event_id is
  'The calendar event for THIS dated gathering — created for it, or an event that already existed and was adopted. Distinct from settings.familyNight.eventId, which is the standing recurring series. Null = this week is not on the calendar.';

-- Finding the gathering that adopted a given event, so deleting or moving an event can
-- ask what it was standing in for. Partial: almost every row is null.
create index ix_fn_occ_event on family_night_occurrences (event_id) where event_id is not null and deleted_at is null;

-- Down Migration

drop index if exists ix_fn_occ_event;
alter table family_night_occurrences drop column if exists event_id;
alter table family_night_assignments
  drop column if exists person_set,
  drop column if exists detail;
