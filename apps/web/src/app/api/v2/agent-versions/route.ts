import type { AgentVersionsResponse } from "@tutor/shared/api";

import { activeVersions } from "../../../../lib/agent-registry";
import { withBearer } from "../../../../lib/auth/bearer";
import { apiError, json, preflight } from "../../../../lib/http";

// Read the registry at request time, not build time (the lockfile may change between deploys).
export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

/**
 * `GET /api/v2/agent-versions` — the tutor versions a client may pick from.
 *
 * `agentId` is stripped. That is the entire point of the route: the app names a VERSION, this
 * server owns version → agent id, and `pnpm sync:agents` can therefore retire a version without
 * breaking binaries already on phones. Sending the id would compile it into the app.
 *
 * `defaultVersion` is sent explicitly rather than left for the client to infer from array order,
 * because "newest active" is a server-side rule (`resolveAgent`) and a client re-deriving it would
 * be a second implementation of that rule living somewhere it cannot be hot-fixed.
 */
export const GET = withBearer(async () => {
  const active = activeVersions();
  // The newest active version IS the default (`resolveAgent` with no argument). Taking it first
  // means one check covers both "nothing provisioned" and the index access.
  const newest = active[active.length - 1];
  if (!newest) {
    return apiError(500, "config", "No active tutor agents — run `pnpm sync:agents`.");
  }

  const body: AgentVersionsResponse = {
    // `provider` rides along because picking a version IS picking a provider (§13 Q1/Q2): the
    // client opens a different transport for each, and inferring which from a naming convention
    // would put a copy of a server-side rule inside shipped binaries.
    versions: active.map(({ version, label, provider }) => ({
      version,
      label: label ?? version,
      provider,
    })),
    defaultVersion: newest.version,
  };
  return json(body);
});
