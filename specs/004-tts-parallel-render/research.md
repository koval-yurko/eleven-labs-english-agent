# Research: Parallelize Batch TTS Rendering

**Feature**: 004-tts-parallel-render | **Date**: 2026-06-07
**Input**: [plan.md](./plan.md) Technical Context

All Technical Context items were resolvable from the existing codebase and provider docs;
no `NEEDS CLARIFICATION` remained. The decisions below record what was chosen and why.

---

## R1 — Concurrency primitive: build vs. buy

**Decision**: Build a ~30-line in-repo generic `mapWithConcurrency<T, R>(items, mapper, limit)`
in `packages/generator/src/utils/concurrency.ts`. Do **not** add `p-limit` / `p-queue`.

**Rationale**:
- Constitution IV ("Buy the Hard Parts, Build the Glue") — bounded scheduling of our own async
  calls is undifferentiated glue, not a hard realtime capability. The spec's Out of Scope explicitly
  rejects "adopting a third-party concurrency library when a small in-repo primitive suffices."
- Constitution II ("One Language, End-to-End", no new runtime deps without justification). The need
  is a single order-preserving bounded map; a tiny typed primitive covers it with zero supply-chain
  or version surface.
- Reusability (FR-008): a first-party util can be exported from `@idiomatic/generator` and reused by
  future callers (parallel item classification, S4 bulk regeneration) on our own terms.

**Alternatives considered**:
- `p-limit` — popular, well-tested, but adds a dependency for trivial logic and returns a limiter
  function rather than an order-preserving map (caller still wires `Promise.all` + index bookkeeping).
  `p-queue` (already present transitively in `node_modules` but unused) is heavier still. Rejected per
  the constitution and spec scope.
- Inline the loop in the adapter — works, but violates FR-008's reuse requirement and leaves
  concurrency control un-unit-testable in isolation. Rejected.

---

## R2 — Pool algorithm: sliding worker pool vs. fixed chunking

**Decision**: Sliding worker pool. Spawn `min(limit, items.length)` workers that each pull the next
index off a shared cursor until the list is exhausted; write each result into `results[index]`.
Return `results` (input-ordered). On the **first** rejection, stop pulling new work and reject with
that error.

**Rationale**:
- Wall-clock optimality (SC-001): a sliding pool keeps `limit` tasks busy at all times. Fixed chunking
  (`Promise.all` over slices of `limit`) stalls at every chunk boundary on the slowest item in that
  chunk — wasteful when batch synthesis times vary, which they do (batches differ in char count).
- Order preservation (FR-005/FR-009): writing into `results[index]` decouples completion order from
  result order, so out-of-order finishes still stitch in script order.
- Fail-fast (FR-007): propagating the first rejection means a failed batch fails the whole lesson, as
  today. In-flight tasks are allowed to settle (no cancellation of an already-sent ElevenLabs request,
  which has no abort hook here), but no *new* work starts and the caller sees the error.

**Alternatives considered**:
- `Promise.all(items.map(mapper))` with no bound — simplest, but violates FR-002 (would exceed plan
  concurrency → 429s). Rejected outright; the bound is a correctness requirement.
- Chunked `Promise.all` — bounded and simple but leaves wall-clock on the table at chunk boundaries
  (above). Rejected.
- `Promise.allSettled` semantics (collect all, never reject) — contradicts FR-007 fail-fast. Rejected.

---

## R3 — Default concurrency bound and env var

**Decision**: New env var `TTS_BATCH_CONCURRENCY`, parsed into `GeneratorConfig.ttsBatchConcurrency`,
**default 3**. Sanitize: non-integer / `< 1` / `NaN` → fall back to the default (do not throw, do not
run unbounded). A value of `1` reproduces today's sequential behavior (rollback switch).

**Rationale**:
- ElevenLabs per-plan concurrency limits (verified June 2026): **Free 2, Starter 3, Creator 5,
  Pro 10, Scale/Business 15**. A default of **3** stays at/under the limit for Starter and above and
  delivers a real win for typical 5–10 item lessons (a few batches).
- The product renders with Eleven v3 Text-to-Dialogue (a paid capability), so the operative floor is
  Starter (limit 3), where default 3 is exactly safe. **Caveat documented**: an operator on the Free
  tier (limit 2) MUST set `TTS_BATCH_CONCURRENCY=2`; this is called out in `.env.example` and quickstart.
- Sanitize-to-default (rather than throw) matches the spec edge case "misconfigured cap falls back to
  the safe default," and keeps a typo from failing generation. (Note: this differs from the existing
  `intFromEnv`, which throws on non-numeric — see R4.)

**Alternatives considered**:
- Default 2 (safe on every tier incl. Free) — maximally safe but leaves speedup on the table for the
  common paid case. Rejected in favor of 3 with the Free-tier caveat documented.
- Default = plan max — impossible to know the plan from code, and risks 429s by hugging the ceiling
  with no headroom for the health-check or other in-flight calls. Rejected; conservative default + env
  override is the right shape.

---

## R4 — Config parsing: sanitize vs. throw

**Decision**: Add a dedicated sanitizing parse for `TTS_BATCH_CONCURRENCY` rather than reusing
`intFromEnv` (which throws on non-numeric). Clamp to `>= 1`, default on absent/blank/invalid.

**Rationale**: The bound is a tuning knob whose misconfiguration should degrade gracefully (FR-003,
spec edge case), not hard-fail a lesson. Other tuning ints (`TTS_CHAR_LIMIT`, etc.) throw today, but
those are operator-set ceilings where a typo *should* surface loudly at boot; the concurrency cap is
safer to clamp. Keep the sanitizer a tiny local helper next to `intFromEnv`.

**Alternatives considered**: Reuse `intFromEnv` (throws) — rejected; contradicts the graceful-fallback
edge case. Validate via Zod — overkill for one integer; no Zod in `config.ts` today.

---

## R5 — Plumbing the bound to the adapter

**Decision**: Thread the bound through the existing `ElevenLabsOptions` (built in
`apps/web/lib/generation/deps.ts:71-76` from `GeneratorConfig`) as a new `batchConcurrency` field,
consumed inside `renderDialogue`. Keep `renderDialogue`'s existing `(script, ttsCharLimit, logger)`
signature unchanged.

**Rationale**: The adapter already receives all TTS tuning via `ElevenLabsOptions` at construction
(`modelId`, `bitrate`, voice ids); the concurrency bound is the same kind of static, per-process
tuning. Adding it there keeps the call site in `index.ts:117`
(`tts.renderDialogue(script, config.ttsCharLimit, log)`) untouched and the adapter a pure consumer.

**Alternatives considered**: Add a 4th positional arg to `renderDialogue` — churns the call site and
the `TtsAdapter` interface for a value that is process-static like the others. Rejected. Read
`process.env` inside the adapter — breaks the injected-config pattern and testability. Rejected.

---

## R6 — Preserving per-batch observability under parallelism

**Decision**: Keep the existing `render.batch` log event, emitted from inside the mapper as each batch
completes (carrying `batchIndex`, `batchCount`, `chars`, `durationMs`). Accept that entries may now
**interleave** across batches; the stable `batchIndex` keeps them correlatable. No new `EventId`.

**Rationale**: FR-010 requires per-batch progress to keep flowing. Each batch's `durationMs` is still
measured around its own `convert()` call, so per-batch timings stay accurate; only their emission order
becomes nondeterministic, which the existing integration test for batch logging must tolerate (assert
*set* of batches, not sequence). The TE2 logging note in CLAUDE.md ("add its EventId and emit through
the injected logger — never console.log") is satisfied without a new event id since `render.batch`
already exists.

**Alternatives considered**: Add a `render.batch.parallel` event id — unnecessary; the shape is
identical and `batchIndex`/`batchCount` already disambiguate. Rejected.

---

## R7 — UI expectation-setting copy

**Decision**: Extend the existing in-progress banner in `apps/web/app/lessons/[id]/page.tsx:84-90`
("⏳ Creating your lesson… this page will update automatically.") with a "generation can take a few
minutes" note, shown only while status is `pending`/`generating` and gone at `ready`/`failed`.

**Rationale**: FR-011 / SC-005 — set the wait expectation at the surface that already polls and renders
the in-progress state (polls every ~2.5s). Reuses the existing conditional, so no new state machine.

**Alternatives considered**: Add the note on the submit button (`new/page.tsx`) or the list label
(`page.tsx`) — those are momentary/secondary; the detail banner is where the learner waits and watches.
Touch the banner; leave the others. (Could optionally echo on the list, but minimal footprint is
preferred.)

---

## Summary of decisions

| # | Decision |
|---|----------|
| R1 | Build a first-party `mapWithConcurrency`; no third-party concurrency lib. |
| R2 | Sliding worker-pool algorithm; order-preserving; fail-fast on first rejection. |
| R3 | `TTS_BATCH_CONCURRENCY`, default 3 (safe at Starter+; Free must set 2); `1` = sequential. |
| R4 | Sanitize the cap to default on invalid (don't throw); clamp `>= 1`. |
| R5 | Plumb the bound via `ElevenLabsOptions.batchConcurrency`; keep `renderDialogue` signature. |
| R6 | Reuse `render.batch` event; tolerate interleaving via stable `batchIndex`; no new EventId. |
| R7 | Extend the existing detail-page in-progress banner with the "few minutes" note. |

**Sources**:
- [ElevenLabs API Pricing](https://elevenlabs.io/pricing/api)
- [ElevenLabs API Error Code 429](https://help.elevenlabs.io/hc/en-us/articles/19571824571921-API-Error-Code-429)
