import { randomUUID } from "node:crypto";

import {
  formatItemsList,
  type TutorItem,
} from "@tutor/shared/tutor";
import type { RealtimeTokenRequest, RealtimeTokenResponse } from "@tutor/shared/api";

import { PROMPT_VERSIONS, effectiveConfig } from "../../../../../agent/prompts";
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
 * ## What is STILL provisional, and where it gets fixed
 *
 * The prompt comes from `PROMPT_VERSIONS` — the same registry the ElevenLabs agents are built from.
 * Two things are knowingly wrong with that and both belong to later stages of
 * docs/2026-08-22-openai-realtime-second-provider.md:
 *
 *   - **§13 Q1 — a version is not yet bound to a provider.** Any words-1.x version can be asked for
 *     here even though every one of them was written against a cascaded STT→LLM→TTS pipeline. The
 *     discriminant lands in stage 3.
 *   - **§11.1 — this is a PORT, and the document says not to ship one.** The reason to run OpenAI at
 *     all is that it hears audio rather than reading a transcript, which is a different lesson and
 *     wants its own version (stage 4). Running words-1.6 here proves the transport, not the product.
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

  // Newest version by default, matching `resolveAgent`'s rule so the two providers do not disagree
  // about what "no version asked for" means.
  const requested = body.version;
  const chosen = requested
    ? PROMPT_VERSIONS.find((v) => v.version === requested)
    : PROMPT_VERSIONS[PROMPT_VERSIONS.length - 1];
  if (!chosen) {
    return apiError(400, "config", `Unknown tutor version "${requested}".`);
  }
  const config = effectiveConfig(chosen);

  // The dynamic-variable substitution ElevenLabs does at runtime, done here instead — the whole of
  // §8's difference between the two routes in one line.
  const instructions = config.prompt.replaceAll("{{items_list}}", formatItemsList(items));

  try {
    const res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        session: {
          type: "realtime",
          model,
          instructions,
          audio: {
            input: {
              // Without this there are NO learner transcripts at all — the model hears the audio and
              // answers, but `conversation.item.input_audio_transcription.completed` never fires, so
              // half of every stored transcript would silently not exist. Opt-in, which is the
              // opposite of the ElevenLabs default and easy to miss.
              transcription: { model: "gpt-4o-transcribe" },
              // The closest analogue of `turnEagerness: "patient"`: a classifier decides the learner
              // is done from what they SAID rather than from a silence timer. Stage 0 measured this
              // as natural for ordinary teaching; podcast pacing (words-1.5) is still open — §6.3.
              turn_detection: { type: "semantic_vad", eagerness: "low" },
            },
            output: { voice },
          },
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
    };
    return json(payload);
  } catch (e) {
    return apiError(502, "openai", e instanceof Error ? e.message : String(e));
  }
});
