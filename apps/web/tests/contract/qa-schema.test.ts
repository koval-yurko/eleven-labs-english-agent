import { describe, expect, it } from "vitest";
import {
  CreateExchangeRequest,
  LiveSessionToken,
  QaExchange,
  QaTurn,
} from "@idiomatic/contracts";

/**
 * T007 — Contract test: the shared Q&A Zod schemas (packages/contracts/src/qa.ts)
 * accept/reject exactly per specs/005-live-tutor-qa/contracts/qa.schema.json.
 * This is the subsystem boundary the realtime client + route handlers + repo share.
 */

const validTurn = { role: "learner" as const, text: "What does it mean?", turnIndex: 0 };

describe("QaTurn", () => {
  it("accepts a well-formed turn", () => {
    expect(() => QaTurn.parse(validTurn)).not.toThrow();
  });

  it("rejects blank text", () => {
    expect(() => QaTurn.parse({ ...validTurn, text: "" })).toThrow();
  });

  it("rejects a negative turnIndex", () => {
    expect(() => QaTurn.parse({ ...validTurn, turnIndex: -1 })).toThrow();
  });

  it("rejects an unknown role", () => {
    expect(() => QaTurn.parse({ ...validTurn, role: "robot" })).toThrow();
  });
});

describe("QaExchange", () => {
  const valid = {
    id: "ex-1",
    lessonId: "lesson-1",
    sourceItemId: "item-1",
    exchangeIndex: 0,
    interruptionPositionSeconds: 132.48,
    elevenlabsConversationId: "conv_x",
    turns: [validTurn, { role: "tutor" as const, text: "It means...", turnIndex: 1 }],
    createdAt: "2026-06-07T10:00:00.000Z",
  };

  it("accepts a full exchange", () => {
    expect(() => QaExchange.parse(valid)).not.toThrow();
  });

  it("accepts a null sourceItemId and null conversation id", () => {
    expect(() =>
      QaExchange.parse({ ...valid, sourceItemId: null, elevenlabsConversationId: null }),
    ).not.toThrow();
  });

  it("rejects an empty turns array", () => {
    expect(() => QaExchange.parse({ ...valid, turns: [] })).toThrow();
  });

  it("rejects a negative interruption position", () => {
    expect(() => QaExchange.parse({ ...valid, interruptionPositionSeconds: -0.5 })).toThrow();
  });
});

describe("CreateExchangeRequest", () => {
  it("accepts a minimal request (sourceItemId/conversationId optional)", () => {
    expect(() =>
      CreateExchangeRequest.parse({ interruptionPositionSeconds: 0, turns: [validTurn] }),
    ).not.toThrow();
  });

  it("rejects a request with no turns", () => {
    expect(() =>
      CreateExchangeRequest.parse({ interruptionPositionSeconds: 0, turns: [] }),
    ).toThrow();
  });
});

describe("LiveSessionToken", () => {
  it("accepts a webrtc token with dynamic variables", () => {
    expect(() =>
      LiveSessionToken.parse({
        agentId: "agent_x",
        conversationToken: "tok",
        connectionType: "webrtc",
        dynamicVariables: { current_item: "break the ice" },
      }),
    ).not.toThrow();
  });

  it("rejects an unknown connectionType", () => {
    expect(() =>
      LiveSessionToken.parse({
        agentId: "agent_x",
        conversationToken: "tok",
        connectionType: "carrier-pigeon",
        dynamicVariables: {},
      }),
    ).toThrow();
  });
});
