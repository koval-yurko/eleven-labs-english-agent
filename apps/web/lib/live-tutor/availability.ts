/**
 * Live-tutor availability (FR-017, research R8). Live Q&A is feature-gated on the
 * ElevenLabs API key + a provisioned agent id being configured server-side. When either
 * is missing, the player surfaces a clear "unavailable" fallback and the lesson stays
 * playable — it is never frozen. The api key is read here but NEVER returned to clients.
 */
export interface LiveTutorConfig {
  apiKey?: string;
  agentId?: string;
}

export function liveTutorConfig(env: NodeJS.ProcessEnv = process.env): LiveTutorConfig {
  return {
    apiKey: env.ELEVENLABS_API_KEY?.trim() || undefined,
    agentId: env.ELEVENLABS_AGENT_ID?.trim() || undefined,
  };
}

export function isLiveTutorConfigured(config: LiveTutorConfig): boolean {
  return Boolean(config.apiKey && config.agentId);
}
