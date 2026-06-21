/**
 * Server-side configuration for the adaptive live story (006-adaptive-live-story).
 *
 * Surfaces the new `ELEVENLABS_STORY_AGENT_ID` (the dedicated narrator agent, research
 * R10) alongside the reused ElevenLabs key and the target-length clamp window
 * (`TARGET_MIN_SECONDS`/`TARGET_MAX_SECONDS`, R8) the plan derivation uses. This module is
 * SERVER-ONLY — the api key is read here but NEVER returned to the browser (Constitution V);
 * only a short-lived conversation token ever reaches the client.
 *
 * Defaults mirror the generator's (`lib/generation/deps.ts`) so the live-story target
 * window matches the scripted lesson's, keeping "bounded target length" one tuning knob.
 *
 * The `LiveStoryConfig` shape lives in `@idiomatic/live-story`; this module is the env
 * reader that produces it (the package never touches `process.env`).
 */
import type { LiveStoryConfig } from "@idiomatic/live-story";

export type { LiveStoryConfig };

const DEFAULT_TARGET_MIN_SECONDS = 300;
const DEFAULT_TARGET_MAX_SECONDS = 600;

function intEnv(value: string | undefined, fallback: number): number {
  const n = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isNaN(n) ? fallback : n;
}

export function liveStoryConfig(env: NodeJS.ProcessEnv = process.env): LiveStoryConfig {
  return {
    apiKey: env.ELEVENLABS_API_KEY?.trim() || undefined,
    agentId: env.ELEVENLABS_STORY_AGENT_ID?.trim() || undefined,
    targetMinSeconds: intEnv(env.TARGET_MIN_SECONDS, DEFAULT_TARGET_MIN_SECONDS),
    targetMaxSeconds: intEnv(env.TARGET_MAX_SECONDS, DEFAULT_TARGET_MAX_SECONDS),
  };
}
