import { afterEach, describe, expect, it } from "vitest";
import {
  flushTracing,
  installTracingShutdownHooks,
} from "../../src/observability/tracing-runtime";

/**
 * Graceful-shutdown flushing for LangSmith. The shared client is only created when a key is
 * present, so with none configured `flushTracing` must be an inert no-op, and installing the
 * shutdown hooks must be idempotent (Next's `register()` runs on every cold start) without
 * leaking duplicate signal listeners.
 */

describe("tracing-runtime", () => {
  const signals = ["SIGTERM", "SIGINT"] as const;
  const before = Object.fromEntries(signals.map((s) => [s, process.listenerCount(s)]));

  afterEach(() => {
    // The hooks install once per process and are not removable; assert we never pile up.
    for (const s of signals) {
      expect(process.listenerCount(s)).toBeLessThanOrEqual(before[s] + 1);
    }
  });

  it("flushTracing is a no-op when no client was ever created (no key configured)", async () => {
    await expect(flushTracing()).resolves.toBeUndefined();
  });

  it("installTracingShutdownHooks is idempotent — repeated calls add no extra listeners", () => {
    installTracingShutdownHooks();
    const afterFirst = signals.map((s) => process.listenerCount(s));
    installTracingShutdownHooks();
    installTracingShutdownHooks();
    expect(signals.map((s) => process.listenerCount(s))).toEqual(afterFirst);
  });
});
