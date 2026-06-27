/**
 * SERVER-ONLY runtime view of which tutor versions are live. Reads the committed lockfile
 * (src/agent/agents.lock.json, written by `pnpm sync:agents`) and exposes the ACTIVE versions —
 * those with a provisioned ElevenLabs agent and not retired — for the signed-url route and the
 * version picker. The newest active version (last in PROMPT_VERSIONS order) is the default.
 */
import lockfile from "../agent/agents.lock.json";
import { PROMPT_VERSIONS } from "../agent/prompts";

interface LockAgent {
  agentId: string;
  status: "active" | "retired";
}
interface Lockfile {
  version: number;
  agents: Record<string, LockAgent>;
}

const lock = lockfile as unknown as Lockfile;

export interface ActiveVersion {
  version: string;
  agentId: string;
  label?: string;
}

/** Active (non-retired, provisioned) versions, in canonical PROMPT_VERSIONS order (oldest → newest). */
export function activeVersions(): ActiveVersion[] {
  return PROMPT_VERSIONS.flatMap((v) => {
    const a = lock.agents[v.version];
    if (!a || a.status !== "active" || !a.agentId) return [];
    return [{ version: v.version, agentId: a.agentId, label: v.label ?? v.version }];
  });
}

/**
 * Resolve a requested version → its live agent. With no version, returns the default (newest
 * active). Returns null when the version is unknown, retired, or nothing is provisioned yet.
 */
export function resolveAgent(version?: string | null): ActiveVersion | null {
  const all = activeVersions();
  if (version) return all.find((v) => v.version === version) ?? null;
  return all[all.length - 1] ?? null;
}
