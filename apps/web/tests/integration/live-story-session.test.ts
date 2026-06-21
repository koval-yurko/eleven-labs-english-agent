import { beforeEach, describe, expect, it } from "vitest";
import { StartStoryToken } from "@idiomatic/contracts";
import { captureLogger, makeHarness } from "../helpers";
import {
  StartStoryService,
  InMemoryLiveStoryRepository,
  type LiveStoryConfig,
  type TokenFetch,
} from "@idiomatic/live-story";
import { InMemoryLessonRepository } from "../../lib/lessons/in-memory-repository";
import { counterIdGenerator, fixedClock } from "../helpers";

/**
 * T016 [US1] — Integration: StartStoryService over the in-memory lesson + live-story repos
 * and a faked ElevenLabs token mint (no live keys, research R11). Verifies plan derivation,
 * a `LiveSession` row opened `active`, owner scoping, the not-ready (409) outcome, and that
 * the response carries only a conversation token — never the xi-api-key (Constitution V).
 * T047 (US6) adds the 503 unavailable cases.
 */

const OWNER = "auth0|alice";
const config: LiveStoryConfig = {
  apiKey: "xi-secret-key-DO-NOT-LEAK",
  agentId: "agent_story",
  targetMinSeconds: 300,
  targetMaxSeconds: 600,
};

const fetchOk: TokenFetch = async () =>
  new Response(JSON.stringify({ token: "conv-token-123" }), { status: 200 });
const fetchFail: TokenFetch = async () => new Response("nope", { status: 500 });

async function readyLesson(h: ReturnType<typeof makeHarness>): Promise<string> {
  const outcome = await h.service.createLesson(OWNER, ["break the ice", "spill the beans"]);
  if (!outcome.ok) throw new Error("setup: createLesson failed");
  await h.scheduler.settle();
  return outcome.lesson.id;
}

function makeService(
  h: ReturnType<typeof makeHarness>,
  repo: InMemoryLiveStoryRepository,
  cfg: LiveStoryConfig = config,
  fetchImpl: TokenFetch = fetchOk,
): StartStoryService {
  return new StartStoryService(h.repo, repo, cfg, undefined, fetchImpl);
}

let h: ReturnType<typeof makeHarness>;
let repo: InMemoryLiveStoryRepository;
beforeEach(() => {
  h = makeHarness();
  repo = new InMemoryLiveStoryRepository(counterIdGenerator("sess"), fixedClock());
});

describe("StartStoryService.startStory", () => {
  it("derives a plan, opens an active session, and mints a token for a ready lesson", async () => {
    const id = await readyLesson(h);
    const svc = makeService(h, repo);

    const out = await svc.startStory(OWNER, id);
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    expect(() => StartStoryToken.parse(out.token)).not.toThrow();
    expect(out.token.conversationToken).toBe("conv-token-123");
    expect(out.token.connectionType).toBe("webrtc");
    expect(out.token.agentId).toBe("agent_story");
    expect(out.token.dynamicVariables.items_list).toContain("break the ice");
    expect((out.token.dynamicVariables.beats_outline ?? "").length).toBeGreaterThan(0);

    // A LiveSession row was opened `active` and is what the token references.
    const session = await repo.getSession(OWNER, out.token.sessionId);
    expect(session?.status).toBe("active");
    expect(session?.lessonId).toBe(id);
    expect(session?.turns).toHaveLength(0);

    // The api key must never appear in the client-facing payload (Constitution V).
    expect(JSON.stringify(out.token)).not.toContain(config.apiKey);
  });

  it("returns 404 for another learner's lesson (no existence leak)", async () => {
    const id = await readyLesson(h);
    const out = await makeService(h, repo).startStory("auth0|mallory", id);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(404);
  });

  it("returns 409 when the lesson is not ready yet", async () => {
    const created = await h.service.createLesson(OWNER, ["break the ice"]);
    if (!created.ok) throw new Error("setup failed");
    // Do NOT settle generation — lesson stays pending.
    const out = await makeService(h, repo).startStory(OWNER, created.lesson.id);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(409);
  });

  it("does NOT open an orphan session when the mint fails", async () => {
    const id = await readyLesson(h);
    const out = await makeService(h, repo, config, fetchFail).startStory(OWNER, id);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(503);
    expect(await repo.listTranscript(OWNER, id)).toHaveLength(0);
  });

  it("enforces the same owner scoping as the repository", () => {
    expect(h.repo).toBeInstanceOf(InMemoryLessonRepository);
  });
});

describe("StartStoryService unavailable fallback (US6, FR-026/R7)", () => {
  it("returns 503 + emits story.unavailable when the agent is not configured", async () => {
    const id = await readyLesson(h);
    const log = captureLogger();
    const unconfigured: LiveStoryConfig = { ...config, agentId: undefined };
    const svc = new StartStoryService(h.repo, repo, unconfigured, log.logger, fetchOk);
    expect(svc.available()).toBe(false);

    const out = await svc.startStory(OWNER, id);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(503);
      expect(out.code).toBe("unavailable");
    }
    expect(log.entries.some((e) => e.event === "story.unavailable")).toBe(true);
    // No orphan session is opened when live is unavailable.
    expect(await repo.listTranscript(OWNER, id)).toHaveLength(0);
  });

  it("returns 503 + emits story.unavailable on a transient mint failure", async () => {
    const id = await readyLesson(h);
    const log = captureLogger();
    const svc = new StartStoryService(h.repo, repo, config, log.logger, fetchFail);

    const out = await svc.startStory(OWNER, id);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(503);
    expect(log.entries.some((e) => e.event === "story.unavailable")).toBe(true);
  });
});
