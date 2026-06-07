# Phase 1 Data Model: Live-Only Lesson Experience

This feature **subtracts** data surface. Below: retired entities (removed by migration
`0006_retire_audio_qa.sql`), retained entities (unchanged), and the one modified entity
(`lessons`, losing its audio-duration column). RLS model is otherwise unchanged (FR-015).

## Retired entities (REMOVED)

### Pre-rendered audio — `lesson_audio` table + `lesson-audio` Storage bucket
- **Table** `lesson_audio` (`0001_init.sql`): columns `id`, `lesson_id`, `owner_id`,
  `storage_path`, `mime_type`, `duration_seconds`, `created_at`; index `lesson_audio_lesson_idx`.
- **Storage** `lesson-audio` private bucket (`0002_storage.sql`) + its two owner RLS policies;
  object key pattern `${sanitizedOwnerId}/${lessonId}/lesson.mp3`.
- **Reason**: FR-001/FR-007 — no audio is synthesized or stored; existing audio discarded.

### Playback-position Q&A — `qa_exchanges` + `qa_turns` (+ `qa_turn_role` enum)
- **`qa_exchanges`** (`0004_qa.sql`): `id`, `lesson_id`, `owner_id`, `source_item_id`,
  `interruption_position_seconds`, `exchange_index`, `elevenlabs_conversation_id`, `created_at`.
- **`qa_turns`**: `id`, `exchange_id`, `owner_id`, `role` (enum `qa_turn_role`), `text`,
  `turn_index`, `created_at`.
- **Enum** `qa_turn_role`.
- **All four RLS policies** on these tables.
- **Reason**: FR-007 — the 005 playback-anchored Q&A mode and its transcript records are retired.

## Modified entity

### `lessons` (table + `LessonSummary` contract)
- **Drop column** `lessons.audio_duration_seconds` (`0001_init.sql:19`).
- **Drop contract field** `LessonSummary.audioDurationSeconds` (`packages/contracts/src/lesson.ts:60`)
  and the mirrored `audioDurationSeconds` on `apps/web/lib/lessons/types.ts` + repository types.
- **KEEP** `status` enum `('pending','generating','ready','failed')` and the
  `script_iff_ready` / `error_iff_failed` constraints — `ready` now means "has a valid script"
  (D1). **KEEP** `target_duration_seconds` (planning input, D2) and `script` (jsonb).
- **Reason**: FR-004 (ready = valid plan), FR-001 (no rendered audio ⇒ no measured duration).

## Retained entities (UNCHANGED)

### `LessonScript` (contract `lesson-script.ts`) — now the *only* generation output
- Fields unchanged: `segments[]` (with `audioTags` expressiveness cues — kept; they are
  prompt hints, not audio-file references), `speakers` (two distinct personas), `coverage[]`,
  `estimatedDurationSeconds` (planning input retained, D2).
- **Reason**: FR-001/002/003 — the script with coverage + two personas + estimated length is
  retained; only the audio render tail downstream of it is removed.

### `source_items` table — UNCHANGED
- Used by `derive-plan.ts` to map coverage entries to item ids by `normalizedText`.

### `live_sessions` + `session_turns` (`0005_live_story.sql`) — UNCHANGED, now the SOLE durable record
- The continuous live-narrated session transcript; owner-scoped RLS retained.
- **No audio column anywhere** (already true in 006). FR-008 confirms these are the single
  durable record of a lesson session.

### `LessonPlan`, `LiveSession`, `SessionTurn`, `StartStoryToken` (contract `live-story.ts`) — UNCHANGED
- Derived from the script; carry no audio persistence. KEEP entirely (FR-006).

## Migration shape — `0006_retire_audio_qa.sql` (forward-only)

Drop order respects FK dependencies; bucket objects cleared before/with the bucket.

```sql
-- 005 playback-position Q&A
drop table if exists qa_turns;
drop table if exists qa_exchanges;
drop type if exists qa_turn_role;

-- pre-rendered audio storage
delete from storage.objects where bucket_id = 'lesson-audio';
delete from storage.buckets where id = 'lesson-audio';
-- (the two lesson-audio Storage RLS policies are dropped with/after the bucket)

-- pre-rendered audio table
drop table if exists lesson_audio;

-- audio-duration column on lessons (script_iff_ready / error_iff_failed constraints stay)
alter table lessons drop column if exists audio_duration_seconds;
```

`live_sessions`, `session_turns`, `lessons` (minus the dropped column), and `source_items`
are intentionally left in place.

## State transitions (lesson lifecycle) — after change

```
pending ──generate──▶ generating ──valid script──▶ ready        (script present; NO audio step)
                              └─ coverage/persona fail ─▶ failed  (error_reason set; no audio copy)
```

`ready` is reached on a valid script alone (FR-004). No `rendering`/audio-upload state exists.
