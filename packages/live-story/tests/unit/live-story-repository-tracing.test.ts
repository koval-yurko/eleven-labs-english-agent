import { describe, expect, it } from "vitest";
import { InMemoryLiveStoryRepository } from "../../src/persistence/in-memory-repository";
import type { Clock, IdGenerator } from "../../src/types";

/**
 * Contract tests for the 008-langsmith-tracing repository additions: the service-role
 * correlation lookup, the abandonment-sweep query, and the `lastActivityAt` bump on append.
 * Run against the in-memory impl (the Supabase impl mirrors the same behaviour under RLS).
 */

/** A controllable clock so we can age sessions deterministically. */
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

const T0 = new Date("2026-06-25T12:00:00.000Z");

describe("LiveStoryRepository tracing additions (in-memory)", () => {
  describe("findSessionByConversationId", () => {
    it("returns the session/lesson/owner across owners; null when unknown", async () => {
      const clock = new FakeClock(T0);
      const repo = new InMemoryLiveStoryRepository(seqIds(), clock);

      const s = await repo.openSession({ lessonId: "lesson-a", ownerId: "owner-1", scenario: null });
      await repo.setConversationId("owner-1", s.id, "conv_xyz");

      // No owner is passed — the webhook looks the owner UP from the conversation id.
      const hit = await repo.findSessionByConversationId("conv_xyz");
      expect(hit).toEqual({ sessionId: s.id, lessonId: "lesson-a", ownerId: "owner-1" });

      expect(await repo.findSessionByConversationId("conv_unknown")).toBeNull();
    });
  });

  describe("findStaleActiveSessions", () => {
    it("returns only active sessions idle past the cutoff, oldest first, bounded by limit", async () => {
      const clock = new FakeClock(T0);
      const repo = new InMemoryLiveStoryRepository(seqIds(), clock);

      // Two old active sessions...
      const old1 = await repo.openSession({ lessonId: "l1", ownerId: "o1", scenario: null });
      const old2 = await repo.openSession({ lessonId: "l2", ownerId: "o2", scenario: null });
      // ...one already ended (must be excluded)...
      const ended = await repo.openSession({ lessonId: "l3", ownerId: "o3", scenario: null });
      await repo.endSession("o3", ended.id);

      // ...and one freshly active (touched "now", must be excluded).
      clock.set(new Date("2026-06-25T12:20:00.000Z"));
      const fresh = await repo.openSession({ lessonId: "l4", ownerId: "o4", scenario: null });

      // Cutoff = 10 min before the fresh session's open.
      const cutoff = new Date("2026-06-25T12:10:00.000Z");
      const stale = await repo.findStaleActiveSessions(cutoff, 100);

      const ids = stale.map((s) => s.sessionId);
      expect(ids).toContain(old1.id);
      expect(ids).toContain(old2.id);
      expect(ids).not.toContain(ended.id);
      expect(ids).not.toContain(fresh.id);
      // Oldest first.
      expect(ids[0]).toBe(old1.id);

      // Limit is respected.
      const oneOnly = await repo.findStaleActiveSessions(cutoff, 1);
      expect(oneOnly).toHaveLength(1);
      expect(oneOnly[0].sessionId).toBe(old1.id);
    });

    it("an append bumps lastActivityAt so a just-touched session is NOT swept", async () => {
      const clock = new FakeClock(T0);
      const repo = new InMemoryLiveStoryRepository(seqIds(), clock);

      const s = await repo.openSession({ lessonId: "l1", ownerId: "o1", scenario: null });

      // Time passes, then the learner sends a turn (activity).
      clock.set(new Date("2026-06-25T12:30:00.000Z"));
      await repo.appendTurns("o1", s.id, [
        { role: "learner", kind: "question", text: "still here?", elevenTurnRef: null },
      ]);

      // A cutoff before the append must NOT consider the session stale.
      const cutoff = new Date("2026-06-25T12:15:00.000Z");
      const stale = await repo.findStaleActiveSessions(cutoff, 100);
      expect(stale.map((x) => x.sessionId)).not.toContain(s.id);
    });
  });
});
