import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { LiveSession, StartStoryToken, TranscriptDTO } from "@idiomatic/contracts";
import { makeHarness } from "../helpers";
import {
  StartStoryService,
  TranscriptService,
  InMemoryLiveStoryRepository,
  type LiveStoryConfig,
  type TokenFetch,
} from "@idiomatic/live-story";
import { counterIdGenerator, fixedClock } from "../helpers";

/**
 * Contract tests for the live-story routes against contracts/http-api.md:
 *   POST /api/lessons/{id}/live-story        → 200 StartStoryToken | 401 | 404 | 409  (T015, US1)
 *   POST /api/lessons/{id}/live-story/turns  → 201 LiveSession | 400 | 401 | 404      (T040, US5)
 *   GET  /api/lessons/{id}/transcript        → 200 TranscriptDTO | 401 | 404          (T040, US5)
 * Auth + container are mocked so handlers run hermetically over the in-memory stack.
 */

const config: LiveStoryConfig = {
  apiKey: "xi-secret",
  agentId: "agent_story",
  targetMinSeconds: 300,
  targetMaxSeconds: 600,
};

const state = vi.hoisted(() => ({
  owner: "auth0|alice" as string | null,
  startStory: null as StartStoryService | null,
  transcript: null as TranscriptService | null,
  readyId: "" as string,
  pendingId: "" as string,
  sessionId: "" as string,
}));

vi.mock("../../lib/auth/session", () => ({
  getOwnerId: async () => state.owner,
  getAuthToken: async () => null,
}));

vi.mock("../../lib/container", () => ({
  getStartStoryService: () => state.startStory,
  getTranscriptService: () => state.transcript,
}));

import { POST as liveStoryPOST } from "../../app/api/lessons/[id]/live-story/route";
import { POST as turnsPOST } from "../../app/api/lessons/[id]/live-story/turns/route";
import { GET as transcriptGET } from "../../app/api/lessons/[id]/transcript/route";

const fetchOk: TokenFetch = async () =>
  new Response(JSON.stringify({ token: "conv-token-abc" }), { status: 200 });

function liveStory(id: string): Promise<Response> {
  return liveStoryPOST(
    new NextRequest(`http://localhost/api/lessons/${id}/live-story`, { method: "POST" }),
    { params: Promise.resolve({ id }) },
  );
}

function postTurns(id: string, body: unknown): Promise<Response> {
  return turnsPOST(
    new NextRequest(`http://localhost/api/lessons/${id}/live-story/turns`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

function getTranscript(id: string): Promise<Response> {
  return transcriptGET(new NextRequest(`http://localhost/api/lessons/${id}/transcript`), {
    params: Promise.resolve({ id }),
  });
}

beforeAll(async () => {
  const h = makeHarness();

  const ready = await h.service.createLesson("auth0|alice", ["break the ice", "spill the beans"]);
  if (!ready.ok) throw new Error("setup: createLesson failed");
  await h.scheduler.settle();
  state.readyId = ready.lesson.id;

  // A genuinely-pending lesson for the 409 case (created via the repo, no generation runs).
  const pending = await h.repo.createPendingLesson({
    ownerId: "auth0|alice",
    generationInput: { items: ["under the weather"] },
    requestedItemCount: 1,
    acceptedItemCount: 1,
    skippedItemCount: 0,
    targetDurationSeconds: 450,
    sourceItems: [
      {
        rawText: "under the weather",
        normalizedText: "under the weather",
        itemType: "idiom",
        teachable: true,
        skipReason: null,
        orderIndex: 0,
        covered: false,
      },
    ],
  });
  state.pendingId = pending.id;

  // One shared live-story repo so the session the start route opens is visible to the
  // turns/transcript services.
  const repo = new InMemoryLiveStoryRepository(counterIdGenerator("sess"), fixedClock());
  state.startStory = new StartStoryService(h.repo, repo, config, undefined, fetchOk);
  state.transcript = new TranscriptService(h.repo, repo, undefined);

  // Open a session to exercise the turns/transcript routes against.
  const opened = await state.startStory.startStory("auth0|alice", state.readyId);
  if (!opened.ok) throw new Error("setup: startStory failed");
  state.sessionId = opened.token.sessionId;
});

beforeEach(() => {
  state.owner = "auth0|alice";
});

describe("POST /api/lessons/{id}/live-story contract", () => {
  it("returns 200 with a StartStoryToken for a ready, owned lesson", async () => {
    const res = await liveStory(state.readyId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(() => StartStoryToken.parse(body)).not.toThrow();
    expect(body.connectionType).toBe("webrtc");
    expect(body.sessionId.length).toBeGreaterThan(0);
    expect(body.dynamicVariables.items_list).toContain("break the ice");
  });

  it("returns 401 when unauthenticated", async () => {
    state.owner = null;
    const res = await liveStory(state.readyId);
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthenticated");
  });

  it("returns 404 for an unknown lesson (no existence leak)", async () => {
    const res = await liveStory("does-not-exist");
    expect(res.status).toBe(404);
  });

  it("returns 409 when the lesson is not ready", async () => {
    const res = await liveStory(state.pendingId);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("not_ready");
  });
});

describe("POST /api/lessons/{id}/live-story/turns contract", () => {
  it("returns 201 with the updated LiveSession and assigns ordered turn indexes", async () => {
    const res = await postTurns(state.readyId, {
      sessionId: state.sessionId,
      turns: [
        { role: "teacher", kind: "narration", text: "Two strangers waited at a bus stop.", elevenTurnRef: "t0" },
        { role: "learner", kind: "question", text: "What does break the ice mean?" },
        { role: "teacher", kind: "answer", text: "It means to ease the awkwardness when people first meet." },
      ],
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(() => LiveSession.parse(body)).not.toThrow();
    expect(body.turns.map((t: { turnIndex: number }) => t.turnIndex)).toEqual([0, 1, 2]);
  });

  it("upserts a teacher turn in place on a barge-in correction (same elevenTurnRef)", async () => {
    const res = await postTurns(state.readyId, {
      sessionId: state.sessionId,
      turns: [{ role: "teacher", kind: "narration", text: "Two strangers waited at a bus stop", elevenTurnRef: "t0" }],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { turns: { text: string; elevenTurnRef: string | null }[] };
    const corrected = body.turns.filter((t) => t.elevenTurnRef === "t0");
    expect(corrected).toHaveLength(1); // not appended — overwritten in place
    expect(corrected[0]?.text).toBe("Two strangers waited at a bus stop");
  });

  it("overwrites the scenario (latest wins) and can mark the session ended", async () => {
    const res = await postTurns(state.readyId, {
      sessionId: state.sessionId,
      turns: [{ role: "learner", kind: "scenario_change", text: "space travel" }],
      scenario: "space travel",
      ended: true,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.scenario).toBe("space travel");
    expect(body.status).toBe("ended");
  });

  it("rejects an empty turns array with 400", async () => {
    const res = await postTurns(state.readyId, { sessionId: state.sessionId, turns: [] });
    expect(res.status).toBe(400);
  });

  it("rejects a role/kind-inconsistent turn with 400", async () => {
    const res = await postTurns(state.readyId, {
      sessionId: state.sessionId,
      turns: [{ role: "learner", kind: "answer", text: "nope" }],
    });
    expect(res.status).toBe(400);
  });

  it("returns 401 when unauthenticated", async () => {
    state.owner = null;
    const res = await postTurns(state.readyId, {
      sessionId: state.sessionId,
      turns: [{ role: "teacher", kind: "narration", text: "x" }],
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown lesson", async () => {
    const res = await postTurns("does-not-exist", {
      sessionId: state.sessionId,
      turns: [{ role: "teacher", kind: "narration", text: "x" }],
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/lessons/{id}/transcript contract", () => {
  it("returns 200 with a TranscriptDTO (sessions with ordered turns)", async () => {
    const res = await getTranscript(state.readyId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(() => TranscriptDTO.parse(body)).not.toThrow();
    expect(body.sessions.length).toBeGreaterThanOrEqual(1);
    const turns = body.sessions[0].turns as { turnIndex: number }[];
    expect(turns.map((t) => t.turnIndex)).toEqual([...turns.map((t) => t.turnIndex)].sort((a, b) => a - b));
  });

  it("returns 401 when unauthenticated", async () => {
    state.owner = null;
    const res = await getTranscript(state.readyId);
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown lesson", async () => {
    const res = await getTranscript("does-not-exist");
    expect(res.status).toBe(404);
  });
});
