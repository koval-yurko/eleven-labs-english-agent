// Reconcile the remote agent objects of every provider with the prompt-version registry on disk.
//
// The FILESYSTEM (src/agent/prompts/) is the source of truth. This command makes each provider
// match it and records the version→id mapping in src/agent/agents.lock.json:
//
//   • a new version file            → CREATE a new agent
//   • a changed version (hash diff) → PATCH the SAME agent in place (id, URLs, analytics survive)
//   • an unchanged version          → no-op
//   • a version removed from disk   → PRUNE: retire (default) | delete | leave
//
// It is IDEMPOTENT — re-running with no changes does nothing.
//
// ## Two providers have remote objects; one does not
//
// ElevenLabs and Vapi both have an agent to reconcile, with different field vocabularies. OpenAI has
// no remote object at all — its session config IS the agent, built per request by the token route —
// so it is invisible here. `DRIVERS` below is that fact expressed once, rather than a provider check
// at each step. Adding a fourth provider with a remote object means adding one entry to that table.
//
// ## A provider whose credentials are absent is SKIPPED, not failed
//
// Missing VAPI_PRIVATE_KEY must not stop an ElevenLabs sync, and — this is the part that would
// silently destroy things — its versions must not then look like orphans. An unusable driver's
// versions AND its lockfile entries are both left alone. See `skipped` below.
//
// ## ElevenLabs MCP servers are reconciled too, in a phase around the agents
//
// A version that grants `mcpTools` needs a second remote object on ElevenLabs: an MCP SERVER
// REGISTRATION, which the agent then names by id. It is provisioned here rather than in the
// dashboard for exactly the reason the agents are — so the lockfile stays the source of truth — and
// it has to bracket the agent loop, because ElevenLabs refuses to delete a server an agent still
// points at:
//
//   1. create / patch registrations   (ids must exist before an agent body can name them)
//   2. create / patch / retire agents (the existing loop; its body carries `mcp_server_ids`)
//   3. delete orphaned registrations  (only now is nothing attached to them)
//
// Two preconditions are READ and never written: the workspace opt-in (`can_use_mcp_servers`) and
// the workspace secret holding the Authorization header. Both fail with an explanation naming the
// one thing a human has to do. See ./elevenlabs-mcp.ts and
// docs/2026-08-28-elevenlabs-mcp-in-code.md.
//
// Usage:
//   pnpm sync:agents                 apply the plan (prune = retire)
//   pnpm sync:agents --dry-run       print the plan, change nothing (no credentials needed)
//   pnpm sync:agents --prune=delete  hard-delete agents whose version file was removed
//   pnpm sync:agents --prune=none    never remove; just warn about orphans
//   pnpm sync:agents --force         re-PATCH every version even if the hash is unchanged
//   pnpm sync:agents --provider=vapi restrict the run to one provider
//   pnpm sync:agents --allow-dev-mcp-url  point the MCP registration at MCP_PUBLIC_URL instead of
//                                    the deployed origin. The workspace is SHARED WITH PRODUCTION,
//                                    so this repoints the live agents — see ./elevenlabs-mcp.ts.
//
// Reads ELEVENLABS_API_KEY + ELEVENLABS_TEACHER_VOICE_ID and VAPI_PRIVATE_KEY (plus optional
// LIVE_STORY_LLM, LIVE_STORY_TTS_MODEL, MCP_PUBLIC_URL) from .env / .env.local — no key ever leaves
// your machine. MCP_TOKEN is deliberately NOT read: ElevenLabs already holds that credential as a
// workspace secret, so nothing here has to carry it there.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import process from "node:process";
import dotenv from "dotenv";
import type { TutorProviderId } from "@tutor/shared/tutor/transport";
import {
  effectiveConfig,
  elevenLabsVersions,
  vapiVersions,
  type EffectiveAgentConfig,
} from "./prompts";
import type { PromptVersion } from "./prompts";
import { vapiConfig } from "../lib/config";
import {
  EL_MCP_API,
  EL_SECRETS_API,
  EL_SETTINGS_API,
  MCP_SECRET_NAME,
  elevenLabsMcpRegistrations,
  mcpCreateBody,
  mcpGrantKey,
  mcpIdentity,
  mcpPatchBody,
  type ElevenLabsMcpRegistration,
} from "./elevenlabs-mcp";
import { VAPI_API, vapiAssistantBody } from "./vapi-assistant";

const here = dirname(fileURLToPath(import.meta.url)); // src/agent
const root = join(here, "..", "..");
for (const f of [".env", ".env.local"]) dotenv.config({ path: join(root, f) });

const LOCK_PATH = join(here, "agents.lock.json");
const EL_API = "https://api.elevenlabs.io/v1/convai/agents";
// Per-session grounding is injected at runtime via the items_list dynamic variable; this is just
// the placeholder default the agent validates its prompt against (must match {{items_list}}).
const ITEMS_PLACEHOLDER = "1. ephemeral; 2. break the ice; 3. I couldn't agree more";
const RETIRED_SUFFIX = " [retired]";

// ── flags ────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const force = argv.includes("--force");
const pruneArg = (argv.find((a) => a.startsWith("--prune=")) ?? "--prune=retire").split("=")[1];
const prune = pruneArg === "delete" || pruneArg === "none" ? pruneArg : "retire";
const onlyProvider = argv.find((a) => a.startsWith("--provider="))?.split("=")[1];
const allowDevMcpUrl = argv.includes("--allow-dev-mcp-url");

// ── lockfile shape ─────────────────────────────────────────────────────────────────────────
type Status = "active" | "retired";
interface LockEntry {
  agentId: string;
  status: Status;
  hash: string;
  name: string;
  updatedAt: string;
  /**
   * Which provider holds this id. OPTIONAL, and absent means `"elevenlabs"` — every entry written
   * before Vapi existed omits it and must keep meaning what it meant.
   *
   * Load-bearing for pruning: an orphaned entry has no version file left to ask, so this is the only
   * record of which API can retire or delete it. Without it a stale Vapi assistant id would be sent
   * to ElevenLabs.
   */
  provider?: TutorProviderId;
  /**
   * The MCP server ids this agent was last PATCHed with. ELEVENLABS ONLY, and absent means none —
   * which is every entry written before MCP existed and every agent that grants no tools.
   *
   * Recorded rather than derived because the agent hash covers the version's GRANT (a stable list of
   * tool names) and not the registration id, so that `--dry-run` can plan offline. Without this
   * field a registration that was deleted and recreated would leave every agent pointing at a dead
   * id with an unchanged hash — a silent noop forever. Compared against the live registration in
   * `buildPlan`, where a mismatch forces the update the hash cannot see.
   */
  mcpServerIds?: string[];
}

/**
 * One provisioned ElevenLabs MCP server registration, keyed by the GRANT SET it serves
 * (`mcpGrantKey`) rather than by a version — several versions granting the same tools share one.
 */
interface McpLockEntry {
  /** Always `"elevenlabs"` today; present so an orphan can name the API that owns it, like agents. */
  provider: TutorProviderId;
  serverId: string;
  /** `MCP_AUTHORIZATION_HEADER`'s id, as resolved at the last apply. Not a secret — an id. */
  secretId: string;
  /**
   * Over `url` + `name` + `description` + `transport`: the fields ElevenLabs will NOT let you PATCH.
   * A diff here is a REPLACE (create, move the agents, delete the old), not an update.
   */
  identityHash: string;
  /** Over the PATCHable half of the body. A diff here is one PATCH in place; the id survives. */
  configHash: string;
  name: string;
  updatedAt: string;
}

interface Lockfile {
  version: number;
  note?: string;
  agents: Record<string, LockEntry>;
  /** Absent in a v1 lockfile, and absent whenever no version grants MCP tools. */
  mcpServers: Record<string, McpLockEntry>;
}

function readLock(): Lockfile {
  try {
    const parsed = JSON.parse(readFileSync(LOCK_PATH, "utf8")) as Partial<Lockfile>;
    return {
      version: parsed.version ?? 1,
      note: parsed.note,
      agents: parsed.agents ?? {},
      mcpServers: parsed.mcpServers ?? {},
    };
  } catch {
    return { version: 1, agents: {}, mcpServers: {} };
  }
}

/**
 * Written key by key rather than as a spread, because this function DROPS anything it does not
 * know about — which is how the `mcpServers` section would have been silently deleted on the first
 * sync after someone added it by hand. `mcpServers` is omitted while empty so a registry that
 * grants nothing keeps producing the lockfile it always produced.
 */
function writeLock(lock: Lockfile): void {
  const out: Record<string, unknown> = { version: lock.version };
  if (lock.note !== undefined) out.note = lock.note;
  if (Object.keys(lock.mcpServers).length > 0) out.mcpServers = lock.mcpServers;
  out.agents = lock.agents;
  writeFileSync(LOCK_PATH, JSON.stringify(out, null, 2) + "\n");
}

/** The provider an existing lock entry belongs to. Legacy entries predate the field. */
function entryProvider(e: LockEntry): TutorProviderId {
  return e.provider ?? "elevenlabs";
}

// ── hashing ────────────────────────────────────────────────────────────────────────────────
/**
 * The ElevenLabs hash. **Do not reorder or add fields casually** — this is what decides
 * "unchanged", and any edit re-PATCHes every existing agent to send an identical body.
 *
 * Left byte-for-byte as it was when Vapi was added, which is why it is a per-provider function
 * rather than one shared hash over `EffectiveAgentConfig`: a shared hash would have had to include
 * fields ElevenLabs does not bake, changing every hash already in the lockfile.
 */
function elevenLabsHash(c: EffectiveAgentConfig): string {
  const canonical = JSON.stringify({
    version: c.version,
    prompt: c.prompt,
    llm: c.llm,
    voiceId: c.voiceId ?? null,
    ttsModelId: c.ttsModelId,
    additionalLanguages: c.additionalLanguages,
    // Mirrors agentBody(): OMITTED when unset, so the four versions pinned before max_tokens
    // existed keep the hashes already in the lockfile and sync doesn't PATCH them to send an
    // identical body.
    ...(c.maxTokens === undefined ? {} : { maxTokens: c.maxTokens }),
    ...(c.turnEagerness === undefined ? {} : { turnEagerness: c.turnEagerness }),
    // Anything added to agentBody() MUST be added here too, or sync reports "unchanged" while the
    // live agent keeps the old value — the exact silent drift the lockfile exists to prevent.
    maxDurationSeconds: c.maxDurationSeconds,
    turnTimeoutSeconds: c.turnTimeoutSeconds,
    silenceEndCallTimeoutSeconds: c.silenceEndCallTimeoutSeconds,
    /**
     * ALWAYS present, including as `[]` — the one field here that is not omitted when empty, and
     * the reason every existing ElevenLabs agent is re-PATCHed once on the sync that introduces it.
     *
     * Omitting it would have kept those hashes, and it would also have made a grant impossible to
     * REVOKE: `PATCH /v1/convai/agents/{id}` patches what it is given, so a body without
     * `mcp_server_ids` leaves the live agent attached — and with the field omitted from the hash
     * too, removing `mcpTools` from a version would restore its old hash and report "unchanged"
     * forever. One re-PATCH of one agent is cheaper than a plan state that exists to work around
     * that. See docs/2026-08-28-elevenlabs-mcp-in-code.md §7.4.
     *
     * It hashes the GRANT and not the resolved server ids, so `--dry-run` can plan before any
     * registration exists. Id drift is caught separately, by `LockEntry.mcpServerIds`.
     */
    mcpTools: c.mcpTools,
  });
  return "sha256:" + createHash("sha256").update(canonical).digest("hex");
}

/**
 * The Vapi hash — over the BODY THAT WILL BE SENT, not over the config.
 *
 * The ElevenLabs hash above enumerates config fields by hand and carries a warning that forgetting
 * one causes silent drift. Vapi has no legacy hashes to preserve, so it can do the safer thing:
 * hash `vapiAssistantBody()` itself. A field added to the body cannot then be forgotten here,
 * because there is nowhere to forget it — the two are the same object.
 *
 * Note this makes the hash sensitive to `turnTimeoutSeconds` NOT appearing: that field has no Vapi
 * counterpart, so changing it on a Vapi version correctly produces no update.
 */
function vapiHash(c: EffectiveAgentConfig): string {
  return (
    "sha256:" +
    createHash("sha256").update(JSON.stringify(vapiBody(c))).digest("hex")
  );
}

// ── HTTP ───────────────────────────────────────────────────────────────────────────────────
async function callApi(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${method} ${url}\n  ${text}`);
  return text ? JSON.parse(text) : {};
}

// ── ElevenLabs body ────────────────────────────────────────────────────────────────────────
function agentBody(c: EffectiveAgentConfig) {
  const language_presets = Object.fromEntries(
    c.additionalLanguages.map((lang) => [lang, { overrides: { agent: { language: lang } } }]),
  );
  return {
    name: c.name,
    conversation_config: {
      agent: {
        // max_tokens is omitted rather than sent as -1 when a version doesn't set it, so a version
        // pinned before this field existed keeps a byte-identical body. See prompts/types.ts.
        prompt: {
          prompt: c.prompt,
          llm: c.llm,
          ...(c.maxTokens === undefined ? {} : { max_tokens: c.maxTokens }),
        },
        first_message: "", // teaching begins on the kickoff contextual update, not a greeting
        language: "en",
        dynamic_variables: {
          dynamic_variable_placeholders: { items_list: ITEMS_PLACEHOLDER },
        },
        // Sent unconditionally, `[]` included — see the note in elevenLabsHash(). Resolved from the
        // lockfile at APPLY time, which is safe because the MCP phase runs first and has already
        // written any newly-created registration into it.
        mcp_server_ids: mcpServerIdsFor(c),
      },
      tts: { model_id: c.ttsModelId, voice_id: c.voiceId },
      // ElevenLabs' default is 600s, which ends a lesson at ten minutes. Accepted range is
      // 60–7200 (undocumented; the API states it on rejection). See prompts/index.ts.
      conversation: { max_duration_seconds: c.maxDurationSeconds },
      // Both are pinned at the platform's own defaults on purpose: the mobile client's held pause
      // keeps a paused conversation quiet by resetting turn_timeout with a `user_activity`
      // heartbeat, so the value must be one we control rather than one we inherit, and a silence
      // timeout must never hang up a lesson the learner paused deliberately.
      turn: {
        turn_timeout: c.turnTimeoutSeconds,
        silence_end_call_timeout: c.silenceEndCallTimeoutSeconds,
        ...(c.turnEagerness === undefined ? {} : { turn_eagerness: c.turnEagerness }),
      },
      ...(c.additionalLanguages.length > 0 ? { language_presets } : {}),
    },
  };
}

// ── ElevenLabs MCP servers ─────────────────────────────────────────────────────────────────
/**
 * The URL choice, made once. `MCP_PUBLIC_URL` is an OVERRIDE here, not the source — see
 * `DEPLOYED_MCP_URL` in ./elevenlabs-mcp.ts for why this provider cannot take the URL from the
 * environment the way OpenAI does.
 */
const mcpUrlOptions = {
  overrideUrl: process.env.MCP_PUBLIC_URL?.trim() || undefined,
  allowOverride: allowDevMcpUrl,
};

/**
 * Stands in for the secret id while hashing. The id can only be learned from the network, and
 * `--dry-run` must plan without it — so it is kept OUT of the hash and tracked as its own field
 * (`McpLockEntry.secretId`), compared at apply time once the real one is in hand.
 */
const SECRET_ID_PLACEHOLDER = "<secret_id>";

const sha = (s: string) => "sha256:" + createHash("sha256").update(s).digest("hex");

/** Over the create-only half. A diff means the registration must be REPLACED — see McpLockEntry. */
const mcpIdentityHash = (reg: ElevenLabsMcpRegistration) => sha(JSON.stringify(mcpIdentity(reg)));

/**
 * Over the PATCHable half — the Vapi rule (hash the body that will be sent), so a field added to
 * `mcpPatchBody` cannot be forgotten here. It takes no registration because the mutable config is
 * identical for every one of them: it is entirely `REGISTRATION_DEFAULTS` plus the secret.
 */
const mcpConfigHash = () => sha(JSON.stringify(mcpPatchBody(SECRET_ID_PLACEHOLDER)));

type McpAction =
  | { kind: "create"; key: string; reg: ElevenLabsMcpRegistration }
  | { kind: "replace"; key: string; reg: ElevenLabsMcpRegistration; entry: McpLockEntry }
  | { kind: "patch"; key: string; reg: ElevenLabsMcpRegistration; entry: McpLockEntry }
  | { kind: "noop"; key: string; reg: ElevenLabsMcpRegistration; entry: McpLockEntry }
  | { kind: "delete"; key: string; entry: McpLockEntry };

/**
 * What the versions on disk require, or a fatal error explaining why they cannot have it.
 *
 * Exits rather than returning a result, and does so even on `--dry-run`, because every check inside
 * `elevenLabsMcpRegistrations` is offline: a plan printed against a URL that would be refused on
 * apply is a plan that lies.
 */
function desiredMcpRegistrations(elRunning: boolean): ElevenLabsMcpRegistration[] {
  if (!elRunning) return [];
  const result = elevenLabsMcpRegistrations(elevenLabsVersions(), mcpUrlOptions);
  if (!result.ok) {
    console.error(`✗ elevenlabs MCP: ${result.reason}`);
    process.exit(1);
  }
  return result.registrations;
}

/**
 * Orphans are pruned unconditionally — there is no `--prune=retire` equivalent for a registration,
 * because "retire" means renaming an agent so a human recognises it and nothing points at a renamed
 * MCP server. A registration nothing grants any more is dead weight holding a URL and a credential.
 */
function buildMcpPlan(
  lock: Lockfile,
  regs: ElevenLabsMcpRegistration[],
  elRunning: boolean,
  secretId: string | undefined,
): McpAction[] {
  // Same rule the agent plan follows: a provider this run did not touch keeps its entries. Without
  // this, `--provider=vapi` would delete the live registration as an orphan.
  if (!elRunning) return [];

  const plan: McpAction[] = [];
  const desired = new Map(regs.map((r) => [r.key, r]));
  for (const [key, reg] of desired) {
    const entry = lock.mcpServers[key];
    // `secretId` is undefined on a dry run, which never resolves it — so a secret recreated under
    // the same name shows up as a patch only on the run that could act on it. That is the one
    // difference between a planned run and an applied one, and it errs toward doing MORE.
    const secretMoved = secretId !== undefined && entry?.secretId !== secretId;
    if (!entry) plan.push({ kind: "create", key, reg });
    else if (force || entry.identityHash !== mcpIdentityHash(reg))
      plan.push({ kind: "replace", key, reg, entry });
    else if (entry.configHash !== mcpConfigHash() || secretMoved)
      plan.push({ kind: "patch", key, reg, entry });
    else plan.push({ kind: "noop", key, reg, entry });
  }
  for (const [key, entry] of Object.entries(lock.mcpServers)) {
    if (!desired.has(key)) plan.push({ kind: "delete", key, entry });
  }
  return plan;
}

/** The registrations whose id will move, so `buildPlan` can force the agents onto the new one. */
function mcpKeysGettingNewIds(mcpPlan: McpAction[]): Set<string> {
  return new Set(
    mcpPlan.filter((a) => a.kind === "create" || a.kind === "replace").map((a) => a.key),
  );
}

/**
 * A version's `mcp_server_ids`, read from the lockfile. `[]` for a version that grants nothing, and
 * also `[]` for one whose registration does not exist yet — which is only ever the state a `--dry-run`
 * sees, because the apply path creates registrations before it touches an agent.
 */
function mcpServerIdsFor(c: EffectiveAgentConfig): string[] {
  if (c.mcpTools.length === 0) return [];
  const entry = lock.mcpServers[mcpGrantKey(c.mcpTools)];
  return entry ? [entry.serverId] : [];
}

const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * What to record on the agent's lock entry after a PATCH. `undefined` rather than `[]` for an agent
 * with no servers, so the field DISAPPEARS from a spread over the previous entry — a revoked grant
 * has to clear the record, not leave a stale id behind it, and `JSON.stringify` drops the key.
 */
function mcpIdsRecord(c: EffectiveAgentConfig): { mcpServerIds: string[] | undefined } {
  const ids = mcpServerIdsFor(c);
  return { mcpServerIds: ids.length > 0 ? ids : undefined };
}

/**
 * The workspace opt-in. MCP is disabled by default for every ElevenLabs workspace, and the switch is
 * a terms acceptance — so this READS it and explains, rather than flipping it. A provisioning script
 * that accepts terms on its own initiative is doing something no other line in this file does.
 */
async function assertMcpEnabled(): Promise<void> {
  const settings = (await callApi("GET", EL_SETTINGS_API, elHeaders())) as {
    can_use_mcp_servers?: boolean;
  };
  if (settings.can_use_mcp_servers) return;
  throw new Error(
    `can_use_mcp_servers is false for this ElevenLabs workspace.\n` +
      `  A version grants MCP tools, but the workspace has not opted in. Enable it once — in the\n` +
      `  dashboard (Agents → Integrations, which shows the MCP terms) or with\n` +
      `  PATCH /v1/convai/settings {"can_use_mcp_servers": true} — then re-run.\n` +
      `  Note: MCP is unavailable entirely in Zero Retention Mode or HIPAA workspaces.`,
  );
}

/**
 * `MCP_AUTHORIZATION_HEADER` → its id. The one read this sync does against the secrets API, and the
 * only relationship it has with that secret: it is created and rotated by a human.
 */
async function resolveMcpSecretId(): Promise<string> {
  const url = `${EL_SECRETS_API}?search=${encodeURIComponent(MCP_SECRET_NAME)}`;
  const data = (await callApi("GET", url, elHeaders())) as {
    secrets?: { secret_id?: string; name?: string }[];
  };
  // `search` is a PREFIX match, so `secrets[0]` could be `MCP_AUTHORIZATION_HEADER_OLD` sitting in
  // the workspace during a rotation. Match the name exactly.
  const hit = (data.secrets ?? []).find((s) => s.name === MCP_SECRET_NAME);
  if (!hit?.secret_id) {
    throw new Error(
      `workspace secret "${MCP_SECRET_NAME}" not found.\n` +
        `  A version grants MCP tools, so the registration needs a credential to present to\n` +
        `  /api/mcp. Create it once in the ElevenLabs dashboard holding the FULL header value —\n` +
        `  "Bearer <MCP_TOKEN>", prefix included — then re-run. lib/mcp/auth.ts requires the scheme,\n` +
        `  so a value stored without it 401s every tool call with nothing local to notice.`,
    );
  }
  return hit.secret_id;
}

async function createMcpServer(reg: ElevenLabsMcpRegistration, secretId: string): Promise<string> {
  const data = (await callApi("POST", EL_MCP_API, elHeaders(), mcpCreateBody(reg, secretId))) as {
    id?: string;
  };
  if (!data.id) throw new Error(`create returned no id for MCP server ${reg.name}`);
  return data.id;
}

// ── drivers ────────────────────────────────────────────────────────────────────────────────
/**
 * Everything that differs between two providers that both have a remote agent object.
 *
 * `unavailable()` returns the REASON a driver cannot run, or null. It is a string rather than a
 * boolean because that reason is printed — a skipped provider must say why, or a sync that quietly
 * did half the work looks like a sync that did all of it.
 */
interface ProviderDriver {
  id: TutorProviderId;
  /** What this provider calls the thing, for log lines. */
  noun: string;
  versions(): PromptVersion[];
  hash(c: EffectiveAgentConfig): string;
  unavailable(): string | null;
  create(c: EffectiveAgentConfig): Promise<string>;
  update(id: string, c: EffectiveAgentConfig): Promise<unknown>;
  rename(id: string, name: string): Promise<unknown>;
  remove(id: string): Promise<unknown>;
}

const elKey = process.env.ELEVENLABS_API_KEY?.trim() ?? "";
const elVoice = process.env.ELEVENLABS_TEACHER_VOICE_ID?.trim() ?? "";
const vapiKey = process.env.VAPI_PRIVATE_KEY?.trim() ?? "";
const { webhookUrl, webhookSecret } = vapiConfig();
const vapiServer = { url: webhookUrl, secret: webhookSecret };

function vapiBody(c: EffectiveAgentConfig) {
  return vapiAssistantBody(c, vapiServer);
}

const elHeaders = () => ({ "xi-api-key": elKey });
const vapiHeaders = () => ({ authorization: `Bearer ${vapiKey}` });

const elevenLabs: ProviderDriver = {
  id: "elevenlabs",
  noun: "agent",
  versions: elevenLabsVersions,
  hash: elevenLabsHash,
  unavailable() {
    if (!elKey) return "ELEVENLABS_API_KEY is not set";
    // Only versions actually baked into an agent need a voice.
    if (!elVoice && elevenLabsVersions().some((v) => !v.voiceId)) {
      return "ELEVENLABS_TEACHER_VOICE_ID is not set and a version does not pin one";
    }
    return null;
  },
  async create(c) {
    const data = (await callApi("POST", `${EL_API}/create`, elHeaders(), agentBody(c))) as {
      agent_id?: string;
    };
    if (!data.agent_id) throw new Error(`create returned no agent_id for ${c.version}`);
    return data.agent_id;
  },
  update: (id, c) => callApi("PATCH", `${EL_API}/${id}`, elHeaders(), agentBody(c)),
  rename: (id, name) => callApi("PATCH", `${EL_API}/${id}`, elHeaders(), { name }),
  remove: (id) => callApi("DELETE", `${EL_API}/${id}`, elHeaders()),
};

const vapi: ProviderDriver = {
  id: "vapi",
  noun: "assistant",
  versions: vapiVersions,
  hash: vapiHash,
  unavailable: () => (vapiKey ? null : "VAPI_PRIVATE_KEY is not set"),
  async create(c) {
    const data = (await callApi(
      "POST",
      `${VAPI_API}/assistant`,
      vapiHeaders(),
      vapiBody(c),
    )) as { id?: string };
    if (!data.id) throw new Error(`create returned no id for ${c.version}`);
    return data.id;
  },
  update: (id, c) =>
    callApi("PATCH", `${VAPI_API}/assistant/${id}`, vapiHeaders(), vapiBody(c)),
  rename: (id, name) => callApi("PATCH", `${VAPI_API}/assistant/${id}`, vapiHeaders(), { name }),
  remove: (id) => callApi("DELETE", `${VAPI_API}/assistant/${id}`, vapiHeaders()),
};

const DRIVERS: ProviderDriver[] = [elevenLabs, vapi];
const driverFor = (id: TutorProviderId) => DRIVERS.find((d) => d.id === id);

// ── plan ───────────────────────────────────────────────────────────────────────────────────
type Action =
  | { kind: "create"; version: string; cfg: EffectiveAgentConfig; hash: string; driver: ProviderDriver }
  | { kind: "update"; version: string; cfg: EffectiveAgentConfig; hash: string; entry: LockEntry; driver: ProviderDriver }
  | { kind: "unretire"; version: string; cfg: EffectiveAgentConfig; hash: string; entry: LockEntry; driver: ProviderDriver }
  | { kind: "noop"; version: string; entry: LockEntry; driver: ProviderDriver }
  | { kind: "retire"; version: string; entry: LockEntry; driver: ProviderDriver }
  | { kind: "delete"; version: string; entry: LockEntry; driver: ProviderDriver }
  | { kind: "orphan"; version: string; entry: LockEntry; driver: ProviderDriver | undefined };

/** Drivers this run will touch: selected by --provider, minus any that cannot run. */
function activeDrivers(): { run: ProviderDriver[]; skipped: { d: ProviderDriver; why: string }[] } {
  const run: ProviderDriver[] = [];
  const skipped: { d: ProviderDriver; why: string }[] = [];
  for (const d of DRIVERS) {
    if (onlyProvider && d.id !== onlyProvider) {
      skipped.push({ d, why: `--provider=${onlyProvider}` });
      continue;
    }
    // A dry run makes no requests, so it must not need credentials — `sync:agents:plan` has to work
    // on a machine that holds none. Applying without them is still fatal, below.
    const why = dryRun ? null : d.unavailable();
    if (why) skipped.push({ d, why });
    else run.push(d);
  }
  return { run, skipped };
}

function buildPlan(lock: Lockfile, run: ProviderDriver[], movingMcpKeys: Set<string>): Action[] {
  const plan: Action[] = [];
  const desired = new Map<string, { cfg: EffectiveAgentConfig; driver: ProviderDriver }>();
  for (const driver of run) {
    for (const v of driver.versions()) desired.set(v.version, { cfg: effectiveConfig(v), driver });
  }

  for (const [version, { cfg, driver }] of desired) {
    const hash = driver.hash(cfg);
    const entry = lock.agents[version];
    /**
     * Two reasons to PATCH an agent whose hash says "unchanged", both of them about an MCP server id
     * the hash deliberately does not cover:
     *
     *  - its registration is about to be created or replaced, so the id it must carry does not exist
     *    yet — without this the agent would be left pointing at nothing, or at a server phase 3 is
     *    about to delete;
     *  - the ids it was last PATCHed with differ from the ones the lockfile now holds, which is what
     *    a registration recreated out-of-band looks like.
     */
    const mcpMoved =
      cfg.mcpTools.length > 0 && movingMcpKeys.has(mcpGrantKey(cfg.mcpTools));
    const mcpDrifted = !sameIds(entry?.mcpServerIds ?? [], mcpServerIdsFor(cfg));
    if (!entry) plan.push({ kind: "create", version, cfg, hash, driver });
    else if (entry.status === "retired")
      plan.push({ kind: "unretire", version, cfg, hash, entry, driver });
    else if (force || entry.hash !== hash || mcpMoved || mcpDrifted)
      plan.push({ kind: "update", version, cfg, hash, entry, driver });
    else plan.push({ kind: "noop", version, entry, driver });
  }

  const runnable = new Set(run.map((d) => d.id));
  for (const [version, entry] of Object.entries(lock.agents)) {
    if (desired.has(version) || entry.status === "retired") continue;
    // An entry belonging to a provider this run did not touch is NOT an orphan — we simply did not
    // look. Pruning it would retire a live agent because a key was missing from the environment.
    if (!runnable.has(entryProvider(entry))) continue;
    const driver = driverFor(entryProvider(entry));
    if (prune === "delete") plan.push({ kind: "delete", version, entry, driver: driver! });
    else if (prune === "none") plan.push({ kind: "orphan", version, entry, driver });
    else plan.push({ kind: "retire", version, entry, driver: driver! });
  }
  return plan;
}

const ICON: Record<Action["kind"], string> = {
  create: "＋ create  ",
  update: "～ update  ",
  unretire: "↺ unretire",
  noop: "· no-op    ",
  retire: "⌁ retire  ",
  delete: "✗ delete  ",
  orphan: "! orphan  ",
};

const MCP_ICON: Record<McpAction["kind"], string> = {
  create: "＋ mcp+    ",
  replace: "⇄ mcp↻    ",
  patch: "～ mcp~    ",
  noop: "· mcp      ",
  delete: "✗ mcp-    ",
};

// ── run ────────────────────────────────────────────────────────────────────────────────────
const { run, skipped } = activeDrivers();

if (run.length === 0) {
  console.error("✗ No provider can run:");
  for (const { d, why } of skipped) console.error(`    ${d.id}: ${why}`);
  process.exit(1);
}

const lock = readLock();
const elRunning = run.some((d) => d.id === "elevenlabs");
const mcpRegistrations = desiredMcpRegistrations(elRunning);

/**
 * The two read-only preconditions, checked BEFORE the plan is printed rather than at apply time.
 *
 * Both are things only a human can fix, so a plan printed without them is a plan that cannot be
 * executed — and the secret id is also an input to the plan (a secret recreated under the same name
 * is a PATCH nothing else can see). A dry run deliberately does neither: it must work on a machine
 * holding no credentials.
 */
let mcpSecretId: string | undefined;
if (!dryRun && mcpRegistrations.length > 0) {
  try {
    await assertMcpEnabled();
    mcpSecretId = await resolveMcpSecretId();
  } catch (e) {
    console.error(`✗ elevenlabs MCP: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

const mcpPlan = buildMcpPlan(lock, mcpRegistrations, elRunning, mcpSecretId);
const plan = buildPlan(lock, run, mcpKeysGettingNewIds(mcpPlan));

console.log(
  `▶ sync:agents${dryRun ? "  (dry run)" : ""}   prune=${prune}${force ? "  force" : ""}` +
    `   providers=${run.map((d) => d.id).join(",")}`,
);
for (const { d, why } of skipped) {
  const n = d.versions().length;
  console.log(`  ⊘ skipped ${d.id} (${why})${n ? ` — ${n} version(s) and their ids left alone` : ""}`);
}
for (const a of mcpPlan) console.log(`  ${MCP_ICON[a.kind]}  ${a.key}  [elevenlabs mcp server]`);
for (const a of plan) console.log(`  ${ICON[a.kind]}  ${a.version}  [${a.driver?.id ?? "?"}]`);

const mcpChanges = mcpPlan.filter((a) => a.kind !== "noop");
const changes = plan.filter((a) => a.kind !== "noop" && a.kind !== "orphan");
if (changes.length === 0 && mcpChanges.length === 0) {
  console.log("\n✅ nothing to do — every provider already matches the registry.");
  process.exit(0);
}
if (dryRun) {
  const n = changes.length + mcpChanges.length;
  console.log(`\n${n} change(s) planned. Re-run without --dry-run to apply.`);
  process.exit(0);
}

const now = new Date().toISOString();
let applied = 0;

/**
 * Server ids superseded by a REPLACE. They cannot be deleted until phase 2 has moved every agent off
 * them, so they queue here and are deleted alongside the orphans in phase 3.
 */
const retiredMcpServerIds: { key: string; id: string }[] = [];

/**
 * ── Phase 1: MCP registrations, before any agent body can name one ────────────────────────────
 *
 * Deletes are NOT here. ElevenLabs refuses to delete a server an agent still points at, so an
 * orphaned registration can only go after phase 2 has detached it (phase 3, at the end of the file).
 */
if (mcpSecretId !== undefined) {
  const secretId = mcpSecretId;
  try {
    for (const a of mcpPlan) {
      if (a.kind === "create" || a.kind === "replace") {
        const serverId = await createMcpServer(a.reg, secretId);
        // A replace leaves the OLD server in place until phase 3: agents are still pointing at it.
        const replacing = a.kind === "replace" ? a.entry.serverId : undefined;
        lock.mcpServers[a.key] = {
          provider: "elevenlabs",
          serverId,
          secretId,
          identityHash: mcpIdentityHash(a.reg),
          configHash: mcpConfigHash(),
          name: a.reg.name,
          updatedAt: now,
        };
        if (replacing) retiredMcpServerIds.push({ key: a.key, id: replacing });
        console.log(
          `  ${a.kind === "create" ? "＋" : "⇄"} mcp ${a.key} → ${serverId}` +
            (replacing ? `  (replacing ${replacing})` : ""),
        );
        applied++;
      } else if (a.kind === "patch") {
        await callApi(
          "PATCH",
          `${EL_MCP_API}/${a.entry.serverId}`,
          elHeaders(),
          mcpPatchBody(secretId),
        );
        lock.mcpServers[a.key] = {
          ...a.entry,
          secretId,
          configHash: mcpConfigHash(),
          updatedAt: now,
        };
        console.log(`  ～ mcp ${a.key} (${a.entry.serverId})`);
        applied++;
      }
      writeLock(lock);
    }
  } catch (e) {
    console.error(`\n✗ MCP phase failed:\n  ${e instanceof Error ? e.message : String(e)}`);
    console.error("  No agent was touched. Fix the cause and re-run.");
    process.exit(1);
  }
}
for (const a of plan) {
  try {
    switch (a.kind) {
      case "create": {
        const id = await a.driver.create(a.cfg);
        lock.agents[a.version] = {
          agentId: id,
          status: "active",
          hash: a.hash,
          name: a.cfg.name,
          updatedAt: now,
          provider: a.driver.id,
          ...mcpIdsRecord(a.cfg),
        };
        console.log(`  ＋ ${a.version} → ${id}  [${a.driver.id} ${a.driver.noun}]`);
        applied++;
        break;
      }
      case "update": {
        await a.driver.update(a.entry.agentId, a.cfg);
        lock.agents[a.version] = {
          ...a.entry,
          status: "active",
          hash: a.hash,
          name: a.cfg.name,
          updatedAt: now,
          provider: a.driver.id,
          ...mcpIdsRecord(a.cfg),
        };
        console.log(`  ～ ${a.version} (${a.entry.agentId})  [${a.driver.id}]`);
        applied++;
        break;
      }
      case "unretire": {
        await a.driver.update(a.entry.agentId, a.cfg); // restore name + push current config
        lock.agents[a.version] = {
          ...a.entry,
          status: "active",
          hash: a.hash,
          name: a.cfg.name,
          updatedAt: now,
          provider: a.driver.id,
          ...mcpIdsRecord(a.cfg),
        };
        console.log(`  ↺ ${a.version} (${a.entry.agentId})  [${a.driver.id}]`);
        applied++;
        break;
      }
      case "retire": {
        await a.driver.rename(a.entry.agentId, a.entry.name + RETIRED_SUFFIX);
        lock.agents[a.version] = { ...a.entry, status: "retired", updatedAt: now };
        console.log(`  ⌁ ${a.version} retired (${a.entry.agentId})  [${a.driver.id}]`);
        applied++;
        break;
      }
      case "delete": {
        await a.driver.remove(a.entry.agentId);
        delete lock.agents[a.version];
        console.log(`  ✗ ${a.version} deleted (${a.entry.agentId})  [${a.driver.id}]`);
        applied++;
        break;
      }
      default:
        break;
    }
    writeLock(lock); // persist after each step so a mid-run failure leaves a consistent lockfile
  } catch (e) {
    console.error(`\n✗ ${a.kind} ${a.version} failed:\n  ${e instanceof Error ? e.message : String(e)}`);
    console.error("  Lockfile saved up to the last successful step. Fix the cause and re-run.");
    process.exit(1);
  }
}

/**
 * ── Phase 3: MCP registrations nothing points at any more ─────────────────────────────────────
 *
 * Last on purpose. Both lists can only be deleted now that phase 2 has PATCHed every agent onto the
 * ids it should be carrying: orphans (no version grants that tool set) and the servers superseded by
 * a replace. A failure here is NOT fatal — the agents are already correct and the only cost is a
 * registration lingering in the dashboard, which the next sync will try again.
 */
const deadMcpServers: { key: string; id: string; orphan: boolean }[] = [
  ...mcpPlan.flatMap((a) =>
    a.kind === "delete" ? [{ key: a.key, id: a.entry.serverId, orphan: true }] : [],
  ),
  ...retiredMcpServerIds.map(({ key, id }) => ({ key, id, orphan: false })),
];
for (const { key, id, orphan } of deadMcpServers) {
  try {
    await callApi("DELETE", `${EL_MCP_API}/${id}`, elHeaders());
    // Only an ORPHAN's lock entry goes: a superseded id's entry already names its replacement.
    if (orphan) delete lock.mcpServers[key];
    writeLock(lock);
    console.log(`  ✗ mcp ${key} deleted (${id})${orphan ? "" : "  — superseded"}`);
    applied++;
  } catch (e) {
    console.error(`  ! could not delete MCP server ${id} (${key}):`);
    console.error(`      ${e instanceof Error ? e.message : String(e)}`);
    console.error("      The agents are correct; this registration is orphaned. Re-run, or remove it");
    console.error("      in the dashboard. A 'still in use' error means an agent outside this repo.");
  }
}

console.log(`\n✅ applied ${applied} change(s). Lockfile updated: src/agent/agents.lock.json`);
console.log("   Commit agents.lock.json so every environment shares these agent ids.");
