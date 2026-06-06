# Quickstart: Structured Internal Logging

Feature: `003-internal-logging` · Date: 2026-06-06

How to enable, use, and verify the internal generation logs. This feature adds no UI and no new services — it makes the existing generation pipeline observable on stdout.

## Prerequisites

- The implemented S1 `lesson-generation` feature (this instruments its pipeline).
- The repo set up per the root `CLAUDE.md` (`pnpm install`). No new dependencies, no DB migration, no provider keys required (logging is exercised with mocked providers).

## Enable / configure

Logging is on by default at `info`. Control it with environment variables (document in `.env.example`):

```bash
LOG_LEVEL=info      # debug | info | warn | error  (default: info)
LOG_PRETTY=1        # optional: human-readable lines for local dev (default: raw NDJSON)
```

- Normal operation: `info` keeps the trail concise and privacy-safe (counts/ids, no raw learner text).
- Debugging a bad lesson: set `LOG_LEVEL=debug` to also capture per-item raw text and draft/prompt bodies.

## Use it: trace one lesson

1. Generate a lesson (submit a list via the app, or run `pnpm smoke:generate`).
2. Note the lesson id from the response / UI.
3. Filter the process output by that id to get the complete, ordered trail:

```bash
# raw NDJSON
grep '"lessonId":"<LESSON_ID>"' <your-app-output>

# structured (jq)
jq -c 'select(.lessonId=="<LESSON_ID>")' <your-app-output>
```

You should see, in order: `lesson.status` (pending→generating), `teachability.*`, `generate.draft`, `generate.coverage`, `render.batch` (one per batch), `render.total`, `generate.result`, and a final `lesson.status` (generating→ready).

## Use it: diagnose a failure

```bash
# the failing stage + reason for a lesson
jq -c 'select(.lessonId=="<LESSON_ID>" and .event=="generate.error")' <out>
# the lifecycle showing the failed transition
jq -c 'select(.lessonId=="<LESSON_ID>" and .event=="lesson.status")' <out>
```

The `generate.error` entry carries `{ stage, reason }`; the final `lesson.status` shows `{ from: "generating", to: "failed", reason }` — enough to locate the break without re-running (SC-002).

## Verification matrix

| Check | How | Expected | Criterion |
|---|---|---|---|
| Per-lesson trail complete & ordered | `pnpm test` (integration: trail capture) | Every executed stage present for the lesson id | SC-001 |
| Failure pinpointed | integration: failure path | `generate.error` with stage+reason; `lesson.status` → failed | SC-002 |
| No secrets in output | integration: secret-scan test | Zero matches against secret patterns | SC-003 |
| All lifecycle transitions logged | integration: lifecycle test | `pending→generating→ready/failed` each emit `lesson.status` | SC-004 |
| Render timings present | integration: render test | `render.batch` per batch + one `render.total` | SC-005 |
| No generation regression | `pnpm test && pnpm typecheck && pnpm lint` | All green; generation behavior unchanged | SC-006 |
| Concurrency separation | unit/integration: two child runs | Each id-filtered trail contains only its own entries | SC-007 |
| Reproducibility recoverable | integration: result test | `generate.result` carries input count, modelId, promptVersion | SC-008 |
| Level filtering | unit: level test | `info` drops debug; `debug` includes raw text/bodies | FR-013/FR-017 |
| Logging isolation | unit: isolation test | Throwing serializer/write never propagates | FR-014 |

## Standard gates

Before committing feature work (per root `CLAUDE.md`):

```bash
pnpm test && pnpm typecheck && pnpm lint
```

## Out of scope (don't add here)

- No external APM, log collector, shipping, or storage.
- No LangSmith export (already wired in `packages/generator/src/workflow/tracing.ts`).
- No changes to learner-facing UI, lesson content, or generation behavior.
