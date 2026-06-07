import {
  LEVEL_RANK,
  type Level,
  type LogContext,
  type LogEntry,
  type LogFields,
  type Logger,
} from "./logger";
import type { EventId } from "./events";
import { redactFields } from "./redact";

/**
 * Newline-delimited-JSON logger (research R5, 003-internal-logging).
 *
 * One `JSON.stringify` + one stream write per event, gated by level so default operation
 * stays quiet (FR-013). Emission is best-effort and isolated: a serialization or write
 * failure is swallowed and never propagates into the caller (FR-014). `child()` returns an
 * independent logger with merged context, so concurrent runs' entries never bleed (FR-015).
 */

export interface JsonLoggerOptions {
  /** Minimum level emitted (default `info`). */
  level?: Level;
  /** Human-readable lines for local dev instead of raw NDJSON. */
  pretty?: boolean;
  /** Correlation context merged into every entry. */
  context?: LogContext;
  /** Where a serialized line goes (default: stdout). Injectable for tests. */
  sink?: (line: string) => void;
  /** ISO timestamp source (default: wall clock). Injectable for deterministic tests. */
  now?: () => string;
}

function defaultSink(line: string): void {
  process.stdout.write(`${line}\n`);
}

function defaultNow(): string {
  return new Date().toISOString();
}

export class JsonLogger implements Logger {
  private readonly level: Level;
  private readonly pretty: boolean;
  private readonly context: LogContext;
  private readonly sink: (line: string) => void;
  private readonly now: () => string;

  constructor(options: JsonLoggerOptions = {}) {
    this.level = options.level ?? "info";
    this.pretty = options.pretty ?? false;
    this.context = options.context ?? {};
    this.sink = options.sink ?? defaultSink;
    this.now = options.now ?? defaultNow;
  }

  enabled(level: Level): boolean {
    return LEVEL_RANK[level] >= LEVEL_RANK[this.level];
  }

  debug(event: EventId, msg: string, fields?: LogFields): void {
    this.emit("debug", event, msg, fields);
  }

  info(event: EventId, msg: string, fields?: LogFields): void {
    this.emit("info", event, msg, fields);
  }

  warn(event: EventId, msg: string, fields?: LogFields): void {
    this.emit("warn", event, msg, fields);
  }

  error(event: EventId, msg: string, fields?: LogFields): void {
    this.emit("error", event, msg, fields);
  }

  child(context: LogContext): Logger {
    return new JsonLogger({
      level: this.level,
      pretty: this.pretty,
      context: { ...this.context, ...context },
      sink: this.sink,
      now: this.now,
    });
  }

  private emit(level: Level, event: EventId, msg: string, fields?: LogFields): void {
    // Best-effort: a logging failure MUST NOT affect generation (FR-014).
    try {
      if (!this.enabled(level)) return;

      const { lessonId, ownerId, ...rest } = this.context;
      const entry: LogEntry = {
        ts: this.now(),
        level,
        event,
        lessonId: lessonId ?? null,
        msg,
      };
      if (ownerId !== undefined) entry.ownerId = ownerId;

      const merged: LogFields = { ...rest, ...(fields ?? {}) };
      if (Object.keys(merged).length > 0) {
        entry.fields = redactFields(merged);
      }

      this.sink(this.pretty ? renderPretty(entry) : JSON.stringify(entry));
    } catch {
      // swallow — observability is never allowed to break the pipeline
    }
  }
}

function renderPretty(entry: LogEntry): string {
  const id = entry.lessonId ?? "-";
  const head = `${entry.ts} ${entry.level.toUpperCase().padEnd(5)} ${entry.event} (${id}) ${entry.msg}`;
  return entry.fields ? `${head} ${JSON.stringify(entry.fields)}` : head;
}
