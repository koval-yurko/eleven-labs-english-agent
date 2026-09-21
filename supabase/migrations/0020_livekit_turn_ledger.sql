-- 0020_livekit_turn_ledger.sql — the LiveKit worker's per-turn ledger.
--
-- One row per TURN, not one row per lesson. Written only by POST /api/v2/livekit/session-end,
-- authenticated by the per-lesson grant (docs/2026-09-25-lesson-grant-tool-authorization.md); read
-- by Phase 4's cost and latency measurements. Never written by a job, never by a webhook, never by
-- the phone. See docs/2026-09-11-livekit-claude-diy-provider.md §5.2.
--
-- ## Why a row per turn, when §5.2 said "a jsonb row keyed by conversation_id"
--
-- Because the worker posts DURING the lesson, in batches, so that a crash loses only the last batch
-- rather than the whole session. A single jsonb document would force every batch through
-- read-modify-write: two in-flight batches would interleave and the second would silently erase the
-- first's turns. A row per turn makes the write an ordinary idempotent upsert on
-- (conversation_id, seq) — a replayed batch overwrites itself, an out-of-order batch lands where it
-- belongs, and nothing is lost to a lost update. The record itself stays jsonb, so the `TurnRecord`
-- shape can gain fields without a migration.
--
-- ## conversation_id is TEXT and NOT a foreign key
--
-- The same reasoning as `debug_reports` (0019), and it matters more here: partial batches arrive
-- WHILE the lesson is running, and the `lesson_sessions` row is not written until it ends. A
-- foreign key would reject every batch except the last — exactly inverting the crash-safety this
-- table exists for. `owner_id` is stamped from the grant, so the rows are owner-scoped regardless.
--
-- ## seq comes from the worker
--
-- It is the ledger's own turn counter, contiguous from 0 within one conversation. It is the sort
-- key, the conflict target, and the thing that makes a replay idempotent — so it is stored as its
-- own column rather than being read out of the jsonb on every query.

create table livekit_turn_ledger (
  conversation_id text not null,
  seq integer not null,
  owner_id text not null,                          -- Auth0 sub, from the verified grant
  record jsonb not null,                           -- one TurnRecord (packages/shared/.../livekit-wire.ts)
  created_at timestamptz not null default now(),
  primary key (conversation_id, seq)
);

-- The read Phase 4 actually makes: one lesson's turns, in order. The primary key already serves it,
-- so the only extra index is the owner scan an operator page would want.
create index livekit_turn_ledger_owner_created_idx
  on livekit_turn_ledger (owner_id, created_at desc);

alter table livekit_turn_ledger enable row level security;

-- Defense in depth, exactly as elsewhere: the route writes with the service client and stamps
-- owner_id in code (CLAUDE.md). A learner may read their own turns; nobody may write through RLS,
-- because the only legitimate writer holds a grant rather than an Auth0 session.
create policy livekit_turn_ledger_select_own on livekit_turn_ledger
  for select using (owner_id = auth.jwt() ->> 'sub');
