# S3 — the conversation id and the v2 token route (B3) · research

**Date:** created 2026-08-13 · researched 2026-08-13 · built, run and **passed 2026-08-14** ·
**Status:** ✅ **GATE PASSED (B3-M4).** Two native sessions, each landing as exactly one
`lesson_sessions` row keyed on the id the token route returned, each carrying both the client's
transcript and the webhook's `duration_secs`. B3 is answered: **the conversation id survives
WebRTC.** See §14.

**Parents:** [build plan → S3](./2026-08-12-expo-build-plan.md) ·
[creation doc §2, §3.4, §9 B3](./2026-08-12-expo-app-creation.md) ·
[S2 research](./2026-08-13-expo-s2-auth0-bearer.md) (passed Half A 2026-08-13; **Half B is owed
here** — §11).

---

## 0. What the research settled

The placeholder asked seven questions. All seven are now answered — six by reading source and
probing the live account, and the seventh by fixing what the probe uncovered and then observing it
work.

| Placeholder question                                              | Answer                                                                                                                                                                       | Where |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| Exact request/response of `/v1/convai/conversation/token`         | **Probed live.** `{ token, conversation_id }`, both present, `conv_*`. But the installed SDK's own type says `{ token }` only — D21.                                          | §2.1  |
| Is `conversation_id` always present?                              | Required in the published schema and present in the probe. Treated as **required anyway** — a missing one is a 502, never a derived fallback.                                 | §2.1  |
| The `api.ts` declarations                                         | Written out in full.                                                                                                                                                         | §5.1  |
| Where `appEnv` comes from, and what "error not default" means     | `elevenLabsConfig().appEnv` ← `APP_ENV`, **which defaults to `"prod"` in `lib/config.ts`.** The client-side rule is the one that bites; the server-side default is a trap.    | §7.2  |
| Which id the **post-call webhook** reports                        | **`conv_*`, and it lands on the same row the client wrote** — observed 2026-08-14, after fixing three stacked defects that had stopped the webhook from ever writing at all.  | §8    |
| How to inspect `lesson_sessions`, and what a fork looks like      | Query in §9.2; the fork signature is exact, because the room-name format is known.                                                                                            | §9    |
| Do overrides land before the kickoff effect on WebRTC?            | **Yes, structurally.** `constructOverrides` + `sendMessage` are the last two statements of `WebRTCConnection.create`, which `startSession` awaits. `onConnect` fires after.   | §3.4  |
| Does `POST /api/v2/lessons/session` reuse `persistTutorSession`?  | **Not as written** — it calls `getOwnerId()` (cookie) internally. It needs an owner parameter. D24.                                                                           | §5.4  |

**Two findings reshaped the stage.**

1. **The B3 hazard is narrower than the creation doc feared** (§3.1). The SDK's derived id *does*
   match the authoritative one in the normal path; only an empty `room.name` breaks it. The
   mitigation stays, as insurance rather than as a correction.
2. **The thing that would actually have failed the gate had nothing to do with the phone** (§3.3):
   the post-call webhook had **never written a row to this database**, on any transport, for three
   independent reasons. That is now found, fixed and proven from a browser (§8) — which is why S3
   grew a pre-gate, **B3-M0**, and why it ran before a line of stage code was written.

---

## 1. Inputs from S2 — filled in

From [S2 §11](./2026-08-13-expo-s2-auth0-bearer.md).

- **`getBearerOwnerId(req: Request): Promise<string | null>`** and the `withBearer(handler)` wrapper
  exist in `apps/web/src/lib/auth/bearer.ts`. Every v2 route is written as
  `export const POST = withBearer(async (req, ownerId) => …)`; the handler signature makes
  "forgot to authenticate" inexpressible. S3's token route is its second caller.
- **Device→server auth works to the edge of the network.** Login, JWT, `Bearer` (not DPoP), silent
  renewal and logout are all green on-device. What has never run is a single authenticated request
  to our server — that is S2's Half B, and it is owed here (§11).
- **The API base URL is `EXPO_PUBLIC_API_BASE_URL` → `MobileEnv.apiBaseUrl`**, read through
  `src/env.ts`'s `required()` getter, which throws (rather than defaults) when empty. **It is still
  empty in `apps/mobile/.env` as of 2026-08-14** — the first thing the build session sets (§7.1).
  Dev-vs-prod is selected by `APP_VARIANT` at build time, which picks a `VARIANTS` entry in
  `app.config.ts`; the value itself comes from `.env` locally and EAS environment variables in the
  cloud (S2 D20). **Changing it requires a rebuild.**
- `MobileEnv.agentId` is S1's public-agent field and **is deleted by this stage**.

---

## 2. The live probe — what was measured, not assumed

Run 2026-08-13 against the real account with the key in `apps/web/.env`. Every number below is
observed output, not documentation. **§2.3 and §2.4 record the state _before_ the fixes in §8** —
they are kept because they are the evidence, and because the failure they describe is the kind that
recurs.

### 2.1 `GET /v1/convai/conversation/token`

```text
GET https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=<words-1.3 agent>
     header: xi-api-key: <server-side only>

HTTP 200
response keys: [ "token", "conversation_id" ]
conversation_id: conv_1201kzyatgm9fa5rk8hqj9wcx67f
```

The token is a **LiveKit access JWT**, and its payload is the most useful thing the probe produced:

```jsonc
{
  "video": {
    "roomJoin": true,
    "room": "room_agent_1801kxv585kweqjba1es8scshjdj_conv_1201kzyatgm9fa5rk8hqj9wcx67f",
    "canPublish": true, "canSubscribe": true, "canPublishData": true
  },
  "sub": "user_agent_<agentId>_conv_<conversationId>",
  "iss": "APIKeyExternal",
  "nbf": …, "exp": …          // exp − nbf = 900 s
}
```

Three facts fall out of that one object, and §3 is built on them:

1. **The room name is `room_agent_<agentId>_conv_<conversationId>`** — it embeds the conversation id
   rather than being it.
2. **The token lives 900 seconds.** Mint it immediately before `startSession`, never at screen
   mount (D28).
3. `alg: HS256`, signed by ElevenLabs for LiveKit. We hold no key and **must not verify it** — it
   arrives over TLS from an authenticated call we made ourselves. Decoding it is possible but
   unnecessary; `conversation_id` is returned beside it (D21's note).

### 2.2 The four tutor agents

`GET /v1/convai/agents/<id>` for every version in `agents.lock.json`:

| Fact                       | Value                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| `auth.enable_auth`         | **`false` on all four**                                                                 |
| `overrides` allowlist      | everything `false` except `conversation.text_only` — dynamic variables are not gated by it |
| `max_duration_seconds`     | 1800 on all four                                                                        |
| `workspace_overrides.webhooks.post_call_webhook_id` | words-1.0, words-1.1 → `bdabca8f…` · words-1.2, words-1.3 → `null` — **all four now `null`** (§8.2c) |

**`enable_auth: false` is worth stating plainly, because it changes the honest argument for the
token route.** The tutor agents are publicly connectable by id today; the token route is therefore
**not** buying confidentiality it currently has. It buys the one thing the creation doc actually
claimed (§2): the app never learns an agent id, so `pnpm sync:agents` can retire a version without
bricking installed binaries. Keep the route, keep the reason accurate.

The **overrides allowlist matters and is fine**: `dynamic_variables` is a sibling of
`conversation_config_override` in the initiation event (`constructOverrides`), not a member of it,
so an allowlist of all-`false` does not block `items_list` / `lesson_id` / `app_env`. This is also
proved empirically — the web app has been sending them through the same event for months, and the
2026-08-14 sessions carried all three (§8.3).

### 2.3 The workspace webhooks — as found

`GET /v1/workspace/webhooks?include_usages=true`:

| Name          | URL                                                                    | Disabled | Used by                     |
| ------------- | ---------------------------------------------------------------------- | -------- | --------------------------- |
| `vercel-prod` | `https://eleven-labs-english-agent.vercel.app/api/words-agent/elevenlabs-webhook` | no  | **nothing**                 |
| `local-ngrok` | `https://exchange-repulsion-daringly.ngrok-free.dev/api/words-agent/elevenlabs-webhook` | no | 2 × ConvAI Agent Settings |
| `local-ngrok` | `https://exchange-repulsion-daringly.ngrok-free.dev/api/live-story/elevenlabs/otel-webhook` | **yes** | ConvAI **Settings** (workspace default) |

And `GET /v1/convai/settings` confirmed the workspace default:

```jsonc
"webhooks": { "post_call_webhook_id": "dfb6c90b…" }   // ← the DISABLED otel webhook
```

Resolve that against §2.2 and the routing *as found* was:

- **words-1.0 / words-1.1** → per-agent override → the ngrok tunnel → a route that exists, but a
  tunnel that was not running (last delivery: **404**, 2026-07-07).
- **words-1.2 / words-1.3** → no override → workspace default → **a disabled webhook pointing at
  `/api/live-story/elevenlabs/otel-webhook`, a route that does not exist in this repo** (left over
  from the live-story spike).

**words-1.3 is the default version** — `resolveAgent(null)` returns the newest active — so the
version every client picks by default had no working post-call webhook.

### 2.4 The database agreed

```text
lesson_sessions: total rows 13 | with duration_secs 0 | with summary 0
conversation_id NOT matching conv_%: []
by agent_version: words-1.0:1, words-1.1:1, words-1.2:4, words-1.3:7
```

**Zero of thirteen rows had ever been written by the post-call webhook.** Every row was the
browser's bare transcript; not one carried the `summary` / `duration_secs` the webhook adds. The
"writers converge on one row" invariant that B3-M4 exists to verify **had never been observed in
this database**, on any transport, including the browser.

The second line is a real result too: **all 13 conversation ids matched `conv_%`.** The WebSocket
path has never produced a bad id — as expected, since it takes the id from the server's
`conversation_initiation_metadata`.

### 2.5 The deployment

`https://eleven-labs-english-agent.vercel.app` is **live**:

```jsonc
// GET /api/health → 503 (only because "auth: not signed in" for an anonymous curl)
{ "supabase": { "ok": true, "detail": "health_pings reachable (1 rows)" },
  "elevenlabs": { "ok": true, "detail": "key valid · 4 active version(s) · default words-1.3" },
  "anthropic": { "ok": true, "detail": "key set · model claude-opus-4-5" } }

// GET /api/words-agent/signed-url → version: words-1.3 | appEnv: "prod"
// GET /api/v2/me                  → 404 (before the push) → 401 (after)
```

Two conclusions. **`APP_ENV=prod` on Vercel** — confirmed by the deployed `signed-url` route echoing
it. And **the deployment was behind `master`**: `/api/v2/me` 404'd because S2's commit had not been
pushed (`origin/master` at `a5acc65`, `/api/v2/me` in `3ef6c01`). Pushed 2026-08-14; it answers 401
now.

> **"Deploy to Vercel first" was therefore mostly `git push`.** The project, the domain, the env
> vars and the integrations were already there and working. This is the cheapest possible version of
> the decision taken for this stage.

---

## 3. B3, re-measured

### 3.1 The derived id actually matches — the fallback chain is not the hazard it looked like

The creation doc read the SDK's derivation and concluded that a derived id "never matches" the
webhook's. With the room-name format now known, that is too strong. From
`@elevenlabs/client@1.17.0` (the installed version — re-read for this stage, unchanged from the
2026-08-12 quote):

```js
const conversationId = `room_${Date.now()}`;                       // placeholder
…
if (room.name) {
  connection.conversationId = room.name.match(/(conv_[a-zA-Z0-9]+)/)?.[0] || room.name;
}
```

Against the real room name `room_agent_1801kxv585kweqjba1es8scshjdj_conv_1201kzyatgm9fa5rk8hqj9wcx67f`:

- `agent_…` cannot contain the substring `conv_` — the id's random tail is alphanumeric with no
  underscores — so the **first and only** `conv_` match is the real conversation id;
- `[a-zA-Z0-9]+` then consumes the id exactly, and the room name ends there, so there is nothing to
  over-consume.

**In the normal path the SDK's derived id equals the authoritative one.** That is a relief, not a
licence: it means the mitigation is cheap insurance rather than a correction, and it means a green
gate proves less than it appears to.

### 3.2 What remains genuinely dangerous

**`room.name` being empty at that instant** — the `room_1786…` placeholder survives, and that id
matches nothing, ever. The read happens after `room.connect()` has resolved *and* after the
`Connected` event *and* after the microphone publish, so `room.name` is populated in every ordinary
run. It is a race that needs a LiveKit-side quirk to lose. It is also invisible when lost: a session
that works perfectly and files its transcript under an id no other writer will ever use.

M1–M3 remain exactly right, and now for a stated reason: **the id is not derived from anything we
control, so we take the one that is.**

### 3.3 The hazard that would actually have failed the gate — found and fixed

§2.3 and §2.4 together: the post-call webhook for the default agent version resolved to a **disabled
webhook at a dead URL**, and no row in the database had ever been enriched by it. Had S3 been built
and the gate run as written, it would have failed — one row, client-written, no summary, no
duration — and every instinct would have blamed WebRTC, the derived id, or `app_env` routing. None
of those would have been the cause.

**Fixed before the device was involved, and proved in a browser: §8.** This is the single most
valuable thing the research produced, and it cost a day less than finding it on a phone would have.

### 3.4 Ordering — overrides land before the kickoff effect

Answered from source rather than deferred to the spike. The last three statements of
`WebRTCConnection.create` are:

```js
if (room.name) { connection.conversationId = …; }
const overridesEvent = constructOverrides(config);
await connection.sendMessage(overridesEvent);
return connection;
```

`startSession` awaits `create`, and `onConnect` is dispatched afterwards, so **`status ===
"connected"` cannot be observed before the dynamic variables have been sent.** The kickoff effect
that fires on `connected` is safe on WebRTC for the same structural reason it is safe on WebSocket.

### 3.5 A third source of truth, better than both

`HookCallbacks` includes **`onConversationMetadata`**, and `BaseConversation.handleMessage` dispatches
`conversation_initiation_metadata` on **either transport** (WebRTC receives it through
`RoomEvent.DataReceived`). Its payload, from `@elevenlabs/types`:

```ts
interface ConversationInitiationMetadataEvent {
  conversation_id: string;
  agent_output_audio_format: …;
  user_input_audio_format: …;
}
```

That is the **server's own id, in band** — the same value the WebSocket path treats as
authoritative. It is a strictly better tripwire than `onConnect`'s derived id, and it costs one
callback. D23 uses both.

> Unverified on WebRTC: the WebSocket connection *waits* for this event, the WebRTC one does not, so
> while the handler exists on both paths, nobody has confirmed the server emits it over the data
> channel. Treat a silent `onConversationMetadata` as "no cross-check available", never as an error.

---

## 4. Decisions

Numbering continues from S2 (which ended at D20). Settled 2026-08-13 unless noted.

### D21 — call the token endpoint with `fetch`, not the `elevenlabs-js` SDK ✅

The installed `@elevenlabs/elevenlabs-js@2.54.0` has a typed method,
`conversationalAi.conversations.getWebrtcToken({ agentId })`. **Do not use it.** Its Fern-generated
response model is:

```ts
export interface TokenResponseModel { token: string }     // dist/api/types/TokenResponseModel.d.ts
```

`conversation_id` is missing from the type. The parser runs with `unrecognizedObjectKeys:
"passthrough"`, so the field survives at runtime — meaning the one value this entire stage is built
on would reach us **untyped, through a hole in a validator, invisible to `tsc`**. A generated client
that drops the field could start stripping it in a patch release and nothing would fail to compile.

A plain `fetch` is four lines, matches what `/api/words-agent/signed-url` already does, and lets the
route assert `conversation_id` explicitly. The published API reference documents both fields as
required; the probe returned both; the SDK's type is simply stale.

### D22 — a response without `conversation_id` is a 502, never a fallback ✅

Same rule `appEnv` follows, for the same reason, and the build plan already words it: _a derived id
is worse than no session_. A session that starts with a made-up row key silently forks a learner's
history weeks before anyone notices; a session that refuses to start is a visible, immediate,
correctable failure.

### D23 — one id, two tripwires ✅

- **`conversationIdRef` is seeded from the token response, before `startSession`.** It is the row
  key. Nothing overwrites it — not `onConnect`, not `onConversationMetadata`.
- **`onConversationMetadata.conversation_id` is the primary cross-check** (§3.5): the server's own
  id, in band. A mismatch is a loud warning.
- **`onConnect`'s id is the secondary cross-check**: warn if it differs from the token id or fails
  `/^conv_/`. It is expected to agree (§3.1); the point is to notice the day it stops.

Both are warnings, never overwrites and never errors. If the SDK's derivation drifts, this is the
line in the log that says so.

### D24 — `persistTutorSession` takes the owner as a parameter ✅

The creation doc §3.2 says the v2 route is a "third thin caller". As written it cannot be: the
function resolves the owner itself, from a cookie.

```ts
// lib/tutor-session.ts
/** The owner-scoped core. No auth, no cache — both are the caller's business. */
export async function persistTutorSessionFor(ownerId: string, input: TutorSessionInput): Promise<boolean>

/** Cookie path (server action + the v1 beacon route). Resolves the owner, then revalidates. */
export async function persistTutorSession(input: TutorSessionInput): Promise<boolean> {
  const ownerId = await getOwnerId();
  if (!ownerId) return false;
  const ok = await persistTutorSessionFor(ownerId, input);
  if (ok) revalidatePath(`/lessons/${input.lessonId}`);
  return ok;
}
```

`revalidatePath` moves **out** of the core and into the cookie wrapper — creation doc §3.2's rule,
and the reason it is a rule: it is a Next data-cache concern for rendered pages, and the native
client refetches. Everything else the core does is unchanged and stays shared: `getLesson(ownerId,
…)` proving the lesson is the caller's, `sanitizeTranscript`, the 200/100-char clamps, the
`conversation_id`-keyed upsert.

**No `after()` fast path is needed here.** The level and enrichment jobs hang off the *word*-write
paths (creation doc §3.2); saving a transcript writes no words. The `after()` duplication becomes
real work at S5, not at S3.

### D25 — CORS: added on the v2 namespace, in the wrapper, never with credentials ✅

Requested for this stage. One fact first, because it decides where this can and cannot save us:

**A React Native `fetch` is not a browser and does not enforce CORS.** RN's networking layer sends no
`Origin` by default and applies no same-origin policy, so the iOS app would reach an origin-less
`/api/v2` route with no headers at all. CORS is therefore **not** what makes the phone work — S2's
Half B failing would never be a CORS symptom.

It is still worth having, for two reasons that are not speculative: `react-native-web` is in
`apps/mobile`'s dependency set and `expo start --web` renders the same screens in a real browser
(where every v2 call *would* be cross-origin and *would* preflight), and a browser-based probe of
the deployed API is the fastest way to debug the thing during S3 itself.

```ts
// lib/http.ts
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "authorization,content-type",
  "access-control-max-age": "86400",
} as const;

export function preflight(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}
```

`withBearer` merges `CORS` into every response it returns, including the 401 — a preflight-less
error with no CORS headers reads in a browser console as a network failure rather than as the 401 it
is. Each v2 route adds `export const OPTIONS = preflight;`, because a Next route handler with no
`OPTIONS` export answers 405 and the preflight fails before the real request is ever sent.

**`access-control-allow-credentials` is never set.** `/api/v2` authenticates with a Bearer token and
nothing else; the header would be meaningless there, is illegal beside `origin: *`, and is the one
line that could make the cookie-authenticated surface reachable cross-origin. `*` with no
credentials grants a third-party site exactly nothing it did not already have — it still needs a
token it cannot obtain.

### D26 — deploy = push `master`; the Vercel deployment is the phone's target ✅ **done**

Vercel builds from the GitHub push (deploy doc, 2026-06-28). `master` was two commits ahead;
**pushed 2026-08-14**, and the deployment now serves `/api/v2/me`.
`EXPO_PUBLIC_API_BASE_URL = https://eleven-labs-english-agent.vercel.app` — no trailing slash,
`src/env.ts` joins paths from `API_V2_ROUTES` directly.

This also disposes of S2 §6's ATS concern entirely: HTTPS on a real certificate, no
`NSAllowsLocalNetworking`, no tunnel URL to chase, no rebuild per session.

**The one consequence to hold on to: the phone's sessions will be `app_env: "prod"`** (§2.5), and
they will write to the same Supabase project the web dev server writes to — there is one database.
That is not new (dev and prod already share it) but S3 is the first time the distinction is *load
bearing*, because `app_env` is what the webhook routes on.

### D27 — one post-call webhook, set at the workspace level, with no per-agent overrides ✅ **done**

The fix for §3.3. The **workspace** default `post_call_webhook_id` points at the registration that
reaches the deployment, so every agent inherits it — words-1.2 and words-1.3 today, and every future
version `pnpm sync:agents` creates.

**At the workspace level rather than per agent**, deliberately: a per-agent override is invisible
from the prompt registry, so a new version would be provisioned with whatever default it inherits
and a mismatch would recur, silently, one version later.

**And the per-agent overrides are cleared, not tolerated.** An earlier draft of this decision said
to leave words-1.0 / words-1.1 on their `local-ngrok` override as harmless history. That was wrong:
it leaves two versions failing while two succeed — the hardest state to diagnose — and it defeats
the very inheritance this decision exists to establish. All four now carry
`post_call_webhook_id: null`. See §8.2c for the PATCH and the integrity check.

**Final target: `vercel-prod-new` (`26a48dac…`)**, not the original `vercel-prod` — see §8.2b for
why the first registration had to be replaced rather than reused.

With this in place the relay in `elevenlabs-webhook/route.ts` finally works as its comments
describe: Prod receives everything, handles `app_env: "prod"` itself, and forwards `app_env: "dev"`
to `ELEVENLABS_WEBHOOK_FORWARD_URL`. That variable is set on Vercel (47 d old) — confirm it points
where you want, or remove it; dev sessions are then acked and dropped, which is a legitimate choice
as long as it is a chosen one.

### D28 — mint the token at the moment of connect ✅

The token lives **900 seconds** (§2.1) and the conversation id is minted with it, not at connect
time. Two consequences:

- Fetch it in the "start session" handler, immediately before `startSession` — never at screen
  mount, never on lesson load. A learner who opens a lesson, reads the word list for a quarter of an
  hour and then taps _Start_ would otherwise get an expired token.
- **A fetched-but-unused token leaves an orphan conversation id.** It has no `lesson_sessions` row
  (nothing writes one until there is a transcript), so it costs nothing — but it means the id in the
  app's log is not proof a conversation happened.

### D29 — `GET /api/v2/agent-versions` returns `{ versions, defaultVersion }` ✅

`activeVersions()` already returns `{ version, agentId, label }` in canonical order. The route maps
`agentId` off and adds the default explicitly, because "newest active" is a **server-side** rule
(`all[all.length - 1]`) and a client that re-derived it from array order would be a second
implementation of `resolveAgent` living in a binary. The picker highlights `defaultVersion`; the
token route resolves version → agent id.

---

## 5. The server

### 5.1 `packages/shared/src/api.ts` — the additions

```ts
export const API_V2_ROUTES = {
  me: `${API_V2}/me`,
  agentVersions: `${API_V2}/agent-versions`,
  conversationToken: `${API_V2}/words-agent/token`,
  lessonSession: `${API_V2}/lessons/session`,
} as const;

/** `?version=` selects a tutor prompt version; omitted means "newest active" — the v2 twin of
 *  `signedUrlPath`, and deliberately the same grammar. */
export function conversationTokenPath(version?: string): string {
  return version
    ? `${API_V2_ROUTES.conversationToken}?version=${encodeURIComponent(version)}`
    : API_V2_ROUTES.conversationToken;
}

/** `POST /api/v2/words-agent/token` — 200. The WebRTC twin of `SignedUrlResponse`. */
export interface ConversationTokenResponse {
  /** Short-lived (900 s) LiveKit access token. The xi-api-key never leaves the server. */
  token: string;
  /**
   * The AUTHORITATIVE conversation id, minted with the token.
   *
   * This is the row key for `lesson_sessions`, and it is returned rather than read off the SDK
   * because the WebRTC transport DERIVES its id from the LiveKit room name and falls back to
   * `room_${Date.now()}` when that is empty — an id no other writer will ever produce.
   * See docs/2026-08-13-expo-s3-conversation-token.md §3.
   */
  conversationId: string;
  /** The version actually resolved (differs from the request when none was asked for). */
  version: string;
  /** Stamped as the `app_env` dynamic variable; the post-call webhook routes on it. */
  appEnv: string;
}

/** Narrow an already-parsed body. Requires BOTH ids: a response missing either is an error, never
 *  something to patch client-side (D22). */
export function isConversationTokenResponse(body: unknown): body is ConversationTokenResponse {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Partial<ConversationTokenResponse>;
  return (
    typeof b.token === "string" && b.token.length > 0 &&
    typeof b.conversationId === "string" && b.conversationId.length > 0 &&
    typeof b.appEnv === "string" && b.appEnv.length > 0
  );
}

/** One selectable tutor version. `agentId` is ABSENT on purpose — see §5.3. */
export interface AgentVersionSummary {
  version: string;
  label: string;
}

/** `GET /api/v2/agent-versions` — 200. */
export interface AgentVersionsResponse {
  versions: AgentVersionSummary[];
  /** The version used when the client asks for none. Server-side rule; never re-derived (D29). */
  defaultVersion: string;
}

export function isAgentVersionsResponse(body: unknown): body is AgentVersionsResponse {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Partial<AgentVersionsResponse>;
  return Array.isArray(b.versions) && typeof b.defaultVersion === "string";
}
```

`TutorSessionInput` and `LessonSessionResponse` already exist and are reused verbatim — the v2
session route posts the same body the beacon does.

### 5.2 `POST /api/v2/words-agent/token`

```ts
// apps/web/src/app/api/v2/words-agent/token/route.ts
import type { ConversationTokenResponse } from "@tutor/shared/api";
import { withBearer } from "../../../../../lib/auth/bearer";
import { resolveAgent } from "../../../../../lib/agent-registry";
import { elevenLabsConfig } from "../../../../../lib/config";
import { json, apiError, preflight } from "../../../../../lib/http";

export const dynamic = "force-dynamic";   // the lockfile may change between deploys
export const OPTIONS = preflight;         // D25 — without this a browser preflight 405s

export const POST = withBearer(async (req) => {
  const { apiKey, appEnv } = elevenLabsConfig();
  if (!apiKey) return apiError(500, "config", "ELEVENLABS_API_KEY is not set.");

  const requested = new URL(req.url).searchParams.get("version");
  const agent = resolveAgent(requested);
  if (!agent) {
    return apiError(requested ? 400 : 500, "config",
      requested ? `Unknown or inactive tutor version "${requested}".`
                : "No active tutor agents — run `pnpm sync:agents` to provision them.");
  }

  try {
    const res = await fetch(
      "https://api.elevenlabs.io/v1/convai/conversation/token" +
        `?agent_id=${encodeURIComponent(agent.agentId)}`,
      { headers: { "xi-api-key": apiKey } },
    );
    if (!res.ok) return apiError(502, "elevenlabs", `ElevenLabs returned HTTP ${res.status}`);

    // Read as unknown and assert both fields. The typed SDK method is NOT used here: its
    // TokenResponseModel declares `{ token }` only, so `conversation_id` would arrive untyped
    // through a passthrough validator. See D21.
    const data = (await res.json()) as { token?: string; conversation_id?: string };
    if (!data.token) return apiError(502, "elevenlabs", "ElevenLabs response had no token.");
    // D22 — a derived id is worse than no session.
    if (!data.conversation_id) {
      return apiError(502, "elevenlabs", "ElevenLabs response had no conversation_id.");
    }

    const body: ConversationTokenResponse = {
      token: data.token,
      conversationId: data.conversation_id,
      version: agent.version,
      appEnv,
    };
    return json(body);
  } catch (e) {
    return apiError(502, "elevenlabs", e instanceof Error ? e.message : String(e));
  }
});
```

**`POST`, and the version in the query string.** POST because the call mints a conversation — it is
not a cacheable read, and no proxy should ever treat it as one. The version rides in the query
string rather than a JSON body so the route shares `signedUrlPath`'s grammar and needs no body
parsing at all; `conversationTokenPath()` is the only place that grammar is written.

### 5.3 `GET /api/v2/agent-versions`

```ts
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

export const GET = withBearer(async () => {
  const active = activeVersions();
  if (active.length === 0) {
    return apiError(500, "config", "No active tutor agents — run `pnpm sync:agents`.");
  }
  // agentId is destructured off and dropped. That seam is the whole point: the app names a
  // VERSION, the server owns version → agent id, and retiring a version cannot brick a binary.
  const body: AgentVersionsResponse = {
    versions: active.map(({ version, label }) => ({ version, label: label ?? version })),
    defaultVersion: active[active.length - 1].version,
  };
  return json(body);
});
```

### 5.4 `POST /api/v2/lessons/session`

Thin, once D24's refactor is in:

```ts
export const OPTIONS = preflight;

export const POST = withBearer(async (req, ownerId) => {
  const body = (await req.json().catch(() => null)) as Partial<TutorSessionInput> | null;
  if (!body || typeof body.lessonId !== "string" || typeof body.conversationId !== "string") {
    return apiError(400, "bad_request", "lessonId and conversationId are required.");
  }
  const stored = await persistTutorSessionFor(ownerId, {
    lessonId: body.lessonId,
    conversationId: body.conversationId,
    agentVersion: typeof body.agentVersion === "string" ? body.agentVersion : "",
    lines: Array.isArray(body.lines) ? body.lines : [],
  });
  // false means "not your lesson" here — the owner is already proven by withBearer.
  if (!stored) return apiError(404, "not_found", "No such lesson.");
  const response: LessonSessionResponse = { ok: true };
  return json(response);
});
```

Note the status divergence from the v1 beacon route, and it is deliberate: there, `false` conflated
"not signed in" with "not your lesson" and 401 was the honest answer. Here authentication is already
proven by the wrapper, so the only remaining cause is a lesson that is not the caller's — **404, not
401**, or a phone with a valid token would show a login screen for a mistyped lesson id.

### 5.5 What is NOT built at S3

`GET /api/v2/lessons/:id` belongs to S4, and S3 does not need it: the stage's screen can hold a
hard-coded lesson id and a hard-coded word list. **Resist building the read routes here** — S3's
question is the conversation id, and every extra route is another thing that can fail the run for an
unrelated reason.

---

## 6. The app

### 6.1 The changes

| File                         | Change                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| `env.types.ts`               | **delete `agentId`** (S1's public-agent field); `apiBaseUrl` is now genuinely required                 |
| `app.config.ts`              | drop `EXPO_PUBLIC_AGENT_ID` from `ENV_VARS`; set `EXPO_PUBLIC_API_BASE_URL`                            |
| `src/api.ts` _(new)_         | one authenticated fetch helper: base URL + `Bearer` + `isApiError` narrowing                           |
| `src/app/index.tsx`          | the S1 probe screen keeps working — swap `agentId` for `conversationToken`                             |

### 6.2 The one authenticated fetch helper

Every v2 call from the device is the same four steps, and they belong in one place before there are
four call sites:

```ts
// apps/mobile/src/api.ts
export async function apiFetch<T>(
  path: string,
  getToken: () => Promise<string | null>,
  init?: RequestInit,
): Promise<T> {
  const token = await getToken();
  if (!token) throw new Error("Not signed in.");
  const res = await fetch(`${env.apiBaseUrl}${path}`, {
    ...init,
    headers: { ...init?.headers, authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || isApiError(body)) {
    throw new Error(isApiError(body) ? body.error.message : `HTTP ${res.status}`);
  }
  return body as T;
}
```

`getToken` is `getCredentials()` from `useAuth0` — **called per request, never cached in a module**,
because that is the call that renews silently (S2 §5). A token captured once at login is a session
that dies mid-lesson an hour later.

### 6.3 Starting a session

```ts
const body = await apiFetch<ConversationTokenResponse>(
  conversationTokenPath(version), getCredentials, { method: "POST" },
);
if (!isConversationTokenResponse(body)) throw new Error("Malformed token response.");

// M2 — seeded BEFORE startSession. This ref is the row key from here on.
conversationIdRef.current = body.conversationId;

startSession({
  conversationToken: body.token,
  connectionType: "webrtc",          // the only transport RN supports; websocket throws
  useWakeLock: false,
  dynamicVariables: {
    items_list: formatItemsList(items),
    lesson_id: lessonId,
    app_env: body.appEnv,            // required, never defaulted — the webhook routes on it
  },
});
```

and the two tripwires (D23):

```ts
onConversationMetadata: ({ conversation_id }) => {
  if (conversation_id !== conversationIdRef.current) {
    log("error", `metadata id ${conversation_id} ≠ token id ${conversationIdRef.current}`);
  }
},
onConnect: ({ conversationId }) => {
  if (conversationId !== conversationIdRef.current) {
    log("error", `onConnect id ${conversationId} ≠ token id ${conversationIdRef.current} (B3)`);
  }
  if (!/^conv_/.test(conversationId)) log("error", `derived id is not conv_* → "${conversationId}"`);
},
```

Neither writes `conversationIdRef`. The S1 screen already logs the `/^conv_/` check; this extends it
rather than replacing it, and S1 §12 explicitly owes this observation to S3 — **report it this
time**, green or red.

### 6.4 Saving the transcript

Collect lines from `onMessage` exactly as `LessonTutor` does, and on `onDisconnect` post
`TutorSessionInput` to `API_V2_ROUTES.lessonSession` with `conversationId:
conversationIdRef.current`. `sanitizeTranscript` runs **server-side** regardless; the client does not
need to trim (that was a `sendBeacon` payload-ceiling concern, and there is no beacon here — S1
proved the app is not being suspended out from under the session).

The per-conversation-id save guard (`savedForRef`) comes across from `LessonTutor` unchanged. It is
what stops a reconnect from re-posting the same transcript.

---

## 7. Environment and deployment

### 7.1 The values, and where each one lives

| Value                            | Where                                       | State as of 2026-08-14                                                                                  |
| -------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `EXPO_PUBLIC_API_BASE_URL`       | `apps/mobile/.env` **and** EAS env (3 envs) | ⬜ **still empty — set it first.** `https://eleven-labs-english-agent.vercel.app`, no trailing slash      |
| `EXPO_PUBLIC_AGENT_ID`           | both                                        | ⬜ to be **removed** by this stage                                                                       |
| `APP_ENV`                        | Vercel                                      | ✅ `prod` — verified via the deployed signed-url route (§2.5)                                            |
| `ELEVENLABS_WEBHOOK_SECRET`      | Vercel                                      | ✅ added 2026-08-14. Had never existed under this name — see §8.2a                                       |
| `ELEVENLABS_WEBHOOK_FORWARD_URL` | Vercel                                      | ✅ present (47 d) — confirm it is the ngrok URL you want, or remove it (D27)                             |
| `LANGSMITH_API_KEY`              | Vercel                                      | ✅ present (47 d) — the webhook 500s without it, **before persisting** (§8.2a)                           |
| `AUTH0_API_AUDIENCE`             | Vercel                                      | ✅ present, added 2026-08-14 (Production + Preview)                                                      |
| `AUTH0_DOMAIN` + the web set     | Vercel                                      | ✅ pre-existing — web login works                                                                        |

**Not needed on Vercel, checked:** `SUPABASE_DB_URL` / `DATABASE_URL` (migration CLI only),
`ELEVENLABS_TEACHER_VOICE_ID` (`sync-agents.ts`, a local script), `NEXT_PUBLIC_SUPABASE_ANON_KEY`
(only `user-client.ts`, which nothing imports — the RLS path is deliberately unshipped).
**Must stay unset:** `AUTH0_AUDIENCE` — `auth0.ts:12` reads it and would change the *web* login flow
(S2's rule). `AUTH0_API_AUDIENCE` is a different variable on purpose.

> **A 401 from curl proves less than it looks.** `getBearerOwnerId` fails **closed** when
> `AUTH0_API_AUDIENCE` is unset, so a server missing that variable answers 401 to *every* request —
> indistinguishable from the 401 a missing or garbage token earns. The deployment's green negative
> checks are compatible with the variable being absent. **Only a real device token distinguishes
> them**, which is exactly S2's Half-B "same `sub`" check (§11). If that 401s, look here first.

### 7.2 `appEnv` is required on the wire, defaulted on the server

`elevenLabsConfig()` reads `APP_ENV?.trim() || "prod"`. The contract's "required, never defaulted"
rule governs the **response** — the client must never invent one — but the server-side default is
worth naming: a deployment that forgets `APP_ENV` files its sessions under `prod` rather than
failing. It is set correctly today (§2.5); it is not protected by anything.

---

## 8. B3-M0 — the pre-gate, and the three defects it found ✅ **passed 2026-08-14**

The webhook had **never once written a row** to this database (§2.4). Not because of anything the
port does — because of three independent defects, each of which alone was enough, and none of which
is visible from inside the repository.

### 8.1 The three stacked causes

| # | Cause                                                                                                                          | Who it affected           |
| - | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| 1 | The workspace default post-call webhook was a **disabled** registration pointing at `/api/live-story/elevenlabs/otel-webhook`, a route that does not exist here | words-1.2, words-1.3 (the default version) |
| 2 | The deployment read `ELEVENLABS_WEBHOOK_SECRET`; Vercel held the value under **`ELEVENLABS_CONVAI_WEBHOOK_SECRET`** — 47 days of silent disagreement | everything, once routing was fixed |
| 3 | A webhook secret is **per registration**, not per workspace — so even the correctly-named variable held the wrong registration's secret | everything, once the name was fixed |

Plus a fourth that only surfaced after (1) was fixed: **repointing the workspace default does
nothing for an agent carrying its own override** (§8.2c).

### 8.2a Cause 2 — the name mismatch

An unsigned `POST` to the deployed webhook is a complete readiness probe, because the handler checks
config *before* signature:

```text
POST https://eleven-labs-english-agent.vercel.app/api/words-agent/elevenlabs-webhook
→ 500  {"error":{"code":"config","message":"ELEVENLABS_WEBHOOK_SECRET is not set."}}
```

`vercel env ls` then showed the value present for 47 days — under
**`ELEVENLABS_CONVAI_WEBHOOK_SECRET`**, while `lib/config.ts:18` reads
**`ELEVENLABS_WEBHOOK_SECRET`**. Nothing was missing; the two halves had simply never agreed.

> **The lesson worth keeping: probe the deployment, don't read the repo.** `.env`, `.env.example`
> and every code path agreed with each other and were all correct. The disagreement lived in a place
> none of them can see. One unsigned POST found it.

Note the ordering hazard the same probe exposes: the handler returns 500 for a missing
`LANGSMITH_API_KEY` **before it persists the session**, so on this deployment an absent tracing key
would silently cost the database row too. It is set; worth reordering one day, not S3's job.

**A Vercel environment change never reaches deployments already built — redeploy after setting one.**

### 8.2b Cause 3 — each registration signs with its own secret

The first real lesson after the name fix (2026-08-13 22:06 UTC) still failed:

```text
vercel-prod   most_recent_failure_error_code = 401 @ 22:06:24
```

The conversation itself was perfect on ElevenLabs' side — `status: done`, `call_duration_secs: 20`,
4 turns, a generated summary, and `dynamic_variables` carrying `lesson_id` and `app_env: "prod"`
exactly as designed. **Only the delivery was rejected.**

**A `wsec_…` value is shown once, at creation.** The listing endpoint exposes `auth_type: "hmac"`
and no secret field, so an unsaved secret is unrecoverable and the registration has to be replaced.
Resolved by creating **`vercel-prod-new`** (`26a48dac…`), capturing its secret at creation, and
putting that value in both `apps/web/.env` and Vercel's `ELEVENLABS_WEBHOOK_SECRET`.

**Verified with a forged-but-valid signature.** The handler acks-and-ignores any event type that is
not `post_call_transcription` *after* verifying the HMAC, so a signed `{"type":"post_call_audio"}`
exercises the whole auth path with **zero** database or LangSmith side effects. Build the header as
`t=<unix>,v0=<hex>` over `hmac-sha256(secret, "<t>.<rawBody>")` — the algorithm is
`dist/wrapper/webhooks.js` in `@elevenlabs/elevenlabs-js`:

| Probe                       | Result                                            |
| --------------------------- | ------------------------------------------------- |
| correctly signed            | **200** `{"ok":true,"ignored":"post_call_audio"}` |
| signed with a wrong secret  | **401** `bad_signature`                           |
| unsigned                    | **401** `unsigned`                                |

Keep this probe. It is the fastest way to answer "is the webhook wired?" without running a lesson —
but note it verifies *by construction* against whatever secret the server holds, so it proves the
plumbing, not that ElevenLabs signs with the same value. Only a real delivery proves that.

⚠️ `retry_enabled: false` on every registration, so the rejected 22:06 event is **permanently
lost** — there is no redelivery. Worth enabling on `vercel-prod-new`.

### 8.2c Cause 4 — the per-agent overrides had to be cleared

Repointing the workspace default does nothing for an agent with its own override: words-1.0 and
words-1.1 still pointed at `local-ngrok` and would have kept failing while the newer versions
succeeded — the most confusing possible state to debug.

Cleared with a surgical nested PATCH per agent, sending **only** the one field:

```jsonc
PATCH /v1/convai/agents/{agent_id}
{ "platform_settings": { "workspace_overrides": { "webhooks": { "post_call_webhook_id": null } } } }
```

`null` means "inherit the workspace default". Verified afterwards that `auth.enable_auth`,
`max_duration_seconds` and the overrides allowlist were unchanged on all four (§2.2) — a PATCH that
silently reset a sibling field would have been a much worse bug than the one being fixed.

**All four versions now resolve to `vercel-prod-new`**, and any future version created by
`pnpm sync:agents` inherits it too — the property D27 wanted, which per-agent overrides had quietly
been defeating.

### 8.2d The workspace webhook settings, as left

```jsonc
// PATCH /v1/convai/settings
{ "webhooks": { "post_call_webhook_id": "26a48dac…",   // vercel-prod-new
                "events": ["transcript"],
                "transcript_format": "json",
                "send_audio": false } }
```

**`send_audio: false` is not cosmetic.** Audio arrives as a separate large event our handler acks and
ignores, and Vercel caps a serverless request body at 4.5 MB — a long conversation's audio would
fail delivery, and repeated failures are how ElevenLabs auto-disables a webhook
(`is_auto_disabled`). Enabling it would risk taking the transcript event down with it.

### 8.3 The pass — rows written 2026-08-13 22:14–22:17 **UTC**

_(The fixes above and this run were one working session on 2026-08-14 local time; every timestamp
quoted in §8 is UTC, where the clock still read 2026-08-13.)_

Four browser lessons on words-1.3 against the deployment, and the database moved for the first time:

```text
total rows 14 → 18   |   webhook-enriched 0 → 4
vercel-prod-new: most_recent_failure_error_code = none
```

| Check                                                   | Result                            |
| ------------------------------------------------------- | --------------------------------- |
| rows created                                            | **4** for 4 sessions — no forking |
| every `conversation_id` matches `conv_[A-Za-z0-9]+`     | **yes**                           |
| any `room_<digits>` placeholder                         | **none**                          |
| unique conversation ids                                 | **4**                             |
| rows carrying **both** a transcript and `duration_secs` | **4 of 4**                        |
| `summary` present                                       | 4 of 4                            |

**The post-call webhook now delivers, verifies and writes.** Every prerequisite B3-M4 rests on is
demonstrated.

> **What is still untested, and it is the whole point of S3.** On WebSocket the client's id comes
> from the server, so convergence was structurally guaranteed — these four rows prove the *webhook
> half* works, not that a *derived* id would converge. That is exactly what B3-M4 tests on WebRTC,
> and it is now the only unproven link left.

### 8.4 Cleanup available (none of it blocking)

- `ELEVENLABS_CONVAI_WEBHOOK_SECRET` on Vercel (47 d, read by nothing) — deletable.
- `vercel-prod` (`4449bf45…`) and the ConvAI `local-ngrok` (`bdabca8f…`) registrations — now unused
  by any agent; deletable once nothing else references them.
- **Enable `retry_enabled`** on `vercel-prod-new`. It is `false`, and §8.2b already cost one event.
- Rotate the webhook secret if it has been exposed anywhere it should not be — cheap now that
  `POST /v1/workspace/webhooks` is known to return `webhook_secret` in its response.

---

## 9. Gate — B3-M4

### 9.1 The criteria — ✅ all met 2026-08-14

- [x] **Pre-gate B3-M0 (§8): a browser session on the deployment produces a `lesson_sessions` row
      carrying `duration_secs`.** ✅ 4 of 4.
- [x] One native session, end to end: token route → WebRTC → spoken turns → transcript saved.
      **Two** were run (12:51 and 12:57 UTC), 47 s and 73 s.
- [x] In the database: the row the client wrote and the row the webhook upserts are **the same
      row** — 2 sessions → **2 rows**, 2 unique ids, no duplicates.
- [x] That row's `conversation_id` equals the id the **token route** returned — and ElevenLabs'
      own `system__conversation_id` reports the same value, so all three agree.
- [x] Both rows carry `duration_secs` (73 / 47, webhook-written) **and** the client's transcript
      lines (5 / 4). `vercel-prod-new` recorded **no** delivery failure.
- [x] No `B3:` mismatch was logged by either tripwire, and no `room_<digits>` placeholder reached
      the database — the observation S1 owed S3, finally reported.

### 9.2 The query

```ts
// node --env-file=apps/web/.env --input-type=module
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data } = await sb.from("lesson_sessions")
  .select("conversation_id, agent_version, summary, duration_secs, transcript, created_at")
  .eq("lesson_id", "<the lesson>")
  .order("created_at", { ascending: false }).limit(5);
console.log(data.map(r => ({
  conv: r.conversation_id, ver: r.agent_version,
  lines: r.transcript?.length ?? 0, dur: r.duration_secs, sum: r.summary ? "yes" : null,
})));
```

`summary` is reported but **not gated on** — `transcript_summary` depends on post-call analysis and
can legitimately be null. `duration_secs` comes from `metadata.call_duration_secs` and is always
present when the webhook handled the event. It is the reliable "the webhook wrote this row" marker.

Worth also checking `most_recent_failure_error_code` on `vercel-prod-new` after the run: `none`
means the delivery was accepted, and it distinguishes "the webhook never fired" from "the webhook
fired and we rejected it" in one field.

### 9.3 What a fork looks like, exactly

Two rows, seconds apart, same `lesson_id`:

| Row              | `conversation_id`                          | `transcript` | `duration_secs` |
| ---------------- | ------------------------------------------ | ------------ | --------------- |
| client's         | **`room_1786650245123`** — 13-digit ms     | the lines    | null            |
| webhook's        | `conv_…`                                   | the lines    | a number        |

That is the **only** fork signature that can occur, and §3.1 is why: if `room.name` was populated,
the derived id is the right one; if it was empty, the placeholder is a literal `room_<Date.now()>`.
A `conversation_id` beginning `room_` and continuing with digits is unambiguous. (A raw room name —
`room_agent_…_conv_…` — would mean the regex itself failed, which would be a genuine SDK change
worth reporting upstream.)

**And the failure that is not a fork.** If `app_env` routing is wrong, there is no second row: the
webhook handler sees an env that is not its own, relays or acks, and never writes. The symptom is
**one row with a transcript and a null `duration_secs`** — which is exactly what §2.4 looked like,
and exactly why §8 had to be green first.

---

## 10. If it fails

| Symptom                                                       | Cause                                                                                                                     |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Every v2 route 401s with a token that decodes perfectly       | `AUTH0_API_AUDIENCE` missing **on Vercel** — `getBearerOwnerId` fails closed (§7.1). Or S2's D19 `useDPoP: false` regressed. |
| `/api/v2/*` returns 404                                       | The deploy is behind `master`. Push (D26).                                                                                 |
| Token route 502 "had no conversation_id"                      | D22 doing its job. Do not add a fallback — check the API response shape first.                                             |
| Token route 400 "Unknown or inactive tutor version"           | The app sent a version the lockfile does not have active. `pnpm sync:agents`, commit the lockfile, redeploy.               |
| Session starts, then errors immediately                       | Denied microphone (S1 / creation doc §4 — the SDK prompts, there is no pre-flight), or a token older than 900 s (D28).     |
| One row, transcript present, `duration_secs` null             | The webhook did not handle it. Check `most_recent_failure_error_code` on `vercel-prod-new` first (§9.2). **Not** a B3 failure. |
| Webhook 401 `bad_signature` on a real delivery                | The deployment's secret is not the one that registration signs with (§8.2b). Recreate the registration and capture the secret. |
| Webhook 500 `… is not set`                                    | An env var missing on Vercel — and **redeploy** after adding it, since existing deployments keep their old snapshot (§8.2a). |
| Two rows, one keyed `room_<digits>`                           | The genuine B3 fork — `room.name` was empty and M2's seeding was not in effect. Check `conversationIdRef` is set BEFORE `startSession`. |
| Preflight fails in a browser (Expo web); iOS unaffected       | Missing `export const OPTIONS = preflight` on that route (D25).                                                            |
| Dynamic variables absent from the webhook payload             | Would contradict §2.2 and §3.4. Check `dynamicVariables` is on the `startSession` options object, not nested.              |

---

## 11. Owed from S2 — run these first

S2's Half B was deferred here because it needs a reachable server, which S3 now has. Run them
against the deployment **before** writing any S3 code — they isolate the Bearer path from
ElevenLabs:

- [ ] `GET /api/v2/me` with a device token returns the **same `sub`** the web app shows — **the only
      one of these that can distinguish a working `AUTH0_API_AUDIENCE` from a missing one** (§7.1)
- [x] `GET /api/v2/me` with **no** token → 401 in the `ApiErrorBody` envelope _(curl, 2026-08-14)_
- [x] `GET /api/v2/me` with a **garbage** token → 401 _(curl, 2026-08-14)_ — the negative check that
      catches a wrapper treating `null` as "anonymous but allowed"
- [ ] Web login verified unchanged after the deploy
- [ ] Auth0 API token lifetime restored to 86400 if it was lowered for S2's renewal check (D17)

---

## 12. The build checklist

Everything before the code is done. Start here:

1. **Set `EXPO_PUBLIC_API_BASE_URL`** in `apps/mobile/.env` **and** the three EAS environments
   (§7.1) — it is still empty, and `src/env.ts` throws on first use rather than defaulting.
2. **Run §11** — S2's Half B from the device. Three checks, no S3 code involved.
3. **Build the server**: `api.ts` declarations (§5.1) → the token route (§5.2) → agent-versions
   (§5.3) → D24's `persistTutorSessionFor` refactor + the session route (§5.4) → the CORS helper
   (D25). Push; Vercel deploys.
4. **Build the app** (§6): delete `agentId`, add `src/api.ts`, swap the S1 screen's `agentId` for
   `conversationToken`, seed `conversationIdRef` before `startSession`, wire both tripwires.
5. **Re-read `WebRTCConnection.js`** in `apps/mobile/node_modules/@elevenlabs/client` if the SDK has
   been bumped since 2026-08-13 (verified at **1.17.0**; `@elevenlabs/react-native` **1.2.18**).
   §3.1's analysis depends on the room-name format and the regex, both of which are theirs to change.
6. **Run the gate** (§9), fill in "What S3 hands to S4", flip the build plan's Progress row.
7. **This is the 🚩 gate stage.** Record the explicit go/no-go in the build plan afterwards.

---

## 13. Is S3 ready to build?

**Yes.** Every question the placeholder raised is answered, every decision it needed is taken
(D21–D29), the routes and the app changes are written out, and the one defect that would have
produced a false red gate has been found, fixed and demonstrated green.

**What is proven:** the token endpoint returns `conversation_id`; the room-name format and therefore
the exact fork signature; overrides land before the kickoff; the webhook delivers, verifies and
writes to the same row as the client; the deployment is live and serving `/api/v2`; every Vercel
variable the stage needs is present.

**What is assumed and will be tested by building:** that a *derived* WebRTC id converges (B3-M4's
whole point); that `onConversationMetadata` fires on WebRTC (§3.5 — degrade gracefully if not); that
`AUTH0_API_AUDIENCE` on Vercel actually works, which only a device token can show (§11).

**The two things to do before the first line of code:** set `EXPO_PUBLIC_API_BASE_URL` (§12.1) and
run S2's Half B (§11). Both are minutes, and both isolate a failure that would otherwise be
discovered tangled up with WebRTC.

---

## 14. Result — B3 is answered, and what S3 hands to S4

**Run 2026-08-14. Two native sessions from the phone**, both proved native by ElevenLabs' own
`system__channel: "react_native_sdk"` — not a browser wearing a different user agent:

| conversation                        | duration | client lines | `duration_secs` | summary |
| ----------------------------------- | -------- | ------------ | --------------- | ------- |
| `conv_2501m00585j6f5k9vtfszds6gpxg` | 47 s     | 4            | 47              | yes     |
| `conv_8401m005hrjgeyvr8cv19bdbd08p` | 73 s     | 5            | 73              | yes     |

Fork check on the same window: **2 rows for 2 sessions**, 2 unique ids, every id matching
`conv_[A-Za-z0-9]+`, **no `room_<digits>` placeholder anywhere**, and **2 of 2** carrying both a
client transcript and webhook-written `duration_secs`.

**The three ids agree.** The token route's `conversation_id`, the row key, and ElevenLabs'
`system__conversation_id` are the same string. That is B3 closed: the WebRTC transport's derived id
was never given the chance to matter, exactly as M1–M3 intended.

**Dynamic variables crossed the transport intact** — `app_env: "prod"`, the real `lesson_id`, and an
`items_list` whose first line is `1. incentive`, i.e. `formatItemsList` output arriving unchanged.
Creation doc §9 B3's claim that `constructOverrides` makes the two transports identical is now
observed rather than inferred.

### What S3 hands to S4

- [x] **`/api/v2` is a real namespace with four routes**, all behind `withBearer`, all with CORS and
      an `OPTIONS` export. S4 adds `GET /api/v2/lessons/:id` to a pattern that exists.
- [x] **The token route is the session's entry point.** S4's tutor screen calls
      `conversationTokenPath(version)` and gets `{ token, conversationId, version, appEnv }`; the
      agent id never reaches the app, so `pnpm sync:agents` stays free to retire versions.
- [x] **`conversationIdRef` seeded before `startSession` is the pattern to keep.** Do not let S4's
      richer state machine reintroduce an `onConnect`-written id.
- [x] **`persistTutorSessionFor(ownerId, input)`** exists and is the seam every future v2 write
      follows: auth in the wrapper, cache invalidation only on the cookie path.
- [x] **`apps/mobile/src/api.ts`** is the one authenticated fetch; `getCredentials` is passed per
      call, never cached, which is what keeps silent renewal working mid-lesson.
- [x] **The post-call webhook works and is inherited by every future agent version** (§8 · D27) —
      workspace-level, no per-agent overrides.
- [ ] ⚠️ **`onConversationMetadata` on WebRTC is still unobserved.** No mismatch was logged, but no
      `metadata id` line has been confirmed either. Treat it as an optional cross-check, never as a
      required signal.
- [ ] ⚠️ **The lesson is hard-coded** (`LESSON_ID`, three literal items in `index.tsx`). S4's first
      job is `GET /api/v2/lessons/:id`; delete both when it lands.
- [ ] ⚠️ **`sendContextualUpdate` is still unexercised** — the resume flow is the one piece of the
      tutor whose transport genuinely changed (a LiveKit data channel rather than the socket).
      Creation doc §4 flags it for S4; nothing in S3 touched it.

---

## Sources

- **Probed live on 2026-08-13** against the project's own ElevenLabs account and Supabase project:
  `GET /v1/convai/conversation/token` (§2.1), `GET /v1/convai/agents/{id}` × 4 (§2.2),
  `GET /v1/workspace/webhooks?include_usages=true` and `GET /v1/convai/settings` (§2.3),
  `lesson_sessions` counts (§2.4), and the deployed `/api/health` + `/api/words-agent/signed-url`
  (§2.5).
- **Changed live on 2026-08-14**, all recorded in §8: `PATCH /v1/convai/settings` (workspace
  post-call webhook → `vercel-prod-new`, `send_audio: false`); `PATCH /v1/convai/agents/{id}` × 2
  (cleared per-agent overrides); `vercel env add ELEVENLABS_WEBHOOK_SECRET production --sensitive`
  + redeploy; signed/unsigned webhook probes; `lesson_sessions` re-query.
- **Read from installed package source on 2026-08-13:** `@elevenlabs/client@1.17.0`
  (`dist/utils/WebRTCConnection.js` — the derivation and the `create` ordering;
  `dist/utils/overrides.js`; `dist/utils/BaseConnection.d.ts` — the config union;
  `dist/BaseConversation.js` — `conversation_initiation_metadata` dispatch),
  `@elevenlabs/types` (`ConversationInitiationMetadataEvent`), `@elevenlabs/react@1.12.0`
  (`useConversation`, `HookCallbacks`), `@elevenlabs/react-native@1.2.18`
  (`index.react-native.ts` — the WebSocket throw), and `@elevenlabs/elevenlabs-js@2.54.0`
  (`TokenResponseModel` — D21; `dist/wrapper/webhooks.js` — the HMAC algorithm used in §8.2b).
- [ElevenLabs — Get conversation token (WebRTC)](https://elevenlabs.io/docs/eleven-agents/api-reference/conversations/get-webrtc-token)
  — `{ token, conversation_id }`, both required.
- In-repo: `packages/shared/src/api.ts` · `apps/web/src/lib/auth/bearer.ts`, `lib/http.ts`,
  `lib/config.ts`, `lib/agent-registry.ts`, `lib/tutor-session.ts`, `lib/lessons.ts`
  (`upsertLessonSession`) · `src/app/api/words-agent/signed-url/route.ts` and
  `elevenlabs-webhook/route.ts` · `src/app/lessons/[id]/LessonTutor.tsx` · `src/proxy.ts` ·
  `supabase/migrations/0002_lessons.sql` (the `conversation_id` unique key) ·
  `apps/mobile/app.config.ts`, `env.types.ts`, `src/env.ts`, `src/app/index.tsx`.
- Prior stages: [creation doc](./2026-08-12-expo-app-creation.md) §2, §3.3–3.5, §9 B3 ·
  [build plan](./2026-08-12-expo-build-plan.md) S3 and the 🚩 gate ·
  [S1](./2026-08-13-expo-s1-background-audio.md) §12 (the `conv_*` observation it owes S3) ·
  [S2](./2026-08-13-expo-s2-auth0-bearer.md) §7, §10, §11 ·
  [deploy options](./2026-06-28-deploy-options.md) (Vercel via GitHub push) ·
  [observability](./2026-06-28-langsmith-tracing-observability.md) (the webhook bridge §8 restores).
