/**
 * The prompt-version registry — the FILESYSTEM source of truth for the English-words-tutor
 * agents. Add a version: create a sibling `words-X.Y.ts` module and import it into PROMPT_VERSIONS
 * below. Remove a version: delete its module + drop it from the array, then run `pnpm sync:agents`
 * (it will retire the corresponding ElevenLabs agent). See ../sync-agents.ts and ../agents.lock.json.
 */
import { MIN_TURN_TIMEOUT_SECONDS } from "@tutor/shared/tutor";

import type { PromptVersion } from "./types";
import words10 from "./words-1.0";
import words11 from "./words-1.1";
import words12 from "./words-1.2";
import words13 from "./words-1.3";
import words14 from "./words-1.4";
import words15 from "./words-1.5";

export type { PromptVersion } from "./types";

/** Defaults baked into the agent when a version doesn't override them. */
export const DEFAULT_LLM = "claude-sonnet-4-6";
export const DEFAULT_TTS_MODEL = "eleven_v3_conversational";
/**
 * 30 minutes. ElevenLabs defaults to 600s, which cuts a lesson off at ten minutes — found when an
 * S1 probe session died at exactly 600s (docs/2026-08-13-expo-s1-background-audio.md §11).
 * The API's accepted range is 60–7200; we deliberately do not take the maximum, because this value
 * is also the cost backstop for a session nobody ended.
 */
export const DEFAULT_MAX_DURATION_SECONDS = 1800;
/**
 * The platform's own current default (range 1–30), pinned so it stops being a value we inherit.
 * The mobile client's held pause resets this timer every 3 s with `user_activity`; if the default
 * ever moved below that, a paused lesson would start talking to itself.
 * See docs/2026-08-16-tutor-pause-hold-the-line.md §4.1.
 */
export const DEFAULT_TURN_TIMEOUT_SECONDS = 7;
/** -1 = disabled, the platform default. Pinned so nothing hangs up a deliberately silent lesson. */
export const DEFAULT_SILENCE_END_CALL_TIMEOUT_SECONDS = -1;

/**
 * All prompt versions, OLDEST → NEWEST. The last entry is the UI default. The order here also
 * drives the version picker; it is the canonical ordering (the lockfile is an unordered map).
 */
export const PROMPT_VERSIONS: PromptVersion[] = [words10, words11, words12, words13, words14, words15];

/** The full agent config baked into ElevenLabs for one version (after applying defaults). */
export interface EffectiveAgentConfig {
  version: string;
  /** EL agent display name — also how `sync` identifies a managed agent. */
  name: string;
  prompt: string;
  llm: string;
  voiceId: string | undefined;
  ttsModelId: string;
  additionalLanguages: string[];
  /** Undefined = omit from the agent body, i.e. the platform's own -1 (unlimited). */
  maxTokens: number | undefined;
  /** Undefined = omit from the agent body, i.e. the platform's own `normal`. */
  turnEagerness: "patient" | "normal" | "eager" | undefined;
  maxDurationSeconds: number;
  turnTimeoutSeconds: number;
  silenceEndCallTimeoutSeconds: number;
}

/** Resolve a version's full baked agent config, applying env/constant defaults (sync-time). */
export function effectiveConfig(
  v: PromptVersion,
  env: NodeJS.ProcessEnv = process.env,
): EffectiveAgentConfig {
  const turnTimeoutSeconds = v.turnTimeoutSeconds ?? DEFAULT_TURN_TIMEOUT_SECONDS;
  assertTurnTimeoutFloor(v.version, turnTimeoutSeconds);
  return {
    version: v.version,
    name: `english-words-tutor (${v.version})`,
    prompt: v.prompt,
    llm: v.llm ?? env.LIVE_STORY_LLM?.trim() ?? DEFAULT_LLM,
    voiceId: v.voiceId ?? env.ELEVENLABS_TEACHER_VOICE_ID?.trim() ?? undefined,
    ttsModelId: v.ttsModelId ?? env.LIVE_STORY_TTS_MODEL?.trim() ?? DEFAULT_TTS_MODEL,
    additionalLanguages: v.additionalLanguages ?? [],
    // No default on purpose: an unset maxTokens must leave the older versions' agents exactly as
    // they were pinned. See types.ts.
    maxTokens: v.maxTokens,
    turnEagerness: v.turnEagerness,
    maxDurationSeconds: v.maxDurationSeconds ?? DEFAULT_MAX_DURATION_SECONDS,
    turnTimeoutSeconds,
    silenceEndCallTimeoutSeconds:
      v.silenceEndCallTimeoutSeconds ?? DEFAULT_SILENCE_END_CALL_TIMEOUT_SECONDS,
  };
}

/**
 * The floor a baked `turn_timeout` may not go under, checked here because `effectiveConfig` is the
 * one place every sync path funnels through.
 *
 * A version that pins a timeout at or below the mobile heartbeat produces a held pause that no
 * longer holds: the tutor re-engages between pings and teaches into a speaker the learner has
 * silenced. That failure is invisible from the server, so it has to be impossible to deploy.
 * See docs/2026-08-18-podcast-mode-tutor.md §3.
 */
function assertTurnTimeoutFloor(version: string, seconds: number): void {
  if (seconds >= MIN_TURN_TIMEOUT_SECONDS) return;
  throw new Error(
    `${version}: turnTimeoutSeconds is ${seconds}s, below the ${MIN_TURN_TIMEOUT_SECONDS}s floor ` +
      `that keeps the mobile held pause quiet (@tutor/shared/tutor). Raise it, or lower ` +
      `TUTOR_HEARTBEAT_MS first and re-reason about the margin.`,
  );
}

export function findVersion(version: string): PromptVersion | undefined {
  return PROMPT_VERSIONS.find((v) => v.version === version);
}
