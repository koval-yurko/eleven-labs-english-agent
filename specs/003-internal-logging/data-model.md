# Phase 1 Data Model: Structured Internal Logging

Feature: `003-internal-logging` · Date: 2026-06-06

This feature persists nothing to a database — its "data" is the in-memory/serialized shape of a log entry and the taxonomy of events. There are **no new Postgres tables, columns, enums, RLS policies, or Storage objects**. The lesson lifecycle states being logged already persist via S1; logging only observes them.

---

## Entity: LogEntry

A single self-contained record of one internal event, serialized as one NDJSON line (FR-001, FR-004).

| Field | Type | Required | Notes |
|---|---|---|---|
| `ts` | string (ISO-8601 timestamp) | yes | Wall-clock time the event was emitted. |
| `level` | `Level` | yes | Severity (see enum below). |
| `event` | `EventId` | yes | Stable stage/event identifier from the taxonomy. |
| `lessonId` | string \| null | yes | Correlation id. `null` (explicit) for events that occur before a lesson id exists (FR-002, edge case). |
| `ownerId` | string \| undefined | no | Auth0 subject of the owning learner when known (bound via child logger). Treated as identity → never the raw email; the `sub` only. |
| `msg` | string | yes | Human-readable one-line message. |
| `fields` | object | no | Event-specific structured payload (allowlisted keys only; see per-event fields). Secret-redacted before emission. |

**Validation / invariants**:
- Every entry MUST carry `ts`, `level`, `event`, `lessonId` (or explicit `null`), and `msg` (FR-004).
- `fields` MUST contain only allowlisted, non-secret keys; any value matching a secret key-name or pattern is replaced with `"[redacted]"` (FR-012, R6).
- Raw learner item text and prompt/draft bodies MUST appear only when the active level is `debug` (FR-017, R4).
- Serialization/emission is best-effort: a failure to build or write an entry MUST NOT throw into the caller (FR-014, R7).

## Enum: Level

Ordered severity threshold (R4):

```
debug  <  info  <  warn  <  error
```

- Entries below the configured `LOG_LEVEL` (default `info`) are dropped before serialization.
- `debug` carries the verbose, privacy-sensitive detail (raw item text, draft bodies).

## Entity: Logger (port)

The injected interface; not serialized. Behavior contract (full signatures in `contracts/log-event.md`):

- `debug/info/warn/error(event, msg, fields?)` — emit at the named level.
- `child(context)` — return a new `Logger` whose emitted entries are merged with `context` (e.g., `{ lessonId, ownerId }`), enabling per-run correlation (R3).
- Default binding is the **no-op logger** so the generator stays decoupled and an unconfigured environment is silent, never failing (R1, R7).

## Entity: Event Taxonomy (EventId)

The stable set of stage/event identifiers used for filtering (R8). These are the "Pipeline Stage / Event" entities from the spec.

| `event` | Emitted at | Default level | Key `fields` (allowlisted) |
|---|---|---|---|
| `lesson.status` | lifecycle transition | info (error on `failed`) | `from`, `to`, `reason?`, `stage?` |
| `teachability.item` | per-item classification | info (text @debug) | `id`, `itemType`, `decision` (accepted/skipped), `skipReason?`, `text?`(debug) |
| `teachability.summary` | after classifying a submission | info | `requested`, `accepted`, `skipped` |
| `generate.draft` | each draft attempt start/outcome | info (body @debug) | `attempt`, `maxAttempts`, `outcome?`, `body?`(debug) |
| `generate.coverage` | coverage validation result | info (warn on miss) | `ok`, `uncovered[]`, `reprompted` |
| `render.batch` | each TTS batch render | info | `batchIndex`, `batchCount`, `chars`, `durationMs` |
| `render.total` | after stitch | info | `batchCount`, `bytes`, `audioDurationSeconds`, `renderDurationMs` |
| `generate.result` | generation success summary (reproducibility) | info | `itemCount`, `modelId`, `promptVersion`, `segments`, `coverage` |
| `generate.error` | generation failure | error | `stage`, `reason` |

**State transitions logged** (no new state machine — this is the existing S1 lifecycle, now observed): `pending → generating → ready` and `pending → generating → failed`, plus retry re-entry `failed → generating` (FR-005, FR-006). Each transition emits a `lesson.status` entry with `from`/`to`, and the failure path additionally records the executing `stage` and a human-readable `reason`.

## Relationships

- A **Correlation Id** (`lessonId`) groups all `LogEntry` records for one generation run; it is the join key for retrieval (SC-001) and the guarantee of concurrency separation (SC-007).
- Each `LogEntry.event` is one member of the **Event Taxonomy**; the taxonomy is the stable filtering vocabulary.
- The **Logger** port produces `LogEntry` records; `child()` derives a context-bound logger so all records from one run share `lessonId`/`ownerId`.

## Configuration (env, no schema impact)

| Var | Default | Purpose |
|---|---|---|
| `LOG_LEVEL` | `info` | Minimum level emitted (`debug`/`info`/`warn`/`error`). |
| `LOG_PRETTY` | unset | When set, human-readable output for local dev; otherwise raw NDJSON. |

These extend the generator/web config loaders (`packages/generator/src/config.ts`, `apps/web/lib/generation/deps.ts`); no `.env`-schema migration is required beyond documenting them in `.env.example`.
