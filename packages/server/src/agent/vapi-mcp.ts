/**
 * One `PromptVersion.mcpTools` grant → the **MCP tool block** a Vapi assistant carries in
 * `model.tools`.
 *
 * The fourth module of its kind, after ./vapi-assistant.ts, ./openai-mcp.ts and ./elevenlabs-mcp.ts:
 * a TRANSLATION between this repo's vocabulary and one vendor's, kept out of `sync-agents.ts` so the
 * decisions in it can be read without the plumbing around them. Its research note is
 * docs/2026-09-10-vapi-mcp-on-the-third-provider.md.
 *
 * ## The whole grant is one object, inline, with no id
 *
 * Vapi has a first-class MCP tool type (`CreateMcpToolDTO`), and it is accepted directly in
 * `model.tools` — so unlike ElevenLabs there is NO second remote object: no registration to create
 * before the assistant, none to delete after it, nothing to key by grant set in the lockfile. The
 * grant is a field of the assistant, and `sync:agents` keeps owning exactly one remote object per
 * version.
 *
 * Vapi also offers the other shape — `POST /tool` returns an id that `model.toolIds` can name — and
 * it is deliberately not used. That is ElevenLabs' model, adopted voluntarily, and it would buy
 * nothing: there is one server and (see below) no way to narrow it, so two versions sharing a stored
 * tool would share an object whose only content is a URL and a header.
 *
 * ## Vapi grants at the SERVER — one step coarser even than ElevenLabs
 *
 * `CreateMcpToolDTO` has no allowlist field. Vapi fetches the tool list from the MCP server WHEN THE
 * CALL STARTS and hands the model everything it advertises. ElevenLabs at least projects a grant onto
 * a registration, so two grant sets can exist side by side; here there is not even that, so:
 *
 *   > on a Vapi version, `mcpTools` is a SWITCH — non-empty means "attach our MCP server" — and the
 *   > names in it are documentation of what the lesson expects to find there.
 *
 * With one tool on `/api/mcp` that distinction is invisible. It becomes real the day a second tool is
 * registered: every Vapi version with a non-empty `mcpTools` gets it retroactively, which is the
 * outcome the field exists to prevent and cannot on this provider. `prompts/types.ts` says so where
 * someone setting the field will read it.
 *
 * (`rejectionPlan` — regex or Liquid over the conversation — can refuse a tool CALL from what was
 * said. It is not an allowlist, and using it as one would put a regular expression between the
 * learner and their own vocabulary.)
 *
 * ## Nothing to approve
 *
 * OpenAI needed `require_approval: "never"` and ElevenLabs needed `auto_approve_all`, both because
 * their defaults stall a lesson waiting for a client that never answers. Vapi has no approval
 * mechanism at all: a tool call runs. This provider's version of that decision is free, and the
 * approval this app relies on is the same one it always was — upstream of the conversation, in a
 * version naming the grant against a server exposing one write-only, non-destructive tool.
 *
 * ## The credential goes IN, in the clear
 *
 * This is the one genuinely new thing, and the reason `sync:agents` reads `MCP_TOKEN` for the first
 * time. Three providers, three custody stories:
 *
 *   - **OpenAI** — the token route reads `MCP_TOKEN` per request and hands it over per session.
 *   - **ElevenLabs** — a human puts it in a workspace secret; the sync resolves an id, never a value.
 *   - **Vapi** — there is no secret store in the public API surface, so the value is written into the
 *     assistant object as `server.headers.Authorization`, where it sits at rest.
 *
 * `Server.credentialId` plus a `custom-credential` holding a `BearerAuthenticationPlan` is the shaped
 * alternative and is the upgrade path, but Vapi's OpenAPI document publishes no credential endpoint,
 * so provisioning one would mean betting the sync on undocumented API surface. See §4.3 of the note.
 *
 * Two consequences worth stating out loud, because both are silent when they go wrong:
 *
 *  1. **A rotation of `MCP_TOKEN` propagates ONLY by re-running the sync.** It does, automatically —
 *     `vapiHash` hashes the body that will be sent, so a new token is a changed body is a PATCH.
 *  2. **A sync run without `MCP_TOKEN` would PATCH the live assistant with `Bearer `** and every tool
 *     call would 401 mid-lesson. That is why `vapiMcpConfig` returns a REASON rather than an empty
 *     grant: `sync-agents.ts` feeds it to the driver's `unavailable()`, and a provider that cannot run
 *     is skipped with its reason printed rather than half-applied.
 */
import {
  MIN_MCP_TOKEN_LENGTH,
  resolveProvisionedMcpUrl,
  type McpUrlOptions,
  type ProvisionedVendor,
} from "./mcp-url";
import type { McpClientConfig } from "./openai-mcp";
import type { EffectiveAgentConfig, PromptVersion } from "./prompts";

/** How ./mcp-url.ts's shared URL guard addresses this provider's reader. */
const VAPI_VENDOR: ProvisionedVendor = { vendor: "Vapi", object: "assistant" };

/**
 * `shttp` is Streamable HTTP; `sse` is the deprecated alternative. `app/api/mcp/route.ts` is
 * `mcp-handler`'s Streamable HTTP handler — one path, `GET`/`POST`/`DELETE`, no separate SSE
 * endpoint — so `sse` cannot talk to it at all.
 *
 * Vapi's default is already `shttp`, unlike ElevenLabs' (whose SSE default is simply wrong for us).
 * Pinned anyway, for the reason every other platform default in this registry is pinned: the value
 * is ours, and a default that moved would move a live assistant with it.
 */
const PROTOCOL = "shttp" as const;

/**
 * Below `route.ts`'s `maxDuration = 60` and well below a spoken turn's patience — the same number and
 * the same argument as `response_timeout_secs` on ElevenLabs. It equals Vapi's own default (range
 * 1–300), and is still stated rather than inherited.
 *
 * `backoffPlan` is deliberately absent beside it, which means no retries. That is what the save
 * clause already tells the tutor to do: "if saving fails, don't retry it and don't dwell on it".
 */
const TOOL_TIMEOUT_SECONDS = 20;

/** The `model.tools` entry, exactly as `CreateMcpToolDTO` takes it. */
export interface VapiMcpTool {
  type: "mcp";
  server: { url: string; headers: Record<string, string>; timeoutSeconds: number };
  metadata: { protocol: typeof PROTOCOL };
  /**
   * **This provider's `pre_tool_speech: "off"`.** Vapi speaks these while a tool runs
   * (request-start / complete / failed / delayed), and the save clause exists specifically to stop
   * the tutor narrating the tool — "Saving is quiet". An empty array at the parent suppresses them
   * for every tool loaded from the server, so this does not have to name `add_words_to_collection`
   * the way the per-tool `toolMessages` override would, and cannot drift from the grant.
   */
  messages: never[];
}

/** What the tool block needs from the environment, once every check has passed. */
export interface VapiMcpConfig {
  /** Absolute https URL of `/api/mcp` AS VAPI WILL DIAL IT. */
  url: string;
  /** `MCP_TOKEN`. Becomes the `Authorization` header value, `Bearer` prefix added here. */
  token: string;
}

/**
 * Either the config every granting Vapi version will be built with, `null` for a registry where none
 * grants anything, or the one-line reason there can be none.
 *
 * The same three-outcome shape as `openAiMcpTools` and `elevenLabsMcpRegistrations`, and the middle
 * one is the dangerous one for the same reason: a registry granting nothing is normal, a version
 * granting tools we cannot wire up is a MISCONFIGURED DEPLOYMENT, and an assistant quietly
 * provisioned with a credential-less tool block is the failure this shape exists to make impossible.
 */
export type VapiMcpConfigResult =
  | { ok: true; mcp: VapiMcpConfig | null }
  | { ok: false; reason: string };

/**
 * Resolved ONCE per sync rather than per version, because every check in it is about the deployment
 * and not about the lesson. Pure: no network, no `process.env` read of its own, so
 * `sync:agents --dry-run` can consult it on a machine holding no credentials.
 */
export function vapiMcpConfig(
  versions: PromptVersion[],
  cfg: McpClientConfig,
  opts: McpUrlOptions = {},
): VapiMcpConfigResult {
  const granting = versions.filter((v) => (v.mcpTools ?? []).length > 0);
  // The common case, and the one that must stay free of every check below: a registry where no Vapi
  // version grants anything runs on a deployment that never configured MCP at all.
  if (granting.length === 0) return { ok: true, mcp: null };

  const url = resolveProvisionedMcpUrl(VAPI_VENDOR, opts);
  if (!url.ok) return url;

  if (!cfg.token || cfg.token.length < MIN_MCP_TOKEN_LENGTH) {
    return {
      ok: false,
      reason:
        `${granting.length === 1 ? "Version" : "Versions"} ` +
        `${granting.map((v) => `"${v.version}"`).join(", ")} ` +
        `${granting.length === 1 ? "grants" : "grant"} MCP tools on Vapi, but MCP_TOKEN is unset\n` +
        `  or shorter than ${MIN_MCP_TOKEN_LENGTH} chars. Unlike ElevenLabs, Vapi has no workspace\n` +
        `  secret to point at — the token is written into the assistant — so syncing without it\n` +
        `  would replace a working tool block with one whose every call our own server rejects.`,
    };
  }

  return { ok: true, mcp: { url: url.value, token: cfg.token } };
}

/**
 * One version's `model.tools`. Empty for a version that grants nothing, and empty when there is no
 * config — which is only ever the state a `--dry-run` on a credential-less machine sees, because the
 * apply path refuses to run this provider at all in that case.
 *
 * The url is ALWAYS set when a block is emitted, and that is load-bearing rather than obvious:
 * `CreateMcpToolDTO.server` documents a fallback chain — `{{tool.server.url}}`,
 * `{{assistant.server.url}}`, … — and our assistants set `server.url` to the end-of-call webhook
 * route. A block emitted without a url would therefore point Vapi's MCP client at
 * `/api/v2/vapi/webhook`. Do not make this field conditional.
 */
export function vapiMcpTools(c: EffectiveAgentConfig, mcp: VapiMcpConfig | null): VapiMcpTool[] {
  if (c.mcpTools.length === 0 || !mcp) return [];
  return [
    {
      type: "mcp",
      server: {
        url: mcp.url,
        // `Bearer <token>`, assembled here rather than stored assembled: this is the one provider
        // that holds the raw `MCP_TOKEN`, so the prefix `lib/mcp/auth.ts` requires is ours to add.
        headers: { Authorization: `Bearer ${mcp.token}` },
        timeoutSeconds: TOOL_TIMEOUT_SECONDS,
      },
      metadata: { protocol: PROTOCOL },
      messages: [],
    },
  ];
}
