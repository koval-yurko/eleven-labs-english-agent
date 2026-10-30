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
import { DEFAULT_VOICEBOX_URL } from "./tts-profiles.ts";
import { VOICEBOX_STT_DEFAULTS, VoiceboxSTT } from "./voicebox-stt.ts";

export interface SttProfile {
  label: string;
  /** Env vars that must all be set. */
  secrets: readonly string[];
  create(): stt.STT;
}

export const DEFAULT_STT_PROFILE = "deepgram";

const env = (name: string): string | undefined => process.env[name] || undefined;

/**
 * Voicebox's `/stt/ws` on this Mac, one profile per model so a version names the exact model it ran
 * with. The model must be downloaded in Voicebox; a missing one fails at session start with the
 * server's reason. Always VOICEBOX_LOCAL_URL (default 127.0.0.1), never the tunnel: its key gate does
 * not let `/stt/*` through, so only the Mac worker can serve these. The language is detected per
 * segment unless VOICEBOX_STT_LANGUAGE pins it: learners answer in Russian too.
 */
function voiceboxStt(model: string, name: string): SttProfile {
  return {
    label: `Voicebox STT ${name} (this Mac, /stt/ws)`,
    secrets: [],
    create: () =>
      new VoiceboxSTT({
        url: env("VOICEBOX_LOCAL_URL") ?? DEFAULT_VOICEBOX_URL,
        model,
        language: env("VOICEBOX_STT_LANGUAGE"),
        interim: VOICEBOX_STT_DEFAULTS.interim,
        interimIntervalMs: VOICEBOX_STT_DEFAULTS.interimIntervalMs,
        maxSegmentS: VOICEBOX_STT_DEFAULTS.maxSegmentS,
      }),
  };
}

export const STT_PROFILES: Record<string, SttProfile> = {
  deepgram: {
    label: "Deepgram Flux",
    secrets: ["DEEPGRAM_API_KEY"],
    create: () => createStt(),
  },
  "voicebox-qwen-asr-0.6b": voiceboxStt("qwen-asr-0.6B", "Qwen3-ASR 0.6B"),
  "voicebox-qwen-asr-1.7b": voiceboxStt("qwen-asr-1.7B", "Qwen3-ASR 1.7B"),
  "voicebox-whisper-turbo": voiceboxStt("whisper-turbo", "Whisper large-v3 turbo"),
  "voicebox-whisper-base": voiceboxStt("whisper-base", "Whisper base"),
};

export function missingSttSecrets(profile: SttProfile): string[] {
  return profile.secrets.filter((name) => !process.env[name]);
}

/** A dispatch's `stt` → a profile id: unknown or absent falls back to the default, and says so. */
export function resolveSttProfile(id: string | undefined): { id: string; profile: SttProfile; fellBack: boolean } {
  if (id && STT_PROFILES[id]) return { id, profile: STT_PROFILES[id]!, fellBack: false };
  return { id: DEFAULT_STT_PROFILE, profile: STT_PROFILES[DEFAULT_STT_PROFILE]!, fellBack: id !== undefined };
}

export function createSttFor(id: string | undefined): stt.STT {
  const { id: resolved, profile } = resolveSttProfile(id);
  const missing = missingSttSecrets(profile);
  if (missing.length > 0) {
    throw new Error(`STT profile "${resolved}" (${profile.label}) needs ${missing.join(", ")} — set it as a worker secret.`);
  }
  return profile.create();
}
