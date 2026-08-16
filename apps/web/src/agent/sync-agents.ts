// Reconcile ElevenLabs Conversational AI agents with the prompt-version registry on disk.
//
// The FILESYSTEM (src/agent/prompts/) is the source of truth. This command makes ElevenLabs
// match it and records the version→agent_id mapping in src/agent/agents.lock.json:
//
//   • a new version file            → CREATE a new agent
//   • a changed version (hash diff) → PATCH the SAME agent in place (id, URLs, analytics survive)
//   • an unchanged version          → no-op
//   • a version removed from disk   → PRUNE: retire (default) | delete | leave
//
// It is IDEMPOTENT — re-running with no changes does nothing — and replaces the old
// non-idempotent `provision:agent` (which created a fresh agent every run).
//
// Usage:
//   pnpm sync:agents                 apply the plan (prune = retire)
//   pnpm sync:agents --dry-run       print the plan, change nothing
//   pnpm sync:agents --prune=delete  hard-delete agents whose version file was removed
//   pnpm sync:agents --prune=none    never remove; just warn about orphans
//   pnpm sync:agents --force         re-PATCH every version even if the hash is unchanged
//
// Reads ELEVENLABS_API_KEY + ELEVENLABS_TEACHER_VOICE_ID (and optional LIVE_STORY_LLM,
// LIVE_STORY_TTS_MODEL) from .env / .env.local — the api key never leaves your machine.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import process from "node:process";
import dotenv from "dotenv";
import { PROMPT_VERSIONS, effectiveConfig, type EffectiveAgentConfig } from "./prompts";

const here = dirname(fileURLToPath(import.meta.url)); // src/agent
const root = join(here, "..", "..");
for (const f of [".env", ".env.local"]) dotenv.config({ path: join(root, f) });

const LOCK_PATH = join(here, "agents.lock.json");
const API = "https://api.elevenlabs.io/v1/convai/agents";
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

// ── lockfile shape ─────────────────────────────────────────────────────────────────────────
type Status = "active" | "retired";
interface LockEntry {
  agentId: string;
  status: Status;
  hash: string;
  name: string;
  updatedAt: string;
}
interface Lockfile {
  version: number;
  note?: string;
  agents: Record<string, LockEntry>;
}

function readLock(): Lockfile {
  try {
    const parsed = JSON.parse(readFileSync(LOCK_PATH, "utf8")) as Partial<Lockfile>;
    return { version: parsed.version ?? 1, note: parsed.note, agents: parsed.agents ?? {} };
  } catch {
    return { version: 1, agents: {} };
  }
}

function writeLock(lock: Lockfile): void {
  writeFileSync(LOCK_PATH, JSON.stringify(lock, null, 2) + "\n");
}

function hashConfig(c: EffectiveAgentConfig): string {
  // Cover everything baked into the agent so a config-only change still triggers a PATCH.
  const canonical = JSON.stringify({
    version: c.version,
    prompt: c.prompt,
    llm: c.llm,
    voiceId: c.voiceId ?? null,
    ttsModelId: c.ttsModelId,
    additionalLanguages: c.additionalLanguages,
    // Anything added to agentBody() MUST be added here too, or sync reports "unchanged" while the
    // live agent keeps the old value — the exact silent drift the lockfile exists to prevent.
    maxDurationSeconds: c.maxDurationSeconds,
    turnTimeoutSeconds: c.turnTimeoutSeconds,
    silenceEndCallTimeoutSeconds: c.silenceEndCallTimeoutSeconds,
  });
  return "sha256:" + createHash("sha256").update(canonical).digest("hex");
}

// ── ElevenLabs calls ───────────────────────────────────────────────────────────────────────
function agentBody(c: EffectiveAgentConfig) {
  const language_presets = Object.fromEntries(
    c.additionalLanguages.map((lang) => [lang, { overrides: { agent: { language: lang } } }]),
  );
  return {
    name: c.name,
    conversation_config: {
      agent: {
        prompt: { prompt: c.prompt, llm: c.llm },
        first_message: "", // teaching begins on the kickoff contextual update, not a greeting
        language: "en",
        dynamic_variables: {
          dynamic_variable_placeholders: { items_list: ITEMS_PLACEHOLDER },
        },
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
      },
      ...(c.additionalLanguages.length > 0 ? { language_presets } : {}),
    },
  };
}

async function elFetch(method: string, url: string, body?: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: { "xi-api-key": apiKey, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${method} ${url}\n  ${text}`);
  return text ? JSON.parse(text) : {};
}

async function createAgent(c: EffectiveAgentConfig): Promise<string> {
  const data = (await elFetch("POST", `${API}/create`, agentBody(c))) as { agent_id?: string };
  if (!data.agent_id) throw new Error(`create returned no agent_id for ${c.version}`);
  return data.agent_id;
}
const updateAgent = (id: string, c: EffectiveAgentConfig) => elFetch("PATCH", `${API}/${id}`, agentBody(c));
const renameAgent = (id: string, name: string) => elFetch("PATCH", `${API}/${id}`, { name });
const deleteAgent = (id: string) => elFetch("DELETE", `${API}/${id}`);

// ── plan ───────────────────────────────────────────────────────────────────────────────────
type Action =
  | { kind: "create"; version: string; cfg: EffectiveAgentConfig; hash: string }
  | { kind: "update"; version: string; cfg: EffectiveAgentConfig; hash: string; entry: LockEntry }
  | { kind: "unretire"; version: string; cfg: EffectiveAgentConfig; hash: string; entry: LockEntry }
  | { kind: "noop"; version: string; entry: LockEntry }
  | { kind: "retire"; version: string; entry: LockEntry }
  | { kind: "delete"; version: string; entry: LockEntry }
  | { kind: "orphan"; version: string; entry: LockEntry };

function buildPlan(lock: Lockfile): Action[] {
  const plan: Action[] = [];
  const desired = new Map(PROMPT_VERSIONS.map((v) => [v.version, effectiveConfig(v)] as const));

  for (const [version, cfg] of desired) {
    const hash = hashConfig(cfg);
    const entry = lock.agents[version];
    if (!entry) plan.push({ kind: "create", version, cfg, hash });
    else if (entry.status === "retired") plan.push({ kind: "unretire", version, cfg, hash, entry });
    else if (force || entry.hash !== hash) plan.push({ kind: "update", version, cfg, hash, entry });
    else plan.push({ kind: "noop", version, entry });
  }

  for (const [version, entry] of Object.entries(lock.agents)) {
    if (desired.has(version) || entry.status === "retired") continue;
    if (prune === "delete") plan.push({ kind: "delete", version, entry });
    else if (prune === "none") plan.push({ kind: "orphan", version, entry });
    else plan.push({ kind: "retire", version, entry });
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

// ── run ────────────────────────────────────────────────────────────────────────────────────
const apiKey = process.env.ELEVENLABS_API_KEY?.trim() ?? "";
const voiceId = process.env.ELEVENLABS_TEACHER_VOICE_ID?.trim();

if (!apiKey) {
  console.error("✗ Missing ELEVENLABS_API_KEY in .env / .env.local");
  process.exit(1);
}
if (!voiceId && PROMPT_VERSIONS.some((v) => !v.voiceId)) {
  console.error("✗ Missing ELEVENLABS_TEACHER_VOICE_ID — agents need a pinned teacher voice.");
  process.exit(1);
}

const lock = readLock();
const plan = buildPlan(lock);

console.log(`▶ sync:agents${dryRun ? "  (dry run)" : ""}   prune=${prune}${force ? "  force" : ""}`);
for (const a of plan) console.log(`  ${ICON[a.kind]}  ${a.version}`);

const changes = plan.filter((a) => a.kind !== "noop" && a.kind !== "orphan");
if (changes.length === 0) {
  console.log("\n✅ nothing to do — ElevenLabs already matches the registry.");
  process.exit(0);
}
if (dryRun) {
  console.log(`\n${changes.length} change(s) planned. Re-run without --dry-run to apply.`);
  process.exit(0);
}

const now = new Date().toISOString();
let applied = 0;
for (const a of plan) {
  try {
    switch (a.kind) {
      case "create": {
        const id = await createAgent(a.cfg);
        lock.agents[a.version] = { agentId: id, status: "active", hash: a.hash, name: a.cfg.name, updatedAt: now };
        console.log(`  ＋ ${a.version} → ${id}`);
        applied++;
        break;
      }
      case "update": {
        await updateAgent(a.entry.agentId, a.cfg);
        lock.agents[a.version] = { ...a.entry, status: "active", hash: a.hash, name: a.cfg.name, updatedAt: now };
        console.log(`  ～ ${a.version} (${a.entry.agentId})`);
        applied++;
        break;
      }
      case "unretire": {
        await updateAgent(a.entry.agentId, a.cfg); // restore name + push current config
        lock.agents[a.version] = { ...a.entry, status: "active", hash: a.hash, name: a.cfg.name, updatedAt: now };
        console.log(`  ↺ ${a.version} (${a.entry.agentId})`);
        applied++;
        break;
      }
      case "retire": {
        await renameAgent(a.entry.agentId, a.entry.name + RETIRED_SUFFIX);
        lock.agents[a.version] = { ...a.entry, status: "retired", updatedAt: now };
        console.log(`  ⌁ ${a.version} retired (${a.entry.agentId})`);
        applied++;
        break;
      }
      case "delete": {
        await deleteAgent(a.entry.agentId);
        delete lock.agents[a.version];
        console.log(`  ✗ ${a.version} deleted (${a.entry.agentId})`);
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

console.log(`\n✅ applied ${applied} change(s). Lockfile updated: src/agent/agents.lock.json`);
console.log("   Commit agents.lock.json so every environment shares these agent ids.");
