import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import type { LessonScript } from "@idiomatic/contracts";
import type { ProviderHealth, RenderedAudio, TtsAdapter } from "./types";

/**
 * ElevenLabs Text to Dialogue renderer (T024, research R5). Maps each segment to a
 * dialogue input voiced by the learner/teacher voice, batches inputs under the
 * per-request char limit, renders each batch, and stitches the MP3 bytes in order.
 * Duration is computed from the CBR MP3 bitrate (SC-003).
 */

export interface ElevenLabsOptions {
  modelId: string;
  /** CBR MP3 bitrate in bps (ElevenLabs default output is mp3_44100_128 → 128000). */
  bitrate: number;
  /** Configured voices, validated by the preflight health check. */
  teacherVoiceId: string;
  learnerVoiceId: string;
}

const ELEVENLABS_API = "https://api.elevenlabs.io";

interface DialogueInput {
  text: string;
  voiceId: string;
}

export class ElevenLabsTtsAdapter implements TtsAdapter {
  private readonly client: ElevenLabsClient;

  constructor(
    private readonly apiKey: string,
    private readonly options: ElevenLabsOptions,
  ) {
    this.client = new ElevenLabsClient({ apiKey });
  }

  async healthCheck(): Promise<ProviderHealth> {
    const voiceIds = Array.from(
      new Set([this.options.teacherVoiceId, this.options.learnerVoiceId]),
    );
    try {
      for (const voiceId of voiceIds) {
        const res = await fetch(`${ELEVENLABS_API}/v1/voices/${voiceId}`, {
          headers: { "xi-api-key": this.apiKey },
        });
        if (res.status === 401) {
          return { provider: "elevenlabs", ok: false, detail: "invalid API key" };
        }
        if (!res.ok) {
          return {
            provider: "elevenlabs",
            ok: false,
            detail: `voice ${voiceId} not found (HTTP ${res.status})`,
          };
        }
      }
      return { provider: "elevenlabs", ok: true, detail: `${voiceIds.length} voice(s) reachable` };
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      return { provider: "elevenlabs", ok: false, detail: message };
    }
  }

  async renderDialogue(script: LessonScript, ttsCharLimit: number): Promise<RenderedAudio> {
    const voiceFor = (speaker: "learner" | "teacher"): string =>
      speaker === "teacher" ? script.speakers.teacher.voiceId : script.speakers.learner.voiceId;

    const inputs: DialogueInput[] = script.segments.map((s) => ({
      text: s.audioTags && s.audioTags.length > 0 ? `[${s.audioTags.join(", ")}] ${s.text}` : s.text,
      voiceId: voiceFor(s.speaker),
    }));

    const batches = batchUnderLimit(inputs, ttsCharLimit);
    const chunks: Uint8Array[] = [];
    for (const batch of batches) {
      const audio = await this.client.textToDialogue.convert({
        inputs: batch,
        modelId: this.options.modelId,
      });
      chunks.push(await collectBytes(audio));
    }

    const bytes = concatBytes(chunks);
    const durationSeconds = Math.max(1, Math.round((bytes.byteLength * 8) / this.options.bitrate));
    return { bytes, mimeType: "audio/mpeg", durationSeconds };
  }
}

/** Group inputs so each batch's combined text stays under the char limit (research R5). */
function batchUnderLimit(inputs: DialogueInput[], limit: number): DialogueInput[][] {
  const batches: DialogueInput[][] = [];
  let current: DialogueInput[] = [];
  let size = 0;
  for (const input of inputs) {
    const len = input.text.length;
    if (current.length > 0 && size + len > limit) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(input);
    size += len;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Read a web/Node stream (or buffer) of audio into a single Uint8Array. */
async function collectBytes(
  audio: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | Uint8Array,
): Promise<Uint8Array> {
  if (audio instanceof Uint8Array) return audio;

  const parts: Uint8Array[] = [];
  // Web ReadableStream
  if (typeof (audio as ReadableStream<Uint8Array>).getReader === "function") {
    const reader = (audio as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) parts.push(value);
    }
    return concatBytes(parts);
  }
  // Async iterable (Node Readable)
  for await (const chunk of audio as AsyncIterable<Uint8Array>) {
    parts.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
  }
  return concatBytes(parts);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}
