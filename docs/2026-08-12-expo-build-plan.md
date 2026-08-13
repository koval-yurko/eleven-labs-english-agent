# Expo app — build plan

**Date:** 2026-08-12 · **Status:** not started. **Current stage: S0** — next action:
[research S0](./2026-08-13-expo-s0-scaffold-testflight.md) is done, so **execute it**.

The stage-by-stage build order for `apps/mobile`. This is the working document — update the status
column as you go.

**The reasoning lives in [`2026-08-12-expo-app-creation.md`](./2026-08-12-expo-app-creation.md)**:
what we are deliberately not building (§1), why the tutor cannot reuse the signed URL (§2), the
`/api/v2/*` design (§3), the scaffold (§7), and the three blockers researched in full (§9). This file
does not re-argue any of it — where a step needs a reason, it points there.

---

## How this works

**One app. Nothing thrown away.** `apps/mobile` is scaffolded once at S0 and grows one risky thing at
a time. The build installed from TestFlight at S0 is the same app that becomes v1 — there is no
throwaway project, and no stage is a prototype to be rewritten later.

Three rules:

1. **One risk per stage.** A stage that adds two risky things cannot tell you which one broke.
2. **Every stage ends installed from TestFlight on a real device.** Not the simulator — it models
   neither the audio-session lifecycle nor screen lock. Not a dev build — its Metro connection drops
   on background and manufactures false negatives.
3. **A red gate stops the ladder.** Do not start the next stage intending to "come back to it".

Server work arrives when a stage needs it rather than as an upfront block, so nothing is built before
the thing that consumes it is proven.

**Status legend:** ⬜ not started · 🟡 in progress · ✅ gate passed · ❌ gate failed (see notes)

---

## Where we are

**This table is the tracker. Update it at the end of every stage — it is how the next session knows
which stage to work on and which research to write.**

| Stage  | Research note                                                            | Research       | Build | Gate result |
| ------ | ------------------------------------------------------------------------ | -------------- | ----- | ----------- |
| **S0** | [s0 — scaffold, TestFlight](./2026-08-13-expo-s0-scaffold-testflight.md) | ✅ full        | ⬜    | —           |
| **S1** | [s1 — background audio](./2026-08-13-expo-s1-background-audio.md)        | 🔲 placeholder | ⬜    | —           |
| **S2** | [s2 — Auth0 + Bearer](./2026-08-13-expo-s2-auth0-bearer.md)              | 🔲 placeholder | ⬜    | —           |
| **S3** | [s3 — conversation token](./2026-08-13-expo-s3-conversation-token.md)    | 🔲 placeholder | ⬜    | —           |
| **S4** | [s4 — tutor screen](./2026-08-13-expo-s4-tutor-screen.md)                | 🔲 placeholder | ⬜    | —           |
| **S5** | [s5 — lessons](./2026-08-13-expo-s5-lessons.md)                          | 🔲 placeholder | ⬜    | —           |
| **S6** | [s6 — collection](./2026-08-13-expo-s6-collection.md)                    | 🔲 placeholder | ⬜    | —           |
| **S7** | [s7 — ship](./2026-08-13-expo-s7-ship.md)                                | 🔲 placeholder | ⬜    | —           |

**Research legend:** 🔲 placeholder (seeded, not researched) · 🟡 being written · ✅ full.

**Why only S0 is researched.** Each stage's real questions are the ones the previous stage's _result_
poses, so every other note holds three things only: what is already decided (with pointers, not
re-argument), what it needs handed over from the stage before it, and its gate — fixed now so it
cannot be renegotiated later. Details and the enrichment procedure:
[S0 research → How the stage docs work](./2026-08-13-expo-s0-scaffold-testflight.md#how-the-stage-docs-work).

### The end-of-stage ritual

When a stage's gate is decided — green **or** red:

1. Set its **Build** cell here and in the Progress table below (✅ / ❌), and write the gate result.
2. Fill in that stage's research note with what it hands forward ("What S*n* hands to S*n+1*").
3. **Write the next stage's research** from its placeholder — its inputs are now known — and set its
   Research cell to ✅.
4. Move the **Current stage** pointer in the header.
5. A red gate stops here. Record why, and do not open the next stage.

---

## Progress

| Stage  | What it adds                                                | Gate                                            | Est.  | Research                                          | Status |
| ------ | ----------------------------------------------------------- | ----------------------------------------------- | ----- | ------------------------------------------------- | ------ |
| **S0** | empty Expo app, EAS, TestFlight, one `@tutor/shared` import | installs, launches, renders the shared string   | 1–2 d | [✅](./2026-08-13-expo-s0-scaffold-testflight.md) | ⬜     |
| **S1** | ElevenLabs + LiveKit, public agent, suspension probe        | **S1a** runs → **S1b** survives a locked screen | 1–2 d | [🔲](./2026-08-13-expo-s1-background-audio.md)    | ⬜     |
| **S2** | `react-native-auth0` login + Bearer on the server           | a Bearer call returns the right `sub`           | 2–3 d | [🔲](./2026-08-13-expo-s2-auth0-bearer.md)        | ⬜     |
| **S3** | private agent via the v2 token route                        | one `lesson_sessions` row, right `app_env`      | 2–3 d | [🔲](./2026-08-13-expo-s3-conversation-token.md)  | ⬜     |
| —      | **🚩 GATE — all three blockers cleared. Commit, or stop.**  |                                                 |       |                                                   |        |
| **S4** | the tutor screen proper                                     | a real lesson, spoken end to end                | 4–6 d | [🔲](./2026-08-13-expo-s4-tutor-screen.md)        | ⬜     |
| **S5** | lessons list + lesson detail                                | create / add / remove a lesson                  | 3–5 d | [🔲](./2026-08-13-expo-s5-lessons.md)             | ⬜     |
| **S6** | collection + word detail                                    | filters, search, facets                         | 5–8 d | [🔲](./2026-08-13-expo-s6-collection.md)          | ⬜     |
| **S7** | theming, navigation, error/empty states                     | shippable                                       | 3–5 d | [🔲](./2026-08-13-expo-s7-ship.md)                | ⬜     |
| —      | _post-v1_ SQLite mirror + offline queue                     |                                                 | +1 wk | —                                                 | ⬜     |

**S0–S3 is ~1–1.5 weeks and answers every open question.** S4–S7 is ~3–5 weeks. The ordering exists
so the cheap part is the part that can say "stop".

---

## S0 — the empty app ships

**Research note:** [2026-08-13-expo-s0-scaffold-testflight.md](./2026-08-13-expo-s0-scaffold-testflight.md) — ✅ researched.

**Goal:** prove the pipeline, before any of our code can be blamed for it.

An empty app is a real stage, not a formality. Bundle identifier, signing, provisioning profiles, EAS
config, the first TestFlight upload and its processing delay all fail in ways that have nothing to do
with our code. Discovering any of them at S1 means debugging two unrelated things at once — and the
one you care about is the one you will misdiagnose.

### Steps

- [ ] `cd apps && npx create-expo-app@latest mobile --template default` — **D6, decided: `default`**,
      so `expo-router` and `@expo/ui` are wired from day one ([S0 research §2](./2026-08-13-expo-s0-scaffold-testflight.md#2-decisions--settled-2026-08-13)). The two source
      docs had disagreed (`blank-typescript` here, `default` in the creation doc). **D8 is also
      decided: Expo SDK 57** (RN 0.86, React 19.2.3), so `@latest` is correct
- [ ] Set `"name": "mobile"` in `apps/mobile/package.json` — the root `pnpm mobile` script already
      exists and filters on that name
- [ ] `pnpm add @tutor/shared@workspace:*` in `apps/mobile`
- [ ] Replace `app.json` with **`app.config.ts`** — **D7, decided**: one EAS project (_English
      Tutor_, slug `english-tutor`) and three `APP_VARIANT` identities
      (`work.kovalchuk.yurii.english-tutor`, `-preview`, `-dev`), each with its own URL scheme
      ([S0 research §2](./2026-08-13-expo-s0-scaffold-testflight.md#2-decisions--settled-2026-08-13))
- [ ] Ship the generated `metro.config.js` **untouched** (see "if it fails" below for the one
      permitted exception)
- [ ] Render one symbol from the shared package (see below)
- [ ] `pnpm install` at the repo root; confirm `ls apps/mobile/node_modules` is a flat tree
- [ ] EAS project init, build, submit to TestFlight
- [ ] Install from TestFlight on the target device

```tsx
import { KICKOFF_MESSAGE } from "@tutor/shared/tutor";
// …
<Text>{KICKOFF_MESSAGE}</Text>;
```

### Gate — **passed 2026-08-13**, on internal distribution

- [x] Installs on a real device (iOS 26.4) and launches — via an EAS **`preview`** build,
      internal distribution. **TestFlight itself is deferred to S7** by D9
      ([S0 §2](./2026-08-13-expo-s0-scaffold-testflight.md#d9--testflight-deferred-to-s7-s0-ships-on-internal-distribution-)): the Apple Developer / App Store Connect side is not set up, and everything that
      differs between preview and production is Apple-side rather than ours.
- [x] **Displays the string imported from `@tutor/shared`** — confirmed on device, alongside an
      Expo UI `Host` rendering SwiftUI, which retires D3's native-linkage risk five stages early.

That second line is load-bearing, not decoration. Every screen in this plan depends on Metro resolving
a workspace package that ships **raw TypeScript through subpath exports** (`"./*": "./src/*.ts"`)
under a hoisted pnpm layout. Three things must line up: Metro's package-exports support (on by default
since RN 0.79, so expected to work), Metro transpiling `.ts` from outside the app directory, and
hoisted workspace resolution. Ten minutes to fix here; a bewildering afternoon at S4, where the
failure surfaces far from its cause.

### If it fails

| Symptom                                | Try                                                                                                                                                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@tutor/shared/tutor` will not resolve | `config.resolver.unstable_enablePackageExports = true` in `metro.config.js`. **The only hand-edit to that file this plan permits** — everything else in a copied config causes the bugs it claims to fix. |
| EAS misdetects the package manager     | Known papercut ([eas-cli#2978](https://github.com/expo/eas-cli/issues/2978)) — pin it explicitly in `eas.json`.                                                                                           |
| Signing / provisioning                 | Not our code. Resolve fully before S1.                                                                                                                                                                    |

---

## S1 — B2: does a locked screen kill the session?

**Research note:** [2026-08-13-expo-s1-background-audio.md](./2026-08-13-expo-s1-background-audio.md) — 🔲 placeholder.

**Goal:** the premise of the entire project.

Add the ElevenLabs + LiveKit dependencies and a single dev screen pointed at a **public** agent — no
auth, no token route, because this stage tests audio and nothing else.

**Two gates, in order**, because there are two risks here and rule 1 applies.

### Steps

- [ ] Install the native packages (below)
- [ ] `app.json` plugins + `NSMicrophoneUsageDescription` + `UIBackgroundModes: ["audio"]`
      (full block in the research doc §7)
- [ ] `EXPO_PUBLIC_AGENT_ID=<a public agent>` in `apps/mobile/.env`
- [ ] Dev screen: `ConversationProvider` + `useConversation`, start/end, live transcript
- [ ] Add `useSuspensionProbe` (appendix A) and show `status`, `AppState`, `drift`, `max drift`
- [ ] Log `conversationId` from `onConnect`; flag anything not matching `/^conv_/` (free early look
      at the B3 hazard — research doc §9 B3)
- [ ] `npx expo prebuild --clean && npx expo run:ios --device --configuration Release`

```bash
npx expo install @elevenlabs/react-native @livekit/react-native @livekit/react-native-webrtc \
  livekit-client @config-plugins/react-native-webrtc @livekit/react-native-expo-plugin
```

### Gate S1a — the stack runs at all

SDK 56 ships RN 0.85 with the New Architecture on by default, and `expo-doctor` flags
`@livekit/react-native` and `@livekit/react-native-webrtc` as _"Unsupported on New Architecture"_.
Reports say they work and the warning is stale metadata
([livekit#255](https://github.com/livekit/client-sdk-react-native/issues/255), closed) — but that was
against a much older React Native and nobody has confirmed it on 0.85. Run `npx expo-doctor`, expect
the warning; what matters is whether it runs.

- [ ] App launches
- [ ] A **foreground** conversation completes — audio both directions, a transcript line rendered

A crash or a session that never connects is a New Architecture or build problem, **not** a B2 result.
Fallback: try `newArchEnabled: false` (SDK 56 does not document removing the opt-out, but that is
itself unverified — check before relying on it), then pin to SDK 55.

Only once S1a is green does the locked-screen test mean anything.

### Gate S1b — B2 itself

Run test **A** first; if it fails the rest are academic.

| #     | Test                               | Method                                                                                             | Isolates                                                                                                                  |
| ----- | ---------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **A** | Locked screen, active conversation | Start, talk until the agent replies, lock the phone. Keep talking; listen. Unlock after **3 min**. | The headline question                                                                                                     |
| **B** | Locked screen, long silence        | Start, lock immediately, say nothing for **3 min**.                                                | Whether an idle-but-open session survives                                                                                 |
| **C** | Muted microphone                   | Start, mute, lock for **2 min**.                                                                   | Whether track _presence_ alone holds us ([#1467](https://github.com/react-native-webrtc/react-native-webrtc/issues/1467)) |
| **D** | App-switch instead of lock         | Start, swipe away for **2 min**.                                                                   | Backgrounding vs locking — different suspension paths                                                                     |
| **E** | Interruption recovery              | Take a call or trigger Siri, then return.                                                          | Whether the SDK recovers or wedges — informs the `"audio"` pause card                                                     |

**A passes when all four hold:**

- [ ] `status` stayed `connected` throughout
- [ ] **`max drift` < 3s** ← the one that matters
- [ ] Agent audio was **audible while the screen was locked**
- [ ] Transcript lines timestamped _during_ the locked window are present

B and D use the same criteria. C is informational: a failure there is expected, harmless (we never
mute), and confirms the #1467 mechanism.

**A session still reporting `connected` after a 40-second lock is not a pass if drift shows 40s.** It
was suspended and has not noticed — precisely the failure the web app has today, and precisely what a
naive "is it still connected?" check misses.

Record the actual number, not just pass/fail: 0.4s and 2.9s are both passes but say different things
about headroom. Results table: appendix B.

### If it fails

| Symptom                                      | Next                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Suspends only when nothing is flowing        | Likely audio-session config, not a dead end. Try `setupIOSAudioManagement` with an explicit `playAndRecord` category (LiveKit's documented escape hatch from its default policy) and re-run. A few hours.                                                                                                                               |
| Suspends with audio configured correctly     | **Escalate to CallKit** (`expo-callkit-telecom`). The real fork: larger integration, its own App Review surface — but it buys the lock-screen call UI and a call-like model that suits a voice tutor. **Re-estimate S4 before committing**; this branch could turn 4.5–7 weeks into something longer and deserves an explicit go/no-go. |
| Passes only with the screen awake-but-dimmed | **Not a pass.** That is `expo-keep-awake` territory and a weaker product than promised. Say so rather than shipping it quietly.                                                                                                                                                                                                         |

### After it goes green

- [ ] **Keep the probe screen** behind a dev flag. It costs nothing and becomes the regression test
      for every SDK and iOS upgrade that follows.

---

## S2 — B1: Auth0 on a device

**Research note:** [2026-08-13-expo-s2-auth0-bearer.md](./2026-08-13-expo-s2-auth0-bearer.md) — 🔲 placeholder.

**Goal:** a native client that can authenticate against our server.

Full research and rationale: research doc §9 B1. The risk turned out to be small — every query runs
through the service-role client, so nothing in the data path reads the access token.

### Auth0 dashboard (one-time)

- [ ] **APIs → Create API** - Name: e.g. `English Tutor API` - Identifier: URI-format, **immutable once created** — e.g. `https://api.english-tutor.app` - Signing algorithm: **RS256** (asymmetric — the server verifies via public JWKS, no shared
      secret is distributed) - No scopes/permissions: authorization is `sub`-based ownership, and RBAC would be a redundant
      second model
- [ ] **Applications → Create Application → Native** — a _second_ app alongside the existing Regular
      Web App. A Native app is a public client using PKCE, so it cannot reuse the web client. - Allowed Callback URLs **and** Allowed Logout URLs:
      `englishtutor://YOUR-TENANT.eu.auth0.com/ios/YOUR.BUNDLE.ID/callback`
- [ ] **Do NOT set `AUTH0_AUDIENCE`.** It is read by `lib/auth0.ts` and would change the _web_ login
      flow, which D4 forbids. Add a verification-only `AUTH0_API_AUDIENCE` instead, read solely by
      `getBearerOwnerId`. Web login then stays byte-for-byte unchanged. (`supabase/README.md` step 4
      says to set `AUTH0_AUDIENCE` — that belongs to the RLS activation path, which this port is not
      doing.)

### Server

- [ ] `apps/web/src/lib/auth/bearer.ts` → `getBearerOwnerId(req): Promise<string | null>`
      — verify via `https://YOUR-TENANT.eu.auth0.com/.well-known/jwks.json`, asserting `alg: RS256`,
      `iss` = `https://YOUR-TENANT.eu.auth0.com/` (**trailing slash**), `aud` = `AUTH0_API_AUDIENCE`
- [ ] `GET /api/v2/me` → `{ sub: string }` — exists to make this gate unambiguous, and stays useful
      afterwards as an auth/liveness probe
- [ ] Confirm `getOwnerId()` is **unchanged** (cookie-only). The v2 namespace exists so the Bearer
      path never runs for the web app.

### App

- [ ] `npx expo install react-native-auth0`; add the plugin with `domain` + `customScheme`
      (lowercase, no special characters)
- [ ] `authorize({ audience, scope: "openid profile email offline_access" })`

### Gate

- [ ] Auth0 login completes on-device
- [ ] `getCredentials()` returns an access token that is a **JWT**, not opaque
- [ ] `GET /api/v2/me` with that Bearer returns the same `sub` the web app sees for that account
- [ ] Background the app past the token lifetime — `offline_access` renews silently

That last one is not optional. A phone that re-prompts for login mid-lesson is not shippable.

### If it fails

| Symptom                      | Cause                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------- |
| `service not found` on login | The API does not exist yet, or the identifier does not match. Create the API before wiring the app. |
| Token is opaque, not a JWT   | No audience was requested. Auth0 only issues a JWT when a custom API audience is asked for.         |
| Web login broke              | You set `AUTH0_AUDIENCE`. Unset it; use `AUTH0_API_AUDIENCE` for verification only.                 |

---

## S3 — B3: the conversation id

**Research note:** [2026-08-13-expo-s3-conversation-token.md](./2026-08-13-expo-s3-conversation-token.md) — 🔲 placeholder.

**Goal:** our own agent, and a transcript row that cannot silently fork.

Swap the public agent for ours via the v2 token route, and close the hazard from research doc §9 B3:
the WebRTC path **derives** `conversationId` from the LiveKit room name with a fallback chain, so it
can end up as `room_<timestamp>` and never match what the post-call webhook reports. Four writers
converge on one `lesson_sessions` row keyed by that column.

### Steps

- [ ] **B3-M1** — `POST /api/v2/words-agent/token` calls `/v1/convai/conversation/token` and returns
      `{ token, conversationId, version, appEnv }`. A response missing `conversationId` is an error,
      exactly like `appEnv` — a derived id is worse than no session.
- [ ] **B3-M1b** — `GET /api/v2/agent-versions` returning version + label, **`agentId` stripped**.
      The app picks a version string; the token route resolves version → agent id server-side. That
      seam is what lets `pnpm sync:agents` retire a version without breaking installed binaries.
- [ ] Declare both in `packages/shared/src/api.ts` (research doc §3.4)
- [ ] **B3-M2** — client seeds `conversationIdRef` from the token response **before** `startSession`;
      `onConnect` never overwrites it
- [ ] **B3-M3** — compare, do not trust: warn if `onConnect`'s id differs from the token id or fails
      `/^conv_/`. Three lines; the tripwire if the SDK's derivation drifts.
- [ ] Send `dynamicVariables: { items_list, lesson_id, app_env }` and save the transcript via
      `POST /api/v2/lessons/session`

### Gate — B3-M4

- [ ] Run one native session end to end
- [ ] In the database: the row the client wrote and the row the post-call webhook upserts are **the
      same row** — one `lesson_sessions` record, not two
- [ ] That row carries the **correct `app_env`**

M1–M3 make the id correct by construction, but they all rest on an assumption about which id the
_webhook_ reports, and no amount of client-side care tests that. M4 does.

The `app_env` check is separate on purpose: dynamic variables are provably identical across transports
(research doc §9 B3), but the webhook's _routing_ on `app_env` has only ever run from a browser. A
session that lands as one row in the **wrong environment** passes the row check and is still wrong —
and that is discovered much later, when dev sessions turn up in prod history.

---

## 🚩 The gate

All three blockers cleared, ~1–1.5 weeks in, for the price of a scaffold and one screen.

**Decide explicitly here.** Green → commit to S4–S7. Red on B2 with CallKit as the only path → re-cost
the project before continuing. This is the cheapest stopping point that will ever exist.

---

## S4 — the tutor screen

**Research note:** [2026-08-13-expo-s4-tutor-screen.md](./2026-08-13-expo-s4-tutor-screen.md) — 🔲 placeholder.

**Goal:** the feature the app exists for, against a real lesson.

The port is mostly mechanical — the RN package re-exports every hook from `@elevenlabs/react` with an
identical API, and everything from `@tutor/shared/tutor` is used as-is (research doc §4).

### Steps

- [ ] `GET /api/v2/lessons/:id` → `LessonDetail` + sessions + item history
- [ ] Port `LessonTutor`'s state machine: proactive kickoff, hidden-message filter,
      per-conversation-id save guard, carried transcript, resume context
- [ ] Session journal on `expo-sqlite` (crash insurance now, not backgrounding insurance)
- [ ] Version picker fed by `GET /api/v2/agent-versions`
- [ ] **Do not port** `useKeepAwake`, `useAudioHealth`, the visibility dance, `pagehide` beacons, or
      the `"background"` pause card — research doc §1
- [ ] Exercise `sendContextualUpdate` deliberately: the resume flow is the one piece of the tutor
      whose transport genuinely changed (LiveKit data channel rather than the socket)

### Gate

- [ ] A real lesson's words, spoken end to end, transcript saved to that lesson's history
- [ ] Resume after an interruption continues the lesson rather than restarting it

---

## S5 — lessons

**Research note:** [2026-08-13-expo-s5-lessons.md](./2026-08-13-expo-s5-lessons.md) — 🔲 placeholder.

- [ ] `GET /api/v2/lessons` → `LessonListItem[]`
- [ ] `POST /api/v2/sync/flush` — **single-op batches** through the existing, property-checked op
      algebra. Keep this even though v1 is online-only: adding offline later becomes a purely
      client-side change (research doc §3.3).
- [ ] Lessons list + new-lesson form; lesson detail with item add/remove
- [ ] Gate: create a lesson, add items, remove an item, delete a lesson — all reflected on the web app

---

## S6 — the collection

**Research note:** [2026-08-13-expo-s6-collection.md](./2026-08-13-expo-s6-collection.md) — 🔲 placeholder.

The largest UI item. **D3 (component strategy) is decided: Expo UI** (`@expo/ui`, SwiftUI — stable in
SDK 56 and shipped in the default template) —
[S0 research §2](./2026-08-13-expo-s0-scaffold-testflight.md#2-decisions--settled-2026-08-13). The
`Host` sizing boundary and the `matchContents` scroll trap are recorded in the S6 placeholder.

- [ ] `GET /api/v2/lesson-items?…` — serialize with `serializeItemsQuery`, parse with
      `parseItemsQuery`. Do not invent a second query format.
- [ ] `GET /api/v2/lesson-items/:id` → `ItemDetail`; `POST` for add-word and favorite
- [ ] Search (`searchItems`, in memory), facets, filters, sort, multiselect — all the logic is already
      pure and shared; only the chrome is new
- [ ] Gate: filter, search and sort return the same results as the web app for the same query

---

## S7 — ship

**Research note:** [2026-08-13-expo-s7-ship.md](./2026-08-13-expo-s7-ship.md) — 🔲 placeholder.

- [ ] Theming (light/dark), navigation polish, error and empty states
- [ ] Mic-permission denial copy — on native a denial surfaces as a _session error_, not a pre-flight
      prompt (research doc §4)
- [ ] **App Review prep:** a demo account and review notes describing how to background the app
      mid-session. Guideline 2.5.4 rejects apps declaring `audio` when the reviewer cannot hear
      background audio — ours genuinely produces it, but the reviewer has to reach it.
- [ ] TestFlight → submit

---

## Post-v1 — offline

Deferred by D1, not cancelled. Port surface and the two invariants that must survive: research doc §5.

- [ ] `expo-sqlite` implementation of `MirrorStore`
- [ ] The three reactive hooks with a store-level emitter fired on `transact` commit
- [ ] Client queues ops instead of posting them — **no server change**

---

## Appendix A — the suspension probe

You cannot watch a screen that is locked, so measure suspension instead of observing it. A 1s timer
increments `ticks` while wall-clock elapsed is read independently; when iOS suspends the app, timers
stop but the clock does not.

```ts
/** Seconds iOS has taken away from us. Keep this — it stays useful as a regression check. */
export function useSuspensionProbe(running: boolean) {
  const [drift, setDrift] = useState(0);
  const [maxDrift, setMaxDrift] = useState(0);
  const started = useRef<number | null>(null);
  const ticks = useRef(0);

  useEffect(() => {
    if (!running) return;
    started.current = Date.now();
    ticks.current = 0;
    const id = setInterval(() => {
      ticks.current += 1;
      const wall = (Date.now() - started.current!) / 1000;
      const d = wall - ticks.current; // ← the measurement
      setDrift(d);
      setMaxDrift((m) => (d > m ? d : m));
    }, 1000);
    return () => clearInterval(id);
  }, [running]);

  return { drift, maxDrift };
}
```

The screen shows `status`, `AppState`, `drift` / `max drift`, and a scrollback of timestamped events
(status changes, transcript lines, errors) readable _after_ unlocking.

---

## Appendix B — S1b results

> Fill in when run. Empty means not yet run — do not infer a result from its absence.

| Test | Date | iOS | Device | Build   | max drift | Audible locked? | Verdict |
| ---- | ---- | --- | ------ | ------- | --------- | --------------- | ------- |
| A    |      |     |        | Release |           |                 |         |
| B    |      |     |        | Release |           |                 |         |
| C    |      |     |        | Release |           |                 |         |
| D    |      |     |        | Release |           |                 |         |
| E    |      |     |        | Release |           |                 |         |

**Conclusion:**

**Follow-ups:**
