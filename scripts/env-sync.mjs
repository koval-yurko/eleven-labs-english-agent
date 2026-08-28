#!/usr/bin/env node
// Sync .env files with the production environment on Vercel (web) and EAS (mobile).
//
//   node scripts/env-sync.mjs diff
//   node scripts/env-sync.mjs push [--apply] [--target web|mobile|all]
//   node scripts/env-sync.mjs pull [--write] [--target web|mobile|all]
//
// Production is the only environment this touches (D9). Plans are the default; mutation
// needs --apply (D6). Values are never printed — only a length and a sha256 prefix (D5).
// Design and rationale: docs/2026-08-28-env-variable-sync.md
//
// Zero dependencies on purpose: this is the tool you want working when node_modules is
// half-installed, which is exactly the state that motivated it (§1.2, D1).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENVIRONMENT = "production"; // D9 — there is deliberately no --env flag.

// D4 — injected by the runtime or the CLI, never a stored variable. Never pushed, stripped on pull.
const DENY_EXACT = new Set(["NEXT_RUNTIME", "NODE_ENV", "CI", "VERCEL", "NX_DAEMON"]);
const DENY_PREFIX = ["VERCEL_", "TURBO_", "EAS_"];
const isDenied = (key) => DENY_EXACT.has(key) || DENY_PREFIX.some((p) => key.startsWith(p));

// MEASURED 2026-08-28, and it contradicts the design doc §2.2: `vercel env pull` returns this
// literal string in place of a `sensitive` value on the production and preview targets. Those
// values are write-only. (§2.2 measured the *development* target, where real values do come
// back — hence the wrong conclusion.) Anything that compares or writes a value must treat this
// as "unknown", never as data: writing it into .env would destroy the real secret.
const UNREADABLE = new Set(["[SENSITIVE]"]);
const isUnreadable = (v) => v === undefined || UNREADABLE.has(v);

const TARGETS = {
  web: { remote: "vercel", dir: join(ROOT, "apps/web"), label: "web → Vercel" },
  mobile: { remote: "eas", dir: join(ROOT, "apps/mobile"), label: "mobile → EAS" },
};

// ── output ───────────────────────────────────────────────────────────────────

const c = process.stdout.isTTY
  ? {
      dim: "\x1b[2m",
      red: "\x1b[31m",
      grn: "\x1b[32m",
      yel: "\x1b[33m",
      bld: "\x1b[1m",
      off: "\x1b[0m",
    }
  : { dim: "", red: "", grn: "", yel: "", bld: "", off: "" };

const say = (s = "") => console.log(s);
const head = (s) => say(`\n${c.bld}${s}${c.off}`);
const warn = (s) => say(`${c.yel}!${c.off} ${s}`);
const fail = (s) => {
  console.error(`${c.red}✖ ${s}${c.off}`);
  process.exit(1);
};

// A value is provable-changed without ever being shown (D5, §5.1).
const fingerprint = (v) =>
  v === undefined
    ? "absent"
    : `len=${v.length} sha=${createHash("sha256").update(v).digest("hex").slice(0, 8)}`;

// ── parsing (§5.3) ───────────────────────────────────────────────────────────

// Handles what both CLIs actually emit: KEY="value" (Vercel quotes everything), \n escapes
// inside quoted values, # comments, blank lines, and an `export ` prefix.
function parseDotenv(text) {
  const out = new Map();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key] = m;
    let value = m[2];
    const q = value[0];
    // A quoted value ends at its CLOSING quote, not at the end of the line: `K="a b"  # note`
    // is a five-character value with a comment beside it. Matching on endsWith('"') instead
    // swallows the quotes into the value, which then gets pushed to the remote with them.
    if (q === '"' || q === "'") {
      let end = -1;
      for (let i = 1; i < value.length; i++) {
        if (q === '"' && value[i] === "\\") i++;
        else if (value[i] === q) {
          end = i;
          break;
        }
      }
      if (end !== -1) {
        value = value.slice(1, end);
        if (q === '"')
          value = value
            .replace(/\\n/g, "\n")
            .replace(/\\r/g, "\r")
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, "\\");
      } else {
        value = value.split(" #")[0].trimEnd(); // unterminated quote: treat as bare
      }
    } else {
      value = value.split(" #")[0].trimEnd(); // trailing inline comment on a bare value
    }
    out.set(key, value);
  }
  return out;
}

// D2 — .env.example is the allowlist. `KEY=` is synced; `#KEY=` is known but never synced.
// A `# secret` annotation anywhere on the line marks the value sensitive (D3).
function parseRegistry(text) {
  const entries = new Map();
  const order = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const commented = line.startsWith("#");
    const body = commented ? line.replace(/^#\s*/, "") : line;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(body);
    if (!m) continue; // a prose comment, not a registry line
    const key = m[1];
    if (entries.has(key)) continue; // first mention wins
    // The annotation is the FIRST comment on the key's own line, not any mention of the word
    // anywhere in it — prose explaining why a key is *not* secret must not mark it secret.
    const hash = body.indexOf("#");
    const note = hash === -1 ? "" : body.slice(hash + 1);
    entries.set(key, {
      key,
      commented,
      secret: /^\s*secret\b/i.test(note), // documentation: this value is a credential
      writeOnly: /^\s*write-only\b/i.test(note), // storage: give up ever reading it back
    });
    order.push(key);
  }
  return { entries, order };
}

// The inverse of parseDotenv. A bare value is only safe while it holds none of the characters
// the parser gives meaning to — an unquoted `a #b` reads back as `a`, and an unquoted newline
// reads back as nothing. Quote-and-escape whenever it is not provably safe, so a pulled file
// round-trips byte-for-byte.
const SAFE_BARE = /^[A-Za-z0-9_./:@+,=-]+$/;
function formatValue(value) {
  if (SAFE_BARE.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
}

// Everything after a value on its line — the whitespace and the `# comment` — so rewriting a
// value does not eat the note beside it. A `#` inside a quoted value is data, not a comment.
function trailingComment(rest) {
  const q = rest[0];
  if (q === '"' || q === "'") {
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === "\\") i++;
      else if (rest[i] === q) return rest.slice(i + 1);
    }
    return "";
  }
  const h = rest.indexOf("#");
  if (h === -1) return "";
  // Take the WHOLE run of whitespace before the `#`, not one character of it, so a column of
  // hand-aligned comments stays aligned after a value is rewritten.
  let start = h;
  while (start > 0 && /\s/.test(rest[start - 1])) start--;
  return rest.slice(start);
}

// D3, REVISED — the annotation that controls STORAGE is `# write-only`, not `# secret`.
//
// Vercel's `sensitive` type cannot be read back on production, so choosing it for a key is
// choosing that the key can never be restored to a new machine. That trade belongs to the key
// itself, not to whether its value happens to be a credential: the goal here is restoring a
// laptop from production, so recoverability is the default and giving it up is opt-in.
// `# secret` stays as documentation of what a value IS; `# write-only` decides how it is
// STORED. EXPO_PUBLIC_ is forced readable regardless — the value ships inside the .ipa, so
// hiding it from a pull protects nothing.
const isSensitive = (entry) => entry.writeOnly && !entry.key.startsWith("EXPO_PUBLIC_");

// ── process helpers ──────────────────────────────────────────────────────────

function run(cmd, args, { cwd = ROOT, input, quiet = true } = {}) {
  const r = spawnSync(cmd[0], [...cmd.slice(1), ...args], {
    cwd,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  if (r.error) return { code: 1, stdout: "", stderr: String(r.error.message) };
  const res = { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  if (!quiet && res.code !== 0) console.error(res.stderr.trim());
  return res;
}

const has = (bin) => spawnSync("which", [bin], { encoding: "utf8" }).status === 0;

let vercelCmdCache;
function vercelCmd() {
  if (vercelCmdCache) return vercelCmdCache;
  if (has("vercel")) return (vercelCmdCache = ["vercel"]);
  warn(
    "vercel is not on PATH — falling back to `npx vercel@latest`, which re-downloads ~59 MB per call.",
  );
  warn("Install it once with `npm i -g vercel` before running push over many keys (§6.1).");
  return (vercelCmdCache = ["npx", "--yes", "vercel@latest"]);
}

let easCmdCache;
function easCmd() {
  if (easCmdCache) return easCmdCache;
  if (has("eas")) return (easCmdCache = ["eas"]);
  return (easCmdCache = ["npx", "--yes", "eas-cli@latest"]);
}

// ── remote: Vercel ───────────────────────────────────────────────────────────

const vercel = {
  label: "Vercel",

  // Names + sensitivity only. `env ls` never returns decrypted values; `read` uses pull.
  list() {
    const r = run(vercelCmd(), ["env", "ls", "--json"], { cwd: ROOT });
    if (r.code !== 0) fail(`vercel env ls failed:\n${r.stderr.trim() || r.stdout.trim()}`);
    let rows;
    try {
      const parsed = JSON.parse(r.stdout);
      rows = Array.isArray(parsed) ? parsed : (parsed.envs ?? parsed.environmentVariables ?? []);
    } catch {
      fail(`could not parse \`vercel env ls --json\` output:\n${r.stdout.slice(0, 400)}`);
    }
    const meta = new Map();
    for (const row of rows) {
      const targets = Array.isArray(row.target) ? row.target : [row.target].filter(Boolean);
      if (!targets.includes(ENVIRONMENT)) continue;
      meta.set(row.key, { sensitive: row.type === "sensitive" });
    }
    return meta;
  },

  // Real values. Sensitive rows do come back for this account (§2.2) — verified, not assumed.
  read() {
    const dir = mkdtempSync(join(tmpdir(), "env-sync-"));
    const file = join(dir, "pulled.env");
    try {
      const r = run(vercelCmd(), ["env", "pull", file, `--environment=${ENVIRONMENT}`, "--yes"], {
        cwd: ROOT,
      });
      if (!existsSync(file)) fail(`vercel env pull failed:\n${r.stderr.trim() || r.stdout.trim()}`);
      return parseDotenv(readFileSync(file, "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },

  // D7 — rm + add, never --force. The project has both merged and split rows, and which
  // one --force produces is unverified; this sequence is correct for either.
  set(key, value, sensitive, existsRemotely) {
    if (existsRemotely) {
      const rm = run(vercelCmd(), ["env", "rm", key, ENVIRONMENT, "--yes"], { cwd: ROOT });
      if (rm.code !== 0) return { ok: false, err: rm.stderr.trim() || rm.stdout.trim() };
    }
    // stdin, not --value: survives newlines and shell metacharacters (PEM keys, JSON blobs).
    // printf-equivalent — no trailing newline is added to the stored value.
    const add = run(
      vercelCmd(),
      ["env", "add", key, ENVIRONMENT, sensitive ? "--sensitive" : "--no-sensitive"],
      {
        cwd: ROOT,
        input: value,
      },
    );
    return add.code === 0
      ? { ok: true }
      : { ok: false, err: add.stderr.trim() || add.stdout.trim() };
  },
};

// ── remote: EAS ──────────────────────────────────────────────────────────────
// Every eas env command resolves the project from app.config.ts, so cwd must be apps/mobile.

const eas = {
  label: "EAS",

  list() {
    const r = run(easCmd(), ["env:list", ENVIRONMENT, "--format", "long"], {
      cwd: TARGETS.mobile.dir,
    });
    if (r.code !== 0) {
      const detail = r.stderr.trim() || r.stdout.trim();
      if (/PluginError|Failed to resolve plugin/.test(detail))
        fail(
          `eas env:list cannot evaluate the Expo config — run \`pnpm install\` first (§1.2).\n${detail}`,
        );
      fail(`eas env:list failed:\n${detail}`);
    }
    const meta = new Map();
    let key = null;
    for (const line of r.stdout.split("\n")) {
      const name = /^\s*(?:ID\s+\S+\s*)?Name\s+(\S+)/.exec(line);
      if (name) {
        key = name[1];
        meta.set(key, { sensitive: false });
        continue;
      }
      const vis = /^\s*Visibility\s+(\S+)/.exec(line);
      // env:list PRINTS the visibility as PUBLIC / SENSITIVE / SECRET, while env:set ACCEPTS it
      // as plaintext / sensitive / secret. Two vocabularies for one field — comparing the
      // printed word against the flag word marks every public variable as sensitive.
      if (vis && key) meta.set(key, { sensitive: vis[1].toUpperCase() !== "PUBLIC" });
    }
    return meta;
  },

  read() {
    const dir = mkdtempSync(join(tmpdir(), "env-sync-"));
    const file = join(dir, "pulled.env");
    try {
      // --path is mandatory: both eas env:push and env:pull default to .env.local, which Expo
      // loads at HIGHER precedence than .env — an unqualified pull silently shadows the file
      // you edit by hand (§2.1).
      const r = run(easCmd(), ["env:pull", ENVIRONMENT, "--path", file], {
        cwd: TARGETS.mobile.dir,
      });
      if (!existsSync(file)) fail(`eas env:pull failed:\n${r.stderr.trim() || r.stdout.trim()}`);
      return parseDotenv(readFileSync(file, "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },

  // env:set upserts, so no rm is needed. --environment REPLACES the environment set on the
  // record rather than adding to it, but D9 means this tool only ever owns production.
  set(key, value, sensitive) {
    const r = run(
      easCmd(),
      [
        "env:set",
        "--name",
        key,
        "--value",
        value,
        "--environment",
        ENVIRONMENT,
        "--visibility",
        sensitive ? "sensitive" : "plaintext", // never `secret` — it does not round-trip (§2.2)
        "--scope",
        "project",
        "--type",
        "string",
        "--non-interactive",
      ],
      { cwd: TARGETS.mobile.dir },
    );
    return r.code === 0 ? { ok: true } : { ok: false, err: r.stderr.trim() || r.stdout.trim() };
  },
};

const remoteFor = (name) => (name === "vercel" ? vercel : eas);

// ── classification (§5.1) ────────────────────────────────────────────────────

function classify(target) {
  const { dir, remote } = TARGETS[target];
  const examplePath = join(dir, ".env.example");
  const envPath = join(dir, ".env");
  if (!existsSync(examplePath)) fail(`missing registry: ${examplePath}`);

  const registry = parseRegistry(readFileSync(examplePath, "utf8"));
  const local = existsSync(envPath) ? parseDotenv(readFileSync(envPath, "utf8")) : new Map();
  const api = remoteFor(remote);
  const remoteMeta = api.list();
  const remoteValues = api.read();

  const plan = {
    create: [],
    change: [],
    same: [],
    unverifiable: [],
    skipped: [],
    unregistered: [],
    missing: [],
    remoteOnly: [],
  };

  for (const key of registry.order) {
    const entry = registry.entries.get(key);
    if (isDenied(key)) {
      plan.skipped.push({ key, why: "runtime-injected (D4)" });
      continue;
    }
    if (entry.commented) {
      plan.skipped.push({ key, why: "commented out in .env.example (D2)" });
      continue;
    }

    const value = local.get(key);
    // An empty local value is skipped, not pushed as "" — lib/auth0.ts branches on exactly
    // the difference between "" and undefined (§5.1).
    if (value === undefined || value === "") {
      plan.missing.push({ key });
      continue;
    }

    const sensitive = isSensitive(entry);
    const onRemote = remoteMeta.has(key);
    const remoteValue = remoteValues.get(key);

    if (!onRemote) {
      plan.create.push({ key, value, sensitive });
      continue;
    }

    const visMismatch = (remoteMeta.get(key)?.sensitive ?? false) !== sensitive;
    if (isUnreadable(remoteValue)) {
      // The value cannot be compared, but the VISIBILITY can — `env ls` reports the type. A
      // mismatch is therefore a proved difference and belongs in `change`, not in the
      // can't-tell bucket; it is also the only way to make a write-only key readable again.
      if (visMismatch) {
        plan.change.push({
          key,
          value,
          sensitive,
          onRemote,
          note: `visibility → ${sensitive ? "sensitive" : "plaintext"}`,
        });
        continue;
      }
      // Otherwise: proved neither equal nor different. Rewriting it every run would churn
      // production secrets for no evidence; --secrets opts in.
      plan.unverifiable.push({ key, value, sensitive, onRemote, visMismatch });
      continue;
    }
    if (remoteValue !== value) plan.change.push({ key, value, sensitive, onRemote, remoteValue });
    else if (visMismatch)
      plan.change.push({
        key,
        value,
        sensitive,
        onRemote,
        remoteValue,
        note: `visibility → ${sensitive ? "sensitive" : "plaintext"}`,
      });
    else plan.same.push({ key });
  }

  for (const key of local.keys())
    if (!registry.entries.has(key) && !isDenied(key)) plan.unregistered.push({ key });

  for (const key of remoteMeta.keys()) {
    if (isDenied(key)) continue;
    const entry = registry.entries.get(key);
    if (!entry || entry.commented) plan.remoteOnly.push({ key, registered: Boolean(entry) });
  }

  return { plan, registry, local, remoteMeta, remoteValues };
}

// ── commands ─────────────────────────────────────────────────────────────────

function report(target, plan) {
  const { label } = TARGETS[target];
  head(`${label} — ${ENVIRONMENT}`);

  const list = (title, rows, fmt, color = "") => {
    if (!rows.length) return;
    say(`  ${color}${title}${c.off} (${rows.length})`);
    for (const r of rows) say(`    ${fmt(r)}`);
  };

  list(
    "create",
    plan.create,
    (r) => `${r.key}  ${c.dim}${fingerprint(r.value)}${r.sensitive ? " sensitive" : ""}${c.off}`,
    c.grn,
  );
  list(
    "change",
    plan.change,
    (r) =>
      `${r.key}  ${c.dim}local ${fingerprint(r.value)} → remote ${r.note ?? fingerprint(r.remoteValue)}${c.off}`,
    c.yel,
  );
  list(
    "unverifiable",
    plan.unverifiable,
    (r) =>
      `${r.key}  ${c.dim}local ${fingerprint(r.value)} → remote is write-only${r.visMismatch ? `, visibility → ${r.sensitive ? "sensitive" : "plaintext"}` : ""}; --secrets rewrites it${c.off}`,
    c.yel,
  );
  list("unchanged", plan.same, (r) => `${c.dim}${r.key}${c.off}`);
  list(
    "no local value",
    plan.missing,
    (r) => `${r.key}  ${c.dim}registered, empty in .env — skipped${c.off}`,
  );
  list(
    "unregistered in .env",
    plan.unregistered,
    (r) => `${r.key}  ${c.dim}add to .env.example to sync it${c.off}`,
    c.yel,
  );
  // D11 / D12 — reported, never deleted.
  list(
    "on remote only",
    plan.remoteOnly,
    (r) =>
      `${r.key}  ${c.dim}${r.registered ? "commented out locally" : "unregistered"} — adopt into .env.example or remove with the vendor CLI${c.off}`,
    c.yel,
  );
  list("not synced", plan.skipped, (r) => `${c.dim}${r.key} — ${r.why}${c.off}`);

  const pending = plan.create.length + plan.change.length;
  say(
    `  ${pending === 0 ? `${c.grn}in sync${c.off}` : `${c.bld}${pending} key(s) would change${c.off}`}`,
  );
  return pending;
}

function cmdDiff(targets) {
  for (const t of targets) report(t, classify(t).plan);
  say(
    `\n${c.dim}Read-only. \`pnpm env:push --apply\` writes the differences to ${ENVIRONMENT}.${c.off}`,
  );
}

function cmdPush(targets, apply, secrets) {
  let pending = 0;
  const work = [];
  for (const t of targets) {
    const { plan } = classify(t);
    pending += report(t, plan) + (secrets ? plan.unverifiable.length : 0);
    work.push({ target: t, plan });
  }
  if (!secrets) {
    const n = work.reduce((a, w) => a + w.plan.unverifiable.length, 0);
    if (n)
      say(
        `\n${c.dim}${n} write-only key(s) left untouched. Add --secrets to rewrite them from .env.${c.off}`,
      );
  }

  if (!apply) {
    say(
      `\n${c.dim}Plan only — nothing was written. Re-run with --apply to push to ${ENVIRONMENT}.${c.off}`,
    );
    return;
  }
  if (pending === 0) {
    say(`\n${c.grn}Nothing to do.${c.off}`);
    return;
  }

  let failed = 0;
  for (const { target, plan } of work) {
    const api = remoteFor(TARGETS[target].remote);
    const todo = [...plan.create, ...plan.change, ...(secrets ? plan.unverifiable : [])];
    if (!todo.length) continue;
    head(`applying — ${TARGETS[target].label}`);
    for (const row of todo) {
      const res = api.set(row.key, row.value, row.sensitive, row.onRemote ?? false);
      if (res.ok) say(`  ${c.grn}✔${c.off} ${row.key}`);
      else {
        failed++;
        say(`  ${c.red}✖${c.off} ${row.key} — ${res.err}`);
      }
    }
  }
  say("");
  if (failed) fail(`${failed} key(s) failed to write.`);
  say(
    `${c.grn}Done.${c.off} Vercel needs a redeploy and EAS needs a rebuild for these to take effect.`,
  );
}

function cmdPull(targets, dryRun) {
  for (const target of targets) {
    const { dir, remote, label } = TARGETS[target];
    const envPath = join(dir, ".env");
    const registry = parseRegistry(readFileSync(join(dir, ".env.example"), "utf8"));
    const api = remoteFor(remote);
    const meta = api.list();
    const values = api.read();
    const local = existsSync(envPath) ? parseDotenv(readFileSync(envPath, "utf8")) : new Map();

    // A value that did not come back is never allowed to overwrite a populated local one —
    // this is the data-loss path, and on this account it is the common case, not the edge one.
    const kept = new Map();
    const writeOnly = [];
    for (const [key, value] of values) {
      if (isDenied(key)) continue; // strips the injected VERCEL_OIDC_TOKEN (§2.3)
      if (registry.entries.get(key)?.commented) continue; // a pull must not clobber APP_BASE_URL / APP_ENV (D2)
      if (isUnreadable(value) || value === "") {
        writeOnly.push(key);
        continue;
      }
      kept.set(key, value);
    }
    const clobbered = writeOnly.filter((k) => local.get(k));
    const orphaned = writeOnly.filter((k) => !local.get(k));

    head(`${label} — pull from ${ENVIRONMENT}`);
    const added = [],
      changed = [],
      removed = [],
      unregistered = [];
    for (const [key, value] of kept) {
      if (!local.has(key)) added.push(key);
      else if (local.get(key) !== value) changed.push(key);
      if (!registry.entries.has(key)) unregistered.push(key);
    }
    for (const key of local.keys())
      if (
        !kept.has(key) &&
        !isDenied(key) &&
        !registry.entries.get(key)?.commented &&
        !writeOnly.includes(key)
      )
        removed.push(key);
    // Everything local the remote does not supply: #commented registry keys whose value must
    // differ per environment (APP_BASE_URL, APP_ENV), keys the remote never held, and the
    // write-only ones. Pull UPDATES .env rather than replacing it, so all of them survive.
    const preserved = [...local.keys()].filter((k) => !kept.has(k) && !isDenied(k));

    for (const k of added)
      say(`  ${c.grn}+ ${k}${c.off}  ${c.dim}${fingerprint(kept.get(k))}${c.off}`);
    for (const k of changed)
      say(
        `  ${c.yel}~ ${k}${c.off}  ${c.dim}local ${fingerprint(local.get(k))} → remote ${fingerprint(kept.get(k))}${c.off}`,
      );
    for (const k of removed)
      say(`  ${c.dim}= ${k}  local only — not on ${ENVIRONMENT}, kept${c.off}`);
    if (clobbered.length)
      say(
        `  ${c.dim}kept local value for ${clobbered.length} write-only key(s): ${clobbered.join(", ")}${c.off}`,
      );
    if (orphaned.length)
      say(
        `  ${c.red}unrecoverable${c.off} (${orphaned.length}): ${orphaned.join(", ")}\n    ${c.dim}write-only on the remote and absent locally — read them from the dashboard${c.off}`,
      );
    if (unregistered.length)
      say(
        `  ${c.yel}unregistered${c.off} (${unregistered.length}): ${unregistered.join(", ")}\n    ${c.dim}adopt into .env.example or delete from the remote${c.off}`,
      );
    if (preserved.length)
      say(`  ${c.dim}kept ${preserved.length} local value(s) the remote does not supply${c.off}`);
    if (!added.length && !changed.length) say(`  ${c.grn}already up to date${c.off}`);

    // The file's layout is the author's, not the tool's: keys keep their position, their
    // grouping comments and their blank lines, and only the value to the right of `=` is
    // rewritten. A key the remote does not supply is not touched at all.
    const changedSet = new Set(changed);
    let text = existsSync(envPath) ? readFileSync(envPath, "utf8") : null;
    const seen = new Set();

    if (text !== null) {
      text = text
        .split("\n")
        .map((line) => {
          const m = /^(\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=)(.*)$/.exec(line);
          if (!m) return line; // a comment, a blank line, anything unparsed — verbatim
          const [, prefix, key, rest] = m;
          if (!kept.has(key)) return line;
          seen.add(key);
          if (!changedSet.has(key)) return line; // same value: leave the line byte-identical
          return prefix + formatValue(kept.get(key)) + trailingComment(rest);
        })
        .join("\n");

      // Keys the remote has that the file does not. Appended, because there is no position in
      // someone else's layout that is obviously theirs.
      const append = [...kept.keys()].filter((k) => !seen.has(k));
      if (append.length) {
        if (!text.endsWith("\n")) text += "\n";
        text += `\n# Added by \`pnpm env:pull\` from ${remote} ${ENVIRONMENT} on ${new Date().toISOString().slice(0, 10)}.\n`;
        for (const key of append) text += `${key}=${formatValue(kept.get(key))}\n`;
      }
    } else {
      // No file yet — the restore-a-machine case. Here the registry's ordering and comments are
      // the only layout there is, so generate from it.
      const lines = [
        `# Written by \`pnpm env:pull\` from ${remote} ${ENVIRONMENT} on ${new Date().toISOString()}`,
        "",
      ];
      const written = new Set();
      for (const key of registry.order) {
        if (registry.entries.get(key).commented || !kept.has(key)) continue;
        lines.push(`${key}=${formatValue(kept.get(key))}`);
        written.add(key);
      }
      const extras = [...kept.keys()].filter((k) => !written.has(k));
      if (extras.length) {
        lines.push("", "# Not in .env.example — adopt or delete (D11).");
        for (const key of extras) lines.push(`${key}=${formatValue(kept.get(key))}`);
      }
      text = lines.join("\n") + "\n";
    }

    if (dryRun) {
      say(`  ${c.dim}--dry-run: ${envPath} not touched${c.off}`);
      continue;
    }
    if (existsSync(envPath)) {
      copyFileSync(envPath, `${envPath}.bak`);
      say(`  ${c.dim}previous file backed up to ${envPath}.bak${c.off}`);
    }
    writeFileSync(envPath, text, { mode: 0o600 });
    say(`  ${c.grn}updated ${envPath}${c.off}`);
  }
  if (dryRun)
    say(`\n${c.dim}--dry-run: no file was written. Re-run without it to update .env.${c.off}`);
}

// ── entry ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const command =
  argv.includes("--help") || argv.includes("-h") ? undefined : argv.find((a) => !a.startsWith("-"));

// An unrecognised flag must never fall through into a real run: `pull --help` writing .env is
// exactly the surprise this tool exists to avoid.
const KNOWN_FLAGS = new Set(["--apply", "--secrets", "--dry-run", "--target", "--help", "-h"]);
for (const a of argv)
  if (a.startsWith("-") && !KNOWN_FLAGS.has(a.split("=")[0]))
    fail(`unknown flag ${a} — run without arguments for usage.`);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("-")) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : undefined;
};

const targetOpt = opt("target") ?? "all";
if (!["web", "mobile", "all"].includes(targetOpt))
  fail(`--target must be web, mobile or all (got ${targetOpt})`);
const targets = targetOpt === "all" ? ["web", "mobile"] : [targetOpt];

switch (command) {
  case "diff":
    cmdDiff(targets);
    break;
  case "push":
    cmdPush(targets, flag("apply"), flag("secrets"));
    break;
  case "pull":
    cmdPull(targets, flag("dry-run"));
    break;
  default:
    say(`env-sync — local .env ⇄ ${ENVIRONMENT} on Vercel (web) and EAS (mobile)

  pnpm env:diff                    report drift; changes nothing
  pnpm env:push                    plan the upload
  pnpm env:push --apply            perform it
  pnpm env:push --apply --secrets  also rewrite values the remote will not read back
  pnpm env:pull                    update .env from the remote (backs up to .env.bak)
  pnpm env:pull --dry-run          show the diff, write nothing

  --target web | mobile | all      default: all

Design: docs/2026-08-28-env-variable-sync.md`);
    process.exit(command ? 1 : 0);
}
