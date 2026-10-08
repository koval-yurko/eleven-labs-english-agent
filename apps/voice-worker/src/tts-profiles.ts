/**
 * The TTS registry: one entry per voice stage the worker can speak with. A version names a profile
 * (`PromptVersion.tts` → dispatch metadata `tts`); the worker builds it here. Testing a new TTS is
 * then: add an entry (and an adapter if LiveKit has no plugin for it), add a `words-4.N` module that
 * names it, put its key in `.env.example`. Nothing else in the worker changes.
 *
 * Every profile lists the secrets it needs, so a lesson on a profile whose key is missing fails at
 * session start with the variable's name — not as a silent lesson (docs/2026-10-02-livekit-silent-tts-on-spent-quota.md).
 * Model, voice and region are env overrides with in-code defaults, like `DEEPGRAM_TTS_MODEL`.
 */
import type { tts } from "@livekit/agents";
import * as deepgram from "@livekit/agents-plugin-deepgram";
import { QwenTTS } from "./qwen-tts.ts";

export interface TtsProfile {
  label: string;
  /** Env vars that must all be set. */
  secrets: readonly string[];
  create(): tts.TTS;
}

export const DEFAULT_TTS_PROFILE = "deepgram";
export const DEFAULT_TTS_MODEL = "aura-2-asteria-en";

const env = (name: string): string | undefined => process.env[name] || undefined;

export const TTS_PROFILES: Record<string, TtsProfile> = {
  deepgram: {
    label: "Deepgram Aura-2",
    secrets: ["DEEPGRAM_API_KEY"],
    // The plugin captures the key at import; passing it keeps a Cloud-secret key working.
    create: () =>
      new deepgram.TTS({ model: env("DEEPGRAM_TTS_MODEL") ?? DEFAULT_TTS_MODEL, apiKey: process.env.DEEPGRAM_API_KEY }),
  },
  qwen: {
    label: "Alibaba Qwen-Audio 3.0 TTS Plus",
    secrets: ["DASHSCOPE_API_KEY", "QWEN_WORKSPACE_ID"],
    create: () =>
      new QwenTTS({
        apiKey: process.env.DASHSCOPE_API_KEY ?? "",
        workspaceId: process.env.QWEN_WORKSPACE_ID ?? "",
        region: env("QWEN_REGION") ?? "ap-southeast-1",
        // Probed 2026-10-08 (research doc §2.2): `qwen-audio-3.1-tts-plus` does not exist ("Model not
        // exist"); 3.1 flash/next exist but this account gets AccessDenied. 3.0 Plus works, and only
        // with a voice it supports — `longanlingxi` fails on it with engine error 411.
        model: env("QWEN_TTS_MODEL") ?? "qwen-audio-3.0-tts-plus",
        voice: env("QWEN_TTS_VOICE") ?? "longanhuan_v3.6",
        language: env("QWEN_TTS_LANGUAGE") ?? "en",
      }),
  },
};

export function missingSecrets(profile: TtsProfile): string[] {
  return profile.secrets.filter((name) => !process.env[name]);
}

/** A dispatch's `tts` → a profile id: unknown or absent falls back to the default, and says so. */
export function resolveTtsProfile(id: string | undefined): { id: string; profile: TtsProfile; fellBack: boolean } {
  if (id && TTS_PROFILES[id]) return { id, profile: TTS_PROFILES[id]!, fellBack: false };
  return { id: DEFAULT_TTS_PROFILE, profile: TTS_PROFILES[DEFAULT_TTS_PROFILE]!, fellBack: id !== undefined };
}

export function createTtsFor(id: string | undefined): tts.TTS {
  const { id: resolved, profile } = resolveTtsProfile(id);
  const missing = missingSecrets(profile);
  if (missing.length > 0) {
    throw new Error(`TTS profile "${resolved}" (${profile.label}) needs ${missing.join(", ")} — set it as a worker secret.`);
  }
  return profile.create();
}
