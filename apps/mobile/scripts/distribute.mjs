#!/usr/bin/env node
// Distribute a signed .ipa: upload it and print an install link for a provisioned device.
//
//   pnpm distribute                      # the .ipa `pnpm build:preview:local` writes (IPA_OUT overrides)
//   pnpm distribute path/to/app.ipa      # a specific file
//   pnpm distribute --comment "text"     # note shown on the install page (default: branch @ short sha)
//   pnpm distribute --password secret    # protect the install page with a password
//   pnpm distribute --no-slack           # skip the Slack post for a one-off
//
// With SLACK_WEBHOOK_URL set, the install link is also posted to Slack as a tappable button —
// the fast path to installing on a phone. Optional: unset, everything else behaves the same.
//
// The command is deliberately provider-neutral. Today the provider is Diawi, confined to the
// "Provider: Diawi" block below plus readToken() — that is the whole surface to replace.
//
// Needs DIAWI_TOKEN, and optionally SLACK_WEBHOOK_URL — in the shell, or in apps/mobile/.env (both
// registered commented-out in .env.example, so env-sync never pushes them to EAS). Create them at
// https://dashboard.diawi.com/profile/api and Slack app → Incoming Webhooks.
//
// How Diawi's API works — two steps:
//   1. POST the file to UPLOAD_URL            → { job }
//   2. GET STATUS_URL?token&job until done    → { status: 2000, link, qrcode }
//
// Zero dependencies on purpose, like the repo-root scripts/env-sync.mjs: Node 22 has fetch,
// FormData and fs.openAsBlob. The API contract follows diawi-nodejs-uploader, which pulls in
// node-fetch 2, form-data, ts-node and TypeScript 3.9 at runtime to do the same.

import { spawnSync } from "node:child_process";
import { existsSync, openAsBlob, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// ── Configuration ────────────────────────────────────────────────────────────

const MOBILE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Kept in step with --output in package.json's build:preview:local; IPA_OUT overrides both.
const DEFAULT_IPA = process.env.IPA_OUT ?? "artifacts/english-tutor-preview.ipa";

const UPLOAD_TIMEOUT_MS = 5 * 60_000; // a ~22 MB file on a slow uplink
const REQUEST_TIMEOUT_MS = 15_000; // one status check
const POLL_INTERVAL_MS = 2_000;
const PROCESSING_TIMEOUT_MS = 3 * 60_000; // the provider usually finishes in seconds

const USAGE =
  "usage: pnpm distribute [file.ipa] [--comment text] [--password pw] [--no-slack]";

// ── Provider: Diawi ──────────────────────────────────────────────────────────
// Swapping provider means this block, DIAWI_TOKEN in readToken() and the two request bodies.

const UPLOAD_URL = "https://upload.diawi.com/";
const STATUS_URL = "https://upload.diawi.com/status";

/** Diawi job status codes. Anything else is an error. */
const JOB_STATUS = { DONE: 2000, PROCESSING: 2001 };

/**
 * @typedef {object} JobStatus
 * @property {number} status   one of JOB_STATUS, or an error code
 * @property {string} message
 * @property {string} [link]   install page, e.g. https://i.diawi.com/AbC123
 * @property {string} [qrcode] PNG of a QR code pointing at `link`
 */

// ── Main flow ────────────────────────────────────────────────────────────────

async function main() {
  const args = readArgs();
  if (args.help) {
    console.log(USAGE);
    return;
  }

  loadDotEnv();
  const token = readToken();
  const ipaPath = resolveIpaPath(args.file);
  const comment = args.comment ?? describeGitHead();

  console.log(`Uploading ${basename(ipaPath)} (${fileSizeMb(ipaPath)} MB)`);
  if (comment) console.log(`Comment:  ${comment}`);

  const jobId = await uploadIpa({ token, ipaPath, comment, password: args.password });
  const result = await waitUntilProcessed({ token, jobId });

  console.log(`\nInstall: ${result.link}`);
  if (result.qrcode) console.log(`QR code: ${result.qrcode}`);

  if (!args["no-slack"]) {
    await announceToSlack({
      link: result.link,
      comment,
      ipaPath,
      isProtected: Boolean(args.password),
    });
  }
}

// ── Steps ────────────────────────────────────────────────────────────────────

/** Parse the command line. Unknown flags throw, which main() reports with the usage line. */
function readArgs() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      comment: { type: "string" },
      password: { type: "string" },
      "no-slack": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (positionals.length > 1) throw new Error(`expected at most one file\n${USAGE}`);
  return { ...values, file: positionals[0] };
}

/**
 * Pull apps/mobile/.env into the environment. Loaded unconditionally and once, so a token that
 * lives in the file is found whether or not its neighbours came from the shell. `loadEnvFile` never
 * overwrites a variable that is already set, which is what keeps `FOO=… pnpm distribute` winning.
 */
function loadDotEnv() {
  const envFile = join(MOBILE_DIR, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

function readToken() {
  const token = process.env.DIAWI_TOKEN;
  if (!token) throw new Error("DIAWI_TOKEN is not set (shell or apps/mobile/.env)");
  return token;
}

/** An explicit path is relative to where you ran the command; the default, to apps/mobile. */
function resolveIpaPath(file) {
  const ipaPath = file ? resolve(file) : resolve(MOBILE_DIR, DEFAULT_IPA);
  if (!existsSync(ipaPath)) {
    throw new Error(`${ipaPath} not found — run pnpm build:preview:local first`);
  }
  return ipaPath;
}

/** Step 1: send the file. Returns the job id that step 2 polls. */
async function uploadIpa({ token, ipaPath, comment, password }) {
  const form = new FormData();
  form.set("token", token);
  form.set("file", await openAsBlob(ipaPath), basename(ipaPath));
  if (comment) form.set("comment", comment);
  if (password) form.set("password", password);

  const response = await fetch(UPLOAD_URL, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  const body = await readJson(response, "upload");
  if (!body.job) throw new Error(`upload failed: ${body.message ?? JSON.stringify(body)}`);
  return body.job;
}

/**
 * Step 2: Diawi unpacks and checks the file before the link exists.
 * @returns {Promise<JobStatus>}
 */
async function waitUntilProcessed({ token, jobId }) {
  // Built once; never printed, because the query string carries the token.
  const statusUrl = `${STATUS_URL}?${new URLSearchParams({ token, job: jobId })}`;
  const deadline = Date.now() + PROCESSING_TIMEOUT_MS;

  process.stdout.write("Processing");
  try {
    while (Date.now() < deadline) {
      const response = await fetch(statusUrl, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      /** @type {JobStatus} */
      const job = await readJson(response, "status check");

      if (job.status === JOB_STATUS.DONE) return job;
      if (job.status !== JOB_STATUS.PROCESSING) {
        throw new Error(`processing failed (${job.status}): ${job.message}`);
      }

      process.stdout.write(".");
      await sleep(POLL_INTERVAL_MS);
    }
  } finally {
    process.stdout.write("\n");
  }

  throw new Error(`still processing after ${PROCESSING_TIMEOUT_MS / 1000}s — job ${jobId}`);
}

// ── Slack (optional) ─────────────────────────────────────────────────────────

/**
 * Post the install link to a Slack incoming webhook, as a tappable button.
 *
 * Deliberately swallows its own failures. By the time this runs the .ipa is uploaded and the link
 * is already on stdout, so the ship succeeded; a Slack outage or a stale webhook must not turn that
 * into a non-zero exit and make CI look like a failed build. It warns instead.
 */
async function announceToSlack({ link, comment, ipaPath, isProtected }) {
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) return;

  const facts = [comment, `${fileSizeMb(ipaPath)} MB`, isProtected ? ":lock: password required" : null]
    .filter(Boolean)
    .join("  ·  ");

  const payload = {
    // Also the push-notification text, where blocks are not rendered — so it carries the link.
    text: `iOS preview ready${comment ? ` — ${comment}` : ""}: ${link}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*iOS preview ready*\n${facts}` } },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: ":iphone: Install", emoji: true },
            url: link,
            style: "primary",
          },
        ],
      },
    ],
  };

  try {
    const response = await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // An incoming webhook answers with the bare string "ok"; everything else is a failure.
    const body = (await response.text()).trim();
    if (!response.ok || body !== "ok") {
      throw new Error(`HTTP ${response.status} ${body.slice(0, 200)}`);
    }
    console.log("Slack:   posted");
  } catch (error) {
    const reason = error.name === "TimeoutError" ? "request timed out" : error.message;
    console.warn(`distribute: the link is above, but Slack rejected it — ${reason}`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Parse a JSON response, turning HTTP errors and HTML error pages into a readable message. */
async function readJson(response, what) {
  const text = await response.text();
  if (!response.ok)
    throw new Error(`${what} failed: HTTP ${response.status} ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

/** "master @ 0036c8c", or "" outside a git checkout. */
function describeGitHead() {
  const git = (...args) =>
    spawnSync("git", args, { cwd: MOBILE_DIR, encoding: "utf8" }).stdout?.trim() ?? "";
  const sha = git("rev-parse", "--short", "HEAD");
  return sha ? `${git("rev-parse", "--abbrev-ref", "HEAD")} @ ${sha}` : "";
}

function fileSizeMb(path) {
  return (statSync(path).size / 1024 / 1024).toFixed(1);
}

// ── Entry point ──────────────────────────────────────────────────────────────

main().catch((error) => {
  // A timeout surfaces as a DOMException named TimeoutError, with an unhelpful message.
  const message = error.name === "TimeoutError" ? "request timed out" : error.message;
  console.error(`distribute: ${message}`);
  process.exitCode = 1;
});
