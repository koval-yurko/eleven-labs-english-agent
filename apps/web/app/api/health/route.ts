import type { ProviderHealth } from "@idiomatic/generator";
import { getOwnerId } from "../../../lib/auth/session";
import {
  buildGenerateLessonDeps,
  hasGenerationKeys,
} from "../../../lib/generation/deps";
import { hasSupabaseEnv } from "../../../lib/supabase/server";
import { json, unauthorized } from "../../../lib/http";

/**
 * Provider preflight. Cheap by default — config presence only (booleans, no secrets).
 * `?live=1` additionally pings Claude (validates the key + model) without generating.
 * Generation is script-only (007-live-only); ElevenLabs is used by the live story, not the
 * generation path. Auth-gated so the paid live check isn't abusable.
 */
export async function GET(request: Request) {
  const ownerId = await getOwnerId();
  if (!ownerId) return unauthorized();

  const env = process.env;
  const present = (v: string | undefined): boolean => Boolean(v && v.trim());

  const config = {
    auth0: ["AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET", "AUTH0_SECRET"].every(
      (k) => present(env[k]),
    ),
    supabase: hasSupabaseEnv(),
    anthropic: present(env.ANTHROPIC_API_KEY),
    elevenlabs: present(env.ELEVENLABS_API_KEY),
    voices: present(env.ELEVENLABS_TEACHER_VOICE_ID) && present(env.ELEVENLABS_LEARNER_VOICE_ID),
  };

  const mode = hasGenerationKeys() ? "real" : "mock";
  const live = new URL(request.url).searchParams.get("live") === "1";

  let providers: { llm: ProviderHealth } | undefined;
  if (live) {
    const deps = buildGenerateLessonDeps();
    const llm =
      (await deps.llm.healthCheck?.()) ??
      ({ provider: "claude", ok: true, detail: "no check available" } satisfies ProviderHealth);
    providers = { llm };
  }

  const configOk = Object.values(config).every(Boolean);
  const providersOk = !providers || providers.llm.ok;
  const ok = configOk && providersOk;

  return json({ ok, mode, config, providers }, ok ? 200 : 503);
}
