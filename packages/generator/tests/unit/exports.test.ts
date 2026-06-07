import { describe, expect, it } from "vitest";
import * as pkg from "../../src/index";
import { mapWithConcurrency } from "../../src/index";

/**
 * T012 (US3, 004-tts-parallel-render) — `mapWithConcurrency` is part of the package public
 * API (the `src/index` barrel), so future callers reuse it instead of re-implementing
 * bounded concurrency (FR-008). Verified via the package entry, exercising the contract.
 */

describe("public API surface", () => {
  it("re-exports mapWithConcurrency from the package barrel", () => {
    expect(typeof pkg.mapWithConcurrency).toBe("function");
  });

  it("the exported primitive runs with order-preserving, bounded semantics", async () => {
    const out = await mapWithConcurrency([1, 2, 3], async (n) => n * 2, 2);
    expect(out).toEqual([2, 4, 6]);
  });
});
