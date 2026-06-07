import { beforeEach, describe, expect, it } from "vitest";
import { LiveSessionToken } from "@idiomatic/contracts";
import { makeHarness } from "../helpers";
import { LiveTutorService } from "../../lib/live-tutor/service";
import { InMemoryLessonRepository } from "../../lib/lessons/in-memory-repository";
import type { TokenFetch } from "../../lib/live-tutor/token";

/**
 * T009 — Integration: LiveTutorService over the in-memory lesson repo + a faked
 * ElevenLabs token mint (no live keys, research R11). Verifies owner scoping, the
 * not-ready (409) and unavailable (503) outcomes, and that the response carries only a
 * conversation token — never the xi-api-key (Constitution V).
 */

const OWNER = "auth0|alice";

/** Create a ready lesson in the harness repo; returns its id. */
async function readyLesson(h: ReturnType<typeof makeHarness>): Promise<string> {
  const outcome = await h.service.createLesson(OWNER, ["break the ice", "spill the beans"]);
  if (!outcome.ok) throw new Error("setup: createLesson failed");
  await h.scheduler.settle();
  return outcome.lesson.id;
}

const fetchOk: TokenFetch = async () =>
  new Response(JSON.stringify({ token: "conv-token-123" }), { status: 200 });
const fetchFail: TokenFetch = async () => new Response("nope", { status: 500 });

let h: ReturnType<typeof makeHarness>;
beforeEach(() => {
  h = makeHarness();
});

describe("LiveTutorService.startSession", () => {
  it("mints a webrtc token + grounding context for a ready, owned lesson", async () => {
    const id = await readyLesson(h);
    const apiKey = "xi-secret-key-DO-NOT-LEAK";
    const svc = new LiveTutorService(h.repo, { apiKey, agentId: "agent_x" }, undefined, fetchOk);

    const out = await svc.startSession(OWNER, id, 0);
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // Shape conforms to the boundary contract.
    expect(() => LiveSessionToken.parse(out.token)).not.toThrow();
    expect(out.token.conversationToken).toBe("conv-token-123");
    expect(out.token.connectionType).toBe("webrtc");
    expect(out.token.agentId).toBe("agent_x");
    expect(out.token.dynamicVariables.items_list).toContain("break the ice");

    // The api key must never appear in the client-facing payload (Constitution V).
    expect(JSON.stringify(out.token)).not.toContain(apiKey);
  });

  it("returns 404 for another learner's lesson (no existence leak)", async () => {
    const id = await readyLesson(h);
    const svc = new LiveTutorService(h.repo, { apiKey: "k", agentId: "agent_x" }, undefined, fetchOk);
    const out = await svc.startSession("auth0|mallory", id, 0);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(404);
  });

  it("returns 409 when the lesson is not ready yet", async () => {
    // Create but DO NOT settle generation — lesson stays pending.
    const created = await h.service.createLesson(OWNER, ["break the ice"]);
    if (!created.ok) throw new Error("setup failed");
    const svc = new LiveTutorService(h.repo, { apiKey: "k", agentId: "agent_x" }, undefined, fetchOk);
    const out = await svc.startSession(OWNER, created.lesson.id, 0);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(409);
  });

  it("returns 503 when the agent is not configured (FR-017)", async () => {
    const id = await readyLesson(h);
    const svc = new LiveTutorService(h.repo, { apiKey: undefined, agentId: undefined }, undefined, fetchOk);
    expect(svc.available()).toBe(false);
    const out = await svc.startSession(OWNER, id, 0);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(503);
      expect(out.code).toBe("unavailable");
    }
  });

  it("returns 503 when the token mint fails (transient outage)", async () => {
    const id = await readyLesson(h);
    const svc = new LiveTutorService(h.repo, { apiKey: "k", agentId: "agent_x" }, undefined, fetchFail);
    const out = await svc.startSession(OWNER, id, 0);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(503);
  });

  it("enforces the same owner scoping as the repository", () => {
    // The repo used is the privacy-enforcing in-memory implementation.
    expect(h.repo).toBeInstanceOf(InMemoryLessonRepository);
  });
});
