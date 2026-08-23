# An MCP server for the collection: one tool, `add_words`

**Status: RESEARCH, nothing built.** The question is how to expose this app's vocabulary collection
over the Model Context Protocol, starting with a single tool that takes a list of strings, checks
which are already in the learner's collection, and adds the ones that are new — protected by the
**same Auth0** that already guards `/api/v2`.

## 1. The short version

- The **write path already exists and is already batch-shaped.** `resolve_words(p_owner_id, p_texts[])`
  takes an array and reports `was_created` per row. Nothing new is needed in Postgres.
- The **MCP server is a single Next route handler** in `apps/web` — `POST /api/mcp` — built with
  `mcp-handler@2` on top of `@modelcontextprotocol/server@2`. Stateless, no Redis, no new service.
- The tool calls `lib/words.ts` **in-process**, not over HTTP. The MCP spec explicitly forbids
  passing a received token to a downstream service; an internal `fetch` back into our own
  `/api/v2/lesson-items` would be exactly that, plus a second network hop for nothing.
- **Auth0 is the expensive part, and it is not "verify a JWT".** Verifying the token is ten lines we
  already have (`lib/auth/bearer.ts`). What MCP additionally requires is that the server *advertise*
  how a client gets a token: RFC 9728 Protected Resource Metadata, a `WWW-Authenticate` challenge on
  401, and an Auth0 tenant configured to accept the RFC 8707 `resource` parameter and to register
  clients dynamically. That is roughly **three tenant toggles and one new Auth0 API**, and the
  toggles are tenant-wide — they affect the existing web and mobile logins' tenant, which is the one
  thing in this document worth being careful about.
- **The ElevenLabs tutor agent is not a viable first consumer.** Its MCP integration authenticates
  with a workspace-level static secret header, not per-user OAuth, so there is no way for it to act
  as *this* learner. If the goal is "the tutor adds a word mid-lesson", that is a **webhook tool**,
  not MCP. See §7.

## 2. What the tool is

One tool. Input is a list of strings; output says, per string, whether it was added, was already
there, or was empty.

```
add_words(words: string[])  →  { added: [...], already_present: [...], skipped: [...] }
```

The name matters more than it looks: it is what a model reads when deciding whether to call it. It
should say *collection*, because that is the domain word this app uses everywhere else, and because
"add words" without a noun invites a model to use it for a shopping list.

Proposed:

```ts
server.registerTool(
  "add_words_to_collection",
  {
    title: "Add words to the English collection",
    description:
      "Add English words, phrases or sentences to the learner's vocabulary collection. " +
      "Each entry is checked first: one that is already in the collection is reported as such " +
      "and is not duplicated. Use for vocabulary the learner wants to practise later.",
    inputSchema: z.object({
      words: z
        .array(z.string().min(1).max(500))
        .min(1)
        .max(50)
        .describe("English words, phrases or full sentences. One entry per item."),
    }),
  },
  async ({ words }, ctx) => { /* … */ },
);
```

`max(500)` is `MAX_WORD_LENGTH` from `@tutor/shared/words/key`; `max(50)` mirrors `MAX_ITEMS` from
the offline op algebra, which is the cap this codebase already chose for "one batch of words".

### 2.1 The data function it needs

`addWord` in `lib/words.ts` is singular and does two round trips (resolve, then bump). For N words
that is N+1. The batch version is a small, honest addition beside it — one RPC for the resolve, one
bump per duplicate:

```ts
export interface AddWordsResult {
  added: { id: string; text: string }[];
  alreadyPresent: { id: string; text: string; popularity: number | null }[];
  skipped: string[]; // normalized to empty, or dropped as a duplicate of another input
}

export async function addWords(ownerId: string, rawTexts: string[]): Promise<AddWordsResult>;
```

Three details it must not get wrong, all of which the existing singular path already gets right:

1. **Dedupe the input by `clientDedupeKey` before the RPC**, not after. `resolve_words` loops over
   the array and upserts each element, so `["Ubiquitous.", "ubiquitous"]` would produce two rows in
   the result map pointing at one word, and the second would report `was_created = false` — i.e. the
   caller would announce "already in your collection" for a word it added one millisecond earlier.
2. **Two inputs can legitimately collapse onto one word id.** `resolveWords`' own doc comment says
   so. Group the output by id, not by text.
3. **`scheduleWordJobs(ownerId)` when anything was actually added.** Without it an MCP-added word has
   no CEFR level and no `details` until the next sweep, and nothing about that is visible at the
   time. This is the same failure the mobile route's doc comment calls out; a third writer is a third
   place to forget it.

### 2.2 The popularity bump, which is the one semantic choice

`addWord` bumps `popularity` on a duplicate — "I met this again" — and returns the new count. An MCP
client retries. A retried `add_words_to_collection` is therefore **not idempotent**: the words are
(the RPC is an upsert), the counter is not.

Recommendation: **bump anyway.** Popularity is a soft signal, an agent re-sending a list it already
sent is a weak version of the same statement, and the alternative — an MCP path whose duplicate
branch silently differs from every other duplicate branch in the app — is worse than an occasionally
inflated integer. Worth one line in the tool's response so it is not invisible.

## 3. Where it lives, and what it is built on

### 3.1 The library

`mcp-handler@2.1.1` (Vercel), peers `@modelcontextprotocol/server@^2.0.0` and `next >= 13.0.0`. It
turns an MCP server definition into a Web-standard `(Request) => Promise<Response>` handler, serves
the **2026-07-28** spec natively, and transparently falls back to stateless Streamable HTTP for
2025-era clients — one handler, both protocol generations. Stateless: **no Redis**, which matters
because the alternative (raw SDK + `StreamableHTTPServerTransport` with session state) needs a store
to survive a serverless instance swap.

Writing against the raw SDK is the alternative and it is not obviously worse for one tool, but it
means owning session management, the dual-spec fallback, and the RFC 9728 plumbing by hand. For one
tool that is a lot of surface for no gain.

**One dependency friction to plan for.** `@modelcontextprotocol/server@2` depends on `zod@^4`;
`apps/web` is on `zod@3.25.76`.

> ~~The clean answer is already installed: zod 3.25 ships Zod 4 at the `zod/v4` subpath.~~
> **Wrong, and disproved in S0.** The subpath exists, but the SDK does not want a Standard Schema —
> it wants a `StandardSchemaWithJSON`, because `tools/list` has to advertise the argument shape as
> JSON Schema. `zod@3.25.76`'s `zod/v4` gives a schema `~standard.validate` and **no
> `~standard.jsonSchema`**, so it satisfies neither the type nor the runtime.
>
> The chosen answer is an **alias**: `"zod4": "npm:zod@^4.4.3"` in `apps/web/package.json`, imported
> as `import { z } from "zod4"` by MCP code only. Upgrading `zod` outright was the alternative and
> was rejected for one reason: `@langchain/core@0.3.80` pins `zod@^3.25.32`, and the two schemas it
> parses structured output with (`lib/levels.ts`, `lib/word-details.ts`) are the level and
> enrichment jobs. A second copy of zod on a server-only route is cheaper than a compatibility
> question hanging over both LLM jobs.

### 3.2 The route

```
apps/web/src/app/api/mcp/route.ts
```

`/api/mcp`, not `/api/v2/mcp`. `/api/v2` is the *native client's* namespace with its own CORS policy
and its own error envelope (`{ error: { code, message } }`); MCP has its own error envelope
(JSON-RPC) and its own 401 semantics (`WWW-Authenticate` with a `resource_metadata` pointer). Mixing
them buys nothing and makes the v2 contract in `packages/shared/src/api.ts` describe a route no v2
client will ever call.

Sketch:

```ts
// apps/web/src/app/api/mcp/route.ts
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod/v4";

import { verifyMcpToken } from "../../../lib/mcp/auth";
import { registerAddWords } from "../../../lib/mcp/add-words";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const handler = createMcpHandler((server) => {
  registerAddWords(server);
});

const authed = withMcpAuth(handler, verifyMcpToken, {
  required: true,
  requiredScopes: ["words:write"],
  resourceMetadataPath: "/.well-known/oauth-protected-resource/api/mcp",
});

export { authed as GET, authed as POST };
```

`withMcpAuth` is what produces the RFC 9728-compliant `WWW-Authenticate` challenge on 401 and the 403
on insufficient scope. `verifyToken` receives `(req, bearerToken)` and returns an `AuthInfo`
(`{ token, scopes, clientId, extra? }`) or `undefined`. The owner id rides in `extra`, and reaches a
tool through `ctx.http?.authInfo`.

`verifyMcpToken` is `getBearerOwnerId` with the audience swapped and the scopes read out — same
`jose` + `createRemoteJWKSet` at module scope, same pinned `RS256`, same trailing-slash issuer, same
fail-closed-on-missing-config rule. It should be written as a *sibling* of `lib/auth/bearer.ts`, not
a parameterization of it: `withBearer` is deliberately the one cookie-free path for the native
client, and threading a second audience through it is how that separation starts to erode.

### 3.3 The metadata document

MCP servers **MUST** implement RFC 9728, and the document **MUST** list at least one
`authorization_servers` entry. For a path-scoped resource the canonical location is the path-suffixed
form:

```
GET /.well-known/oauth-protected-resource/api/mcp
```

```json
{
  "resource": "https://tutor.example.com/api/mcp",
  "authorization_servers": ["https://YOUR_TENANT.eu.auth0.com/"],
  "scopes_supported": ["words:write"],
  "bearer_methods_supported": ["header"]
}
```

`mcp-handler` exports `protectedResourceHandler` for the GET and `metadataCorsOptionsRequestHandler`
for the OPTIONS preflight (browser-based MCP clients preflight it).

**Serving a `.well-known` path from the App Router needs a five-minute check before it is designed
around.** `app/.well-known/oauth-protected-resource/api/mcp/route.ts` is used in the wild and should
work, but dot-prefixed directories are a corner of Next's file conventions with no explicit
documentation. The guaranteed-portable alternative is a normal route plus a rewrite:

```ts
// next.config.ts
rewrites: async () => [
  {
    source: "/.well-known/oauth-protected-resource/:path*",
    destination: "/api/oauth-protected-resource/:path*",
  },
],
```

Decide this by trying the folder first and falling back; do not spend an hour on it either way.

## 4. Auth0 — what actually has to change

The user requirement is "the same Auth0". Two things are being asked at once, and only the first is
free:

1. **Verify the token the same way.** Already solved. Same tenant, same JWKS, same `RS256`, same
   `sub` → `ownerId`.
2. **Let an MCP client obtain such a token without a human pasting one.** This is the OAuth 2.1
   discovery dance, and it is where the tenant configuration lives.

### 4.1 What the spec requires of us

From the MCP authorization spec (2025-06-18, still the load-bearing text, hardened by the 2026-07-28
revision):

- Server **MUST** implement RFC 9728 Protected Resource Metadata.
- Server **MUST** send `WWW-Authenticate` on 401 pointing at that metadata URL.
- Server **MUST** validate that the token was issued *specifically for it* — the audience claim.
- Server **MUST NOT** accept or transit tokens issued for anything else, and **MUST NOT** pass the
  received token through to an upstream API.
- Client **MUST** send the RFC 8707 `resource` parameter — the server's canonical URI — on both the
  authorization request and the token request. Clients send it whether or not the AS supports it.
- Authorization server **MUST** provide RFC 8414 metadata and **SHOULD** support RFC 7591 Dynamic
  Client Registration. (The 2026-07-28 revision adds Client ID Metadata Documents as the modern
  alternative to DCR, plus issuer validation, `offline_access` for refresh tokens, and scope
  accumulation on step-up.)

Auth0 provides RFC 8414 metadata out of the box. The other two need toggles.

### 4.2 Tenant changes, concretely

Dashboard → **Settings → Advanced**:

| Toggle | Why | Blast radius |
| --- | --- | --- |
| **Resource Parameter Compatibility Profile** | Auth0 has used `audience` since 2017 and ignores `resource` without this. MCP clients send `resource`. | Tenant-wide. Safe for existing logins: when *both* are present **`audience` still wins**, and web/mobile send `audience` and never `resource`. |
| **Include Issuer in Authorization Responses** | Adds `iss` to the authorization response; the 2026-07-28 revision's issuer-validation requirement. | Tenant-wide, additive parameter. |
| **Dynamic Client Registration** | Off by default for all tenants. Without it (and without CIMD support in the client) an MCP client cannot get a `client_id` on its own. | Tenant-wide, and **this is the one with a real downside** — see §8.1. |

Dashboard → **Applications → APIs → Settings**: DCR-created apps are *third-party* applications, and
you cannot grant API access to them individually. So the MCP API needs
**"Default Permissions for Third-Party Applications"** configured with `words:write` under
User-Delegated access. Third-party apps also always show a consent screen, which is the right
behaviour here — the learner should see "Claude wants to add words to your collection".

### 4.3 The decision that has no free answer: which API identifier

RFC 8707 requires `resource` to be an absolute URI, and Auth0's compatibility profile maps it onto an
API identifier — so with the profile on, `resource` must **equal an existing Auth0 API identifier**.
Auth0's own recommendation is to define API identifiers as URIs for exactly this reason.

**Option A — a new Auth0 API per environment, identifier = the canonical MCP URL.**
`https://tutor.example.com/api/mcp` for prod, the dev origin for dev. Tokens carry `aud` = that URL,
which is precisely the audience binding the spec asks for: a mobile token cannot drive the MCP
server, and an MCP token cannot drive `/api/v2`. Server verifies against a new
`AUTH0_MCP_AUDIENCE`.
Cost: two Auth0 APIs, and **the dev identifier is tied to a tunnel URL that changes**. Mitigate with a
stable dev hostname, or accept editing the API identifier when the tunnel rotates. (The same tunnel
instability already shows up in `ELEVENLABS_WEBHOOK_FORWARD_URL`, so this is a known local cost, not
a new class of problem.)

**Option B — reuse the existing `AUTH0_API_AUDIENCE`.** No new API, no new env var. But the PRM
document must still advertise `resource` = the MCP URL, so `resource` and the issued `aud` disagree;
clients that assert `aud === resource` will reject the token, and any token minted for the mobile app
becomes a valid MCP token. For the same owner with the same permissions the practical risk is small,
but it is exactly the audience-binding property the spec spends a whole section on.

**Recommendation: A.** B is defensible for an afternoon spike and should not survive it.

> **Decided 2026-08-23: B.** That is a legitimate call, but B as described above *does not work* —
> not for a security reason, for a mechanical one. See §11.2 for the chain and for the one tenant
> configuration that makes B function.

### 4.4 The end-to-end flow, once configured

```
Claude (or any MCP client)
  │  POST /api/mcp                                   (no token)
  ▼
/api/mcp  ──► 401  WWW-Authenticate: Bearer resource_metadata="https://…/.well-known/oauth-protected-resource/api/mcp"
  │
  ├─ GET  /.well-known/oauth-protected-resource/api/mcp   → { authorization_servers: [Auth0] }
  ├─ GET  https://TENANT/.well-known/oauth-authorization-server   → RFC 8414 metadata
  ├─ POST https://TENANT/oidc/register                     → client_id            (DCR)
  ├─ browser: /authorize  + PKCE + resource=https://…/api/mcp + scope=words:write offline_access
  │           learner logs in with the SAME Auth0 account as the app, consents
  └─ POST  /oauth/token   + code_verifier + resource       → access token (aud = https://…/api/mcp)
  │
  ▼
POST /api/mcp  Authorization: Bearer …   →  verifyMcpToken → sub → addWords(sub, words)
```

The learner's `sub` is the same string the mobile app writes with, so a word added through Claude
appears in the phone's collection on the next refresh. That property is free and it is the whole
point.

## 5. What does *not* belong in `packages/shared`

Apply the repo's own test from `CLAUDE.md`: *if this had a bug, could I fix it by deploying the web
app alone?* Yes, entirely — the MCP tool schema, the PRM document, the `AddWordsResult` shape. **None
of it goes in `@tutor/shared`.** No MCP client is a client of `api.ts`. The only shared code involved
is what already exists and is already imported: `wordInputKey`, `clientDedupeKey`, `MAX_WORD_LENGTH`,
`MAX_ITEMS`.

## 6. File plan

```
apps/web/src/app/api/mcp/route.ts                    new   handler + withMcpAuth wiring
apps/web/src/lib/mcp/add-words.ts                    new   registerTool + response formatting
apps/web/src/lib/mcp/auth.ts                         new   verifyMcpToken (sibling of auth/bearer.ts)
apps/web/src/lib/mcp/metadata.ts                     new   protectedResourceHandler config
apps/web/src/app/.well-known/oauth-protected-resource/api/mcp/route.ts
                                                     new   (or a rewrite to /api/oauth-protected-resource/*)
apps/web/src/lib/words.ts                            edit  + addWords(ownerId, texts[])
apps/web/src/lib/config.ts                           edit  + mcpConfig(): { audience, resourceUrl }
apps/web/package.json                                edit  + mcp-handler, @modelcontextprotocol/server
apps/web/.env.example / deployment env               edit  + AUTH0_MCP_AUDIENCE, MCP_RESOURCE_URL
```

Nine files, one of them a `package.json`. The tool body itself is about thirty lines.

## 7. Who consumes it — and the ElevenLabs finding

**Claude Code / Claude Desktop / any OAuth-capable MCP client.** The intended consumer. Add as a
remote HTTP server pointed at `https://…/api/mcp`; the client drives §4.4 by itself. This is the one
to build for.

**The ElevenLabs tutor agent — no, and this is worth knowing before designing around it.** ElevenLabs
agents *do* support external MCP servers over both SSE and Streamable HTTP, with per-tool approval
modes (Always Ask / fine-grained / no approval). But the authentication options are a **server URL
that may embed a secret, an optional static secret token header, and static custom headers** — all
configured at the workspace level. There is no per-conversation credential and no OAuth. So an
ElevenLabs-hosted MCP connection cannot present *this learner's* Auth0 token; it would either be
unauthenticated or authenticate as one fixed identity. Two further constraints: MCP servers are not
manageable via the ElevenLabs CLI (dashboard/SDK only), which means they would sit outside the
`agents.lock.json` versioned-registry discipline this repo deliberately built; and MCP is unavailable
for Zero Retention Mode and HIPAA workspaces.

If "the tutor adds a word it just taught" is a goal, the correct mechanism is an ElevenLabs
**webhook tool** hitting `POST /api/v2/lesson-items`, with the learner's identity carried the way
identity is already carried into a lesson — the dynamic variables stamped at session start, the same
channel `lesson_id` and `app_env` already ride on. That is a different piece of work with a different
threat model (dynamic variables come from the client and, as the webhook route's comment already
says, *are never trusted for ownership*). It should not be folded into this one.

## 8. Risks

### 8.1 Dynamic Client Registration is an open endpoint

Turning DCR on lets anyone register a client against the tenant. It is a documented abuse vector —
resource exhaustion and a pile of junk applications — and Auth0's mitigations (tenant access control
lists, reverse proxy) are **Enterprise-only**. Three ways out, in order of preference:

1. **Prefer CIMD.** The 2026-07-28 revision replaces DCR with Client ID Metadata Documents — the
   client uses an HTTPS URL as its identifier, no registration call. If the intended client supports
   it, DCR never has to be enabled. Check this before flipping the toggle.
2. **Enable DCR, watch the application list.** Acceptable for a single-learner app; revisit if the
   tenant is ever shared.
3. **Skip both:** hand-register one Auth0 application and configure the client with that `client_id`.
   Loses zero-config connection, keeps the tenant closed.

### 8.2 A write tool reachable by a model is a prompt-injection sink

`add_words_to_collection` is low-severity by construction — it creates rows in the caller's own
collection and cannot read anything, delete anything, or reach another learner. The realistic bad
outcome is junk vocabulary, cleaned up with the existing delete. Keep it that way: **do not add a
read tool, a delete tool, or a lesson tool to this server without revisiting the threat model.** The
50-item cap and the 500-character-per-entry cap are the whole mitigation, and they are enough for
exactly this tool.

### 8.3 Verify, don't assume

- ~~**`after()` inside a tool callback.**~~ **Resolved in S0: it fires.** Both words added through
  `tools/call` came back with `level_at` and `details_at` stamped within seconds — one levelled `C1`
  with details, the nonsense one stamped-but-empty, which is the ATTEMPTED-flag semantics working
  exactly as designed. `mcp-handler`'s request plumbing does not break `after()`.
- ~~**`zod/v4` against `@modelcontextprotocol/server@2`.**~~ **Resolved in S0: it does not work.**
  See the correction in §3.1 — the SDK needs `~standard.jsonSchema`, which `zod@3.25`'s subpath does
  not implement. Fixed with a `zod4` alias.
- **The `.well-known` folder in the App Router** (§3.3).
- **Tenant toggles are tenant-wide.** The compatibility profile is documented as `audience`-wins when
  both are present, and web/mobile never send `resource` — so existing logins should be untouched.
  Confirm a mobile login still works immediately after flipping it, rather than discovering it later.

## 9. Staging

**S0 — the tool, unauthenticated, local. ✅ DONE 2026-08-23.** `createMcpHandler` +
`add_words_to_collection` + `addWords` in `lib/words.ts`, owner id from `MCP_DEV_OWNER_ID`. Driven
over raw JSON-RPC (`initialize` → `tools/list` → `tools/call`). What it proved, in one call:

```
words: ["quokkafied", "Quokkafied.", "quokkafied", "   ", "reconcile", "to hedge one's bets"]
→ added:           Quokkafied.  ·  to hedge one's bets
  already_present: reconcile (met 1×)
  skipped:         "quokkafied" (dup of an earlier entry)  ·  "   " (empty)
```

Every branch of §2.1 in one shot. `"quokkafied"` and `"Quokkafied."` have different
`clientDedupeKey`s, so both reached the RPC and Postgres collapsed them onto **one** id — the group
was reported **once, as added** (not as a duplicate of itself), under the last-typed spelling. That
is the exact bug §2.1 items 1 and 2 exist to prevent, and it is the one thing a loop over `addWord`
would have got wrong.

Also settled here: `after()` fires (§8.3), the `zod/v4` plan does not (§3.1), and the route's
`mcpDevOwnerId()` gate returns **404** with the variable unset — the same branch production takes,
so the unauthenticated stage cannot be deployed.

**S1 — Auth0 verification, token pasted by hand.** `verifyMcpToken` + `withMcpAuth` + the PRM
document + the 401 challenge. Test with a real access token copied from the mobile app (Option B
audience) or from the new API's test tab (Option A). No tenant toggles yet. At the end of S1 the
server is correct and spec-shaped; it just cannot be connected zero-config.

**S2 — the tenant.** New Auth0 API with the canonical URL as identifier, `words:write` scope, default
third-party permissions, compatibility profile + issuer-in-response on, DCR (or CIMD) resolved per
§8.1. Connect Claude Code end-to-end and add a word from a chat.

**S3 — the honest edges.** Popularity-bump note in the response, a `console` line per call for the
same reason every other write path has one, and a decision on whether the dev environment gets its
own Auth0 API or is left as pasted-token-only.

S0 and S1 are the work. S2 is configuration and is where the surprises will be.

## 10. Open questions — answered 2026-08-23

1. **Which client?** Claude, ChatGPT, *any* remote MCP client. Not an internal script — the full
   OAuth discovery dance in §4 is required, and it now has to work for more than one client
   implementation. See §11.1.
2. **Option A or B?** **B** — reuse the existing `AUTH0_API_AUDIENCE`, no new Auth0 API. See §11.2.
3. **Dev MCP-connectable?** No. Dev is localhost-only, no tunnel. See §11.3.
4. **First of several tools?** **Yes, the first.** So §8.2's threat model is due now, not later.
   See §11.4.

## 11. What the answers change

Three of the four answers are cheap. One of them — Option B — turns out to be the load-bearing one,
and not for the reason §4.3 gave.

### 11.1 "Claude, ChatGPT, any remote client" raises the compliance bar

Writing for one client lets you tolerate its quirks. Writing for *any* client means the server has to
be right, because each client enforces a different subset of the spec and they do not overlap
politely.

| Client | What it needs from us | Notes |
| --- | --- | --- |
| **Claude Code / Desktop / claude.ai** | RFC 9728 PRM whose `resource` **matches the server URL**, `WWW-Authenticate` on 401, DCR or a pasted `client_id` | Strictest on the PRM check — see 11.2 |
| **ChatGPT** (developer mode) | DCR **or** CIMD; connector added by URL; write tools require per-conversation manual confirmation | Its deep-research surface wants a `search`/`fetch` tool pair — see 11.4 |
| **VS Code** | Sends `resource`, never `audience` | Documented as *unable* to use Auth0 today without help (`microsoft/vscode#274226`) |

Two consequences worth stating before any code is written:

- **The PRM `resource` value is not decorative — clients discard the document on mismatch.** RFC 9728
  requires it and clients enforce it. Claude Code fails *before opening the browser* with
  `Protected resource <x> does not match expected <server-url>`. This is the exact wall that
  Microsoft Entra-protected MCP servers hit (`anthropics/claude-code#76096`, closed as duplicate, no
  workaround implemented): Entra demands `resource` = an `api://<guid>` App ID URI, Claude Code
  demands `resource` = the server's own URL, and there is no value that satisfies both.
- **`resource` and `aud` are allowed to differ; `resource` and the server URL are not.** That
  distinction is what saves Option B, and it is the whole of 11.2.

### 11.2 Option B does not work as written — and here is the version that does

The chain, in order, all of it verified:

1. Every MCP client **MUST** send `resource` = the canonical MCP URL (spec, §4.1). Not optional, not
   configurable, and they send it whether or not the AS understands it.
2. The PRM must advertise that same URL, or Claude Code (and any RFC 9728-conformant client)
   discards the document. So the advertised `resource` is pinned to `https://…/api/mcp`.
3. **With the Resource Parameter Compatibility Profile ON**, Auth0 maps `resource` → audience and
   requires it to name an existing API identifier. Under Option B no such API exists, so the token
   request fails with Auth0's `Service not enabled within domain`. **B + the profile is broken.**
4. **With the profile OFF**, Auth0 ignores `resource` entirely and falls back to `audience` — which
   no MCP client sends. Auth0 with no audience issues an **opaque/encrypted token**, not an
   RS256 JWT. `jose` + JWKS cannot verify it. **B + no profile is also broken.**

The escape is the tenant's **Default Audience** (Dashboard → Settings → API Authorization Settings):
set it to the existing `AUTH0_API_AUDIENCE` and *leave the compatibility profile OFF*. Then the PRM
advertises the honest MCP URL (clients are satisfied), the client sends `resource` (Auth0 ignores it,
harmlessly), and every token comes out as an RS256 JWT with `aud` = the existing API. `verifyMcpToken`
becomes literally `getBearerOwnerId` plus a scope read. No new API, no new env var, and — this is the
part that makes B coherent with answer 3 — **no dev tunnel problem, because no API identifier is ever
tied to a URL.**

So the tenant change list from §4.2 is now *different*, not just shorter:

| Setting | Option A (was) | **Option B (now)** |
| --- | --- | --- |
| Resource Parameter Compatibility Profile | ON | **OFF — turning it on breaks B** |
| Default Audience | not needed | **= `AUTH0_API_AUDIENCE`, required** |
| Include Issuer in Authorization Responses | ON | ON (independent, additive) |
| New Auth0 API | one per environment | none |

**The cost, stated once, precisely.** `withBearer` (`apps/web/src/lib/auth/bearer.ts`) validates
issuer, `RS256`, `aud` and `sub` — **and no scopes**. Mobile logs in with
`scope: "openid profile email offline_access"` (`apps/mobile/src/lib/auth.tsx:84`), so there is no
scope for it to check. Under B, `aud` is the same string for both surfaces. Therefore:

- A **mobile token cannot drive `/api/mcp`** — `withMcpAuth`'s `requiredScopes: ["words:write"]`
  rejects it. Good, and free.
- An **MCP token is a fully valid `/api/v2` token.** The credential handed to Claude or ChatGPT is
  not a `words:write` credential; it is a whole-API credential that only the MCP route happens to
  ask a scope of.

That is survivable for a single-learner app with hand-picked clients. It stops being survivable the
moment **Dynamic Client Registration** is enabled, because then any client anyone registers can, with
one consent screen, obtain a token that reads and writes the learner's entire collection through
`/api/v2`. Default Audience is tenant-wide and Auth0 documents it as "equivalent to appending this
audience to every authorization request… for every application" — it amplifies DCR rather than
containing it.

**The tripwire, therefore: under Option B, DCR stays OFF.** Hand-register one Auth0 application per
client and paste the `client_id` (§8.1 option 3) — both Claude and ChatGPT expose a field for a
pre-supplied client id, which is worth confirming in S2 before committing. If zero-config DCR ever
becomes a requirement, that is the moment Option B has to be revisited, and the cost of switching
then is exactly what §4.3 said it was: one Auth0 API, one env var, one line in the PRM. Nothing in
this design makes that switch expensive later, which is the main reason B is a reasonable bet now.

Two smaller things Default Audience touches, both to confirm rather than fear:

- The **web app's** access tokens become JWTs where they were opaque. The Auth0 Next SDK stores them
  in the session cookie; a JWT is larger. Confirm the web login still works and the cookie still
  chunks cleanly.
- **Mobile is unaffected** — it already sends `audience` explicitly, and `audience` wins over any
  default.

### 11.3 Localhost-only dev — what it costs and what it buys

No tunnel means **no cloud client in dev**. ChatGPT and claude.ai reach out from OpenAI's and
Anthropic's infrastructure and cannot see `http://localhost:3000`. Dev is therefore: the **MCP
Inspector** and **locally-running clients** (Claude Code, Claude Desktop) — which is enough to
exercise everything except the two cloud connectors' own UX.

What it buys is the tunnel-URL-as-API-identifier problem from §4.3 disappearing twice over: Option B
never names a URL to Auth0 at all, and there is no tunnel to rotate. The `ELEVENLABS_WEBHOOK_FORWARD_URL`
class of pain does not reappear here.

Two things to verify rather than assume:

- **`http://` canonical URI.** The PRM in dev must advertise `http://localhost:3000/api/mcp`, and the
  client will compare its configured URL against it. OAuth 2.1 requires HTTPS for *authorization
  server* endpoints (Auth0, fine) and permits loopback redirect URIs; whether each client tolerates a
  plain-`http` *resource* is per-client. Test it early — it is a five-minute check, not a design.
- **Auth0 callback registration** for whatever loopback port the local client uses.

Practical consequence for staging: S1's "paste a token by hand" is not a stepping stone any more, it
is the **permanent dev workflow**, and full OAuth is exercised for the first time against a deployed
origin.

### 11.4 It is the first of several — so the threat model is due now

§8.2's reasoning ("low severity by construction") rested entirely on this being one write tool that
cannot read anything. That property ends with tool two. Recording the boundary now, while it is still
cheap:

- **Adding a read tool changes the class of the server, not its size.** `add_words_to_collection`
  gives a prompt injection a way to write junk into the learner's own collection. A `list_words` or
  `search_words` tool gives it an **exfiltration channel** — content leaves the account and enters a
  model context that an attacker may be steering. That is the line worth naming explicitly: today's
  server is write-only and blind, and the first read tool is the change that needs its own review.
- **A delete tool crosses a second line** — irreversibility. `deleteWord` exists in `lib/words.ts`
  and would be trivial to expose; it should not be exposed to a model without a confirmation story.
  ChatGPT already requires manual confirmation for write actions per conversation; Claude has
  per-tool approval. Both are client-side and neither is a guarantee.
- **Scopes should be minted per capability from the start**, even though nothing enforces them
  outside `/api/mcp` today: `words:write` now, `words:read` for the first read tool, `lessons:write`
  later. Under Option B the scope is the *only* granularity that exists (§11.2), so a single
  omnibus scope would erase the one distinction the design still has.
- **ChatGPT's `search`/`fetch` convention is a real design pull.** Its deep-research surface expects
  a read-only pair with a defined result shape (`id`/`title`/`url`, then `id`/`title`/`text`/`url`).
  If the collection should be *readable* by ChatGPT, that is the shape to build — and it is a read
  tool, so it lands squarely on the line above. Decide it deliberately, not as a compatibility patch.

Nothing here changes the file plan in §6. The route, `verifyMcpToken` and the PRM document are
identical for one tool or six.

### 11.5 Revised staging

**S0 — the tool, unauthenticated, local. ✅ Done** — see §9.

**S1 — Auth0 verification, pasted token.** Unchanged in substance, but note that with Option B the
token to paste is one the **mobile app already holds** — no new API's test tab needed. This is also
now the standing dev workflow (§11.3), so it is worth making pleasant.

**S2 — the tenant, and it is a shorter list than §4.2 implied.** Set **Default Audience**; leave the
compatibility profile **OFF**; turn on Include Issuer; leave **DCR OFF** and hand-register one Auth0
application per client. Then connect from a deployed origin — Claude first, ChatGPT second, because
ChatGPT additionally needs developer mode and will exercise the manual-confirmation path.

**S3 — the honest edges.** As before, plus: write the read-tool boundary from §11.4 into the repo
(a comment in `lib/mcp/` beats a doc nobody re-reads), and record in the tenant's notes *why* the
compatibility profile is off — because the next person to read Auth0's MCP guide will try to turn it
on, and it will break the server.

## Sources

- [MCP Authorization specification (2025-06-18)](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
- [vercel/mcp-handler](https://github.com/vercel/mcp-handler) · [AUTHORIZATION.md](https://github.com/vercel/mcp-handler/blob/main/docs/AUTHORIZATION.md)
- [Auth0 — Dynamic Client Registration for MCP](https://auth0.com/ai/docs/mcp/guides/registering-your-mcp-client-application/dynamic-client-registration)
- [Auth0 — Resource Parameter Compatibility Profile](https://auth0.com/ai/docs/mcp/guides/resource-param-compatibility-profile)
- [ElevenLabs — Model Context Protocol for agents](https://elevenlabs.io/docs/eleven-agents/customization/tools/mcp)
- [RFC 9728 Protected Resource Metadata](https://datatracker.ietf.org/doc/html/rfc9728) · [RFC 8707 Resource Indicators](https://www.rfc-editor.org/rfc/rfc8707.html) · [RFC 7591 Dynamic Client Registration](https://datatracker.ietf.org/doc/html/rfc7591)
- [OpenAI — Building MCP servers for connectors](https://developers.openai.com/api/docs/mcp) · [MCP and Connectors](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)
- [claude-code#76096 — PRM `resource` must match the server URL (Entra deadlock)](https://github.com/anthropics/claude-code/issues/76096)
- [vscode#274226 — Auth0 as AS for MCP: `resource` ignored, non-JWT token](https://github.com/microsoft/vscode/issues/274226)
- [Auth0 — Tenant Settings (Default Audience)](https://auth0.com/docs/get-started/tenant-settings) · [Error "Service not enabled within domain"](https://support.auth0.com/center/s/article/Service-not-enabled-within-domain-error)
