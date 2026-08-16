# Background controls — driving the lesson from the lock screen

**Date:** 2026-08-16
**Scope:** `apps/mobile`. A new iOS **widget-extension target** (`apps/mobile/targets/controls/`), a
local **Expo module** for the bridge, and a **controls reducer** inside the lesson screen
(`apps/mobile/src/app/lessons/[id]/index.tsx`). Reaches `packages/shared/src/tutor.ts` only if the
current-word signal in §5.3 is built. No web work. **iOS only** — Android has no equivalent surface
(§8.1).
**Status:** **designed, not built.** Rests on the held pause shipped in `9811d28` plus the
uncommitted `setAgentAudioVolume` refinement in the working tree (`apps/mobile/src/lib/agent-audio.ts`)
— see `docs/2026-08-16-tutor-pause-hold-the-line.md`. That dependency is not incidental; it is the
reason this document exists at all (§0). The lesson screen was under active edit while this was
written, so code is quoted by behaviour rather than by line number wherever it is still moving.
Claims are tagged `[source]` (read out of the pinned packages in `node_modules`), `[docs]` (Apple or
ElevenLabs documentation), `[code]` (this repo), `[unverified]` (needs the probe in §11).

---

## The ask

While the phone is locked and the lesson is running, the learner should see and be able to touch:

1. **the list of words being learned**,
2. **pause / resume**,
3. **mute / unmute**.

The reference the ask names is the YouTube lock-screen card. That reference is misleading, and §1 is
about why: what YouTube gets is a *media transport*, and none of the three asks above is one.

---

## §0 The headline — this became possible this morning, and not because of ActivityKit

Before `9811d28`, pause meant `endSession()` and resume meant minting a fresh conversation token,
opening a new WebRTC connection, and replaying a truncated transcript tail into an agent that had
just been re-told to greet the learner and start at item one. Putting *that* behind a lock-screen
button would have been a hazard dressed as a control: one mis-tap on a phone in a pocket tears down a
billed conversation and rebuilds a worse one, from a process the learner cannot see, with no way to
undo it.

After `9811d28`, pause is a handful of synchronous calls against a connection that stays open
`[code]`:

```ts
setSilenced(setAgentAudioVolume(rawConversation, 0) > 0);   // the tutor goes quiet mid-word
setMuted(true);                                             // the learner goes private
heldAtLineRef.current = linesRef.current.length;            // mark, for the resume restatement
sendContextualUpdate(PAUSE_CONTEXT);
heartbeatRef.current = setInterval(() => sendUserActivity(), HEARTBEAT_MS);
```

No teardown, no token mint, no network round-trip on the critical path, and nothing that is wrong to
do twice. **That** is a thing a button can safely do 200 ms after a tap on a locked screen. The
lock-screen feature is not really a new capability — it is the surfacing of a capability the held
pause created.

The corollary sets the architecture, so it is worth stating before the design: **the Swift side must
never touch the ElevenLabs SDK, the audio session, or the conversation.** It posts intent; JavaScript
owns the state machine. §4.2 — and the first line of that snippet is the reason it is not negotiable.

---

## §1 Why Now Playing is not the surface `[docs]`

The YouTube card is `MPNowPlayingInfoCenter` (metadata) plus `MPRemoteCommandCenter` (buttons). Its
vocabulary on the lock screen is closed:

| The ask | What Now Playing offers | Verdict |
|---|---|---|
| a list of words | one title, one subtitle, one artwork image | **no** |
| pause / resume | `togglePlayPauseCommand` | yes — the only clean fit |
| mute / unmute | *nothing.* There is no mute remote command | **no** |

You cannot add a button. The nearest cheat is to bind `nextTrackCommand` to mute, which puts a ⏭
glyph on the control the learner must press to stop being recorded — an unlabelled, wrong-iconed
button for a privacy action. That is not a trade-off worth making.

Two further notes for accuracy:

- We do not populate `MPNowPlayingInfoCenter` anywhere today `[code]`, so no such card currently
  appears during a lesson. Audio flows through LiveKit/WebRTC, which does not register one for us.
- Now Playing is not *free* even where it fits: the transport metaphor implies a timeline and a
  seekable position, and a live conversation has neither. A scrubber that does nothing is worse than
  no scrubber.

**Now Playing is rejected outright**, not deferred. If a card is ever wanted, it is a separate
decision with a separate justification.

---

## §2 The surface that does fit: Live Activity + App Intents

- **Live Activity** (ActivityKit, iOS 16.2+) renders **our own SwiftUI view** on the lock screen. The
  word list has somewhere to live.
- **Interactive buttons inside it require iOS 17** — `Button(intent:)` `[docs]`. This is the hard
  floor for the feature.

The floor is already paid for. Expo SDK 57 pins `expo-modules-core` at `:ios => '16.4'` `[source:
apps/mobile/node_modules/expo-modules-core/ExpoModulesCore.podspec]`, and `app.config.ts` sets no
`ios.deploymentTarget` override `[code]`. So the gap is 16.4 → 17.0, which is one
`if #available(iOS 17.0, *)` in the widget view plus a capability check on the JS side — **not** a
deployment-target bump that would drop devices. Recommendation: keep the 16.4 floor and gate, so a
16.4–16.x device gets a read-only lock-screen card rather than no card.

Three things about the surface that constrain the design more than they first appear:

1. **The view is SwiftUI, in a widget extension.** There is no JS rendering path, and no wrapper
   provides one. React Native's role is to *push state* and *receive taps*.
2. **The Dynamic Island presentations are mandatory**, not optional — `compact`, `minimal` and
   `expanded` must all be supplied `[docs]`. Budget for four layouts, not one.
3. **The lock-screen presentation is capped at roughly 160 pt** `[docs]`. That is the real constraint
   on "list of words" and §5.4 spends it.

---

## §3 What "pause" and "mute" mean when pause already mutes

This is the design question the ask hides, and it has to be answered before any Swift is written.

### 3.1 The collision

The shipped `holdSession` already calls `setMuted(true)` `[code]`. So "pause" and "mute" are not two
independent booleans — pause *implies* mute. Two independent toggles on the lock screen would let the
learner reach states the app has no meaning for ("paused but unmuted"), and a naive resume would
clobber a mute the learner set deliberately.

### 3.2 One state machine, four states

| State | Mic | Output | Heartbeat | The tutor experiences | Reached by |
|---|---|---|---|---|---|
| `live` | on | on | — | a normal conversation | default |
| `muted` | **off** | on | — | silence; will re-engage after `turn_timeout` (§3.4) | Mute |
| `held` | off | **off** | **3 s** | a learner who is present but not speaking | Pause |
| `held-from-muted` | off | off | 3 s | same as `held` | Pause while muted |

`held-from-muted` is not a fifth behaviour — it is a one-bit memory (`wasMuted`) so that Resume
restores the learner's mute rather than overriding it.

The `held` row's "output: off" carries an asterisk that the lock screen inherits. Silencing the tutor
is not an SDK feature — `setVolume({ volume: 0 })` is a **silent no-op on React Native**, so
`apps/mobile/src/lib/agent-audio.ts` reaches through `useRawConversation()` to a `protected`
connection field and calls `RemoteAudioTrack.setVolume` on each agent track by feature detection
`[code]`. It returns how many tracks it reached, and **0 means the tutor is still audible**. The
in-app status line already refuses to lie about this — *"⏸ paused — microphone muted, but the tutor
may still be audible"* `[code]`. §7.6 is that sentence's lock-screen obligation.

### 3.3 A latent bug this exposes in the shipped code `[code]`

`releaseSession` currently does:

```ts
setMuted(false);
setVolume({ volume: 1 });
```

Unconditionally. That is correct **today**, because nothing else in the app can mute — pause is the
only writer of the mute bit. The moment a standalone Mute button exists, this line silently unmutes a
learner who muted on purpose and then paused. The fix belongs in this feature's first commit, not
later:

```ts
setMuted(wasMutedRef.current);   // restore, don't assume
setVolume({ volume: 1 });
```

This is the kind of coupling that argues for the reducer in §4.2 rather than more booleans: mute and
hold are one state, and one place should compute it.

### 3.4 What standalone Mute actually does to the tutor `[docs]`

A held pause keeps the agent quiet because of the heartbeat — `turn_timeout` defaults to **7 s**, and
`user_activity` resets it (this is the mechanism `docs/2026-08-16-tutor-pause-hold-the-line.md`
established). **Mute has no heartbeat**, deliberately. So a mute lasting longer than ~7 s produces a
tutor asking whether the learner is still there.

That is not a bug to paper over; it is the honest difference between the two controls, and it is what
makes both worth having:

- **Mute** = "keep teaching, I have noise around me / I need to not be recorded for a moment." The
  tutor talking on is the *point*. Output stays live.
- **Pause** = "hold everything, I am gone." Both directions silent, line held.

**Recommendation:** ship them with exactly that difference and no auto-escalation. A "mute silently
becomes a pause after N seconds" rule was considered and rejected for v1 — it makes the lock-screen
button lie about its own state, and a learner who wants a pause has a Pause button right next to it.

### 3.5 End is *not* on the lock screen

Deliberate. Ending is destructive, irreversible, triggers `persistSession`, and cannot be confirmed
on a locked device. Pause is a total substitute for it from the lock screen: a held pause that is
abandoned already degrades into a parked pause with a marker on disk `[code]`. The learner ends the
lesson by unlocking the phone.

---

## §4 The architecture

### 4.1 Five parts

```
  ┌──────────────────────── apps/mobile ────────────────────────┐
  │                                                             │
  │  lessons/[id]/index.tsx                                     │
  │    ├── controls reducer  ← the ONLY writer of session state │
  │    ├── holdSession() / releaseSession()  (already shipped)  │
  │    └── useLiveActivity(state)  ──push──┐                    │
  │                                        │                    │
  │  modules/lesson-activity/  (local Expo module)              │
  │    start / update / end   ─────────────┤                    │
  │    onControlIntent (event) ◄───────────┤                    │
  └────────────────────────────────────────┼────────────────────┘
                                           │  App Group
  ┌────────────── targets/controls/ ────────┼────────────────────┐
  │  LessonActivityAttributes.swift  (shared file, both targets) │
  │  LessonActivityView.swift        words + 2 Buttons           │
  │  ControlIntents.swift            LiveActivityIntent × 2      │
  └──────────────────────────────────────────────────────────────┘
```

1. **`LessonActivityAttributes`** — static: lesson title, item count. `ContentState`:
   `words: [String]`, `focusIndex: Int?`, `phase: "live" | "muted" | "held" | "over"`,
   `silenced: Bool`, `startedAt: Date`. `silenced` is not a nicety — §7.6.
2. **The widget view** — renders the rows, the two buttons, and the four Dynamic Island layouts.
3. **The intents** — two types conforming to `LiveActivityIntent`.
4. **The local Expo module** — `startActivity` / `updateActivity` / `endActivity`, plus an event
   emitter for taps. Local module (`npx create-expo-module --local`), not a published package: this
   is app-specific glue with no reuse story.
5. **The reducer** in the lesson screen — derives `phase` from the existing `held` / `status` /
   `wasMuted` and pushes it. One writer, one direction.

### 4.2 The single-writer rule

**Swift never calls the ElevenLabs SDK.** A tap does not mute anything; it records an *intention*,
and JavaScript decides what that intention means given the state it actually holds.

Four concrete reasons, all from the code as it stands:

- **Silencing the tutor is a feature-detected reach through a `protected` field** (`agent-audio.ts`,
  §3.2). It is defensive, it counts what it reached, and it is explicitly expected to break on an SDK
  upgrade. Reimplementing *that* in Swift, against a `Room` the extension has no handle on, is not a
  thing to attempt — and a pause that mutes the mic but not the tutor is not a pause.
- `setMuted` **throws** when there is no active conversation, and the provider resets its own mute
  state on disconnect `[code]`. A Swift button that muted directly would need to duplicate that
  guard, in a second language, against an SDK it cannot see.
- `holdSession` marks the transcript position (`heldAtLineRef`) so resume can tell whether any agent
  line landed while the speaker was silenced, and only then send the restatement `[code]`. That
  signal lives in the React tree and nowhere else.
- Resume conditionally sends `SOFT_RESUME_MESSAGE` and a `formatHeldResumeContext(pausedSeconds)`
  update `[code]`. Reimplementing that in the extension would fork the tutor wire contract that
  `packages/shared` exists to keep singular — exactly the failure mode CLAUDE.md warns about
  ("a copied `KICKOFF_MESSAGE` produces a *working* session with a silently polluted transcript").

So the tap handler is, in full: write to the App Group, post the event, return. `holdSession` and
`releaseSession` are called **verbatim**, from the same place they are called by the on-screen
buttons.

### 4.3 `LiveActivityIntent`, and why the event alone is not enough

Intents conforming to `LiveActivityIntent` `perform()` **in the containing app's process**, not the
extension's `[docs]` — which is the whole reason this design works, since the app process is alive
(background audio, active WebRTC). `AudioPlaybackIntent` is the more precise conformance if the
intent ever needs to touch the audio session; under §4.2 it does not, so `LiveActivityIntent` is the
right one.

But "the app's process is alive" is a *usually*, not an *always*. If iOS has terminated the app, it
relaunches it in the background to run the intent — and the React Native runtime will not be up, so
an emitted event lands nowhere. Hence the **intent inbox**: `perform()` writes
`{ action, at }` into App Group `UserDefaults` *and* emits. JS drains and clears the inbox on mount
and on every foreground transition, so a tap is never merely lost.

Note that in the terminated case the *session* is dead too, so draining the inbox means "show the
Paused card", not "resume a conversation". Which is the existing parked-pause path — see §7.2.

### 4.4 The shared Swift file

`LessonActivityAttributes` and the two intent types must compile into **both** targets: the extension
references them to build the view, the app references them to start/update the activity and to run
`perform()`. `@bacons/apple-targets` scaffolds the target directory but the shared-source membership
is the fiddliest part of the wiring `[unverified]` — see the P0 probe in §10.

---

## §5 What the lock screen can honestly show

### 5.1 The word list is already there `[code]`

```ts
const active = useMemo(
  () => (items ?? []).filter((i) => i.removed_at === null).sort((a, b) => a.position - b.position),
  [items],
);
```

`lessons/[id]/index.tsx`. Ordered, filtered, and it is exactly the list the tutor was given via
`formatItemsList`. Nothing new is needed to render *a* list.

### 5.2 The current word is not known — by anything `[code]`

This is the finding that most affects what the feature can promise. **The app does not know which
word the tutor is on.** The lesson is driven entirely inside the ElevenLabs agent; the prompt
registry defines no client tools (`apps/web/src/agent/prompts/types.ts` has no tool surface), so the
agent has no channel to tell us it has moved on. The client sees a transcript, not a lesson state.

This is the same gap `docs/2026-08-16-tutor-pause-hold-the-line.md` §6 names — "what we carry is
dialogue, never lesson state" — arriving from a different direction.

### 5.3 Three ways to close it

| Option | Cost | Fidelity | Verdict |
|---|---|---|---|
| **A. No highlight.** Show the list as a static reminder of the lesson's scope | zero | honest, low | **ship this in v1** |
| **B. Client-side transcript matching** — mark a word "covered" when its `norm_key` appears in an agent turn | moderate; belongs in `packages/shared` as a pure function | guesswork. Misses paraphrase, false-positives on incidental use | no |
| **C. A client tool** on the agent (`mark_item_covered`) wired into the prompt registry | a new prompt version, `sync:agents`, a lock-file bump, and a real tool contract | exact, and it is lesson *state* — reusable by the parked-pause resume, progress UI, and §6 of the pause doc | **the right long-term answer, separately** |

**Recommendation:** v1 ships option A. Option C is genuinely valuable but it is a *lesson-state*
feature that happens to have a lock-screen consumer — building it inside this feature would put a
tutor-protocol change behind a Swift widget, which is the wrong dependency order. Ship the card, then
propose C on its own merits; the `ContentState.focusIndex` field is there from day one, nullable, so
adopting C later is a JS-side change with no Swift edit.

### 5.4 Spending the 160 pt

At ~160 pt with a header row, a status line and a button row, the realistic budget is **4–5 word
rows** — against a `MAX_ITEMS` lesson that is much larger. So "the list of words" on the lock screen
is necessarily *a window into* the list, and the window must be chosen by a rule the learner can
infer without being told. With no focus index (§5.3 option A), the only honest rule is **the first N
in lesson order, plus a `+K more` affordance**. Truncation must be visible; a silently cut list reads
as a wrong list.

---

## §6 Constraints, and what each one costs us

| Constraint | Source | What it costs here |
|---|---|---|
| Lock-screen view ≈ 160 pt | `[docs]` | §5.4 — the list is a window, never the lesson |
| `ContentState` must stay small and `Codable` | `[docs]` | send word *strings* only, never `LessonItem` rows |
| An activity can only be **started** from the foreground | `[docs]` | fine: start it in `startSession`, which is a foreground tap |
| Updates work from the background | `[docs]` | fine: `UIBackgroundModes: ["audio"]` already keeps us unsuspended `[code]` |
| 8 h active, then system-ended | `[docs]` | irrelevant — `max_duration_seconds` is 1800 |
| Interactive buttons need iOS 17 | `[docs]` | one `@available` gate; 16.4–16.x gets a read-only card (§2) |
| Dynamic Island layouts are mandatory | `[docs]` | four layouts, not one |
| **The mic indicator stays on during a held pause** | `[source]`, pause doc §4.2 | §7.4 — this matters *more* here than in-app |
| No Android equivalent | `[docs]` | §8.1 |

---

## §7 Failure modes

### 7.1 A stale activity outliving its session

The worst failure: a lock-screen card with live-looking buttons for a conversation that has ended.
The rule is that **`endActivity` is called from exactly the places `persistSession` is** — the
`onDisconnect` path, the End button, and the unmount guard `[code]` — and that the `status` effect
which already clears a stranded hold — and now also resets `silenced` — also pushes `phase: "over"`. A
card in `phase: "over"` renders its buttons disabled, so a tap on a stale card cannot mint anything.

### 7.2 The app was terminated

Intent taps drain from the inbox (§4.3) into the *parked* pause path that already exists — the marker
on disk, the "Paused" card, resume-by-reconnect. Degraded and repetitive, which is precisely what
`docs/2026-08-16-tutor-session-pause-resume.md` records as the involuntary floor. The lock screen
does not make this worse; it must simply not pretend otherwise.

### 7.3 The line drops while the phone is locked

`onDisconnect` fires, the hold is cleared, and the activity must be updated to `"over"` in the same
breath. Otherwise the learner unlocks to find a card that says "paused" about a lesson that died ten
minutes ago. This is the update that is easiest to forget and most visible when missed.

### 7.4 "Muted" and the orange dot

`setMuted(true)` reaches LiveKit's `track.mute()`, which stops the capture *device* only when the
track was published with `stopMicTrackOnMute` — and the ElevenLabs SDK does not `[source, pause doc
§4.2]`. So a held pause is muted but still capturing, and iOS shows the microphone indicator.

In-app we handle this with copy: *"⏸ paused — microphone muted, the tutor is waiting"* `[code]`. On a
locked screen the learner sees the orange dot **next to our card**, with no other explanation
available. The card must therefore carry that sentence itself, in the paused state, in words. This is
not polish; it is the difference between "paused" and "this app is recording me while it says it is
paused".

### 7.5 Update storms

`phase` changes are rare, but a naive `useEffect` on the whole state object would push on every
render. Push only on a **shallow diff of `ContentState`**, and never on transcript activity.

### 7.6 The tutor was not actually silenced

`setAgentAudioVolume` returning `0` means the pause muted the microphone but left the tutor audible
(§3.2). In-app that is a status-line variant. **On a locked screen it is the whole experience**: the
learner presses Pause, the card says paused, and a teaching monologue keeps playing out of the phone.

So `silenced: false` must change the card's own words, exactly as it changes the status line — and
the `phase: "held"` layout needs both copies designed, not one copy plus a warning icon. This is also
the single most likely thing to regress silently on an ElevenLabs SDK upgrade, since the hatch is
feature-detected by construction, and the lock screen is where a regression would be least visible to
us and most visible to the learner.

### 7.7 Double taps and races

A tap arriving between `onDisconnect` and the status effect hits `holdSession`'s `if (!connected || heldRef.current) return` guard `[code]` — already correct, and another reason the taps route through
the existing functions rather than new ones.

---

## §8 Deliberately not built

1. **Android.** No equivalent surface exists; the closest is an ongoing notification with a different
   interaction model and different constraints. The module's JS API no-ops off iOS — worth stating
   because `apps/mobile` still carries `react-native-web` `[code]`.
2. **A Now Playing card.** §1.
3. **ActivityKit push updates.** Push tokens exist for updating an activity when the app is *not*
   running. Our app is running by construction — it is holding a WebRTC session. Adding a push path
   would mean an APNs key, a server route, and a second source of truth for state, to solve a problem
   we do not have.
4. **End from the lock screen.** §3.5.
5. **Auto-escalation of mute into pause.** §3.4.
6. **A current-word highlight.** §5.3 — deferred to a lesson-state feature, with the field reserved.

---

## §9 Build and release cost (the part that is easy to under-budget)

An app extension is a **second bundle identifier per variant**
(`work.kovalchuk.yurii.english-tutor{suffix}.controls`), and that has knock-on effects:

- **A second provisioning profile per variant.** `apps/mobile/credentials.json` is in EAS *local*
  credentials mode with a single profile path `[code]`. Multi-target local credentials use the
  per-target keyed form `{"ios": {"<target>": {...}}}` `[docs, unverified]` — this must be
  restructured and new profiles generated, for development, preview *and* production.
- **The App Group must be registered on the Apple Developer portal** and added as an entitlement to
  **both** targets, or the shared `UserDefaults` silently returns `nil` — a failure with no error.
- **`NSSupportsLiveActivities: true`** in the app's `infoPlist`, alongside the existing
  `UIBackgroundModes` `[code]`.
- **A new dev-client build.** None of this is reachable from the existing binary, and none of it is
  reachable from Expo Go at all.
- **`privacyManifests`** — the extension is a new binary. Re-run the `find … PrivacyInfo.xcprivacy`
  sweep that `app.config.ts` documents `[code]` after adding it.

Config sketch:

```ts
ios: {
  entitlements: {
    "com.apple.security.application-groups": [`group.${bundleIdentifier}`],
  },
  infoPlist: {
    NSSupportsLiveActivities: true,
    UIBackgroundModes: ["audio"],   // already present
  },
},
plugins: [..., "@bacons/apple-targets"],
```

with the target scaffolded by `npx create-target widget` `[docs]`.

---

## §10 Phases

**P0 — the target compiles and ships.** A hardcoded Live Activity, no data, no buttons, started by a
debug button. *Exit:* it appears on a locked device from an **EAS preview build** — not just a local
prebuild. This phase exists solely to retire the §9 credential and shared-source risk before any
design work is sunk into it. It is the phase most likely to cost a day.

**P1 — read-only, real data.** The Expo module's `start`/`update`/`end`, the reducer, the word window
(§5.4), and the `phase` lifecycle including §7.1 and §7.3. *Exit:* lock, watch the card track a real
lesson, end the session, watch the card go and stay gone.

**P2 — the two buttons.** Intents, the App Group inbox, the `wasMuted` fix from §3.3, and the
paused-state copy from §7.4. *Exit:* pause and mute from the lock screen behave identically to the
on-screen buttons, including the resume restatement.

**P3 — Dynamic Island.** The three extra layouts. Separable from P2 and genuinely optional for a
first release.

Deferred, not phased: §5.3 option C.

---

## §11 Probes needed on a real device

Everything below is `[unverified]` and none of it is answerable from a simulator or from reading.

1. Does `@bacons/apple-targets` produce a target that survives an **EAS build** on Expo 57 / Xcode 26,
   and how are shared Swift sources declared (§4.4)?
2. Does the per-target `credentials.json` form work with local credentials, or does the extension
   force a move to EAS-managed credentials (§9)?
3. How many word rows actually fit before the 160 pt cap truncates, at the system font sizes the card
   uses (§5.4)?
4. Latency from a lock-screen tap to `holdSession` executing, with the app backgrounded and holding a
   WebRTC session. Anything above ~300 ms needs an optimistic `phase` write in `perform()` so the
   button does not feel dead.
5. Does the intent still reach a *live* app process reliably after a long lock (30 min+), or does iOS
   degrade it toward the terminated case (§7.2)?
6. Confirm the microphone indicator's exact presentation next to the card during a held pause, so
   §7.4's copy is written against what the learner actually sees.
7. Confirm `setAgentAudioVolume` still reaches ≥1 track on a locked device mid-lesson — the hatch is
   feature-detected and untested under lock, and §7.6 is the failure it produces.
