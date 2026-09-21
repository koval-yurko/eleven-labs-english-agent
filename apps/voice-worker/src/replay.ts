/**
 * L4's replay harness: play a corpus of real learner utterances into a room and score how the tutor
 * takes turns (research doc §4 L4, task plan Phase 4).
 *
 * **Why a corpus and not a person.** The turn plans (`turn-plans.ts`) are three sets of thresholds,
 * and the question they answer — "has the learner finished talking?" — is decided by audio: how long
 * a pause ran, whether the pitch fell. That cannot be measured from stored transcripts, because the
 * transcript is what is left AFTER something already decided where the turn ended. And it cannot be
 * measured from synthesized speech: `stt:check` learned that the hard way twice, and TTS has no
 * word-search pauses, no "ehm" and no breath — the phenomena under test. So: real recordings,
 * replayed byte-identically, so that changing a threshold produces a diff instead of an impression.
 *
 * **What a corpus is.** A directory of mono 16-bit PCM WAV files, one utterance each, trimmed so the
 * file ENDS when the speaking ends — the trailing silence is what this script adds and times, and a
 * clip with silence baked in would score itself. Aim for 30-50 covering: mid-sentence word-search
 * pauses of 1-3 s, "ehm" fillers, Russian inserts, one-word answers, and backchannels recorded while
 * the tutor talks. Default directory `.local/corpus/` — gitignored, like everything else under
 * `.local/`, and it is a recording of someone's voice, so it stays there.
 *
 * **What it scores**, per clip, against the moment the clip's audio ended:
 *   - `false cutoff` — the tutor started speaking BEFORE the learner finished. The worst failure:
 *     the learner is interrupted mid-word and has to start again.
 *   - `missed end` — the tutor took more than 2 s after the true end. Dead air.
 *   - `self-interruption` — the tutor stopped and restarted with no learner audio in between.
 *
 * Usage:
 *   pnpm --filter voice-worker replay                  # every plan, against .local/corpus
 *   TURN_PLAN=eager pnpm --filter voice-worker replay   # one plan
 *   CORPUS_DIR=.local/corpus-noisy pnpm --filter voice-worker replay
 *
 * Needs `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, and a worker running (`pnpm dev`)
 * or deployed. It mints its own token and dispatches the tutor itself, so one command is the whole
 * experiment. It spends real Anthropic, Deepgram and ElevenLabs credit — one full run of three plans
 * over 40 clips is roughly three lessons' worth.
 */
import "./env.ts";

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  ParticipantKind,
  Room,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
  type Participant,
} from "@livekit/rtc-node";
import { LIVEKIT_AGENT_NAME, type LiveKitDispatchMetadata } from "@tutor/shared/tutor/livekit-wire";
import { AccessToken, AgentDispatchClient } from "livekit-server-sdk";

import { TURN_PLANS, type TurnPlan } from "./turn-plans.ts";

/** Silence appended after each clip, long enough for the most patient plan to call the turn over. */
const TAIL_SILENCE_MS = 6_000;
/** Beyond this, a reply is "dead air" rather than a considered pause (research doc §4 L4). */
const MISSED_END_MS = 2_000;
const FRAME_MS = 10;

interface Clip {
  name: string;
  pcm: Int16Array;
  sampleRate: number;
  durationMs: number;
}

interface Score {
  clip: string;
  /** Reply latency measured from the END of the learner's audio. Negative = the tutor cut in. */
  replyMs: number | null;
  falseCutoff: boolean;
  missedEnd: boolean;
  selfInterrupted: boolean;
}

/**
 * Minimal RIFF/WAVE reader: mono 16-bit PCM only, which is what a phone recording exports and what
 * `AudioSource` takes. Anything else is rejected loudly rather than resampled quietly — a corpus
 * silently converted is a corpus that no longer matches what the learner said.
 */
function readWav(file: string): { pcm: Int16Array; sampleRate: number } {
  const buf = readFileSync(file);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${path.basename(file)}: not a RIFF/WAVE file`);
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === "data") {
      if (channels !== 1 || bits !== 16) {
        throw new Error(
          `${path.basename(file)}: need mono 16-bit PCM, got ${channels}ch/${bits}-bit. Convert it rather than letting this script guess.`,
        );
      }
      const bytes = buf.subarray(body, body + size);
      // Copy into an aligned buffer before viewing it as Int16 — a `data` chunk can start on an odd
      // offset, and a misaligned view throws.
      return { pcm: new Int16Array(Uint8Array.from(bytes).buffer), sampleRate };
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }
  throw new Error(`${path.basename(file)}: no data chunk`);
}

function loadCorpus(dir: string): Clip[] {
  const files = readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".wav"))
    .sort();
  if (files.length === 0) throw new Error(`No .wav files in ${dir}`);
  return files.map((name) => {
    const { pcm, sampleRate } = readWav(path.join(dir, name));
    return { name, pcm, sampleRate, durationMs: (pcm.length / sampleRate) * 1000 };
  });
}

/** Publish one clip in real time, then silence. Returns the wall-clock moment the speech ended. */
async function playClip(source: AudioSource, clip: Clip): Promise<number> {
  const samplesPerFrame = (clip.sampleRate * FRAME_MS) / 1000;
  for (let i = 0; i < clip.pcm.length; i += samplesPerFrame) {
    const chunk = clip.pcm.slice(i, i + samplesPerFrame);
    await source.captureFrame(new AudioFrame(chunk, clip.sampleRate, 1, chunk.length));
  }
  // `captureFrame` resolves on the buffer, not on the wire, so the real end of speech is now.
  const endedAt = Date.now();
  const silence = new Int16Array(samplesPerFrame);
  for (let ms = 0; ms < TAIL_SILENCE_MS; ms += FRAME_MS) {
    await source.captureFrame(new AudioFrame(silence, clip.sampleRate, 1, silence.length));
  }
  return endedAt;
}

async function runPlan(plan: TurnPlan, corpus: Clip[]): Promise<Score[]> {
  const url = process.env.LIVEKIT_URL!;
  const apiKey = process.env.LIVEKIT_API_KEY!;
  const apiSecret = process.env.LIVEKIT_API_SECRET!;
  const roomName = `l4-${plan}-${Date.now()}`;

  const fixture = JSON.parse(
    readFileSync(process.env.DISPATCH_METADATA_FILE ?? ".local/dispatch.json", "utf8"),
  ) as LiveKitDispatchMetadata;
  // The plan under test, and a conversation id per run so ledgers never collide.
  const metadata: LiveKitDispatchMetadata = {
    ...fixture,
    turnPlan: plan,
    conversationId: `${fixture.conversationId}-${plan}`,
  };

  const dispatch = new AgentDispatchClient(url, apiKey, apiSecret);
  await dispatch.createDispatch(roomName, LIVEKIT_AGENT_NAME, {
    metadata: JSON.stringify(metadata),
  });

  const at = new AccessToken(apiKey, apiSecret, { identity: "l4-replay", ttl: "1h" });
  at.addGrant({ room: roomName, roomJoin: true, canPublish: true, canSubscribe: true });

  const room = new Room();
  let speakingSince: number | null = null;
  let speakingStarts: number[] = [];

  room.on(RoomEvent.ParticipantAttributesChanged, (_changed, p: Participant) => {
    if (p.kind !== ParticipantKind.AGENT) return;
    const speaking = p.attributes["lk.agent.state"] === "speaking";
    if (speaking && speakingSince === null) {
      speakingSince = Date.now();
      speakingStarts.push(speakingSince);
    } else if (!speaking) {
      speakingSince = null;
    }
  });

  await room.connect(url, await at.toJwt(), { autoSubscribe: true, dynacast: false });

  const source = new AudioSource(corpus[0]!.sampleRate, 1);
  const track = LocalAudioTrack.createAudioTrack("learner", source);
  await room.localParticipant!.publishTrack(
    track,
    new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
  );

  // Let the tutor finish whatever it opens with, so the first clip is not scored against a greeting.
  await sleep(8_000);

  const scores: Score[] = [];
  for (const clip of corpus) {
    speakingStarts = [];
    const startedAt = Date.now();
    const endedAt = await playClip(source, clip);

    const reply = speakingStarts.find((t) => t > startedAt) ?? null;
    const replyMs = reply === null ? null : reply - endedAt;
    scores.push({
      clip: clip.name,
      replyMs,
      // Started while the learner was still talking. The tolerance is zero on purpose: this is the
      // failure the learner feels most, so it is not softened by a grace window.
      falseCutoff: replyMs !== null && replyMs < 0,
      missedEnd: replyMs === null || replyMs > MISSED_END_MS,
      // Two starts for one utterance: it began, stopped, and began again with nothing said between.
      selfInterrupted: speakingStarts.filter((t) => t > startedAt).length > 1,
    });
  }

  await room.disconnect();
  return scores;
}

function report(plan: TurnPlan, scores: Score[]): void {
  const n = scores.length;
  const cutoffs = scores.filter((s) => s.falseCutoff).length;
  const missed = scores.filter((s) => s.missedEnd).length;
  const selfInt = scores.filter((s) => s.selfInterrupted).length;
  const replies = scores.map((s) => s.replyMs).filter((v): v is number => v !== null && v >= 0).sort((a, b) => a - b);
  const p50 = replies.length ? replies[Math.floor(replies.length * 0.5)] : null;
  const p95 = replies.length ? replies[Math.floor(replies.length * 0.95)] : null;

  const pct = (k: number) => `${((k / n) * 100).toFixed(1)}%`;
  console.log(
    `\n${plan.padEnd(8)} ${TURN_PLANS[plan].endpointing.minDelay}-${TURN_PLANS[plan].endpointing.maxDelay}ms endpointing`,
  );
  console.log(`  clips              ${n}`);
  console.log(`  false cutoffs      ${cutoffs} (${pct(cutoffs)})   ← the gate: ≤ 5% under "patient"`);
  console.log(`  missed ends        ${missed} (${pct(missed)})`);
  console.log(`  self-interruptions ${selfInt} (${pct(selfInt)})   ← the gate: zero`);
  console.log(`  reply p50 / p95    ${p50 ?? "—"}ms / ${p95 ?? "—"}ms`);
  for (const s of scores.filter((x) => x.falseCutoff || x.selfInterrupted)) {
    console.log(
      `    ${s.clip}: ${s.replyMs}ms${s.falseCutoff ? " CUTOFF" : ""}${s.selfInterrupted ? " SELF-INT" : ""}`,
    );
  }
}

async function main(): Promise<void> {
  const missing = ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"].filter(
    (k) => !process.env[k],
  );
  if (missing.length > 0) {
    console.error(`replay: ${missing.join(", ")} not set (apps/voice-worker/.env).`);
    process.exit(1);
  }

  const dir = process.env.CORPUS_DIR ?? ".local/corpus";
  const corpus = loadCorpus(dir);
  console.log(`[replay] ${corpus.length} clips from ${dir}`);

  const plans = process.env.TURN_PLAN
    ? [process.env.TURN_PLAN as TurnPlan]
    : (Object.keys(TURN_PLANS) as TurnPlan[]);

  for (const plan of plans) {
    const scores = await runPlan(plan, corpus);
    report(plan, scores);
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
