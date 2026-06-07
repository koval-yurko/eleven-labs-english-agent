-- 0004_qa.sql — live-tutor Q&A transcript capture (005-live-tutor-qa, data-model.md).
-- Two owner-scoped, append-only tables: a Q&A exchange (one interruption-to-resume
-- episode) and its ordered turns. Anchored to a lesson + the relevant source item.
-- RLS keys on the Auth0 subject (`auth.jwt() ->> 'sub'`), same pattern as 0003_rls.sql.

create type qa_turn_role as enum ('learner', 'tutor');

-- qa_exchanges ---------------------------------------------------------------
create table qa_exchanges (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references lessons (id) on delete cascade,
  owner_id text not null,
  -- Relevant item active at interruption (R3). SET NULL keeps the exchange if the
  -- item is later removed; null is also valid when no item was resolvable.
  source_item_id uuid references source_items (id) on delete set null,
  interruption_position_seconds numeric(8, 3) not null check (interruption_position_seconds >= 0),
  exchange_index int not null,
  elevenlabs_conversation_id text,
  created_at timestamptz not null default now(),
  unique (lesson_id, exchange_index)
);
create index qa_exchanges_lesson_idx on qa_exchanges (lesson_id, exchange_index);

-- qa_turns -------------------------------------------------------------------
create table qa_turns (
  id uuid primary key default gen_random_uuid(),
  exchange_id uuid not null references qa_exchanges (id) on delete cascade,
  owner_id text not null,
  role qa_turn_role not null,
  text text not null check (length(btrim(text)) > 0),
  turn_index int not null,
  created_at timestamptz not null default now(),
  unique (exchange_id, turn_index)
);
create index qa_turns_exchange_idx on qa_turns (exchange_id, turn_index);

-- RLS: owner-only, append-only (no update/delete policies; cascade-delete with the
-- lesson is the only removal path). `owner_id` is denormalized so RLS needs no join.
alter table qa_exchanges enable row level security;
alter table qa_turns enable row level security;

create policy "qa_exchanges owner select"
  on qa_exchanges for select
  using (owner_id = auth.jwt() ->> 'sub');

create policy "qa_exchanges owner insert"
  on qa_exchanges for insert
  with check (owner_id = auth.jwt() ->> 'sub');

create policy "qa_turns owner select"
  on qa_turns for select
  using (owner_id = auth.jwt() ->> 'sub');

create policy "qa_turns owner insert"
  on qa_turns for insert
  with check (owner_id = auth.jwt() ->> 'sub');
