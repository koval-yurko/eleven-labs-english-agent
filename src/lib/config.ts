/**
 * Server-side configuration. SERVER-ONLY — the ElevenLabs api key is read here but NEVER
 * returned to the browser; only a short-lived conversation token ever reaches the client.
 */

export interface ElevenLabsConfig {
  apiKey?: string;
  agentId?: string;
  teacherVoiceId?: string;
}

export function elevenLabsConfig(env: NodeJS.ProcessEnv = process.env): ElevenLabsConfig {
  return {
    apiKey: env.ELEVENLABS_API_KEY?.trim() || undefined,
    agentId: env.ELEVENLABS_STORY_AGENT_ID?.trim() || undefined,
    teacherVoiceId: env.ELEVENLABS_TEACHER_VOICE_ID?.trim() || undefined,
  };
}
