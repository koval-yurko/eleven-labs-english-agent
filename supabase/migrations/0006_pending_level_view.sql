-- 0006_pending_level_view.sql — the level job's work queue.
--
-- 0004 reserved lesson_item_attrs.level / level_source / level_at for "a future background job".
-- This is the only schema that job needs: no new table, no new column, no constraint change.
-- See docs/2026-07-16-level-assignment-background-job.md.

-- Pending == level_at is null. NOT `level is null`: an item the model has no answer for keeps a
-- null level forever, so that predicate would re-ask about it on every sweep. level_at separates
-- "never looked at" from "looked at, nothing came back" — identical on the page, opposite here.
--
-- LEFT JOIN because lesson_item_attrs is sparse: an untouched item has no row at all, which reads
-- through the join as level_at is null → pending.
--
-- Exists because owner_items exposes level and level_source but not level_at, so the job can't see
-- its own flag through the view the page uses. A separate view leaves owner_items untouched.
create view owner_items_pending_level with (security_invoker = true) as
select i.owner_id,
       i.norm_key,        -- the upsert key
       i.text,            -- the learner's most recent spelling — what the model is asked about
       i.kind,            -- 'word' | 'phrase' | 'sentence' — a prompt hint, not a branch
       i.first_added_at   -- the queue's order: newest first
  from owner_items i
  left join lesson_item_attrs a
         on a.owner_id = i.owner_id
        and a.norm_key = i.norm_key
 where a.level_at is null;

-- first_added_at is load-bearing: the `after()` hook levels only a bounded slice of this queue, and
-- the item the learner just added has to be in it. Ordered by norm_key, any backlog would push a
-- new word outside the window.

-- Built on owner_items rather than lesson_items, so each read computes the lessons + practice
-- aggregate and discards it. Deliberate: `kind` and `text` are non-trivial expressions (0005) and
-- duplicating them would let the job's notion of "sentence" drift from the page's. At a few hundred
-- items the waste is microseconds; past that, lift `kind` into a function and derive both views
-- from lesson_items.

-- No index: `level_at is null` over a few hundred rows is a free sequential scan, and the
-- (owner_id, norm_key) PK covers the join.

-- Widen the meaning, not the schema: 0004 called this "when the job last classified it", but the
-- job stamps it whenever it LOOKED. That's what makes "looked, no answer" terminal.
comment on column lesson_item_attrs.level_at is
  'When the level job last ATTEMPTED this item — not when it succeeded. NULL = never attempted. '
  'Set even when no level came back, so an unanswerable item is asked about once rather than on '
  'every sweep. `pnpm level:items --force` sets it back to NULL to re-level.';

-- level_source's check (… in ('job','user')) is deliberately unchanged: 'job' is the only value
-- ever written, and an item the model had no answer for keeps whatever it already had.
