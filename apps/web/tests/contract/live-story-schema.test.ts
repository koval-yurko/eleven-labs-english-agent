import { describe, expect, it } from "vitest";
import {
  AppendTurnRequest,
  LessonPlan,
  LiveSession,
  PlanBeat,
  PlanItem,
  SessionTurn,
  StartStoryToken,
  TranscriptDTO,
} from "@idiomatic/contracts";

/**
 * T011 — Contract test: the shared live-story Zod schemas (packages/contracts/src/live-story.ts)
 * accept/reject exactly per specs/006-adaptive-live-story/contracts/live-story.schema.json.
 * This is the subsystem boundary the realtime client + route handlers + state machine + repo
 * share (required fields, enums, minItems, role/kind consistency).
 */

describe("PlanItem", () => {
  const valid = { sourceItemId: "si-1", normalizedText: "break the ice", itemType: "idiom" as const };
  it("accepts a well-formed item", () => {
    expect(() => PlanItem.parse(valid)).not.toThrow();
  });
  it("rejects an empty sourceItemId", () => {
    expect(() => PlanItem.parse({ ...valid, sourceItemId: "" })).toThrow();
  });
  it("rejects an unknown itemType", () => {
    expect(() => PlanItem.parse({ ...valid, itemType: "phrase" })).toThrow();
  });
});

describe("PlanBeat", () => {
  it("accepts a beat with no taught items (pure story beat)", () => {
    expect(() => PlanBeat.parse({ index: 0, summary: "Two strangers meet", teachesItemIds: [] })).not.toThrow();
  });
  it("rejects a negative index", () => {
    expect(() => PlanBeat.parse({ index: -1, summary: "x", teachesItemIds: [] })).toThrow();
  });
  it("rejects a blank summary", () => {
    expect(() => PlanBeat.parse({ index: 0, summary: "", teachesItemIds: [] })).toThrow();
  });
});

describe("LessonPlan", () => {
  const valid = {
    lessonId: "lesson-1",
    items: [{ sourceItemId: "si-1", normalizedText: "break the ice", itemType: "idiom" as const }],
    beats: [{ index: 0, summary: "intro", teachesItemIds: ["si-1"] }],
    targetSeconds: 420,
    teacherVoiceId: "voice-x",
  };
  it("accepts a full plan", () => {
    expect(() => LessonPlan.parse(valid)).not.toThrow();
  });
  it("rejects an empty items array (minItems 1)", () => {
    expect(() => LessonPlan.parse({ ...valid, items: [] })).toThrow();
  });
  it("rejects an empty beats array (minItems 1)", () => {
    expect(() => LessonPlan.parse({ ...valid, beats: [] })).toThrow();
  });
  it("rejects a non-positive targetSeconds", () => {
    expect(() => LessonPlan.parse({ ...valid, targetSeconds: 0 })).toThrow();
  });
});

describe("StartStoryToken", () => {
  it("accepts a webrtc token with dynamic variables", () => {
    expect(() =>
      StartStoryToken.parse({
        sessionId: "sess-1",
        agentId: "agent_story",
        conversationToken: "tok",
        connectionType: "webrtc",
        dynamicVariables: { scenario: "space travel", target_minutes: "7" },
      }),
    ).not.toThrow();
  });
  it("rejects an unknown connectionType", () => {
    expect(() =>
      StartStoryToken.parse({
        sessionId: "sess-1",
        agentId: "agent_story",
        conversationToken: "tok",
        connectionType: "carrier-pigeon",
        dynamicVariables: {},
      }),
    ).toThrow();
  });
});

describe("SessionTurn role/kind consistency", () => {
  it("accepts teacher/narration", () => {
    expect(() => SessionTurn.parse({ role: "teacher", kind: "narration", text: "Once...", turnIndex: 0 })).not.toThrow();
  });
  it("accepts teacher/answer with an elevenTurnRef", () => {
    expect(() =>
      SessionTurn.parse({ role: "teacher", kind: "answer", text: "It means...", turnIndex: 1, elevenTurnRef: "t9" }),
    ).not.toThrow();
  });
  it("accepts learner/question and learner/scenario_change", () => {
    expect(() => SessionTurn.parse({ role: "learner", kind: "question", text: "What?", turnIndex: 2 })).not.toThrow();
    expect(() => SessionTurn.parse({ role: "learner", kind: "scenario_change", text: "make it space", turnIndex: 3 })).not.toThrow();
  });
  it("rejects an inconsistent learner/narration turn", () => {
    expect(() => SessionTurn.parse({ role: "learner", kind: "narration", text: "x", turnIndex: 0 })).toThrow();
  });
  it("rejects an inconsistent teacher/question turn", () => {
    expect(() => SessionTurn.parse({ role: "teacher", kind: "question", text: "x", turnIndex: 0 })).toThrow();
  });
  it("rejects blank text", () => {
    expect(() => SessionTurn.parse({ role: "teacher", kind: "narration", text: "", turnIndex: 0 })).toThrow();
  });
});

describe("LiveSession", () => {
  const valid = {
    id: "sess-1",
    lessonId: "lesson-1",
    status: "active" as const,
    scenario: null,
    elevenlabsConversationId: null,
    turns: [],
    createdAt: "2026-06-07T10:00:00.000Z",
    endedAt: null,
  };
  it("accepts an active empty session", () => {
    expect(() => LiveSession.parse(valid)).not.toThrow();
  });
  it("accepts an ended session with a scenario + turns", () => {
    expect(() =>
      LiveSession.parse({
        ...valid,
        status: "ended",
        scenario: "space travel",
        endedAt: "2026-06-07T10:07:00.000Z",
        turns: [{ role: "teacher", kind: "narration", text: "Once...", turnIndex: 0 }],
      }),
    ).not.toThrow();
  });
  it("rejects an unknown status", () => {
    expect(() => LiveSession.parse({ ...valid, status: "paused" })).toThrow();
  });
});

describe("AppendTurnRequest", () => {
  const valid = {
    sessionId: "sess-1",
    turns: [{ role: "teacher" as const, kind: "narration" as const, text: "Two strangers...", elevenTurnRef: "t1" }],
  };
  it("accepts a minimal append (scenario/ended optional)", () => {
    expect(() => AppendTurnRequest.parse(valid)).not.toThrow();
  });
  it("accepts scenario + ended + conversation id", () => {
    expect(() =>
      AppendTurnRequest.parse({ ...valid, scenario: "space", ended: true, elevenlabsConversationId: "conv_x" }),
    ).not.toThrow();
  });
  it("rejects an empty turns array (minItems 1)", () => {
    expect(() => AppendTurnRequest.parse({ ...valid, turns: [] })).toThrow();
  });
  it("rejects blank turn text", () => {
    expect(() =>
      AppendTurnRequest.parse({ ...valid, turns: [{ role: "teacher", kind: "narration", text: "" }] }),
    ).toThrow();
  });
  it("rejects a role/kind-inconsistent turn", () => {
    expect(() =>
      AppendTurnRequest.parse({ ...valid, turns: [{ role: "learner", kind: "answer", text: "x" }] }),
    ).toThrow();
  });
});

describe("TranscriptDTO", () => {
  it("accepts an empty sessions list", () => {
    expect(() => TranscriptDTO.parse({ sessions: [] })).not.toThrow();
  });
});
