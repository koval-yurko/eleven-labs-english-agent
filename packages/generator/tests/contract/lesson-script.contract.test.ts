import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LessonScript } from "@idiomatic/contracts";
import { MockLlmAdapter } from "../../src/index.js";
import type { ClassifiedItem } from "../../src/index.js";

/**
 * T016 — Contract test: a generated LessonScript conforms to the shared schema, and
 * the Zod schema stays aligned with contracts/lesson-script.schema.json (the boundary
 * artifact both subsystems depend on).
 */

const SCHEMA_URL = new URL(
  "../../../../specs/002-lesson-generation/contracts/lesson-script.schema.json",
  import.meta.url,
);

const items: ClassifiedItem[] = [
  {
    id: "item-0",
    rawText: "break the ice",
    normalizedText: "break the ice",
    itemType: "idiom",
    teachable: true,
    skipReason: null,
    orderIndex: 0,
  },
];

describe("LessonScript contract", () => {
  it("a mock-generated script parses against the Zod LessonScript schema", async () => {
    const draft = await new MockLlmAdapter().draftScript({
      acceptedItems: items,
      teacherVoiceId: "voice-teacher",
      learnerVoiceId: "voice-learner",
      targetMinSeconds: 300,
      targetMaxSeconds: 600,
      wordsPerMinute: 150,
    });
    expect(() => LessonScript.parse(draft)).not.toThrow();
  });

  it("the JSON Schema and Zod schema agree on required top-level keys", () => {
    const jsonSchema = JSON.parse(readFileSync(SCHEMA_URL, "utf8")) as {
      required: string[];
    };
    const zodKeys = Object.keys(LessonScript.shape).sort();
    expect(jsonSchema.required.sort()).toEqual(zodKeys);
  });
});
