-- 0010_lexicon.sql — the suggestion corpus behind the add-word autocomplete.
--
-- Phase 0 of docs/2026-08-15-word-autocomplete-suggestions.md. A prefix-searchable English
-- dictionary with Russian glosses and CEFR levels, built offline from three open datasets
-- (apps/web/scripts/lexicon/) and loaded with `pnpm lexicon:load`.
--
-- Why it cannot be a query against `words`: the dropdown has to suggest words the learner has
-- NEVER added, and therefore words with no row in `words` at all. And it cannot be the CEFR-J list
-- either — `ubiquitous`, the placeholder in the app's own add-word field, is in no open CEFR word
-- list, because a CEFR profile is a syllabus and a learner types precisely the tail a syllabus
-- excludes. Hence a corpus of its own, with the level as an ANNOTATION on it. See the doc's §2.
--
-- Additive and self-contained: one table, one trigger, two indexes. Nothing existing is touched.

-- ---------------------------------------------------------------------------------------------
-- The table — the first NON-owner-scoped table in this schema
-- ---------------------------------------------------------------------------------------------
-- Every other table here carries owner_id and an owner-only policy. This one is shared reference
-- data: the same 53k rows for every learner, written only by the loader script (service role) and
-- read by everyone. That exception is deliberate and is recorded in supabase/README.md rather than
-- left to be inferred from the absence of a column. Decision D3 in the doc.
create table lexicon (
  -- The search key, and the join key. lesson_item_norm_key(text) by trigger — the SAME function
  -- words.norm_key uses (0004), which is the whole point: `owned` on a suggestion row is a left
  -- join against words.norm_key, and it is exact only if both sides normalize identically. The
  -- build script's Python fold is an approximation used for deduping the artifact; this is the
  -- authority.
  key          text primary key,
  -- The dictionary headword as Wiktionary spells it — what goes into the input on select, so
  -- `English` and `I'd` keep their capitals and apostrophes.
  text         text not null,
  -- NULL forever is a real state, exactly as on words.level. At load time only ~15% of rows carry
  -- a level (that is all the open CEFR lists cover); `pnpm level:lexicon` (phase 1) fills the rest.
  level        cefr_level,
  -- Provenance, and what protects the human-curated values from the job: the level pass fills gaps
  -- and must not overwrite Tono Laboratory. 'job' is written by phase 1.
  level_source text check (level_source in ('cefrj', 'octanove', 'job')),
  -- Zipf frequency (wordfreq): the ranking signal, and the inclusion filter at build time. NOT a
  -- level estimator — a threshold classifier fitted on it scored 39% exact / 83% within one level,
  -- which is good enough to sort by and not good enough to print (doc §4.2).
  zipf         real not null,
  -- Up to three Russian glosses, best first, stress marks kept (гла́сный is more use to a learner
  -- than гласный). Display only — nothing searches this side.
  ru           text[] not null default '{}'
);

create or replace function lexicon_set_key() returns trigger
language plpgsql as $$
begin
  new.key := lesson_item_norm_key(new.text);
  return new;
end $$;

-- BEFORE INSERT, so the key exists by the time ON CONFLICT (key) is evaluated — same reason as
-- words_norm_key. A headword that normalizes to NULL (punctuation only) violates the PK and is
-- rejected rather than stored as a phantom; the loader filters those out first.
create trigger lexicon_key
  before insert or update of text on lexicon
  for each row execute function lexicon_set_key();

-- ---------------------------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------------------------
-- Left-anchored `key like 'abc%'` wants a B-tree with text_pattern_ops, NOT pg_trgm + GIN — the
-- trigram index exists for the un-anchored '%abc%' case and is strictly more expensive here. It
-- becomes the right tool only if typo tolerance is added later (doc §9), and that is deferred.
-- The PK's own index is not usable for LIKE unless the database is in the C collation, which is
-- exactly what text_pattern_ops works around.
create index lexicon_prefix_idx on lexicon (key text_pattern_ops);

-- The ORDER BY inside each prefix's candidate set.
create index lexicon_zipf_idx on lexicon (zipf desc);

-- ---------------------------------------------------------------------------------------------
-- RLS — read-only to everyone, instead of the owner-id policy every other table has
-- ---------------------------------------------------------------------------------------------
-- Defense-in-depth beneath the service-role client, same as everywhere else. The difference is
-- that there is nothing to scope: a dictionary entry belongs to no one. No insert/update/delete
-- policy exists, so a user token can read and cannot write; the loader runs as service_role, which
-- bypasses RLS.
alter table lexicon enable row level security;

create policy "lexicon read-only to all"
  on lexicon for select
  using (true);

comment on table lexicon is
  'Shared reference data — NOT owner-scoped, the only such table in this schema. Written only by '
  'apps/web/scripts/lexicon/load-lexicon.ts (pnpm lexicon:load); read by the add-word suggestion '
  'route. Derived from Wiktionary/DBnary (CC BY-SA), CEFR-J 1.5, Octanove C1/C2 (CC BY-SA 4.0) and '
  'wordfreq — see apps/web/scripts/lexicon/data/ATTRIBUTION.md.';
