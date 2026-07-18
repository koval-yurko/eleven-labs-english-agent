-- 0008_soft_delete_lessons.sql — a lesson can be deleted without losing its words or their history.
--
-- See docs/2026-07-17-delete-lesson-keep-words.md.
--
-- "Delete a lesson" is a SOFT delete, mirroring lesson_items.removed_at (0003) one level up: the
-- lesson leaves the UI, but its lesson_items and lesson_sessions rows STAY. That retention is the
-- whole point —
--   * each word keeps the practice credit it earned in the lesson (owner_item_practice is unchanged
--     and still counts those sessions), and
--   * a future Archive page can list, restore, or permanently delete what was removed.
--
-- The one subtlety is that the two derived views now DIVERGE on what a deleted lesson means:
--   * owner_items (attachment / chips) treats it as NOT attached — so a word whose only lesson was
--     just deleted reads as unattached (lesson_count 0) immediately.
--   * owner_item_practice (credit) still counts it — so that same word keeps its practice_count.

-- ---------------------------------------------------------------------------------------------
-- 1. The flag
-- ---------------------------------------------------------------------------------------------
alter table lessons add column deleted_at timestamptz;  -- null = active

-- The active-lessons list is the hot path; keep it a partial index so soft-deleted rows never widen
-- it. lessons_owner_created_idx (0002) stays as-is — it covers the Archive page's `deleted_at is not
-- null` scan.
create index lessons_owner_active_idx on lessons (owner_id, created_at desc) where deleted_at is null;

-- ---------------------------------------------------------------------------------------------
-- 2. Rebuild owner_items so a soft-deleted lesson stops counting toward attachment
-- ---------------------------------------------------------------------------------------------
-- owner_item_practice is deliberately NOT touched: it counts sessions held while the word was linked,
-- regardless of whether the lesson was later soft-deleted, which is exactly what preserves credit.
--
-- Only change here vs 0007: `l.deleted_at is null` added to each of the three attachment aggregates.
-- The aggregates count i.lesson_id (from lesson_items, non-null even when the word's only lesson is
-- deleted), so the deleted lesson has to be excluded by the filter, not the join. Same column list as
-- 0007, so `create or replace view` applies in place.
create or replace view owner_items with (security_invoker = true) as
select
  w.id,
  w.owner_id,
  w.norm_key,
  w.text,
  lesson_item_kind(w.norm_key)                                                             as kind,
  count(distinct i.lesson_id) filter (where l.deleted_at is null)                          as lesson_count,
  count(distinct i.lesson_id)
    filter (where i.removed_at is null and l.deleted_at is null)                           as active_lesson_count,
  w.created_at                                                                             as first_added_at,
  coalesce(
    jsonb_agg(distinct jsonb_build_object('id', l.id, 'title', l.title))
      -- `i.lesson_id is not null` keeps a word with no links from emitting a phantom {null,null}
      -- chip (0007); `l.deleted_at is null` drops the just-deleted lesson's chip.
      filter (where i.removed_at is null and i.lesson_id is not null and l.deleted_at is null),
    '[]'::jsonb)                                                                           as lessons,
  coalesce(p.practice_count, 0)                                                            as practice_count,
  p.last_practiced_at,
  w.level,
  w.level_source,
  w.is_favorite,
  w.categories
from words w
left join lesson_items i on i.word_id = w.id
left join lessons      l on l.id = i.lesson_id
left join owner_item_practice p on p.owner_id = w.owner_id and p.word_id = w.id
group by w.id, p.practice_count, p.last_practiced_at;

-- RLS: soft delete is an UPDATE on `lessons`, already covered by the "lessons owner update" policy
-- 0007 added. lesson_items / lesson_sessions aren't touched. DELETE policies are deferred to whenever
-- the Archive page implements permanent deletion (the hard cascade this design intentionally avoids).
