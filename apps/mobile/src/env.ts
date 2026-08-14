import Constants from "expo-constants";

import type { MobileEnv } from "../env.types";

// app.config.ts puts the whole per-variant object here as `extra.env` (never spread key by key,
// so this cast describes one shape rather than drifting field by field).
const raw = Constants.expoConfig?.extra?.env as Partial<MobileEnv> | undefined;

/**
 * Required, never defaulted — the same rule `appEnv` follows on the server (CLAUDE.md). A value
 * that silently falls back is a value you eventually ship pointing at the wrong thing.
 */
function required<K extends keyof MobileEnv>(key: K): NonNullable<MobileEnv[K]> {
  const value = raw?.[key];
  if (value === undefined || value === "") {
    throw new Error(
      `Missing env value "${String(key)}" for this build. Set it for every variant in ` +
        `apps/mobile/env.config.ts, then rebuild — values are baked in at build time.`,
    );
  }
  return value as NonNullable<MobileEnv[K]>;
}

/**
 * Getters, not eager reads. An import-time throw in React Native is a white screen with no
 * message; a throw at first use lands in the error boundary carrying the text above.
 */
export const env = {
  get auth0Domain() {
    return required("auth0Domain");
  },
  get auth0ClientId() {
    return required("auth0ClientId");
  },
  get auth0Audience() {
    return required("auth0Audience");
  },
  get apiBaseUrl() {
    return required("apiBaseUrl");
  },
};
