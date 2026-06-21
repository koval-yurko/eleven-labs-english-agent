import { beforeEach, describe, expect, it } from "vitest";
import type { AppendTurnRequest } from "@idiomatic/contracts";
import { makeHarness } from "../helpers";
import { TranscriptService, InMemoryLiveStoryRepository } from "@idiomatic/live-story";
import { counterIdGenerator, fixedClock } from "../helpers";

/**
 * T041 [US5] — Integration: TranscriptService over the in-memory lesson + live-story repos.
 * Verifies incremental persist (off the speech path), the corrected-text upsert by
 * elevenTurnRef (barge-in), preserved ordering, ownership/privacy, and that a partial
 * transcript is kept when a session never ends (FR-027).
 */

const OWNER = "auth0|alice";

async function readyLesson(h: ReturnType<typeof makeHarness>): Promise<string> {
  const outcome = await h.service.createLesson(OWNER, ["break the ice", "piece of cake"]);
  if (!outcome.ok) throw new Error("setup: createLesson failed");
  await h.scheduler.settle();
  return outcome.lesson.id;
}

let h: ReturnType<typeof makeHarness>;
let repo: InMemoryLiveStoryRepository;
let svc: TranscriptService;
let lessonId: string;
let sessionId: string;

beforeEach(async () => {
  h = makeHarness();
  repo = new InMemoryLiveStoryRepository(counterIdGenerator("sess"), fixedClock());
  svc = new TranscriptService(h.repo, repo, undefined);
  lessonId = await readyLesson(h);
  const session = await repo.openSession({ lessonId, ownerId: OWNER, scenario: null });
  sessionId = session.id;
});

function req(partial: Partial<AppendTurnRequest> & { turns: AppendTurnRequest["turns"] }): AppendTurnRequest {
  return { sessionId, ...partial };
}

describe("TranscriptService.appendTurns", () => {
  it("appends finalized turns incrementally with ordered, contiguous indexes", async () => {
    await svc.appendTurns(OWNER, lessonId, req({ turns: [{ role: "teacher", kind: "narration", text: "Once...", elevenTurnRef: "t0" }] }));
    const out = await svc.appendTurns(
      OWNER,
      lessonId,
      req({
        turns: [
          { role: "learner", kind: "question", text: "What does that mean?" },
          { role: "teacher", kind: "answer", text: "It means to ease awkwardness." },
        ],
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.session.turns.map((t) => t.turnIndex)).toEqual([0, 1, 2]);
    expect(out.session.turns.map((t) => t.role)).toEqual(["teacher", "learner", "teacher"]);
  });

  it("upserts a teacher turn in place on a barge-in correction (no duplicate, corrected text)", async () => {
    await svc.appendTurns(OWNER, lessonId, req({ turns: [{ role: "teacher", kind: "narration", text: "Two strangers waited and chatted about—", elevenTurnRef: "t7" }] }));
    const out = await svc.appendTurns(OWNER, lessonId, req({ turns: [{ role: "teacher", kind: "narration", text: "Two strangers waited", elevenTurnRef: "t7" }] }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const t7 = out.session.turns.filter((t) => t.elevenTurnRef === "t7");
    expect(t7).toHaveLength(1);
    expect(t7[0]?.text).toBe("Two strangers waited");
  });

  it("overwrites the scenario (latest wins) and marks the session ended", async () => {
    await svc.appendTurns(OWNER, lessonId, req({ turns: [{ role: "learner", kind: "scenario_change", text: "space travel" }], scenario: "space travel" }));
    const out = await svc.appendTurns(OWNER, lessonId, req({ turns: [{ role: "learner", kind: "scenario_change", text: "a pirate ship" }], scenario: "a pirate ship", ended: true }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.session.scenario).toBe("a pirate ship");
    expect(out.session.status).toBe("ended");
    expect(out.session.endedAt).not.toBeNull();
  });

  it("persists the conversation id once (reproducibility)", async () => {
    await svc.appendTurns(OWNER, lessonId, req({ turns: [{ role: "teacher", kind: "narration", text: "Hi" }], elevenlabsConversationId: "conv_abc" }));
    const out = await svc.appendTurns(OWNER, lessonId, req({ turns: [{ role: "teacher", kind: "narration", text: "More" }], elevenlabsConversationId: "conv_other" }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.session.elevenlabsConversationId).toBe("conv_abc"); // not clobbered
  });

  it("returns 404 for another learner's lesson (privacy)", async () => {
    const out = await svc.appendTurns("auth0|mallory", lessonId, req({ turns: [{ role: "teacher", kind: "narration", text: "x" }] }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(404);
  });

  it("rejects a blank turn with 400", async () => {
    const out = await svc.appendTurns(OWNER, lessonId, req({ turns: [{ role: "teacher", kind: "narration", text: "   " }] }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(400);
  });
});

describe("TranscriptService.listTranscript", () => {
  it("keeps a partial transcript for a session that never ends (FR-027)", async () => {
    await svc.appendTurns(OWNER, lessonId, req({ turns: [{ role: "teacher", kind: "narration", text: "Partial..." }] }));
    // Never mark ended (abandoned). The partial record must survive.
    const transcript = await svc.listTranscript(OWNER, lessonId);
    expect(transcript).not.toBeNull();
    expect(transcript!.sessions).toHaveLength(1);
    expect(transcript!.sessions[0]?.status).toBe("active");
    expect(transcript!.sessions[0]?.turns).toHaveLength(1);
  });

  it("returns null (→404) for a non-owner", async () => {
    expect(await svc.listTranscript("auth0|mallory", lessonId)).toBeNull();
  });

  it("never includes audio anywhere in the transcript (FR-025)", async () => {
    await svc.appendTurns(OWNER, lessonId, req({ turns: [{ role: "teacher", kind: "narration", text: "spoken" }] }));
    const transcript = await svc.listTranscript(OWNER, lessonId);
    expect(JSON.stringify(transcript)).not.toMatch(/audio|mp3|mpeg|\.wav/i);
  });
});
