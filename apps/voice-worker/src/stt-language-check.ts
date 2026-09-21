/**
 * Does Deepgram Flux transcribe a learner answering in Russian? (research doc §2 Q5; the task
 * plan's "cheap to resolve standalone" question.) Answered here with no room and no worker running.
 *
 * Each sample is a sentence a learner might say: a Russian word inside an English sentence, pure
 * Russian, and a code-switch at a clause boundary. ElevenLabs voices it, the audio is streamed
 * through the SAME `STTv2` plugin the worker uses, once per variant below, and the transcripts are
 * printed next to what was actually said.
 *
 * Three things about the setup are deliberate, because the first run of this script (2026-09-25)
 * produced two artifacts that looked like model failures and weren't:
 *
 * 1. **A Russian-native voice speaks every sample, including the English ones.** The learner is a
 *    Russian speaker, so Russian-accented English with Cyrillic inserts *is* the case under test.
 *    The first run used the English teacher voice, which pronounces Cyrillic badly — that measures
 *    the TTS, not the STT, and makes the insert harder to recognize than it is in life.
 * 2. **Every sample starts with leading silence.** Flux is a turn-based model: audio arriving in
 *    frame zero means the turn starts mid-word. The first run pushed speech immediately and lost
 *    exactly the first word of a sample, which is an artifact of the harness.
 * 3. **`multi` is also run with keyterms.** The worker knows the lesson's words before the learner
 *    says any of them (dispatch metadata), and the Flux API takes them as a bias. This measures
 *    what the worker can actually do in production, not what a cold model does.
 *
 * What to look for: on `flux-general-en` the Russian comes back as English-shaped nonsense or is
 * dropped entirely. On `flux-general-multi` it should come back in Cyrillic. If multi garbles it
 * even with keyterms, the STT choice is wrong, and that has to be settled before more is built on
 * top of it.
 *
 * Clean synthetic speech is the EASY case. A pass here does not replace Phase 4's L4 corpus of
 * real learner recordings.
 *
 * Costs a few cents (one TTS call per sample, ~2 minutes of STT). Run on demand:
 *   pnpm --filter voice-worker stt:check
 * Requires `DEEPGRAM_API_KEY` and `ELEVENLABS_API_KEY`.
 */
import "./env.ts";

import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { initializeLogger, stt } from "@livekit/agents";
import { AudioFrame } from "@livekit/rtc-node";

import { createStt } from "./pipeline.ts";

initializeLogger({ pretty: true, level: "warn" });

const SAMPLE_RATE = 16_000;
const FRAME_MS = 20;
const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_MS) / 1000;
/** Flux decides a turn has ended from silence, so each sample is followed by enough of it to end one. */
const TRAILING_SILENCE_MS = 2_000;
/** And it decides one STARTED the same way — without this the first word lands before the turn does. */
const LEADING_SILENCE_MS = 500;
/** Faster than real time, but not a single burst: Flux is a streaming model and paces its turn detection on audio time. */
const SPEEDUP = 4;

/**
 * "Vika", an ElevenLabs shared voice tagged `ru`. Russian-accented English is what the tutor hears
 * all lesson, so it is the right voice for the English samples too. `STT_CHECK_VOICE_ID` overrides.
 */
const LEARNER_VOICE_ID = "YjYZWA1JjVPJcnWmCm0r";

interface Sample {
  /** What the learner says. */
  readonly text: string;
  /**
   * What a lesson would have told the worker to expect — the words being practised and their
   * Russian translations, which is exactly what `words.details` already holds.
   */
  readonly keyterms: readonly string[];
}

const SAMPLES: readonly Sample[] = [
  { text: "I think the word is мимолётный, it means fleeting.", keyterms: ["fleeting", "мимолётный"] },
  { text: "How do you say сложный in English?", keyterms: ["complicated", "сложный"] },
  { text: "Я не знаю, как это сказать по-английски.", keyterms: [] },
  { text: "Can we skip this one? Давай следующее слово.", keyterms: [] },
];

interface Variant {
  readonly label: string;
  readonly model: string;
  /** Whether the sample's own keyterms are handed to Flux. */
  readonly keyterms: boolean;
}

const VARIANTS: readonly Variant[] = [
  { label: "flux-general-en", model: "flux-general-en", keyterms: false },
  { label: "flux-general-multi", model: "flux-general-multi", keyterms: false },
  { label: "multi + keyterms", model: "flux-general-multi", keyterms: true },
];

async function synthesize(text: string): Promise<Int16Array> {
  const voiceId = process.env.STT_CHECK_VOICE_ID || LEARNER_VOICE_ID;
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=pcm_${SAMPLE_RATE}`,
    {
      method: "POST",
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY!, "content-type": "application/json" },
      body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
    },
  );
  if (!res.ok) throw new Error(`ElevenLabs TTS ${res.status}: ${await res.text()}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  // Raw 16-bit little-endian mono PCM. Copy into an aligned buffer before viewing it as Int16.
  return new Int16Array(bytes.slice().buffer, 0, Math.floor(bytes.length / 2));
}

async function transcribe(
  variant: Variant,
  pcm: Int16Array,
  keyterms: readonly string[],
): Promise<string[]> {
  const stream = createStt(variant.model, variant.keyterms ? keyterms : []).stream();
  const finals: string[] = [];
  const reading = (async () => {
    for await (const ev of stream) {
      if (ev.type === stt.SpeechEventType.FINAL_TRANSCRIPT) {
        const alt = ev.alternatives?.[0];
        if (alt?.text) finals.push(alt.language ? `${alt.text}  [${alt.language}]` : alt.text);
      }
    }
  })();

  const lead = new Int16Array((SAMPLE_RATE * LEADING_SILENCE_MS) / 1000);
  const tail = new Int16Array((SAMPLE_RATE * TRAILING_SILENCE_MS) / 1000);
  const audio = new Int16Array(lead.length + pcm.length + tail.length);
  audio.set(pcm, lead.length);
  for (let i = 0; i < audio.length; i += SAMPLES_PER_FRAME) {
    const chunk = audio.slice(i, i + SAMPLES_PER_FRAME);
    stream.pushFrame(new AudioFrame(chunk, SAMPLE_RATE, 1, chunk.length));
    await sleep(FRAME_MS / SPEEDUP);
  }
  stream.endInput();
  await Promise.race([reading, sleep(10_000)]);
  stream.close();
  return finals;
}

async function main(): Promise<void> {
  const missing = ["DEEPGRAM_API_KEY", "ELEVENLABS_API_KEY"].filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`stt:check: ${missing.join(" and ")} not set (apps/voice-worker/.env). This makes billed calls, so it refuses rather than skip.`);
    process.exit(1);
  }

  for (const sample of SAMPLES) {
    const pcm = await synthesize(sample.text);
    console.log(`\nsaid:               ${sample.text}`);
    for (const variant of VARIANTS) {
      // A variant that would bias on nothing says so, rather than printing a duplicate run.
      if (variant.keyterms && sample.keyterms.length === 0) {
        console.log(`${variant.label.padEnd(20)}(skipped — the lesson knows no terms for this one)`);
        continue;
      }
      const finals = await transcribe(variant, pcm, sample.keyterms);
      console.log(`${variant.label.padEnd(20)}${finals.length ? finals.join(" | ") : "(nothing)"}`);
    }
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
