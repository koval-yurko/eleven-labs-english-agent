# Implementation Plan: Generate a Story-Driven Podcast Lesson from a List

**Branch**: `002-lesson-generation` | **Date**: 2026-06-06 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/002-lesson-generation/spec.md`

## Summary

Turn a learner's list of English words/sentences/idioms into a single coherent ~5–10 minute, two-voice (curious learner + warm teacher) audio lesson where every teachable item is taught through a mini-story, then persist it privately to the learner's account for later replay on responsive web.

Technical approach: a **Lesson Generator** subsystem (a versioned Mastra workflow driving Claude) validates/normalizes input, plans coverage, drafts an expressive two-speaker script conforming to a shared **LessonScript** schema, and renders it to audio via ElevenLabs Text to Dialogue (segmented to respect the per-request character limit, then stitched). A **Next.js (App Router)** web app handles authenticated submission, asynchronous generation status, a private lesson library, and in-browser playback. Lessons, source items, the structured script, and the rendered audio persist in **Supabase** (Postgres + Storage) with **Auth0** identity; row-level ownership keeps each lesson private. This feature is S1 (MVP) and deliberately stops before live Q&A, notes, and adaptive progress.

## Technical Context

**Language/Version**: TypeScript (strict) on Node 20 LTS — single language end-to-end (Constitution II)
**Primary Dependencies**: Next.js (App Router) · Mastra (generation workflow) · `@anthropic` Claude (generation brain) · ElevenLabs `@elevenlabs/elevenlabs-js` (server, Text to Dialogue / Eleven v3) + `@elevenlabs/react` (client playback) · Supabase JS (`@supabase/supabase-js`, Postgres + Storage) · Auth0 (`@auth0/nextjs-auth0`) · Zod (shared schemas) · LangSmith via `@mastra/langsmith` (eval/observability)
**Storage**: Supabase Postgres (lessons, source items, script JSON, generation metadata) + Supabase Storage (rendered audio assets). No service-role key in the browser.
**Testing**: Vitest (unit + contract) · Playwright (responsive web E2E across desktop + mobile viewports) · external managed services exercised against mocks/fixtures in CI (no live keys required — Constitution Dev Workflow) · LangSmith evals as the generation quality gate (Constitution III)
**Target Platform**: Responsive web — modern desktop + mobile browsers (no native apps; v1 non-goal NG1)
**Project Type**: Web application — pnpm workspace: a Next.js app plus two internal packages (generator subsystem + shared contracts)
**Performance Goals**: Generation is asynchronous (batch); target lesson length ~5–10 min, none materially over the upper bound (SC-003). No realtime latency budget in S1 (the <1.5s live-answer budget applies to S2). Audio begins playing promptly once a ready lesson is opened.
**Constraints**: ElevenLabs Text to Dialogue ~3,000-char-per-request limit → generate per segment and stitch. Every accepted teachable item covered ≥1× (FR-009/SC-002). Max teachable items per lesson bounded (decided in research: 20). Two distinct, natural voices; teacher voice is a fixed voice ID reused by S2 (Constitution I voice consistency).
**Scale/Scope**: Single self-directed learner per account; modest inputs (≤20 teachable items/lesson); personal-scale lesson libraries. No multi-user/social (NG3).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate | Status |
|-----------|------|--------|
| I. Voice-First Experience Quality | Two distinct, natural voices via Text to Dialogue with expressive audio tags (not screen-reader read-aloud); teacher voice pinned to a fixed voice ID so S2's live tutor matches. No live-answer latency surface in S1. | ✅ PASS |
| II. One Language, End-to-End | All runtime code TypeScript/Node; no Python. Shared lesson-script shape is an explicit Zod schema in `packages/contracts`; no `any` across module boundaries. | ✅ PASS |
| III. Evaluated, Reproducible Generation | Mastra workflow + prompts live in version control; generation runs through LangSmith evals before "done"; each lesson persists its inputs, model/version, and resulting structured script for reproduction/debugging. | ✅ PASS |
| IV. Buy the Hard Parts, Build the Glue | Auth0 (auth), Supabase (storage/DB), ElevenLabs (TTS), Mastra (workflow) are managed; we build only glue. No custom infra duplicating a managed capability. | ✅ PASS |
| V. Learner Data Integrity & Privacy | Lessons owned by exactly one learner; Postgres RLS keyed on the Auth0 subject enforces owner-only access (defense in depth atop server-only route handlers); all provider secrets stay server-side, never shipped to the browser. | ✅ PASS |
| Subsystem independence | Lesson Generator (batch) and the Player/web app communicate **only** through the persisted LessonScript schema, not shared internal state; each is independently buildable/testable. (Live Tutor subsystem is out of scope for S1.) | ✅ PASS |

**Result**: All gates pass. No deviations → Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/002-lesson-generation/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (decisions + rationale)
├── data-model.md        # Phase 1 output (entities, tables, RLS, state machine)
├── quickstart.md        # Phase 1 output (setup + run + verify)
├── contracts/           # Phase 1 output
│   ├── lesson-script.schema.json   # Subsystem boundary: structured two-voice script
│   └── http-api.md                 # Next.js route-handler contracts
└── tasks.md             # Phase 2 output (/speckit.tasks — NOT created here)
```

### Source Code (repository root)

A pnpm workspace keeps the two constitution-mandated subsystems independently buildable while sharing one typed contract.

```text
package.json                      # pnpm workspace root
pnpm-workspace.yaml

packages/contracts/               # Shared boundary: Zod schemas + inferred TS types
└── src/
    ├── lesson-script.ts          # LessonScript schema (speakers, segments, coverage map)
    ├── lesson.ts                 # Lesson/SourceItem/status DTOs
    └── index.ts

packages/generator/               # Lesson Generator subsystem (batch) — Constitution III
├── src/
│   ├── workflow/                 # Mastra workflow: validate → plan coverage → draft → expressive pass → segment
│   ├── prompts/                  # Versioned prompts (no untracked strings)
│   ├── teachability.ts           # classify teachable vs. skipped + normalize/dedupe
│   ├── render/                   # ElevenLabs Text to Dialogue per-segment render + stitch
│   ├── evals/                    # LangSmith eval definitions + fixtures
│   └── index.ts                  # generateLesson(input) → LessonScript + audio asset
└── tests/
    ├── contract/                 # LessonScript schema conformance + coverage guarantee
    └── unit/

apps/web/                         # Next.js (App Router): UI + API + persistence glue
├── app/
│   ├── (auth)/                   # Auth0 sign-in gating
│   ├── lessons/                  # submit form, library list, lesson playback page
│   └── api/lessons/              # route handlers (create/list/get/audio/retry)
├── lib/
│   ├── supabase/                 # server-only Supabase clients (RLS via Auth0 JWT)
│   └── generation/               # enqueue + status bridge to packages/generator
└── tests/
    ├── contract/                 # HTTP API contract tests (mocked providers)
    ├── integration/              # auth gating, ownership/privacy, status lifecycle
    └── e2e/                      # Playwright desktop + mobile viewport flows
```

**Structure Decision**: pnpm workspace. `packages/contracts` is the single source of truth for the LessonScript schema — the boundary through which the batch generator and the realtime/web side communicate (Constitution: subsystems communicate through the structured script, not shared state). `packages/generator` is the self-contained Lesson Generator; `apps/web` is the Next.js application owning UI, authenticated API route handlers, and Supabase persistence. This keeps S1 buildable now and leaves clean seams for S2 (live tutor) to reuse the pinned teacher voice and the same contracts.

## Complexity Tracking

> No Constitution Check violations. Section intentionally empty.
