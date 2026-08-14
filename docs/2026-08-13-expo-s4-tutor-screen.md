# S4 — the tutor screen · research

**Date:** created 2026-08-13 · enriched 2026-08-14 · **Status:** ✅ **GATE PASSED (2026-08-14)** —
built, tested on device, one native session on a real lesson recorded end to end.

**Parents:** [build plan → S4](./2026-08-12-expo-build-plan.md) ·
[creation doc §1, §4, §6](./2026-08-12-expo-app-creation.md) ·
[S1 research](./2026-08-13-expo-s1-background-audio.md) ·
[S3 research](./2026-08-13-expo-s3-conversation-token.md).

**In one line:** the port is mechanical except for one thing — the session's *lifecycle* — and the
native lifecycle is not the web one with the browser bits deleted. It is a different, smaller machine
driven by a signal the browser never had: the SDK tells you **why** the session ended.

---

## 0. What the research settled

Every question the placeholder asked, answered. Detail follows in the sections named.

| #   | Question                                                     | Answer                                                                                                                                                                                                       | §         |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| 1   | A current read of `LessonTutor.tsx` — what ports?            | 504 lines → **~210 port, ~200 delete, ~90 rewritten as JSX.** Full inventory, block by block.                                                                                                                | §2        |
| 2   | `GET /api/v2/lessons/:id` — one response or three?           | **One.** `{ lesson, sessions, sessionCount }`, built from the same two `lib/lessons.ts` functions the web page calls. Item history is **not** in it — it belongs to S5's editing screen.                    | §5.2, D30 |
| 3   | `sendContextualUpdate` on WebRTC                             | Path verified in source: `connection.sendMessage` → `room.localParticipant.publishData(…, {reliable: true})`. Same path the kickoff already uses **and S3 proved working**. The residual risk is server-side. | §3.3, D38 |
| 4   | What the SDK reports on an audio interruption                | **Nothing specific — and that is the finding.** No `AVAudioSession` interruption event reaches JS anywhere in the installed stack. What you get instead is a typed `onDisconnect` **reason**.                | §3.1      |
| 5   | Session journal storage                                      | **`expo-sqlite/kv-store`** — first-party, AsyncStorage-shaped, one JSON blob per lesson. Adding it is a **native rebuild**, not a JS reload.                                                                 | §6.4, D35 |
| 6   | Transcript rendering perf / split hooks                      | **Not yet.** Keep combined `useConversation`; memoise the row and use `FlatList`. Split hooks are a measured optimisation, and nothing is measured.                                                          | D37       |
| 7   | D3 (Expo UI) applied for the first time                      | **Deliberately small:** RN primitives own layout and scrolling; Expo UI owns the version `Picker` and the two buttons, inside fixed-height `Host`s. The `matchContents` trap is avoided by construction.     | §6.5, D39 |
| 8   | ⚠️ Not asked, and the most dangerous thing found             | **The conversation outlives the screen.** `ConversationProvider` is in `_layout.tsx` and `UIBackgroundModes: ["audio"]` is set — navigating away leaves a live, billed, listening session running.           | §3.5, D41 |

**Two corrections to earlier docs**, both load-bearing:

- **Creation doc §1 says `useAudioHealth` can go because "iOS delivers a real `AVAudioSession`
  interruption event — handle it, stop inferring".** The premise is wrong at the versions we ship:
  nothing in `@livekit/react-native@2.9.8`, `@livekit/react-native-webrtc@137.0.3` or
  `@elevenlabs/client@1.17.0` surfaces an interruption to JavaScript. The **conclusion still holds**
  — `useAudioHealth` goes — but for a better reason (§3.1), and the replacement is different from
  what that line implies.
- **The build plan's S4 step list bundles item history into `GET /api/v2/lessons/:id`.** Split out to
  S5 (D30). It is display data for the *editing* screen, not for the tutor.

---

## 1. Inputs from S1 and S3 — filled in

### From S3 (all green)

| Input                                             | State                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `POST /api/v2/words-agent/token`                  | ✅ live, returns `{ token, conversationId, version, appEnv }`                                |
| `GET /api/v2/agent-versions`                      | ✅ live, `{ versions, defaultVersion }`, no agent ids                                        |
| `POST /api/v2/lessons/session`                    | ✅ live, 404 for a foreign lesson, idempotent per `conversation_id`                          |
| "Which id does the webhook report?"               | ✅ **the token's** — `system__conversation_id` == row key == token id, twice, on hardware    |
| The save-guard rule                               | ✅ `savedForRef` keyed on the **token's** id; seed `conversationIdRef` *before* `startSession` |
| `apiFetch` + per-request `getCredentials`         | ✅ built (`apps/mobile/src/api.ts`)                                                          |
| CORS / `OPTIONS` / `withBearer` on the v2 surface | ✅ the pattern S4 extends                                                                    |

Plus three ⚠️ carry-forwards, each handled below: `onConversationMetadata` unobserved (§3.3),
the hard-coded lesson (§6.2), `sendContextualUpdate` unexercised (§3.3 + the gate).

### From S1 — and the two gaps that matter here

S1b **A–E all passed**, including E (interruption: Siri / an incoming call, then return). That is the
input S4's pause UI was supposed to be designed from. Two things were **not** recorded, and S1 says so
itself rather than guessing:

- ⚠️ **The `AppState` sequences were never captured.** Lock, app-switch and Siri produce different
  ones and S1 flagged this as owed to S4.
- ⚠️ **What test E actually looked like** — recovered by itself, or recovered because the tester
  restarted — is not written down. "E passed" is the whole record.

**This does not block S4, and the reason is the point of §3.** A design keyed on *AppState sequences*
would be blocked: it would need those observations before a line could be written. The design in §3 is
keyed on **`onDisconnect`'s reason**, which is a typed value from the SDK, readable in source today,
and true regardless of which iOS path produced it. `AppState` stays what S1 made it — an observation
logged to the scrollback — and never becomes a control input.

**Also from S1, and relevant:** `maxDurationSeconds` is a registry field defaulting to **1800 s**
(`apps/web/src/agent/prompts/index.ts:24`), applied to all four tutor agents. A lesson can run half an
hour. At 30 minutes the *agent* ends the call, which arrives as a specific disconnect reason (§3.2) and
deserves its own copy — "the tutor ended the session", not "something went wrong".

---

## 2. `LessonTutor.tsx`, read fresh — the port inventory

504 lines, unchanged on `master` since the creation doc measured it. Block by block, with line refs.

| Lines     | Block                                   | Verdict                       | Note                                                                                    |
| --------- | --------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------- |
| 3–22      | imports                                 | **rewrite**                   | `@elevenlabs/react-native`, no `next/navigation`, no Base UI                             |
| 49        | `VersionOption`                         | **delete**                    | superseded by `AgentVersionSummary` in `@tutor/shared/api` (S3 D29)                      |
| 52–55     | `PauseReason`                           | **redesign**                  | §3.2 — different set, different source                                                   |
| 58        | `HIDE_GRACE_MS`                         | **delete**                    | there is no hide to grace                                                                |
| 60        | `ACTIVITY_PING_MS`                      | **delete**                    | with `sendUserActivity` — D36                                                            |
| 74–79     | version state + options mapping         | **ports**                     | source becomes `GET /api/v2/agent-versions`                                              |
| 80–95     | `lines` / `carried` / refs              | **ports verbatim**            | the mirrors exist for the same reason: callbacks close over first render                 |
| 98–106    | `snapshot()`                            | **ports**                     | feeds the journal only; there is no beacon                                               |
| 110–127   | `persistSession`                        | **ports, retargeted**         | `apiFetch(API_V2_ROUTES.lessonSession)` instead of the server action; no `router.refresh` |
| 129–146   | `useConversation` callbacks             | **ports + 2 additions**       | `onAgentResponseCorrection` (D34), `onConversationMetadata` tripwire (S3)                |
| 160       | `useKeepAwake`                          | **delete**                    | D40 — and `useWakeLock: false` stays                                                     |
| 161–165   | `useAudioHealth`                        | **delete**                    | §3.1 — replaced by the disconnect reason, not by another poller                          |
| 171–184   | proactive kickoff / resume effect       | **ports verbatim**            | the single most valuable block in the file                                               |
| 191–202   | `pauseSession`                          | **simplifies**                | no beacon; reason now comes *in*, rather than being decided by the caller                |
| 206–207   | `pauseRef`                              | **delete**                    | it exists to survive re-render inside DOM listeners; there are none                      |
| 211–229   | visibility / `HIDE_GRACE_MS` dance      | **delete**                    | creation doc §1                                                                          |
| 233–235   | audio-health → pause                    | **delete**                    | ditto                                                                                    |
| 239–250   | `pagehide` / `freeze` beacons           | **delete**                    | ditto                                                                                    |
| 254–272   | `sendUserActivity` pings                | **delete**                    | D36 — the agent has no idle timeout configured                                           |
| 276–303   | journal recovery on mount               | **ports**                     | storage swaps to `expo-sqlite/kv-store`; the logic is identical                          |
| 305–351   | `start()`                               | **ports, two edits**          | drop `getUserMedia` pre-flight; token route instead of signed URL                        |
| 354–357   | `resumeSession`                         | **simplifies**                | no `resumeAudio()` — the SDK owns the audio session                                      |
| 359–362   | `dismissPause`                          | **ports verbatim**            |                                                                                           |
| 365–381   | `pauseCopy`                             | **rewrite**                   | new reasons, new copy, and one case that names microphone denial                         |
| 383–490   | JSX                                     | **rewrite**                   | ~110 lines of Base UI + inline CSS → RN + Expo UI                                        |
| 493–504   | `ConversationProvider` wrapper          | **delete**                    | already mounted in `apps/mobile/src/app/_layout.tsx`                                     |

**Score:** ~210 lines port (several verbatim), ~200 are deleted, ~90 are JSX rewritten against
different primitives. Plus **two new** blocks with no web ancestor: the unmount guard (§3.5) and the
lesson fetch (§5).

**The web file is not edited.** D4 stands: `/api/v2` is additive and `LessonTutor.tsx` keeps its
browser workarounds, because the browser still needs them.

---

## 3. The state machine — the one part that is not mechanical

### 3.1 What the native stack actually reports

Read from the installed packages, not from documentation.

**a. There is no interruption event.** Grepping `@livekit/react-native@2.9.8` (`src/`, `ios/`) and
`@livekit/react-native-webrtc@137.0.3` for `interruption` returns exactly one file —
`ios/AudioUtils.swift` — and only as two `AVAudioSession` *category option names*
(`interruptSpokenAudioAndMixWithOthers`, `overrideMutedMicrophoneInterruption`) being translated from
JS config. **No listener, no emitter, no event.** The native interruption notification is not bridged
at this version. Anything written against "handle the real iOS interruption event" would not compile
into a working behaviour.

**b. What you get instead is a typed reason** — `@elevenlabs/client/dist/types.d.ts:28`:

```ts
export type DisconnectionDetails =
  | { reason: "error"; message: string; context: DisconnectionContext; closeCode?; closeReason? }
  | { reason: "agent"; context?: DisconnectionContext; closeCode?; closeReason? }
  | { reason: "user" };
```

and `dist/utils/WebRTCConnection.js:271–291` is where the WebRTC transport produces them:

| Source                                                | Becomes                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------- |
| `RoomEvent.Disconnected`                              | `reason: "agent"`, `context: { type: "close", reason: <LiveKit reason> }` |
| `RoomEvent.ConnectionStateChanged` → `Disconnected`   | `reason: "error"`, `message: "LiveKit connection state changed to …"`     |
| `endSession()` (`dist/BaseConversation.js:73`)        | `reason: "user"`                                                          |

**c. LiveKit's own reconnection sits below this line.** `Room` retries internally and the SDK
subscribes to neither `Reconnecting` nor `Reconnected`, so a transient blip never reaches the app —
only a *terminal* disconnect does. That is why `status` has four values and none of them is
`"reconnecting"` (`@elevenlabs/react/dist/conversation/ConversationStatus.d.ts:1`).

**Consequence for the design:** the web app *inferred* trouble (poll the volume, watch
`visibilitychange`) because the browser told it nothing. Native is told. Every inference goes; the
reason becomes the input.

### 3.2 The pause machine, re-derived

```ts
/** Why the session is not running. Sourced from `onDisconnect`, never inferred. */
type PauseReason =
  | "dropped"    // reason: "error"  — the connection failed (network, audio graph, LiveKit)
  | "ended"      // reason: "agent"  — the tutor or the server ended it (max_duration, end_call)
  | "recovered"; // a journal from a previous run was found at mount
// reason: "user" produces NO card: the learner pressed End and knows it.
```

| Reason        | Copy                                              | CTA                | Offers resume context? |
| ------------- | ------------------------------------------------- | ------------------ | ---------------------- |
| `"dropped"`   | "The session dropped — your transcript was saved" | **Resume session** | **yes**                |
| `"ended"`     | "The tutor ended the session"                     | Start another      | yes, but say so        |
| `"recovered"` | (web copy, unchanged)                             | Continue           | **yes**                |
| `"user"`      | —                                                 | Start              | no — cleared           |

Three notes that are the whole design:

- **`"background"` is gone and nothing replaces it.** That is S1's result cashed in: backgrounding is
  not an event the tutor reacts to. If iOS ever *does* kill a backgrounded session it arrives as
  `"dropped"` and the learner gets a resume card — correct behaviour, no special case.
- **`"ended"` at 30 minutes is a success, not a failure**, and the copy must not apologise. Reaching
  `max_duration_seconds` is the agent hanging up politely.
- **A denied microphone is not a disconnect.** The SDK triggers the OS prompt itself inside
  `AudioSession.configureAudio()` / `startAudioSession()` (`@elevenlabs/react-native/src/index.react-native.ts:41–50`),
  so a denial surfaces through `onError` before a session exists. `onError` copy must name it —
  creation doc §4, and the S3 probe screen already words it that way.

### 3.3 Kickoff and resume

The effect at `LessonTutor.tsx:171–184` ports **verbatim**. What changed underneath, and why it is
safe:

```ts
if (status === "connected" && !kickedOff.current) {
  kickedOff.current = true;
  const resumeFrom = resumeContextRef.current;
  resumeContextRef.current = null;
  if (resumeFrom?.length) {
    sendContextualUpdate(formatResumeContext(resumeFrom)); // ← the one unexercised call
    sendUserMessage(RESUME_MESSAGE);
  } else {
    sendUserMessage(KICKOFF_MESSAGE);
  }
}
```

Both calls funnel into `WebRTCConnection.sendMessage` (`dist/utils/WebRTCConnection.js:376–390`):

```js
if (!this.isConnected || !this.room.localParticipant) { console.warn(…); return; }   // silent drop
const data = new TextEncoder().encode(JSON.stringify(message));
await this.room.localParticipant.publishData(data, { reliable: true });
```

- **Reliable and ordered.** The contextual update cannot arrive after the resume message.
- **S3 already proved this path works**: `sendUserMessage(KICKOFF_MESSAGE)` goes through the same
  function, and the tutor spoke first on both native sessions.
- **The guard is a silent drop, and `status === "connected"` is what clears it.** `isConnected` is set
  on `RoomEvent.Connected` (line 272). Sending any earlier warns to the console and vanishes — which
  is exactly why the effect is keyed on `status` and must stay that way.

**So the remaining risk is not transport, it is semantics:** whether the ElevenLabs *server* applies a
`contextual_update` that arrives over a data channel the same way it applies one over the socket.
Source cannot answer that. It is a gate item (§9 T4), not an assumption.

**`onConversationMetadata` stays optional.** S3 never saw it fire on WebRTC and never saw it disagree.
Keep the tripwire (it costs one callback), and never make anything wait on it.

### 3.4 The save guard, unchanged and still correct

Four writers converge on one `lesson_sessions` row keyed by `conversation_id`
(`packages/shared/src/tutor.ts:22–26`). Native is the fourth. The rule S3 proved:

1. `conversationIdRef.current = body.conversationId` **before** `startSession`. Never written by a callback.
2. `savedForRef` keyed on that id; on failure, **un-guard so a retry is possible** (S3's `index.tsx:118`).
3. `onDisconnect` → `persistSession()` — for every reason including `"user"`.
4. The server sanitizes regardless (`persistTutorSessionFor` → `sanitizeTranscript`).

**One native-only addition:** also persist on **unmount** (§3.5). On the web, leaving the page tears
the whole runtime down; here it does not.

### 3.5 ⚠️ The failure the web app cannot have: the conversation outlives the screen

Two facts, both already in the repo:

- `apps/mobile/src/app/_layout.tsx:24` mounts `ConversationProvider` **above the router's `Stack`**.
  The conversation's state lives in the root layout, not in the screen. Unmounting the screen does not
  touch it.
- `app.config.ts:101` sets `UIBackgroundModes: ["audio"]` — the entire point of S1. iOS will not
  suspend the app when it leaves the foreground.

Together: **navigate back from the tutor screen mid-session and the session keeps running** — mic
live, agent talking, ElevenLabs minutes billing, and no UI anywhere that says so. The learner's next
action is to lock the phone and put it in a pocket. On the web this is impossible, so there is no
prior art to port.

```ts
// The native-only invariant: a tutor session may not outlive the screen that owns it.
useEffect(() => () => {
  if (statusRef.current === "connected") {
    void persistSession();   // save what was said
    endSession();            // then stop the audio session and the billing
  }
}, []);
```

Ordering is deliberate: `endSession()` triggers `onDisconnect` → `persistSession()`, but the component
is unmounting and that callback's closure may not survive to complete a network call. Persist first;
the guard makes the second attempt a no-op.

---

## 4. Decisions

Numbering continues from S3's D29.

### D30 — `GET /api/v2/lessons/:id` returns one response, and item history is **not** in it ✅

`{ lesson: LessonDetail, sessions: LessonSession[], sessionCount: number }`, assembled from
`getLesson(ownerId, id)` and `listLessonSessions(ownerId, id)` — the same two functions
`apps/web/src/app/lessons/[id]/page.tsx:119–125` already calls. No new query, no new shape.

Three round trips for one screen is three chances to half-load, three spinners, and three error
states, for data that is always wanted together and is one owner-scoped read on the server.

**Item history is dropped from S4's scope** — deliberately, against the build plan's bullet. It powers
the web's "Word changes" disclosure, which is *editing* history; the tutor screen neither shows nor
needs it. It belongs with S5's add/remove UI, where the events it lists are actually generated. The
build plan's S4 row is being narrowed, not silently skipped; S5's row picks it up.

**`itemsDetailed` is sent fat and formatted on the client** — `formatItemsList` is the shared tutor
wire contract (`@tutor/shared/tutor`), and the web builds it client-side too. Both clients must agree
on `{{items_list}}` byte-for-byte; that is precisely what makes it shared code rather than server code.

### D31 — `sessions` is capped at 20, and the cap is reported ✅

`listLessonSessions` has no limit. A heavy user's lesson could carry hundreds of rows, each with up to
500 transcript lines, down a cellular link, to render a collapsed list.

Cap at the **20 newest** in the route and return `sessionCount` alongside, so the screen can say
"showing 20 of 37" rather than quietly implying that is all of them. If per-session transcripts turn
out to dominate the payload, the next step is a summaries-only list plus a per-session fetch — not a
smaller silent cap.

### D32 — `withBearer` gains a route-context parameter ✅

The current signature (`apps/web/src/lib/auth/bearer.ts:76`) is
`(req: Request, ownerId: string) => Promise<NextResponse>`. Next.js hands a dynamic route handler a
**second argument** — `{ params: Promise<{ id: string }> }` — and the wrapper drops it. `/api/v2/lessons/[id]`
is the first v2 route that needs it.

Two ways: dig the id out of `new URL(req.url).pathname`, or pass the context through. The first
re-implements routing by string surgery in every dynamic route forever. So:

```ts
export function withBearer<Ctx = undefined>(
  handler: (req: Request, ownerId: string, ctx: Ctx) => Promise<NextResponse>,
): (req: Request, ctx: Ctx) => Promise<NextResponse> {
  return async (req, ctx) => {
    const ownerId = await getBearerOwnerId(req);
    if (!ownerId) return withCors(unauthorized());
    return withCors(await handler(req, ownerId, ctx));
  };
}
```

Backwards-compatible: the three existing routes ignore the third parameter and keep compiling. The
auth boundary does not move.

### D33 — pause reasons come from `onDisconnect`, never from inference ✅

§3.1–3.2. `useAudioHealth` and the visibility dance are not replaced by native equivalents; they are
replaced by **reading the reason the SDK already provides**. Corollary, and the part worth enforcing in
review: **`AppState` is logged, never branched on.** The moment a `useEffect` keys behaviour off
`AppState`, S1's result has been re-litigated in code by someone who did not have to measure it.

### D34 — wire `onAgentResponseCorrection` ✅ (new — the web app does not have it)

Fires on barge-in with `{ original_agent_response, corrected_agent_response }`. Without it, an
interrupted turn is stored as the sentence the teacher *would* have finished — a transcript that
misquotes the tutor, in an app whose entire premise is that the learner interrupts freely.

The web app has never wired it, and mostly gets away with it because the post-call webhook later
overwrites the row with ElevenLabs' own corrected transcript. "Mostly" is the problem: if the webhook
fails (as it silently did for 47 days — S3 §8), the uncorrected copy is the permanent record.

Native fixes it at the source: replace the trailing agent line when the correction arrives. **Then
port the same three lines back to the web app** — one prompt-version-independent bug, fixed once.

### D35 — the journal lives on `expo-sqlite/kv-store` ✅

Verified against [the SDK 57 docs](https://docs.expo.dev/versions/latest/sdk/sqlite/): `expo-sqlite`
ships an AsyncStorage-shaped KV API at `expo-sqlite/kv-store` (`getItem` / `setItem` / `removeItem`,
plus `…Sync` variants). Current version **`expo-sqlite@57.0.1`**.

- **First-party**, so it tracks the SDK rather than being a fourth-party native module.
- **The shape the journal actually needs is a key-value blob**, not a table: one entry per lesson,
  rewritten whole on every transcript line. `SessionJournalEntry` already serialises as JSON.
- **When the mirror lands** (D1) it will bring real SQLite tables with it, and the journal can move in
  as one more table — `expo-sqlite` is the same package either way.
- ⚠️ **This is a new native module: `pnpm native` + a fresh build.** A JS reload will not pick it up,
  and the failure looks like an unrelated crash on first write.

`AsyncStorage` is the alternative and would also work; it is a community package doing the same job
with more supply chain and no path to the mirror.

### D36 — drop `sendUserActivity` entirely ✅

It exists on the web to stop a long silence being read as an abandoned call. Two reasons it is dead
code here:

- **The agents have no idle timeout to defeat.** `sync-agents.ts` never sets
  `conversation_config.turn.silence_end_call_timeout`, so it keeps ElevenLabs' default `-1` —
  disabled (S1 §5.3).
- **Its triggers do not exist.** The web pings on `pointerdown` / `keydown` / `scroll`. A learner in a
  voice lesson touches nothing; scrolling a transcript is not evidence of presence, and *talking* —
  which is — already produces traffic.

Keeping it would mean porting three DOM listeners into RN gesture handlers to defend against a
timeout that is switched off.

### D37 — keep the combined `useConversation`; do not split the hooks yet ✅

The RN package re-exports `useConversationControls` / `useConversationStatus` / `useConversationMode` /
`useConversationInput` (`@elevenlabs/react-native/src/index.ts:10–13`), and `useConversation`'s own
JSDoc calls itself "less performant". True, and still not the trade to make now: the combined hook is
what keeps the port a port, and the screen it renders is a header, two buttons and a list.

**Cheap things first**, in order: `FlatList` instead of mapping an array; a `memo`'d row; `keyExtractor`
by index+role. If a real lesson's transcript still janks, split the hooks then — with a number.

### D38 — exercise `sendContextualUpdate` as a gate item, not a code review item ✅

§3.3: transport verified in source and already proven by the kickoff; **server-side handling of a
contextual update over WebRTC is not verifiable from source**. So the gate carries an explicit test
whose pass condition is behavioural — the resumed tutor continues the lesson instead of greeting the
learner again (§9 T4).

### D39 — Expo UI, applied narrowly: RN owns layout and scrolling ✅

D3's first use in anger. The split:

| Element                      | Built with                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------- |
| screen scaffold, transcript  | RN — `SafeAreaView`, `View`, `FlatList`                                      |
| version picker               | `@expo/ui/swift-ui` `Picker` in a fixed-height `Host`                        |
| Start / End, resume-card CTA | `@expo/ui/swift-ui` `Button` in a `Host` with `matchContents`                |
| pause card, status line      | RN `View` + `Text`                                                           |

This is the shape S0 §2 warns about, taken seriously the first time it applies: **`matchContents` on
the same axis as a scroll container silently stops scrolling.** The transcript is the one scrolling
thing on the screen, so it stays outside SwiftUI entirely. `matchContents` is used only on
intrinsically-sized content (`Button`), which is exactly what S0 says it is for.

S4 is therefore a *small* Expo UI bet on a screen where a mistake is obvious. S6 makes the big one.

### D40 — never hold the screen awake ✅

`useKeepAwake` + `@zakj/no-sleep` (~200 lines across two files, including a failure banner) exist
because a locked browser tab ends the session. S1 measured that a locked *app* does not. `expo-keep-awake`
is available transitively and stays unused; `startSession({ useWakeLock: false })` stays as S3 set it.

The web behaviour was never a feature. It was an apology.

### D41 — a session may not outlive the screen ✅

§3.5. Unmount ends and persists. This is the one behaviour with no web ancestor, so it also gets an
explicit gate test (§9 T5) rather than trusting a cleanup function nobody watches run.

### D42 — the screen fetches by id; **one** hard-coded id remains, as navigation only ✅

S5 builds the lessons list. Until then something has to name a lesson. The distinction that keeps this
from rotting: **the id is a route parameter the screen receives, never a constant the screen reads.**
`app/index.tsx` keeps a single `Link href={/lessons/${DEV_LESSON_ID}}` — one line, deleted the moment
S5's list exists — while `app/lessons/[id].tsx` fetches everything about that lesson from the server.

S3's three literal `LESSON_ITEMS` are deleted outright. Fabricated lesson data is exactly what
`GET /api/v2/lessons/:id` exists to end.

### D43 — keep S3's probe screen, move it to `/probe` ✅

`index.tsx` today is the S1 suspension probe wearing S3's token route. It is the regression instrument
for every SDK, LiveKit and iOS upgrade — drift, uplink/downlink turn counts, `AppState` transitions,
both B3 tripwires — and none of that belongs on a screen a learner sees.

Move it to `app/probe.tsx` intact; make `app/index.tsx` a trivial launcher (link to the lesson, link to
`/auth`, link to `/probe`). Deleting a working instrument to keep the router tidy is a bad trade the
first time an upgrade misbehaves.

---

## 5. The server

### 5.1 The route

```ts
// apps/web/src/app/api/v2/lessons/[id]/route.ts
import type { LessonDetailResponse } from "@tutor/shared/api";
import { withBearer } from "…/lib/auth/bearer";
import { apiError, json, preflight } from "…/lib/http";
import { getLesson, listLessonSessions } from "…/lib/lessons";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

/** Everything the tutor screen needs on first paint, in one owner-scoped read. */
export const GET = withBearer<{ params: Promise<{ id: string }> }>(async (_req, ownerId, ctx) => {
  const { id } = await ctx.params;

  const lesson = await getLesson(ownerId, id);
  // 404 for "not yours" as well as "not there" — `getLesson` is already owner-scoped, and
  // distinguishing the two would leak which ids exist (the v2 rule set at S3 D24).
  if (!lesson) return apiError(404, "not_found", "No such lesson.");

  const all = await listLessonSessions(ownerId, lesson.id);
  const body: LessonDetailResponse = {
    lesson,
    sessions: all.slice(0, MAX_SESSIONS),   // D31 — newest first, capped
    sessionCount: all.length,               // …and the cap is visible to the client
  };
  return json(body);
});
```

`getLesson` already filters `deleted_at` and `lesson_items.removed_at`, and orders by `position` — so
`itemsDetailed` arrives in the order the learner sees on the web, which is the order `formatItemsList`
numbers them in. Nothing to re-derive.

### 5.2 The contract addition

In `packages/shared/src/api.ts`, beside the rest:

```ts
/** `GET /api/v2/lessons/:id`. */
export function lessonPath(id: string): string {
  return `${API_V2}/lessons/${encodeURIComponent(id)}`;
}

/** `GET /api/v2/lessons/:id` — 200. */
export interface LessonDetailResponse {
  lesson: LessonDetail;
  /** Newest first, capped server-side (D31). */
  sessions: LessonSession[];
  /** Total the learner has, so a capped list can say so instead of implying completeness. */
  sessionCount: number;
}

export function isLessonDetailResponse(body: unknown): body is LessonDetailResponse { … }
```

`API_V2_ROUTES.lessonSession` is `/api/v2/lessons/session` and the new route is
`/api/v2/lessons/[id]` — **`session` is a literal segment and Next matches literals before dynamic
ones**, so the two coexist. Worth stating because it looks like a collision and is not; the one thing
never to do is name a lesson `session`, which uuids prevent.

`lessonPath` joins `signedUrlPath` and `conversationTokenPath` as the third path-building function.
The rule stays: paths are built in `@tutor/shared/api` and nowhere else.

---

## 6. The app

### 6.1 Files

```text
apps/mobile/src/
  app/
    _layout.tsx            (unchanged — ConversationProvider already mounted)
    index.tsx              → trivial launcher (D42, D43)
    probe.tsx              ← today's index.tsx, moved verbatim (D43)
    auth.tsx               (unchanged)
    lessons/[id].tsx       ← NEW: the tutor screen
  lib/
    session-journal.ts     ← NEW: expo-sqlite/kv-store (D35)
  api.ts                   (unchanged)
```

Only `lessons/[id].tsx` is real work. `typedRoutes: true` is on (`app.config.ts:125`), so the `Link`
in `index.tsx` is type-checked against the file that exists.

### 6.2 The screen's shape

```tsx
export default function LessonTutorScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  // 1. fetch — lesson + sessions + versions, in parallel, once
  // 2. the ported state machine (§2's inventory, §3's reasons)
  // 3. render: header · version picker · Start/End · pause card · live transcript · history
}
```

Three fetches on mount, in one `Promise.all`: `lessonPath(id)`, `API_V2_ROUTES.agentVersions`, and
nothing else — the token is minted at Start, never at mount (S3 D28: it lives 900 s and mints the
conversation id with it).

`agent-versions` is a separate call on purpose. It is not lesson data, it changes on deploy rather than
on edit, and folding it into the lesson response would make every lesson fetch depend on the agent
registry.

### 6.3 The journal

```ts
// apps/mobile/src/lib/session-journal.ts
import Storage from "expo-sqlite/kv-store";
import type { SessionJournalEntry } from "@tutor/shared/mirror-store";
import { sanitizeTranscript } from "@tutor/shared/tutor";

const key = (lessonId: string) => `journal:${lessonId}`;
```

Same three functions as the web's (`writeJournal` / `readJournal` / `clearJournal`), same
best-effort-swallow-everything discipline — *a journal write must never break a running conversation* —
and **`beaconJournal` does not exist**: there is no page teardown to outrun.

`SessionJournalEntry` is reused from `@tutor/shared/mirror-store` rather than re-declared. The type is
already pure and already shared; only the storage behind it is per-platform, which is the same split
`MirrorStore` makes (CLAUDE.md).

**Its job changed and the copy should reflect that.** On the web the journal catches a tab iOS
discarded. Here it catches a crash or a force-quit. Both end with a transcript on disk and no row on
the server, so the recovery flow is identical — but "your last session ended unexpectedly" is now a
true statement about a rare event rather than a routine Tuesday.

---

## 7. Deliberately not built at S4

So that none of it gets re-argued mid-stage:

- **The lessons list, and any lesson editing** — S5. S4 reads one lesson by id.
- **Item history / "Word changes"** — S5 (D30).
- **The offline mirror and the outbox** — D1. The journal is not a mirror; it is one blob per lesson
  with no ops, no replay order and no reactivity.
- **Split conversation hooks** — D37, until measured.
- **CallKit, `useIOSAudioManagement`, LiveKit 2.12** — S1 ended on rung zero and nothing here moves it.
- **Android anything** — D2.
- **`sendUserActivity`, keep-awake, audio-health polling, visibility handling, beacons** — D33, D36, D40.

---

## 8. Test plan — on the phone

Same two rules as S1, and for the same reason: **no debugger attached, Release configuration.** A
debugger prevents the suspension that half of this is about.

**Setup:** a real lesson with ≥3 enriched words, and its id in `index.tsx`. A second device or the web
app open on `/lessons/<id>` to watch history land.

| #      | Test                                                                                                    | Pass                                                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **T1** | Open the lesson. Read the header, the word count, the version picker, the history list.                 | Real lesson title, the real words, versions from the registry, past sessions listed — **no hard-coded anything**         |
| **T2** | Start. Let the tutor greet and teach the first word. Answer it. End with the button.                     | Tutor speaks first; both directions transcribed; on End, the transcript appears in this lesson's history on **the web**  |
| **T3** | Start. Lock the phone. Keep talking for 2 min. Unlock.                                                   | Session still connected, both directions still in the transcript, **no pause card ever appeared**                        |
| **T4** | **The resume flow (D38).** Start, teach one word, force a drop (airplane mode ~10 s, then off). Resume. | A `"dropped"` card; on Resume the tutor **continues** — it does not greet or restart the lesson from word one            |
| **T5** | **The unmount guard (D41).** Start, talk, then navigate back with the gesture.                          | Audio stops immediately; the transcript is in history; **nothing is still speaking 30 s later**                          |
| **T6** | Force-quit mid-session. Reopen the lesson.                                                              | "Your last session ended unexpectedly", the transcript is offered as context, and it is **already saved** to the server  |

**T4 is the one to run twice.** It is the only test whose mechanism (a server-side contextual update
over a data channel) could not be verified from source, and "the tutor continued" versus "the tutor
greeted me again" is the entire signal.

**T2 doubles as the id check.** The row that appears on the web must carry a `conv_*` conversation id
and, a minute later, a `duration_secs` and a summary from the webhook — the same convergence S3's gate
measured, now with a real lesson under it.

---

## 9. Gate

The build plan's two criteria, made checkable:

- [x] **A real lesson's words, spoken end to end, transcript saved to that lesson's history** — T1 + T2,
      **verified in the database and against ElevenLabs**, not from the phone's UI (§14)
- [x] **Resume after an interruption continues the lesson rather than restarting it** — T4

And three that the research added, each guarding something that would otherwise ship broken:

- [x] **T5** — no session survives leaving the screen (D41; it costs money and mic access)
- [x] **T3** — the locked-screen behaviour still holds with the real screen, not the probe
- [x] **T6** — the journal recovers on a real crash path, on `expo-sqlite`

**Reported green by the tester on 2026-08-14.** T1 and T2 are independently confirmed by the evidence
in §14. ⚠️ **T3–T6 were not individually recorded**, and this file says so rather than inventing
detail — the same discipline S1 §12 used for its uncaptured numbers. What that costs is named in §14.

---

## 10. If it fails

| Symptom                                                | First suspicion                                                                                                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Screen crashes on first journal write                  | `expo-sqlite` added without a native rebuild (D35). `pnpm native` + rebuild.                                                                                 |
| `GET /api/v2/lessons/:id` 404s a lesson that exists    | The wrong owner — a stale token from a different Auth0 tenant. Check `/api/v2/me` first; it is the probe that exists for this.                               |
| 500 on that route with a valid id                      | `withBearer` not yet generic (D32) — `ctx` is `undefined` and `ctx.params` throws.                                                                           |
| Tutor greets instead of continuing on resume (T4)      | The unexercised path (D38). Check ordering first: `sendContextualUpdate` **before** `sendUserMessage`, both after `status === "connected"` — never earlier (§3.3). |
| Nothing sends, no error, console warns                 | Sent before `RoomEvent.Connected`. `sendMessage` drops silently by design (§3.3).                                                                            |
| Transcript keeps growing after leaving the screen      | D41 not wired, or wired into the wrong effect. This is the expensive one.                                                                                    |
| Two rows for one lesson session                        | Something wrote `conversationIdRef` from a callback. It is seeded once, before `startSession`, and never again (S3 D23).                                     |
| Transcript quotes sentences the tutor was cut off from | `onAgentResponseCorrection` not wired (D34).                                                                                                                |
| Scrolling silently stops                               | `matchContents` on a scroll axis (D39 / S0 §2). Not an error — just a list that will not move.                                                               |

---

## 11. Build order

1. **Server first, verified from a terminal.** `withBearer` generic (D32) → `lessonPath` +
   `LessonDetailResponse` in `@tutor/shared/api` → the route (§5.1). `curl` it with a real Bearer
   token before touching the app.
2. **`pnpm add expo-sqlite` in `apps/mobile`, then `pnpm native` and rebuild.** Do the native step
   early, when a build failure is cheap to attribute.
3. **Move `index.tsx` → `probe.tsx`; make `index.tsx` the launcher** (D42, D43). Confirm the probe
   still runs — it is the fallback instrument if anything below misbehaves.
4. **`lessons/[id].tsx`: fetch and render only.** No conversation yet. T1 passes here.
5. **Port the state machine** (§2's inventory), including the new pause reasons (§3.2) and the unmount
   guard (§3.5). T2, T3, T5.
6. **The journal** (§6.3). T6.
7. **The resume flow last**, because it depends on all of the above being stable. T4, twice.
8. `pnpm -r typecheck && pnpm -r lint`, then the six tests on a Release build with no debugger.
9. Port `onAgentResponseCorrection` back to `apps/web/src/app/lessons/[id]/LessonTutor.tsx` (D34).
10. Flip this file's status, update the build plan's Progress table, and write S5's research from its
    placeholder.

---

## 12. Is S4 ready to build?

**Yes.** Every input S3 owed it is live and proven on hardware; the port inventory is line-referenced
against the current file; the one genuinely new design — the lifecycle — is written down in §3 before
any code, which is what the placeholder asked for.

**Two things go in with eyes open:**

- **T4 (`sendContextualUpdate` semantics on WebRTC) cannot be de-risked further from source.** The
  transport is verified and already exercised by the kickoff; what remains is whether the server treats
  a contextual update the same over a data channel. If it does not, the fallback is not complicated —
  fold the recap into the resume `sendUserMessage` instead, at the cost of it being a visible turn
  rather than silent context.
- **S1's `AppState` sequences are still unrecorded**, and this design is built not to need them (§1).
  If they are wanted, `probe.tsx` still logs them and D43 is why it still exists.

**One thing S4 will find that nothing else could:** whether a 30-minute lesson on a real vocabulary
list is a good *product*. Every stage so far measured whether the machine works. This is the first one
a learner could use.

---

## 13. Implementation — built 2026-08-14, statically verified

Built in the order §11 specifies. Every decision D30–D43 is in the code; nothing was deferred.

### What was built

| File                                                | Change                                                                                              |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `apps/web/src/lib/auth/bearer.ts`                   | `withBearer<Ctx = undefined>` — passes Next's route context through (**D32**)                        |
| `packages/shared/src/api.ts`                        | `lessonPath`, `LessonDetailResponse`, `MAX_LESSON_SESSIONS = 20`, `isLessonDetailResponse`           |
| `apps/web/src/app/api/v2/lessons/[id]/route.ts`     | **new** — the first dynamic v2 route (**D30, D31**)                                                  |
| `apps/mobile/package.json`                          | `expo-sqlite ~57.0.1` (**D35**)                                                                      |
| `apps/mobile/src/lib/session-journal.ts`            | **new** — the journal on `expo-sqlite/kv-store`                                                      |
| `apps/mobile/src/app/probe.tsx`                     | S3's screen, moved off `/` and re-framed as an instrument (**D43**)                                  |
| `apps/mobile/src/app/index.tsx`                     | **new** — a launcher holding one lesson id as a link, deleted at S5 (**D42**)                        |
| `apps/mobile/src/app/lessons/[id].tsx`              | **new** — the tutor screen: the port, the pause machine, the unmount guard                           |
| `apps/web/src/app/lessons/[id]/LessonTutor.tsx`     | `onAgentResponseCorrection`, ported **back** to the browser (**D34**)                                |

### What the checks proved

- `pnpm -r typecheck` · `pnpm -r lint` — green across all three packages.
- `pnpm build` — the web app builds, and the route list shows **`/api/v2/lessons/[id]` and
  `/api/v2/lessons/session` side by side**. The literal-before-dynamic claim in `api.ts` is now
  observed in Next's own output rather than asserted.
- `pnpm --filter mobile check` — `expo-doctor` **20/20**, and `expo export --platform ios` bundles
  1611 modules. That is the real check on the two new native-adjacent imports: `expo-sqlite/kv-store`
  and the `@expo/ui/swift-ui` `Picker`/`Button`/modifier set all resolve in a Metro bundle.
- `expo-sqlite/expo-module.config.json` declares the `SQLiteModule` apple module, so autolinking picks
  it up without a config plugin.

### Two things found while building, both fixed

- **The unmount guard's dependency array was a bug in its own right.** Written as
  `useEffect(…, [endSession, persistSession])`, its cleanup re-runs whenever `persistSession` changes
  identity — which is whenever `load` does — so the guard against leaking a session past the screen
  would instead **end the lesson mid-sentence**. It now reads both callbacks through a ref updated on
  every render, with an empty dependency array. "Runs once, reads the latest."
- **`findLastIndex` does not compile in `apps/web`.** Its `lib` target predates ES2023. The native
  file keeps the call (Expo's tsconfig is newer); the web copy is a backwards `for` loop, because
  raising a compiler-wide target for one three-line callback is the wrong trade.

### Where the B3 tripwires live now

The **`onConnect` id check ported to the product screen** — it is the guard against a silently forked
history, and it now says so in words a learner can read ("the transcript is still saved correctly")
rather than in a debug log. **`onConversationMetadata` did not**: it has never once been observed
firing on WebRTC (S3), so a product screen listening for it would carry a callback that has never
proved it can fire. It stays in `probe.tsx`, which is where an unobserved signal belongs.

### `expo-sqlite`'s config plugin is deliberately not added

`expo install` prints "add `expo-sqlite` to plugins". Read `plugin/build/withSQLite.js`: every branch
is `if (value !== undefined)`, so with no props it writes nothing to the Podfile or Gradle properties.
The suggestion is generic. Recorded in `session-journal.ts` so the next person does not re-litigate it.

### What this does not tell us

Everything in §8. A bundle that builds says nothing about whether the tutor speaks, whether a
contextual update over a data channel resumes a lesson (**T4**, the one unexercised path), or whether
the unmount guard actually fires (**T5**). ⚠️ **`expo-sqlite` is a new native module: the installed
app must be rebuilt.** A JS-only reload of the S3 binary will crash on the first journal write, and
the crash will look unrelated to anything in this stage.

---

## 14. Result — and what S4 hands to S5

**One native session on the real lesson, 2026-08-14 18:27 UTC**, read back from `lesson_sessions` and
from ElevenLabs rather than from the phone:

| Field                         | Value                                                            |
| ----------------------------- | ---------------------------------------------------------------- |
| conversation                  | `conv_2301m00rcf9aeh5sap1swtk8sj3v`                              |
| `lesson_id`                   | the real lesson — **not** S3's hard-coded constant               |
| agent version                 | `words-1.3`                                                       |
| client transcript             | 5 lines · ElevenLabs' own copy: 6 turns                           |
| `duration_secs` / `summary`   | 82 / present — the post-call webhook enriched the same row        |
| `system__channel`             | `react_native_sdk`                                                |
| `app_env`                     | `prod`                                                            |
| token id == row key == `system__conversation_id` | yes                                            |

**The proof that this ran on the S4 build and not the S3 one is `items_list`: 2541 characters.** S3's
three hard-coded items carried `details: null` and produced about thirty characters of plain numbered
lines. This payload carries RU translations, part of speech, word-family forms and example sentences
for every word — i.e. `words.details`, fetched by `GET /api/v2/lessons/:id` and formatted by
`formatItemsList`. The enrichment job's output reached the tutor over the native transport intact,
which is the first time that has been observed on a phone.

That single fact closes the two headline gate criteria on its own: the lesson was **fetched**, the
words were **real**, the conversation **happened**, and the transcript **landed on the right row** with
the webhook's enrichment on top of it.

### ⚠️ What is not in the record

**T3–T6 left no separately identifiable evidence**, and one of them would have: a successful T4 resume
mints a *second* conversation id, and only one row exists after the S4 build was installed. So either
the resume was exercised inside that one session in a way that reused it, or T4's second session was
not kept. **`sendContextualUpdate` on WebRTC therefore remains the least-evidenced claim in the
project** — reported working, not measured working.

This is a known-unknown carried into S5, not a reason to reopen S4. It is cheap to settle whenever the
resume path is next touched: two rows, two ids, and the tutor's first sentence after the reconnect.

### What S4 hands to S5

- [x] **`GET /api/v2/lessons/:id` and a generic `withBearer`** — the dynamic v2 route pattern exists,
      including 404-for-not-yours. S5's routes copy it.
- [x] **The data-fetching convention:** `Promise.all` of `apiFetch` calls in one `load()` callback,
      re-called after a write instead of `router.refresh()`. No query library was needed or added.
- [x] **The navigation shape:** `index.tsx` (launcher — **S5 deletes it**), `lessons/[id].tsx`,
      `auth.tsx`, `probe.tsx`. `typedRoutes` is on, so a bad `Link` is a compile error.
- [x] **D3 in practice:** RN primitives own layout and scrolling, `@expo/ui/swift-ui` owns discrete
      controls inside sized `Host`s. It survived contact. S6's list-shape question is untouched.
- [x] **The error/empty conventions:** one `loadError` string with a retry, `ActivityIndicator` while
      null, and copy that names the microphone case because a denial cannot surface any other way.
- [x] **`expo-sqlite` is installed and autolinked**, so the deferred mirror (D1) has its package
      already in the build.
- [ ] ⚠️ **`sendContextualUpdate` is reported working, not measured** — see above.
- [ ] ⚠️ **The hard-coded lesson id in `index.tsx` is S5's first deletion.** It is one line and a
      `Link`, exactly as D42 intended, but it is still a constant pointing at one learner's lesson.

---

## Sources

- **Read from installed package source on 2026-08-14** — the basis for §3:
  `@elevenlabs/client@1.17.0` (`dist/types.d.ts:28` — the `DisconnectionDetails` union;
  `dist/utils/WebRTCConnection.js:271–291` — `RoomEvent` → reason mapping;
  `:376–390` — `sendMessage` over `publishData({reliable:true})` and its silent `isConnected` guard;
  `dist/BaseConversation.js:73` — `reason: "user"`),
  `@elevenlabs/react@1.12.0` (`dist/conversation/types.d.ts` — the 26 `HookCallbacks`;
  `useConversation.d.ts` — the returned surface and its own "less performant" note;
  `ConversationStatus.d.ts` — four statuses, no `reconnecting`),
  `@elevenlabs/react-native@1.2.18` (`src/index.react-native.ts:41–50` — `configureAudio` /
  `startAudioSession`, i.e. why there is no mic pre-flight; `src/index.ts:8–27` — the re-export list),
  `@livekit/react-native@2.9.8` (`src/audio/AudioSession.ts`, `src/audio/AudioManager.ts`,
  `ios/AudioUtils.swift` — **grepped for `interruption`: two category-option names, no event**).
- **In-repo, read fresh on 2026-08-14:** `apps/web/src/app/lessons/[id]/LessonTutor.tsx` (504 lines,
  the §2 inventory), `page.tsx`, `session-journal.ts`, `useKeepAwake.ts`, `useAudioHealth.ts` ·
  `apps/web/src/lib/tutor-session.ts`, `lib/lessons.ts` (`getLesson`, `listLessonSessions`,
  `upsertLessonSession`), `lib/auth/bearer.ts`, `lib/agent-registry.ts` ·
  `packages/shared/src/tutor.ts`, `api.ts`, `lesson-types.ts` ·
  `apps/web/src/app/api/v2/**` (the three routes S4 extends) ·
  `apps/web/src/agent/prompts/index.ts:24` (`DEFAULT_MAX_DURATION_SECONDS = 1800`) and
  `sync-agents.ts` (**`silence_end_call_timeout` is never set** — D36) ·
  `apps/mobile/src/app/_layout.tsx`, `index.tsx`, `src/api.ts`, `app.config.ts`, `package.json`.
- [Expo — `expo-sqlite` (SDK 57)](https://docs.expo.dev/versions/latest/sdk/sqlite/) — the
  `expo-sqlite/kv-store` AsyncStorage-compatible API (D35); `expo-sqlite@57.0.1` confirmed on npm.
- [`@expo/ui` reference](https://docs.expo.dev/versions/latest/sdk/ui/) — D39's component set.
- Prior stages: [creation doc](./2026-08-12-expo-app-creation.md) §1 (what is not built — and its one
  wrong premise, corrected in §0), §4 (the native tutor), §5 (D1), §6 (screens) ·
  [S0](./2026-08-13-expo-s0-scaffold-testflight.md) §2 D3 (Expo UI, the `Host` boundary and the
  `matchContents` trap) · [S1](./2026-08-13-expo-s1-background-audio.md) §7 (the gate), §11
  (`maxDurationSeconds`), §12 (what it handed forward, including the two gaps) ·
  [S3](./2026-08-13-expo-s3-conversation-token.md) §3 (B3 re-measured), §4 D23/D24/D28/D29, §14 (the
  handover this file consumes) · [build plan](./2026-08-12-expo-build-plan.md) S4, S5, and the 🚩 gate.
- Repo conventions: `CLAUDE.md` — the `packages/shared` purity rule and the "could I fix it by
  deploying the web app alone?" test, applied in D30 and §6.3.
