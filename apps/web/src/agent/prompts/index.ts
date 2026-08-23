/**
 * The prompt-version registry — the FILESYSTEM source of truth for the English-words-tutor
 * agents. Add a version: create a sibling `words-X.Y.ts` module and import it into PROMPT_VERSIONS
 * below. Remove a version: delete its module + drop it from the array, then run `pnpm sync:agents`
 * (it will retire the corresponding ElevenLabs agent). See ../sync-agents.ts and ../agents.lock.json.
 */
import type { RealtimeTurnDetection } from "@tutor/shared/api";
import { MIN_TURN_TIMEOUT_SECONDS } from "@tutor/shared/tutor/session";
import type { TutorProviderId } from "@tutor/shared/tutor/transport";

import type { PromptVersion } from "./types";
import words10 from "./words-1.0";
import words20 from "./words-2.0";
import words30 from "./words-3.0";

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
 * All prompt versions, OLDEST → NEWEST. The order drives the version picker and is the canonical
 * ordering (the lockfile is an unordered map).
 *
 * **The last entry is no longer automatically the default** — see `DEFAULT_PROMPT_VERSION`.
 *
 * ## Three entries, one lesson
 *
 * There used to be eight, seven of which were the trail of getting the lesson right. They are gone,
 * and what is left is the destination three times: `PODCAST_LESSON_PROMPT` on ElevenLabs, the same
 * text on OpenAI, and the same text again on Vapi. The picker is therefore a choice of SERVICE
 * wearing a version number, which is why every label names the service.
 *
 * `words-3.0` is in this list but NOT in the picker: it has a provisioned assistant and no mobile
 * adapter, so `activeVersions()` withholds it (../../lib/agent-registry.ts). This list is what
 * `sync:agents` reconciles; `activeVersions()` is what a learner can be handed. Those are different
 * questions and this is the first version where the answers differ.
 *
 * The history is in `docs/`, not here. A version's value while it exists is that a session can be
 * attributed to it; once nothing can be learned from running it again, keeping the module only makes
 * the picker a quiz.
 */
export const PROMPT_VERSIONS: PromptVersion[] = [words10, words20, words30];

/**
 * The version a session runs when none was asked for — and therefore the SERVICE it runs on.
 *
 * **This used to be "the last entry in PROMPT_VERSIONS", and that stopped being safe the moment a
 * version could name a different provider.** Appending `words-2.0` would otherwise have moved every
 * learner who never touches the picker onto a second provider and a code path nobody had spoken to,
 * as a side effect of appending to a list. Positional defaults are fine while every entry is
 * interchangeable; these are not — they are two different services.
 *
 * So the default is a NAME, and promoting a version is a deliberate one-line edit here. Now that
 * both versions run the same lesson, that edit is exactly one thing: which service a learner who
 * never opens the picker is taught by. `resolveVersion` falls back to the newest active version if
 * this name is ever missing or retired, so a mistake degrades rather than breaks.
 */
export const DEFAULT_PROMPT_VERSION = "words-1.0";

/** The full agent config baked into ElevenLabs for one version (after applying defaults). */
export interface EffectiveAgentConfig {
  version: string;
  /**
   * Which service runs this version. Deliberately NOT part of `hashConfig` in ../sync-agents.ts:
   * the hash covers what is baked into an ElevenLabs agent body, and this is not — adding it would
   * change every existing hash and make the next sync re-PATCH seven agents to send an identical
   * body.
   */
  provider: TutorProviderId;
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
    provider: v.provider ?? "elevenlabs",
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
      `that keeps the mobile held pause quiet (@tutor/shared/tutor/session). Raise it, or lower ` +
      `TUTOR_HEARTBEAT_MS first and re-reason about the margin.`,
  );
}

/**
 * OpenAI's own floor for `server_vad.idle_timeout_ms`, discovered the way floors usually are: the
 * session request came back `HTTP 400 integer_below_min_value — Expected a value >= 5000, but got
 * 3000` for a version pinned at the 3 s the ElevenLabs twin runs.
 *
 * So the two providers do not share a range. ElevenLabs accepts 1–30 s and this repo narrows that to
 * `MIN_TURN_TIMEOUT_SECONDS` (3 s) for the held pause; OpenAI will not go below 5 s at all. A
 * version therefore states the pacing it wants in the units the field has always meant, and this
 * mapper raises it to what the provider will accept rather than each OpenAI version carrying a
 * number that exists only to satisfy a vendor minimum.
 *
 * Raising is the safe direction for every constraint attached to this value: the mobile held pause
 * needs the timeout to stay comfortably ahead of `TUTOR_HEARTBEAT_MS`, and a longer one is more
 * ahead, not less. It costs pacing only — the tutor resumes into silence after 5 s instead of 3 —
 * which is why it is a clamp and not another deploy-blocking assert.
 */
const OPENAI_MIN_IDLE_TIMEOUT_MS = 5_000;

/**
 * `turnEagerness` → `semantic_vad.eagerness`. The one knob that maps cleanly across the providers.
 */
const EAGERNESS: Record<"patient" | "normal" | "eager", "low" | "medium" | "high"> = {
  patient: "low",
  normal: "medium",
  eager: "high",
};

/**
 * `turnEagerness` → `server_vad.silence_duration_ms`, in the mode that has no eagerness classifier.
 *
 * The platform default is 500 ms. `patient` more than doubles it, because the learner this app is
 * for is composing English aloud and a half-second gap mid-sentence is normal for them — the exact
 * thing `turnEagerness: "patient"` was pinned on words-1.5 to stop the tutor talking over.
 */
const SILENCE_MS: Record<"patient" | "normal" | "eager", number> = {
  patient: 1_200,
  normal: 500,
  eager: 300,
};

/**
 * A version's OpenAI `audio.input.turn_detection` block — the OpenAI half of the two turn-taking
 * knobs, which until now were documented as ElevenLabs-only and ignored here.
 *
 * The two modes are mutually exclusive on OpenAI's side and that is what makes this a branch rather
 * than a set of fields: **`idle_timeout_ms` exists only on `server_vad`, and `eagerness` only on
 * `semantic_vad`.** So a version has to pick which question matters more:
 *
 *   - **`turnTimeoutSeconds` SET → `server_vad` with an idle timeout.** Podcast pacing. The server
 *     commits an empty turn after that much silence and provokes a response, which is the only
 *     mechanism either provider has for "keep talking when nobody answers" — on ElevenLabs it is
 *     `turn_timeout`, and this is the same knob wearing the other vendor's name (§5, §6.3 of
 *     docs/2026-08-22-openai-realtime-second-provider.md). A lesson the learner listens to with the
 *     microphone off does not work without it: the model answers input, and silence is not input.
 *   - **unset → `semantic_vad`.** A classifier decides the learner has finished from WHAT THEY
 *     SAID, and the tutor waits indefinitely for them. What a drill or a Q&A lesson wants.
 *
 * Read off the RAW version rather than `effectiveConfig`, and that is load-bearing: the effective
 * config defaults `turnTimeoutSeconds` to 7, so going through it would silently give every OpenAI
 * version podcast pacing — including one written to wait for the learner, which would then nag them
 * every seven seconds.
 *
 * The client is told which block it got (`RealtimeTokenResponse.turnDetection`) because a held pause
 * has to suspend the idle timeout and `session.update` replaces the object wholesale.
 */
export function openAiTurnDetection(v: PromptVersion): RealtimeTurnDetection {
  if (v.turnTimeoutSeconds === undefined) {
    return {
      type: "semantic_vad",
      eagerness: v.turnEagerness ? EAGERNESS[v.turnEagerness] : "auto",
    };
  }
  // The floor `effectiveConfig` enforces applies here too, and for a reason that survives the change
  // of provider: a held pause suspends this timeout, and a timeout shorter than the suspension can
  // be delivered is a tutor that teaches into a paused lesson.
  assertTurnTimeoutFloor(v.version, v.turnTimeoutSeconds);
  // ...and OpenAI's own floor is higher than ours, so the pinned value is raised to it rather than
  // rejected by the session request. See OPENAI_MIN_IDLE_TIMEOUT_MS.
  return {
    type: "server_vad",
    silence_duration_ms: SILENCE_MS[v.turnEagerness ?? "normal"],
    idle_timeout_ms: Math.max(v.turnTimeoutSeconds * 1_000, OPENAI_MIN_IDLE_TIMEOUT_MS),
  };
}

export function findVersion(version: string): PromptVersion | undefined {
  return PROMPT_VERSIONS.find((v) => v.version === version);
}

/**
 * The versions `pnpm sync:agents` is responsible for.
 *
 * Everything else in the registry runs on a provider with no remote agent object to reconcile, so
 * the sync must not create, patch, or count it as an orphan. One helper rather than a filter at each
 * call site, because "which versions does ElevenLabs know about" is a question the lockfile's
 * correctness depends on and it should have exactly one answer.
 */
export function elevenLabsVersions(): PromptVersion[] {
  return versionsFor("elevenlabs");
}

/**
 * The versions `pnpm sync:agents` provisions on Vapi.
 *
 * Vapi sits between the other two providers and this helper is where that shows: like ElevenLabs it
 * HAS a remote object to reconcile, so it cannot be skipped the way OpenAI is; unlike ElevenLabs its
 * object is an "assistant" with a different field vocabulary, so it cannot share the ElevenLabs
 * body. Two lists, one loop — see `DRIVERS` in ../sync-agents.ts.
 */
export function vapiVersions(): PromptVersion[] {
  return versionsFor("vapi");
}

/**
 * One filter, so "which versions belong to provider X" has a single answer and the
 * `provider ?? "elevenlabs"` default is written once. That default is not cosmetic: every version
 * predating the second provider omits the field and must keep meaning ElevenLabs forever.
 */
function versionsFor(provider: TutorProviderId): PromptVersion[] {
  return PROMPT_VERSIONS.filter((v) => (v.provider ?? "elevenlabs") === provider);
}
