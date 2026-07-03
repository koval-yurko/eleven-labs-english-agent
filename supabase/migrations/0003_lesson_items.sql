-- 0003_lesson_items.sql — one row per word/phrase/sentence, editable with history.
--
-- Replaces lessons.items (text[]) with a lesson_items table: one row per item, owner-scoped
-- like everything else. Removal is a SOFT-DELETE (set removed_at) rather than a DELETE, so:
--   * the add/remove history of a lesson is derivable from the rows alone (created_at = added,
--     removed_at = removed) — no separate audit log to keep in sync;
--   * every word ever studied stays available for cross-lesson analysis;
--   * re-adding a removed word inserts a NEW row (the old one remains as history).
-- A generated normalized_text (lower/trimmed) makes future "all words I've learned" / dedupe
-- queries trivial without committing to a full vocabulary table yet.

create table lesson_items (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references lessons(id) on delete cascade,
  owner_id text not null,                        -- Auth0 sub (copied from the lesson)
  text text not null,
  -- lower/trimmed form for cross-lesson analysis ("all words I've learned", dedupe).
  normalized_text text generated always as (lower(btrim(text))) stored,
  position integer not null,                     -- display order among ACTIVE items
  created_at timestamptz not null default now(), -- = "added at"
  removed_at timestamptz                         -- null = active
);

-- Hot path: active items of a lesson in display order.
create index lesson_items_lesson_idx on lesson_items (lesson_id, position)
  where removed_at is null;
-- Cross-lesson vocabulary analysis.
create index lesson_items_owner_norm_idx on lesson_items (owner_id, normalized_text);

alter table lesson_items enable row level security;

create policy "lesson_items owner select"
  on lesson_items for select
  using (owner_id = auth.jwt() ->> 'sub');

create policy "lesson_items owner insert"
  on lesson_items for insert
  with check (owner_id = auth.jwt() ->> 'sub');

-- Soft-delete is an UPDATE (removed_at), not a DELETE, so an update policy is what edits need.
create policy "lesson_items owner update"
  on lesson_items for update
  using (owner_id = auth.jwt() ->> 'sub');

-- Backfill from the array column, preserving order; stamp the lesson's own created_at so the
-- history doesn't claim every word was "added" at migration time.
insert into lesson_items (lesson_id, owner_id, text, position, created_at)
select l.id, l.owner_id, t.item, t.ord::int - 1, l.created_at
from lessons l, unnest(l.items) with ordinality as t(item, ord);

-- Single-user app: code and schema deploy together, so drop the old column immediately.
alter table lessons drop column items;

-- Surface recently-edited lessons; every item mutation bumps this.
alter table lessons add column updated_at timestamptz not null default now();
