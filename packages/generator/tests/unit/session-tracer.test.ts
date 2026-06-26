import { describe, expect, it } from "vitest";
import {
  buildSessionRunInputs,
  buildTurnChildRuns,
  type SessionTrace,
} from "../../src/observability/session-tracer";

/**
 * Tier A (008-langsmith-tracing, T012/FR-013): the self-reported session trace must report a
 * REAL start (from session open, not the upsert wall-clock), an end only when ended, a per-turn
 * child run, and filterable metadata. Tested via the pure run-payload builders.
 */

const CREATED = "2026-06-25T12:00:00.000Z";
const END_MS = Date.parse("2026-06-25T12:05:00.000Z");

function trace(overrides: Partial<SessionTrace> = {}): SessionTrace {
  return {
    sessionId: "11111111-1111-1111-1111-111111111111",
    lessonId: "lesson-1",
    ownerId: "owner-1",
    scenario: "space travel",
    status: "ended",
    createdAt: CREATED,
    turns: [
      { role: "teacher", kind: "narration", text: "Once upon a time…", turnIndex: 0 },
      { role: "learner", kind: "question", text: "what does X mean?", turnIndex: 1 },
      { role: "teacher", kind: "answer", text: "X means…", turnIndex: 2 },
    ],
    isNew: true,
    ended: true,
    ...overrides,
  };
}

describe("buildSessionRunInputs (Tier A parent run)", () => {
  it("starts from createdAt, not the upsert wall-clock", () => {
    const run = buildSessionRunInputs(trace(), "proj", END_MS);
    expect(run.start_time).toBe(Date.parse(CREATED));
  });

  it("sets end_time only when the session has ended", () => {
    expect(buildSessionRunInputs(trace({ ended: true }), "proj", END_MS).end_time).toBe(END_MS);
    expect(buildSessionRunInputs(trace({ ended: false }), "proj", END_MS).end_time).toBeUndefined();
  });

  it("carries filterable metadata: thread_id, status, turnCount, scenario, termination_reason", () => {
    const run = buildSessionRunInputs(
      trace({ terminationReason: "abandoned" }),
      "proj",
      END_MS,
    );
    const meta = (run.extra as { metadata: Record<string, unknown> }).metadata;
    expect(meta.thread_id).toBe("lesson-1");
    expect(meta.status).toBe("ended");
    expect(meta.turnCount).toBe(3);
    expect(meta.scenario).toBe("space travel");
    expect(meta.termination_reason).toBe("abandoned");
  });
});

describe("buildTurnChildRuns (Tier A per-turn hierarchy)", () => {
  it("emits one child run per turn, parented + traced to the session", () => {
    const children = buildTurnChildRuns(trace(), "proj");
    expect(children).toHaveLength(3);
    for (const c of children) {
      expect(c.parent_run_id).toBe("11111111-1111-1111-1111-111111111111");
      expect(c.trace_id).toBe("11111111-1111-1111-1111-111111111111");
    }
    // Deterministic, distinct child ids (stable across re-finalization, no duplicates).
    const ids = children.map((c) => c.id);
    expect(new Set(ids).size).toBe(3);
    // Same trace built twice yields the same ids.
    expect(buildTurnChildRuns(trace(), "proj").map((c) => c.id)).toEqual(ids);
  });

  it("labels teacher turns as llm runs and learner turns as chain runs", () => {
    const children = buildTurnChildRuns(trace(), "proj");
    expect(children[0].run_type).toBe("llm"); // teacher
    expect(children[1].run_type).toBe("chain"); // learner
  });
});
