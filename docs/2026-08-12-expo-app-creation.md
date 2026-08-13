# Expo app — full native port

**Date:** 2026-08-12 · **Status:** research. Nothing implemented. **Ready to start at S0.** The three
hard blockers are researched (§9) and become the first three stages of the build (§8) — one app,
proven one risk at a time.

**The decision:** `apps/mobile` as a full native Expo app, **iOS only**. Every screen in React Native,
the ElevenLabs tutor rebuilt on the native SDK, and a **`/api/v2/*` endpoint surface** built
alongside the web app's existing routes. No WebView. The web app is not modified.

**Why native at all:** a browser tab cannot hold a voice session when the phone locks — iOS revokes
the microphone, interrupts the audio graph and drops the socket the moment Safari leaves the
foreground. A language tutor you must stare at is a worse product than one you can talk to with the
screen off. Everything below follows from that one sentence.

`docs/2026-08-09-expo-repo-structure-migration.md` decided where the code lives and **is done** — the
pnpm workspace, `packages/shared`, and the React pin all exist today. This note is the app itself.

### Decisions taken

| #   | Decision                                                       | Consequence                                                                       |
| --- | -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| D1  | **Offline is not required at v1**                              | the SQLite mirror ships later; v1 reads and writes over HTTP (§5)                 |
| D2  | **iOS only**                                                   | no Android permissions, no Core-Telecom, one device matrix                        |
| D4  | **The web app stays as is**                                    | native-only endpoints are added under `/api/v2/*`; no existing route changes (§3) |
| D5  | **Distribution is handled**, EAS/Expo Cloud assumed configured | not a work item below                                                             |
| D3  | Component strategy — **still open**                            | see §9                                                                            |

---

## 1. What we are not building

Deleting these is not a scope cut — each is a workaround for a browser constraint that does not exist
natively, or a web artifact with no native meaning. Porting them would forfeit the point of the
project.

| Dropped                                                | Why                                                                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `useKeepAwake` + `@zakj/no-sleep`                      | `expo-keep-awake` is one line; under background audio the screen may lock anyway                                   |
| `useAudioHealth` (volume polling)                      | iOS delivers a real `AVAudioSession` interruption event — handle it, stop inferring                                |
| `HIDE_GRACE_MS` visibility dance                       | backgrounding is no longer fatal, so there is nothing to detect                                                    |
| `pagehide` / `freeze` beacons                          | the app is not about to be discarded mid-sentence                                                                  |
| `"background"` pause card + copy                       | the failure it apologises for cannot happen                                                                        |
| `navigator.mediaDevices.getUserMedia` pre-flight       | see §4 — the SDK's audio session triggers the prompt                                                               |
| `/offline` route, `sw.js`, `manifest.ts`, `pwa/[icon]` | PWA machinery; a binary has none                                                                                   |
| `lib/asset-version.ts`                                 | service-worker cache busting                                                                                       |
| `lib/format-date.ts`                                   | pins timezone/locale so SSR and hydration match — RN has neither, and the user's real locale is the correct answer |
| `/demo` route                                          | integration smoke test; no reason to ship it                                                                       |
| `/` route                                              | a redirect                                                                                                         |
| `lib/supabase/user-client.ts`                          | _would_ run natively — deliberately not shipped, see §3.5                                                          |
| Signed-URL / WebSocket tutor path                      | impossible on RN, see §2                                                                                           |
| Dexie mirror + outbox (**at v1**)                      | D1 — deferred, not cancelled (§5)                                                                                  |
| Android permissions / Core-Telecom                     | D2                                                                                                                 |

That is roughly half of `LessonTutor.tsx`'s 504 lines gone, plus four files and three routes.

**Kept, repointed:** the session journal. Its job changes from "iOS is about to discard this tab" to
ordinary crash/kill insurance, which is still real on a phone. Without the mirror at v1 it becomes a
small `expo-sqlite` (or `AsyncStorage`) table of its own. The `"audio"` and `"recovered"` pause
reasons survive; `"background"` does not.

---

## 2. The tutor cannot reuse the signed URL

The web tutor starts a session with `signedUrl` + `connectionType: "websocket"`. **On React Native
that throws.** From the SDK source (`packages/react-native/src/index.react-native.ts`):

```ts
if (options.connectionType === "websocket" || options.signedUrl) {
  throw new Error(
    "WebSocket connections are not supported on React Native. " +
      "Only WebRTC connections are available. …",
  );
}
```

Structural, not a gap someone will close: the WebSocket path needs `AudioContext` and
`AudioWorkletNode`, which RN does not have. The two auth modes are mutually exclusive at the type
level (`packages/client/src/utils/BaseConnection.ts`): `signedUrl`+`websocket` versus
`conversationToken`+`webrtc`.

So `/api/words-agent/signed-url` (which calls `/v1/convai/conversation/get-signed-url`) needs a v2
sibling calling `/v1/convai/conversation/token`, returning `{ token, conversation_id }`. Under D4 the
existing route is left alone.

**Do not send `agentId` from the app instead.** That is the _public_-agent path; it works only if the
agent is public, and it would compile agent ids into a binary — so a `pnpm sync:agents` that retires a
version would break every installed copy until the next review cycle. The API key stays server-side.

---

## 3. The server work — `/api/v2/*`

**a full native port is mostly a server project.** Every screen in the web app is a React Server
Component querying Postgres directly, and every mutation is a Server Action — Next's private RPC over
an unstable wire format. A native client can use neither. The web app has almost no API, and we build
one beside it.

### 3.1 Why a `/v2` namespace (D4)

Everything native needs lives under `/api/v2/*`. Nothing under `/api/*` is touched — not the beacon
route, not the signed-URL route, not the webhook.

This is worth more than tidiness. It means **the Bearer-token code path never runs for the web app**:
v2 routes authenticate with their own helper, and `getOwnerId()` keeps its current cookie-only
behaviour. There is no shared auth branch to regress, so "keep the web app as is" is enforced
structurally rather than by care.

```ts
// apps/web/src/lib/auth/bearer.ts — v2 only
export async function getBearerOwnerId(req: Request): Promise<string | null>;
```

`/api/v2/lessons/session` therefore duplicates the _route_, not the _logic_ — it is a third thin
caller of `persistTutorSession` alongside the Server Action and the existing beacon route.

### 3.2 The pattern — the repo already demonstrates it

Do **not** move logic out of Server Actions into routes. Do what `persistTutorSession` already does:
the validation + write live in a `lib/` function, and both the Server Action and the HTTP route are
thin callers of it. `saveLessonSessionAction` and `/api/lessons/session` are already exactly this.

Two carry-over details: `revalidatePath` stays in the web-side caller only (a Next cache concern; the
native client refetches), and the `after()` fast paths for the level and enrichment jobs **must** be
duplicated into the v2 handlers — `after()` works there, and dropping it means words added from the
phone wait for the next `pnpm level:items` sweep instead of being levelled in seconds.

### 3.3 Routes

Reads, replacing server-component queries:

| Route                          | Backed by                                                    | Returns                                  |
| ------------------------------ | ------------------------------------------------------------ | ---------------------------------------- |
| `GET /api/v2/lessons`          | `listLessons`                                                | `LessonListItem[]`                       |
| `GET /api/v2/lessons/:id`      | `getLesson` + `listLessonSessions` + `listLessonItemHistory` | `LessonDetail`, sessions, item history   |
| `GET /api/v2/lesson-items?…`   | `listItems` + `listItemFacets`                               | `ItemRow[]`, `ItemFacet[]`               |
| `GET /api/v2/lesson-items/:id` | `getItem`                                                    | `ItemDetail`                             |
| `GET /api/v2/agent-versions`   | `activeVersions()`                                           | version + label — **`agentId` stripped** |

Writes:

| Route                                | Backed by                                                    |
| ------------------------------------ | ------------------------------------------------------------ |
| `POST /api/v2/words-agent/token`     | new — WebRTC conversation token (§2)                         |
| `POST /api/v2/sync/flush`            | `flushOutbox`'s `applyOp` — all lesson/item mutations        |
| `POST /api/v2/lesson-items`          | `addWord` (returns `AddWordResult`, incl. `already-present`) |
| `POST /api/v2/lesson-items/favorite` | `setItemFavorite`                                            |
| `POST /api/v2/lessons/session`       | `persistTutorSession`                                        |

Three things to get right:

- **`/api/v2/agent-versions` must not return `agentId`.** The app picks a _version string_; the token
  route resolves version → agent id server-side via `resolveAgent`. That seam is what lets
  `pnpm sync:agents` retire a version without breaking installed binaries.
- **`GET /api/v2/lesson-items` reuses the existing URL grammar.** `serializeItemsQuery` /
  `parseItemsQuery` already own both directions plus the whitelists that keep arbitrary strings out
  of PostgREST, and `pnpm check:shared` verifies the round-trip exhaustively. Do not invent a second
  query format. Note `?q=` free-text is deliberately _not_ in `ItemsQuery` — it is `searchItems`, in
  memory, client-side.
- **Keep `/api/v2/sync/flush` even though v1 is online-only.** This is the one place D1 should not
  simplify the design. The native app sends **single-op batches** — one `createLesson`, one
  `addItems`, one `removeItem`, one `deleteLesson` — through the op algebra that already exists and
  is already property-checked. Adding offline later then becomes a purely client-side change: queue
  the ops in SQLite instead of posting them immediately, and the server never learns the difference.
  Four bespoke REST mutations now would have to be thrown away to get there.

### 3.4 Declaring it in `packages/shared/src/api.ts`

Every route gets its path in `API_ROUTES`, its body as an exported interface, and a guard where the
client narrows. Routes assign their body to the declared type before returning, so a drifted field is
a typecheck failure rather than a runtime `undefined` on a shipped device. With a second client that
stops being tidiness and becomes the thing keeping a phone in the App Store working.

```ts
export const API_V2 = "/api/v2";

export interface ConversationTokenResponse {
  token: string;
  conversationId: string; // see B3 — the authoritative id, do not derive it client-side
  version: string;
  appEnv: string; // required, never defaulted
}
```

`appEnv` stays required for the same reason as today: it becomes the `app_env` dynamic variable the
post-call webhook routes on, so a missing one must error rather than file a dev session under prod.

Everything else these routes return is _already_ a shared DTO — `LessonListItem`, `LessonDetail`,
`LessonItem`, `LessonSession`, `ItemRow`, `ItemDetail`, `ItemFacet`, `WordDetails`, `OutboxRecord`,
`FlushResult`. No new shapes to design, only new envelopes to declare.

### 3.5 What stays server-only, permanently

Supabase queries, the LangChain/Anthropic calls, the level and enrichment jobs, the `resolve_words`
RPC (`norm_key` needs Postgres unaccent + NFKC, so text → word id is never a client-side guess), the
ElevenLabs API key, and `agent-registry.ts`. `lib/supabase/user-client.ts` _would_ run in RN and could
query Postgres directly under RLS — deliberately not shipped, because the standing convention is
"ownership is enforced in code, RLS is defense-in-depth", and moving the enforcing code into a binary
you cannot hot-fix makes RLS your only line of defence.

---

## 4. The native tutor

**Ports unchanged.** The RN package re-exports `ConversationProvider` and every hook from
`@elevenlabs/react` with an identical API (verified in `packages/react-native/src/index.ts`), so
`onConnect`, `onMessage`, `onDisconnect`, `onError`, `dynamicVariables`, `sendUserMessage`,
`sendContextualUpdate` and `sendUserActivity` behave as they do on web. Everything the tutor imports
from `@tutor/shared/tutor` is used as-is: `KICKOFF_MESSAGE`, `RESUME_MESSAGE`,
`HIDDEN_KICKOFF_MESSAGES`, `formatItemsList`, `formatResumeContext`, `sanitizeTranscript`. The
proactive-kickoff effect, the hidden-message filter, the per-conversation-id save guard, the carried
transcript and the resume-context flow are pure state machines over that API — they move across with
only their JSX rewritten.

**Changes:**

```ts
startSession({
  conversationToken: body.token, // ← the v2 token route
  connectionType: "webrtc",
  dynamicVariables: { items_list, lesson_id, app_env }, // identical wire format — see B3
});
```

- **No mic pre-flight.** The SDK calls `AudioSession.configureAudio()` + `startAudioSession()` itself,
  and that triggers the OS prompt. The official Expo example ships **no explicit permission request** —
  just `NSMicrophoneUsageDescription`. A denial therefore surfaces as a session error rather than up
  front, so the error copy must name that case.
- **Take `conversationId` from the token response, not from the SDK.** This is the B3 finding and it
  is load-bearing — see §9.
- **Confirm `sendContextualUpdate` at S4.** The resume flow depends on it, and on WebRTC it travels
  over a LiveKit data channel rather than the socket. The same `connection.sendMessage` path carries
  the overrides event, so it is expected to work — but the resume flow is the one piece of the tutor
  whose transport genuinely changed, so exercise it deliberately rather than assuming.

The RN SDK also offers split hooks (`useConversationControls`, `useConversationStatus`,
`useConversationMode`, `useConversationInput`). The combined `useConversation` keeps the port closest
to existing code; the split hooks are a rendering optimisation worth taking later, since today every
transcript line re-renders the whole screen.

---

## 5. The offline mirror — deferred (D1)

**Not in v1.** v1 screens read from `/api/v2/*` and write through `/api/v2/sync/flush` with single-op
batches. That removes ~1 week from the critical path and drops the one genuinely novel design problem
(SQLite change notification) out of the first release.

This is a deferral, not a cancellation, and §3.3's advice is what keeps it cheap. When offline lands:

| File                         | LOC | Native                                         |
| ---------------------------- | --- | ---------------------------------------------- |
| `lib/sync/db.ts`             | 56  | rewritten — `expo-sqlite`                      |
| `lib/sync/dexie-store.ts`    | 85  | rewritten — `sqlite-store.ts`                  |
| `lib/sync/live.ts` (3 hooks) | 53  | rewritten — no portable equivalent             |
| `lib/sync/engine.ts`         | 182 | **mostly free** — already behind `MirrorStore` |
| `lib/sync/mirror.ts`         | 97  | **free** — pure `MirrorStore` calls            |

Two invariants to preserve when that day comes: **a mirror write and its outbox record go in the same
`transact`** (what makes it impossible for the UI to show a change whose intent was never queued), and
**`listOutbox` is `seq` ascending, which _is_ the replay order** (`listLessons` is `created_at` desc,
`listItems` is `position` asc). The one genuinely new design is reactivity — Dexie's `liveQuery` rides
IndexedDB's own mutation events and SQLite has no equivalent, so the three hooks need a store-level
emitter fired on `transact` commit.

**One asymmetry to carry over deliberately, whenever it happens:** `/lesson-items` is online-only even
on web — favoriting and adding a word are direct writes, not outbox ops, because `MirrorItem` is keyed
on a `lesson_id` a standalone word does not have.

---

## 6. Screens

Four screens survive the §1 cull:

| Native screen                                           | Notes                            |
| ------------------------------------------------------- | -------------------------------- |
| lessons list + new-lesson form                          | `GET /api/v2/lessons`            |
| lesson detail + **the tutor**                           | the one screen native exists for |
| collection — search, filters, facets, sort, multiselect | the most complex screen          |
| word detail — `WordDetails` rendering                   |                                  |

`expo-router` is the natural fit: file-based routing mirroring the App Router layout, so the two apps'
navigation stays legible side by side.

**The UI is the honest cost and none of it ports.** ~2630 LOC of `.tsx` outside page files, all Base
UI + CSS: `Select`, `Checkbox`, `ConfirmDialog`, `Disclosure`, `InfoPopover`, `Tooltip`, `Button`,
`NavLink`, `NavProgressBar`, `ThemeToggle`, `RefreshButton`, `FavoriteButton`, `ItemsBrowser`,
`LessonsList`, `NewLessonForm`, `AddWordForm`, `LessonItemsView`. None have RN equivalents in the same
library; each is a rewrite against RN primitives or a native component kit (D3, still open).

What _does_ come free is everything behind them: `searchItems`, facet grouping and sort labels
(`@tutor/shared/item-list`), the URL grammar, `wordInputKey` / `clientDedupeKey`, and every DTO. The
filtering logic of the collection screen is already pure and shared — only its chrome is rebuilt.

---

## 7. Scaffold

**Superseded on 2026-08-13 → Expo SDK 57** (released 2026-06-30): **React Native 0.86 + React
19.2.3**, a release with no intended breaking changes from 0.85. SDK 56 (RN 0.85) is what this
section originally pinned; D8 in [S0 §2](./2026-08-13-expo-s0-scaffold-testflight.md#2-decisions--settled-2026-08-13) closed it in favour of 57 after checking that nothing in
the stack below declares an RN upper bound. **The workspace React override moves to `19.2.3`** — the
version `react-native@0.86` requires — rather than the `19.2.7` written here; Next asks only for
`^19.0.0`, so one version still serves both apps. Two peer conflicts found during that check are
recorded in S0 §2 and inherited by S1.

```bash
cd apps && npx create-expo-app@latest mobile --template default
cd mobile
npx expo install @elevenlabs/react-native @livekit/react-native @livekit/react-native-webrtc \
  livekit-client @config-plugins/react-native-webrtc @livekit/react-native-expo-plugin \
  react-native-auth0 expo-router expo-keep-awake expo-dev-client
pnpm add @tutor/shared@workspace:*
```

`npx expo install`, not `pnpm add`, for native packages — it picks SDK-matching versions. Set
`"name": "mobile"` in `package.json` or the root `pnpm mobile` script (which already exists, pointing
at nothing) stays broken. `expo-sqlite` / `netinfo` are deferred with the mirror (D1).

`app.json` — iOS only (D2); plugins from the official ElevenLabs Expo example plus Auth0:

```jsonc
{
  "expo": {
    "plugins": [
      "@livekit/react-native-expo-plugin",
      "@config-plugins/react-native-webrtc",
      [
        "react-native-auth0",
        { "domain": "YOUR-TENANT.eu.auth0.com", "customScheme": "englishtutor" },
      ],
      "expo-router",
    ],
    "ios": {
      "bundleIdentifier": "YOUR.BUNDLE.ID",
      "infoPlist": {
        "NSMicrophoneUsageDescription": "Used to talk with your English tutor.",
        "UIBackgroundModes": ["audio"], // the whole point — see B2
      },
    },
  },
}
```

`customScheme` must be lowercase with no special characters.

Three traps worth knowing before losing a day to them:

- **Expo Go will not work.** Both `@elevenlabs/react-native` and `react-native-auth0` need custom
  native code. `expo-dev-client` + `npx expo prebuild` + `npx expo run:ios --device` from day one.
- **Ship the generated `metro.config.js` untouched.** SDK 52+ handles monorepos automatically; old
  StackOverflow `watchFolders` / `extraNodeModules` snippets _cause_ the bugs they claim to fix.
- **`UIBackgroundModes: ["audio"]` behaves differently in a dev build** — backgrounding a dev-client
  app can drop the Metro connection, so "background audio doesn't work" in development is frequently
  an artifact of the dev build. Confirm on a release build (see B2).

**Env discipline unchanged:** `apps/mobile/.env` gets `EXPO_PUBLIC_API_BASE_URL`,
`EXPO_PUBLIC_AUTH0_DOMAIN`, `EXPO_PUBLIC_AUTH0_CLIENT_ID`, `EXPO_PUBLIC_AUTH0_AUDIENCE` and nothing
else — `EXPO_PUBLIC_*` is inlined into the bundle exactly like `NEXT_PUBLIC_*`. `ELEVENLABS_API_KEY`
and the Supabase service-role key never appear here; the token route exists so the app never needs
them.

---

## 8. The plan is the spike ladder

**The stage-by-stage build order lives in [`2026-08-12-expo-build-plan.md`](./2026-08-12-expo-build-plan.md)**
— steps, gates, checklists and a status column to keep current. This section is the shape of it and
the reasoning behind the shape; the plan file is what you work from.

**One app. Nothing thrown away.** `apps/mobile` is scaffolded once at S0 and grows one risky thing at
a time. The build installed from TestFlight at S0 is the same app that becomes v1 — there is no
throwaway project and no stage is a prototype to be rewritten later.

Three rules make the ladder worth the ceremony:

1. **One risk per stage.** A stage that adds two risky things cannot tell you which one broke.
2. **Every stage ends installed from TestFlight on a real device.** Not the simulator — it models
   neither the audio-session lifecycle nor screen lock. Not a dev build — its Metro connection drops
   on background and manufactures false negatives.
3. **A red gate stops the ladder.** Do not start the next stage to "come back to it".

Server work arrives when a stage needs it rather than as an upfront block, so nothing is built before
the thing that consumes it is proven.

| Stage  | Adds to `apps/mobile`                                                      | Gate                                                  | Est.  |
| ------ | -------------------------------------------------------------------------- | ----------------------------------------------------- | ----- |
| **S0** | empty Expo app, EAS, TestFlight, one `@tutor/shared` import                | installs, launches, renders the shared string         | 1–2 d |
| **S1** | ElevenLabs + LiveKit, public agent, suspension probe                       | **S1a** runs on New Arch → **S1b/B2** survives a lock | 1–2 d |
| **S2** | `react-native-auth0` login                                                 | **B1** — a Bearer call returns the right `sub`        | 2–3 d |
| **S3** | private agent via the token route                                          | **B3** — one row, right `app_env`                     | 2–3 d |
| —      | **GATE: all three blockers cleared — commit to the rest, or stop cheaply** |                                                       |       |
| **S4** | the tutor screen proper                                                    | a real lesson, spoken end to end                      | 4–6 d |
| **S5** | lessons list + detail                                                      | create / add / remove a lesson                        | 3–5 d |
| **S6** | collection + word detail                                                   | filters, search, facets                               | 5–8 d |
| **S7** | theming, navigation, error/empty states                                    | shippable                                             | 3–5 d |
| —      | _(post-v1)_ SQLite mirror + reactive hooks + offline queue                 |                                                       | +1 wk |

**S0–S3 is ~1–1.5 weeks and answers every open question.** S4–S7 is ~3–5 weeks. The whole point of
the ordering is that the cheap part is the part that can say "stop".

Three things about the order are deliberate and worth stating here, because the plan file only
records the decision:

- **S0 tests one import from `@tutor/shared`.** Every screen depends on Metro resolving a workspace
  package that ships raw TypeScript through subpath exports under a hoisted pnpm layout. That is a
  ten-minute fix at S0 and a bewildering afternoon at S4, where the failure surfaces far from its
  cause.
- **S1 has two gates, not one.** `expo-doctor` flags the LiveKit packages as unsupported on the New
  Architecture, which SDK 56 enables by default. If the app crashes on launch that is a build
  problem, not a B2 result — so a foreground conversation must work (S1a) before a locked one means
  anything (S1b).
- **S4 comes before S5 and S6.** The tutor is the reason the app exists; a lessons list is not worth
  building against an unproven foundation.

_(post-v1)_ SQLite mirror + reactive hooks + offline queue, +1 week — see §5.

---

## 9. The blockers, researched

### B1 — Auth0: what exists, and exactly what to change ✅ **de-risked**

**The setup is already specified in this repo.** `supabase/README.md` §"Trust Auth0 as a third-party
auth provider" documents creating the API and wiring the audience; it was written for the Supabase RLS
path and never completed. The native port needs the same first step and not much else.

**The risk I flagged earlier is smaller than it looked.** I checked whether setting `AUTH0_AUDIENCE`
could break the web app:

```
getUserSupabase / isThirdPartyAuthConfigured  → defined in user-client.ts, called NOWHERE
lessons.ts, lesson-items.ts, words.ts         → all import getServiceSupabase
getAuthToken                                  → only caller is the dormant user-client.ts
```

Every query runs through the **service-role** client with explicit `owner_id` filtering. Nothing reads
the access token. So switching the token from opaque to JWT changes the login authorization parameters
and nothing else in the data path. The residual risk is the login flow itself: if the audience names
an API that does not exist, Auth0 rejects the authorization with `service not found`. Create the API
first, then set the env var.

**Changes to make in Auth0:**

1. **APIs → Create API.**
   - _Name_: anything (e.g. `English Tutor API`).
   - _Identifier_: URI-format, **immutable once created** (e.g. `https://api.english-tutor.app`).
     This value becomes `AUTH0_AUDIENCE` (server) and `EXPO_PUBLIC_AUTH0_AUDIENCE` (app).
   - _Signing algorithm_: **RS256** — asymmetric, so our server verifies via the tenant's public JWKS
     and no shared secret is distributed.
   - No scopes/permissions needed. Authorization is `sub`-based ownership, not scope-based; adding
     RBAC would be a second, redundant authorization model.
2. **Applications → Create Application → Native.** This is a **second** Auth0 application, alongside
   the existing Regular Web App the Next server uses. Both request the same audience. A Native app is
   a public client (no secret, PKCE), which is why it cannot reuse the web app's client.
   - _Allowed Callback URLs_ and _Allowed Logout URLs_:
     `englishtutor://YOUR-TENANT.eu.auth0.com/ios/YOUR.BUNDLE.ID/callback`
     (pattern: `{customScheme}://{domain}/ios/{bundleIdentifier}/callback`; iOS only per D2).
3. **Nothing else.** The `post-login` Action adding the `role: "authenticated"` claim and the Supabase
   → Third-Party Auth registration (steps 2–3 of `supabase/README.md`) are **only** needed to activate
   Postgres RLS. That is orthogonal to this port and should stay out of it.

**On the app side:** `authorize({ audience, scope: "openid profile email offline_access" })`.
`offline_access` yields a refresh token so `getCredentials()` can renew silently — without it the
learner re-authenticates whenever the access token expires, which on a phone is intolerable.

**On the server side:** `getBearerOwnerId` verifies via the tenant JWKS
(`https://YOUR-TENANT.eu.auth0.com/.well-known/jwks.json`), asserting `alg: RS256`, `iss` =
`https://YOUR-TENANT.eu.auth0.com/` (**trailing slash**), and `aud` = the API identifier. `sub` is
then the same owner id `getOwnerId()` returns today, so every owner-scoped query works unchanged.

> **Do not set `AUTH0_AUDIENCE` — add a separate variable.** This is a correction to my own earlier
> framing. `lib/auth0.ts` reads `AUTH0_AUDIENCE` and, when set, adds
> `authorizationParameters: { audience, scope: "…offline_access" }` to the **web** Auth0 client — so
> setting it changes the web login flow, which D4 says not to do.
>
> The server never needs to _request_ the audience in order to _verify_ it. The mobile app requests
> its own via `react-native-auth0`'s `authorize({ audience })`; the server only needs the identifier
> as a string to check the `aud` claim. So introduce a verification-only variable —
> `AUTH0_API_AUDIENCE` — read solely by `getBearerOwnerId`, and leave `AUTH0_AUDIENCE` empty.
>
> Web login then stays **byte-for-byte unchanged**, and B1's one remaining risk ("does setting the
> audience break the web login?") disappears rather than being tested. `supabase/README.md` step 4
> still says to set `AUTH0_AUDIENCE`; that instruction belongs to the RLS activation path, which this
> port is not doing.

**Revised cost: ~half a day**, most of it dashboard work. It was the largest risk item; it is now the
smallest.

### B2 — background audio through a screen lock ⚠️ **conditionally yes; proven at S1**

**The mechanism is real and correct for our case.** `UIBackgroundModes: ["audio"]` plus an
`AVAudioSession` in `playAndRecord` is the supported way to run WebRTC voice in the background, and
LiveKit's `registerGlobals()` already configures and activates the iOS audio session from the WebRTC
audio-engine lifecycle — the SDK's default is documented as sufficient for voice apps, which is why
§7 adds no custom audio code.

> **⚠️ Partly superseded 2026-08-13 by [S1 §3](./2026-08-13-expo-s1-background-audio.md#3-the-mechanism-corrected-for-the-version-we-install).**
> The audio-engine-lifecycle description above is **`@livekit/react-native@2.12.0`'s** mechanism, and
> D10 pins us to **2.9.8** (ElevenLabs' `livekit-client` pin forces it). At 2.9.8 `registerGlobals()`
> instead monkey-patches `getUserMedia` and sets `playAndRecord` **once**, before mic acquisition,
> with no `audioMode` and no re-application; the lifecycle-aware path is a React hook
> (`useIOSAudioManagement`) that the ElevenLabs SDK never calls. The conclusion — the #1467 condition
> is met, so B2 should hold — is unchanged. The exposure is **interruption recovery** (test E).

**The condition that matters.** `react-native-webrtc#1467` documents the failure mode precisely: with
**no** incoming voice track and the app **not** transmitting, iOS suspends the app after ~40 seconds.
With at least one audio track present — even from a muted peer — it stays awake. Track _existence_ is
what holds the app, not audio content.

Our session satisfies this in both directions and does so structurally, not incidentally. From
`WebRTCConnection.ts`, the SDK enables the microphone on `SignalConnected`, before `room.connect()`
even resolves, and never mutes it for the duration:

```ts
room.once(RoomEvent.SignalConnected, () => {
  room.localParticipant.setMicrophoneEnabled(true)…
});
```

So a published mic track exists for the whole session, and the agent publishes audio back. **Expected
answer: yes, it holds.**

**Why S1 still happens.** The mechanism being right does not prove our stack is right, and the one
thing that cannot be checked from documentation is a real device under real conditions — long
silences, the Metro-connection false negative in dev builds, and iOS reclaiming the session under
memory pressure. That is stage **S1** (§8), on the real app rather than a throwaway.

**Two residual risks worth naming now:**

- **App Review guideline 2.5.4.** Apps declaring `audio` are routinely rejected when the reviewer
  cannot hear background audio — the key is intended for apps that "provide audible content to the
  user while in the background". Ours genuinely does (the tutor speaks), so this is demonstrable
  rather than a stretch, but the reviewer has to _reach_ it: they must sign in and start a lesson.
  **Mitigation: a demo account plus explicit review notes describing how to background the app
  mid-session.** Cheap, and skipping it is a predictable rejection.
- **If the spike fails**, the escalation is CallKit (`expo-callkit-telecom`, or LiveKit's own
  recommendation) — a meaningfully larger integration that also brings the lock-screen call UI. Do not
  build it preemptively.

### B3 — WebRTC parity ✅ **dynamic variables identical; `conversation_id` is a real hazard**

**Dynamic variables: identical, and provably so.** `constructOverrides()` is imported by _both_
`WebSocketConnection.ts` and `WebRTCConnection.ts`, and it is the only thing that serialises them:

```ts
if (config.dynamicVariables) {
  overridesEvent.dynamic_variables = config.dynamicVariables;
}
```

Both transports send the same `conversation_initiation_client_data` event, so `items_list`,
`lesson_id` and `app_env` reach the agent and the post-call webhook exactly as they do today. The
prompt registry, `formatItemsList` output and webhook routing need no changes.

The _timing_ differs — WebSocket sends overrides on socket open, before the server's
`conversation_initiation_metadata` reply; WebRTC sends them after `room.connect()` and after the mic
is enabled. Both happen inside `createConnection` before `startSession` resolves, so both land before
our kickoff effect fires on `status === "connected"`. **No kickoff race**, but this is worth
re-confirming in the spike since it depends on server-side ordering we do not control.

**`conversation_id` is where the transports genuinely diverge, and it can corrupt history.**

WebSocket takes it from the server, authoritatively:

```ts
const { conversation_id, … } = conversationConfig;   // from conversation_initiation_metadata
return new WebSocketConnection(socket, conversation_id, …);
```

WebRTC _derives_ it, with a fallback chain:

```ts
const conversationId = `room_${Date.now()}`;          // placeholder
…
if (room.name) {
  connection.conversationId =
    room.name.match(/(conv_[a-zA-Z0-9]+)/)?.[0] || room.name;
}
```

If `room.name` is empty at that moment, the id stays `room_1758…`. If it is non-empty but does not
match `conv_*`, the raw room name is used. **Either outcome never matches the `conversation_id` the
post-call webhook reports**, and our schema has four writers converging on one `lesson_sessions` row
keyed by exactly that column. The failure is silent: a duplicate or orphaned row, noticed weeks later
when a lesson's history looks wrong — precisely the class of bug `sanitizeTranscript` was shared to
prevent.

**Mitigation, and it is cheap.** `/v1/convai/conversation/token` returns `conversation_id` alongside
the token, so our v2 route already has the authoritative value before the app connects. Return it
(§3.4), have the client use _that_ as the row key, and treat the SDK's `onConnect` id as
advisory — asserting it starts with `conv_` and logging a mismatch rather than trusting it.

### Still open

**D3 — component strategy: closed 2026-08-13 → Expo UI** (`@expo/ui`, SwiftUI). It ships in the
default template chosen by D6, so it costs nothing to adopt; the `Host` boundary and the
`matchContents` scroll trap are recorded in [S0 §2](./2026-08-13-expo-s0-scaffold-testflight.md#2-decisions--settled-2026-08-13) and in the S6 placeholder. What remains open
is **D8 — Expo SDK 56 or 57** (57 shipped 2026-06-30 with RN 0.86; `create-expo-app@latest` now
scaffolds it), which S0 must settle before typing.

---

## Sources

- [ElevenLabs — React Native SDK](https://elevenlabs.io/docs/eleven-agents/libraries/react-native) ·
  [Expo integration guide](https://elevenlabs.io/docs/eleven-agents/guides/integrations/expo-react-native)
- [elevenlabs/packages](https://github.com/elevenlabs/packages) — the source behind §2 and B3: the
  WebSocket/`signedUrl` throw in `packages/react-native/src/index.react-native.ts`; the
  `PrivateWebSocketSessionConfig` / `PrivateWebRTCSessionConfig` union in
  `packages/client/src/utils/BaseConnection.ts`; the shared `constructOverrides` in
  `packages/client/src/utils/overrides.ts`; the divergent `conversationId` derivation and the
  `SignalConnected` mic-enable in `WebRTCConnection.ts` vs `WebSocketConnection.ts`;
  `examples/react-native-expo/`.
- [ElevenLabs — Get conversation token (WebRTC)](https://elevenlabs.io/docs/eleven-agents/api-reference/conversations/get-webrtc-token)
  — `{ token, conversation_id }`.
- [react-native-webrtc#1467](https://github.com/react-native-webrtc/react-native-webrtc/issues/1467) —
  B2's condition: no audio track in either direction → iOS suspends after ~40s.
- [Apple — App Review Guidelines §2.5.4](https://developer.apple.com/app-store/review/guidelines/) ·
  [audio_service#975](https://github.com/ryanheise/audio_service/issues/975) — the `audio`
  background-mode rejection pattern.
- [livekit/client-sdk-react-native](https://github.com/livekit/client-sdk-react-native) —
  `registerGlobals()` auto-configures the iOS audio session; CallKit for the background escalation ·
  [expo-callkit-telecom](https://github.com/mfairley/expo-callkit-telecom).
- [Auth0 — Mobile + API architecture](https://auth0.com/docs/get-started/architecture-scenarios/mobile-api/part-2)
  (create API, identifier, RS256, Native app type) ·
  [Auth0 Expo quickstart](https://auth0.com/docs/quickstart/native/react-native-expo)
  (callback URL pattern, `customScheme`, `offline_access`) ·
  [react-native-auth0](https://www.npmjs.com/package/react-native-auth0).
- [Expo SDK 56 changelog](https://expo.dev/changelog/sdk-56) — RN 0.85, React 19.2, Expo UI stable ·
  [Expo — Work with monorepos](https://docs.expo.dev/guides/monorepos/).
- [Metro — Package Exports](https://metrobundler.dev/docs/package-exports/) ·
  [expo/expo#26926](https://github.com/expo/expo/issues/26926) — subpath exports from a workspace
  package, and `unstable_enablePackageExports` as the S0 escape hatch (on by default since RN 0.79).
- [livekit/client-sdk-react-native#255](https://github.com/livekit/client-sdk-react-native/issues/255)
  — `expo-doctor` flagging the LiveKit packages "Unsupported on New Architecture"; reported working,
  unverified on RN 0.85. The S1a gate.
- `supabase/README.md` — the Auth0 API + audience steps, already written.
- `docs/2026-08-09-expo-repo-structure-migration.md` (where the code lives — done) ·
  `docs/2026-08-09-shareable-core-refactor.md` (how `packages/shared` came to exist).

> **Housekeeping — the two 2026-08-07 references.**
>
> `docs/2026-08-07-Expo-migration.md` exists (untracked) but is **superseded by this note.** It
> proposes a hybrid WebView shell and says explicitly not to port the other screens — the opposite of
> the decision here — and it assumes the signed-URL mint carries over to native, which §2 disproves.
> Keep it as history; do not implement from it.
>
> `docs/2026-08-07-ios-locked-screen-background-voice.md` is genuinely **missing** — untracked,
> deleted, and not in git history. Its conclusion is restated at the top of this note. It is still
> cited by `docs/2026-08-09-expo-repo-structure-migration.md`,
> `docs/2026-08-07-ios-keep-session-alive-foreground.md`, `apps/web/src/.../useKeepAwake.ts` and
> `LessonTutor.tsx`; `CLAUDE.md` has been repointed at this note.
