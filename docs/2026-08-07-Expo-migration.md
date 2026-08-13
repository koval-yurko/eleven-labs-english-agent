# Expo migration — running the tutor natively so it survives a locked screen

**Date:** 2026-08-07
**Status:** ⛔️ **SUPERSEDED by `docs/2026-08-12-expo-app-creation.md` — do not implement from this
note.** Kept as history. Two things here are now known to be wrong: it proposes a *hybrid WebView
shell* (the decision is a full native port, iOS only), and §2/§3 assume the existing signed-URL mint
carries over to React Native — it cannot. The RN SDK is WebRTC-only and throws on `signedUrl`.
The build plan is `docs/2026-08-12-expo-build-plan.md`.
**Background:** `docs/2026-08-07-ios-locked-screen-background-voice.md` once explained why the browser
session cannot work in the background on iOS (mic revoked, Web Audio interrupted, page suspended,
socket dropped). **That note no longer exists** — it was never committed. Its conclusion is restated
at the top of `docs/2026-08-12-expo-app-creation.md`.

This is "Option B" from that note, written out. The goal is one thing only: **a tutor session that
keeps going with the phone in a pocket, screen off.** Everything else here is in service of that.

---

## 1. Why Expo/React Native is the cheap native path

`@elevenlabs/react-native` re-exports `ConversationProvider` and the same hooks as
`@elevenlabs/react` **with an identical API**. `LessonTutor`'s entire conversation layer — the
`useConversation({ onConnect, onMessage, onDisconnect, onError })` block, the kickoff effect, the
transcript state, `persistSession()` — moves across unchanged. Only the JSX (`<section>`/`<button>`
→ `<View>`/`<Pressable>`) is rewritten.

Underneath it is `@livekit/react-native` + `@livekit/react-native-webrtc`, i.e. native WebRTC and a
native `AVAudioSession` instead of `getUserMedia` + `AudioContext`. That is the whole trick: iOS
suspends _web_ audio, not an app that declared the `audio` background mode.

Requires an Expo **dev build** (LiveKit has native modules — Expo Go will not run it).

## 2. Recommended shape: hybrid shell, not a full rewrite

Do **not** port `/lessons`, `/lesson-items`, the word detail pages, Dexie sync, or the offline app.
That is weeks of work for zero background-audio benefit.

```
┌─ Expo app (iOS) ───────────────────────────────────────────┐
│  WebView  → https://<our-next-app>/…   (all browsing UI)   │
│      │  postMessage: {startSession, lessonId, version}     │
│      ▼                                                     │
│  Native screen: <TutorScreen/>                             │
│      @elevenlabs/react-native + LiveKit WebRTC             │
│      CallKit + UIBackgroundModes: audio, voip              │
└────────────────────────────────────────────────────────────┘
              │ https (Bearer token)
              ▼
   existing Next.js app — /api/words-agent/signed-url,
   server actions, /api/elevenlabs-webhook, Supabase, Auth0
```

The server side does not change: same signed-URL mint, same agent version registry
(`src/agent/agents.lock.json`), same dynamic variables (`items_list`, `lesson_id`, `app_env`), same
post-call webhook writing history. Only the client that opens the audio connection moves.

**Phase 2 (optional, later):** replace WebView screens with native ones where the UX warrants it.
Nothing forces that.

## 3. Work items

### 3.1 Project setup

```bash
npx create-expo-app@latest mobile        # sibling folder or apps/mobile if we ever go workspace
pnpm add @elevenlabs/react-native @livekit/react-native @livekit/react-native-webrtc \
         livekit-client @config-plugins/react-native-webrtc @livekit/react-native-expo-plugin \
         react-native-webview react-native-auth0 expo-dev-client
```

`app.json` (the parts that matter):

```jsonc
{
  "expo": {
    "ios": {
      "bundleIdentifier": "com.<us>.englishtutor",
      "infoPlist": {
        "NSMicrophoneUsageDescription": "The tutor listens to you so it can talk back.",
        "UIBackgroundModes": ["audio", "voip"],
      },
    },
    "plugins": ["@livekit/react-native-expo-plugin", "@config-plugins/react-native-webrtc"],
  },
}
```

- `audio` keeps the app running while a mic/audio track is live — that is the background fix.
- `voip` is required for CallKit (below).
- Ship via EAS Build → TestFlight. There is no way to test this in Expo Go or the simulator's audio.

### 3.2 The tutor screen

Port `src/app/lessons/[id]/LessonTutor.tsx` almost verbatim. The pieces that change:

| Today (web)                                          | In the app                                                                                     |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `navigator.mediaDevices.getUserMedia` pre-prompt     | `expo-av` / LiveKit permission request (`NSMicrophoneUsageDescription`)                        |
| `fetch("/api/words-agent/signed-url")` (cookie auth) | same URL, absolute, `Authorization: Bearer <token>` (§3.3)                                     |
| `connectionType: "websocket"`                        | `"webrtc"` — the RN SDK is LiveKit-based; WS mode is a web thing                               |
| `saveLessonSessionAction` (Next server action)       | a small `POST /api/lessons/:id/sessions` route wrapping the same `src/lib/lessons.ts` function |
| `router.refresh()`                                   | reload the WebView / refetch                                                                   |

`useConversation` options, callbacks, `sendUserMessage(KICKOFF_MESSAGE)`, `dynamicVariables` — all
identical.

> **Superseded 2026-08-09.** This section used to say the tutor contract "can be shared verbatim;
> simplest is to copy it initially". **Do not copy it.** That advice pre-dates
> `docs/2026-08-09-shareable-core-refactor.md`, which extracted the whole pure core into
> `src/shared/` precisely because a hand-copied contract drifts silently — the same codebase had
> already been bitten by exactly that with the `/lesson-items` URL grammar. `src/lib/tutor.ts` no
> longer exists; `KICKOFF_MESSAGE`, `formatItemsList`, `TranscriptLine` and `sanitizeTranscript` are
> in `src/shared/tutor.ts`, alongside `src/shared/api.ts` (routes, request/response shapes),
> `sync-ops.ts`, `mirror-store.ts`, `word-key.ts`, `items-query.ts`, `item-list.ts` and the type
> modules. The app imports `@tutor/shared`; it does not carry a second copy of any of it.

### 3.3 Auth — the one genuinely new problem

Today auth is `@auth0/nextjs-auth0` cookies plus the gate in `src/proxy.ts`. A native app has no
cookie jar we control and no browser session.

Plan: `react-native-auth0` (native login, PKCE) → access token for our API audience → API routes
accept `Authorization: Bearer` in addition to the session cookie. Concretely:

1. Create an Auth0 **API** (audience, e.g. `https://api.english-tutor`) and a **Native** application.
2. In `src/lib/auth0.ts` add a token path: verify the JWT (JWKS), map `sub` → the same `owner_id`
   we already stamp on every Supabase row. Ownership semantics are unchanged.
3. Allow-list `Bearer` on `/api/words-agent/signed-url` and the new session-save route in
   `src/proxy.ts`.
4. WebView screens: pass the session by loading the WebView with a short-lived login URL, or accept
   that the WebView logs in separately once (Auth0 SSO cookie in `ASWebAuthenticationSession` makes
   this near-invisible).

Budget real time for this — it is the largest non-obvious chunk of the migration.

### 3.4 Background robustness — CallKit

Background modes alone keep the app alive "as long as a mic or audio track is playing" (LiveKit's
own wording), which is fragile: a brief audio gap or memory pressure can suspend the app. LiveKit
recommends **CallKit** (`react-native-callkeep`) to hold the connection. Benefits beyond robustness:

- The session shows up as a call — lock-screen UI, end from the lock screen, ducks other audio.
- Correct interruption behaviour when a real call arrives.
- Makes the background-audio entitlement obviously legitimate to App Review.

Also configure `AVAudioSession` `.playAndRecord` / `.voiceChat` (LiveKit exposes this) so the
earpiece/speaker routing and echo cancellation behave.

### 3.5 Known traps

- **"Local Network" permission.** Denying it makes LiveKit hang and time out after ~30s with no
  useful error ([elevenlabs-swift-sdk#83](https://github.com/elevenlabs/elevenlabs-swift-sdk/issues/83)).
  Ask for it with context, and detect the hang.
- **Expo Go doesn't work.** Dev builds only — everyone testing needs a TestFlight/dev build.
- **App Review** will ask why we need background audio. "Live conversational tutoring session" plus
  visible CallKit call UI is the answer. Do not use the audio mode for anything else.
- **Dexie/offline** (`src/lib/sync`, `dexie`) is IndexedDB — it does not exist in RN. In the hybrid
  shape the WebView keeps using it; only a full native port would need `expo-sqlite` and a storage
  adapter in `src/lib/sync/db.ts`.
- **Two release trains.** Web deploys stay instant; the app needs EAS builds and review. Keep all
  logic server-side (as it already is) so the app stays a thin client.

## 4. Effort sketch

| Chunk                                                                         | Estimate                     |
| ----------------------------------------------------------------------------- | ---------------------------- |
| Expo project, plugins, dev build, TestFlight pipeline                         | 1–2 d                        |
| Auth0 native login + Bearer on API routes                                     | 2–3 d                        |
| Tutor screen port + session-save route                                        | 1–2 d                        |
| Background modes + CallKit + audio session tuning                             | 2–3 d                        |
| WebView shell, deep links, postMessage bridge                                 | 1–2 d                        |
| Device testing (lock, incoming call, AirPods, cellular↔Wi-Fi, Low Power Mode) | 2 d                          |
| **Total**                                                                     | **~2 weeks of focused work** |

Android comes almost free afterwards (same RN code, foreground service instead of background modes),
but it is not the reason to do this.

## 5. Decisions to make before starting

1. **Hybrid WebView shell vs full native port** — recommend hybrid.
2. **Repo layout** — sibling `mobile/` folder vs turning the repo into a pnpm workspace with
   `apps/web` + `apps/mobile` + `packages/shared`. Workspace is cleaner long-term; the CLAUDE.md
   "single pnpm package (no workspace)" note would need updating.
3. **CallKit now or later** — later means a flakier background session; recommend now.
4. **Is telephony (Option D) enough?** If "practice while walking" is the only background use case,
   an ElevenLabs phone number delivers it in days with no app, no review, no auth work. Decide this
   _before_ spending the two weeks.

## Sources

- [ElevenLabs React Native SDK](https://elevenlabs.io/docs/eleven-agents/libraries/react-native) ·
  [Expo guide](https://elevenlabs.io/docs/eleven-agents/guides/integrations/expo-react-native) ·
  [npm](https://www.npmjs.com/package/@elevenlabs/react-native)
- [@livekit/react-native — background modes & CallKit guidance](https://www.npmjs.com/package/@livekit/react-native) ·
  [LiveKit Swift quickstart](https://docs.livekit.io/home/quickstarts/swift/)
- [elevenlabs-swift-sdk#83 — Local Network permission hang](https://github.com/elevenlabs/elevenlabs-swift-sdk/issues/83)
- [Apple — background execution / audio background mode discussion](https://developer.apple.com/forums/thread/64960)
