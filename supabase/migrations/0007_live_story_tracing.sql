-- 0007_live_story_tracing.sql — observability support for live-story session tracing
-- (008-langsmith-tracing, data-model.md). Forward-only. Two additions to live_sessions:
--   1. a last-activity signal so the abandonment sweep can force-close sessions that
--      disconnect without a clean `ended` append (FR-003, SC-002), and
--   2. an index on the realtime conversation id so the post-call webhook can correlate
--      conversation_id -> session/lesson/owner (FR-005, R3).
-- No new table, no new bucket; session_turns is untouched; realtime audio is still NEVER
-- persisted (FR-011/025). RLS is unchanged — the correlation lookup and the sweep run with
-- the service-role client (they legitimately operate across owners).

alter table live_sessions
  add column last_activity_at timestamptz not null default now();

-- Sweep query: active sessions idle past the threshold. Leading `status` lets the planner
-- scan only `active` rows, then range-filter on last_activity_at.
create index live_sessions_stale_idx on live_sessions (status, last_activity_at);

-- Webhook correlation: conversation_id -> session/lesson/owner (R3). Nullable column; the
-- index simply makes the equality lookup cheap once an id has been persisted.
create index live_sessions_conversation_idx on live_sessions (elevenlabs_conversation_id);
