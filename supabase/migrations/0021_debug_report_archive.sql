-- 0021_debug_report_archive.sql — get a dealt-with report out of the list without deleting it.
--
-- See docs/2026-09-09-mobile-debug-reports-and-feedback.md §12.4.
--
-- ## Why a column and not another `status` value
--
-- 0019 made `status` unconstrained text precisely so a new triage state needs no migration, so
-- `status = 'archived'` is the cheap move. It is also wrong: archiving a report would overwrite
-- the fact that it was RESOLVED, and "resolved" is the thing worth keeping — §14's retention
-- sweep keys on it, and the detail page's resolution note is only meaningful next to it. The two
-- axes are independent: triage says what a report turned out to be, archive says whether it still
-- belongs in front of someone. A resolved report that is not archived is a fix filed today; an
-- archived report that is still `new` is one that was never worth triaging.
--
-- ## Why a timestamp and not a boolean
--
-- Same reason `captured_at` is not a flag: "archived" is an event, and the only question anyone
-- asks afterwards is when. It costs the same eight bytes as a nullable boolean would, and `is
-- null` is the same predicate either way.
--
-- This is the THIRD mutable field on a table whose 0019 comment calls a report an observation.
-- The claim still holds — the observation itself is immutable; status, resolution and archived_at
-- are all the operator's annotations on top of it, which is why none of them gets an `updated_at`.

alter table debug_reports add column archived_at timestamptz;

comment on column debug_reports.archived_at is
  'When an operator archived this report, or null while it is still in the list. Independent of '
  'status: archiving does not change what a report turned out to be, it only stops showing it.';

-- The default list is "not archived, newest first", and it is the only query that runs on every
-- page load. A partial index on exactly that predicate stays small as the archive grows, which is
-- the point — the archive is unbounded by design and the list is not.
create index debug_reports_active_idx on debug_reports (owner_id, created_at desc)
  where archived_at is null;
