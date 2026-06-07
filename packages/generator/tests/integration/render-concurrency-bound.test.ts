import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { describe, expect, it } from "vitest";
import {
  classifyInput,
  ElevenLabsTtsAdapter,
  MockLlmAdapter,
  type ElevenLabsOptions,
  type LessonScript,
} from "../../src/index";

/**
 * T010 (US2, 004-tts-parallel-render) — the configured bound is never exceeded (FR-002,
 * so no 429s) and any batch failure fails the whole render with no partial audio (FR-007).
 */

type ConvertArgs = { inputs: { text: string; voiceId: string }[]; modelId: string };

function fakeClient(convert: (args: ConvertArgs) => Promise<Uint8Array>): ElevenLabsClient {
  return { textToDialogue: { convert } } as unknown as ElevenLabsClient;
}

function options(batchConcurrency: number): ElevenLabsOptions {
  return {
    modelId: "eleven_v3",
    bitrate: 128000,
    teacherVoiceId: "voice-teacher",
    learnerVoiceId: "voice-learner",
    batchConcurrency,
  };
}

async function tick(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

async function manyBatchScript(): Promise<LessonScript> {
  const { accepted } = classifyInput([
    "break the ice",
    "spill the beans",
    "under the weather",
    "piece of cake",
    "hit the sack",
    "cost an arm and a leg",
  ]);
  return new MockLlmAdapter().draftScript({
    acceptedItems: accepted,
    teacherVoiceId: "voice-teacher",
    learnerVoiceId: "voice-learner",
    targetMinSeconds: 300,
    targetMaxSeconds: 600,
    wordsPerMinute: 150,
  });
}

describe("render concurrency bound", () => {
  it("never exceeds the configured in-flight bound for N > K batches", async () => {
    const K = 2;
    let inFlight = 0;
    let peak = 0;
    const convert = async ({ inputs }: ConvertArgs): Promise<Uint8Array> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick(4);
      inFlight--;
      return new TextEncoder().encode(inputs.map((i) => i.text).join("|"));
    };

    const script = await manyBatchScript();
    const adapter = new ElevenLabsTtsAdapter("k", options(K), fakeClient(convert));
    await adapter.renderDialogue(script, 60); // tiny limit → N > K batches

    expect(peak).toBeLessThanOrEqual(K);
    expect(peak).toBe(K); // and it does saturate the pool
  });

  it("rejects the whole render and returns no audio when a batch fails", async () => {
    let calls = 0;
    const convert = async ({ inputs }: ConvertArgs): Promise<Uint8Array> => {
      calls++;
      if (calls === 2) throw new Error("ElevenLabs 500");
      await tick(2);
      return new TextEncoder().encode(inputs.map((i) => i.text).join("|"));
    };

    const script = await manyBatchScript();
    const adapter = new ElevenLabsTtsAdapter("k", options(2), fakeClient(convert));

    await expect(adapter.renderDialogue(script, 60)).rejects.toThrow("ElevenLabs 500");
  });
});
