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

/**
 * Vapi — the third provider. Same rule as the two above: the PRIVATE key is read here and never
 * reaches a client.
 *
 * Vapi issues two keys and the distinction matters more than usual, because unlike ElevenLabs and
 * OpenAI this platform has one that is *meant* to ship:
 *
 *   - **private** — provisions assistants (`pnpm sync:agents`) and mints calls. Server only.
 *   - **public**  — what a client SDK is constructed with. Safe to ship, and better replaced by a
 *     short-lived public-scope JWT signed with the private key, which can be restricted to specific
 *     assistant ids and can forbid transient assistants (§6.2 of
 *     docs/2026-08-27-vapi-third-voice-provider.md).
 *
 * `orgId` exists only to sign those JWTs; it is an identifier, not a secret.
 *
 * There is no voice or model default here on purpose. Unlike OpenAI Realtime — where the session
 * config IS the agent and the token route has to supply one — a Vapi assistant is a remote object
 * provisioned from the prompt registry, so its model and voice come from the version. See
 * `vapiAssistantBody` in ../agent/sync-agents.ts.
 */
export interface VapiConfig {
  privateKey?: string;
  publicKey?: string;
  orgId?: string;
}

export function vapiConfig(env: NodeJS.ProcessEnv = process.env): VapiConfig {
  return {
    privateKey: env.VAPI_PRIVATE_KEY?.trim() || undefined,
    publicKey: env.VAPI_PUBLIC_KEY?.trim() || undefined,
    orgId: env.VAPI_ORG_ID?.trim() || undefined,
  };
}
