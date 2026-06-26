import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryLiveStoryRepository, OtelWebhookService } from "@idiomatic/live-story";
import { counterIdGenerator, fixedClock } from "../helpers";

/**
 * Integration (008-langsmith-tracing, T029, US3): a forwarded session trace must carry
 * `thread_id = lessonId` (so generation + every session of a lesson share one LangSmith Thread,
 * FR-006) plus lesson/owner and the filterable session summary (FR-012).
 */

const SECRET = "whsec_thread";
const otelFixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../../packages/live-story/tests/fixtures/otel-delivery.json", import.meta.url),
    ),
    "utf8",
  ),
);

function sign(body: string): string {
  const t = String(Math.floor(Date.now() / 1000));
  return `t=${t},v0=${createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex")}`;
}

type KV = { key: string; value: Record<string, unknown> };

let repo: InMemoryLiveStoryRepository;
beforeEach(() => {
  repo = new InMemoryLiveStoryRepository(counterIdGenerator("sess"), fixedClock());
});

describe("session trace threading (US3)", () => {
  it("threads the forwarded trace under thread_id = lessonId with session summary attrs", async () => {
    const s = await repo.openSession({
      lessonId: "lesson-42",
      ownerId: "auth0|alice",
      scenario: "space travel",
    });
    await repo.appendTurns("auth0|alice", s.id, [
      { role: "teacher", kind: "narration", text: "once upon a time", elevenTurnRef: null },
      { role: "learner", kind: "question", text: "why?", elevenTurnRef: null },
    ]);
    await repo.setConversationId("auth0|alice", s.id, otelFixture.data.conversation_id);

    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));
    const svc = new OtelWebhookService(repo, {
      webhookSecret: SECRET,
      langsmithProject: "eleven-labs-english-agent",
      env: { LANGSMITH_API_KEY: "ls_key" } as unknown as NodeJS.ProcessEnv,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const body = JSON.stringify(otelFixture);
    const res = await svc.handleDelivery({ rawBody: body, signatureHeader: sign(body) });
    expect(res.status).toBe("forwarded");

    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    const sent = JSON.parse(init.body as string);
    const attrs = sent.resourceSpans[0].resource.attributes as KV[];
    const get = (k: string) => attrs.find((a) => a.key === k)?.value;

    expect(get("langsmith.metadata.thread_id")).toEqual({ stringValue: "lesson-42" });
    expect(get("langsmith.metadata.lessonId")).toEqual({ stringValue: "lesson-42" });
    expect(get("langsmith.metadata.ownerId")).toEqual({ stringValue: "auth0|alice" });
    expect(get("langsmith.metadata.scenario")).toEqual({ stringValue: "space travel" });
    expect(get("langsmith.metadata.status")).toEqual({ stringValue: "active" });
    expect(get("langsmith.metadata.turnCount")).toEqual({ intValue: 2 });
  });
});
