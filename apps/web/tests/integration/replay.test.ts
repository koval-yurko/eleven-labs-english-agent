import { describe, expect, it } from "vitest";
import { buildGenerateLessonDeps } from "../../lib/generation/deps";
import { InMemoryLessonRepository } from "../../lib/lessons/in-memory-repository";
import { counterIdGenerator, fixedClock, makeSession } from "../helpers";

/**
 * T035 — cross-session replay (FR-018/SC-006). A learner generates lessons, "signs out"
 * (we drop the session), then "signs back in" as a brand-new session over the SAME durable
 * repo (standing in for Postgres). Their prior lessons are still listed newest-first and
 * remain readable; another account still sees nothing.
 */

const LEARNER = "auth0|returning-learner";
const OTHER = "auth0|someone-else";

describe("cross-session replay", () => {
  it("lists and reopens prior lessons after re-login", async () => {
    // Durable infra persists across sessions.
    const repo = new InMemoryLessonRepository(counterIdGenerator(), fixedClock());
    const deps = buildGenerateLessonDeps({});

    // --- Session 1: generate two lessons, then the session ends. ---
    const session1 = makeSession(repo, deps);
    const first = await session1.service.createLesson(LEARNER, ["break the ice"]);
    const second = await session1.service.createLesson(LEARNER, [
      "spill the beans",
      "under the weather",
    ]);
    if (!first.ok || !second.ok) throw new Error("expected both lessons to be created");
    await session1.scheduler.settle();

    const secondId = second.lesson.id;

    // --- Session 2: fresh service over the same durable infra (re-login). ---
    const session2 = makeSession(repo, deps);

    // Library lists both lessons, newest-first (FR-020).
    const library = await session2.service.listLessons(LEARNER);
    expect(library).toHaveLength(2);
    expect(library[0]!.id).toBe(secondId); // most recent first
    expect(library.every((l) => l.status === "ready")).toBe(true);
    expect(library[0]!.itemPreview).toEqual(["spill the beans", "under the weather"]);

    // The prior lesson is fully reopenable: detail is ready with its taught items.
    const detail = await session2.service.getLesson(LEARNER, secondId);
    expect(detail).not.toBeNull();
    expect(detail!.status).toBe("ready");
    expect(detail!.items.length).toBeGreaterThan(0);

    // Privacy still holds across sessions: another account sees nothing (FR-019/SC-005).
    expect(await session2.service.listLessons(OTHER)).toHaveLength(0);
    expect(await session2.service.getLesson(OTHER, secondId)).toBeNull();
  });
});
