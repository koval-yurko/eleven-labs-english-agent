import type { RealtimeSpikeTokenResponse } from "@tutor/shared/api";

import { withBearer } from "../../../../../lib/auth/bearer";
import { openAiRealtimeConfig } from "../../../../../lib/config";
import { apiError, json, preflight } from "../../../../../lib/http";

// Mints a credential per request; nothing here is cacheable.
export const dynamic = "force-dynamic";

// D25 — without this a browser preflight gets 405 and the real request is never sent.
export const OPTIONS = preflight;

/**
 * `POST /api/v2/words-agent/openai-token` — **STAGE 0 SPIKE**, the OpenAI Realtime twin of
 * `/api/v2/words-agent/token`.
 *
 * It exists to answer the five questions in docs/2026-08-22-openai-realtime-second-provider.md §12
 * on a real device, and it is expected to be deleted or promoted once they are. Nothing in the
 * tutor session reaches it; `apps/mobile/src/app/realtime.tsx` is its only caller.
 *
 * ## Why the whole session config is baked HERE
 *
 * OpenAI has no remote agent object — unlike ElevenLabs, where `sync:agents` provisions an agent and
 * this route only resolves version → agent id. The session config *is* the agent, so whatever is
 * passed at credential-minting time is what the client gets, and anything the client could pass
 * instead is something a shipped binary could be made to lie about. Baking it here keeps the same
 * property the ElevenLabs route has: the prompt never reaches the app.
 *
 * The client may still send a `session` alongside its SDP offer, and any field it sets would win.
 * The spike deliberately sends none (see the screen), so this body is the whole configuration.
 *
 * ## Why the prompt is hardcoded and short
 *
 * It is NOT words-1.6. A spike that ran the real prompt would be measuring the prompt; this one has
 * exactly the shape needed to exercise the five questions — it teaches, so there is something to
 * interrupt (§6.1); it invites interruption, so barge-in happens without coaching; and it listens
 * for pronunciation, which is the one thing the ElevenLabs pipeline structurally cannot do (§11.1).
 */
const SPIKE_INSTRUCTIONS = `You are an English tutor running a two-minute test lesson.

Teach these three words, one at a time, in this order: "ephemeral", "to break the ice", "I couldn't agree more".

For each one: say the word, give a one-sentence meaning, then one natural example sentence, then ask
the learner to say it back to you.

Rules that matter for this test:
- Keep every turn short — two or three sentences, then stop and let the learner speak.
- The learner WILL interrupt you mid-sentence. That is expected and welcome; stop immediately and
  answer what they asked.
- You can hear the learner's actual voice, not a transcript. When they say a word back to you,
  comment on how they PRONOUNCED it — stress, vowel length, a sound they replaced — and model it
  again. Be specific about the sound, not vague praise.
- Never read lists or spell things out. This is speech.`;

export const POST = withBearer(async () => {
  const { apiKey, model, voice } = openAiRealtimeConfig();
  if (!apiKey) return apiError(500, "config", "OPENAI_API_KEY is not set.");

  try {
    const res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        session: {
          type: "realtime",
          model,
          instructions: SPIKE_INSTRUCTIONS,
          audio: {
            input: {
              // Without this there are NO learner transcripts at all — the model hears the audio and
              // answers, but `conversation.item.input_audio_transcription.completed` is never sent,
              // so half the transcript this app stores would silently not exist. It is opt-in, which
              // is the opposite of the ElevenLabs default and easy to miss.
              transcription: { model: "gpt-4o-transcribe" },
              // `semantic_vad` + `eagerness: "low"` is the closest analogue of the `turnEagerness:
              // "patient"` that words-1.5 pins — a classifier decides the learner is done from what
              // they said, not from a silence timer. Question 5 of §12 is whether this is enough to
              // reproduce podcast pacing; `server_vad` with `idle_timeout_ms` is the other candidate.
              turn_detection: { type: "semantic_vad", eagerness: "low" },
            },
            output: { voice },
          },
        },
      }),
    });

    if (!res.ok) {
      // Forwarded verbatim rather than summarised: an OpenAI refusal (quota, model name, bad field)
      // says exactly what is wrong in the body, and the ElevenLabs quota outage is the standing
      // proof that swallowing that text costs hours. See docs/2026-08-21-quota-outage-and-pause-panel.md.
      const detail = (await res.text()).slice(0, 500);
      return apiError(502, "openai", `OpenAI returned HTTP ${res.status}: ${detail}`);
    }

    const data = (await res.json()) as {
      value?: string;
      expires_at?: number;
      session?: { model?: string };
    };
    if (!data.value) return apiError(502, "openai", "OpenAI response had no client secret.");

    const body: RealtimeSpikeTokenResponse = {
      clientSecret: data.value,
      expiresAt: data.expires_at ?? 0,
      // What the SESSION says, not what we asked for — `gpt-realtime` is an alias, and the snapshot
      // it resolves to is the thing worth reading on screen.
      model: data.session?.model ?? model,
    };
    return json(body);
  } catch (e) {
    return apiError(502, "openai", e instanceof Error ? e.message : String(e));
  }
});
