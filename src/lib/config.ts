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
