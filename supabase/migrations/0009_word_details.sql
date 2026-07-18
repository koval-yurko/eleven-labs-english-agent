-- 0009_word_details.sql — the word-details enrichment job's storage + work queue.
--
-- A second background job on the level job's machinery (0006): asks the LLM for a rich per-word
-- payload — Russian translations, part of speech, the word family's other forms with their own
-- translations, and example sentences — and renders it on the word detail page.
-- See docs/2026-07-18-word-details-enrichment-job.md.
--
-- Additive: three columns on `words`, one partial index, one queue view. `owner_items` is left
-- untouched (the detail page reads `details` with its own narrow query, so the list `select *`
-- never ships this jsonb blob per row).

-- ---------------------------------------------------------------------------------------------
-- 1. The payload + its flags, folded onto `words` (mirrors level / level_at, 0007)
-- ---------------------------------------------------------------------------------------------
alter table words
  -- The WordDetails document (pos, translations_ru, forms[], examples[]). A nested doc nothing
  -- filters or joins on, 1:1 with a word — the jsonb case, same as `categories`. NULL = not
  -- enriched (either never attempted, or attempted with no usable answer — see details_at).
  add column details          jsonb,
  -- The ATTEMPTED flag, exactly like level_at: stamped when the job LOOKED, not when it succeeded.
  -- NULL = never attempted. This is what makes "looked, nothing usable came back" terminal instead
  -- of re-asked on every sweep (a non-English token, a made-up word).
  add column details_at       timestamptz,
  -- Which prompt/schema version produced `details`. Provenance, and what lets a schema change
  -- re-run ONLY the rows built by an older version (`--force --stale`) instead of re-billing the
  -- whole collection. NULL on rows that were attempted but got no payload.
  add column details_version  smallint;

comment on column words.details_at is
  'When the word-details enrichment job last ATTEMPTED this word — not when it succeeded. '
  'NULL = never attempted. Set even when no payload came back, so an un-enrichable item is asked '
  'about once rather than on every sweep. `pnpm enrich:words --force` sets it back to NULL to re-run.';

-- The job's queue: `where details_at is null`, newest first. Partial, like words_owner_pending_idx.
create index words_owner_pending_details_idx
  on words (owner_id, created_at desc) where details_at is null;

-- ---------------------------------------------------------------------------------------------
-- 2. The work queue view (mirrors owner_items_pending_level, 0007)
-- ---------------------------------------------------------------------------------------------
-- Pending == details_at is null. A straight scan of the collection (details is a property of the
-- word), so no owner_items join is needed. `kind` is a REAL branch here, not just a hint: "forms"
-- means a word family for a word, and structural/tense variants for a phrase or sentence.
create view owner_words_pending_details with (security_invoker = true) as
select w.owner_id,
       w.id as word_id,
       w.norm_key,
       w.text,                              -- the learner's most recent spelling — what's asked about
       lesson_item_kind(w.norm_key) as kind,
       w.created_at                 as first_added_at
  from words w
 where w.details_at is null;

-- first_added_at is the queue's order (newest first): the `after()` hook enriches only a bounded
-- slice, and the word the learner just added has to fall inside it.
