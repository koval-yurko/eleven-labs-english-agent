# MCP on ElevenLabs, owned by the repo: attaching `/api/mcp` to a tutor agent in code

**2026-08-28.** Companion to `docs/2026-08-23-mcp-server-add-words.md` (the server),
`docs/2026-08-27-mcp-static-token-auth.md` (its authorization) and
`docs/2026-08-28-openai-realtime-mcp-tools.md` (the same capability on the other provider).

## 1. The short version

**The premise this repo has been carrying is out of date.** `agent/prompts/types.ts` and §6 of the
static-token note both say ElevenLabs MCP servers are *dashboard/SDK-only and therefore outside the
`agents.lock.json` discipline*. They are not. ElevenLabs exposes full CRUD over MCP server
configurations, over workspace secrets, and over the workspace opt-in, and the agent body already
carries the attachment field:

```text
POST   /v1/convai/mcp-servers                    create a server registration
GET    /v1/convai/mcp-servers                    list
GET    /v1/convai/mcp-servers/{id}               get
PATCH  /v1/convai/mcp-servers/{id}               update config IN PLACE (id survives)
DELETE /v1/convai/mcp-servers/{id}               delete
GET    /v1/convai/mcp-servers/{id}/tools         list the tools the server advertises
GET    /v1/convai/secrets?search=…               resolve a workspace secret name → secret_id
GET    /v1/convai/settings                       read can_use_mcp_servers (the workspace opt-in)
PATCH  /v1/convai/agents/{agent_id}              conversation_config.agent.prompt.mcp_server_ids
```

(Secrets and settings also have full write endpoints — `POST`/`PATCH /v1/convai/secrets`,
`PATCH /v1/convai/settings` — which the decisions below deliberately do not use.)

Everything `pnpm sync:agents` already does for agents — create / patch-in-place / hash-compare /
record the id in a committed lockfile — is available for MCP servers. **So the answer to "can this
live in code like the prompts?" is yes, with no dashboard step and no new tooling**, and the work is
one new mapper module plus a pre-phase in the existing sync.

Three things make it more than "add a field to `agentBody()`":

1. **ElevenLabs' unit of grant is the SERVER, not the tool.** An agent gets
   `mcp_server_ids: [...]`; there is no per-agent tool allowlist. `PromptVersion.mcpTools` — which
   on OpenAI becomes `allowed_tools` per session — has to be projected onto *server registrations*
   instead: one registration per distinct tool set (§4).
2. **The credential cannot be a plain string in the config.** It has to be a workspace secret
   referenced by `{ secret_id }` — which, given the decisions below, the sync **resolves by name and
   never writes** (§5).
3. **`approval_policy` is what `require_approval: "never"` was on OpenAI, and getting it wrong
   hangs a lesson for five minutes** (§6). The default is `require_approval_all`.

### Decisions taken 2026-08-28

They shape everything below; the alternatives they close off are recorded in §10 and §14 rather than
deleted.

1. **The registration points at the deployed origin**, not at a tunnel:
   `https://eleven-labs-english-agent.vercel.app/api/mcp`. It lives as a **constant in
   `agent/elevenlabs-mcp.ts`**, with `MCP_PUBLIC_URL` as an explicit override for anyone who needs
   one.
2. **The credential is the workspace secret `MCP_AUTHORIZATION_HEADER`, which already exists** and
   already holds the complete header value (`Bearer …`). The sync **looks up its `secret_id` by name
   and never creates, updates or deletes it.**
3. **It rides in `request_headers.Authorization`, not in `secret_token`** — the stored value is a
   whole header, and `secret_token` is documented as "the secret token (Authorization header)"
   without saying whether it adds a `Bearer ` prefix of its own (§5.1).
4. **No per-conversation credential.** MCP writes stay anonymous (`owner_id IS NULL`), exactly as
   they are on OpenAI today. §10 records what was available and why it is not being taken now.
5. **No ElevenLabs environment variables / environments.** One URL, one workspace, one value (§8.3).

**Recommendation.** Build it, in the shape of §7, as `words-1.1` — `words-1.0` plus the prompt
clause plus the grant, standing to `words-1.0` exactly as `words-2.1` stands to `words-2.0`.
Register with `approval_policy: "auto_approve_all"` and `transport: "STREAMABLE_HTTP"`.

**What the decisions buy.** With the secret pre-existing and the URL a constant, the sync's new
phase is *one* remote object with *one* read to resolve a name — no secret writes, no fingerprint in
the lockfile, no rotation choreography, and **`MCP_TOKEN` is never read by the ElevenLabs path at
all**. The secret is already on ElevenLabs' side; nothing has to carry it there.

---

## 2. The four remote objects, and the one the sync ends up owning

OpenAI needed zero: `session.tools` is minted per request, so `openai-mcp.ts` is a pure function and
nothing is provisioned. ElevenLabs is the opposite end — four objects stand between a version's
grant and a tutor that can call the tool.

| # | Object | Endpoint | Lifetime | Owner after this change |
| --- | --- | --- | --- | --- |
| 1 | **Workspace opt-in** — `can_use_mcp_servers` | `GET`/`PATCH /v1/convai/settings` | once per workspace | **a human, once.** The sync reads it and refuses (§2.1) |
| 2 | **Workspace secret** — `MCP_AUTHORIZATION_HEADER` | `GET /v1/convai/secrets?search=…` | until rotated by hand | **already exists.** The sync only resolves its id (§5) |
| 3 | **MCP server registration** — url + headers + policy | `/v1/convai/mcp-servers` | until the config changes | **`sync-agents.ts`** — the one new object it owns |
| 4 | **The attachment** — `prompt.mcp_server_ids` | `PATCH /v1/convai/agents/{id}` | per agent | `sync-agents.ts`, as today |

Only row 3 is created or mutated by the sync. Rows 1 and 2 are read-only preconditions it verifies
and explains, which is what keeps the new phase to a single write.

### 2.1 The opt-in is a real gate, and it is workspace-wide

> MCP is disabled by default for every workspace. Before anyone can add or use MCP servers, one
> member of the workspace must opt in on the workspace's behalf.

Via the dashboard the opt-in is a terms-acceptance dialog; via the API it is
`PATCH /v1/convai/settings { "can_use_mcp_servers": true }`. Any member — or any API key with
`convai_write` — can flip it; it is not admin-only. Setting it back to `false` keeps existing
registrations but stops agents using them.

**The sync should READ it and refuse with an explanation, not flip it.** Enabling MCP for a whole
workspace is a terms acceptance, and a provisioning script that accepts terms on its own initiative
is doing something no other line in `sync-agents.ts` does. `GET /v1/convai/settings` →
`can_use_mcp_servers === false` → the same shape of failure as a missing `ELEVENLABS_API_KEY`:

```text
✗ elevenlabs: can_use_mcp_servers is false for this workspace.
  A version grants MCP tools but the workspace has not opted in. Enable it once, either in the
  dashboard (Agents → Integrations, which shows the MCP terms) or with
  PATCH /v1/convai/settings {"can_use_mcp_servers": true}, then re-run.
```

**Hard blocker, no workaround:** MCP is unavailable in workspaces with Zero Retention Mode or HIPAA
compliance enabled, *regardless* of `can_use_mcp_servers`. Not this workspace's situation today, but
it is the one constraint that would make this whole document moot, so it belongs at the top.

### 2.2 The CLI is not the answer

ElevenLabs ships an agents CLI that does config-as-code for agents, and it would be reasonable to
ask whether this repo should adopt it instead of `sync-agents.ts`. It cannot help here — the docs
say so twice, once for MCP servers and once for environment variables:

> MCP servers are not yet manageable via the ElevenLabs CLI — use the dashboard or SDK.

So the choice is dashboard or API, and "API" means either `@elevenlabs/elevenlabs-js` (already a
dependency of `apps/web`, and it does have `conversationalAi.mcpServers.{list,create,get,update,delete}`
plus `.tools`, `.toolApprovals`, `.toolConfigs`, and `conversationalAi.secrets`) or raw `fetch`.

**Use raw `fetch`, matching the rest of `sync-agents.ts`.** That file already talks to two vendors
through one `callApi` helper and one `ProviderDriver` table; introducing an SDK for one object type
would put two HTTP idioms in one script, and the token route already documents (in its own comment)
why it reads bare shapes rather than trusting a generated model.

---

## 3. What the agent body actually takes

Confirmed in the agent create/update schema — `conversation_config.agent.prompt` carries:

```text
mcp_server_ids         (list of string, optional)  — MCP server ids used by the agent
native_mcp_server_ids  (list of string, optional)  — "Native" MCP servers (ElevenLabs-hosted; not us)
```

`native_mcp_server_ids` is for ElevenLabs' own catalogue of hosted integrations. Ours is a custom
remote server, so it is `mcp_server_ids`, and `native_mcp_server_ids` is never sent.

That is the entire attachment. There is **no per-agent tool selection** — no `allowed_tools`, no
per-agent approval override. An agent that names a server gets every tool that server exposes,
subject only to the *server's own* approval configuration.

Also confirmed while reading the schema, and load-bearing for §11: **inline
`conversation_config.agent.prompt.tools` is deprecated**, replaced by `tool_ids` referencing
workspace-scoped tool resources.

---

## 4. Where ElevenLabs' model disagrees with ours

`PromptVersion.mcpTools` is a per-version list of tool NAMES. Its doc comment says the field is
OpenAI-only and that ElevenLabs "IGNORES it rather than approximating it". If this is built, that
sentence has to change — and the honest change is not "ElevenLabs reads the same field", because the
two providers grant at different granularities:

| | OpenAI Realtime | ElevenLabs |
| --- | --- | --- |
| Where the grant lives | `session.tools[].allowed_tools`, minted per request | a persistent workspace resource |
| Granularity | per session, therefore per version, therefore free | per **server registration** |
| Narrowing a version's reach | list fewer names | register a second server with fewer tools enabled |
| Cost of a new tool set | zero | one more remote object + lockfile entry |

So the projection is:

> **A version's `mcpTools` set names a REGISTRATION.** Two versions granting the same set share one
> registration; a version granting a different set needs its own.

Today that is trivial — the server exposes exactly one tool, so there is exactly one non-empty grant
set, `["add_words_to_collection"]`, and therefore exactly one registration. The rule matters on the
day the second tool is registered, which is precisely the day the OpenAI doc's "no wildcard on
purpose" argument was written for. Keying the registration by its tool set means that day costs a
second registration rather than a silent retroactive grant.

**Naming.** Derive the registration name from the grant set so it is stable, unique, and legible in
the dashboard beside the agents:

```text
tutor-collection (add_words_to_collection)
```

not `tutor-collection`, because the second one would need a name and "which set is this?" is the
only question a reader of the dashboard will have.

### 4.1 How a registration narrows its tools

Two mechanisms, and only one of them is safe here.

**`approval_policy: "require_approval_per_tool"` + `tool_approval_hashes`.** Each entry is
`{ tool_name, tool_hash, approval_policy: "auto_approved" | "requires_approval" }`, where
`tool_hash` is documented as *"SHA256 hash of the tool's parameters and description"*. The dashboard
calls the third state "Disabled", which is what a tool absent from the list appears to mean.

This is the mechanism that matches `allowed_tools` semantically — and it is a trap for this repo
specifically:

- **The hash is over the tool definition as OUR OWN server advertises it.** `add-words.ts` builds
  the input schema from `MAX_ITEMS` and `MAX_WORD_LENGTH` and carries a hand-written description.
  Editing that description — a one-word improvement to a `.describe()` string — changes the hash and
  invalidates the stored approval.
- **What happens then is undocumented.** The plausible outcomes are "falls back to requires_approval"
  (a lesson that hangs, §6) or "treated as disabled" (a tutor that silently loses its tool). Both
  are invisible from the repo, and neither is something a typecheck or `sync:agents` would catch,
  because the drift is between ElevenLabs' stored hash and a string in a source file the sync does
  not hash today.
- **The hashing function is not published.** You can avoid computing it by posting to
  `POST /v1/convai/mcp-servers/{id}/tool-approvals` with `{ tool_name, tool_description, input_schema }`
  and letting ElevenLabs hash it — but then the sync has to fetch the live tool list
  (`GET /v1/convai/mcp-servers/{id}/tools`, which returns `name`, `description`, `inputSchema`) on
  every run to notice drift, which means the sync now depends on the deployed MCP server being
  reachable and correct at sync time.

**`approval_policy: "auto_approve_all"`, on a registration whose server exposes only granted tools.**
The narrowing then lives where it already lives — in what `route.ts` registers — and the registration
carries no copy of anything that can drift.

**Take the second, today.** One server, one tool, one grant set: per-tool approvals would buy nothing
and cost a hash our own repo can invalidate. Revisit only when a registration must expose a strict
subset of what the server advertises — and when that day comes, prefer *two MCP endpoints* over
per-tool hashes if the split is stable, because a path is something this repo can test.

---

## 5. The credential: one pre-existing secret, resolved by name

`MCP_AUTHORIZATION_HEADER` already exists in the workspace and already holds the complete header
value — `Bearer <the MCP_TOKEN value>`. **The sync's entire relationship with it is one read:**

```text
GET /v1/convai/secrets?search=MCP_AUTHORIZATION_HEADER
  → { secrets: [{ type: "stored", secret_id, name, used_by }] }
```

and it fails, loudly and by name, when that returns nothing:

```text
✗ elevenlabs: workspace secret "MCP_AUTHORIZATION_HEADER" not found.
  A version grants MCP tools, so the registration needs a credential to present to /api/mcp.
  Create it once in the dashboard (Agents → Secrets) holding the FULL header value, including the
  "Bearer " prefix, then re-run.
```

The value can never be read back — `GET` returns `{ type, secret_id, name, used_by }` and no value —
which is exactly why owning it is not worth it: verifying a secret this sync wrote would need a
locally-stored fingerprint, and this way there is nothing to verify. `MCP_TOKEN` is not read on this
path at all; the ElevenLabs side already has the credential, so nothing has to carry it there.

**Rotation is manual, and stays a two-place change:** update `MCP_AUTHORIZATION_HEADER` in the
ElevenLabs dashboard (or by hand via `PATCH /v1/convai/secrets/{id}`) and `MCP_TOKEN` in `.env` +
`pnpm env:push`. `MCP_TOKEN_OLD` is what makes the gap survivable — ElevenLabs holds a *stored* copy
(unlike OpenAI, which is handed the value per request), so **move ElevenLabs to the new value before
retiring `MCP_TOKEN_OLD` on our side.** Worth a line in `.env.example` next to `MCP_TOKEN`, since the
list of clients holding a stored copy is now longer than one and nothing in the repo records it.

**`search` is a PREFIX match** — documented as *"returns only secrets whose names start with this
string"* — so the lookup must find the entry whose `name` equals `MCP_AUTHORIZATION_HEADER` and never
take `secrets[0]`. A future `MCP_AUTHORIZATION_HEADER_OLD` sitting in the same workspace during a
rotation is exactly the value that would otherwise be picked up, silently, at the worst moment.

The `secret_id` does not need a lockfile entry of its own — it is resolved on every run and folded
into the registration body, so a secret recreated under the same name simply produces a config diff
and one PATCH.

### 5.1 `request_headers.Authorization`, not `secret_token`

`config.secret_token` accepts a `ConvAISecretLocator` (`{ secret_id }`) or an inline
`ConvAIUserSecretDBModel` (`{ name, encrypted_value, nonce, id }` — the dashboard's own encrypted
representation, not something a script can construct). There is no plain-string form, and its
description — *"The secret token (Authorization header) stored as a workspace secret"* — **does not
say whether the platform prefixes `Bearer ` itself.** Our stored value already carries the prefix, so
if it does, every call arrives as `Bearer Bearer …` and `mcpTokenOk` rejects all of them: a tutor
whose tools 401 mid-lesson, which is the failure mode with the least evidence attached to it.

`config.request_headers` has no such ambiguity — the value is sent as the header, verbatim — and its
values may be a plain string, a `{ secret_id }`, a `{ variable_name }` (§10) or a
`{ env_var_label }` (§8.3). So:

```jsonc
"request_headers": {
  "Authorization": { "secret_id": "<resolved from MCP_AUTHORIZATION_HEADER>" }
}
```

and never a plain string there, which would put the credential in a config object that
`GET /v1/convai/mcp-servers` returns in full.

This also means the secret's **format is load-bearing and invisible from this repo**: a value stored
without the `Bearer ` prefix produces the same silent 401. `lib/mcp/auth.ts` splits on a space and
requires the scheme, so there is no tolerant path to fall back on — S0 (§12) exists partly to see one
authenticated request arrive.

---

## 6. `approval_policy` is this provider's `require_approval: "never"`

The OpenAI document's §3.2 says the default `"always"` produces a tutor that stops talking and never
resumes. ElevenLabs has the identical hazard with a different default and a different shape, and it
is worth stating precisely because — unlike OpenAI — the SDK here *can* answer.

From the agent WebSocket schema, a `mcp_tool_call` event has four states:

```text
loading            → the tool is running
awaiting_approval  → + approval_timeout_secs (default 300)
success            → + result
failure            → + error_message
```

and the client→server direction carries:

```text
{ type: "mcp_tool_approval_result", tool_call_id, is_approved }
```

**Who can answer that, in this repo:**

| Layer | MCP approval support | Verified |
| --- | --- | --- |
| `@elevenlabs/client@1.17.0` | `sendMCPToolApprovalResult(toolCallId, isApproved)` | yes — `dist/BaseConversation.d.ts:100` |
| `@elevenlabs/react@1.12.0` | `onMCPToolCall` callback + `sendMCPToolApprovalResult` control | yes — `dist/conversation/useConversation.d.ts:35` |
| `@elevenlabs/react-native@1.2.18` | re-exports the above; nothing MCP-specific of its own | yes — no `mcp` match in `src/` or `dist/` |
| **`apps/mobile/src/lib/transport/elevenlabs.ts`** | **none — no `mcp` reference at all** | yes |

So the capability exists and our transport does not use it. With the platform default
(`require_approval_all`), the first tool call would emit `awaiting_approval`, nothing would answer,
and the lesson would sit for **300 seconds** before failing. That is the same hang as OpenAI's, just
with a timer on it.

**Set `approval_policy: "auto_approve_all"` explicitly, and never rely on the default.** The approval
in this design is upstream of the conversation, exactly as the OpenAI note argues: a version must
name the grant, and the server exposes one write-only, non-destructive tool whose worst outcome is
junk vocabulary in a collection with an existing delete.

**Worth knowing but not worth building now:** because the SDK *does* support it, ElevenLabs could
one day ask the learner out loud — "shall I save that?" — and have the app answer. That is a UX
feature with a voice-latency budget attached (an approval round trip inside a spoken turn), and it
belongs to whoever designs the interaction, not to the provisioning script. Note the door; leave it
shut.

---

## 7. The design

### 7.1 Files

Mirrors the OpenAI change one-for-one, which is the point — a reader who has read
`openai-mcp.ts` should recognise this immediately.

| File | Change |
| --- | --- |
| `agent/prompts/types.ts` | `mcpTools` stops being OpenAI-only: document the ElevenLabs projection (§4) |
| `agent/elevenlabs-mcp.ts` | **new** — the URL constant, the registration body, the guards |
| `agent/sync-agents.ts` | a pre-phase that resolves the secret and reconciles the registration before agents; ordering; prune |
| `agent/agents.lock.json` | **new top-level `mcpServers` section**, and `writeLock` must stop dropping unknown keys |
| `agent/prompts/words-1.1.ts` | **new** — `words-1.0` + the interruption clause + the grant |
| `apps/web/.env.example` | `MCP_PUBLIC_URL` becomes an override rather than a requirement; note the ElevenLabs stored copy beside `MCP_TOKEN` (§5) |

`elevenlabs-mcp.ts` follows `vapi-assistant.ts`' and `openai-mcp.ts`' rule: a translation table with
no runtime dependencies, so the decisions are readable without the plumbing.

```ts
/**
 * Where our MCP server lives, as ELEVENLABS will dial it. A constant, not an env read, because it
 * is one deployed origin that does not vary: the workspace is shared by every environment, so a
 * value that could differ per machine is a value that can repoint production (§8.2).
 */
const MCP_URL = "https://eleven-labs-english-agent.vercel.app/api/mcp";

/** The workspace secret holding the FULL `Authorization` header value. Resolved by name; never written. */
export const MCP_SECRET_NAME = "MCP_AUTHORIZATION_HEADER";

/** What one grant set becomes on ElevenLabs. `secretId` is resolved by the sync, not by this module. */
export interface ElevenLabsMcpRegistration {
  /** Identity key in the lockfile AND the registration name: derived from the sorted tool set. */
  key: string;                    // "add_words_to_collection"
  name: string;                   // "tutor-collection (add_words_to_collection)"
  url: string;                    // MCP_URL, or MCP_PUBLIC_URL when explicitly overridden
  transport: "STREAMABLE_HTTP";   // NOT the platform default — see §8.1
  approvalPolicy: "auto_approve_all";  // NOT the platform default — see §6
  description: string;
  /** Voice-shaped knobs, pinned rather than inherited. See §9. */
  preToolSpeech: "off";
  executionMode: "post_tool_speech";
  responseTimeoutSecs: number;
}

export type McpRegistrationsResult =
  | { ok: true; registrations: ElevenLabsMcpRegistration[] }
  | { ok: false; reason: string };
```

The `ok: false` shape is copied deliberately: three outcomes, and the middle one is the dangerous
one. A version that grants nothing is normal; a version that grants tools we cannot wire up is a
misconfigured deployment and must stop the sync rather than produce an agent that quietly has no
tools.

**The guards are the same guards, minus one.** `openai-mcp.ts` already wrote loopback hosts, RFC
1918 ranges, `.local` and non-`https`, and every one of them applies here — ElevenLabs dials
`/api/mcp` from *their* network too, so the same URL mistakes fail the same invisible way. Do not
copy the code: lift `unreachableHost` into a small shared module under `agent/`, since a second
verbatim copy is how the two drift.

The one that does **not** carry over is the `MIN_TOKEN_LENGTH` check. `openai-mcp.ts` needs it
because it *presents* `MCP_TOKEN`; here the credential is a `secret_id` we never see the value of, so
there is nothing to measure. Its replacement is the lookup failing by name (§5).

`MCP_PUBLIC_URL` remains readable as an override, and it is the only way to point a registration at
a tunnel. Guard it rather than trusting it: when it is set and differs from `MCP_URL`, require
`--allow-dev-mcp-url` and print both URLs. See §8.2 for the failure that guard exists to prevent.

### 7.2 The lockfile

`readLock`/`writeLock` today read and write exactly `{ version, note, agents }`. **`writeLock` drops
any key it does not know about**, so adding a section is not purely additive — the writer has to be
extended in the same commit or the first sync after a hand-edit silently deletes it.

```jsonc
{
  "version": 2,
  "note": "…",
  "mcpServers": {
    "add_words_to_collection": {
      "provider": "elevenlabs",
      "serverId": "mcp_srv_…",
      "configHash": "sha256:…",   // over the registration body actually sent, secret_id included
      "name": "tutor-collection (add_words_to_collection)",
      "updatedAt": "2026-08-28T…"
    }
  },
  "agents": { /* unchanged */ }
}
```

`configHash` follows the **Vapi** rule, not the ElevenLabs one: hash the body that will be sent, not
a hand-enumerated field list. There are no legacy hashes to preserve here, and the ElevenLabs agent
hash already carries a warning about the exact failure a body hash makes impossible.

**No `secretId` field and no token fingerprint.** The `secret_id` is resolved by name on every run
and is part of the hashed body, so a secret recreated under the same name shows up as an ordinary
config diff. Nothing derived from the secret's *value* is stored, because nothing writes it (§5) —
which is the whole reason this section is three fields instead of five.

### 7.3 Order of operations

The sync gains a phase, and the phases are not interchangeable:

```text
0. settings   GET  /v1/convai/settings                          → refuse if can_use_mcp_servers is false
1. secret     GET  /v1/convai/secrets?search=MCP_AUTHORIZATION_HEADER → secretId  (READ ONLY)
2. server     POST or PATCH /v1/convai/mcp-servers              → serverId
3. agents     PATCH each agent with prompt.mcp_server_ids = [serverId, …]   ← existing loop
```

and pruning runs in reverse, because ElevenLabs refuses to delete an object still in use — but stops
one step short, since the secret is not ours to remove:

```text
3'. detach    PATCH the agent with mcp_server_ids: []
2'. server    DELETE /v1/convai/mcp-servers/{id}
              (the secret is left alone — it was not created here)
```

Phases 0–2 run only when **some** ElevenLabs version has a non-empty `mcpTools`. A deployment where
no version grants anything must never touch settings, secrets or registrations — the same rule
`openAiMcpTools` states as "the common case, and the one that must stay free of every check below".

`--dry-run` must keep working with no credentials, which means phase 0 cannot be a hard prerequisite
of *planning*. Plan it as an action (`⚙ opt-in check`) and perform it only on apply.

### 7.4 The hash rule, and the one genuinely awkward bit

`elevenLabsHash()` carries an explicit warning: anything added to `agentBody()` must be added to the
hash or the sync reports "unchanged" while the live agent keeps the old value. So `mcp_server_ids`
goes into both — and, following the `maxTokens` precedent, **omitted from both when the version
grants nothing**, so `words-1.0`'s existing hash survives untouched.

The awkward bit is revocation. `PATCH /v1/convai/agents/{id}` patches what it is given; a field the
body omits is not cleared. So the omit-when-empty rule means **removing `mcpTools` from a version
leaves the live agent still attached to the server**, and — worse — the hash goes back to its old
value, so the sync sees "unchanged" and never notices.

Two ways out:

- **(A) Always send the field.** `mcp_server_ids: []` for every version that grants nothing.
  Correct, self-maintaining, and it re-PATCHes every existing ElevenLabs agent once with a new hash.
  Given that the registry currently holds exactly one ElevenLabs version, "every existing agent" is
  one agent.
- **(B) Omit when empty, and make the lockfile carry the detach.** The plan gains an explicit
  `detach` action when a lock entry records attached servers and the version no longer grants any.
  Preserves every existing hash; costs a fourth state in the plan and a piece of knowledge that
  lives only in the lockfile.

**Take (A).** The repo's instinct to protect existing hashes is right when the cost is re-PATCHing
seven agents to send an identical body (the reason the Vapi hash is a separate function); it is not
worth a permanent extra plan state to protect exactly one. Say so in the commit, because a single
`~ update words-1.0` in the first sync after the change is otherwise unexplained.

### 7.5 What `words-1.1` is

`words-2.1` exists because `words-1.0`, `words-2.0` and `words-3.0` run `PODCAST_LESSON_PROMPT`
byte for byte on three services, and that identity is the only reason comparing them means anything.
The same argument applies unchanged: granting the tool on `words-1.0` would spend the comparison.

So `words-1.1` = `PODCAST_LESSON_PROMPT` + the same interruption clause `words-2.1` added +
`mcpTools: ["add_words_to_collection"]`. Composed, not copied — the clause should be imported from
wherever `words-2.1` keeps it rather than pasted, so the two providers' versions of "the tutor may
save a word" cannot drift into two different lessons.

That also produces the second comparison this repo is actually built for: `words-1.1` vs `words-2.1`
is the same lesson, the same clause and the same grant on two services, one of which routes the tool
call through a persistent workspace registration and one of which mints it per session.

---

## 8. Reachability, transport, and the hazard nobody has hit yet

### 8.1 The transport default is wrong for our server

`transport` defaults to `SSE`. `app/api/mcp/route.ts` is `mcp-handler`'s Streamable HTTP handler —
`GET`/`POST`/`DELETE` on one path, no separate SSE endpoint and no Redis. **Send
`transport: "STREAMABLE_HTTP"` explicitly.** Taking the default would produce a registration that
cannot list tools, and the failure surfaces at registration time rather than mid-lesson, which is the
good version of this mistake but still worth not making.

`response_timeout_secs` defaults to 30 and accepts 5–300. `route.ts` sets `maxDuration = 60`, so 30
is a real ceiling on a slow cold start plus a Supabase round trip. Pin it — see §9.

### 8.2 One URL, a constant, and the guard that keeps it one

The registration points at `https://eleven-labs-english-agent.vercel.app/api/mcp` — the deployed
origin, hardcoded in `elevenlabs-mcp.ts`. That is a deliberate departure from `openai-mcp.ts`, which
reads `MCP_PUBLIC_URL` and refuses to run without it, and the reason is the hazard this decision
closes:

**The ElevenLabs workspace is a single shared namespace.** Dev and production already share agent
ids — that is what committing `agents.lock.json` means — and it has been harmless because nothing in
the agent body varies by environment. A URL read from the environment would break that:
`docs/2026-08-28-env-variable-sync.md` singles out `MCP_PUBLIC_URL` as *"the one key whose value
legitimately differs per environment"*, so **running `pnpm sync:agents` on a laptop with a tunnel in
`MCP_PUBLIC_URL` would repoint the production agents' MCP server at that laptop.** The tunnel dies;
every production tool call fails; nothing in the sync warns, because from its side it was an
ordinary config change.

A constant makes the default outcome correct no matter whose machine runs the sync. The override
survives — some day someone will need to point a registration at a tunnel — behind a flag that says
so:

```text
✗ MCP_PUBLIC_URL is set to https://abc123.ngrok.app/api/mcp, which differs from the deployed
  origin this registration normally uses:
      https://eleven-labs-english-agent.vercel.app/api/mcp
  The ElevenLabs workspace is shared with production, so applying this repoints the LIVE agents.
  Re-run with --allow-dev-mcp-url if that is what you want.
```

Everything in the OpenAI doc's §3.1 still applies to whatever URL is used: ElevenLabs dials
`/api/mcp` from their network, so a loopback or LAN host yields a tutor whose tools never list, with
nothing in our logs because the request never arrives. The guards stay.

ElevenLabs additionally publishes **static egress IPs** for allowlisting
(`/docs/eleven-api/resources/ip-allowlisting`). Not needed for a public Vercel deployment; relevant
if `/api/mcp` ever moves behind a firewall.

### 8.3 ElevenLabs environments — available, and not being used

Recorded because it is the platform's own answer to §8.2 and someone will find it later.

ElevenLabs has a workspace-scoped **environment variable** resource: a label with one value per
environment (`production` always exists; others optional; a missing value falls back to production).
MCP server URLs and headers may reference them — `config.url =
"https://{{system__env_mcp_host}}/api/mcp"`, with the `https://` required *before* any reference so
the template cannot control the protocol. The environment is chosen at conversation start; for
WebRTC that is a query parameter on the token mint
(`GET /v1/convai/conversation/token?agent_id=…&environment=staging`), and
`apps/web/src/app/api/v2/words-agent/token/route.ts` already holds an `appEnv` it could pass there in
one line.

**Decided against for now** (decision 5, §1). It buys a per-environment URL for a repo whose stated
rule is that *every environment carries the same values*, and it costs a fourth remote object type to
reconcile (`/v1/convai/environment-variables` — create/list/get/update, also not CLI-manageable) plus
a second meaning for "environment" alongside `appEnv`. The constant plus the flag in §8.2 covers the
same hazard for one line of code.

Its trigger, if it ever comes: a real staging deployment, or local MCP testing becoming routine
enough that `--allow-dev-mcp-url` gets typed weekly.

---

## 9. Voice-shaped knobs worth pinning

The registration carries several fields that are about the LESSON rather than about plumbing, and
`prompts/index.ts` has a settled view on this class of value: pin it, don't inherit it, so it is ours
rather than a platform default that can move.

| Field | Default | Pin to | Why |
| --- | --- | --- | --- |
| `approval_policy` | `require_approval_all` | **`auto_approve_all`** | §6 — the default hangs the lesson for 300 s |
| `transport` | `SSE` | **`STREAMABLE_HTTP`** | §8.1 — the default cannot talk to `mcp-handler` |
| `pre_tool_speech` | `auto` | **`off`** | `auto` makes the agent announce the call when latency looks high. The `words-2.1` clause exists specifically to stop the tutor narrating the tool; `auto` would put the narration back below the prompt |
| `execution_mode` | `immediate` | **`post_tool_speech`** | Lets the tutor finish its sentence before the write lands. `async` is for long operations and returns nothing to the turn; `add_words_to_collection` returns `added` / `already_present`, which the tutor may want |
| `interruption_mode` | `allow` | **`allow`** | Interruption is how the learner takes part in this lesson (`docs/2026-08-16-tutor-pause-hold-the-line.md`). Suppressing it around a tool call would silence the learner for exactly the turn they just spoke into |
| `tool_call_sound` | none | **none** | A UI sound in a podcast-shaped lesson |
| `response_timeout_secs` | 30 | **20** | Below `route.ts`'s `maxDuration = 60`, and well below a spoken turn's patience. A tool that has not answered in 20 s should fail the turn, not stall it |
| `disable_compression` | `false` | **`false`** | Next.js handles compressed responses |

The interesting one is `pre_tool_speech: "off"` — it is the same decision `words-2.1`'s prompt clause
makes, expressed in the vendor's vocabulary, and it is the kind of value that belongs in
`elevenlabs-mcp.ts` beside a comment saying which prompt clause it is protecting.

---

## 10. What ElevenLabs could do that OpenAI cannot — deliberately not doing it yet

**Decision 4 (§1): no per-conversation credential. MCP writes stay anonymous.** This section stays
in the document because the capability is real and provider-specific, and because the day the second
learner arrives, this is the page that says what was already known.

Both previous documents end on the same unresolved consequence:

> **A word saved this way has `owner_id` NULL.** … With two learners, a word saved during one
> person's lesson appears in the other's collection.

On OpenAI that is structural: `session.tools[].authorization` is one string, baked when the session
is minted, and OpenAI's servers present it on every call. There is no per-conversation channel.

**ElevenLabs has one.** `config.request_headers` values may be a `ConvAIDynamicVariable`:

```jsonc
{
  "request_headers": {
    "Authorization": { "secret_id": "sec_…" },        // the caller credential (§5)
    "X-Tutor-Session": { "variable_name": "session_token" }   // resolved per conversation
  }
}
```

Dynamic variables are already how this repo grounds a lesson — `items_list` is injected at
`startSession` (`apps/mobile/src/lib/transport/elevenlabs.ts:184`) and `app_env` is stamped from the
token route's response. So the mechanism is in place and understood.

The sketch, and its one non-negotiable property:

1. `/api/v2/words-agent/token` already authenticates the learner (`withBearer`) and already knows
   their `sub`. Mint a short-lived signed token — audience `/api/mcp`, subject the learner's `sub`,
   lifetime the conversation's `maxDurationSeconds` — and return it alongside the conversation token.
2. The client passes it as a dynamic variable, exactly like `items_list`.
3. ElevenLabs sends it as a header on every MCP call. `lib/mcp/auth.ts` keeps verifying `MCP_TOKEN`
   as the caller credential and additionally verifies this one, stamping `owner_id` when present.
4. **The value must be server-minted and signed.** A dynamic variable is set by the device, so a
   plain `owner_id` string there is client-controlled and would let any device write into any
   learner's collection — strictly worse than NULL. The signature is what makes the device a courier
   rather than an authority.

The fully-server-side variant exists too: the workspace's
`conversation_initiation_client_data_webhook` can return dynamic variables per conversation, so the
value need never touch the device at all. That is a fourth workspace-level object and its own
design.

**Why it is not in this build.** It is a genuinely different capability, not a nicer spelling of the
same one — and that is exactly why it does not belong in the commit that attaches the server. It
changes `lib/mcp/auth.ts` from "one boolean" back into something that resolves an identity, it
changes the `owner_id` semantics `0018_unowned_words.sql` was written for, and it adds a second
credential with its own lifetime and threat model. With one learner it buys nothing observable;
`words-1.1` shipped without it behaves exactly as `words-2.1` already does.

**Its trigger is the second learner, and it is not subtle.** Until then a word saved mid-lesson lands
in the unowned pool that every collection reads, which looks correct because there is one collection.
The day there are two, this is urgent — and this section, plus §6 of the static-token note, is the
record of the shape the fix takes on this provider.

---

## 11. Revisiting "the webhook tool is the better-shaped alternative"

§6 of the static-token note concluded, about attaching this server to ElevenLabs:

> The two objections that remain are unaffected by this change — MCP servers on ElevenLabs are
> dashboard/SDK-only and so sit outside the `agents.lock.json` discipline … and the webhook-tool
> alternative is still the better-shaped one.

Both halves have to be withdrawn, and the second is the more interesting correction:

- **"dashboard/SDK-only"** — false. Full REST CRUD, §1.
- **"the webhook tool is better shaped"** — this rested on a webhook tool being *part of the agent
  body*, and therefore already covered by the lockfile discipline. **Inline
  `conversation_config.agent.prompt.tools` is deprecated; tools are now workspace resources
  referenced by `tool_ids`.** So a webhook tool is *also* a remote object with its own id, its own
  lifecycle and its own lockfile entry — the same machinery this document proposes, for one tool
  instead of a server.

What is left of the comparison is a real trade, and it now favours MCP for this repo:

| | Webhook tool (`tool_ids`) | MCP server (`mcp_server_ids`) |
| --- | --- | --- |
| Remote objects to reconcile | 1 tool (+ secret) | 1 server (+ secret) |
| Where the tool's schema lives | duplicated in the ElevenLabs tool config | on our server, advertised once |
| Shared with OpenAI / Claude Code / Cursor | no — an ElevenLabs-only definition | yes — the same `/api/mcp`, already working |
| Adding a second tool | a second remote object, a second schema copy | zero remote change (subject to §4's grant-set rule) |
| Approval/hang hazard | none | §6, mitigated by one pinned field |
| Workspace opt-in required | no | yes, once |

The decisive column is the third. `add_words_to_collection` is already written, already authorized,
already verified end-to-end against OpenAI's MCP client, and already reachable from Claude Code. A
webhook tool would be a second, hand-maintained copy of a schema whose first copy is generated from
`MAX_ITEMS` and `MAX_WORD_LENGTH` — the drift is between a Zod schema and a JSON blob in a vendor's
database, which is exactly the kind of drift `packages/shared` exists to prevent elsewhere.

---

## 12. Stages

| | Stage | Ends when |
| --- | --- | --- |
| **S0** | **Probe, by hand.** Enable `can_use_mcp_servers`; register the server against the DEPLOYED url with `request_headers.Authorization = { secret_id: MCP_AUTHORIZATION_HEADER }`; `GET …/tools` and see `add_words_to_collection`; attach it to a scratch agent; run one lesson; watch `/api/mcp` log an authenticated `tools/list`. Delete the registration and the scratch agent; leave the secret. | The transport, the header format and the approval policy are confirmed against the real thing, not against this document |
| **S1** | **`elevenlabs-mcp.ts` + the shared `unreachableHost` guard.** Pure mapper, no network. `--dry-run` prints the registration it would create. | `pnpm sync:agents --dry-run` shows the plan on a machine with no credentials |
| **S2** | **The sync pre-phase + lockfile v2.** Settings check, secret lookup, server reconcile, ordering, prune, the `--allow-dev-mcp-url` guard, `writeLock` stops dropping unknown keys. | Two consecutive `pnpm sync:agents` runs, the second a clean no-op |
| **S3** | **`words-1.1` + `mcp_server_ids` in `agentBody()`/`elevenLabsHash()`** (rule (A), §7.4). | A real lesson on `words-1.1` saves a word the learner asked for, and `words-1.0` still runs unchanged |

S0 before S1 is not ceremony, and one item on its list is there because of decision 3: **nothing in
this repo can tell whether `MCP_AUTHORIZATION_HEADER` holds a value `mcpTokenOk` will accept.** The
secret is opaque to the API, the format requirement (`Bearer ` + ≥32 chars) lives in
`lib/mcp/auth.ts`, and the failure is a 401 mid-lesson with no local evidence. Three more
load-bearing claims are read from documentation and typings rather than a running conversation —
that `STREAMABLE_HTTP` talks to `mcp-handler`, that `auto_approve_all` really skips the
`awaiting_approval` state, and that attaching a server to an agent needs nothing on the device. The
OpenAI build did the same probe, and it is why that document can say "verified end to end, not just
typechecked".

There is no S4. Per-conversation identity (§10) is deliberately out of scope; its trigger is a second
learner, not a stage.

---

## 13. Verified, and not

**Verified in this repo (2026-08-28):**

- `@elevenlabs/elevenlabs-js@^2.54.0` is already a dependency of `apps/web` and exposes
  `conversationalAi.mcpServers` (`list`/`create`/`get`/`update`/`delete`, plus `tools`,
  `approvalPolicy`, `toolApprovals`, `toolConfigs`) and `conversationalAi.secrets`.
- `@elevenlabs/client@1.17.0` has `sendMCPToolApprovalResult`; `@elevenlabs/react@1.12.0` surfaces
  `onMCPToolCall` and the same control; `@elevenlabs/react-native@1.2.18` adds nothing MCP-specific.
- `apps/mobile/src/lib/transport/elevenlabs.ts` contains no MCP handling of any kind.
- The token route mints via `GET /v1/convai/conversation/token?agent_id=…` and already carries an
  `appEnv` value it echoes to the client.
- `writeLock()` in `sync-agents.ts` serialises only `{ version, note, agents }`.
- `app/api/mcp/route.ts` is a Streamable HTTP handler (`GET`/`POST`/`DELETE`, one path, no Redis).
- `lib/mcp/auth.ts` splits the `authorization` header on a space, requires the scheme to be `bearer`
  (case-insensitively) and the value to be ≥32 characters — so `MCP_AUTHORIZATION_HEADER` must hold
  the complete `Bearer <token>` string, and there is no tolerant fallback if it does not.

**Taken from the user, not verified here (2026-08-28):** that `MCP_AUTHORIZATION_HEADER` exists in
the ElevenLabs workspace and holds `Bearer …`, and that
`https://eleven-labs-english-agent.vercel.app/api/mcp` is the deployed endpoint. S0 confirms both in
one request.

**Verified against ElevenLabs' published API reference and guides (fetched 2026-08-28), not against
a live call:** every endpoint, field, default and enum in §1–§9. Specifically:
`approval_policy ∈ {auto_approve_all, require_approval_all, require_approval_per_tool}` (default
`require_approval_all`); per-tool `∈ {auto_approved, requires_approval}`; `transport ∈ {SSE,
STREAMABLE_HTTP}` (default `SSE`); `response_timeout_secs` default 30, range 5–300;
`secret_token` accepts only a locator or an encrypted model; `request_headers` values may be string /
`secret_id` / `variable_name` / `env_var_label`; `mcp_tool_call.awaiting_approval.approval_timeout_secs`
default 300; `prompt.mcp_server_ids` on the agent body; `prompt.tools` deprecated in favour of
`tool_ids`; `can_use_mcp_servers` default `false`; MCP unavailable under Zero Retention / HIPAA;
MCP servers and environment variables both absent from the CLI.

**Not established, and each one is a question S0 should answer:**

1. **What a stale `tool_hash` does** under `require_approval_per_tool` — falls back to requiring
   approval, or disables the tool. §4.1 avoids the mode entirely because of this, so it only matters
   if that decision is revisited.
2. **Whether a tool absent from `tool_approval_hashes` is disabled** in that mode. Implied by the
   dashboard's three states; not stated in the API reference.
3. **Whether `PATCH /v1/convai/agents/{id}` with `mcp_server_ids: []` clears the attachment** as
   §7.4(A) assumes. If it does not, revocation needs `DELETE` on the registration instead.
4. **Whether `DELETE /v1/convai/mcp-servers/{id}` refuses while `dependent_agents` is non-empty.**
   The field exists on the response; the refusal is inferred from the secrets endpoint's documented
   "if it's not in use".
5. **What the ElevenLabs MCP client sends as its user agent**, for the same log line the OpenAI
   probe captured (`ua: openai-mcp/1.0.0`).
6. **Whether `auto_approve_all` skips `awaiting_approval` entirely**, or emits it with an
   auto-answer. Only the first is safe for a client that ignores the event.
7. **Whether `secret_token` adds a `Bearer ` prefix of its own.** Unanswered, and §5.1 routes around
   it rather than finding out — but if `request_headers` ever proves not to be sent verbatim, this
   is the first thing to test.

---

## 14. What to leave alone

- **`native_mcp_server_ids`.** ElevenLabs' hosted integration catalogue. We register a custom remote
  server; the field is never sent.
- **`secret_token`.** §5.1 — the stored value is a whole header, and this field's prefix behaviour is
  undocumented. `request_headers.Authorization` says the same thing without the ambiguity.
- **Creating, updating or deleting workspace secrets.** `MCP_AUTHORIZATION_HEADER` is managed by a
  human; the sync resolves its id and nothing else. This is the decision that keeps the new phase to
  one write.
- **Environment variables / `{{system__env_*}}` templating** (§8.3), and **per-conversation
  credentials via dynamic variables** (§10). Both available, both recorded, both out of scope by
  decision.
- **`auth_connection`.** OAuth2/JWT connections for MCP servers that speak the OAuth profile. Ours
  deliberately does not any more (`docs/2026-08-27-mcp-static-token-auth.md` §7) — adding one back
  here would reintroduce the machinery that document deleted.
- **`request_meta`.** Values sent in MCP `_meta` on `tools/call`. Interesting for tracing, and the
  wrong place to start: `_meta` is not read by `mcp-handler`'s tool registration today.
- **`tool_config_overrides`.** Per-tool `input_overrides`, `response_mocks`, `assignments`. Real
  capability — a constant or dynamic variable can be injected into a tool's arguments without the
  model seeing it, which is another route to §10 — but it re-describes our tool's schema in a
  vendor's database, which is §11's argument against webhook tools in a different costume.
- **Agent branches.** ElevenLabs versions agents and can pin a phone number to a branch. This repo
  versions agents its own way (one agent per prompt version), and mixing the two id spaces would make
  `agents.lock.json` ambiguous.
- **A read tool.** Unchanged from the server's own rule: the first one turns this into an
  exfiltration channel and is a different review.
