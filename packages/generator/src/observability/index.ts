/**
 * Structured internal logging (003-internal-logging). A dependency-free, typed `Logger`
 * port with an NDJSON implementation, a no-op default, level filtering, and secret
 * redaction. Consumed by the generator pipeline and the web generation bridge.
 */
export type { EventId } from "./events";
export type { Level, LogContext, LogEntry, LogFields, Logger } from "./logger";
export { LEVEL_RANK } from "./logger";
export { JsonLogger, type JsonLoggerOptions } from "./json-logger";
export { noopLogger } from "./noop-logger";
export { redactFields } from "./redact";
