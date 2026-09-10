# The tutor reaches the collection on Vapi too: MCP tools on the third provider

*2026-09-10. Companion to `docs/2026-08-28-openai-realtime-mcp-tools.md` (OpenAI) and
`docs/2026-08-28-elevenlabs-mcp-in-code.md` (ElevenLabs). Verified against Vapi's own OpenAPI
document (`https://api.vapi.ai/api-json`, fetched 2026-09-10) rather than against the docs site,
because the docs site's example and the schema disagree — see §2.1.*

---

## 1. The short version

Vapi has a **first-class MCP tool type** (`CreateMcpToolDTO`), and it is accepted **inline in
`model.tools`** on the assistant we already provision. So the third provider is the *cheapest* of the
three to grant, not the most expensive:

- **No second remote object.** ElevenLabs needed an MCP server registration, created before the agent
  and deleted after it, keyed by grant set in `agents.lock.json`. Vapi needs none of that — the grant
  is a field of the assistant, carried by the same create/patch that carries the prompt.
- **Nothing to approve.** OpenAI needed `require_approval: "never"`; ElevenLabs needed
  `auto_approve_all`. Vapi has no approval mechanism at all. A tool call runs.
- **No allowlist either**, which is the flip side of the same coin. Vapi fetches the tool list from
  the MCP server when the call starts and hands the model everything it advertises. So on this
  provider `mcpTools` is a **switch with documentation attached**, one step coarser even than
  ElevenLabs' registration-per-grant-set.
- **One genuinely new thing: we hold the credential.** Vapi has no secret store in its public API, so
  `MCP_TOKEN` is written into the assistant as `server.headers.Authorization`. `pnpm sync:agents`
  reads that variable for the first time, and the sentence in its header saying it deliberately does
  not is now wrong and corrected.

`words-3.1` is `words-3.0` plus the shared clause and the shared grant. With it, **the same lesson,
the same clause and the same grant run on all three services** — which is what makes a difference
between `words-1.1`, `words-2.1` and `words-3.1` a difference between ElevenLabs, OpenAI and Vapi and
nothing else.

### Decisions taken 2026-09-10

1. **Inline `model.tools`, not a stored tool + `toolIds`.** §4.1.
2. **`metadata.protocol: "shttp"`**, pinned though it is already Vapi's default. §4.2.
3. **`server.headers.Authorization`, not `server.credentialId`** — the credential path is the upgrade,
   and it rests on undocumented API surface today. §4.3.
4. **A missing or short `MCP_TOKEN` makes the whole Vapi driver `unavailable()`**, so the provider is
   skipped with a printed reason instead of half-applied. §4.4.
5. **`messages: []` on the tool block** — this provider's `pre_tool_speech: "off"`. §4.5.
6. **`timeoutSeconds: 20`, no `backoffPlan`.** §4.6.
7. **`DEPLOYED_MCP_URL` and the override guard move into `mcp-url.ts`**, now shared by the two
   providers that write a URL into a provisioned object. §4.7.
8. **`mcpServerIds` is ElevenLabs-only, and `buildPlan` was applying it to every driver.** A latent
   bug that `words-3.1` would have turned into an endless PATCH loop. §6.

---

## 2. What Vapi's MCP tool actually is

From the OpenAPI document, `CreateMcpToolDTO`:

| Property | Type | Notes |
|---|---|---|
| `type` | `"mcp"` | **The only required property.** |
| `server` | `Server` | `url`, `headers`, `timeoutSeconds` (1–300, default 20), `credentialId`, `encryptedPaths`, `backoffPlan` (default: no retries), `staticIpAddressesEnabled`. |
| `metadata` | `McpToolMetadata` | Exactly one property: `protocol`, `"sse" \| "shttp"`, *"Defaults to Streamable HTTP"*. |
| `messages` | `ToolMessage[]` | Spoken **while the tool runs**: request-start / complete / failed / delayed. |
| `toolMessages` | `McpToolMessages[]` | Per-tool overrides, `{ name, messages }`. *"Set to an empty array to suppress all messages for this tool."* |
| `rejectionPlan` | conditions | Regex or Liquid over the conversation, to refuse a call. Not an allowlist — §4.2. |

`CreateMcpToolDTO` appears in the `oneOf` of `AnthropicModel.tools` (verified: it is in the list, and
`AnthropicModel` also has `toolIds` and `toolRefs`), and in the body of `POST /tool` as `McpTool`. So
both shapes exist and inline is available.

### 2.1 The docs site is wrong about one field, and it matters

`https://docs.vapi.ai/tools/mcp` shows:

```json
{ "type": "mcp", "function": { "name": "mcpTools" }, "server": { "url": "…" }, "metadata": { "protocol": "sse" } }
```

`CreateMcpToolDTO` has **no `function` property at all** — the schema's properties are exactly
`messages`, `type`, `server`, `toolMessages`, `metadata`, `rejectionPlan`. The example is a leftover
from when MCP tools were modelled on function tools. It is either ignored or rejected as an unknown
field; we do not send it, and the assistant Vapi returns will not have it.

The same page also still labels `sse` as the default in one place and calls it deprecated in another.
The schema says Streamable HTTP is the default. Trust the schema.

### 2.2 The two operational facts that are not in the schema

Both from the docs page, and both worth knowing because neither is visible from this repo:

- **Tools are listed when the CALL STARTS** — *"Vapi fetches the currently available tools from your
  configured MCP server when a call starts"* — so a lesson's tool inventory depends on `/api/mcp`
  being up and warm at that moment, and a cold Vercel function sits on the call-setup path. This is
  the same shape as ElevenLabs and unlike OpenAI, where the grant is baked into a minted session.
- **Each MCP request carries `X-Call-Id`** (`X-Chat-Id` / `X-Session-Id` for the non-voice surfaces).
  Harmless to our route, which reads one header. See §9 for what it could be worth later.

---

## 3. Three providers, three shapes of one grant

The table this note exists to complete:

| | OpenAI Realtime | ElevenLabs | **Vapi** |
|---|---|---|---|
| Where the grant lives | `session.tools[]`, minted per request | a workspace **MCP server registration**, named by id on the agent | **inline `model.tools[]`** on the assistant |
| Remote objects to reconcile | none | 2 (agent + registration), with a delete-ordering constraint | **1** (the assistant) |
| Narrowed by | `allowed_tools` — the list is sent | the registration (server-level); the list is never sent | **nothing**; the list is never sent |
| Approval default | `"always"` → must set `"never"` | `require_approval_all` → must set `auto_approve_all` | **none** |
| Who holds `MCP_TOKEN` | OpenAI, per session (redacted on read-back) | ElevenLabs, as a human-created workspace secret | **the assistant object, in the clear** |
| A typo in `mcpTools` | silently yields a tutor with no tools | a wrongly-named registration; tools still reach the agent | **nothing at all; invisible** |
| Rotating `MCP_TOKEN` | next request | edit the workspace secret | **re-run `pnpm sync:agents`** |

Reading down the "Vapi" column: this provider is the easiest to wire and the least willing to be
narrowed. Both halves of that come from the same design — the grant is a pointer at a server, with no
vocabulary for what lives on it.

---

## 4. The decisions

### 4.1 Inline `model.tools`, not `POST /tool` + `toolIds`

A stored tool would be a second remote object with its own id, its own hash, its own lockfile entry
and its own ordering problem (a tool cannot be deleted while an assistant references it — the exact
constraint that makes the ElevenLabs MCP phase bracket the agent loop). Inline costs none of that,
and it puts the tool block inside `vapiHash`, so a change to the grant is an update to the assistant
and nothing else needs to notice.

The stored shape only starts paying if several assistants must share one tool object *and* that object
has content worth sharing. Here its entire content is a URL and a header, and — because Vapi cannot
narrow a server — two versions can never want *different* Vapi MCP tools against `/api/mcp` anyway.
Adopting `toolIds` would be adopting ElevenLabs' registration model voluntarily, for the cost of it
and none of the reason.

### 4.2 `mcpTools` is a switch on this provider, and the field's own doc says so

There is no allowlist. The two things that look like one, and why neither is used:

- **`toolMessages[].name`** proves Vapi knows the per-tool names — but it only overrides what is
  *spoken*, never what is *available*.
- **`rejectionPlan`** can refuse a tool call based on a regex or a Liquid template over the
  conversation. That is a per-call gate, not a grant, and using it as an allowlist would put a regular
  expression between the learner and their own vocabulary. If a save is refused it must be refused by
  the server, which is where the write actually is.

So the projection recorded in `vapi-mcp.ts` is: *a non-empty `mcpTools` means "attach our MCP server";
the names in it document what the lesson expects to find there.* With one tool registered on
`/api/mcp` the distinction is invisible. The day a second is registered, every Vapi version with a
non-empty list gets it retroactively — the outcome `mcpTools` exists to prevent and cannot, on this
provider. `prompts/types.ts` states it where someone setting the field will read it, which is the only
mitigation available.

`metadata.protocol` is pinned to `"shttp"` even though that is the platform default, because
`app/api/mcp/route.ts` is `mcp-handler`'s Streamable HTTP handler and `sse` cannot talk to it at all.
On ElevenLabs the same field had to be corrected (its default is SSE); here the default is already
right, and it is pinned for the standing registry reason — the value is ours, and a default that moved
would move a live assistant with it.

### 4.3 The credential is written in, in the clear

Vapi's public OpenAPI document has **no credential endpoints** (no path matching `/credential`), so
the shaped alternative — `Server.credentialId` pointing at a `custom-credential` holding a
`BearerAuthenticationPlan` (`{ type: "bearer", token, headerName?, bearerPrefixEnabled? }`, which is
exactly the header `lib/mcp/auth.ts` wants) — would mean provisioning against API surface Vapi does
not publish. The schemas for it exist (`CreateCustomCredentialDTO`, `BearerAuthenticationPlan`), which
is what makes it a real upgrade path rather than a wish; the endpoint to create one is not documented,
which is what keeps it out of `sync:agents` today.

So: `server.headers: { Authorization: "Bearer <MCP_TOKEN>" }`, and the consequences stated where they
can be read (`vapi-mcp.ts`, and this section):

1. **The token is at rest in the assistant object**, readable by anyone holding `VAPI_PRIVATE_KEY` or
   dashboard access. It is not a new class of exposure — §3.3 of the OpenAI note already accepted that
   this secret leaves our infrastructure by design — but it is the first time it is *stored* by a
   vendor rather than presented to one. `MCP_TOKEN_OLD` is deliberately not consulted here, for the
   same reason as on OpenAI: we always present the current value.
2. **Rotation propagates only through a sync**, and it does so automatically: `vapiHash` hashes the
   body that will be sent, so a new token is a changed body is a PATCH.
3. **The hash now has a secret as an input.** That is fine in both directions and both are recorded in
   `vapiHash`'s docblock: the lockfile stores a SHA-256, so it records *that* the secret changed
   without recording the secret; and `--dry-run` on a machine missing the value prints an update the
   apply would not need, which errs toward doing more. `VAPI_WEBHOOK_SECRET` already had exactly this
   property — this is a second instance of an accepted trade, not a new one.

### 4.4 A missing token must SKIP the provider, not half-apply it

This is the hazard worth the most care in the whole change, because it is silent from end to end.

`vapiHash` hashes the body that will be sent. The token is in the body. So a sync run on a machine
without `MCP_TOKEN` computes a *different* hash and PATCHes the live assistant with a tool block whose
Authorization is `Bearer ` — after which every tool call comes back 401, mid-lesson, with nothing
local to notice. Same failure as the `secret_token` trap on ElevenLabs (§5.1 of that note), arriving
through a different door.

The fix is to put it where `sync-agents.ts` already handles "this provider cannot run": the driver's
`unavailable()`, which prints its reason and leaves the provider's versions **and** its lockfile
entries alone. `vapiMcpConfig` therefore returns a *reason*, in the same three-outcome shape as
`openAiMcpTools` and `elevenLabsMcpRegistrations`:

```
✗ skip vapi — Version "words-3.1" grants MCP tools on Vapi, but MCP_TOKEN is unset
  or shorter than 32 chars. Unlike ElevenLabs, Vapi has no workspace secret to point
  at — the token is written into the assistant — so syncing without it would replace a
  working tool block with one whose every call our own server rejects.
```

`--dry-run` never calls `unavailable()`, so `pnpm sync:agents:plan` still works on a machine holding
no credentials — which is a requirement, not a nicety.

The URL guard reports through the same channel rather than `process.exit(1)` (which is what the
ElevenLabs registration phase does): skipping is strictly safer than exiting when the alternative
outcome is a repointed live assistant, and it is loud either way.

### 4.5 `messages: []` — this provider's `pre_tool_speech: "off"`

The save clause is explicit that saving is quiet: *"Never announce that you are about to use a tool,
never describe the tool, never read back what it returned."* Vapi's tool `messages` are spoken while
the tool runs, so an unset default is a prompt-level rule undone by a platform field — which is
exactly what `pre_tool_speech: "auto"` would have done on ElevenLabs.

An empty array **at the parent** suppresses them for every tool loaded from the server. The per-tool
`toolMessages` override would do the same thing while hardcoding `add_words_to_collection` in a second
place, where it could drift from the grant. Parent-level, therefore.

### 4.6 `timeoutSeconds: 20`, and no `backoffPlan`

Twenty seconds is the same number and the same argument as `response_timeout_secs` on ElevenLabs:
below `route.ts`'s `maxDuration = 60`, and well below a spoken turn's patience. It happens to equal
Vapi's own default; it is still stated rather than inherited.

`backoffPlan` is left undefined, which means no retries — the clause already tells the tutor "if
saving fails, don't retry it and don't dwell on it", and a platform-level retry would put a duplicate
write behind a tutor that has already moved on.

### 4.7 One URL, one guard, two providers

Vapi is the second provider whose remote object is **shared with production** and has the URL written
into it. That makes `MCP_PUBLIC_URL` an override rather than a source for it too, with the same
consequence if it is not: `sync:agents` run on a laptop with a tunnel would repoint the live
assistants at that laptop, and the tunnel then dies.

Rather than a second copy of `resolveUrl`, `DEPLOYED_MCP_URL` and the guard moved into `mcp-url.ts` —
the module that exists precisely because *"a second verbatim copy is how two guards drift, and this
one fails SILENTLY when it is wrong"*. Its header used to say the mappers deliberately do not share
their failure messages; that argument was about OpenAI versus ElevenLabs, which are genuinely
different shapes (per-session and env-driven versus provisioned and constant). ElevenLabs and Vapi are
the *same* shape as each other, so what is shared is the pair that matches, and the vendor's name and
its noun for the object are parameters:

```
MCP_PUBLIC_URL is set to https://abc.ngrok.app/api/mcp, which differs from the deployed origin this
  assistant normally uses:
      https://eleven-labs-english-agent.vercel.app/api/mcp
  The Vapi account is shared with production, so applying this would repoint the
  LIVE assistants' MCP server. Re-run with --allow-dev-mcp-url if that is what you want.
```

OpenAI keeps its own reader, unchanged.

---

## 5. The hazard hiding in a copy-pasted sentence

`CreateMcpToolDTO.server` carries the generic `Server` description, which says the webhook goes to
*"the first available URL in this order: `{{tool.server.url}}`, `{{assistant.server.url}}`,
`{{phoneNumber.server.url}}`, `{{org.server.url}}`"*.

Our assistants set `server.url` — it is where `end-of-call-report` is delivered
(`/api/v2/vapi/webhook`). If a tool block were ever emitted **without** a url, that fallback chain
would point Vapi's MCP client at our webhook route: an endpoint that speaks neither JSON-RPC nor MCP,
reached with a secret it does not check for, failing in a way that looks like a broken tool rather
than a misconfigured one.

`vapiMcpTools` always sets the url, and its docblock says not to make the field conditional. Recorded
here because the fallback is documented behaviour, not a bug, and the next person to touch that
builder will not have read the `Server` schema.

---

## 6. A real bug found next door: `mcpServerIds` is ElevenLabs' and `buildPlan` applied it to everyone

`lock.mcpServers` holds **ElevenLabs registrations** and nothing else. But `mcpServerIdsFor(cfg)` was
keyed on the grant set alone, and `buildPlan` / `applyPlan` used it for every driver:

- `mcpDrifted = !sameIds(entry?.mcpServerIds ?? [], mcpServerIdsFor(cfg))` — for a Vapi version
  granting `add_words_to_collection`, that compares `[]` against the *ElevenLabs* server id and
  reports a difference **on every run, forever**: a pointless PATCH of the live assistant each sync.
- `mcpIdsRecord(a.cfg)` would then stamp that ElevenLabs id onto the Vapi lock entry, where it means
  nothing.
- `mcpMoved` had the same shape: an ElevenLabs registration being replaced would force an update to
  every Vapi version that happened to grant the same set.

Vacuous before this change — no Vapi version granted anything — and wrong the moment `words-3.1`
existed. Fixed by asking the question the code actually meant: `mcpServerIdsFor` returns `[]` unless
`c.provider === "elevenlabs"`, and `mcpMoved` carries the same guard. This is the same class of
mistake as `PROVISIONED` in `agent-registry.ts` once being written as `provider !== "elevenlabs"` — a
predicate that was correct while ElevenLabs was the only provider of its kind.

Confirmed by the plan after the change: `words-3.0` is `no-op` (its body is byte-identical — the
`tools` key is omitted, not sent empty) and only `words-3.1` is a create.

```
▶ sync:agents  (dry run)   prune=retire   providers=elevenlabs,vapi
  · mcp        add_words_to_collection  [elevenlabs mcp server]
  · no-op      words-1.0  [elevenlabs]
  · no-op      words-1.1  [elevenlabs]
  · no-op      words-3.0  [vapi]
  ＋ create    words-3.1  [vapi]
```

---

## 7. What `words-3.1` is

`words-3.0` + `SAVE_TO_COLLECTION_CLAUSE` + `SAVE_TO_COLLECTION_TOOLS`, with 3.0's `llm`,
`turnEagerness` and `silenceEndCallTimeoutSeconds` carried over unchanged so the capability is the
only difference between the two.

**Why a new module rather than an edit to 3.0** is the argument 2.1 and 1.1 already made and it has
not weakened: `words-1.0`, `words-2.0` and `words-3.0` are the same prompt byte for byte on three
services, and that identity is the only reason comparing them means anything. What 3.1 adds is the
symmetric fact one level up — the clause and the grant now exist on all three services too, so the
lesson-with-a-tool is comparable exactly the way the lesson without one already was.

The prompt is composed, not copied. Diffing 3.0 against 3.1 shows one thing.

### 7.1 A correction: "words-3.0 is not in the picker" was stale

Both `words-3.0.ts` and the registry note in `prompts/index.ts` still claimed 3.0 was withheld from
the picker for lack of a mobile adapter. That stopped being true on **2026-08-28**, when
`apps/mobile/src/lib/transport/vapi.ts` became real and `"vapi"` was added to `CLIENT_READY`
(`lib/agent-registry.ts`). Both the registry note and `words-3.0.ts`'s own
section are corrected — comment-only, so no hash moves and nothing is re-PATCHed.

`words-3.1` is therefore offerable to a learner as soon as a sync provisions it — the first MCP-granting
version on this provider, and the third overall.

---

## 8. What is NOT verified, and how to verify it

**Applied 2026-09-10.** `pnpm sync:agents` created the assistant
(`b105c7cc-132e-4f23-9bb5-1174cb2d71a6`) and a re-plan reports every provider unchanged, so the
`mcpServerIds` fix in §6 holds: the Vapi lock entry carries no `mcpServerIds` key and does not
re-PATCH on the next run. `GET /assistant/{id}` echoes the block back **byte for byte** — nothing
dropped, renamed, or rejected as unknown:

```json
{ "type": "mcp",
  "server": { "url": "https://…/api/mcp", "headers": { "Authorization": "Bearer <redacted>" },
              "timeoutSeconds": 20 },
  "messages": [],
  "metadata": { "protocol": "shttp" } }
```

So the write path is verified: the schema reading was right, `messages: []` persists rather than
being treated as unset, and `silenceTimeoutSeconds` came back as 3600 — the `-1` → platform-maximum
mapping, intact.

**One real lesson is still owed**, and it is the same class of verification §5 of the OpenAI note
insisted on, for the same reason: the remaining failure modes are invisible from this repo.

1. **Vapi's MCP client against `mcp-handler`'s Streamable HTTP.** Their client opens a new connection
   per call; ours is a stateless handler that will see an `initialize` each time. Content negotiation
   (`Accept: application/json, text/event-stream`) and session-id handling are exactly where two MCP
   implementations disagree quietly. Check: the tool appears at call start, one "save that one" writes
   a row, and `/api/mcp` logs show no 401 and no 406.
2. **Call-setup latency.** Tools are listed when the call starts, against a Vercel function that may
   be cold. Worth timing once — if it is material, it is an argument for a warm ping at token mint.
3. ~~**Whether `GET /assistant/{id}` echoes the Authorization header in clear.**~~ **ANSWERED: yes.**
   The header comes back verbatim, so `MCP_TOKEN` is readable by anyone holding `VAPI_PRIVATE_KEY` or
   dashboard read access. Unlike OpenAI, which redacts it (`"<redacted>"`) in the `client_secrets`
   response, Vapi treats it as ordinary assistant config. This is the strongest argument for the
   `credentialId` upgrade in §4.3, and it moves that from tidiness to a real, if accepted, exposure.
4. **That `rejectionPlan`'s absence is really the default** — i.e. that a tool call is never gated by
   anything we did not send.

---

## 9. The consequence that has not changed, and one that could

**Words saved through MCP are anonymous — `owner_id` is NULL** — because the static token
authenticates a caller and not a person (`docs/2026-08-27-mcp-static-token-auth.md` §2). Unchanged by
this work, and restated because `words-3.1` is the third door onto the same server: with one learner
it is invisible, with two it is a word saved in one lesson appearing in the other learner's
collection. It is the thing to fix before either of these versions is offered to a second person, and
it is a property of the SERVER, not of any version.

**Vapi is, unexpectedly, the provider where it could be fixed first.** Its MCP requests carry
`X-Call-Id`, and the call was minted by our own `/api/v2/words-agent/vapi-token` route, which knows
the Auth0 `sub` at mint time. A `call_id → owner_id` record written there would let
`lib/mcp/add-words.ts` resolve a real owner for exactly the calls we minted, and fall back to
anonymous for everything else. Neither of the other two providers offers a correlator like it —
OpenAI's MCP calls carry nothing session-shaped, and ElevenLabs' carry nothing at all. Recorded as a
lead, not a plan; it is a schema change and a review of its own.

---

## 10. Follow-ups not taken

1. **`VAPI_WEBHOOK_SECRET` has the same "absent secret silently rewrites the assistant" property** and
   no precondition guarding it: a sync without it PATCHes the live assistant to *drop* the `server`
   block, and `end-of-call-report` then has nowhere to go. The same one-line treatment as §4.4 would
   fix it. Left alone because it is a pre-existing bug in a different feature, and folding it into
   this change would hide it.
2. **`server.credentialId` custody** (§4.3), if the plaintext token in the assistant ever becomes
   unacceptable — or if Vapi documents the credential endpoints.
3. **`MIN_MCP_TOKEN_LENGTH` is now defined in `mcp-url.ts` and still mirrored privately in
   `openai-mcp.ts`.** Two copies of the same 32, both mirroring `lib/mcp/auth.ts`. Consistent with the
   house style (that module deliberately mirrors rather than imports), and worth collapsing the next
   time someone touches it.
4. **Nothing in `apps/mobile` changed and nothing needs to.** The grant runs vendor → us; the client
   never sees it. Worth stating because Vapi *does* accept a client-supplied `tools:append` in
   `assistantOverrides`, which would have been the wrong place for this by a wide margin: it would
   put `MCP_TOKEN` in a shipped binary and let a tampered client append any tool it liked.
