-- 0006_retire_audio_qa.sql — Live-Only Lesson Experience (007-live-only)
--
-- Forward-only retirement of the pre-rendered audio subsystem and the 005 playback-position
-- Q&A subsystem. After this migration the live-narrated session (live_sessions/session_turns)
-- is the single durable record of a lesson session (FR-008). Previously rendered audio and
-- 005 Q&A transcripts are discarded; that loss is accepted (FR-007). No auth/RLS redesign
-- (FR-015). live_sessions, session_turns, lessons (minus the dropped column), and source_items
-- are intentionally left in place.

-- 005 playback-position Q&A (drop children before parents; RLS policies drop with the tables).
drop table if exists qa_turns;
drop table if exists qa_exchanges;
drop type if exists qa_turn_role;

-- Pre-rendered audio storage. The two owner RLS policies live on storage.objects (which
-- persists), so drop them explicitly here (DDL is permitted). The bucket itself and its
-- objects CANNOT be removed via SQL — Supabase blocks direct DML on storage.objects/buckets
-- ("Use the Storage API instead"); the `lesson-audio` bucket was removed out-of-band via the
-- Storage API.
drop policy if exists "lesson audio owner read" on storage.objects;
drop policy if exists "lesson audio owner write" on storage.objects;

-- Pre-rendered audio table.
drop table if exists lesson_audio;

-- Audio-duration column on lessons. The script_iff_ready / error_iff_failed constraints stay:
-- `ready` now means "has a valid script" (FR-004).
alter table lessons drop column if exists audio_duration_seconds;
