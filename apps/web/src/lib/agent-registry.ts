/**
 * SERVER-ONLY runtime view of which tutor versions are live, and which service runs each.
 *
 * Reads the committed lockfile (src/agent/agents.lock.json, written by `pnpm sync:agents`) and the
 * prompt registry, and exposes the ACTIVE versions for the token routes and the version picker.
 * The newest active version (last in PROMPT_VERSIONS order) is the default.
 *
 * ## Two kinds of version since 2026-08-22
 *
 * An **ElevenLabs** version is active only when the lockfile says it has a provisioned, non-retired
 * agent — the id is what the session is actually opened against, so a version without one cannot
 * run. An **OpenAI** version has no remote agent object at all (§8: the session config *is* the
 * agent, and it is built per request by the token route), so it is active by existing on disk.
 *
 * That asymmetry is the whole reason `agentId` is nullable here rather than two separate lists:
 * every caller that needs an id is already the caller that knows it is talking to ElevenLabs.
 */
import type { TutorProviderId } from "@tutor/shared/tutor-transport";

import lockfile from "../agent/agents.lock.json";
import { DEFAULT_PROMPT_VERSION, PROMPT_VERSIONS } from "../agent/prompts";

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
  provider: TutorProviderId;
  /** The provisioned ElevenLabs agent, or `null` for a provider that has no such object. */
  agentId: string | null;
  label?: string;
}

/** Active versions, in canonical PROMPT_VERSIONS order (oldest → newest). */
export function activeVersions(): ActiveVersion[] {
  return PROMPT_VERSIONS.flatMap<ActiveVersion>((v) => {
    const provider: TutorProviderId = v.provider ?? "elevenlabs";
    const label = v.label ?? v.version;
    if (provider !== "elevenlabs") {
      return [{ version: v.version, provider, agentId: null, label }];
    }
    const a = lock.agents[v.version];
    // Unprovisioned or retired: NOT active. Offering it would put a version in the picker that
    // cannot start a session, and the failure would land on the learner rather than on a sync.
    if (!a || a.status !== "active" || !a.agentId) return [];
    return [{ version: v.version, provider, agentId: a.agentId, label }];
  });
}

/**
 * Resolve a requested version, whichever provider it belongs to. With no version, returns the
 * default (newest active). Null when the version is unknown, retired, or nothing is provisioned.
 *
 * This is what the token routes branch on: each one resolves, then refuses a version that is not
 * its own. Refusing rather than silently redirecting, because a version names a PROMPT written for
 * one pipeline and running it on the other is a different lesson (§11.1), not a fallback.
 */
export function resolveVersion(version?: string | null): ActiveVersion | null {
  const all = activeVersions();
  if (version) return all.find((v) => v.version === version) ?? null;
  // NAMED, not positional — see `DEFAULT_PROMPT_VERSION` for why appending to the registry must not
  // be able to move every learner onto a different provider. The fallback keeps a bad name from
  // taking the app down: it degrades to the newest active version instead.
  return all.find((v) => v.version === DEFAULT_PROMPT_VERSION) ?? all[all.length - 1] ?? null;
}

/**
 * Resolve a requested version → its live ElevenLabs agent, or null.
 *
 * Narrower than `resolveVersion` on purpose: it returns only what can actually be opened as an
 * ElevenLabs conversation, so a caller holding one of these has an `agentId` without a check.
 * An OpenAI version resolves to null here — the caller is expected to have used `resolveVersion`
 * first if it wants to tell "wrong provider" apart from "unknown version".
 */
export function resolveAgent(version?: string | null): (ActiveVersion & { agentId: string }) | null {
  const resolved = resolveVersion(version);
  if (!resolved || resolved.provider !== "elevenlabs" || !resolved.agentId) return null;
  return { ...resolved, agentId: resolved.agentId };
}

/**
 * Map an ElevenLabs agent id back to its prompt version — retired versions included, since
 * a post-call webhook can arrive for an agent that was retired mid-flight. Null when unknown.
 */
export function versionForAgentId(agentId: string): string | null {
  for (const [version, a] of Object.entries(lock.agents)) {
    if (a.agentId === agentId) return version;
  }
  return null;
}
