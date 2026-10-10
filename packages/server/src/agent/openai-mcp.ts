/**
 * One `PromptVersion` → the `session.tools` entry that lets an OpenAI Realtime tutor call our own
 * MCP server.
 *
 * The sibling of ./vapi-assistant.ts, and the same kind of module: a TRANSLATION between this
 * repo's vocabulary and one vendor's, kept out of the route so the decisions in it can be read
 * without the plumbing around them. What it translates is `PromptVersion.mcpTools` — a list of tool
 * names a lesson grants — into the object OpenAI wants.
 *
 * ## The connection runs OpenAI → us, not us → OpenAI
 *
 * This is the fact everything else here follows from. We hand OpenAI a URL and a credential, and
 * THEIR servers dial `/api/mcp` over the public internet: they list the tools, they call them, they
 * feed the result back into the model. Nothing about it reaches the device, which is why the mobile
 * transport needs no change for this and why `require_approval` must be `"never"` (see below).
 *
 * Two consequences that are easy to meet the hard way:
 *
 *  1. **`localhost` cannot work.** A dev server is not reachable from OpenAI's network, and the
 *     failure surfaces mid-lesson as a tool that silently never lists — so this module refuses a
 *     loopback URL up front instead. Use a deployed origin, a tunnel (ngrok et al), or OpenAI's own
 *     Secure MCP Tunnel (`tunnel_id` in place of `server_url`, not wired here).
 *  2. **The secret leaves our infrastructure by design.** `MCP_TOKEN` is handed to OpenAI so they
 *     can present it back to us. That is a genuine widening of where the secret lives, and it is
 *     the reason `MCP_TOKEN_OLD` is deliberately not consulted here: a rotation moves this side
 *     forward immediately, and the old value's only job is to keep OTHER clients working until they
 *     are moved. Verified 2026-08-28: OpenAI echoes the field back as `"<redacted>"` in the
 *     `client_secrets` response, so the credential does not ride back down to the device with the
 *     ephemeral key.
 */
import { unreachableHost } from "./mcp-url";
import type { PromptVersion } from "./prompts";

/**
 * The MCP entry in `session.tools`, exactly as the Realtime API takes it.
 *
 * Deliberately NOT in `@tutor/shared` and not in `RealtimeTokenResponse`: unlike `audioInput`,
 * which the client is told about because a held pause has to put it back, no client ever sees or
 * sends this. It is server-side session config, and the package's own test — *could I fix a bug in
 * this by deploying the web app alone?* — answers yes.
 */
export interface RealtimeMcpTool {
  type: "mcp";
  /** Identifies the server in tool calls and in the `mcp_list_tools` / `mcp_call` items. */
  server_label: string;
  server_url: string;
  /** Sent by OpenAI as `Authorization: Bearer <value>`, which is exactly what `mcpTokenOk` reads. */
  authorization: string;
  allowed_tools: string[];
  require_approval: "never";
}

/**
 * Either the tools to bake into the session, or the one-line reason there are none.
 *
 * A result rather than a throw or a silent `[]`, because the three outcomes are genuinely
 * different and the middle one is the dangerous one: a version that grants no tools is normal, a
 * version that grants tools we cannot wire up is a MISCONFIGURED DEPLOYMENT, and a lesson that
 * quietly starts without the tool it was written around is the failure this shape exists to make
 * impossible. The route turns `ok: false` into a 500 the same way it does a missing API key.
 */
export type McpToolsResult = { ok: true; tools: RealtimeMcpTool[] } | { ok: false; reason: string };

/** What this module needs from the environment. Read by `mcpClientConfig` in ../lib/config.ts. */
export interface McpClientConfig {
  /** Absolute URL of our MCP endpoint AS OPENAI WILL DIAL IT, e.g. `https://…/api/mcp`. */
  url: string | undefined;
  /** The shared secret `lib/mcp/auth.ts` verifies. */
  token: string | undefined;
}

/**
 * `lib/mcp/auth.ts` treats anything shorter than this as unset and rejects every request. Mirrored
 * rather than imported: this module is a translation table with no runtime dependencies (the same
 * rule ./vapi-assistant.ts follows), and the coupling is one constant with a loud failure — a short
 * token here would produce a tutor whose every tool call comes back 401 mid-lesson.
 */
const MIN_TOKEN_LENGTH = 32;

/**
 * `serverInfo.name` from `app/api/mcp/route.ts`. The two do not have to match — OpenAI never reads
 * the server's own name — but a label that disagreed with it would make a trace of an `mcp_call`
 * item name a server nothing in this repo is called.
 */
const SERVER_LABEL = "tutor-collection";

/**
 * The `session.tools` array for one version.
 *
 * ## `require_approval: "never"` is not a convenience
 *
 * The default is `"always"`, which makes the model emit an `mcp_approval_request` item and WAIT for
 * an `mcp_approval_response` that must come from the client over the data channel. Nothing in
 * `apps/mobile/src/lib/transport/openai.ts` answers one, so the default would produce a tutor that
 * stalls on every tool call — visible as a lesson that stops talking, not as an error. The approval
 * this app relies on is upstream of the session: a version has to name the tool, and the server
 * exposes exactly one write-only, non-destructive tool (`add_words_to_collection`).
 *
 * ## What is deliberately not sent
 *
 * **`headers`.** `authorization` is the same thing in one field — OpenAI normalises it into
 * `headers: { Authorization: … }` on their side — and two ways to say it is two things to keep in
 * step. **`defer_loading`**, which trades a round trip for tools discovered lazily via tool search:
 * pointless against a server advertising a single tool. **`tool_choice`**, which stays `"auto"`:
 * this tutor's job is to teach, and a forced tool call would make it a form-filler.
 */
export function openAiMcpTools(v: PromptVersion, cfg: McpClientConfig): McpToolsResult {
  const allowed = v.mcpTools ?? [];
  // The common case, and the one that must stay free of every check below: a lesson that grants
  // nothing runs on a deployment that never configured MCP at all.
  if (allowed.length === 0) return { ok: true, tools: [] };

  if (!cfg.url) {
    return {
      ok: false,
      reason:
        `Version "${v.version}" grants MCP tools but MCP_PUBLIC_URL is not set. OpenAI dials our ` +
        `MCP server from their network, so it needs a publicly reachable URL for /api/mcp.`,
    };
  }
  let url: URL;
  try {
    url = new URL(cfg.url);
  } catch {
    return { ok: false, reason: `MCP_PUBLIC_URL is not a valid absolute URL: "${cfg.url}".` };
  }
  if (unreachableHost(url.hostname)) {
    return {
      ok: false,
      reason:
        `MCP_PUBLIC_URL points at ${url.hostname}, which OpenAI cannot reach — they dial the MCP ` +
        `server from their own network, not from this process. Use a deployed origin or a tunnel.`,
    };
  }
  // The token rides in a header on THIS url, to a third party, across the public internet. `http://`
  // would put it on the wire in cleartext, and the request would still work — which is exactly why
  // it is refused here rather than left to be noticed.
  if (url.protocol !== "https:") {
    return {
      ok: false,
      reason: `MCP_PUBLIC_URL must be https — it carries MCP_TOKEN to OpenAI. Got "${url.protocol}".`,
    };
  }
  if (!cfg.token || cfg.token.length < MIN_TOKEN_LENGTH) {
    return {
      ok: false,
      reason:
        `Version "${v.version}" grants MCP tools but MCP_TOKEN is unset or shorter than ` +
        `${MIN_TOKEN_LENGTH} chars — our own server would reject every call OpenAI makes.`,
    };
  }

  return {
    ok: true,
    tools: [
      {
        type: "mcp",
        server_label: SERVER_LABEL,
        server_url: url.toString(),
        authorization: cfg.token,
        allowed_tools: allowed,
        require_approval: "never",
      },
    ],
  };
}
