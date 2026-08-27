-- Unowned words: `words.owner_id` becomes nullable, and NULL means "added anonymously".
--
-- The MCP server (`/api/mcp`) authenticates a CALLER — one shared secret — not a person, so it has
-- no `sub` to stamp and is not given a configured one to guess with. Its writes leave `owner_id`
-- NULL. Every other path is unchanged: the web action and `/api/v2/*` still stamp the session's or
-- the Bearer token's sub, and `owner_id` remains the ownership gate for them.
-- See docs/2026-08-27-mcp-static-token-auth.md §2.
--
-- Three things below are NOT optional dressing — each one is a silent failure if omitted, because
-- SQL's NULL is never equal to anything, including itself:
--
--   1. `unique (owner_id, norm_key)` treats every NULL as DISTINCT, so `on conflict` in
--      `resolve_words` would never fire for an unowned row. Every anonymous add would insert a new
--      row: no "already in your collection", no popularity bump, a fresh duplicate every call.
--      `nulls not distinct` (PG 15+; this database is 17.6) is what makes one anonymous word one
--      row.
--   2. `bump_word_popularity` gates on `owner_id = p_owner_id`, which is NULL — never true — for an
--      unowned word. The counter would stop at 0 forever and the tool would report
--      `popularity: null`. `is not distinct from` is NULL-safe equality and leaves the owned case
--      byte-identical.
--   3. RLS on `words` selects `owner_id = auth.jwt() ->> 'sub'`, which excludes NULL rows. The app
--      reads through the service-role client so this is defence in depth today, but a policy that
--      hides rows the application deliberately shows is a trap for the day the token-scoped client
--      is wired up.

-- ---------------------------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------------------------
alter table words alter column owner_id drop not null;

comment on column words.owner_id is
  'The Auth0 sub of the learner who added the word, or NULL when it was added anonymously — today '
  'that means through the MCP server, which authenticates a shared secret rather than a person. '
  'NULL is a first-class value here, not a missing one: unowned words are visible to every learner '
  'and are levelled and enriched by the same background jobs. Every non-MCP write path still '
  'stamps a sub, and for those rows owner_id remains the ownership gate.';

-- ---------------------------------------------------------------------------------------------
-- 2. The natural key, made NULL-safe
-- ---------------------------------------------------------------------------------------------
-- Same columns, same purpose (one row per distinct spelling-family per owner) — the only change is
-- that all unowned rows now share one namespace instead of each being its own. `resolve_words`
-- infers its arbiter from the columns, so `on conflict (owner_id, norm_key)` picks this index up
-- with no change to the function.
--
-- ⚠️ An owned row and an unowned row with the SAME norm_key remain two different rows, by design:
-- (NULL, 'ubiquitous') and ('auth0|…', 'ubiquitous') are distinct keys. A learner who types a word
-- the MCP server already added anonymously gets their own copy, and the collection shows both.
alter table words drop constraint words_owner_id_norm_key_key;

create unique index words_owner_id_norm_key_key
  on words (owner_id, norm_key) nulls not distinct;

-- ---------------------------------------------------------------------------------------------
-- 3. The popularity bump, made NULL-safe
-- ---------------------------------------------------------------------------------------------
-- `is not distinct from` is `=` for every non-null value and true for NULL = NULL. Nothing about
-- the owned path changes; the unowned path starts working.
create or replace function bump_word_popularity(p_owner_id text, p_id uuid)
returns int
language sql
as $fn$
  update words
     set popularity = popularity + 1,
         updated_at = now()
   where owner_id is not distinct from p_owner_id
     and id = p_id
  returning popularity;
$fn$;

comment on function bump_word_popularity(text, uuid) is
  'Atomically +1 a word''s popularity, returning the new value (NULL when no row matched). '
  'Matches owner_id with IS NOT DISTINCT FROM so an unowned word (owner_id NULL, added through '
  'MCP) can be bumped by passing NULL — plain `=` is never true for NULL and would silently no-op.';

-- ---------------------------------------------------------------------------------------------
-- 4. RLS: unowned rows are readable by everyone, writable by no one
-- ---------------------------------------------------------------------------------------------
-- SELECT widens to include NULL because that is the product decision: an anonymous word belongs to
-- the collection, and a row nobody can read is a row that may as well not exist.
--
-- INSERT and UPDATE deliberately do NOT widen. Only the MCP path creates unowned rows and it goes
-- through the service-role client, which bypasses RLS entirely; a token-scoped client has no
-- business minting rows with no owner, and `with check (owner_id is null)` would let any logged-in
-- user do exactly that.
drop policy "words owner select" on words;

create policy "words owner select"
  on words for select
  using (owner_id = auth.jwt() ->> 'sub' or owner_id is null);
