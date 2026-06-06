import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { z } from "zod";
import { ItemType, LessonStatusDTO } from "@idiomatic/contracts";
import { makeHarness } from "../helpers";

/**
 * T019 — Contract test: the real `POST /api/lessons` and `GET /api/lessons/{id}`
 * route handlers return the status codes and body shapes defined in
 * contracts/http-api.md (LessonStatus + lesson detail). The auth boundary and the
 * service container are mocked so the handlers run hermetically over an in-memory
 * stack + mock providers — no live Supabase or provider keys (research R11).
 */

// Mutable harness/owner shared with the mocked modules. `vi.hoisted` lets the
// `vi.mock` factories below capture it despite hoisting.
const state = vi.hoisted(() => ({
  owner: "auth0|alice" as string | null,
  service: null as ReturnType<typeof import("../helpers").makeHarness>["service"] | null,
  scheduler: null as ReturnType<typeof import("../helpers").makeHarness>["scheduler"] | null,
}));

vi.mock("../../lib/auth/session", () => ({
  getOwnerId: async () => state.owner,
  getAuthToken: async () => null,
}));

vi.mock("../../lib/container", () => ({
  getLessonService: () => state.service,
}));

// Imported after the mocks so the handlers resolve the stubbed dependencies.
import { POST } from "../../app/api/lessons/route";
import { GET as detailGET } from "../../app/api/lessons/[id]/route";

/** The `GET /api/lessons/{id}` detail body: LessonStatus + items + nullable audio. */
const LessonDetailBody = LessonStatusDTO.extend({
  items: z.array(
    z.object({
      normalizedText: z.string(),
      itemType: ItemType,
      covered: z.boolean(),
    }),
  ),
  audio: z
    .object({
      url: z.string(),
      durationSeconds: z.number(),
      mimeType: z.string(),
    })
    .nullable(),
});

function postLessons(body: unknown): Promise<Response> {
  return POST(
    new NextRequest("http://localhost/api/lessons", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

function getLesson(id: string): Promise<Response> {
  return detailGET(new NextRequest(`http://localhost/api/lessons/${id}`), {
    params: Promise.resolve({ id }),
  });
}

beforeAll(() => {
  const h = makeHarness();
  state.service = h.service;
  state.scheduler = h.scheduler;
});

beforeEach(() => {
  state.owner = "auth0|alice";
});

afterEach(() => {
  state.owner = "auth0|alice";
});

describe("POST /api/lessons contract", () => {
  it("returns 202 with a LessonStatus body (status pending) for a teachable list", async () => {
    const res = await postLessons({
      items: ["break the ice", "spill the beans", "under the weather"],
    });
    expect(res.status).toBe(202);

    const body = await res.json();
    expect(() => LessonStatusDTO.parse(body)).not.toThrow();
    expect(body.status).toBe("pending");
    expect(body.requestedItemCount).toBe(3);
    expect(body.acceptedItemCount).toBe(3);
    expect(body.skipped).toEqual([]);
  });

  it("includes a typed skip report alongside the 202 for mixed input (FR-006)", async () => {
    const res = await postLessons({ items: ["break the ice", "12345"] });
    expect(res.status).toBe(202);

    const body = LessonStatusDTO.parse(await res.json());
    expect(body.acceptedItemCount).toBe(1);
    expect(body.skipped).toEqual([{ rawText: "12345", reason: "gibberish" }]);
  });

  it("returns 401 with the error envelope when unauthenticated (FR-017)", async () => {
    state.owner = null;
    const res = await postLessons({ items: ["break the ice"] });
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error.code).toBe("unauthenticated");
    expect(typeof body.error.message).toBe("string");
  });

  it("returns 400 invalid_body for a malformed request shape", async () => {
    const res = await postLessons({ notItems: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_body");
  });
});

describe("GET /api/lessons/{id} contract", () => {
  it("returns the detail body shape and reaches a ready lesson with audio", async () => {
    const created = LessonStatusDTO.parse(
      await (await postLessons({ items: ["break the ice", "spill the beans"] })).json(),
    );

    // Shape conforms immediately, before audio exists (pending/generating).
    const early = await getLesson(created.id);
    expect(early.status).toBe(200);
    const earlyBody = LessonDetailBody.parse(await early.json());
    expect(earlyBody.id).toBe(created.id);

    // Drive the deterministic background generation to completion.
    await state.scheduler!.settle();

    const ready = await getLesson(created.id);
    expect(ready.status).toBe(200);
    const body = LessonDetailBody.parse(await ready.json());
    expect(body.status).toBe("ready");
    expect(body.items).toHaveLength(2);
    expect(body.items.every((i) => i.covered)).toBe(true);
    expect(body.audio).not.toBeNull();
    expect(body.audio?.durationSeconds).toBeGreaterThan(0);
    expect(body.audio?.url).toContain(created.id);
    expect(body.audio?.mimeType).toBe("audio/mpeg");
  });

  it("returns 404 (no existence leak) for an unknown lesson id (SC-005)", async () => {
    const res = await getLesson("does-not-exist");
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  it("returns 401 when unauthenticated (FR-017)", async () => {
    state.owner = null;
    const res = await getLesson("anything");
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthenticated");
  });
});
