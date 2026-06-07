# Contract: Structured Log Event (Observability Boundary)

Feature: `003-internal-logging` · Date: 2026-06-06

This is the internal subsystem boundary for observability: the `Logger` port that the generator and web app program against, and the on-the-wire `LogEntry` shape that engineers filter. It is not an external/public API (no HTTP surface); it is the typed contract through which the generation subsystem and the web bridge emit a uniform, correlatable trail.

---

## Logger port (TypeScript)

```ts
export type Level = "debug" | "info" | "warn" | "error";

/** Allowlisted, non-secret, JSON-serializable structured payload. */
export type LogFields = Record<string, unknown>;

export interface LogContext {
  lessonId?: string | null;
  ownerId?: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(event: EventId, msg: string, fields?: LogFields): void;
  info(event: EventId, msg: string, fields?: LogFields): void;
  warn(event: EventId, msg: string, fields?: LogFields): void;
  error(event: EventId, msg: string, fields?: LogFields): void;
  /** True when `level` would be emitted at the current threshold — gates debug-only fields. */
  enabled(level: Level): boolean;
  /** Returns a logger whose entries are merged with `context` (correlation binding). */
  child(context: LogContext): Logger;
}
```

> Implementation note: `enabled(level)` was added to the port during implementation so call
> sites can gate privacy-sensitive fields (raw learner text, draft bodies) to `debug`
> (FR-017) without assembling them when they would be dropped. The no-op logger returns
> `false`, so unconfigured callers never build debug payloads.

**Behavioral contract**:
- Each method emits at most one `LogEntry`, or zero if `level` is below the configured threshold.
- A method MUST NOT throw — serialization or write failures are swallowed (best-effort, FR-014).
- `child()` returns an independent logger; entries from one child MUST NOT acquire another child's context (concurrency separation, FR-015).
- The default exported logger is a **no-op** (generator stays decoupled, FR-014/R7).

## LogEntry (emitted NDJSON, one object per line)

```jsonc
{
  "ts": "2026-06-06T12:34:56.789Z",  // ISO-8601 string, required
  "level": "info",                     // "debug" | "info" | "warn" | "error", required
  "event": "render.batch",            // EventId from the taxonomy, required
  "lessonId": "lesson_123",           // string | null (explicit null pre-correlation), required
  "ownerId": "auth0|abc",             // string, optional (when bound)
  "msg": "rendered batch 2/3",        // string, required
  "fields": { "batchIndex": 1, "batchCount": 3, "chars": 870, "durationMs": 412 }
}
```

**Invariants**:
- `ts`, `level`, `event`, `lessonId` (or explicit `null`), and `msg` are always present.
- `fields` contains only allowlisted keys; secret-named keys/values are emitted as `"[redacted]"`.
- Raw learner text / prompt bodies appear only at `level: "debug"`.

## EventId taxonomy

```ts
export type EventId =
  | "lesson.status"        // lifecycle transition (from/to, reason?, stage?)
  | "teachability.item"    // per-item accept/skip (+ type; text @debug)
  | "teachability.summary" // requested/accepted/skipped counts
  | "generate.draft"       // draft attempt (attempt/maxAttempts; body @debug)
  | "generate.coverage"    // coverage result (ok, uncovered[], reprompted)
  | "render.batch"         // per-TTS-batch timing (batchIndex/Count, chars, durationMs)
  | "render.total"         // stitched totals (bytes, audioDurationSeconds, renderDurationMs)
  | "generate.result"      // success summary (itemCount, modelId, promptVersion, segments, coverage)
  | "generate.error";      // failure (stage, reason)
```

Per-event `fields` allowlists are defined in [`../data-model.md`](../data-model.md#entity-event-taxonomy-eventid).

## Consumer contract (filtering)

Engineers retrieve one lesson's complete, ordered trail with no special tooling:

```bash
# all entries for a lesson, in order
grep '"lessonId":"lesson_123"' app.log

# or structured
jq -c 'select(.lessonId=="lesson_123")' app.log

# just failures with stage + reason
jq -c 'select(.event=="generate.error")' app.log
```

This satisfies SC-001 (100% of a lesson's stages retrievable by id alone) and SC-007 (id-filtered trail contains only that lesson's entries).

## Configuration contract

| Var | Default | Effect |
|---|---|---|
| `LOG_LEVEL` | `info` | Minimum emitted level. |
| `LOG_PRETTY` | unset | Human-readable dev output instead of raw NDJSON. |

## Verification (tests assert against this contract)

- Every `EventId` emits an entry conforming to the `LogEntry` invariants (shape test).
- `LOG_LEVEL=info` drops `debug` entries; `LOG_LEVEL=debug` includes raw text/body fields (level-filter test).
- A secret-pattern scan over emitted output finds zero matches (SC-003).
- Two concurrent `child()` runs produce disjoint id-filtered trails (SC-007).
- A throwing serializer / write does not propagate to the caller (isolation test, FR-014).
