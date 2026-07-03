-- 0002_lessons.sql — lessons (named word sets) + their tutor conversation history.
--
-- A lesson is a set of words/phrases the learner keeps coming back to; each voice
-- conversation held over a lesson is recorded as a lesson_session. Ownership is the
-- Auth0 subject, same pattern as health_pings: the server filters/stamps owner_id in
-- code, RLS is defense-in-depth.

-- lessons — a named set of words / phrases / sentences to learn.
create table lessons (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null,                       -- Auth0 sub
  title text not null,
  items text[] not null,                        -- one word/phrase/sentence per element
  created_at timestamptz not null default now()
);

create index lessons_owner_created_idx on lessons (owner_id, created_at desc);

alter table lessons enable row level security;

create policy "lessons owner select"
  on lessons for select
  using (owner_id = auth.jwt() ->> 'sub');

create policy "lessons owner insert"
  on lessons for insert
  with check (owner_id = auth.jwt() ->> 'sub');

-- lesson_sessions — one row per tutor conversation over a lesson. Written from two
-- sides, keyed on conversation_id: the browser saves the transcript the moment the
-- session ends, and the ElevenLabs post-call webhook later upserts the richer copy
-- (full transcript + summary + duration).
create table lesson_sessions (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references lessons(id) on delete cascade,
  owner_id text not null,                       -- Auth0 sub (copied from the lesson)
  conversation_id text not null unique,         -- ElevenLabs conversation id
  agent_version text,                           -- tutor prompt version (e.g. words-1.1)
  transcript jsonb not null default '[]'::jsonb, -- [{role, text, timeInCallSecs?}]
  summary text,                                 -- ElevenLabs transcript_summary
  duration_secs integer,
  created_at timestamptz not null default now()
);

create index lesson_sessions_lesson_created_idx on lesson_sessions (lesson_id, created_at desc);

alter table lesson_sessions enable row level security;

create policy "lesson_sessions owner select"
  on lesson_sessions for select
  using (owner_id = auth.jwt() ->> 'sub');

create policy "lesson_sessions owner insert"
  on lesson_sessions for insert
  with check (owner_id = auth.jwt() ->> 'sub');
