# Implementation Plan: Live-Only Lesson Experience

**Branch**: `007-live-only` | **Date**: 2026-06-07 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/007-live-only/spec.md`

## Summary

Retire the pre-rendered audio "scripted podcast" and the older playback-position live
Q&A (feature 005), making the product **live-only** on the adaptive live-narrated story
(feature 006, unchanged). Generation keeps producing the text `LessonScript` (ordered
items, story beats, two personas, coverage guarantee, estimated target length) but stops
synthesizing, stitching, and storing any audio file — a lesson is **ready** once it has a
valid script. The lesson page presents exactly one experience (the live story). The audio
storage bucket + `lesson_audio` table, the `qa_exchanges`/`qa_turns` tables, the audio
player UI, the 005 Q&A surface, and the audio-duration eval scorer are removed via a
forward-only change; `live_sessions`/`session_turns` remain the single durable record.
The constitution's voice-consistency / reproducibility wording is amended away from the
"scripted podcast" (recorded decision, FR-012).

**Technical approach**: a deletion-and-reduction refactor across four seams — (1) the
generator orchestrator drops its TTS stage and `RenderedAudio` return; (2) the web
generation bridge stops uploading audio and marks ready on script alone; (3) the lesson
page and DI container drop the audio player + 005 Q&A wiring; (4) a new migration drops the
retired tables/bucket/column and the eval gate drops `scoreLength`. No new runtime
dependency; no auth/RLS/persistence-model redesign (FR-015).

## Technical Context

**Language/Version**: TypeScript (strict) on Node 20 LTS — single language end-to-end (Constitution II)
**Primary Dependencies**: Next.js (App Router) · `@idiomatic/contracts` (Zod) · Supabase JS (Postgres + Storage) · Auth0 · in-repo structured logger. **Removed from the generation path**: `@elevenlabs/elevenlabs-js` (server Text-to-Dialogue). **Untouched / still required**: `@elevenlabs/react` + ElevenLabs Conversational AI (live-story realtime), native Claude (generation brain + agent LLM).
**Storage**: Supabase Postgres + Storage. Forward-only change drops the `lesson-audio` Storage bucket, the `lesson_audio` table, the `audio_duration_seconds` column on `lessons`, and the `qa_exchanges`/`qa_turns` tables (+ `qa_turn_role` enum). `live_sessions`/`session_turns` retained unchanged (FR-008). No auth/RLS redesign (FR-015).
**Testing**: Vitest (unit + contract + integration, providers mocked) · Playwright e2e · `pnpm eval:generation` quality gate (script-only after this change) · `pnpm typecheck` · `pnpm lint`.
**Target Platform**: Responsive web (Next.js) on Node 20 server.
**Project Type**: Web monorepo — `packages/contracts`, `packages/generator`, `apps/web`, `supabase/migrations`.
**Performance Goals**: Time-to-ready improves vs. the render-inclusive path (SC-006) because the TTS synthesis/stitch step is gone. Per-lesson audio-synthesis + audio-storage cost drops to zero (SC-005). Live-story interruption latency unchanged (out of scope — live-story behavior is untouched, FR-006).
**Constraints**: No new runtime dependency. No feature flag / compatibility shim for the old modes (FR-013). Forward-only; previously rendered audio and old Q&A transcripts are discarded and that loss is accepted (FR-007). Status/error copy must not reference audio render/length/playback (FR-014).
**Scale/Scope**: Single-developer monorepo; the change is a bounded retirement — ~5 whole-file deletions in the generator/audio-storage path, ~6 whole-file deletions in the 005 Q&A path, surgical edits in ~10 mixed files, one new SQL migration, one constitution amendment.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Verdict | Notes |
|-----------|---------|-------|
| **I. Voice-First Experience Quality** | ⚠ Amendment required | Principle I currently names the "scripted podcast" as a voice-consistency surface and says "generated audio MUST sound like a told story." Retiring the scripted podcast removes that surface. FR-012 mandates reframing this wording onto the pinned teacher voice + live narration. This is a sanctioned **MAJOR amendment** (a decided stack component is dropped — see Governance versioning), performed as part of this feature, **not** an unjustified violation. Voice consistency itself is preserved: the single pinned ElevenLabs teacher voice carries the live story. |
| **II. One Language, End-to-End (TS/Node)** | ✅ Pass | Pure TS/Node deletion + reduction. No new runtime, no `any` leaks introduced; shared shapes stay typed in `@idiomatic/contracts`. |
| **III. Evaluated, Reproducible Generation** | ✅ Pass | Generation prompts/workflow stay in version control. The quality gate continues to run on every generation change; it is **narrowed** to script-only criteria (coverage, two-persona, story-driven) per FR-010 — still an enforced eval, just without the audio-duration scorer that no longer has an input. Reproducibility (inputs, model/version, structured script recoverable) is unaffected. |
| **IV. Buy the Hard Parts, Build the Glue** | ✅ Pass | Reinforces the principle: we delete owned glue (TTS batching/stitch, audio storage, playback-Q&A state) and keep buying realtime from ElevenLabs Agents. No managed capability is reimplemented. |
| **V. Learner Data Integrity & Privacy** | ✅ Pass | Auth/ownership/RLS unchanged (FR-015). The durable record consolidates onto `live_sessions`/`session_turns` (owner-scoped RLS retained). Accepted data loss (old audio + 005 Q&A transcripts) is an explicit product decision (FR-007), not a defect. Notes/progress anchoring untouched. |

**Gate result**: PASS with one **planned constitution amendment** (Principle I + the "Scripted audio" stack entry), executed as part of this feature per the Governance amendment procedure. No entry required in Complexity Tracking (the amendment is sanctioned, not a deviation).

## Project Structure

### Documentation (this feature)

```text
specs/007-live-only/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output — decisions & rationale
├── data-model.md        # Phase 1 output — retired vs retained entities + migration shape
├── quickstart.md        # Phase 1 output — how to verify live-only end-to-end
├── contracts/           # Phase 1 output — boundary surface after removal
│   └── boundary-changes.md
└── checklists/
    └── requirements.md  # (already present)
```

### Source Code (repository root)

```text
packages/contracts/src/
├── lesson.ts            # EDIT — drop `audioDurationSeconds` from LessonSummary
├── lesson-script.ts     # KEEP — script boundary (estimatedDurationSeconds is a plan input)
├── live-story.ts        # KEEP — live-story schemas
└── qa.ts                # DELETE — 005 Q&A schemas; drop its re-export from index.ts

packages/generator/src/
├── index.ts             # EDIT — remove TTS stage + RenderedAudio from generateLesson
├── config.ts            # EDIT — drop tts* config; KEEP targetMin/MaxSeconds, voice ids
├── adapters/
│   ├── elevenlabs.ts    # DELETE — server Text-to-Dialogue render adapter
│   ├── mock.ts          # EDIT — drop MockTtsAdapter; KEEP MockLlmAdapter
│   ├── types.ts         # EDIT — drop RenderedAudio + Tts adapter interface; KEEP target* on request
│   └── claude.ts        # KEEP — script generation
├── workflow/
│   ├── derive-plan.ts   # KEEP — read-only plan derivation (uses estimatedDurationSeconds)
│   ├── validate-coverage.ts  # KEEP
│   └── tracing.ts       # EDIT — drop audio fields from traced output
├── prompts/lesson-script.ts  # KEEP — script prompt (word-count target stays)
├── observability/events.ts   # EDIT — drop render.* EventIds
├── evals/
│   ├── scorers.ts       # EDIT — delete scoreLength + LengthWindow + ScorerKey "length"
│   ├── harness.ts       # EDIT — drop lengthWindow plumbing + scoreLength call
│   └── run.ts           # EDIT — drop lengthWindow/live-TTS detection; KEEP script scorers
└── tests/eval/scorers.test.ts  # EDIT — drop length-scorer test

apps/web/
├── app/lessons/[id]/page.tsx          # EDIT — remove <audio> player + LiveTutorProvider
├── app/lessons/[id]/live-tutor/*      # DELETE — 005 Q&A UI (Provider/Controller/usePlaybackQa)
├── app/lessons/[id]/live-story/*      # KEEP — 006 live-story UI
├── app/api/lessons/[id]/live-session/route.ts  # DELETE — 005 token mint route
├── app/api/lessons/[id]/exchanges/route.ts     # DELETE — 005 Q&A route
├── app/api/lessons/[id]/live-story/**          # KEEP
├── lib/live-tutor/
│   ├── token.ts         # KEEP — REUSED by live-story (do not move)
│   ├── service.ts       # DELETE
│   ├── current-item.ts  # DELETE
│   ├── exchange-state.ts# DELETE
│   ├── context.ts       # DELETE
│   ├── availability.ts  # DELETE
│   └── agent-prompt.ts  # DELETE
├── lib/qa/*             # DELETE — 005 Q&A persistence
├── lib/supabase/qa-repository.ts       # DELETE
├── lib/supabase/audio-storage.ts       # DELETE — Supabase audio storage
├── lib/generation/storage.ts           # DELETE — AudioStorage port + in-memory impl
├── lib/generation/runner.ts            # EDIT — stop upload; mark ready on script
├── lib/generation/deps.ts              # EDIT — drop TTS adapter wiring
├── lib/container.ts                    # EDIT — drop qaRepo + LiveTutorService wiring
├── lib/lessons/{types,repository,service,in-memory-repository}.ts  # EDIT — drop audio* + getAudio
├── lib/supabase/lesson-repository.ts   # EDIT — drop lesson_audio insert/read + audio col map
└── lib/live-story/**                   # KEEP

supabase/migrations/
└── 0006_retire_audio_qa.sql            # NEW — drop bucket + lesson_audio + qa_* + audio col

scripts/
├── smoke-generate.ts                   # EDIT — no audio output; exercise script path only (FR-011)
└── create-live-tutor-agent.ts          # DELETE — 005 agent setup

.specify/memory/constitution.md          # EDIT — MAJOR amendment (FR-012), via /speckit.constitution
```

**Structure Decision**: Existing web-monorepo layout is retained (`packages/contracts`,
`packages/generator`, `apps/web`, `supabase/migrations`). No new top-level structure — this
feature subtracts surface area. The two subsystem boundaries from the constitution (Lesson
Generator ↔ Live Player via the structured script) are preserved; the script remains the
only cross-subsystem artifact, now also the only generation output.

## Complexity Tracking

> No constitution violations require justification. The Principle-I amendment is a
> sanctioned governance change executed as part of this feature (FR-012), not a deviation,
> so no row is needed here.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| _(none)_ | — | — |
