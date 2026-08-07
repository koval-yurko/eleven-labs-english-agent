# Keeping the iOS web session alive for as long as the app is open

**Date:** 2026-08-07
**Status:** implemented (2026-08-07) — see §5 for what shipped and the one item deferred.
**Related:** `docs/2026-08-07-ios-locked-screen-background-voice.md` (why background is impossible),
`docs/2026-08-07-Expo-migration.md` (the native escape hatch).

Background operation is off the table in a browser. This note is about the achievable goal:
**while the tab is open and in front of the user, the session must never die and must never lie.**
Today it does both — the phone can auto-lock mid-lesson, and a transient audio interruption leaves
`status === "connected"` with a dead microphone.

---

## 1. What "always active" has to survive

| #   | Event                                                                        | What happens now                                                                                                                                     | Detectable in JS?                                |
| --- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1   | iOS idle auto-lock                                                           | usually prevented — the SDK takes a screen wake lock by default (`VoiceSessionSetup.js:69-75`) — but silently _not_ prevented when the request fails | yes (`wakeLock.request` result, `release` event) |
| 2   | Wake lock request fails (non-HTTPS origin, iOS < 16.4, installed PWA < 18.4) | swallowed by `catch (_e) {}`; screen dims → locks → session dies, looks random                                                                       | yes, if we own the request                       |
| 3   | Notification/timer sound, Siri, Control Center, another app grabbing audio   | `AudioContext` → `interrupted`; nothing in the SDK resumes it (`resume()` is only called at setup)                                                   | indirectly — see §3.3                            |
| 4   | Incoming phone call                                                          | audio session interrupted; often the mic track is gone for good                                                                                      | yes                                              |
| 5   | Brief app switch (< a few seconds)                                           | page hidden → wake lock auto-released, mic muted, audio interrupted; the socket may survive a short hide                                             | yes (`visibilitychange`)                         |
| 6   | Wi-Fi ↔ cellular handoff                                                     | WebSocket drops, `onDisconnect` fires                                                                                                                | yes                                              |
| 7   | Safari discards/reloads the tab under memory pressure                        | everything lost, including the un-saved transcript                                                                                                   | partly (`pagehide`, `freeze`)                    |
| 8   | Long user silence                                                            | ElevenLabs may time the conversation out                                                                                                             | preventable (`sendUserActivity()`)               |

Items 1–3 are the ones that actually bite in normal use. 3 is the worst because it fails _silently_.

## 2. What the SDK already does — and the two gaps

Reading `@elevenlabs/client@1.14.0`:

- ✅ Requests `navigator.wakeLock.request("screen")` on session start, default on
  (`useWakeLock?: boolean` is a public session option, `utils/BaseConnection.d.ts:52`).
- ✅ Re-acquires the wake lock on `visibilitychange → visible` (`VoiceSessionSetup.js:122-132`).
- ✅ Unlocks iOS audio inside the user gesture and stashes the context (`platform/web/audioUnlock.js`).
- ❌ **Gap 1:** the visibility re-acquire handler is installed _only if the first request succeeded_
  (`if (wakeLock)`, line 123). A single early failure = no wake lock for the whole session, no retry,
  no signal to us.
- ❌ **Gap 2:** no `statechange` listener anywhere. `resume()` is called only during setup
  (`input.js:66`, `output.js:65`, `audioUnlock.js:13`). An `AudioContext` that goes `interrupted`
  mid-session stays dead. The hook exposes no way to reach that context (`useConversation` returns
  volume/frequency getters, not the context).

So: keep the SDK's behaviour, but **own the wake lock ourselves** and **add our own interruption
detector** on top.

## 3. Proposed design — one `useSessionKeepAlive` hook

Lives next to `LessonTutor.tsx`; `LessonTutor` starts the session with `useWakeLock: false` and
delegates.

### 3.1 Own the wake lock (fixes #1, #2)

```ts
// pseudo-sketch
const lock = useRef<WakeLockSentinel | null>(null);
async function acquire() {
  try {
    lock.current = await navigator.wakeLock.request("screen");
    lock.current.addEventListener("release", () => {
      lock.current = null;
      setAwake(false);
    });
    setAwake(true);
  } catch {
    setAwake(false); // ← surfaced in the UI, not swallowed
    startVideoFallback(); // §3.2
  }
}
// retry on every visibility change, whether or not the first attempt worked
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && active) void acquire();
});
```

Two things fall out for free: a **"screen stays on" indicator** in the session UI, and a loud dev
warning when the page is served over a non-secure origin (phone → `http://192.168.x.x:3000` is the
single most likely reason a dev-mode session dies on a phone but not on a laptop; Wake Lock is
secure-context-only).

### 3.2 Video fallback where Wake Lock isn't available (fixes #2)

The NoSleep.js technique: a tiny `muted playsinline loop` `<video>` playing off-screen keeps iOS from
idling the display. Started inside the same user gesture as "Start conversation", stopped on
`endSession`. `@zakj/no-sleep` (the maintained fork of NoSleep.js) already implements
wake-lock-with-video-fallback in ~1 KB, so this is a dependency decision, not code we must write.
Worth measuring on a real device before shipping — the video trick is a workaround, not a contract,
and it costs a little battery.

### 3.3 Detect the interrupted audio pipeline (fixes #3, #4)

We cannot reach the SDK's `AudioContext`. Three ways to know it died anyway, best first:

1. **Probe context.** Create our own `AudioContext` in the same user gesture that starts the session
   and keep it alive. On iOS an interruption is a _system audio session_ event — every context in
   the page flips together — so `probe.onstatechange` firing `interrupted`/`suspended` is a reliable
   proxy for "the SDK's audio is dead too". Cheap, no internals, no monkey-patching.
2. **Volume heartbeat.** Poll `getInputVolume()` / `getOutputVolume()` (both exposed by
   `useConversation`) every ~2 s. Exactly `0` on both for ~5 s while `status === "connected"` and the
   agent is supposedly speaking ⇒ dead pipeline. Good confirmation signal, some false positives when
   the room is silent.
3. **Monkey-patch `window.AudioContext`** before `startSession`, keep the instances in a `WeakSet`,
   attach `statechange` → `resume()`. This actually _fixes_ the interruption rather than detecting it
   (`resume()` does resume an `interrupted` context, unlike libraries that only check for
   `suspended`). It is a hack against library internals — acceptable as a stopgap, but it must be
   feature-detected and it breaks the day the SDK changes its audio graph. Prefer 1+2 and file the
   gap upstream.

Response, once detected: don't pretend. Show a **"Tap to resume"** card, call `probe.resume()` on the
tap, then `endSession()` + `startSession()` — a fresh session is the only reliable recovery, because
the SDK's worklets are attached to the broken context. Continuity comes from passing the transcript
so far as a dynamic variable (see §3.5).

### 3.4 Short hide vs real background (fixes #5)

On `visibilitychange → hidden`, start a ~2 s grace timer instead of killing the session immediately —
an accidental swipe or a notification pull-down shouldn't end the lesson. If the page comes back
inside the window: re-acquire the wake lock, run the audio-health check from §3.3, resume. If it does
not: end + persist while JS still runs, and mark the session "paused by iOS" so the return renders a
Resume card rather than a zombie.

### 3.5 Never lose the transcript (fixes #6, #7)

`linesRef` lives only in memory today; a discarded tab loses everything not yet saved.

- Append each line to Dexie as it arrives — the offline machinery already exists (`src/lib/sync/db.ts`,
  `dexie`), so this is a table plus a write, not new infrastructure.
- Flush on `pagehide` and `freeze` (both fire on iOS before suspension) with
  `navigator.sendBeacon` to a save endpoint — `fetch` inside those handlers is unreliable.
- On mount, if an unsaved transcript exists for the lesson, offer "resume the previous session" so
  the tutor continues instead of restarting. The continuity is carried by `sendContextualUpdate`
  (a non-interrupting message into the agent's context, sent right before the resume kickoff), not
  by a `previous_transcript` dynamic variable as first sketched — a dynamic variable would need a
  new prompt version in `src/agent/prompts/` plus a `pnpm sync:agents` round trip, and the
  contextual update needs neither.

### 3.6 Keep the agent from timing out (fixes #8)

`useConversation` exposes `sendUserActivity()`. Ping it on real user activity (touch/scroll on the
lesson screen) so a learner who is thinking for 40 s doesn't get hung up on. Cheap, one `useEffect`.

### 3.7 Consider `connectionType: "webrtc"` (helps #6)

Not a background fix, but WebRTC handles network handoff and jitter far better than a raw WebSocket,
which is the common failure on a phone walking between Wi-Fi and cellular.

**Not a one-line change, as first assumed.** The SDK's session config is a discriminated union
(`utils/BaseConnection.d.ts`): `signedUrl` implies `connectionType: "websocket"` and forbids
`conversationToken`; WebRTC requires a `conversationToken` and forbids `signedUrl`. Switching
transports therefore means minting a conversation token server-side — a second ElevenLabs endpoint
alongside `/api/words-agent/signed-url` — not flipping a string in the component. Left for its own
change, with a device A/B before committing.

## 4. What this still cannot do

- Power-button lock — nothing prevents it; wake lock only stops _idle_ sleep.
- An answered phone call — the mic is gone; recovery is a new session afterwards.
- Anything at all with the app backgrounded (that is the other doc).
- Low Power Mode still dims aggressively; the wake lock holds, but expect a darker screen.

## 5. What shipped (2026-08-07)

| Step                                                          | Where                                                                                    |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1. Own the wake lock, badge, non-HTTPS warning                | `src/app/lessons/[id]/useKeepAwake.ts`; `startSession` now passes `useWakeLock: false`    |
| 2. Hide grace timer → deterministic save → Resume card        | `LessonTutor.tsx` (`pauseSession`, `PauseReason`, the pause panel)                        |
| 3. Probe context + volume heartbeat                           | `src/app/lessons/[id]/useAudioHealth.ts` (`interrupted` pauses, `stalled` warns)          |
| 4. Journal + beacon                                           | `session-journal.ts`, `sessionJournal` table (mirror DB v2), `POST /api/lessons/session`  |
| 5. `sendUserActivity` pings                                   | `LessonTutor.tsx`, throttled to one per 15 s of real interaction                          |
| 6. Video fallback                                             | `@zakj/no-sleep`, used only where it picks its video implementation (see §3.2)            |
| —  Resume continuity                                          | `formatResumeContext` + `RESUME_MESSAGE` in `src/lib/tutor.ts`, sent via contextual update |

The save path was pulled into `src/lib/tutor-session.ts` so the server action and the beacon route
share one validation + upsert; both are idempotent by conversation id, as is the post-call webhook.

**Deferred:** the `webrtc` transport (§3.7) — it needs a conversation-token endpoint, not a config
flag. **Not verified on a device:** everything below is desk-tested only (typecheck, lint, build, and
the beacon route's 401/400 paths). The matrix in §6 is the real acceptance test.

## 6. Device test matrix (a real iPhone, not the simulator)

Auto-lock at 30 s idle · manual power button · notification with sound · incoming call
(decline / accept) · Siri · app switch 1 s / 10 s / 60 s · Control Center pull-down · AirPods connect
and disconnect mid-session · Wi-Fi → cellular · Low Power Mode on · Safari tab vs installed PWA ·
iOS 18 and iOS 26.

Each cell asks two questions: _did the session survive?_ and _if not, did the UI say so truthfully
and save the transcript?_

## Sources

- Installed SDK internals: `@elevenlabs/client@1.14.0` — `platform/web/VoiceSessionSetup.js`,
  `platform/web/audioUnlock.js`, `platform/web/{input,output}.js`, `utils/BaseConnection.d.ts`.
- [MDN — Screen Wake Lock API](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API) ·
  [WebKit 254545 — Wake Lock in Home Screen web apps (fixed in 18.4)](https://bugs.webkit.org/show_bug.cgi?id=254545)
- [NoSleep.js](https://github.com/richtr/NoSleep.js/) · [@zakj/no-sleep](https://www.npmjs.com/package/@zakj/no-sleep)
- [WebAudio/web-audio-api#2585 — AudioContext stuck on "interrupted" in Safari](https://github.com/WebAudio/web-audio-api/issues/2585) ·
  [Tone.js#767 — `resume()` does recover an interrupted context](https://github.com/Tonejs/Tone.js/issues/767)
- [MDN — `BaseAudioContext.state` (`interrupted` on iOS)](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/state)
- [Apple — Responding to Audio Interruptions](https://developer.apple.com/library/archive/documentation/Audio/Conceptual/AudioSessionProgrammingGuide/HandlingAudioInterruptions/HandlingAudioInterruptions.html)
