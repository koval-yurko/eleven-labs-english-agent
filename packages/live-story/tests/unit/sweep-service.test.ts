import { describe, expect, it } from "vitest";
import type { SessionTrace, SessionTracer } from "@idiomatic/generator";
import { InMemoryLiveStoryRepository } from "../../src/persistence/in-memory-repository";
import { SweepService } from "../../src/services/sweep-service";
import type { Clock, IdGenerator } from "../../src/types";

/**
 * Contract test for the abandonment sweep (008-langsmith-tracing, T023).
 */

class FakeClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return this.current;
  }
  set(d: Date): void {
    this.current = d;
  }
}
function seqIds(): IdGenerator {
  let n = 0;
  return { next: () => `id-${++n}` };
}
function capturingTracer(): { tracer: SessionTracer; recorded: SessionTrace[] } {
  const recorded: SessionTrace[] = [];
  return {
    recorded,
    tracer: {
      async recordSession(t) {
        recorded.push(t);
      },
    },
  };
}

const T0 = new Date("2026-06-25T12:00:00.000Z");
const NOW = new Date("2026-06-25T12:30:00.000Z"); // 30 min later

describe("SweepService.sweep", () => {
  it("finalizes stale active sessions and records an 'abandoned' finalized trace", async () => {
    const clock = new FakeClock(T0);
    const repo = new InMemoryLiveStoryRepository(seqIds(), clock);
    const { tracer, recorded } = capturingTracer();

    const s = await repo.openSession({ lessonId: "l1", ownerId: "o1", scenario: null });
    await repo.appendTurns("o1", s.id, [
      { role: "teacher", kind: "narration", text: "hello", elevenTurnRef: null },
    ]);

    const result = await new SweepService(repo, tracer).sweep({
      now: NOW,
      idleMinutes: 10,
      limit: 100,
    });

    expect(result).toEqual({ scanned: 1, finalized: 1 });
    const closed = await repo.getSession("o1", s.id);
    expect(closed?.status).toBe("ended");

    expect(recorded).toHaveLength(1);
    expect(recorded[0].ended).toBe(true);
    expect(recorded[0].terminationReason).toBe("abandoned");
    expect(recorded[0].turns).toHaveLength(1);
  });

  it("is idempotent — an already-ended session is skipped (single finalized trace)", async () => {
    const clock = new FakeClock(T0);
    const repo = new InMemoryLiveStoryRepository(seqIds(), clock);
    const { tracer, recorded } = capturingTracer();

    const s = await repo.openSession({ lessonId: "l1", ownerId: "o1", scenario: null });
    await repo.endSession("o1", s.id); // a clean end already happened

    const result = await new SweepService(repo, tracer).sweep({
      now: NOW,
      idleMinutes: 10,
      limit: 100,
    });

    expect(result.finalized).toBe(0);
    expect(recorded).toHaveLength(0);
  });

  it("respects the batch limit", async () => {
    const clock = new FakeClock(T0);
    const repo = new InMemoryLiveStoryRepository(seqIds(), clock);
    const { tracer } = capturingTracer();

    for (let i = 0; i < 5; i++) {
      await repo.openSession({ lessonId: `l${i}`, ownerId: `o${i}`, scenario: null });
    }

    const result = await new SweepService(repo, tracer).sweep({
      now: NOW,
      idleMinutes: 10,
      limit: 2,
    });
    expect(result.finalized).toBe(2);
  });

  it("does not finalize sessions still within the idle window", async () => {
    const clock = new FakeClock(NOW); // session opened "now"
    const repo = new InMemoryLiveStoryRepository(seqIds(), clock);
    const { tracer, recorded } = capturingTracer();

    await repo.openSession({ lessonId: "l1", ownerId: "o1", scenario: null });

    const result = await new SweepService(repo, tracer).sweep({
      now: NOW,
      idleMinutes: 10,
      limit: 100,
    });
    expect(result).toEqual({ scanned: 0, finalized: 0 });
    expect(recorded).toHaveLength(0);
  });
});
