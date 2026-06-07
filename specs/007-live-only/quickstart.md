# Quickstart: Verifying the Live-Only Lesson Experience

How to confirm the product is live-only after this change. Maps each check to a Success
Criterion / User Story.

## Prerequisites

```bash
pnpm install
pnpm typecheck && pnpm lint        # strict TS, ESLint flat config
```

Apply the new migration to a local/dev Supabase:

```bash
# 0006_retire_audio_qa.sql drops lesson_audio, the lesson-audio bucket, qa_*, and the
# lessons.audio_duration_seconds column. Forward-only; previously stored audio + 005 Q&A
# transcripts are discarded (accepted, FR-007).
supabase db push   # or your project's migration runner
```

## 1. A lesson is ready without any audio render (US1 / SC-001, SC-005, SC-006)

```bash
pnpm test            # generation + bridge unit/integration, providers mocked
```

Expect:
- `generateLesson(...)` returns `{ script, metadata }` with full coverage + two distinct
  personas + a bounded target length, and **no** `audio` field.
- The web generation bridge marks the lesson `ready` **without** calling any storage upload.
- No row is written to `lesson_audio` (table no longer exists); no object in a `lesson-audio`
  bucket (bucket no longer exists).
- A coverage/persona failure ⇒ lesson stays non-ready with a status message that **does not**
  mention audio rendering or length (FR-014).

Optional real-provider smoke (script path only — produces **no** `.mp3`, FR-011):

```bash
pnpm smoke:generate  # exercises Claude script generation; asserts a valid script, writes no audio
```

## 2. The lesson opens directly into the live story (US2 / SC-002)

```bash
pnpm dev             # then open a ready lesson at /lessons/[id]
pnpm test:e2e        # Playwright: live-story flow only
```

Expect on the lesson page:
- Exactly one experience: the live-narrated story panel (`LiveStoryProvider`) +
  `TranscriptReview`.
- **No** `<audio>` player element and **no** separate playback-position Q&A panel
  (`LiveTutorProvider` is gone).
- Starting the story narrates every item live in the pinned teacher voice; turns persist to
  `live_sessions`/`session_turns`. Reopening shows the durable transcript (US2 #3, FR-008).
- A former audio URL or a `/live-session` / `/exchanges` link returns **404** (FR-009), not
  stale audio.

## 3. Generation quality gate is script-only (US3 / SC-003, SC-007)

```bash
pnpm eval:generation   # live with keys, else mocks
```

Expect the gate to score **only**: coverage of every teachable item, two distinct personas,
story-driven (not dictionary) structure. **No** audio-render or audio-length (`scoreLength`)
criterion remains. A script that omits an item or collapses the two personas fails on that
script-level criterion. Full suite green (SC-007).

## 4. Retired data + surfaces are gone (US4 / SC-004)

```sql
-- against the migrated DB
select to_regclass('public.lesson_audio');   -- NULL
select to_regclass('public.qa_exchanges');   -- NULL
select to_regclass('public.qa_turns');       -- NULL
select column_name from information_schema.columns
  where table_name='lessons' and column_name='audio_duration_seconds';  -- 0 rows
select to_regclass('public.live_sessions');  -- present (retained)
select to_regclass('public.session_turns');  -- present (retained)
select id from storage.buckets where id='lesson-audio';  -- 0 rows
```

A live session still round-trips: start → narrate → turns persist → transcript readable.

## 5. Constitution amendment recorded (FR-012)

`.specify/memory/constitution.md` shows **v2.0.0** (MAJOR — a decided stack component
dropped), with Principle I voice-consistency / expressiveness wording reframed onto the
pinned teacher voice + live narration (no "scripted podcast"), and the Technology &
Architecture "Scripted audio: ElevenLabs Text to Dialogue" line removed/reframed.

## Final gate

```bash
pnpm test && pnpm typecheck && pnpm lint
```

All green with the audio + 005 Q&A coverage removed and the quality-gate coverage updated
(SC-007).
