import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../../src/index";

/**
 * T002 (Foundational) — contract for the reusable bounded-concurrency primitive
 * (004-tts-parallel-render, contracts/concurrency.md §1). Order preservation (C1),
 * the in-flight cap (C2), fail-fast (C3), empty (C4), and a degenerate limit (C5).
 */

/** Resolve after `ms` "ticks" via chained microtasks (no real timers, keeps tests fast/deterministic). */
async function tick(ms: number): Promise<void> {
  for (let i = 0; i < ms; i++) await Promise.resolve();
}

describe("mapWithConcurrency", () => {
  it("returns results in input order even when mappers settle out of order (C1)", async () => {
    const items = [0, 1, 2, 3, 4];
    // Earlier items resolve later, so completion order is the reverse of input order.
    const out = await mapWithConcurrency(
      items,
      async (n) => {
        await tick(items.length - n);
        return n * 10;
      },
      2,
    );
    expect(out).toEqual([0, 10, 20, 30, 40]);
  });

  it("never exceeds min(limit, items.length) in-flight invocations (C2)", async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    let inFlight = 0;
    let peak = 0;
    const limit = 3;
    await mapWithConcurrency(
      items,
      async (n) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await tick(2);
        inFlight--;
        return n;
      },
      limit,
    );
    expect(peak).toBe(Math.min(limit, items.length));
  });

  it("caps at items.length when limit exceeds the number of items (C2)", async () => {
    const items = [0, 1];
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(
      items,
      async (n) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await tick(2);
        inFlight--;
        return n;
      },
      100,
    );
    expect(peak).toBe(2);
  });

  it("propagates the first rejection and starts no further work (C3)", async () => {
    const started: number[] = [];
    // limit 1 => strictly sequential; rejecting index 0 must halt before index 1.
    await expect(
      mapWithConcurrency(
        [0, 1, 2],
        async (n) => {
          started.push(n);
          if (n === 0) throw new Error("boom");
          return n;
        },
        1,
      ),
    ).rejects.toThrow("boom");
    expect(started).toEqual([0]);
  });

  it("resolves to [] for an empty list and never calls the mapper (C4)", async () => {
    let calls = 0;
    const out = await mapWithConcurrency(
      [] as number[],
      async (n) => {
        calls++;
        return n;
      },
      4,
    );
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });

  it("clamps a degenerate limit (0 / negative / NaN) to 1 and stays ordered (C5)", async () => {
    for (const bad of [0, -3, Number.NaN]) {
      let inFlight = 0;
      let peak = 0;
      const out = await mapWithConcurrency(
        [1, 2, 3],
        async (n) => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await tick(1);
          inFlight--;
          return n;
        },
        bad,
      );
      expect(out).toEqual([1, 2, 3]);
      expect(peak).toBe(1);
    }
  });

  it("handles a single item with any limit", async () => {
    const out = await mapWithConcurrency(["x"], async (s, i) => `${s}:${i}`, 8);
    expect(out).toEqual(["x:0"]);
  });
});
