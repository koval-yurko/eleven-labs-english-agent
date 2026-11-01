/**
 * The STT registry, the twin of `./tts-profiles.ts`: a version names a profile (`PromptVersion.stt`
 * → dispatch metadata `stt`) and the worker builds it here. Absent or unknown = Deepgram Flux, the
 * STT every version had before `words-4.5`.
 *
 * Every profile lists the secrets it needs, so a lesson whose STT key is missing fails at session
 * start with the variable's name.
 */
import type { stt } from "@livekit/agents";
import { createStt } from "./pipeline.ts";
import { VOICEBOX_STT_DEFAULTS, VoiceboxSTT } from "./voicebox-stt.ts";
import { splitOptions, type ProfileOptions } from "./profile-options.ts";

export interface SttProfile {
  label: string;
  /** Env vars that must all be set. */
  secrets: readonly string[];
  /** The learner options (`stt.<key>`) this profile reads; none today. Same rule as `TtsProfile.accepts`. */
  accepts: readonly string[];
  /** `options` holds only keys from `accepts`. */
  create(options?: ProfileOptions): stt.STT;
}

export const DEFAULT_STT_PROFILE = "deepgram";

const env = (name: string): string | undefined => process.env[name] || undefined;

/** The STT worker of Voicebox YK on this Mac; the main server (17593) refuses `/stt/ws` while it has workers. */
export const DEFAULT_VOICEBOX_STT_URL = "http://127.0.0.1:17495";

/**
 * Voicebox's `/stt/ws`, one profile per model so a version names the exact model it ran with. The
 * model must be downloaded in Voicebox; a missing one fails at session start with the server's reason.
 * The language is detected per segment unless VOICEBOX_STT_LANGUAGE pins it: learners answer in
 * Russian too.
 *
 * - `voicebox-<model>`: this Mac's STT worker (VOICEBOX_LOCAL_STT_URL, default 127.0.0.1:17495), no
 *   key, so only the Mac worker serves these (`words-4.5`).
 * - `voicebox-remote-<model>`: the tunnel to the same STT worker (VOICEBOX_STT_URL) with
 *   VOICEBOX_API_KEY, for the LiveKit Cloud worker. Both secrets are required; a missing one fails at
 *   session start with its name.
 */
function voiceboxStt(model: string, name: string, remote = false): SttProfile {
  return {
    label: `Voicebox STT ${name} (${remote ? "tunnel" : "this Mac"}, /stt/ws)`,
    secrets: remote ? ["VOICEBOX_STT_URL", "VOICEBOX_API_KEY"] : [],
    accepts: [],
    create: () =>
      new VoiceboxSTT({
        url: (remote ? env("VOICEBOX_STT_URL") : env("VOICEBOX_LOCAL_STT_URL")) ?? DEFAULT_VOICEBOX_STT_URL,
        apiKey: remote ? env("VOICEBOX_API_KEY") : undefined,
        model,
        language: env("VOICEBOX_STT_LANGUAGE"),
        interim: VOICEBOX_STT_DEFAULTS.interim,
        interimIntervalMs: VOICEBOX_STT_DEFAULTS.interimIntervalMs,
        maxSegmentS: VOICEBOX_STT_DEFAULTS.maxSegmentS,
      }),
  };
}

const VOICEBOX_STT_MODELS: readonly [id: string, model: string, name: string][] = [
  ["qwen-asr-0.6b", "qwen-asr-0.6B", "Qwen3-ASR 0.6B"],
  ["qwen-asr-1.7b", "qwen-asr-1.7B", "Qwen3-ASR 1.7B"],
  ["whisper-turbo", "whisper-turbo", "Whisper large-v3 turbo"],
  ["whisper-base", "whisper-base", "Whisper base"],
];

export const STT_PROFILES: Record<string, SttProfile> = {
  deepgram: {
    label: "Deepgram Flux",
    secrets: ["DEEPGRAM_API_KEY"],
    accepts: [],
    create: () => createStt(),
  },
  ...Object.fromEntries(VOICEBOX_STT_MODELS.map(([id, model, name]) => [`voicebox-${id}`, voiceboxStt(model, name)])),
  ...Object.fromEntries(VOICEBOX_STT_MODELS.map(([id, model, name]) => [`voicebox-remote-${id}`, voiceboxStt(model, name, true)])),
};

export function missingSttSecrets(profile: SttProfile): string[] {
  return profile.secrets.filter((name) => !process.env[name]);
}

/** A dispatch's `stt` → a profile id: unknown or absent falls back to the default, and says so. */
export function resolveSttProfile(id: string | undefined): { id: string; profile: SttProfile; fellBack: boolean } {
  if (id && STT_PROFILES[id]) return { id, profile: STT_PROFILES[id]!, fellBack: false };
  return { id: DEFAULT_STT_PROFILE, profile: STT_PROFILES[DEFAULT_STT_PROFILE]!, fellBack: id !== undefined };
}

/** `options` are the learner's `stt.*` values; the profile gets only the keys it `accepts`. */
export function createSttFor(id: string | undefined, options: ProfileOptions = {}): stt.STT {
  const { id: resolved, profile } = resolveSttProfile(id);
  const missing = missingSttSecrets(profile);
  if (missing.length > 0) {
    throw new Error(`STT profile "${resolved}" (${profile.label}) needs ${missing.join(", ")} — set it as a worker secret.`);
  }
  const { accepted, ignored } = splitOptions(profile.accepts, options);
  if (ignored.length > 0) console.log(`[worker] STT profile "${resolved}" ignores options: ${ignored.join(", ")}`);
  return profile.create(accepted);
}
