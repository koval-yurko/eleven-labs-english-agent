import type { EventId } from "./events";

/**
 * Structured logging port (003-internal-logging, contracts/log-event.md).
 *
 * The generator and the web bridge program against this typed `Logger` port — never a
 * global or a vendor SDK — so observability is an injected dependency (Constitution II)
 * and the generator keeps a no-op default (subsystem independence). One run binds a child
 * logger to `{ lessonId, ownerId }`, so every entry for that lesson shares its id and the
 * whole trail is retrievable by lesson id alone (SC-001/SC-007).
 */

/** Ordered severity. Entries below the configured threshold are dropped before emission. */
export type Level = "debug" | "info" | "warn" | "error";

/** Numeric rank for threshold comparison: debug < info < warn < error. */
export const LEVEL_RANK: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Allowlisted, non-secret, JSON-serializable structured payload. */
export type LogFields = Record<string, unknown>;

/** Correlation context merged into every entry from a child logger. */
export interface LogContext {
  lessonId?: string | null;
  /** Auth0 subject (`sub`) of the owning learner — never the raw email (Constitution V). */
  ownerId?: string;
  [key: string]: unknown;
}

/** One emitted record, serialized as a single NDJSON line (data-model.md). */
export interface LogEntry {
  ts: string;
  level: Level;
  event: EventId;
  lessonId: string | null;
  ownerId?: string;
  msg: string;
  fields?: LogFields;
}

export interface Logger {
  debug(event: EventId, msg: string, fields?: LogFields): void;
  info(event: EventId, msg: string, fields?: LogFields): void;
  warn(event: EventId, msg: string, fields?: LogFields): void;
  error(event: EventId, msg: string, fields?: LogFields): void;
  /**
   * True when `level` would be emitted at the current threshold. Call sites use this to
   * gate privacy-sensitive fields (raw learner text, prompt bodies) to `debug` (FR-017)
   * without paying to assemble them when they would be dropped.
   */
  enabled(level: Level): boolean;
  /** Returns a logger whose entries are merged with `context` (correlation binding). */
  child(context: LogContext): Logger;
}
