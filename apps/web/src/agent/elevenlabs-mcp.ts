/**
 * One `PromptVersion.mcpTools` grant → the ElevenLabs **MCP server registration** that carries it.
 *
 * The third module of its kind, after ./vapi-assistant.ts and ./openai-mcp.ts: a TRANSLATION
 * between this repo's vocabulary and one vendor's, kept out of `sync-agents.ts` so the decisions in
 * it can be read without the plumbing around them. Its research note is
 * docs/2026-08-28-elevenlabs-mcp-in-code.md.
 *
 * ## ElevenLabs grants at the SERVER, not at the tool
 *
 * This is the fact everything else here follows from, and it is where this provider parts company
 * with OpenAI. An OpenAI session names the tools it may call (`allowed_tools`), so a version's grant
 * costs nothing and lives entirely in the minted session. An ElevenLabs agent names SERVER IDS —
 * `conversation_config.agent.prompt.mcp_server_ids` — and gets every tool that server exposes. There
 * is no per-agent allowlist anywhere.
 *
 * So a grant is projected onto a REGISTRATION, and the projection is:
 *
 *   > a version's sorted `mcpTools` set names a registration; versions granting the same set share
 *   > one, and a different set needs its own.
 *
 * Today there is exactly one non-empty set — `["add_words_to_collection"]` — because the server
 * exposes exactly one tool, so this rule costs nothing yet. It becomes load-bearing on the day a
 * second tool is registered on `/api/mcp`: without it, that tool would be handed to every existing
 * ElevenLabs version retroactively, which is the outcome `mcpTools` exists to prevent.
 *
 * ## Narrowing is done by the SERVER, not by `tool_approval_hashes`
 *
 * ElevenLabs' per-tool mechanism (`approval_policy: "require_approval_per_tool"` + a SHA-256 of each
 * tool's description and parameters) is the closer match to `allowed_tools`, and it is deliberately
 * not used. That hash is over OUR OWN tool definition, so a one-word edit to a `.describe()` string
 * in `lib/mcp/add-words.ts` invalidates it — and what ElevenLabs does with a stale hash is
 * undocumented (requires approval, which hangs a lesson; or disabled, which silently removes the
 * tool). Both are invisible from this repo. Registration-level `auto_approve_all` keeps the
 * narrowing where it already lives: in what `app/api/mcp/route.ts` registers.
 *
 * ## The connection runs ElevenLabs → us
 *
 * Same as OpenAI, with the same consequence: `localhost` cannot work, and it fails by never
 * arriving. See `unreachableHost` in ./mcp-url.ts, which both mappers share for exactly that reason.
 */
import { unreachableHost } from "./mcp-url";
import type { PromptVersion } from "./prompts";

export const EL_MCP_API = "https://api.elevenlabs.io/v1/convai/mcp-servers";
export const EL_SECRETS_API = "https://api.elevenlabs.io/v1/convai/secrets";
export const EL_SETTINGS_API = "https://api.elevenlabs.io/v1/convai/settings";

/**
 * Where our MCP server lives, as ELEVENLABS will dial it.
 *
 * A CONSTANT, and that is a deliberate departure from ./openai-mcp.ts, which reads `MCP_PUBLIC_URL`
 * and refuses to run without it. The two providers have different blast radii for the same mistake:
 * OpenAI's URL is baked into one minted session and affects one lesson, while this one is written
 * into a workspace resource that every environment shares. `sync:agents` run on a laptop with a
 * tunnel in `MCP_PUBLIC_URL` would therefore repoint the LIVE agents at that laptop — and the tunnel
 * then dies. A constant makes the default outcome correct no matter whose machine runs the sync.
 *
 * The override still exists (`MCP_PUBLIC_URL` + `--allow-dev-mcp-url`), because someone will one day
 * need a tunnel here too. It just has to be asked for out loud.
 */
export const DEPLOYED_MCP_URL = "https://eleven-labs-english-agent.vercel.app/api/mcp";

/**
 * The workspace secret holding the COMPLETE `Authorization` header value — `Bearer <MCP_TOKEN>`,
 * prefix included.
 *
 * **Resolved by name and never written.** It is created and rotated by a human in the ElevenLabs
 * dashboard, so `sync:agents` reads its `secret_id` and nothing else. That is what keeps this whole
 * feature to one remote object the sync owns, and it means `MCP_TOKEN` is never read on this path:
 * the credential is already on ElevenLabs' side, so nothing has to carry it there.
 *
 * Its FORMAT is load-bearing and invisible from this repo. `lib/mcp/auth.ts` splits the header on a
 * space and requires the `Bearer` scheme, so a value stored without the prefix produces a tutor
 * whose every tool call comes back 401 mid-lesson, with nothing local to notice it.
 */
export const MCP_SECRET_NAME = "MCP_AUTHORIZATION_HEADER";

/**
 * `serverInfo.name` from `app/api/mcp/route.ts`, and the stem of every registration name. The same
 * label ./openai-mcp.ts uses as `server_label`, for the same reason: a name that disagreed with the
 * server's own would make a trace name a server nothing in this repo is called.
 */
const SERVER_LABEL = "tutor-collection";

/**
 * The default is `SSE`. `app/api/mcp/route.ts` is `mcp-handler`'s Streamable HTTP handler — one
 * path, `GET`/`POST`/`DELETE`, no separate SSE endpoint — so the default cannot talk to it at all.
 *
 * It sits with the identity fields rather than the defaults below because ElevenLabs will not let
 * you PATCH it: getting it wrong is a delete-and-recreate, not an edit.
 */
const TRANSPORT = "STREAMABLE_HTTP";

/**
 * Pinned rather than inherited — the same rule `prompts/index.ts` follows for the turn-taking
 * knobs. Every one of these has a platform default, and the first default is wrong for a voice
 * lesson in a way that does not look like an error.
 */
const REGISTRATION_DEFAULTS = {
  /**
   * **The load-bearing one.** ElevenLabs' default is `require_approval_all`, which emits an
   * `mcp_tool_call` in state `awaiting_approval` and waits `approval_timeout_secs` (300) for a
   * client to send `mcp_tool_approval_result`. `@elevenlabs/client` CAN answer that — it exposes
   * `sendMCPToolApprovalResult` — but `apps/mobile/src/lib/transport/elevenlabs.ts` does not listen
   * for the event, so the default produces a lesson that stops talking for five minutes. This is
   * the counterpart of `require_approval: "never"` on OpenAI, and the approval it replaces is
   * upstream of the conversation: a version has to name the grant, and the server exposes one
   * write-only, non-destructive tool.
   */
  approval_policy: "auto_approve_all",
  /**
   * `auto` makes the agent announce a tool call when recent latency looks high. The save clause in
   * words-1.1 / words-2.1 exists specifically to stop the tutor narrating the tool ("Saving is
   * quiet"), so `auto` would put the narration back underneath the prompt.
   */
  pre_tool_speech: "off",
  /**
   * Left at the platform default ON PURPOSE, and stated rather than omitted: interruption is how the
   * learner takes part in this lesson (docs/2026-08-16-tutor-pause-hold-the-line.md), so suppressing
   * it around a tool call would silence them for exactly the turn they just spoke into.
   */
  interruption_mode: "allow",
  /**
   * Let the tutor finish its sentence before the write lands. `immediate` interrupts the turn to
   * run the tool; `async` returns nothing to the turn at all, and this tool's answer is worth having
   * — it distinguishes "added" from "already on your list", which the clause tells the tutor to say.
   */
  execution_mode: "post_tool_speech",
  /**
   * Below `route.ts`'s `maxDuration = 60`, and well below a spoken turn's patience. A tool that has
   * not answered in 20 s should fail the turn rather than stall it. (Range is 5–300; default 30.)
   */
  response_timeout_secs: 20,
} as const;

/** One grant set, as it will exist on ElevenLabs. */
export interface ElevenLabsMcpRegistration {
  /** Identity key: the sorted tool set, joined. Keys the lockfile and names the registration. */
  key: string;
  /** Display name in the dashboard, and the reason the key is visible there. */
  name: string;
  /** Absolute https URL of `/api/mcp` as ElevenLabs will dial it. */
  url: string;
  /** The tools this registration exists to grant, sorted. Documentation only — see the header. */
  tools: string[];
  description: string;
}

/**
 * Either the registrations this repo's versions require, or the one-line reason there are none.
 *
 * The same three-outcome shape as `openAiMcpTools`, and the middle one is the dangerous one for the
 * same reason: no version granting anything is normal, a version granting tools we cannot wire up is
 * a misconfigured deployment, and a sync that quietly provisioned an agent with no tools is the
 * failure this shape exists to make impossible.
 */
export type McpRegistrationsResult =
  | { ok: true; registrations: ElevenLabsMcpRegistration[] }
  | { ok: false; reason: string };

export interface McpUrlOptions {
  /** `MCP_PUBLIC_URL`, when set. Ignored unless `allowOverride`. */
  overrideUrl?: string | undefined;
  /** `--allow-dev-mcp-url` — the flag that makes an override deliberate. */
  allowOverride?: boolean;
}

/** The lockfile key / registration identity for a grant set. Sorted, so order in a module is free. */
export function mcpGrantKey(tools: string[]): string {
  return [...tools].sort().join("+");
}

/**
 * Every registration the ElevenLabs half of the registry needs, deduplicated by grant set.
 *
 * Pure: no network, no `process.env` read of its own. `sync:agents --dry-run` has to work on a
 * machine holding no credentials, and this is the function that makes the MCP half of the plan
 * printable there.
 */
export function elevenLabsMcpRegistrations(
  versions: PromptVersion[],
  opts: McpUrlOptions = {},
): McpRegistrationsResult {
  const granting = versions.filter((v) => (v.mcpTools ?? []).length > 0);
  // The common case, and the one that must stay free of every check below: a registry where no
  // version grants anything runs on a workspace that never configured MCP at all.
  if (granting.length === 0) return { ok: true, registrations: [] };

  const url = resolveUrl(opts);
  if (!url.ok) return url;

  const byKey = new Map<string, ElevenLabsMcpRegistration>();
  for (const v of granting) {
    const tools = [...(v.mcpTools ?? [])].sort();
    const key = mcpGrantKey(tools);
    if (byKey.has(key)) continue;
    byKey.set(key, {
      key,
      name: `${SERVER_LABEL} (${tools.join(", ")})`,
      url: url.value,
      tools,
      description:
        `The learner's vocabulary collection, from the English tutor's own MCP server. ` +
        `Grants: ${tools.join(", ")}.`,
    });
  }
  return { ok: true, registrations: [...byKey.values()] };
}

function resolveUrl(opts: McpUrlOptions): { ok: true; value: string } | { ok: false; reason: string } {
  const override = opts.overrideUrl?.trim();
  if (!override || override === DEPLOYED_MCP_URL) return { ok: true, value: DEPLOYED_MCP_URL };

  // The override is real and differs. Refuse it unless it was asked for out loud — see
  // DEPLOYED_MCP_URL for what applying it would do to production.
  if (!opts.allowOverride) {
    return {
      ok: false,
      reason:
        `MCP_PUBLIC_URL is set to ${override}, which differs from the deployed origin this\n` +
        `  registration normally uses:\n      ${DEPLOYED_MCP_URL}\n` +
        `  The ElevenLabs workspace is shared with production, so applying this would repoint the\n` +
        `  LIVE agents' MCP server. Re-run with --allow-dev-mcp-url if that is what you want.`,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(override);
  } catch {
    return { ok: false, reason: `MCP_PUBLIC_URL is not a valid absolute URL: "${override}".` };
  }
  if (unreachableHost(parsed.hostname)) {
    return {
      ok: false,
      reason:
        `MCP_PUBLIC_URL points at ${parsed.hostname}, which ElevenLabs cannot reach — they dial the ` +
        `MCP server from their own network, not from this process. Use a tunnel or a deployed origin.`,
    };
  }
  // https is not politeness: the registration carries a credential reference and every tool call
  // rides this URL. ElevenLabs rejects a non-https MCP url anyway; failing here says why.
  if (parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: `MCP_PUBLIC_URL must be https for an MCP server. Got "${parsed.protocol}".`,
    };
  }
  return { ok: true, value: parsed.toString() };
}

/**
 * The four fields ElevenLabs will NOT let you change after creation.
 *
 * `PATCH /v1/convai/mcp-servers/{id}` accepts the approval policy, the headers and the tool-call
 * behaviour — and not `url`, `name`, `description` or `transport`. So a change to any of these is a
 * REPLACE (create a new registration, move the agents onto it, delete the old one), not a patch, and
 * `sync-agents.ts` hashes this separately to tell the two apart. Discovered from the API reference
 * rather than the hard way, but it is the reason the URL is a constant worth protecting: moving it
 * costs a new server id and a re-patch of every attached agent.
 */
export function mcpIdentity(reg: ElevenLabsMcpRegistration) {
  return { url: reg.url, name: reg.name, description: reg.description, transport: TRANSPORT };
}

/**
 * The `POST /v1/convai/mcp-servers` body. Everything lives under `config`, unlike the PATCH body.
 */
export function mcpCreateBody(reg: ElevenLabsMcpRegistration, secretId: string) {
  return { config: { ...mcpIdentity(reg), ...mcpMutableConfig(secretId) } };
}

/**
 * The `PATCH /v1/convai/mcp-servers/{id}` body: the mutable half, NOT wrapped in `config`.
 */
export function mcpPatchBody(secretId: string) {
  return mcpMutableConfig(secretId);
}

function mcpMutableConfig(secretId: string) {
  return {
    ...REGISTRATION_DEFAULTS,
    // Deliberately `request_headers` and NOT `secret_token`. The stored secret holds a COMPLETE
    // header value ("Bearer …"), and `secret_token` is documented as "the secret token
    // (Authorization header)" without saying whether the platform adds a `Bearer ` prefix of its
    // own. If it does, every call arrives as `Bearer Bearer …` and `mcpTokenOk` rejects all of them
    // — a tutor whose tools 401 mid-lesson, which is the failure with the least evidence attached.
    // `request_headers` sends the value verbatim, so there is nothing to be wrong about.
    request_headers: { Authorization: { secret_id: secretId } },
  };
}
