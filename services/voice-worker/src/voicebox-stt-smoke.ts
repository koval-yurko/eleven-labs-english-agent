/**
 * Live check of `VoiceboxSTT` against the real Voicebox app on this Mac (`0.6.0-custom.1` or later,
 * with the STT model downloaded): a WAV file goes in at real-time speed, 20 ms per frame, the way a
 * room delivers a learner's microphone, and every speech event is printed. The Node twin of the
 * Python plugin's `scripts/smoke_stt.py`.
 *
 *   pnpm --filter voice-worker stt:voicebox <file.wav> [--profile voicebox-qwen-asr-0.6b]
 *
 * `--profile` is a key of `STT_PROFILES` (`./stt-profiles.ts`), exactly what a version names, so the
 * run uses the same model and settings as a lesson on it. Default: `voicebox-qwen-asr-0.6b`.
 *
 * The WAV must be 16-bit PCM, any rate, mono or stereo. `say -o /tmp/s.wav --data-format=LEI16@16000 "…"`
 * makes one. Fails (exit 1) when no final transcript comes back. Uses VOICEBOX_LOCAL_URL, default
 * 127.0.0.1:17493.
 */
import "./env.ts";

import { readFileSync } from "node:fs";
import process from "node:process";
import { parseArgs } from "node:util";
import { initializeLogger, stt } from "@livekit/agents";
import { AudioFrame } from "@livekit/rtc-node";

import { createSttFor, STT_PROFILES } from "./stt-profiles.ts";
import { VoiceboxSTT } from "./voicebox-stt.ts";

/** Enough trailing silence for the server VAD (500 ms) to close the last segment. */
const TAIL_SILENCE_MS = 1500;

function readWav(path: string): { rate: number; channels: number; samples: Int16Array } {
  const buf = readFileSync(path);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error(`${path} is not a WAV file`);
  let rate = 0;
  let channels = 0;
  for (let at = 12; at + 8 <= buf.length; ) {
    const id = buf.toString("ascii", at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === "fmt ") {
      if (buf.readUInt16LE(body) !== 1 || buf.readUInt16LE(body + 14) !== 16) throw new Error(`${path} is not 16-bit PCM`);
      channels = buf.readUInt16LE(body + 2);
      rate = buf.readUInt32LE(body + 4);
    } else if (id === "data") {
      const data = buf.subarray(body, body + size);
      return { rate, channels, samples: new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)) };
    }
    at = body + size + (size % 2);
  }
  throw new Error(`${path} has no data chunk`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { profile: { type: "string", default: "voicebox-qwen-asr-0.6b" } },
  });
  const path = positionals[0];
  const voiceboxProfiles = Object.keys(STT_PROFILES).filter((id) => id.startsWith("voicebox-"));
  if (!path || !voiceboxProfiles.includes(values.profile)) {
    console.error(`usage: pnpm --filter voice-worker stt:voicebox <file.wav> [--profile ${voiceboxProfiles.join("|")}]`);
    process.exit(1);
  }
  initializeLogger({ pretty: true, level: "warn" });

  const { rate, channels, samples } = readWav(path);
  const vb = createSttFor(values.profile) as VoiceboxSTT;
  vb.on("error", (e) => console.error(`stt error (recoverable=${e.recoverable}): ${e.error.message}`));
  const audioS = samples.length / channels / rate;
  console.log(`${path}: ${audioS.toFixed(1)}s, ${rate} Hz, ${channels} ch → ${vb.opts.url} (${values.profile}: ${vb.model})`);

  const stream = vb.stream();
  const t0 = Date.now();
  const at = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;
  const finals: string[] = [];
  const reader = (async () => {
    for await (const event of stream) {
      const alt = event.alternatives?.[0];
      const name = stt.SpeechEventType[event.type];
      const times = alt ? ` [${alt.startTime.toFixed(2)}–${alt.endTime.toFixed(2)}s]` : "";
      console.log(`${at()} ${name}${event.requestId ? ` #${event.requestId}` : ""}${times}${alt ? ` (${alt.language || "?"}) ${alt.text}` : ""}`);
      if (event.type === stt.SpeechEventType.FINAL_TRANSCRIPT && alt?.text) finals.push(alt.text);
    }
  })();

  // 20 ms frames at real-time speed, then silence so the last segment closes on the server VAD.
  const perFrame = (rate / 50) * channels;
  const silence = new Int16Array(((rate * TAIL_SILENCE_MS) / 1000) * channels);
  const all = new Int16Array(samples.length + silence.length);
  all.set(samples);
  let next = Date.now();
  for (let i = 0; i + perFrame <= all.length; i += perFrame) {
    stream.pushFrame(new AudioFrame(all.slice(i, i + perFrame), rate, channels, perFrame / channels));
    next += 20;
    await new Promise((r) => setTimeout(r, Math.max(0, next - Date.now())));
  }
  stream.endInput();
  await Promise.race([reader, new Promise((r) => setTimeout(r, 30_000))]);
  stream.close();

  if (finals.length === 0) {
    console.error("stt:voicebox: FAILED — no final transcript came back");
    process.exit(1);
  }
  console.log(`stt:voicebox: ${finals.length} final transcript(s): ${JSON.stringify(finals.join(" "))}`);
  // The resampler is a native handle that keeps the event loop alive.
  process.exit(0);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
