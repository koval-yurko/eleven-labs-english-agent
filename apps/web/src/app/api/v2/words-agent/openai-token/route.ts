import { randomUUID } from "node:crypto";

import {
  formatItemsList,
  type TutorItem,
} from "@tutor/shared/tutor";
import type {
  RealtimeAudioInput,
  RealtimeTokenRequest,
  RealtimeTokenResponse,
} from "@tutor/shared/api";

import { effectiveConfig, findVersion, openAiTurnDetection } from "../../../../../agent/prompts";
import { resolveVersion } from "../../../../../lib/agent-registry";
import { withBearer } from "../../../../../lib/auth/bearer";
import { openAiRealtimeConfig } from "../../../../../lib/config";
import { apiError, json, preflight } from "../../../../../lib/http";

// Mints a credential per request; nothing here is cacheable.
export const dynamic = "force-dynamic";

// D25 — without this a browser preflight gets 405 and the real request is never sent.
export const OPTIONS = preflight;

/**
 * `POST /api/v2/words-agent/openai-token` — the OpenAI Realtime twin of
 * `/api/v2/words-agent/token`.
 *
 * ## Why the whole session config is baked HERE
 *
 * OpenAI has no remote agent object. Unlike ElevenLabs — where `pnpm sync:agents` provisions an
 * agent and the token route only resolves version → agent id — **the session config IS the agent**,
 * so whatever is passed at credential-minting time is what the client gets. Anything the client
 * could pass instead is something a shipped binary could be made to lie about, which is why the
 * words arrive in the request body as DATA and the prompt they go into never leaves this process.
 *
 * The client may still send a `session` object alongside its SDP offer and any field it set would
 * win. The adapter deliberately sends none (`apps/mobile/src/lib/transport/openai.ts`), so this body
 * is the whole configuration.
 *
 * ## The row key is minted here
 *
 * OpenAI does mint an `rtc_…` call id, but only at SDP exchange — after the client needs one, and
 * somewhere this route cannot see. So the conversation id is ours. That is the same conclusion
 * `ConversationTokenResponse` reached for a different reason, and for the same stakes: four writers
 * converge on one `lesson_sessions` row keyed by this column.
 *
 * ## Which versions this route will serve
 *
 * Only versions whose `provider` is `"openai"` — the discriminant added in stage 3. Asking for an
 * ElevenLabs version here is refused rather than honoured, because those prompts were written for a
 * cascaded STT→LLM→TTS pipeline that reads a transcript, and this model hears the learner's voice.
 * Running one on the other is a different lesson (§11.1), not a fallback.
 *
 * Today that is `words-2.0`. Add another `words-2.x` module with `provider: "openai"` and it starts
 * serving that one too.
 *
 * ## Turn-taking is per VERSION, not per provider
 *
 * `turn_detection` was hardcoded here until words-2.0 needed podcast pacing. It is now derived from
 * the version (`openAiTurnDetection`), because "does the tutor take the floor back on its own after
 * a silence" is a property of the LESSON — the same question `turnTimeoutSeconds` answers on the
 * ElevenLabs side — and the two OpenAI modes that answer it are mutually exclusive.
 */
export const POST = withBearer(async (req) => {
  const { apiKey, model, voice } = openAiRealtimeConfig();
  if (!apiKey) return apiError(500, "config", "OPENAI_API_KEY is not set.");

  let body: RealtimeTokenRequest;
  try {
    body = (await req.json()) as RealtimeTokenRequest;
  } catch {
    return apiError(400, "bad_request", "Expected a JSON body.");
  }
  if (typeof body?.lessonId !== "string" || body.lessonId.length === 0) {
    return apiError(400, "bad_request", "lessonId is required.");
  }
  const items: TutorItem[] = Array.isArray(body.items) ? body.items : [];

  // One resolver for both providers, so "no version asked for" cannot mean two different things.
  const requested = body.version;
  const resolved = resolveVersion(requested);
  if (!resolved) {
    return apiError(
      requested ? 400 : 500,
      "config",
      requested ? `Unknown or inactive tutor version "${requested}".` : "No active tutor versions.",
    );
  }
  if (resolved.provider !== "openai") {
    // The mirror of the ElevenLabs route's refusal, and for the same reason: these prompts are
    // written for different pipelines (§11.1), so running one here would be a different lesson.
    return apiError(
      400,
      "wrong_provider",
      `Tutor version "${resolved.version}" runs on ${resolved.provider}, not OpenAI.`,
    );
  }
  const chosen = findVersion(resolved.version);
  if (!chosen) return apiError(500, "config", `Version "${resolved.version}" vanished mid-request.`);
  const config = effectiveConfig(chosen);

  // The dynamic-variable substitution ElevenLabs does at runtime, done here instead — the whole of
  // §8's difference between the two routes in one line.
  const instructions = config.prompt.replaceAll("{{items_list}}", formatItemsList(items));
  /**
   * PACING, chosen by the version rather than fixed by the provider.
   *
   * It used to be one hardcoded `semantic_vad` block, which was right while the only planned OpenAI
   * lesson was a pronunciation drill and wrong the moment one was a podcast: a podcast needs the
   * tutor to take the floor back on its own after a silence, and on this provider the ONLY thing
   * that does that is `server_vad`'s `idle_timeout_ms`. The model answers input, and silence is not
   * input — without it a monologue lesson says one paragraph and stops for good.
   *
   * Read off the raw version, not `config`, so an unset `turnTimeoutSeconds` still means "wait for
   * the learner" rather than the effective default of seven seconds. See `openAiTurnDetection`.
   */
  const audioInput: RealtimeAudioInput = {
    // Without this there are NO learner transcripts at all — the model hears the audio and answers,
    // but `conversation.item.input_audio_transcription.completed` never fires, so half of every
    // stored transcript would silently not exist. Opt-in, which is the opposite of the ElevenLabs
    // default and easy to miss.
    transcription: { model: "gpt-4o-transcribe" },
    turn_detection: openAiTurnDetection(chosen),
  };

  try {
    const res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        session: {
          type: "realtime",
          model,
          instructions,
          audio: { input: audioInput, output: { voice } },
          // The per-version turn budget, carried across. It is a BACKSTOP for a prompt-level rule,
          // never the rule itself — the model is cut off mid-sentence when it hits this.
          ...(config.maxTokens === undefined ? {} : { max_output_tokens: config.maxTokens }),
        },
      }),
    });

    if (!res.ok) {
      // Forwarded verbatim rather than summarised: an OpenAI refusal (quota, model name, bad field)
      // says exactly what is wrong in the body, and the ElevenLabs quota outage is the standing
      // proof that swallowing that text costs hours.
      const detail = (await res.text()).slice(0, 500);
      return apiError(502, "openai", `OpenAI returned HTTP ${res.status}: ${detail}`);
    }

    const data = (await res.json()) as {
      value?: string;
      expires_at?: number;
      session?: { model?: string };
    };
    if (!data.value) return apiError(502, "openai", "OpenAI response had no client secret.");

    const payload: RealtimeTokenResponse = {
      clientSecret: data.value,
      conversationId: randomUUID(),
      version: chosen.version,
      // What the SESSION says, not what we asked for — `gpt-realtime` is an alias and the snapshot
      // it resolves to is the thing worth recording.
      model: data.session?.model ?? model,
      expiresAt: data.expires_at ?? 0,
      // Handed back WHOLE so the transport can put it back whole: a held pause suspends the idle
      // timeout with a `session.update`, and an update carrying only `turn_detection` would bet on
      // how the server merges a nested object — with the transcription config as the stake.
      audioInput,
    };
    return json(payload);
  } catch (e) {
    return apiError(502, "openai", e instanceof Error ? e.message : String(e));
  }
});
