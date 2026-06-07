import {
  LEVEL_RANK,
  type EventId,
  type Level,
  type LogContext,
  type LogEntry,
  type LogFields,
  type Logger,
} from "../../src/observability";

/**
 * In-memory `Logger` test double (003-internal-logging, research R9). Records every
 * emitted entry (after applying the configured level threshold and context merge) so
 * tests can assert the per-lesson trail, ordering, and concurrency separation without
 * touching stdout. Children share the root's `entries` array but carry their own context,
 * mirroring how the real per-run child loggers behave (FR-015).
 */
export class CapturingLogger implements Logger {
  readonly entries: LogEntry[];

  constructor(
    private readonly level: Level = "debug",
    private readonly context: LogContext = {},
    entries?: LogEntry[],
  ) {
    this.entries = entries ?? [];
  }

  enabled(level: Level): boolean {
    return LEVEL_RANK[level] >= LEVEL_RANK[this.level];
  }

  debug(event: EventId, msg: string, fields?: LogFields): void {
    this.record("debug", event, msg, fields);
  }

  info(event: EventId, msg: string, fields?: LogFields): void {
    this.record("info", event, msg, fields);
  }

  warn(event: EventId, msg: string, fields?: LogFields): void {
    this.record("warn", event, msg, fields);
  }

  error(event: EventId, msg: string, fields?: LogFields): void {
    this.record("error", event, msg, fields);
  }

  child(context: LogContext): Logger {
    return new CapturingLogger(this.level, { ...this.context, ...context }, this.entries);
  }

  /** Entries whose merged context carries the given lesson id. */
  forLesson(lessonId: string): LogEntry[] {
    return this.entries.filter((e) => e.lessonId === lessonId);
  }

  private record(level: Level, event: EventId, msg: string, fields?: LogFields): void {
    if (!this.enabled(level)) return;
    const { lessonId, ownerId, ...rest } = this.context;
    const entry: LogEntry = {
      ts: "1970-01-01T00:00:00.000Z",
      level,
      event,
      lessonId: lessonId ?? null,
      msg,
    };
    if (ownerId !== undefined) entry.ownerId = ownerId;
    const merged: LogFields = { ...rest, ...(fields ?? {}) };
    if (Object.keys(merged).length > 0) entry.fields = merged;
    this.entries.push(entry);
  }
}
