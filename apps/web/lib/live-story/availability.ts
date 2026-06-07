import type { LiveStoryConfig } from "../config";

/**
 * Live-story availability (FR-026, research R7/R10). The adaptive live-narrated lesson is
 * feature-gated on the ElevenLabs API key + a provisioned story agent id being configured
 * server-side. When either is missing, the Live Story UI surfaces a clear "unavailable"
 * panel with retry/try-later — never a blank/frozen screen. Mirrors 005's
 * `isLiveTutorConfigured`. The api key is read upstream (lib/config.ts) but NEVER returned
 * to clients.
 */
export function isLiveStoryConfigured(config: LiveStoryConfig): boolean {
  return Boolean(config.apiKey && config.agentId);
}
