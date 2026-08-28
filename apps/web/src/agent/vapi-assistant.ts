/**
 * The Vapi half of `sync:agents`: one `EffectiveAgentConfig` → one Vapi assistant body.
 *
 * Separate from sync-agents.ts because it is the only genuinely new thinking in adding this
 * provider. Everything else there is a second entry in a table; this is a TRANSLATION, and the
 * places where the two vocabularies do not line up are decisions rather than plumbing.
 *
 * Vapi is the first provider that is neither of the two shapes this repo already knows:
 *
 *   - ElevenLabs — a remote agent object we bake, reconciled by hash (`agentBody`).
 *   - OpenAI     — no remote object at all; the session config IS the agent, built per request.
 *   - **Vapi**   — a remote object like ElevenLabs, whose fields mean the same things under
 *                  different names, EXCEPT where they have no counterpart at all.
 *
 * See §7 of docs/2026-08-27-vapi-third-voice-provider.md for the field-by-field table.
 */
import type { EffectiveAgentConfig } from "./prompts";

/** Vapi's REST base. Assistants are `POST /assistant`, `PATCH|DELETE /assistant/{id}`. */
export const VAPI_API = "https://api.vapi.ai";

/**
 * Vapi's accepted range for `silenceTimeoutSeconds` (default 30). Both ends matter here:
 * the max is what "disabled" becomes, and the min is what stops a version pinning something the
 * API would reject.
 */
const SILENCE_TIMEOUT_MIN = 10;
const SILENCE_TIMEOUT_MAX = 3600;

/**
 * `turnEagerness` → Vapi's two speaking plans.
 *
 * ElevenLabs answers "how readily does the agent take its turn" with ONE knob; Vapi splits it in
 * two, and the split is genuinely better for this app:
 *
 *   - `startSpeakingPlan.waitSeconds` — how long after the learner stops before the tutor starts.
 *   - `stopSpeakingPlan` — what counts as the learner INTERRUPTING a tutor who is already talking.
 *
 * `numWords` is the one worth understanding. At 0, any detected voice interrupts — including the
 * "mm" and "so…" of someone composing a sentence in a second language, which is exactly the learner
 * this app is for. `patient` therefore demands several words before it accepts that it is being
 * interrupted, and backs off longer when it is.
 *
 * Emitted ONLY when a version sets `turnEagerness`, so an unset value keeps Vapi's own defaults
 * rather than freezing today's guesses into every future assistant — the same rule `agentBody`
 * follows for `max_tokens`.
 */
const SPEAKING_PLANS: Record<
  "patient" | "normal" | "eager",
  { start: { waitSeconds: number }; stop: { numWords: number; voiceSeconds: number; backoffSeconds: number } }
> = {
  patient: { start: { waitSeconds: 1.0 }, stop: { numWords: 3, voiceSeconds: 0.3, backoffSeconds: 1.5 } },
  normal: { start: { waitSeconds: 0.4 }, stop: { numWords: 0, voiceSeconds: 0.2, backoffSeconds: 1.0 } },
  eager: { start: { waitSeconds: 0.2 }, stop: { numWords: 0, voiceSeconds: 0.1, backoffSeconds: 0.5 } },
};

/**
 * An LLM id → the `{ provider, model }` pair Vapi wants.
 *
 * Our registry names a model the way its vendor does (`claude-sonnet-4-6`); Vapi wants the vendor
 * named separately. Prefix matching rather than a lookup table on purpose: a table would have to be
 * edited every time a model ships, and the failure mode of getting this wrong is loud — Vapi rejects
 * an unknown model at create time, which `sync:agents` surfaces with the response body attached.
 *
 * Anthropic is the default for an unrecognised prefix because that is what `DEFAULT_LLM` is; an
 * unknown model reaching Anthropic fails clearly, where silently choosing a different VENDOR would
 * produce a working assistant running the wrong brain.
 */
export function vapiModelRef(llm: string): { provider: string; model: string } {
  if (llm.startsWith("gpt-") || llm.startsWith("o1") || llm.startsWith("o3")) {
    return { provider: "openai", model: llm };
  }
  if (llm.startsWith("gemini")) return { provider: "google", model: llm };
  return { provider: "anthropic", model: llm };
}

/**
 * `silenceEndCallTimeoutSeconds` → `silenceTimeoutSeconds`.
 *
 * Our field carries ElevenLabs' vocabulary, where **-1 means disabled** and is pinned that way
 * precisely so nothing hangs up a lesson the learner paused on purpose. Vapi has no -1: the timer
 * always exists. So "disabled" becomes the largest value the platform accepts — an hour, which is
 * twice `DEFAULT_MAX_DURATION_SECONDS`, so `maxDurationSeconds` remains the limit that actually
 * ends an abandoned session and the cost backstop stays where it was.
 *
 * A pinned value below Vapi's floor is raised rather than rejected, matching how
 * `openAiTurnDetection` treats that provider's higher floor: the direction is safe (a longer
 * silence tolerance can only help a held pause) and it costs pacing, not correctness.
 */
export function vapiSilenceTimeout(seconds: number): number {
  if (seconds < 0) return SILENCE_TIMEOUT_MAX;
  return Math.min(Math.max(seconds, SILENCE_TIMEOUT_MIN), SILENCE_TIMEOUT_MAX);
}

/**
 * The assistant body for one version.
 *
 * ## Vapi picks its own voice
 *
 * No `voice` block is sent, and no transcriber. Vapi applies its own defaults for both.
 *
 * That is a decision, not an omission. Routing our ElevenLabs voice through Vapi would mean giving
 * a third party our `xi-api-key` as a provider key — **we are deliberately not linking the two
 * accounts** (2026-08-28). Without that key, `voice.provider: "11labs"` would be billed through
 * Vapi's own ElevenLabs relationship at a markup, on top of the ElevenLabs bill we already pay
 * directly. Paying twice to make a comparison prettier is a bad trade.
 *
 * The cost is that a Vapi lesson does not sound like an ElevenLabs one, so this version varies the
 * VOICE as well as the orchestrator. That is not a new compromise: `words-2.0` already accepts
 * exactly it, because OpenAI Realtime has its own fixed voices too (§11.3 of the OpenAI note). What
 * stays constant across all three is the thing that matters most — the prompt, byte for byte.
 *
 * Consequence for the registry: `voiceId` and `ttsModelId` are ElevenLabs fields and are IGNORED
 * here. `llm` is NOT — see `vapiModelRef`.
 *
 * ## What is deliberately NOT here
 *
 * **`turnTimeoutSeconds`.** Vapi has no re-engage timer — its only silence timer ends the call — so
 * the field that gives words-1.0 and words-2.0 their podcast pacing has no counterpart at all. It is
 * dropped rather than approximated, because the honest options were both worse: mapping it onto
 * `silenceTimeoutSeconds` would turn "keep talking" into "hang up", and inventing a value would hide
 * the gap. Podcast pacing on Vapi needs a client-side timer driving `vapi.say()`. See words-3.0.ts.
 *
 * **A transcriber.** Vapi picks a sensible default, and pinning one would be inventing a decision
 * the registry has never had a field for.
 *
 * ## The prompt goes in verbatim, `{{items_list}}` included
 *
 * Vapi's dynamic-variable syntax is the same `{{name}}` as ElevenLabs', so the shared
 * `PODCAST_LESSON_PROMPT` needs no rewriting — the placeholder is filled per call via
 * `assistantOverrides.variableValues`.
 *
 * Note the asymmetry with ElevenLabs: `agentBody` also ships `dynamic_variable_placeholders`, a
 * DEFAULT used when a call supplies nothing, which is what makes an ElevenLabs agent testable from
 * its own dashboard. Vapi has no such field — variable values are API-only — so an assistant opened
 * in Vapi's test console shows the literal `{{items_list}}`. That is a property of the platform, not
 * an oversight, and it is why evaluating this version means driving it from a client.
 */
/** Where finished calls are reported to. Both halves or neither — see `vapiAssistantBody`. */
export interface VapiServerConfig {
  url?: string;
  secret?: string;
}

export function vapiAssistantBody(
  c: EffectiveAgentConfig,
  server: VapiServerConfig = {},
): Record<string, unknown> {
  const plans = c.turnEagerness ? SPEAKING_PLANS[c.turnEagerness] : undefined;
  return {
    name: c.name,
    model: {
      ...vapiModelRef(c.llm),
      messages: [{ role: "system", content: c.prompt }],
      ...(c.maxTokens === undefined ? {} : { maxTokens: c.maxTokens }),
    },
    // NO `voice` BLOCK, AND NO TRANSCRIBER — deliberate. See "Vapi picks its own voice" above.
    // `voiceId` and `ttsModelId` are ElevenLabs settings and are IGNORED for a Vapi version, the
    // same way they are for an OpenAI one (prompts/types.ts).
    // The ElevenLabs twin ships `first_message: ""` because teaching begins on the kickoff
    // contextual update, not a greeting. This is that same decision in Vapi's vocabulary: the
    // assistant does not open the conversation.
    firstMessage: "",
    firstMessageMode: "assistant-waits-for-user",
    maxDurationSeconds: c.maxDurationSeconds,
    silenceTimeoutSeconds: vapiSilenceTimeout(c.silenceEndCallTimeoutSeconds),
    ...(plans ? { startSpeakingPlan: plans.start, stopSpeakingPlan: plans.stop } : {}),
    // What the CLIENT is told during a call. These are the event sources a `TutorTransport` adapter
    // needs (§5.2): transcripts for `onTurn`, conversation-update as the material `onTurnCorrected`
    // must be reconstructed from, status/speech for `onStatus` and `isSpeaking`.
    clientMessages: ["transcript", "conversation-update", "speech-update", "status-update"],
    // What OUR SERVER is told. `end-of-call-report` only: it carries `endedReason`, the full
    // transcript and the cost breakdown in one delivery, and is the direct replacement for the
    // ElevenLabs post-call webhook (§8). `transcript` is deliberately absent — it fires per partial
    // and would be a firehose against a route whose only job is the final upsert.
    serverMessages: ["end-of-call-report"],
    /**
     * WHERE that report goes, provisioned onto the assistant rather than set org-wide in Vapi's
     * dashboard — so it is versioned with the rest of the assistant and cannot drift unnoticed.
     *
     * Both halves or neither. A `server` block with a url and no secret would stand up an
     * unauthenticated endpoint, and a webhook carries no session: the secret IS the authentication.
     * Omitting the block entirely is a supported state — `serverMessages` then names a report Vapi
     * has nowhere to send, which is exactly what this assistant looked like before this field
     * existed, and is silent rather than broken.
     */
    ...(server.url && server.secret
      ? { server: { url: server.url, secret: server.secret } }
      : {}),
  };
}
