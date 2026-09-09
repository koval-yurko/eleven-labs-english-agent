-- 0019_debug_reports.sql — diagnostic reports filed from the phone.
--
-- One row per report. Written only by POST /api/v2/debug-reports (Bearer, owner-scoped); read by
-- the operator page and by scripts/report.ts. Never written by a job, never by the webhooks.
-- See docs/2026-09-09-mobile-debug-reports-and-feedback.md §9.
--
-- ## The join keys are TEXT AND NOT FOREIGN KEYS on purpose, except lesson_id
--
--   * `conversation_id` may name a conversation that has no `lesson_sessions` row. A session that
--     failed to CONNECT is exactly the case this table exists for — there is no transcript, so
--     there is no row — and a foreign key would reject precisely the reports worth having.
--   * `lesson_id` IS a foreign key, but `on delete set null`. Lessons are soft-deleted (0008), so a
--     hard delete is already exceptional; when one happens it must not take the evidence with it.
--   * `provider` is unconstrained text rather than a check constraint. A fourth provider must not
--     need a migration before its first failure can be reported. Same reasoning as `status`.
--
-- ## captured_at is separate from created_at, and that is the whole point of the spool
--
-- A report is generated at the exact moment things are broken, and "broken" is frequently "the
-- request that would file this report will also fail". So it queues on the device and retries on
-- foreground — which means it can arrive hours after the failure. Collapsing the two columns would
-- make every offline report lie about when the bug happened, and offline reports are
-- disproportionately the interesting ones.
--
-- ## error_code is denormalized out of `events`
--
-- It is inside the jsonb too. It is lifted here because the first question the operator page asks
-- is "group by error", and a jsonb scan per row for a list view is a page that gets slow at exactly
-- the moment it starts being useful.

create table debug_reports (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null,                        -- Auth0 sub, from the verified Bearer token
  created_at timestamptz not null default now(), -- when the SERVER received it
  captured_at timestamptz not null,              -- when the PHONE built it (differs when spooled)

  kind text not null check (kind in ('error','feedback','manual')),
  note text not null default '',

  lesson_id uuid references lessons(id) on delete set null,
  conversation_id text,                          -- joins lesson_sessions.conversation_id, no FK
  provider text,                                 -- 'elevenlabs' | 'openai' | 'vapi', unconstrained
  agent_version text,

  error_code text,                               -- denormalized from events, for grouping
  error_message text,

  client jsonb not null default '{}'::jsonb,     -- build identity
  state jsonb not null default '{}'::jsonb,      -- { live, atError }
  events jsonb not null default '[]'::jsonb,     -- the ring
  transcript_tail jsonb not null default '[]'::jsonb,

  -- Triage, owned by the operator page. NOT an enum and not a check: adding a state must not need
  -- a migration, and the set of useful states is not knowable before the page has been used.
  status text not null default 'new',
  resolution text
);

comment on table debug_reports is
  'Diagnostic reports filed from the phone: the session state machine (including the refs no '
  'render can see), a bounded ring of structured events, and what the learner typed. Written only '
  'by POST /api/v2/debug-reports. captured_at is when the phone built it; created_at is when it '
  'arrived, and they differ for a report that spooled offline.';

create index debug_reports_owner_created_idx on debug_reports (owner_id, created_at desc);
create index debug_reports_created_idx       on debug_reports (created_at desc);
create index debug_reports_error_code_idx    on debug_reports (error_code, created_at desc)
  where error_code is not null;
create index debug_reports_conversation_idx  on debug_reports (conversation_id)
  where conversation_id is not null;

-- No `updated_at` and no trigger. A report is an OBSERVATION; the only mutable fields are the
-- triage pair, and their history is not interesting enough to pay for one.

alter table debug_reports enable row level security;

-- Included for symmetry with lessons/lesson_sessions. As everywhere else in this repo the write
-- goes through the service-role client and ownership is enforced in code (CLAUDE.md: "Ownership is
-- enforced in code […] RLS is defense-in-depth").
create policy "debug_reports owner select"
  on debug_reports for select
  using (owner_id = auth.jwt() ->> 'sub');

create policy "debug_reports owner insert"
  on debug_reports for insert
  with check (owner_id = auth.jwt() ->> 'sub');
