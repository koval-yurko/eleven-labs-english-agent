import { describe, expect, it } from "vitest";
import { makeHarness } from "../helpers.js";

/** T034 — cross-account access is denied: another learner cannot see a lesson (FR-019/SC-005). */

const ALICE = "auth0|alice";
const BOB = "auth0|bob";

describe("lesson privacy", () => {
  it("Bob cannot read, list, or get audio for Alice's lesson", async () => {
    const { service, scheduler } = makeHarness();

    const outcome = await service.createLesson(ALICE, ["break the ice"]);
    if (!outcome.ok) throw new Error("expected ok");
    await scheduler.settle();
    const lessonId = outcome.lesson.id;

    // Owner sees it.
    expect(await service.getLesson(ALICE, lessonId)).not.toBeNull();

    // Non-owner gets null (route maps to 404 — no existence leak).
    expect(await service.getLesson(BOB, lessonId)).toBeNull();
    expect(await service.getAudioUrl(BOB, lessonId)).toBeNull();
    expect(await service.listLessons(BOB)).toHaveLength(0);

    // Owner's library still shows it.
    expect(await service.listLessons(ALICE)).toHaveLength(1);
  });

  it("retry is denied for a non-owner", async () => {
    const { service, scheduler } = makeHarness();
    const outcome = await service.createLesson(ALICE, ["spill the beans"]);
    if (!outcome.ok) throw new Error("expected ok");
    await scheduler.settle();

    const result = await service.retry(BOB, outcome.lesson.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });
});
