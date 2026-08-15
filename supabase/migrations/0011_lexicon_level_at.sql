-- 0011_lexicon_level_at.sql — the ATTEMPTED flag for the lexicon level pass.
--
-- Phase 1 of docs/2026-08-15-word-autocomplete-suggestions.md. 0010 loaded 53,538 dictionary rows
-- of which only 8,301 carry a CEFR level, because that is all the open CEFR lists cover. The rest
-- are filled by one offline pass over the Message Batches API (`pnpm level:lexicon`).
--
-- The flag is the same one `words` has carried since 0007, and for the same reason: it records that
-- the job LOOKED, not that it succeeded. Without it a word the model declines to level — a proper
-- noun, an abbreviation, a Wiktionary artifact that survived the build filters — is re-asked on
-- every run, forever, and re-billed each time. With it, "looked, no answer" is terminal.

alter table lexicon
  -- NULL = never attempted. Stamped for every row the job saw, answered or not. Deliberately
  -- separate from `level`: a row can be attempted and still unlevelled, and that is a real state.
  add column level_at timestamptz;

comment on column lexicon.level_at is
  'When pnpm level:lexicon last ATTEMPTED this row — not when it succeeded. NULL = never attempted. '
  'Set even when the model returned nothing, so an unlevellable headword is asked about once rather '
  'than on every run. `--force` sets it back to NULL for job-levelled rows.';

-- The job's queue: rows with no level that have never been looked at. Partial and tiny relative to
-- the table (45,237 of 53,538 at load, and it only shrinks), mirroring words_owner_pending_idx.
--
-- `level is null` and `level_at is null` are BOTH required, and they are not redundant: the first
-- protects the 8,301 human-curated CEFR values from being asked about at all (the job fills gaps,
-- it does not overwrite Tono Laboratory), the second retires a row the model had no answer for.
create index lexicon_pending_level_idx
  on lexicon (zipf desc) where level is null and level_at is null;

-- zipf desc, so a --limit run levels the words a learner is most likely to type first. The whole
-- pass costs a few dollars and takes one batch, so this matters mainly for a resumed or capped run.
