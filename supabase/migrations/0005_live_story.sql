-- 0005_live_story.sql — adaptive live-story durable transcript (006-adaptive-live-story,
-- data-model.md §Migration). Two owner-scoped tables: a live narration-plus-interaction
-- session and its ordered turns (corrected text). No audio column anywhere — realtime
-- audio is NEVER persisted (FR-025); the text transcript is the only durable record.
-- RLS keys on the Auth0 subject (`auth.jwt() ->> 'sub'`), mirroring 0003_rls.sql / 0004_qa.sql.

create type live_session_status as enum ('active', 'ended');
create type session_turn_role   as enum ('teacher', 'learner');
create type session_turn_kind   as enum ('narration', 'answer', 'question', 'scenario_change');

-- live_sessions --------------------------------------------------------------
create table live_sessions (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references lessons (id) on delete cascade,
  owner_id text not null,
  status live_session_status not null default 'active',
  -- The scenario currently in effect; null = the plan's original setting (FR-008/FR-009).
  scenario text,
  -- Realtime conversation id, for reproducibility/debug (Constitution III, R6).
  elevenlabs_conversation_id text,
  created_at timestamptz not null default now(),
  ended_at timestamptz
);
create index live_sessions_lesson_idx on live_sessions (lesson_id, created_at desc);

-- session_turns --------------------------------------------------------------
create table session_turns (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references live_sessions (id) on delete cascade,
  owner_id text not null,
  role session_turn_role not null,
  kind session_turn_kind not null,
  -- Corrected transcript of the utterance (R5). Empty/unintelligible input never becomes
  -- a stored turn; it triggers clarification (FR-016, R9).
  text text not null check (length(btrim(text)) > 0),
  turn_index int not null,
  -- Optional stable ref to the SDK turn, used to upsert a barge-in correction in place (R5/R6).
  eleven_turn_ref text,
  created_at timestamptz not null default now(),
  unique (session_id, turn_index)
);
create index session_turns_session_idx on session_turns (session_id, turn_index);

-- RLS: owner-only, keyed on the Auth0 sub. `owner_id` is denormalized onto both tables so
-- RLS never needs a join (matches source_items / qa_*).
alter table live_sessions enable row level security;
alter table session_turns enable row level security;

-- live_sessions: status/scenario/ended_at are mutated by the owner during the session.
create policy "live_sessions owner select"
  on live_sessions for select
  using (owner_id = auth.jwt() ->> 'sub');

create policy "live_sessions owner insert"
  on live_sessions for insert
  with check (owner_id = auth.jwt() ->> 'sub');

create policy "live_sessions owner update"
  on live_sessions for update
  using (owner_id = auth.jwt() ->> 'sub')
  with check (owner_id = auth.jwt() ->> 'sub');

-- session_turns: insert-append + the single permitted mutation — a barge-in correction
-- overwrites a teacher turn's text in place (R5/R6). No DELETE policy (turns are otherwise
-- append-only; cascade-delete with the lesson is the only removal path).
create policy "session_turns owner select"
  on session_turns for select
  using (owner_id = auth.jwt() ->> 'sub');

create policy "session_turns owner insert"
  on session_turns for insert
  with check (owner_id = auth.jwt() ->> 'sub');

create policy "session_turns owner update"
  on session_turns for update
  using (owner_id = auth.jwt() ->> 'sub')
  with check (owner_id = auth.jwt() ->> 'sub');
