import { getOwnerId } from "../../../lib/auth/session";
import { checkSupabase, checkElevenLabs, checkAnthropic } from "../../../lib/health";
import { json } from "../../../lib/http";
import type { HealthResponse } from "../../../shared/api";

/** Machine-readable health of the kept integrations. 200 when all green, else 503. */
export async function GET() {
  const ownerId = await getOwnerId();
  const [supabase, elevenlabs] = await Promise.all([checkSupabase(), checkElevenLabs()]);
  const anthropic = checkAnthropic();
  const auth = {
    ok: Boolean(ownerId),
    detail: ownerId ? `signed in as ${ownerId}` : "not signed in",
  };
  const allOk = auth.ok && supabase.ok && elevenlabs.ok && anthropic.ok;
  const body: HealthResponse = { auth, supabase, elevenlabs, anthropic };
  return json(body, allOk ? 200 : 503);
}
