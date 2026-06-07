import { describe, expect, it } from "vitest";
import type { CoverageEntry, LessonScript, LessonSegment } from "@idiomatic/contracts";
import { LESSON_SCRIPT_VERSION } from "@idiomatic/contracts";
import {
  classifyInput,
  generateLesson,
  MockTtsAdapter,
  type GeneratorConfig,
  type LlmAdapter,
  type ScriptDraftRequest,
} from "../../src/index";
import { CapturingLogger } from "../helpers/capturing-logger";

/** T027 (US3) — generate.coverage reports uncovered ids and that a re-prompt occurred. */

const config: GeneratorConfig = {
  teacherVoiceId: "voice-teacher",
  learnerVoiceId: "voice-learner",
  maxTeachableItems: 20,
  targetMinSeconds: 300,
  targetMaxSeconds: 600,
  wordsPerMinute: 150,
  ttsCharLimit: 3000,
  modelId: "mock-llm-1",
  ttsModelId: "eleven_v3",
  ttsBitrate: 128000,
  ttsBatchConcurrency: 3,
};

/** Misses coverage for the last item on the first draft, then covers everything on retry. */
class FlakyCoverageLlmAdapter implements LlmAdapter {
  readonly modelId = "mock-llm-1";
  readonly promptVersion = "mock-prompt-1";
  private calls = 0;

  async draftScript(request: ScriptDraftRequest): Promise<LessonScript> {
    this.calls += 1;
    const dropLast = this.calls === 1;
    const segments: LessonSegment[] = [];
    const coverage: CoverageEntry[] = [];

    request.acceptedItems.forEach((item, idx) => {
      const segId = `seg-${idx}-teacher`;
      segments.push({
        id: segId,
        speaker: "teacher",
        text: `Here is "${item.normalizedText}" in a little story that lands.`,
        audioTags: ["warm"],
      });
      const isLast = idx === request.acceptedItems.length - 1;
      if (!(dropLast && isLast)) {
        coverage.push({
          sourceItemId: item.id,
          normalizedText: item.normalizedText,
          segmentIds: [segId],
        });
      }
    });

    return {
      version: LESSON_SCRIPT_VERSION,
      speakers: {
        learner: { role: "learner", voiceId: request.learnerVoiceId, displayName: "Learner" },
        teacher: { role: "teacher", voiceId: request.teacherVoiceId, displayName: "Teacher" },
      },
      segments,
      coverage,
      estimatedDurationSeconds: 60,
    };
  }
}

describe("coverage logging", () => {
  it("records the uncovered ids on a missed draft and a reprompted retry", async () => {
    const root = new CapturingLogger("info");
    const { accepted } = classifyInput(["break the ice", "spill the beans", "under the weather"]);

    await generateLesson(accepted, {
      llm: new FlakyCoverageLlmAdapter(),
      tts: new MockTtsAdapter(config.wordsPerMinute),
      config,
      logger: root.child({ lessonId: "lesson_1" }),
    });

    const coverage = root.entries.filter((e) => e.event === "generate.coverage");
    expect(coverage).toHaveLength(2);

    // First attempt missed coverage and was not yet a re-prompt.
    expect(coverage[0]?.fields?.ok).toBe(false);
    expect(coverage[0]?.fields?.reprompted).toBe(false);
    expect(coverage[0]?.fields?.uncovered).toEqual([accepted[accepted.length - 1]!.id]);

    // Second attempt covered everything and was the re-prompt.
    expect(coverage[1]?.fields?.ok).toBe(true);
    expect(coverage[1]?.fields?.reprompted).toBe(true);
  });
});
