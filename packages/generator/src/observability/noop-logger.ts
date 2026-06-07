import type { Logger } from "./logger";

/**
 * The default logger: does nothing (research R7, FR-014).
 *
 * Keeps the generator decoupled — an unconfigured environment (and every existing caller
 * that doesn't pass a logger) is silent and never fails. `enabled()` is always false so
 * call sites skip assembling debug-only fields entirely.
 */
class NoopLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  enabled(): boolean {
    return false;
  }
  child(): Logger {
    return this;
  }
}

export const noopLogger: Logger = new NoopLogger();
