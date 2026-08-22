/**
 * Server-side configuration. SERVER-ONLY — the ElevenLabs api key is read here but NEVER
 * returned to the browser; only a short-lived conversation token ever reaches the client.
 */

export interface ElevenLabsConfig {
  appEnv: string;
  apiKey?: string;
  teacherVoiceId?: string;
  webhookSecret?: string;
  webhookForwardUrl?: string;
}

export function elevenLabsConfig(env: NodeJS.ProcessEnv = process.env): ElevenLabsConfig {
  return {
    apiKey: env.ELEVENLABS_API_KEY?.trim() || undefined,
    teacherVoiceId: env.ELEVENLABS_TEACHER_VOICE_ID?.trim() || undefined,
    webhookSecret: env.ELEVENLABS_WEBHOOK_SECRET?.trim() || undefined,
    appEnv: env.APP_ENV?.trim() || "prod",
    webhookForwardUrl: env.ELEVENLABS_WEBHOOK_FORWARD_URL?.trim() || undefined,
  };
}

/**
 * STAGE 0 SPIKE — OpenAI Realtime. Same rule as above: the api key is read here and NEVER returned
 * to a client; only an ephemeral `ek_…` client secret ever leaves the server.
 *
 * See docs/2026-08-22-openai-realtime-second-provider.md.
 */
export interface OpenAiRealtimeConfig {
  apiKey?: string;
  /** The realtime model. Overridable so `-mini` can be A/B'd without a deploy (§10). */
  model: string;
  /** One of OpenAI's fixed output voices — there is no voice catalogue here (§11.3). */
  voice: string;
}

export function openAiRealtimeConfig(env: NodeJS.ProcessEnv = process.env): OpenAiRealtimeConfig {
  return {
    apiKey: env.OPENAI_API_KEY?.trim() || undefined,
    model: env.OPENAI_REALTIME_MODEL?.trim() || "gpt-realtime",
    voice: env.OPENAI_REALTIME_VOICE?.trim() || "marin",
  };
}
