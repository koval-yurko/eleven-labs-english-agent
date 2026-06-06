import { describe, expect, it } from "vitest";
import {
  scoreCoverage,
  scoreLength,
  scoreStoryNotDefinition,
  scoreTwoVoice,
} from "../../src/evals/scorers";
import { EVAL_DATASET } from "../../src/evals/dataset";
import { evaluateSuite, MOCK_GATING } from "../../src/evals/harness";
import { MockLlmAdapter, MockTtsAdapter } from "../../src/adapters/mock";
import { loadGeneratorConfig } from "../../src/config";
import type { LessonScript } from "@idiomatic/contracts";

/**
 * T051 — generation eval scorers. The deterministic scorers (coverage, two-voice,
 * story-not-definition) must pass on the mock generator across the whole dataset; the
 * length scorer is exercised directly since mock audio is intentionally short.
 */

const config = loadGeneratorConfig({
  ELEVENLABS_TEACHER_VOICE_ID: "teacher-voice",
  ELEVENLABS_LEARNER_VOICE_ID: "learner-voice",
});

const deps = {
  llm: new MockLlmAdapter(),
  tts: new MockTtsAdapter(config.wordsPerMinute),
  config,
};

describe("generation eval — gating scorers on mock generator", () => {
  it("every dataset case passes coverage, two-voice, and story-not-definition", async () => {
    const evaluations = await evaluateSuite(EVAL_DATASET, deps, {
      lengthWindow: { minSeconds: config.targetMinSeconds, maxSeconds: config.targetMaxSeconds },
      gatingKeys: MOCK_GATING,
    });

    expect(evaluations).toHaveLength(EVAL_DATASET.length);
    for (const ev of evaluations) {
      expect(ev.error).toBeUndefined();
      expect(ev.pass, `${ev.case.id}: ${JSON.stringify(ev.scores)}`).toBe(true);
      const byKey = new Map(ev.scores.map((s) => [s.key, s]));
      expect(byKey.get("coverage")!.pass).toBe(true);
      expect(byKey.get("two_voice")!.pass).toBe(true);
      expect(byKey.get("story_not_definition")!.pass).toBe(true);
    }
  });
});

describe("generation eval — scorer unit behavior", () => {
  function baseScript(overrides: Partial<LessonScript> = {}): LessonScript {
    return {
      version: "1.0",
      speakers: {
        learner: { role: "learner", voiceId: "v-learner", displayName: "Learner" },
        teacher: { role: "teacher", voiceId: "v-teacher", displayName: "Teacher" },
      },
      segments: [
        { id: "s1", speaker: "teacher", text: "Picture a frozen lake at dawn." },
        { id: "s2", speaker: "learner", text: "Oh, I can see it." },
      ],
      coverage: [{ sourceItemId: "item-0", normalizedText: "break the ice", segmentIds: ["s1"] }],
      estimatedDurationSeconds: 60,
      ...overrides,
    };
  }

  it("flags an uncovered item", () => {
    const r = scoreCoverage(["item-0", "item-1"], baseScript());
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("item-1");
  });

  it("flags shared voice IDs", () => {
    const script = baseScript({
      speakers: {
        learner: { role: "learner", voiceId: "same" },
        teacher: { role: "teacher", voiceId: "same" },
      },
    });
    expect(scoreTwoVoice(script).pass).toBe(false);
  });

  it("flags dictionary-definition phrasing", () => {
    const script = baseScript({
      segments: [
        { id: "s1", speaker: "teacher", text: '"break the ice" means to start a conversation.' },
        { id: "s2", speaker: "learner", text: "Got it." },
      ],
    });
    expect(scoreStoryNotDefinition(["item-0"], script).pass).toBe(false);
  });

  it("scores length inside and outside the window", () => {
    expect(scoreLength(420, { minSeconds: 300, maxSeconds: 600 }).pass).toBe(true);
    expect(scoreLength(120, { minSeconds: 300, maxSeconds: 600 }).pass).toBe(false);
    expect(scoreLength(900, { minSeconds: 300, maxSeconds: 600 }).pass).toBe(false);
  });
});
