# Phase 0 Research: Live-Only Lesson Experience

This is a **retirement/refactor** feature, so "research" is primarily resolving the
removal boundaries against the actual codebase and recording the few real decisions. There
were no open `NEEDS CLARIFICATION` markers in the Technical Context; the items below are the
design decisions that gate implementation.

## D1 — What "ready" means after audio is removed

- **Decision**: Keep the `ready` lesson status; redefine it as "has a valid script/plan."
  Keep the `lessons.script_iff_ready` DB constraint (`script IS NOT NULL` ⇔ `status = 'ready'`).
- **Rationale**: FR-004 explicitly states `"Ready" means "has a valid plan/script."` The
  existing constraint already couples `ready` to the presence of a script — removing the
  audio render makes it *cleaner*, not invalid, because script presence was always the other
  half of the gate. Lifecycle stays `pending → generating → ready | failed`.
- **Alternatives considered**: Removing the `ready` status entirely (suggested by a first-pass
  code scan). Rejected — it contradicts FR-004, would churn the contracts/UI/polling for no
  benefit, and `script_iff_ready` already expresses the right invariant.

## D2 — Estimated/target length is a planning input, not an audio property

- **Decision**: Retain `targetMinSeconds`/`targetMaxSeconds` (config + generation request)
  and `LessonScript.estimatedDurationSeconds`. Remove only the *rendered-audio* measurement
  `audioDurationSeconds` (the `lesson_audio.duration_seconds` value surfaced on the lesson row
  and in `LessonSummary`).
- **Rationale**: FR-003 + the spec's closing assumption keep estimated/target length as a
  narration-pacing input. These feed the script prompt's word-count target
  (`prompts/lesson-script.ts`) and `derive-plan.ts`'s narration target — both on the retained
  live-story path. `audioDurationSeconds` is the measured length of the MP3 that no longer
  exists, so it is the only "duration" that retires.
- **Alternatives considered**: Dropping all `*Seconds` config as "audio." Rejected — it would
  break the live-story plan derivation and the script prompt.

## D3 — Eval gate: remove the audio-length scorer, do not replace it

- **Decision**: Delete `scoreLength` (and `LengthWindow`, the `"length"` `ScorerKey`, and the
  `lengthWindow` plumbing through `harness.ts`/`run.ts`). The gate keeps `scoreCoverage`,
  `scoreTwoVoice`, `scoreStoryNotDefinition`. No new word-count scorer is added.
- **Rationale**: FR-010 enumerates the gate as coverage + two-persona + story-driven and
  forbids audio-render/length checks. `scoreLength` consumes `result.audio.durationSeconds`,
  which disappears with the TTS adapter. The spec does not require a textual length gate, and
  the script prompt already targets a word budget — adding a scorer would be unrequested scope.
- **Alternatives considered**: Re-point `scoreLength` at `estimatedDurationSeconds` or a word
  count. Rejected — not required by FR-010 and risks a brittle/flaky bar.

## D4 — `lib/live-tutor/token.ts` is shared; keep it in place

- **Decision**: Delete all of `lib/live-tutor/` **except** `token.ts`. Keep `token.ts` at its
  current path. Update nothing about live-story's import of it.
- **Rationale**: `lib/live-story/service.ts` and two live-story tests import
  `mintConversationToken`/`TokenFetch` from `../live-tutor/token`. CLAUDE.md records that 006
  intentionally **reuses** 005's token mint. Moving it adds churn and breaks the recorded
  lineage for no functional gain; the directory name being slightly historical is acceptable.
- **Alternatives considered**: Move to `lib/convai/token.ts`. Rejected as unnecessary risk for
  this retirement-scoped change (could be a later cleanup).

## D5 — Forward-only data removal (no migration/backfill)

- **Decision**: One new migration `0006_retire_audio_qa.sql` drops, in dependency order:
  `qa_turns`, `qa_exchanges`, the `qa_turn_role` enum, the `lesson_audio` table, the
  `lesson-audio` Storage bucket (+ its objects + RLS policies), and the
  `lessons.audio_duration_seconds` column. `live_sessions`/`session_turns` are left untouched.
- **Rationale**: FR-007 accepts discarding previously rendered audio and old Q&A transcripts;
  FR-008 retains the live-session transcript. A single forward migration realizes SC-004/SC-005
  with no backfill. RLS model is otherwise unchanged (FR-015).
- **Alternatives considered**: Soft-deprecation (leave tables, stop writing). Rejected — FR-007
  requires the records/storage to no longer exist, and FR-013 forbids a compatibility shim.

## D6 — Audio + 005 Q&A entry points must return not-found, not stale data

- **Decision**: Delete the audio-serving path (signed-URL / `getAudioUrl` service surface) and
  the 005 routes (`/api/lessons/[id]/live-session`, `/api/lessons/[id]/exchanges`). Removing the
  Next.js route files makes those paths 404 by default.
- **Rationale**: FR-009 requires former audio / playback-Q&A access to return a clear
  not-found/removed response rather than serving stale data. Next.js App Router returns 404 for
  absent route segments, which satisfies this without custom handlers.
- **Alternatives considered**: 410 Gone handlers. Acceptable but unrequested; 404 via deletion
  is the minimal, clean removal.

## D7 — Constitution amendment (Principle I + decided stack) is part of this feature

- **Decision**: Amend `.specify/memory/constitution.md` via the `/speckit.constitution` flow as
  a deliverable of this feature. **Version bump: 1.0.0 → 2.0.0 (MAJOR)** because a decided stack
  component ("Scripted audio: ElevenLabs Text to Dialogue") is dropped (Governance versioning
  rule). Reframe Principle I's voice-consistency clause from "the teacher voice in the scripted
  podcast and the live tutor" to "the pinned teacher voice across the live-narrated story," and
  its expressiveness clause from "generated audio" (rendered file) to the live narration. Update
  the Technology & Architecture Constraints "Scripted audio" line and the two-subsystem framing
  (the boundary artifact is still the structured script).
- **Rationale**: FR-012 requires this as an explicit, recorded decision rather than an implicit
  code change. The constitution's own Governance section classifies dropping a decided stack
  component as MAJOR.
- **Alternatives considered**: Leaving the constitution stale. Rejected — FR-012 and the
  Governance "must stay consistent" rule forbid it.

## Non-goals reaffirmed (from spec OUT OF SCOPE)

- No change to live-story behavior (FR-006). The 006 subsystem files are KEEP-only.
- No removal of script/coverage generation — the planner still needs them (FR-001/002/003).
- No preservation/migration of previously rendered audio (FR-007).
- No flag/toggle to keep the old modes (FR-013).
- No auth/persistence/RLS redesign (FR-015).
