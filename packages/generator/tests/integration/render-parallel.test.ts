import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { describe, expect, it } from "vitest";
import {
  classifyInput,
  ElevenLabsTtsAdapter,
  MockLlmAdapter,
  type ElevenLabsOptions,
  type LessonScript,
} from "../../src/index";
import { CapturingLogger } from "../helpers/capturing-logger";

/**
 * T007 (US1, 004-tts-parallel-render) — parallel batch rendering must produce audio
 * byte-equivalent to a sequential render (FR-005/FR-006), keep per-batch observability
 * (FR-010), and leave single-batch lessons unchanged (FR-012).
 */

type ConvertArgs = { inputs: { text: string; voiceId: string }[]; modelId: string };

/** A fake ElevenLabs client whose `convert` is deterministic given the batch inputs. */
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

/** Resolve after `n` microtask ticks — used to shuffle completion order without real timers. */
async function tick(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

async function multiBatchScript(): Promise<LessonScript> {
  const { accepted } = classifyInput([
    "break the ice",
    "spill the beans",
    "under the weather",
    "piece of cake",
    "hit the sack",
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

// Deterministic per-batch payload; an earlier-finishing longer batch shuffles completion order.
const convert = async ({ inputs }: ConvertArgs): Promise<Uint8Array> => {
  const text = inputs.map((i) => i.text).join("|");
  await tick(7 - (text.length % 7));
  return new TextEncoder().encode(`BATCH(${text})`);
};

describe("parallel batch rendering", () => {
  it("produces byte-identical audio whether rendered sequentially or in parallel", async () => {
    const script = await multiBatchScript();
    const charLimit = 80; // small → many batches

    const sequential = new ElevenLabsTtsAdapter("k", options(1), fakeClient(convert));
    const parallel = new ElevenLabsTtsAdapter("k", options(4), fakeClient(convert));

    const seqLog = new CapturingLogger("info");
    const parLog = new CapturingLogger("info");
    const seq = await sequential.renderDialogue(script, charLimit, seqLog);
    const par = await parallel.renderDialogue(script, charLimit, parLog);

    // Equivalence (FR-006): same stitched bytes + duration regardless of scheduling.
    expect(Buffer.from(par.bytes)).toEqual(Buffer.from(seq.bytes));
    expect(par.durationSeconds).toBe(seq.durationSeconds);
    expect(par.mimeType).toBe("audio/mpeg");

    // The scenario is only meaningful if it actually split into multiple batches.
    const parBatches = parLog.entries.filter((e) => e.event === "render.batch");
    expect(parBatches.length).toBeGreaterThan(1);
  });

  it("emits one render.batch per batch, one per batchIndex (interleaving allowed)", async () => {
    const script = await multiBatchScript();
    const log = new CapturingLogger("info");
    const adapter = new ElevenLabsTtsAdapter("k", options(4), fakeClient(convert));

    await adapter.renderDialogue(script, 80, log);

    const batches = log.entries.filter((e) => e.event === "render.batch");
    const declaredCount = batches[0]?.fields?.batchCount as number;
    expect(batches).toHaveLength(declaredCount);
    // Exactly one entry per index 0..N-1, regardless of emission order.
    const indices = batches.map((e) => e.fields?.batchIndex as number).sort((a, b) => a - b);
    expect(indices).toEqual(Array.from({ length: declaredCount }, (_, i) => i));
  });

  it("renders a single-batch lesson unchanged (one batch, one event)", async () => {
    const script = await multiBatchScript();
    const log = new CapturingLogger("info");
    const adapter = new ElevenLabsTtsAdapter("k", options(4), fakeClient(convert));

    // A large limit keeps everything in one batch.
    const result = await adapter.renderDialogue(script, 100000, log);

    const batches = log.entries.filter((e) => e.event === "render.batch");
    expect(batches).toHaveLength(1);
    expect(batches[0]?.fields?.batchIndex).toBe(0);
    expect(batches[0]?.fields?.batchCount).toBe(1);
    expect(result.bytes.byteLength).toBeGreaterThan(0);
  });
});
