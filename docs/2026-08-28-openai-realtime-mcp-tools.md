# The tutor reaches the collection: MCP tools on an OpenAI Realtime version

**2026-08-28.** Companion to `docs/2026-08-23-mcp-server-add-words.md` (the server),
`docs/2026-08-27-mcp-static-token-auth.md` (its authorization) and
`docs/2026-08-22-openai-realtime-second-provider.md` (the provider).

## 1. The short version

`/api/mcp` has existed since 2026-08-23 and has had exactly one kind of client: a chat app the
learner types into. This adds the other kind — **the tutor mid-lesson**. An OpenAI Realtime version
may now declare `mcpTools`, and `/api/v2/words-agent/openai-token` bakes our own MCP server into the
session it mints, so the model can save a word the learner asks for without the lesson stopping.

The mechanism is one object in `session.tools`. **The connection runs OpenAI → us**: their servers
dial `/api/mcp` over the public internet, list the tools, call them, and feed the result back into
the model. Nothing about it touches the device — `apps/mobile/src/lib/transport/openai.ts` is
unchanged, and there is no data-channel round trip on the tool path.

Four files carry the change, and one new version uses it:

| File | Role |
| --- | --- |
| `agent/prompts/types.ts` | `mcpTools?: string[]` — the grant, per version |
| `agent/openai-mcp.ts` | the translation: version + env → the `session.tools` entry (new) |
| `lib/config.ts` | `mcpClientConfig()` — the URL and the secret we PRESENT |
| `api/v2/words-agent/openai-token/route.ts` | bakes it, or 500s saying why it could not |
| `agent/prompts/words-2.1.ts` | words-2.0 + the clause + the grant (new) |

## 2. Why the version names the tools

The registry's existing rule: a version states what the LESSON wants, and a per-provider mapper
translates it into a vendor's field (`turnTimeoutSeconds` → `idle_timeout_ms` → Vapi's nothing at
all). "May this tutor write to the learner's collection" is that kind of question, so it belongs on
the version. The server's address and credential are deployment facts and stay in the environment.

**There is no wildcard on purpose.** Under one shared secret there are no scopes: every client
holding `MCP_TOKEN` reaches every tool registered on the server. This list is the only place a
version's reach narrows, and a `"all tools"` value would hand the second tool — the read tool whose
threat model the server's own header comment calls a different review — to every existing version
retroactively, on the day it is registered.

The field is OpenAI-only. ElevenLabs attaches MCP servers through its dashboard, outside the
`agents.lock.json` discipline (§6 of the static-token note); Vapi has its own tool vocabulary that
`vapiAssistantBody` does not speak. Both IGNORE the field rather than approximating it.

## 3. The three things that decide whether this works

### 3.1 `localhost` cannot work, and fails silently if you let it

OpenAI dials the server from their network. A dev URL produces a tutor whose tools never list —
visible as a lesson that simply never saves anything, with nothing in our logs at all, because the
request never arrives. `openAiMcpTools` therefore refuses a loopback host up front, and
`MCP_PUBLIC_URL` exists as its own variable rather than being derived from `APP_BASE_URL` (which is
`http://localhost:3000` in every dev environment).

For local work: a tunnel. This document's verification used one (§5). The same guard also refuses a
LAN address (`192.168.…`, `.local`) — the identical mistake made from a URL that looks real — and
anything that is not `https`, because this URL carries `MCP_TOKEN` to a third party and `http` would
put it on the wire in cleartext while still appearing to work.

It is also, for the same reason, **the one key whose value legitimately differs per environment** — a
tunnel on the laptop, the deployed origin in production — against the "every environment carries the
same values" rule in `docs/2026-08-28-env-variable-sync.md`. Noted in `.env.example` where whoever
runs the bulk push will see it.

### 3.2 `require_approval: "never"` is load-bearing

The default is `"always"`: the model emits an `mcp_approval_request` and waits for an
`mcp_approval_response` that must come from the client over the data channel. Nothing in the mobile
transport answers one, so the default produces a tutor that stops talking mid-lesson and never
resumes — a hang, not an error. The approval in this design is upstream of the session: a version
must name the tool, and the server exposes one write-only, non-destructive tool.

### 3.3 The secret leaves our infrastructure

`MCP_TOKEN` is handed to OpenAI so they can present it back to us. That is a real widening of where
the secret lives and it should be said plainly rather than buried in a field name.

What was checked rather than assumed (2026-08-28): the `client_secrets` response echoes the session
back with `"authorization": "<redacted>"` and `"headers": {"Authorization": "<redacted>"}`, so the
credential does **not** ride down to the device alongside the ephemeral key. The device gets a key
that opens one session, exactly as before.

`MCP_TOKEN_OLD` is deliberately not consulted: it exists so clients configured with the outgoing
secret keep working through a rotation, and we are not one of those clients.

## 4. words-2.1, and why it is a new version

`words-1.0`, `words-2.0` and `words-3.0` run `PODCAST_LESSON_PROMPT` **byte for byte** on three
services. That identity is the only reason comparing them means anything, and a tool the tutor may
call needs a prompt clause — so granting it on 2.0 would have cost the comparison, and granting it
without a clause would have left 2.0's module describing something it no longer is.

`words-2.1` is therefore composed, not copied: the shared prompt unchanged, plus one clause, plus
`mcpTools: ["add_words_to_collection"]`. Diffing 2.0 against 2.1 shows exactly one thing.

The clause is worded as an interruption rule, because interruptions are already how the learner takes
part in this lesson. It guards three failure modes: **narrating the tool** (this is a podcast, not a
machine describing itself), **saving today's items** (they are already in the collection — that is
where the lesson's list came from), and **saving unasked** (a tutor that hoovered up every related
word it mentioned would fill the collection with words nobody chose).

`words-2.1` appears in the picker automatically — `activeVersions()` withholds only providers with
no client adapter, and OpenAI has one.

## 5. Verified end to end, not just typechecked

Against a real session, with the dev server exposed through an ngrok tunnel:

```text
POST /api/mcp  401   ← no credential (the standing check, unchanged)
POST /api/mcp  200   ← ua: openai-mcp/1.0.0 (Realtime API)   method: server/discover
POST /api/mcp  200   ← ua: openai-mcp/1.0.0 (Realtime API)   method: tools/list
```

and on the session:

```text
mcp_list_tools.in_progress → mcp_list_tools.completed
LISTED from tutor-collection: [ 'add_words_to_collection' ]
```

So OpenAI's MCP client authenticates with the static Bearer token, speaks our server's transport,
and the model ends up holding the tool. Also confirmed on the way: a hyphenated `server_label`
(`tutor-collection`, matching `serverInfo.name`) is accepted.

The probe deliberately stopped at listing and never called the tool, because calling it writes a
real row.

## 6. The consequence to fix before a second learner

**A word saved this way has `owner_id` NULL.** MCP writes are anonymous — the shared token names a
caller, not a person (§2 of the static-token note) — and the collection reads widen to unowned rows,
so with exactly one learner the word appears in their collection and everything looks right.

With two learners, a word saved during one person's lesson appears in the other's collection. That is
the same trade the MCP server already made, but this change moves it from "a chat app the learner
drives" to "the tutor, during a lesson", which makes it much easier to hit. Whichever fix the
collection eventually gets — per-learner tokens, or claiming on save — this version is the reason it
becomes urgent rather than theoretical.

## 7. What was left alone

- **No `headers`.** `authorization` says the same thing in one field; OpenAI normalises it into
  `headers` on their side.
- **No `defer_loading`.** It trades a round trip for lazily-discovered tools; pointless against a
  server advertising one tool.
- **No `tool_choice`.** Stays `"auto"` — a forced tool call would make the tutor a form-filler.
- **No `tunnel_id`.** OpenAI's Secure MCP Tunnel would remove the ngrok step for local work. Worth
  revisiting if local tool testing becomes routine; `server_url` is what a deployment uses.
- **No read tool.** Unchanged from the server's own rule: the first one makes this an exfiltration
  channel and is a different review.
