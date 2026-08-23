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
// Usage:
//   pnpm sync:agents                 apply the plan (prune = retire)
//   pnpm sync:agents --dry-run       print the plan, change nothing (no credentials needed)
//   pnpm sync:agents --prune=delete  hard-delete agents whose version file was removed
//   pnpm sync:agents --prune=none    never remove; just warn about orphans
//   pnpm sync:agents --force         re-PATCH every version even if the hash is unchanged
//   pnpm sync:agents --provider=vapi restrict the run to one provider
//
// Reads ELEVENLABS_API_KEY + ELEVENLABS_TEACHER_VOICE_ID and VAPI_PRIVATE_KEY (plus optional
// LIVE_STORY_LLM, LIVE_STORY_TTS_MODEL) from .env / .env.local — no key ever leaves your machine.

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
  return "sha256:" + createHash("sha256").update(JSON.stringify(vapiAssistantBody(c))).digest("hex");
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
      vapiAssistantBody(c),
    )) as { id?: string };
    if (!data.id) throw new Error(`create returned no id for ${c.version}`);
    return data.id;
  },
  update: (id, c) =>
    callApi("PATCH", `${VAPI_API}/assistant/${id}`, vapiHeaders(), vapiAssistantBody(c)),
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

function buildPlan(lock: Lockfile, run: ProviderDriver[]): Action[] {
  const plan: Action[] = [];
  const desired = new Map<string, { cfg: EffectiveAgentConfig; driver: ProviderDriver }>();
  for (const driver of run) {
    for (const v of driver.versions()) desired.set(v.version, { cfg: effectiveConfig(v), driver });
  }

  for (const [version, { cfg, driver }] of desired) {
    const hash = driver.hash(cfg);
    const entry = lock.agents[version];
    if (!entry) plan.push({ kind: "create", version, cfg, hash, driver });
    else if (entry.status === "retired")
      plan.push({ kind: "unretire", version, cfg, hash, entry, driver });
    else if (force || entry.hash !== hash)
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

// ── run ────────────────────────────────────────────────────────────────────────────────────
const { run, skipped } = activeDrivers();

if (run.length === 0) {
  console.error("✗ No provider can run:");
  for (const { d, why } of skipped) console.error(`    ${d.id}: ${why}`);
  process.exit(1);
}

const lock = readLock();
const plan = buildPlan(lock, run);

console.log(
  `▶ sync:agents${dryRun ? "  (dry run)" : ""}   prune=${prune}${force ? "  force" : ""}` +
    `   providers=${run.map((d) => d.id).join(",")}`,
);
for (const { d, why } of skipped) {
  const n = d.versions().length;
  console.log(`  ⊘ skipped ${d.id} (${why})${n ? ` — ${n} version(s) and their ids left alone` : ""}`);
}
for (const a of plan) console.log(`  ${ICON[a.kind]}  ${a.version}  [${a.driver?.id ?? "?"}]`);

const changes = plan.filter((a) => a.kind !== "noop" && a.kind !== "orphan");
if (changes.length === 0) {
  console.log("\n✅ nothing to do — every provider already matches the registry.");
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
        const id = await a.driver.create(a.cfg);
        lock.agents[a.version] = {
          agentId: id,
          status: "active",
          hash: a.hash,
          name: a.cfg.name,
          updatedAt: now,
          provider: a.driver.id,
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

console.log(`\n✅ applied ${applied} change(s). Lockfile updated: src/agent/agents.lock.json`);
console.log("   Commit agents.lock.json so every environment shares these agent ids.");
