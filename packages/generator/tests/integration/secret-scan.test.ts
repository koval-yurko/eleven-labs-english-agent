import { describe, expect, it } from "vitest";
import {
  classifyInput,
  generateLesson,
  JsonLogger,
  MockLlmAdapter,
  MockTtsAdapter,
  type GeneratorConfig,
} from "../../src/index";

/** T032 (SC-003) — a full mocked generation run emits zero secrets across all events. */

const config: GeneratorConfig = {
  teacherVoiceId: "voice-teacher",
  learnerVoiceId: "voice-learner",
  maxTeachableItems: 20,
  targetMinSeconds: 300,
  targetMaxSeconds: 600,
  wordsPerMinute: 150,
  ttsCharLimit: 80,
  modelId: "mock-llm-1",
  ttsModelId: "eleven_v3",
  ttsBitrate: 128000,
  ttsBatchConcurrency: 3,
};

// Patterns an operator would treat as a leaked secret in the log stream.
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/,
  /\bxi-[A-Za-z0-9]{16,}\b/,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
  /\bBearer\s+[A-Za-z0-9._-]{12,}\b/i,
  /"(?:api[_-]?key|secret|password|token|authorization)"\s*:\s*"(?!\[redacted\])[^"]+"/i,
];

describe("secret scan", () => {
  it("produces no secret-shaped output even at debug level", async () => {
    const lines: string[] = [];
    const logger = new JsonLogger({
      level: "debug", // most verbose: raw text + draft bodies included
      sink: (line) => lines.push(line),
      now: () => "2026-06-06T10:00:00.000Z",
    });
    const { accepted } = classifyInput([
      "break the ice",
      "spill the beans",
      "under the weather",
    ]);

    await generateLesson(accepted, {
      llm: new MockLlmAdapter(),
      tts: new MockTtsAdapter(config.wordsPerMinute),
      config,
      logger: logger.child({ lessonId: "lesson_1", ownerId: "auth0|alice" }),
    });

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      for (const pattern of SECRET_PATTERNS) {
        expect(line, `secret pattern ${pattern} matched: ${line}`).not.toMatch(pattern);
      }
    }
  });

  it("redacts a secret value if one ever reaches a field", async () => {
    const lines: string[] = [];
    const logger = new JsonLogger({
      level: "info",
      sink: (line) => lines.push(line),
      now: () => "t",
    });
    // Simulate a careless call site leaking a key into fields.
    logger.info("generate.result", "leak attempt", { apiKey: "sk-ant-abcdefghijklmnop0123" });
    expect(lines[0]).toContain('"apiKey":"[redacted]"');
    for (const pattern of SECRET_PATTERNS) {
      expect(lines[0]).not.toMatch(pattern);
    }
  });
});
