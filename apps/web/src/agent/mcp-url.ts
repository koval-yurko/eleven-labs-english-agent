/**
 * What every MCP mapper needs before it can hand a vendor our server's address.
 *
 * `openai-mcp.ts`, `elevenlabs-mcp.ts` and `vapi-mcp.ts` translate the same grant into three
 * vendors' vocabularies, and they share exactly one piece of reasoning — that the connection runs
 * *vendor → us*, so a URL that resolves on this machine cannot work no matter which vendor holds it.
 *
 * That reasoning lives here rather than in one of them because a second verbatim copy is how two
 * guards drift, and this one fails SILENTLY when it is wrong — the request never arrives, so there
 * is nothing in our logs to notice.
 *
 * ## Two of the three share more than the predicate; OpenAI does not
 *
 * `unreachableHost` is all OpenAI needs: its grant is a per-session object built by the token route
 * from `MCP_PUBLIC_URL`, so that environment variable IS the source and a bad one spoils one lesson.
 *
 * ElevenLabs and Vapi are the same shape as each other and a different shape from that: both hold a
 * PROVISIONED remote object, shared with production, that `pnpm sync:agents` writes the URL into. For
 * those two the environment variable is an OVERRIDE and the deployed origin is the source — which is
 * `resolveProvisionedMcpUrl` below, added when Vapi became the second of them. Sharing it is the same
 * argument as sharing the predicate: the guard is what stops a laptop's tunnel from being written
 * into the live agents, and two copies of it would drift.
 */

/**
 * Hosts that resolve somewhere on this machine or this network and nowhere on a vendor's.
 *
 * The loopback names are the ones a dev environment produces by default; the RFC 1918 ranges and
 * `.local` are the same mistake made from a LAN address, which looks more like a real URL and is
 * therefore likelier to be believed.
 */
export function unreachableHost(hostname: string): boolean {
  if (["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(hostname)) return true;
  if (hostname.endsWith(".local") || hostname.endsWith(".localhost")) return true;
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname);
}

/**
 * Where our MCP server lives, as A VENDOR will dial it.
 *
 * A CONSTANT, and that is a deliberate departure from `openai-mcp.ts`, which reads `MCP_PUBLIC_URL`
 * and refuses to run without it. The providers have different blast radii for the same mistake:
 * OpenAI's URL is baked into one minted session and affects one lesson, while this one is written
 * into remote objects every environment shares. `sync:agents` run on a laptop with a tunnel in
 * `MCP_PUBLIC_URL` would therefore repoint the LIVE agents at that laptop — and the tunnel then
 * dies. A constant makes the default outcome correct no matter whose machine runs the sync.
 *
 * The override still exists (`MCP_PUBLIC_URL` + `--allow-dev-mcp-url`), because someone will one day
 * need a tunnel here too. It just has to be asked for out loud.
 */
export const DEPLOYED_MCP_URL = "https://eleven-labs-english-agent.vercel.app/api/mcp";

/**
 * `lib/mcp/auth.ts` treats anything shorter than this as unset and rejects every request.
 *
 * Mirrored from that module rather than imported by it: this file is reached from a provisioning
 * script and from a route, and `auth.ts` reads `process.env` at module scope. The coupling is one
 * number with a loud failure — a short token produces a tutor whose every tool call comes back 401
 * mid-lesson — which is exactly why the mappers check it before a vendor is handed anything.
 */
export const MIN_MCP_TOKEN_LENGTH = 32;

export interface McpUrlOptions {
  /** `MCP_PUBLIC_URL`, when set. Ignored unless `allowOverride`. */
  overrideUrl?: string | undefined;
  /** `--allow-dev-mcp-url` — the flag that makes an override deliberate. */
  allowOverride?: boolean;
}

/** Names the vendor and its remote object, so one guard can write two readers' error messages. */
export interface ProvisionedVendor {
  /** "ElevenLabs", "Vapi" — as the reader would say it. */
  vendor: string;
  /** What that vendor calls the object the URL is written into: "registration", "assistant". */
  object: string;
}

export type McpUrlResult = { ok: true; value: string } | { ok: false; reason: string };

/**
 * The URL a provisioned MCP grant is written with: `DEPLOYED_MCP_URL`, unless an override was asked
 * for out loud AND survives every check a vendor's network would fail silently.
 */
export function resolveProvisionedMcpUrl(v: ProvisionedVendor, opts: McpUrlOptions): McpUrlResult {
  const override = opts.overrideUrl?.trim();
  if (!override || override === DEPLOYED_MCP_URL) return { ok: true, value: DEPLOYED_MCP_URL };

  // The override is real and differs. Refuse it unless it was asked for out loud — see
  // DEPLOYED_MCP_URL for what applying it would do to production.
  if (!opts.allowOverride) {
    return {
      ok: false,
      reason:
        `MCP_PUBLIC_URL is set to ${override}, which differs from the deployed origin this\n` +
        `  ${v.object} normally uses:\n      ${DEPLOYED_MCP_URL}\n` +
        `  The ${v.vendor} account is shared with production, so applying this would repoint the\n` +
        `  LIVE ${v.object}s' MCP server. Re-run with --allow-dev-mcp-url if that is what you want.`,
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
        `MCP_PUBLIC_URL points at ${parsed.hostname}, which ${v.vendor} cannot reach — they dial ` +
        `the MCP server from their own network, not from this process. Use a tunnel or a deployed ` +
        `origin.`,
    };
  }
  // https is not politeness: the URL carries a credential — a reference to one on ElevenLabs, the
  // secret itself on Vapi — and every tool call rides it. Both vendors reject a non-https MCP url
  // anyway; failing here says why.
  if (parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: `MCP_PUBLIC_URL must be https for an MCP server. Got "${parsed.protocol}".`,
    };
  }
  return { ok: true, value: parsed.toString() };
}
