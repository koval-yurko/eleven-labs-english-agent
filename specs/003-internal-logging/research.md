# Phase 0 Research: Structured Internal Logging

Feature: `003-internal-logging` · Date: 2026-06-06

All Technical Context items were resolvable from the existing codebase and constitution; there were no open `NEEDS CLARIFICATION` markers in the spec. The decisions below lock the design choices the plan depends on.

---

## R1 — Logger implementation: minimal in-repo vs. a logging library

**Decision**: Build a minimal, dependency-free structured logger in `packages/generator/src/observability/` (a `Logger` port, a newline-JSON emitter, a no-op default, level filtering, child-context binding, and a redaction pass).

**Rationale**: The requirements are modest and fully enumerated — line-oriented JSON to stdout, four levels, lesson-id correlation, secret redaction, and emit isolation (FR-001..FR-017). All of that is a few dozen lines of typed code with no runtime dependency, which keeps the bundle and the dependency surface small (Constitution II/IV) and makes the behavior trivially testable with a capturing logger. Logging-to-stdout is undifferentiated glue, not one of the "hard parts" Constitution IV says to buy.

**Alternatives considered**:
- **`pino`** — fast, battle-tested, child loggers and redaction built in. Rejected: adds a runtime dependency and transport/serializer surface for needs we can meet in-house; its redaction is path-based and we want an allowlist-first emission style anyway. Revisit only if log volume/perf becomes a real concern.
- **`winston`** — heavier, transport-oriented; over-scoped for stdout-only. Rejected.
- **A third-party APM / log-shipping SDK** — explicitly out of scope per the spec.

## R2 — Where the logger lives (no new package)

**Decision**: House the logger in `packages/generator` and export it from `@idiomatic/generator`. `apps/web` consumes it from there (it already imports the package). No new workspace package.

**Rationale**: Most loggable events originate inside the generator (classification, draft, coverage, render). The web bridge (`runner.ts`) already imports `@idiomatic/generator`, so reusing the same `Logger` and `LogEntry` taxonomy from one place avoids duplication and a second source of truth. A new `packages/observability` would add workspace/tsconfig/package.json ceremony for no real isolation benefit.

**Alternatives considered**:
- **New `packages/observability` package** — cleanest conceptual home, but more ceremony; rejected for now. The logger module is self-contained, so promoting it to its own package later (if S2/S3/S4 need it independent of generation) is a cheap move.
- **Logger interface in `packages/contracts`, impl in each app** — `contracts` is intentionally schema/DTO-only with no behavior; adding a runtime emitter there breaks that boundary. Rejected. (The `LogEntry` *type* could live in contracts, but co-locating type + impl in generator is simpler and the type is internal, not a cross-subsystem DTO.)

## R3 — Correlation: how `lessonId` reaches generator-internal logs

**Decision**: Use a **child logger bound to context**. The web generation bridge (`runner.ts`) creates `logger.child({ lessonId, ownerId })` per run and injects it into the generation call; `generateLesson` and the stages it calls log through that bound logger, so every entry carries the correlation id automatically. Pre-correlation events (e.g., submission-time validation before a lesson id exists) log with an explicit `lessonId: null`.

**Rationale**: A bound child logger keeps call-sites clean (no threading an id through every signature) and makes concurrency separation structural — each run has its own bound logger, so entries can never be misattributed (FR-015/SC-007). It mirrors the pattern `generateLessonTraced` already uses to pass `{ lessonId, ownerId }` metadata.

**Implementation note**: `generateLesson(items, deps)` currently takes no logger. Add an optional per-run logger (via an extra param or a `logger` field on a per-run options object) defaulting to the no-op logger, so existing callers and tests are unaffected. The `GenerationRunner` already has `lessonId`/`ownerId` at `run()` time — the natural place to mint the child logger.

**Alternatives considered**:
- **AsyncLocalStorage ambient context** — avoids passing a logger at all, but adds implicit global state that is harder to test and reason about, and risks cross-run bleed if misused. Rejected in favor of explicit injection (Constitution II: explicit typed boundaries).
- **Threading `lessonId` as a plain field on every log call** — verbose and error-prone; the child logger subsumes it.

## R4 — Levels and verbosity control

**Decision**: Four levels — `debug | info | warn | error`. A single `LOG_LEVEL` env var (default `info`) sets the threshold; entries below it are dropped before serialization. Deep per-item detail (raw learner item text, prompt/draft bodies) is emitted only at `debug` (FR-013, FR-017). Lifecycle transitions, stage boundaries, classification *summaries* (counts, ids, types), coverage outcomes, render timings, and failures are `info`/`warn`/`error`.

**Rationale**: Keeps normal operation quiet and privacy-safe while making full detail available on demand for active debugging. A single env knob satisfies "configurable without code changes."

**Alternatives considered**: Per-module log levels — more flexibility than needed now; rejected for simplicity. Can layer on later via a namespaced threshold map.

## R5 — Output format, destination, and dev ergonomics

**Decision**: Emit one JSON object per line (NDJSON) to `process.stdout` (FR-016), with a stable core shape (`ts`, `level`, `event`, `lessonId`, `msg`, plus event-specific fields). Provide an optional `LOG_PRETTY=1` dev flag for human-readable single-line output; default is raw JSON for `jq`/`grep`.

**Rationale**: NDJSON to stdout is the universal, infra-free contract — the host runtime captures stdout, and engineers filter with `grep '"lessonId":"…"'` or `jq 'select(.lessonId=="…")'` (satisfies SC-001 retrieval). No collector or vendor needed.

**Alternatives considered**: stderr for warn/error split — unnecessary complexity; a single stream keeps the per-lesson trail contiguous. File output / rotation — that is log-shipping infra, explicitly out of scope.

## R6 — Secret redaction strategy

**Decision**: Two complementary measures. (1) **Allowlist emission** — log only explicitly chosen, named fields per event (never dump whole config/objects/provider payloads), which structurally keeps secrets out. (2) A **redaction pass** as defense-in-depth: before serialization, replace values of keys matching a secret-name set (`apiKey`, `authorization`, `token`, `xi-api-key`, `*_KEY`, `*_SECRET`, etc.) and any value matching known key patterns with `"[redacted]"`.

**Rationale**: The generator already never logs raw provider payloads (adapters surface timings/counts), so the allowlist does most of the work; the redaction pass guarantees SC-003 even if a future call-site logs a richer object. An automated test scans emitted output against secret patterns to enforce zero leakage.

**Alternatives considered**: Redaction-only (no allowlist) — riskier, depends on catching every pattern. Allowlist-only — good but brittle against future careless call-sites. Using both is belt-and-suspenders for a privacy gate (Constitution V).

## R7 — Isolation: logging must never break generation

**Decision**: Every emit is wrapped so any error inside serialization or the stream write is swallowed (best-effort), exactly as `generateLessonTraced` already treats tracing. The no-op logger is the default, so an absent/misconfigured logger degrades to silence, never a throw.

**Rationale**: Observability is strictly subordinate to the product path (FR-014/SC-006). This mirrors the existing soft-dependency posture for LangSmith.

## R8 — Instrumentation points (grounded in current code)

**Decision**: Instrument these existing seams (no behavior change, log-only):

| Stage / event | Call-site (existing) | Level |
|---|---|---|
| Lifecycle `pending→generating` | `apps/web/lib/generation/runner.ts` `run()` start | info |
| Lifecycle `generating→ready` | `runner.ts` after `markReady` | info |
| Lifecycle `generating→failed` + stage + reason | `runner.ts` catch block | error |
| Teachability per-item decision (accept/skip, type; raw text @debug) | `packages/generator/src/teachability.ts` `classifyEntries` / web `service.ts` submission | info (summary) / debug (text) |
| Draft attempt start/outcome (attempt N of MAX) | `packages/generator/src/index.ts` `generateLesson` loop | info; draft body @debug |
| Coverage validation result (uncovered ids, re-prompt occurred) | `index.ts` (uses `validate-coverage.ts`) | info / warn on miss |
| TTS per-batch render timing | `packages/generator/src/adapters/elevenlabs.ts` `renderDialogue` batch loop | info |
| Total stitched render duration | `elevenlabs.ts` after stitch | info |
| Reproducibility summary (input count, modelId, promptVersion) | `index.ts` result / `runner.ts` | info |

**Rationale**: These are precisely the stages the spec calls out (US1/US2/US3) and they already exist as discrete, well-named functions, so instrumentation is additive and low-risk. Timing is captured by measuring around the existing `await` boundaries.

**Note on `Date.now()` in tests**: timing fields use wall-clock at runtime, but unit tests assert *shape and presence* (and use a capturing logger / injectable clock) rather than exact durations, keeping tests deterministic.

## R9 — Testing approach

**Decision**: A **capturing logger** test double records entries in memory for assertions: per-lesson trail completeness and order (SC-001), concurrency separation across two interleaved runs (SC-007), failure path carrying stage + reason (SC-002), lifecycle transitions present (SC-004), render timings present per batch + total (SC-005), and a secret-scan over serialized output (SC-003). Level-filter, redaction, JSON-shape, child-binding, and emit-isolation are unit-tested directly. All with mocked providers (no live keys).

**Rationale**: A capturing logger makes every success criterion directly assertable without parsing stdout, and keeps the suite in the existing Vitest unit+integration structure (Constitution Dev Workflow — providers mocked in CI).
