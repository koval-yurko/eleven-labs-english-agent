# Implementation Plan: Parallelize Batch TTS Rendering

**Branch**: `004-tts-parallel-render` | **Date**: 2026-06-07 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/004-tts-parallel-render/spec.md`

## Summary

Cut lesson-generation wall-clock time by rendering the per-batch ElevenLabs Text-to-Dialogue
calls **concurrently** instead of one-after-another. Today `ElevenLabsTtsAdapter.renderDialogue`
(`packages/generator/src/adapters/elevenlabs.ts:81-96`) walks its batches in a sequential
`for … await` loop, so a multi-batch lesson waits batch-after-batch and total render time grows
linearly with lesson length.

Technical approach: extract a small, dependency-free **`mapWithConcurrency`** primitive (a
sliding worker-pool that runs at most N async tasks at once, returns results in input order, and
propagates the first failure) into `packages/generator/src/utils/concurrency.ts`, export it from
the package's public API, and use it to drive the batch loop. A new configurable bound
`TTS_BATCH_CONCURRENCY` (added to `GeneratorConfig`, conservative default **3**) caps in-flight
syntheses below the ElevenLabs plan limit to avoid 429s. Stitch order is preserved because results
return positionally regardless of completion order; the existing `render.batch` log event still
fires per batch (entries may interleave). The web in-progress banner
(`apps/web/app/lessons/[id]/page.tsx:84-90`) gains a "generation can take a few minutes" note so
the wait reads as expected. This is the **TE1** technical enhancement on top of the implemented S1
lesson-generation feature; no DB/schema change, no new package, no new runtime dependency.

## Technical Context

**Language/Version**: TypeScript (strict) on Node 20 LTS — single language end-to-end (Constitution II)
**Primary Dependencies**: No new runtime dependency. A minimal in-repo `mapWithConcurrency`
primitive added to `packages/generator/src/utils/`; consumed by the existing `ElevenLabsTtsAdapter`.
Existing stack unchanged (Next.js · Mastra-free `generateLesson` orchestrator · `@elevenlabs/elevenlabs-js`
Text-to-Dialogue · Claude · Supabase · Auth0 · Zod · in-repo structured logger · LangSmith soft-dep).
**Storage**: N/A. No persistence change. The stitched `RenderedAudio` artifact and the lesson status
lifecycle persist exactly as today (via S1); only the in-process render scheduling changes.
**Testing**: Vitest unit (concurrency primitive: order preservation, in-flight cap never exceeded,
first-rejection propagation, edge caps 0/1/negative/NaN→default, empty list) + Vitest integration
(adapter renders multi-batch script with stitched bytes byte-equal to sequential output; per-batch
`render.batch` events still emitted for every batch; cap honored). Providers stay mocked
(Constitution Dev Workflow); no live ElevenLabs key required.
**Target Platform**: Node server runtime (generation runs server-side inside the generator package /
`apps/web` bridge). Only the existing in-progress UI copy changes on the client.
**Project Type**: Web application — existing pnpm workspace (`packages/contracts`, `packages/generator`,
`apps/web`); no new package.
**Performance Goals**: For an N-batch lesson (N>1), render wall-clock approaches
`sequential_time ÷ min(N, bound)`; target ≥40% reduction for a typical 5–10 item lesson (SC-001).
No regression for single-batch lessons (SC-004).
**Constraints**: Never exceed the configured in-flight bound (FR-002 / SC-002 — no 429s under normal
load); stitched output byte-equivalent to the prior sequential renderer (FR-006 / SC-003); any batch
failure fails the whole lesson with no partial/mis-ordered audio persisted (FR-007); per-batch
observability preserved (FR-010).
**Scale/Scope**: One self-directed learner per account; modest inputs (≤20 teachable items/lesson →
typically a small number of batches); a handful of concurrent generations. The bound sits below the
plan's account-wide concurrency limit.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate | Status |
|-----------|------|--------|
| I. Voice-First Experience Quality | Output audio is **byte-identical** to today (FR-006/SC-003): same voices, same expressiveness, same stitched bytes — only the render *scheduling* changes. This is the batch path, not the live-tutor barge-in path, so interruption latency is untouched. Net effect is *less* waiting. | ✅ PASS |
| II. One Language, End-to-End | All TypeScript/Node. `mapWithConcurrency<T,R>(items, mapper, limit)` is a fully-typed generic with no `any` across boundaries; the new config field is typed in `GeneratorConfig`. | ✅ PASS |
| III. Evaluated, Reproducible Generation | Same script → same audio bytes; generation remains reproducible. No prompt or model change. Existing `render.batch` traceability preserved (FR-010); evals/length bounding unaffected. | ✅ PASS |
| IV. Buy the Hard Parts, Build the Glue | Bounded-concurrency scheduling of our own batch calls is undifferentiated glue. A ~30-line in-repo primitive is intentionally minimal; a third-party lib (`p-limit`/`p-queue`) is explicitly rejected (spec Out of Scope; see research R1). No managed capability is duplicated — ElevenLabs still owns synthesis. | ✅ PASS |
| V. Learner Data Integrity & Privacy | No data-handling change. No new logging of learner text or secrets; the concurrency util logs nothing itself. No persistence/ownership change. | ✅ PASS |
| Subsystem independence | Change is confined to the Lesson Generator subsystem (the batch path) and one UI copy edit. The generator/web boundary (lesson script in, `RenderedAudio` out) is unchanged; the realtime player/live-tutor subsystem is untouched. | ✅ PASS |

**Result**: All gates pass. No deviations → Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/004-tts-parallel-render/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (decisions + rationale)
├── data-model.md        # Phase 1 output (config field, util signature, render invariants)
├── quickstart.md        # Phase 1 output (configure the bound, verify speedup + order)
├── contracts/
│   └── concurrency.md   # Public contract: mapWithConcurrency signature + invariants + render guarantees
├── checklists/
│   └── requirements.md  # Spec quality checklist (from /speckit.specify)
└── tasks.md             # Phase 2 output (/speckit.tasks — NOT created here)
```

### Source Code (repository root)

New code is one small utility module in the generator package, a config field, a rewrite of the
adapter's batch loop, and one UI copy edit. No new package, no schema/DB changes.

```text
packages/generator/
├── src/
│   ├── utils/
│   │   └── concurrency.ts          # NEW — mapWithConcurrency: bounded pool, order-preserving, first-error-propagating
│   ├── adapters/
│   │   └── elevenlabs.ts           # CHANGE — renderDialogue batch loop uses mapWithConcurrency(batches, …, bound)
│   ├── config.ts                   # CHANGE — add ttsBatchConcurrency (TTS_BATCH_CONCURRENCY, default 3, sanitized)
│   ├── adapters/types.ts           # CHANGE (if needed) — thread the bound to renderDialogue (via options or arg)
│   └── index.ts                    # CHANGE — export the new concurrency util from the public API
└── tests/
    ├── unit/
    │   └── concurrency.test.ts     # NEW — order, cap-never-exceeded, first-rejection, edge caps, empty list
    └── integration/
        └── render-parallel.test.ts # NEW — multi-batch stitch byte-equals sequential; per-batch render.batch fires; cap honored

apps/web/
├── app/lessons/[id]/page.tsx       # CHANGE — in-progress banner adds "generation can take a few minutes"
└── (tests as applicable)           # in-progress copy assertion if a UI test exists

.env.example                        # CHANGE — document TTS_BATCH_CONCURRENCY (and the existing TTS tuning vars)
```

**Structure Decision**: Keep the existing pnpm workspace and add **no new package**. The
concurrency primitive lives under `packages/generator/src/utils/concurrency.ts` (a new `utils/`
sibling to `adapters/`/`observability/`) and is exported from `packages/generator/src/index.ts`
so future callers (parallel item classification, bulk regeneration in S4) reuse it rather than
re-implement concurrency control (FR-008, backlog note). The bound is plumbed as configuration
(`GeneratorConfig.ttsBatchConcurrency`) through the existing `ElevenLabsOptions` seam where the
adapter is built (`apps/web/lib/generation/deps.ts`), so the adapter stays a pure consumer and the
generator subsystem remains independently buildable and testable. This is the lowest-ceremony seam
that satisfies the typed-boundary (II) and reproducibility (III) gates while changing only the
render scheduling.

## Complexity Tracking

> No Constitution Check violations. Section intentionally empty.
