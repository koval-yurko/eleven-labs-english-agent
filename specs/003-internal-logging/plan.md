# Implementation Plan: Structured Internal Logging for Lesson Generation

**Branch**: `003-internal-logging` | **Date**: 2026-06-06 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/003-internal-logging/spec.md`

## Summary

Make the lesson-generation pipeline observable. Today only the HTTP request edges log; everything between submission and a `ready`/`failed` lesson — teachability classification, draft attempts, coverage validation, per-batch audio rendering, and the `pending → generating → ready|failed` lifecycle — is a black box, so a failed or low-quality lesson cannot be debugged without re-running it.

Technical approach: introduce one small, dependency-free **structured logger** (a typed `Logger` port plus a newline-delimited-JSON implementation, a no-op default, level filtering, and secret redaction) that lives in `packages/generator` and is consumed by both the generator subsystem and `apps/web`. The web generation bridge creates a per-run **child logger bound to `{ lessonId, ownerId }`** and injects it; the generator emits structured events at each pipeline stage through that bound logger, so every entry for one lesson shares its id and the whole trail is retrievable by lesson id alone. Logging is best-effort and isolated (an emit failure never affects generation), secrets are redacted, and deep per-item/per-prompt detail is confined to the `debug` level. No external APM/log-shipping and no LangSmith export are added (LangSmith is already wired in `tracing.ts`). This is the TE2 technical enhancement on top of the implemented S1 feature.

## Technical Context

**Language/Version**: TypeScript (strict) on Node 20 LTS — single language end-to-end (Constitution II)
**Primary Dependencies**: No new runtime dependency. A minimal in-repo structured logger (interface + JSON-line emitter + redaction) added to `packages/generator`; consumed by `apps/web` (which already depends on `@idiomatic/generator`). Existing stack unchanged (Next.js · Mastra-free `generateLesson` orchestrator · Claude/ElevenLabs adapters · Supabase · Auth0 · Zod · LangSmith soft-dep).
**Storage**: N/A. Logs are emitted to the process standard output stream (FR-016); nothing is persisted to Postgres or Storage. The lesson lifecycle states being logged already persist via S1.
**Testing**: Vitest unit (level filtering, redaction, JSON shape, child-context binding, emit-failure isolation) + Vitest integration (per-lesson trail capture with a capturing logger, concurrency separation, failure-path stage+reason) + an automated secret-scan test over emitted output (SC-003). Providers stay mocked (Constitution Dev Workflow).
**Target Platform**: Node server runtime (generation runs server-side inside `apps/web` / the generator package). No browser/client logging surface.
**Project Type**: Web application — existing pnpm workspace (`packages/contracts`, `packages/generator`, `apps/web`); no new package.
**Performance Goals**: Negligible overhead — synchronous `JSON.stringify` + single stream write per event, gated by level so default operation stays quiet (FR-013). No generation failures introduced and no perceptible wall-clock regression (SC-006).
**Constraints**: Zero secrets in output (FR-012/SC-003); logging failures fully isolated from generation (FR-014); concurrent lessons' entries unambiguously separable by correlation id (FR-015/SC-007); learner item text confined to `debug` (FR-017); entries are line-oriented JSON for `grep`/`jq` filtering.
**Scale/Scope**: One self-directed learner per account; modest inputs (≤20 teachable items/lesson); a handful of concurrent generations. Log volume is proportionate and summarizable (no per-character flooding).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate | Status |
|-----------|------|--------|
| I. Voice-First Experience Quality | Observability-only; does not touch the audio path, voices, or any latency-sensitive surface. Isolation requirement (FR-014) guarantees logging cannot regress generation. | ✅ PASS |
| II. One Language, End-to-End | All TypeScript/Node; the `Logger` is an explicit typed port with a structured `LogEntry` shape, no `any` across boundaries; injected, not global. | ✅ PASS |
| III. Evaluated, Reproducible Generation | **Directly advances III.** Logs make each lesson's inputs, model/version, prompt version, and per-stage decisions recoverable for debugging (FR-011/SC-008). No prompts added or changed; no eval behavior changed. | ✅ PASS |
| IV. Buy the Hard Parts, Build the Glue | Logging-to-stdout is undifferentiated glue, not a hard realtime capability. A ~dependency-free structured logger is intentionally minimal; heavy APM/log-shipping is explicitly out of scope. (Library option `pino` considered and rejected in research — modest needs, no new dep.) | ✅ PASS |
| V. Learner Data Integrity & Privacy | **Directly advances V.** Secrets redacted from all output (FR-012); learner-submitted text gated to `debug`, only counts/ids at default level (FR-017); no emails/identity logged. | ✅ PASS |
| Subsystem independence | The logger is an injected port; the generator keeps a no-op default and stays decoupled. Web and generator communicate observability through the structured `LogEntry`/event taxonomy, not shared state. | ✅ PASS |

**Result**: All gates pass. No deviations → Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/003-internal-logging/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (decisions + rationale)
├── data-model.md        # Phase 1 output (LogEntry, Level, event taxonomy, correlation)
├── quickstart.md        # Phase 1 output (enable, filter by lesson, verify no secrets)
├── contracts/           # Phase 1 output
│   └── log-event.md     # Subsystem boundary: LogEntry shape + stage/event taxonomy
├── checklists/
│   └── requirements.md  # Spec quality checklist (from /speckit.specify)
└── tasks.md             # Phase 2 output (/speckit.tasks — NOT created here)
```

### Source Code (repository root)

New code is a single logging module in the generator package plus instrumentation call-sites across the existing pipeline. No new package, no schema/DB changes.

```text
packages/generator/
├── src/
│   ├── observability/                 # NEW — the structured logger
│   │   ├── logger.ts                  # Logger port + LogEntry type + Level; child() context binding
│   │   ├── json-logger.ts            # newline-JSON emitter to stdout; level filter; isolation (try/catch)
│   │   ├── noop-logger.ts            # default no-op (keeps generator decoupled)
│   │   ├── redact.ts                  # secret redaction (key allowlist + value patterns)
│   │   ├── events.ts                  # stable stage/event identifiers (taxonomy)
│   │   └── index.ts
│   ├── index.ts                       # generateLesson — accept per-run logger; log draft attempts/coverage/result
│   ├── teachability.ts                # log per-item accept/skip decision + type (debug for raw text)
│   ├── workflow/validate-coverage.ts  # log uncovered items + re-prompt occurrence
│   ├── adapters/elevenlabs.ts         # log per-batch render timing + total render duration
│   └── config.ts                      # add log level/format config (LOG_LEVEL, LOG_PRETTY)
└── tests/
    ├── unit/                          # level filter, redaction, JSON shape, child binding, isolation
    └── integration/                   # per-lesson trail, concurrency separation, failure stage+reason, secret scan

apps/web/
├── lib/
│   ├── generation/
│   │   ├── runner.ts                  # log pending→generating→ready|failed transitions + failure stage/reason
│   │   └── deps.ts                    # build the concrete JSON logger from env; pass into deps
│   └── lessons/service.ts            # (optional) bind logger at submission for early/uncorrelated events
└── tests/
    └── integration/                   # lifecycle-transition logging assertions
```

**Structure Decision**: Keep the existing pnpm workspace and add **no new package**. The logger lives under `packages/generator/src/observability/` because the generator is where most internal events originate and `apps/web` already imports `@idiomatic/generator`, so the web bridge can reuse the same logger and the same `LogEntry`/event taxonomy. The logger is an injected port (no-op default) so the generator subsystem stays independently buildable and testable, and correlation flows via a per-run child logger bound to `{ lessonId, ownerId }` created in the web generation bridge. This is the lowest-ceremony seam that satisfies the typed-boundary (II), reproducibility (III), and privacy (V) gates.

## Complexity Tracking

> No Constitution Check violations. Section intentionally empty.
