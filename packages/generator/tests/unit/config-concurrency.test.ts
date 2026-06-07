import { describe, expect, it } from "vitest";
import {
  DEFAULT_TTS_BATCH_CONCURRENCY,
  loadGeneratorConfig,
  parseBatchConcurrency,
} from "../../src/index";

/**
 * T009 (US2, 004-tts-parallel-render) — `TTS_BATCH_CONCURRENCY` sanitizes to a safe default
 * on absent/invalid input (FR-003) and clamps to a usable value; valid values pass through.
 */

describe("parseBatchConcurrency", () => {
  it("falls back to the default when unset or blank", () => {
    expect(parseBatchConcurrency(undefined)).toBe(DEFAULT_TTS_BATCH_CONCURRENCY);
    expect(parseBatchConcurrency("")).toBe(DEFAULT_TTS_BATCH_CONCURRENCY);
    expect(parseBatchConcurrency("   ")).toBe(DEFAULT_TTS_BATCH_CONCURRENCY);
  });

  it("falls back to the default on non-integer or sub-1 values", () => {
    expect(parseBatchConcurrency("abc")).toBe(DEFAULT_TTS_BATCH_CONCURRENCY);
    expect(parseBatchConcurrency("0")).toBe(DEFAULT_TTS_BATCH_CONCURRENCY);
    expect(parseBatchConcurrency("-2")).toBe(DEFAULT_TTS_BATCH_CONCURRENCY);
  });

  it("accepts valid positive integers (parseInt semantics)", () => {
    expect(parseBatchConcurrency("1")).toBe(1);
    expect(parseBatchConcurrency("2")).toBe(2);
    expect(parseBatchConcurrency("5")).toBe(5);
    expect(parseBatchConcurrency("2.7")).toBe(2);
  });

  it("always returns a value >= 1", () => {
    for (const raw of [undefined, "", "abc", "0", "-9", "3"]) {
      expect(parseBatchConcurrency(raw)).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("loadGeneratorConfig — ttsBatchConcurrency", () => {
  const baseEnv = {
    ELEVENLABS_TEACHER_VOICE_ID: "voice-teacher",
    ELEVENLABS_LEARNER_VOICE_ID: "voice-learner",
  };

  it("defaults to the safe default when TTS_BATCH_CONCURRENCY is unset", () => {
    const config = loadGeneratorConfig({ ...baseEnv });
    expect(config.ttsBatchConcurrency).toBe(DEFAULT_TTS_BATCH_CONCURRENCY);
  });

  it("honors a configured value", () => {
    const config = loadGeneratorConfig({ ...baseEnv, TTS_BATCH_CONCURRENCY: "4" });
    expect(config.ttsBatchConcurrency).toBe(4);
  });

  it("sanitizes an invalid value instead of throwing", () => {
    const config = loadGeneratorConfig({ ...baseEnv, TTS_BATCH_CONCURRENCY: "nope" });
    expect(config.ttsBatchConcurrency).toBe(DEFAULT_TTS_BATCH_CONCURRENCY);
  });
});
