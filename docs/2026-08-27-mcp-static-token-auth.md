# One token in the env: replacing MCP OAuth with a static Bearer secret

> **Supersedes the authorization half of `docs/2026-08-23-mcp-server-add-words.md`** — §4 (Auth0),
> §8.1 (DCR), §11.1–§11.6 (Option A/B), and stages S1, S2 and S4. Everything else in that document
> stands: the tool, the `addWords` semantics (§2), the library and route choices (§3), the
> write-only-and-blind threat model (§8.2), and the read-tool boundary (§11.4). This document
> changes **who the server believes you are**, and nothing about what it does once it believes you.

## 1. The short version

Today `/api/mcp` is an OAuth 2.1 resource server: it publishes RFC 9728 metadata, answers an
unauthenticated request with a `resource_metadata` pointer, and accepts an Auth0 RS256 JWT whose
`aud` is its own URL. The learner's identity arrives inside the token as `sub`.

The proposal is to accept **one fixed secret, presented as `Authorization: Bearer <token>`, compared
against `MCP_TOKEN`**, and to write the words with **no owner at all** (§2). Every OAuth mechanism goes:
the metadata route, the challenge that points at it, `withMcpAuth`, the scope check, JWKS
verification, `MCP_RESOURCE_URL`, and the Auth0 API that existed only to mint MCP tokens.

| | Today (Option A) | **Static token (proposed)** |
| --- | --- | --- |
| Credential | Auth0 access token, ~24h, per learner | one secret, no expiry, per deployment |
| Who mints it | Auth0, after PKCE + consent | `openssl rand -hex 32`, once |
| Identity | `sub` claim, threaded through the request | **none** — `owner_id` is NULL |
| Server-side verification | JWKS fetch, RS256, `iss`, `aud`, `scope` | one constant-time comparison |
| Files under `lib/mcp/` | `auth.ts`, `metadata.ts`, `owner.ts` + a `.well-known` route | `auth.ts` alone — one boolean |
| Auth0 objects needed | 1 API + 1 application **per client, per environment** | none |
| Clients that can connect | any OAuth-capable MCP client | any client that can set a header |
| Multi-learner | yes, by construction | **no** — unowned words are shared by everyone |
| Revocation | delete the grant in Auth0 | rotate the env var, redeploy |

**Decision of record: adopt it.** This is a single-learner app; the per-user identity OAuth was
buying was being spent on exactly one user, at the price of two Auth0 objects per client per
environment and a discovery handshake that three of the four interesting clients implement
differently. The one property worth keeping from Option A — *an MCP credential that is useless
anywhere else* — survives for free: the static token is not a JWT, so `/api/v2` rejects it at
`jwtVerify` without a line of new code.

**Why it is cheap right now.** S4 (production) was never started: `/api/mcp` answers 404 on the
deployed origin, the branch is not merged, and the only Auth0 objects in existence are a dev API
whose identifier is `http://localhost:3000/api/mcp` and one hand-registered Native application. The
sunk configuration cost of the reversal is two dashboard deletions. It will not be this cheap after
a production API is created and a second client is hand-registered.

## 2. MCP writes are anonymous, and `owner_id` becomes nullable

The token authenticates a **caller**, not a person. There is no `sub` in it, so there is nothing
truthful to stamp — and an owner read from an environment variable would be a guess wearing a
configuration value's clothes: wrong silently, forever, with no signature to disagree with it.

**So MCP writes leave `owner_id` NULL** (`supabase/migrations/0018_unowned_words.sql`). NULL is a
first-class value here, not a hole: it means *nobody claimed this word*. Every other path is
untouched — the web action and `/api/v2/*` still stamp the session's or the Bearer token's sub, and
for those rows `owner_id` remains the ownership gate exactly as CLAUDE.md describes it.

The plumbing goes with the owner. Under OAuth the chain was:

```
token → verifyMcpToken → AuthInfo.extra.ownerId → req.auth → ctx.http.authInfo → mcpOwnerId(ctx) → owner_id
```

All six links are deleted. `lib/mcp/owner.ts` is gone, nothing is attached to the request, and
`auth.ts` returns a boolean.

### Three NULL traps, each of which fails silently

SQL's NULL is never equal to anything, including itself, and three places in this schema quietly
depend on equality. Missing any one of them produces a feature that looks like it works:

1. **`unique (owner_id, norm_key)` treats every NULL as distinct**, so `on conflict` in
   `resolve_words` never fires for an unowned row. Every anonymous add would insert a *new* row: no
   "already in your collection", no popularity bump, a fresh duplicate on every call — the exact
   behaviour §2.1 of the original design exists to prevent. Fixed with `nulls not distinct`
   (PG 15+; this database is 17.6).
2. **`bump_word_popularity` gates on `owner_id = p_owner_id`**, which is never true for NULL. The
   counter would sit at 0 and the tool would report `popularity: null` forever. Fixed with
   `is not distinct from`, which is `=` for every non-null value.
3. **RLS on `words` selects `owner_id = auth.jwt() ->> 'sub'`**, which excludes NULL rows. Inert
   today (every read goes through the service-role client) but a trap for the day the token-scoped
   client is wired up. The SELECT policy widens; INSERT and UPDATE deliberately do not, because a
   logged-in user has no business minting rows with no owner.

### The words have to be visible, and that is a product decision

A row no query returns may as well not exist, so the collection reads widen from
`owner_id = <sub>` to `owner_id = <sub> OR owner_id is null` — expressed once, as
`ownedOrUnowned()` in `lib/lesson-items.ts`, rather than as four `.or(…)` strings that drift.

**Say the consequence out loud: unowned means everyone's.** With one learner (there is exactly one:
106 words, one sub) that is invisible. With two, both would see every MCP-added word. That is the
trade this design makes, and it is the thing to revisit before a second learner exists (§11.4).

**Reads widen; writes do not.** Every write still names an explicit owner — the MCP path names NULL
on purpose, and nothing else may. The one other widening is `deleteWord`, and it earns it: the whole
mitigation for a model talked into calling this tool is "junk vocabulary, cleaned up with the
existing delete", so a word the UI shows but cannot remove would turn a recoverable annoyance into a
permanent one.

### One consequence worth knowing before it surprises someone

An owned row and an unowned row with the same `norm_key` are two different rows, because
`(NULL, 'ubiquitous')` and `('auth0|…', 'ubiquitous')` are distinct keys even under
`nulls not distinct`. A learner who types a word the MCP server already added anonymously gets their
own copy, and the collection shows both. Collapsing them would mean claiming an unowned word on
sight — a write the learner did not ask for, made on a guess about intent.

## 3. The 401 must stop advertising OAuth — the part that is easy to get half-right

The tempting middle path is "accept the static token *and* keep the OAuth path for clients that
prefer it". Do not. Two independent reasons, and the first is empirical:

**A client that discovers OAuth may abandon the header you configured.** `anthropics/claude-code#59467`
is exactly this shape: an HTTP MCP server configured in `.mcp.json` with a valid
`Authorization: Bearer <PAT>` header, which also advertises OAuth, connects "successfully" and
exposes only the synthetic `authenticate` / `complete_authentication` pair instead of the server's
real tools. Closed as duplicate; no workaround beyond wrapping the server. The claude.ai side has
its own family of the same bug (`anthropics/claude-ai-mcp#644`, `#112`, `#10`). A server that
advertises no authorization server cannot trip this, because there is nothing to discover.

**`withMcpAuth` cannot be told to stop advertising.** Reading `mcp-handler@2.1.1`
(`dist/index.mjs`, `withMcpAuth`): the challenge options are built before the token is even parsed —

```js
const origin = resourceUrl ?? getPublicOrigin(req);
const resourceMetadataUrl = `${origin}${resourceMetadataPath}`;   // default: /.well-known/oauth-protected-resource
const challengeOptions = { requiredScopes, resourceMetadataUrl };
```

— and every failure path returns `bearerAuthChallengeResponse(err, challengeOptions)`. There is no
option that omits `resource_metadata`. Keeping the wrapper and deleting the metadata route yields
the worst of both: a 401 that points every client at a URL that 404s. **So `withMcpAuth` goes**, and
with it the only reason `metadata.ts` and `MCP_RESOURCE_URL` exist.

The replacement 401 is a plain RFC 6750 challenge with no pointer:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer error="invalid_token"
```

A conformant client that sees no `resource_metadata` falls back to probing
`/.well-known/oauth-protected-resource/api/mcp` and then `/.well-known/oauth-protected-resource`
(MCP spec, Authorization §"Protected Resource Metadata Discovery Requirements"). Both must 404 —
which they do once the route is deleted — and discovery then fails cleanly instead of half-working.

## 4. The code, concretely

### 4.1 `lib/mcp/auth.ts`, rewritten — one question, one boolean

The module keeps its name and loses everything else: `jose`, the JWKS set, the issuer, the audience,
the scope parser, and — because of §2 — the `AuthInfo` it used to build.

```ts
import { createHash, timingSafeEqual } from "node:crypto";

const current = process.env.MCP_TOKEN?.trim();
const previous = process.env.MCP_TOKEN_OLD?.trim();   // optional; §8.4 (rotation)

/**
 * Digests, not the secrets: `timingSafeEqual` throws on a length mismatch, which would leak the
 * token's length to anyone willing to read a stack trace. SHA-256 makes every comparison 32 bytes.
 * The 32-character floor rejects a placeholder like "changeme" as if it were unset — a short token
 * is not a weaker deployment, it is a broken one.
 */
const accepted = [current, previous]
  .filter((t): t is string => typeof t === "string" && t.length >= 32)
  .map(digest);

function digest(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

/**
 * `reduce`, not `some`: every candidate is compared whether or not an earlier one matched, so the
 * response time does not say WHICH token was presented (current vs. the one being rotated out).
 */
function matches(presented: string): boolean {
  const d = digest(presented);
  return accepted.reduce<boolean>((ok, a) => timingSafeEqual(d, a) || ok, false);
}

// One line at module scope, no secret in it. Without OAuth there is no metadata route left to 500
// loudly (the failure shape S4 documented), so a misconfigured deployment would otherwise be a
// silent permanent 401 with nothing anywhere to say why.
if (accepted.length === 0) {
  console.warn("[mcp] MCP_TOKEN unset or shorter than 32 chars; /api/mcp rejects every request.");
}

/** Is this request carrying the shared secret? That is the entire authorization model. */
export function mcpTokenOk(req: Request): boolean {
  if (accepted.length === 0) return false;            // misconfigured fails CLOSED

  const [scheme, value] = req.headers.get("authorization")?.split(" ") ?? [];
  if (scheme?.toLowerCase() !== "bearer" || !value) return false;

  return matches(value);
}
```

Three properties carried over from the JWT version on purpose: **fail closed when misconfigured**,
**return rather than throw** (an unauthenticated probe is a normal event, not a server error), and
**one undifferentiated failure** — a caller has nothing to do with the difference between "no
header" and "wrong secret", and reporting it tells an attacker which half to fix.

`WORDS_WRITE_SCOPE` is deleted. A scope is a grant an authorization server issues; with no
authorization server it is a string this codebase would be comparing against itself. §11.4's rule —
*mint the scope with the tool* — becomes, under a static token, *mint the **token** with the tool*:
a read tool means a second secret, not a claim inside this one.

### 4.2 The route

```ts
import { createMcpHandler } from "mcp-handler";

import { registerAddWords } from "../../../lib/mcp/add-words";
import { mcpTokenOk } from "../../../lib/mcp/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const handler = createMcpHandler(
  (server) => { registerAddWords(server); },
  { serverInfo: { name: "tutor-collection", version: "0.1.0" } },
);

async function authed(req: Request): Promise<Response> {
  if (mcpTokenOk(req)) return handler(req);

  return new Response(JSON.stringify({ error: "invalid_token" }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      // Deliberately no `resource_metadata=` — §3. There is no authorization server to point at,
      // and a pointer is what pulls a header-configured client into an OAuth flow instead.
      "www-authenticate": 'Bearer error="invalid_token"',
    },
  });
}

export { authed as GET, authed as POST, authed as DELETE };
```

Eight lines where `withMcpAuth` + `verifyMcpToken` + the PRM document + the scope list used to be,
and nothing is attached to the request on the way through.

The long comment block above `registerAddWords` — the three lines a second tool must not cross —
**stays**, with one edit. Its third item says a new scope must be minted with its tool and that
`requiredScopes` is per-server. Under a static token the mechanical half is gone (there is no
`requiredScopes` and no `ctx.http.authInfo.scopes` to check), and the rule is *stronger*, not
weaker: **a read tool cannot be gated at all without a second credential.**

### 4.3 There is no owner to place — but three call sites move

`add-words.ts` calls `addWords(ANONYMOUS, words)` with `const ANONYMOUS = null`, and
`scheduleWordJobs(ANONYMOUS)` — `null` there already means "every owner's pending words", which is
what the sweep scripts pass and the only thing that can reach a row with no owner.

`logCall` loses its `clientId` parameter along with the `AuthInfo` that supplied it (Auth0's `azp`).
The line keeps its whole reason for existing — an MCP write is the one write in this app that
happens with no learner watching a screen, so the row must not be the only evidence — and it keeps
the rule that it logs **counts, never the words themselves**. It simply has one fewer field. §8.1
counts that as a real loss.

The data layer widens its types rather than its behaviour: `resolveWords`, `addWords` and
`bumpWordPopularity` take `string | null`, and `scheduleWordJobs` too. Nothing about the owned path
changes — `null` is a value those functions now carry, not a default they invent.

### 4.4 File plan

| File | Action |
| --- | --- |
| `apps/web/src/lib/mcp/auth.ts` | **rewrite** — §4.1; ~35 lines, returns a boolean |
| `apps/web/src/app/api/mcp/route.ts` | **edit** — drop `withMcpAuth`; an 8-line guard |
| `apps/web/src/lib/mcp/metadata.ts` | **delete** — PRM document, `MCP_PATH`, `mcpResourceUrl()` |
| `apps/web/src/app/.well-known/oauth-protected-resource/api/mcp/route.ts` | **delete** (and the now-empty `.well-known` tree) |
| `apps/web/src/lib/mcp/owner.ts` | **delete** — §2; there is no per-request owner left to resolve |
| `apps/web/src/lib/mcp/add-words.ts` | **edit** — `OWNER_ID` at module scope, callback drops `ctx`, `logCall` drops `clientId` |
| `supabase/migrations/0018_unowned_words.sql` | **new** — nullable `owner_id`, `nulls not distinct` key, NULL-safe bump, RLS |
| `apps/web/src/lib/words.ts` | **edit** — `string \| null` owners; `deleteWord` reaches unowned rows |
| `apps/web/src/lib/lesson-items.ts` | **edit** — `ownedOrUnowned()`, used by `listItems` and `getItem` |
| `apps/web/src/lib/sync-flush.ts` | **edit** — `scheduleWordJobs(string \| null)` |
| `apps/web/src/proxy.ts` | **comment only** — §4.5 |
| `apps/web/.env.example` | `MCP_RESOURCE_URL` out; `MCP_TOKEN` and `MCP_TOKEN_OLD` in — and no owner variable |
| `apps/web/package.json` | **no change** — `mcp-handler` still provides `createMcpHandler`; `jose` is still the `/api/v2` path |

Net: **three files deleted**, one rewritten, five edited, one migration added. `packages/shared` is not touched, and
should not be — this is server-side identity, which by the shared-core test (*could I fix a bug here
by deploying the web app alone?* — yes) belongs on the server.

### 4.5 `proxy.ts` — keep the `/.well-known/` exemption

It was added in S1 because the Auth0 gate answered the metadata document with `307 → /auth/login`
while `/api/mcp` looked healthy. The document is going away, so the exemption is now unused — and it
should still stay, for the failure shape: with it, a client probing for PRM gets a clean **404**;
without it, a **307 to an HTML login page**, which is a worse thing to hand a JSON parser and a
worse thing to read in a client's logs. Rewrite the comment to say that, and to keep the standing
warning that this gate eats any public path added under `/.well-known/` in future.

## 5. Environment

```diff
 # ── MCP server (/api/mcp) ────────────────────────────────────────────────────
-# The MCP server's canonical URI. THREE things must be this exact string, byte for byte …
-MCP_RESOURCE_URL=
+# The shared secret every MCP client presents as `Authorization: Bearer <token>`.
+# Generate with:  openssl rand -hex 32     (64 hex chars; no delimiter, no shell escaping)
+# Anything shorter than 32 characters is treated as unset — the server rejects every request.
+MCP_TOKEN=                    # secret
+
+# There is NO owner variable. MCP writes are anonymous — `words.owner_id` is NULL — because the
+# token authenticates a caller, not a person (0018_unowned_words.sql).
+
+# Set ONLY during a rotation: the outgoing token, accepted alongside MCP_TOKEN until every client
+# is moved over. Its presence in the environment means a rotation is half-finished. See §8.4.
+MCP_TOKEN_OLD=                # secret
```

Client side, Claude Code:

```bash
claude mcp remove tutor-collection
claude mcp add --transport http tutor-collection http://localhost:3000/api/mcp \
  --header "Authorization: Bearer $MCP_TOKEN"
```

Two things S2 already taught that still apply: **Claude Code binds MCP tools at session start**, so
the reconfigured server exposes its tool only in the *next* session; and `claude mcp add` stores the
value without checking it, so a typo surfaces later as a bare "Failed to connect".

## 6. Client compatibility — what the trade actually costs

This is the real price, and it is not the security ledger. §11.1 of the previous document chose
OAuth because the answer to "which client?" was *any remote MCP client*. A static token narrows that
to *any client that can set a request header*, which is a different set — overlapping, not smaller.

| Client | Static header | Notes |
| --- | --- | --- |
| **Claude Code** | ✅ | `--header "Authorization: Bearer …"`, repeatable. The client already connected end-to-end in S2 |
| **claude.ai / Desktop / mobile / Cowork** | ⚠️ **beta** | `static_headers` is listed as Beta in Claude's connector auth docs: an **org administrator** enters the credential when adding the connector, and it is shared org-wide. Also the surface with the most open "header ignored, OAuth started instead" reports |
| **ChatGPT connectors** | ❌ (verify) | The in-product connector flow is OAuth via DCR or CIMD, with no field for a header. OpenAI's MCP docs do describe `http_headers` / `env_http_headers` for servers wired up through the API/plugin side — a different surface. Confirm before promising ChatGPT anything |
| **VS Code / Cursor** | ✅ | `headers` in `mcp.json`, with input variables for the secret |
| **ElevenLabs agents** | ✅ **newly possible** | §7 rejected them because the auth options are a workspace-level static secret token / custom headers with no per-conversation credential — "it would authenticate as one fixed identity". Under this design **that is the design**, so the objection dissolves |

Two consequences worth stating plainly:

- **ChatGPT is what the change spends.** §9's S4 CIMD plan existed almost entirely for it. If
  ChatGPT is wanted later, it wants OAuth back — which is why §12 (rollback) is written down rather
  than assumed.
- **ElevenLabs is what the change buys, and it should not be built in the same commit.** The
  tutor-adds-a-word idea from §7 becomes mechanically possible: workspace-level static header, one
  fixed learner, exactly what a single-learner deployment already is. The two objections that
  remain are unaffected by this change — MCP servers on ElevenLabs are dashboard/SDK-only and so sit
  outside the `agents.lock.json` discipline, and MCP is unavailable in Zero Retention / HIPAA
  workspaces — and the webhook-tool alternative is still the better-shaped one. Note the door;
  leave it shut.

## 7. Spec conformance, honestly

The MCP authorization spec (2025-11-25) opens with *"Authorization is **OPTIONAL** for MCP
implementations"*, and where it is supported over HTTP, implementations **SHOULD** conform to the
OAuth profile. So this is a deliberate SHOULD-level deviation, not a violation — but it is a
deviation, and the document should say so rather than imply the server is still spec-shaped.

What is still honoured, and must stay honoured:

- **The credential travels in the `Authorization` header.** Access tokens **MUST NOT** be in the URI
  query string — the spec says it, and Claude's connector docs repeat it as the top anti-pattern,
  because URLs land in proxy logs, server logs and browser history. Never accept `?token=`.
- **401 for a missing or invalid credential**, with a `WWW-Authenticate: Bearer` challenge.
- **The token is only valid at this resource.** The spec's audience rule (*servers MUST only accept
  tokens issued for them*) was met by `aud` under Option A; it is met here by the secret being
  known to exactly one resource. `/api/v2` rejects it because it is not a JWT — the same asymmetry,
  achieved by construction instead of by claim.

What is knowingly given up: RFC 9728 metadata (which the spec makes a **MUST** for servers that
implement the OAuth flow — we no longer do), RFC 8707 resource binding, PKCE, consent, and
short-lived tokens with refresh.

## 8. Security ledger

### 8.1 What is lost

1. **Expiry.** An Auth0 access token died in hours. This one lives until someone rotates it. A leak
   is permanent until noticed and acted on.
2. **Revocation as an operation.** There is no grant to delete. Revocation is `vercel env` + a
   redeploy, and it breaks every client at once (§8.4 is the mitigation).
3. **Per-client attribution.** `azp` told the log line which client wrote; with no `AuthInfo` on
   the request there is nothing to log, so the line reports counts only (§4.3). With one learner
   and one or two clients this is a real but small loss; if it ever matters, give each client its
   own token and label the *token* — never rebuild the per-request plumbing §2 deleted.
4. **Consent.** Nobody is shown a screen saying "Claude wants to add words to your collection".
   Under one owner who is also the operator, there is nobody left to consent *to*.
5. **Attribution of the write itself.** §2. An MCP-added word records no author at all, so
   "who added this?" is answerable only as "not a logged-in session". The compensating property is
   that it cannot be answered WRONGLY, which a configured owner could not promise.
6. **Secret at rest on every client.** The token sits in plaintext in `.mcp.json` / `~/.claude.json`
   / a connector's settings. An Auth0 refresh token had the same problem, but was revocable and
   audience-bound.

### 8.2 What is gained

1. **The blast radius shrinks even as the credential weakens.** A stolen MCP token writes junk
   vocabulary into one known collection and can read nothing — the same worst case as before,
   because the tool is still write-only and blind (§8.2 of the previous document, unchanged and
   still load-bearing).
2. **The Auth0 tenant stops being part of the MCP story.** No DCR toggle to weigh (§8.1), no
   Resource Parameter Compatibility Profile, no per-client hand-registration, no
   application↔API grant surprise, no third-party-application consent configuration for CIMD. Every
   tenant-wide toggle this feature asked for goes back to where it was.
3. **The whole discovery surface disappears.** No public metadata document, no `/.well-known` route,
   no CORS-open endpoint, no unauthenticated probe that is *supposed* to happen.
4. **Preview deployments stop being a trap.** §9's S4 note — PRM `resource` is configured, so a
   preview URL serves the production resource string and every conformant client discards it — is
   moot. A preview deployment with the env var set simply works.
5. **The failure mode is legible.** One comparison, two possible answers.

### 8.3 Rules the implementation must keep

- **Constant-time comparison over digests.** `===` on secrets leaks a prefix oracle; raw
  `timingSafeEqual` on unequal-length buffers throws and leaks length (§4.1).
- **Never log the token**, not even a prefix, not even at `console.debug`. The existing rule about
  never logging the learner's words stands beside it.
- **HTTPS only in production.** A bearer secret on plain HTTP is a shared secret with the network.
  Localhost dev is the documented exception and stays localhost-only.
- **Minimum length enforced in code**, so a weak value is treated as no value.
- **No second way in.** One header, one scheme. No `?token=`, no `X-Api-Key` alias, no
  "temporarily also accept the old JWT path".
- **Fail closed on misconfiguration**, with a warning line at module scope that names the variables
  and contains no secret.

### 8.4 Rotation

`MCP_TOKEN_OLD` exists so that rotation is not an outage: set the new secret in `MCP_TOKEN`, move
the outgoing one to `MCP_TOKEN_OLD`, redeploy, reconfigure the clients, then delete `MCP_TOKEN_OLD`
and redeploy again. Both are accepted in between, and every comparison runs on every request so the
timing does not reveal which secret was presented. **A leftover `MCP_TOKEN_OLD` is a half-finished
rotation** — that is why it is a separate variable rather than a delimited list in `MCP_TOKEN`: its
mere presence in the environment listing is the reminder, and there is no delimiter for a secret to
accidentally contain.

## 9. Unwinding Auth0

None of this is required for the code to work — it is the cleanup that makes the tenant match the
design again. Do it after §10's T2 passes, not before.

**Delete:**
- The dev API with identifier `http://localhost:3000/api/mcp` and its `words:write` permission.
- The hand-registered Native application Claude Code used with `--client-id`.
- The S1 throwaway **M2M application**, if it still exists. This one has real value: its client
  secret mints tokens the `/api/v2` audience accepts, bounded to that machine owner's own rows. S1
  said to delete it at the end of S2; confirm.

**Revert:**
- **Resource Parameter Compatibility Profile → OFF.** It was turned on for `resource=` and nothing
  else uses it. Re-check the mobile login afterwards, the way S2 checked it when turning the toggle
  on — mobile sends `audience`, never `resource`, so the expectation is *no change*, and the
  expectation is exactly what should be verified rather than assumed.

**Leave alone:**
- **Include Issuer (RFC 9207) → ON.** It is a security improvement unrelated to MCP.
- **DCR → off.** Already off; it never went on.
- The `/api/v2` API, the mobile Native application, the web application. Untouched by all of this,
  and this change must not become the commit that edits them.

## 10. Staging

**T0 — the code, verified against curl.** Rewrite `auth.ts`, edit the route, delete `metadata.ts`
and the `.well-known` route. Then, with `MCP_TOKEN` set locally (there is nothing else to set):

```bash
BODY='{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
H='-H content-type:application/json -H accept:application/json,text/event-stream'

# no credential → 401, and the challenge must NOT mention resource_metadata
curl -si -X POST localhost:3000/api/mcp $H -d "$BODY" | grep -i '^HTTP/\|^www-authenticate'
# wrong secret → 401, same challenge, same timing
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/api/mcp $H \
     -H "authorization: Bearer $(openssl rand -hex 32)" -d "$BODY"
# right secret → 200 with add_words_to_collection in the tool list
curl -s -X POST localhost:3000/api/mcp $H -H "authorization: Bearer $MCP_TOKEN" -d "$BODY"
# discovery is gone, not broken
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/.well-known/oauth-protected-resource/api/mcp   # 404
# and with MCP_TOKEN unset the server rejects everything, loudly in the server log, quietly on the wire
```

**T0b — the migration.** `pnpm db:migrate` (`:status` first). The three checks that matter are the
three NULL traps: add the same word twice through MCP and confirm it is **one row** reported as
already-present with a **rising popularity**, and that the row appears in the collection screen.
Each of those exercises one of §2's fixes, and each fails quietly if its line was dropped.

**T1 — Claude Code, end to end.** `claude mcp remove` + `claude mcp add --header …`, then **a new
session** (tools bind at session start). Add a word from a chat and confirm the row has
`owner_id IS NULL` *and* that the word appears in the mobile app — the second half is the whole
point of `ownedOrUnowned`, and no amount of green curl output substitutes for it. Confirm `after()`
still stamps `level_at` /
`details_at`, as it did in S0, S1 and S2; nothing in this change touches that path, which is
precisely why a regression here would be worth knowing about.

**T2 — production.** Set `MCP_TOKEN` in Vercel, apply the migration there, deploy, re-point Claude Code at
`https://…/api/mcp`, repeat T1 against it. This is the stage S4 was blocked on, and it no longer
needs an Auth0 API, a hand-registered application, or a CIMD import — the deployment *is* the
configuration.

**T3 — the tenant cleanup of §9**, and only then.

## 11. Risks and open questions

1. **Client bugs around static headers are real and recent.** `claude-code#59467` (header ignored
   when the server advertises OAuth) and `claude-code#50464` (configured header not attached to tool
   calls, 2.1.114, Windows). The first is designed around by §3. The second is not designable
   around — the mitigation is the curl in T0: if curl with the header works and the client does not,
   it is the client, and that distinction is worth being able to make in one command.
2. **`static_headers` on the hosted Claude surfaces is Beta**, entered by an org administrator and
   shared org-wide. If claude.ai (not Claude Code) is wanted, verify availability on the account
   before committing to this design.
3. **ChatGPT is likely off the table** (§6). Verify rather than assume, because it is the single
   largest thing OAuth was buying.
4. **A second learner is the one change this design does not absorb**, and the reason is now in
   the reads, not the writes: unowned means *everyone's*, so learner B would see every word learner
   A's MCP client added. Fixing it needs a token → owner lookup (hashed tokens in Postgres, one row
   per learner) *and* the per-request plumbing §2 deletes — `auth.ts` goes back to returning an
   `AuthInfo`, the route re-attaches `req.auth`, `owner.ts` comes back — *and* a decision about the
   unowned rows already written. Nothing here blocks that; everything here assumes it has not
   happened yet, and the assumption is load-bearing enough to re-read before onboarding anyone.
5. **Secret sprawl.** One value now lives in Vercel, in `~/.claude.json`, and in a shell history if
   the `claude mcp add` command was typed with the literal token. Prefer `--header "Authorization:
   Bearer $MCP_TOKEN"` with the variable exported from a file that is not committed.
6. **The `.well-known` directory is being deleted from `src/app/`.** If anything else ever needs to
   live there (`apple-app-site-association` for universal links is the plausible one), the S1 lesson
   about the auth gate applies again — which is why §4.5 keeps the exemption and its comment.

## 12. Rollback

`git revert` restores every file, since the OAuth code is being deleted rather than mutated in
place. The configuration is the part that does not revert for free:

- The dev Auth0 API can be **recreated with the same identifier** after deletion (identifiers are
  immutable, not unrepeatable), but the application↔API authorization has to be re-enabled and
  each client re-consents. Budget the S2 surprise again:
  `Client "X" is not authorized to access resource server "<uri>"` means the API exists and the app
  is not linked; `Service not enabled within domain` means no API with that identifier exists.
- If production has by then created its own API, its identifier is locked to the origin it was
  created for.

The cheap insurance is §9's ordering: do the code, verify it in production, and only then delete
anything in Auth0.

## Sources

- [MCP Authorization specification (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) — "Authorization is OPTIONAL"; tokens in the `Authorization` header and **not** the query string; PRM discovery and the well-known probing order
- [Claude — Authentication for connectors](https://claude.com/docs/connectors/building/authentication) — the supported auth types table, `static_headers` (Beta, admin-entered, org-shared), and why credentials in a URL are rejected
- [Claude — Third-party connectors with remote MCP](https://claude.com/docs/connectors/custom/remote-mcp) — what an administrator sees when entering a request header
- [claude-code#59467 — HTTP MCP client ignores the configured `Authorization` header when the server also advertises OAuth](https://github.com/anthropics/claude-code/issues/59467)
- [claude-code#50464 — configured `--header` not attached on tool calls](https://github.com/anthropics/claude-code/issues/50464)
- [claude-ai-mcp#644](https://github.com/anthropics/claude-ai-mcp/issues/644) · [#112](https://github.com/anthropics/claude-ai-mcp/issues/112) · [#10](https://github.com/anthropics/claude-ai-mcp/issues/10) — the same class of report on the claude.ai connector surface
- [OpenAI — Building MCP servers](https://developers.openai.com/api/docs/mcp) — `http_headers` / `env_http_headers`, and the connector flow's OAuth expectations
- [vercel/mcp-handler](https://github.com/vercel/mcp-handler) — `withMcpAuth` always builds a `resource_metadata` challenge (`dist/index.mjs`, v2.1.1), and `req.auth` is how `authInfo` reaches a tool
- [ElevenLabs — MCP for agents](https://elevenlabs.io/docs/eleven-agents/customization/tools/mcp) — workspace-level static secret token and custom headers, no per-conversation credential
- `docs/2026-08-23-mcp-server-add-words.md` — the design this supersedes the authorization half of
