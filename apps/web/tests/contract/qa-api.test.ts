import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { LiveSessionToken, QaExchange } from "@idiomatic/contracts";
import { makeHarness } from "../helpers";
import { LiveTutorService } from "../../lib/live-tutor/service";
import { QaService } from "../../lib/qa/service";
import { InMemoryQaRepository } from "../../lib/qa/in-memory-repository";
import { counterIdGenerator, fixedClock } from "../helpers";
import type { TokenFetch } from "../../lib/live-tutor/token";

/**
 * T008 + T025 — Contract tests for the live-tutor routes against contracts/http-api.md:
 *   POST /api/lessons/{id}/live-session  → 200 LiveSessionToken | 401 | 404 | 409 | 503
 *   POST /api/lessons/{id}/exchanges     → 201 QaExchange | 400 | 401 | 404
 *   GET  /api/lessons/{id}/exchanges     → 200 { exchanges: QaExchange[] }
 * Auth + container are mocked so handlers run hermetically over the in-memory stack.
 */

const state = vi.hoisted(() => ({
  owner: "auth0|alice" as string | null,
  liveTutor: null as LiveTutorService | null,
  qa: null as QaService | null,
  readyId: "" as string,
  pendingId: "" as string,
}));

vi.mock("../../lib/auth/session", () => ({
  getOwnerId: async () => state.owner,
  getAuthToken: async () => null,
}));

vi.mock("../../lib/container", () => ({
  getLiveTutorService: () => state.liveTutor,
  getQaService: () => state.qa,
}));

import { POST as liveSessionPOST } from "../../app/api/lessons/[id]/live-session/route";
import { POST as exchangesPOST, GET as exchangesGET } from "../../app/api/lessons/[id]/exchanges/route";

const fetchOk: TokenFetch = async () =>
  new Response(JSON.stringify({ token: "conv-token-abc" }), { status: 200 });

function liveSession(id: string, body?: unknown): Promise<Response> {
  return liveSessionPOST(
    new NextRequest(`http://localhost/api/lessons/${id}/live-session`, {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

function postExchange(id: string, body: unknown): Promise<Response> {
  return exchangesPOST(
    new NextRequest(`http://localhost/api/lessons/${id}/exchanges`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

function getExchanges(id: string): Promise<Response> {
  return exchangesGET(new NextRequest(`http://localhost/api/lessons/${id}/exchanges`), {
    params: Promise.resolve({ id }),
  });
}

beforeAll(async () => {
  const h = makeHarness();

  const ready = await h.service.createLesson("auth0|alice", ["break the ice", "spill the beans"]);
  if (!ready.ok) throw new Error("setup: createLesson failed");
  await h.scheduler.settle();
  state.readyId = ready.lesson.id;

  // A genuinely-pending lesson for the 409 case (created via the repo, so no generation
  // runs — the test scheduler executes scheduled tasks eagerly, so a serviced lesson
  // would race to ready).
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

  const qaRepo = new InMemoryQaRepository(counterIdGenerator("qa"), fixedClock());
  state.liveTutor = new LiveTutorService(
    h.repo,
    { apiKey: "xi-secret", agentId: "agent_x" },
    undefined,
    fetchOk,
  );
  state.qa = new QaService(h.repo, qaRepo, undefined);
});

beforeEach(() => {
  state.owner = "auth0|alice";
});

describe("POST /api/lessons/{id}/live-session contract", () => {
  it("returns 200 with a LiveSessionToken for a ready, owned lesson", async () => {
    const res = await liveSession(state.readyId, { currentPositionSeconds: 0 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(() => LiveSessionToken.parse(body)).not.toThrow();
    expect(body.connectionType).toBe("webrtc");
    expect(body.dynamicVariables.items_list).toContain("break the ice");
  });

  it("works with no request body", async () => {
    const res = await liveSession(state.readyId);
    expect(res.status).toBe(200);
  });

  it("returns 401 when unauthenticated", async () => {
    state.owner = null;
    const res = await liveSession(state.readyId);
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthenticated");
  });

  it("returns 404 for an unknown lesson (no existence leak)", async () => {
    const res = await liveSession("does-not-exist");
    expect(res.status).toBe(404);
  });

  it("returns 409 when the lesson is not ready", async () => {
    const res = await liveSession(state.pendingId);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("not_ready");
  });
});

describe("POST /api/lessons/{id}/exchanges contract", () => {
  const validBody = {
    interruptionPositionSeconds: 12.5,
    elevenlabsConversationId: "conv-1",
    turns: [
      { role: "learner", text: "What does break the ice mean?", turnIndex: 0 },
      { role: "tutor", text: "It means to ease initial tension.", turnIndex: 1 },
    ],
  };

  it("returns 201 with a stored QaExchange", async () => {
    const res = await postExchange(state.readyId, validBody);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(() => QaExchange.parse(body)).not.toThrow();
    expect(body.lessonId).toBe(state.readyId);
    expect(body.exchangeIndex).toBe(0);
    expect(body.turns).toHaveLength(2);
  });

  it("rejects an empty turns array with 400", async () => {
    const res = await postExchange(state.readyId, { ...validBody, turns: [] });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_body");
  });

  it("rejects blank turn text with 400", async () => {
    const res = await postExchange(state.readyId, {
      ...validBody,
      turns: [{ role: "learner", text: "", turnIndex: 0 }],
    });
    expect(res.status).toBe(400);
  });

  it("returns 401 when unauthenticated", async () => {
    state.owner = null;
    const res = await postExchange(state.readyId, validBody);
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown lesson", async () => {
    const res = await postExchange("does-not-exist", validBody);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/lessons/{id}/exchanges contract", () => {
  it("lists captured exchanges, ordered by exchangeIndex", async () => {
    // The POST suite above captured one exchange for readyId; add a second.
    await postExchange(state.readyId, {
      interruptionPositionSeconds: 30,
      turns: [{ role: "learner", text: "And spill the beans?", turnIndex: 0 }],
    });

    const res = await getExchanges(state.readyId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.exchanges)).toBe(true);
    expect(body.exchanges.length).toBeGreaterThanOrEqual(2);
    expect(body.exchanges[0].exchangeIndex).toBe(0);
    expect(body.exchanges[1].exchangeIndex).toBe(1);
    for (const ex of body.exchanges) expect(() => QaExchange.parse(ex)).not.toThrow();
  });

  it("returns 404 for an unknown lesson", async () => {
    const res = await getExchanges("does-not-exist");
    expect(res.status).toBe(404);
  });

  it("returns 401 when unauthenticated", async () => {
    state.owner = null;
    const res = await getExchanges(state.readyId);
    expect(res.status).toBe(401);
  });
});
