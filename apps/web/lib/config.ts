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

const DEFAULT_LANGSMITH_ENDPOINT = "https://api.smith.langchain.com";
const DEFAULT_LANGSMITH_PROJECT = "idiomatic-generation";
const DEFAULT_SWEEP_IDLE_MINUTES = 10;
const DEFAULT_SWEEP_BATCH_LIMIT = 100;

/**
 * Server-side config for live-story session tracing (008-langsmith-tracing). All values are
 * SERVER-ONLY (Constitution V): the ElevenLabs webhook HMAC secret, the cron/sweep secret,
 * and the LangSmith OTLP sink coordinates. Everything degrades to a no-op when unset — the
 * forwarder skips (no `LANGSMITH_API_KEY`) and the webhook/sweep routes reject unsigned calls.
 */
export interface LiveStoryTracingConfig {
  /** ElevenLabs post-call webhook HMAC secret; webhook rejects all posts when unset. */
  webhookSecret?: string;
  /** Shared secret the scheduled sweep route requires (cron auth, not Auth0). */
  sweepSecret?: string;
  /** LangSmith base URL; OTLP ingest is `${langsmithEndpoint}/otel/v1/traces`. */
  langsmithEndpoint: string;
  /** LangSmith project the forwarded spans land in (matches the run-API tracer's project). */
  langsmithProject: string;
  /** Sessions idle longer than this are force-closed by the sweep (FR-003, clarification Q1). */
  sweepIdleMinutes: number;
  /** Max sessions finalized per sweep tick; the rest are caught next run. */
  sweepBatchLimit: number;
}

export function liveStoryTracingConfig(
  env: NodeJS.ProcessEnv = process.env,
): LiveStoryTracingConfig {
  return {
    webhookSecret: env.ELEVENLABS_CONVAI_WEBHOOK_SECRET?.trim() || undefined,
    sweepSecret: env.CRON_SECRET?.trim() || undefined,
    langsmithEndpoint:
      env.LANGSMITH_ENDPOINT?.trim() || env.LANGCHAIN_ENDPOINT?.trim() || DEFAULT_LANGSMITH_ENDPOINT,
    langsmithProject:
      env.LANGSMITH_PROJECT?.trim() || env.LANGCHAIN_PROJECT?.trim() || DEFAULT_LANGSMITH_PROJECT,
    sweepIdleMinutes: intEnv(env.LIVE_STORY_SWEEP_IDLE_MINUTES, DEFAULT_SWEEP_IDLE_MINUTES),
    sweepBatchLimit: intEnv(env.LIVE_STORY_SWEEP_BATCH_LIMIT, DEFAULT_SWEEP_BATCH_LIMIT),
  };
}
