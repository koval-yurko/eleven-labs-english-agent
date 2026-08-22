# Two voice providers behind one interface: ElevenLabs and the OpenAI Realtime API

Research, 2026-08-22. **Status: Stage 0 PASSED on device; stages 1–5 BUILT and green in CI, none of
them device-verified (§14, §15). `words-2.0` has never been spoken to a human, and that one lesson is
still what every remaining unknown depends on — but §17 changed WHAT it is: it is now words-1.6's
podcast on the other provider rather than a pronunciation drill, so the comparison it settles is the
one this document is actually about.**

## 1. The question

Can "ChatGPT live" — OpenAI's Realtime API, the thing behind ChatGPT Advanced Voice — be used as a
second tutor backend in this app, behind a provider-neutral interface that today's ElevenLabs
implementation also fits?

Two sub-questions, and they have very different answers:

1. **Can it run at all on the client we ship?** (Expo SDK 57, `apps/mobile`, iOS, background audio,
   lock-screen controls.) — **Yes, with no new native module, and it survives a screen lock.**
   Demonstrated on a device, not argued: §4, §14.
2. **Does the app's session model survive the swap?** — **Yes, with three losses and two gains.**
   The one feared gap (barge-in transcripts) was measured and withdrawn. §5, §6, §10, §11.

## 2. Verdict

**Confirmed on a device.** The Stage 0 spike was built the same day this was written and answered all
five of §12's questions green, including the screen lock — the one that gates whether this can ship at
all. Two findings changed the document rather than confirming it: the barge-in transcript is **not**
the gap §6.1 feared (it is trimmed, not deleted), and the iOS audio session turned out to be a real,
non-obvious integration cost that no amount of reading would have surfaced (§4.1). Record in §14.

**Worth doing, and the abstraction is worth building even if OpenAI is never shipped to a learner** —
because the exercise of naming the seam is what makes the tutor session testable without a network.
But do it in the order in §12: prove the transport with a throwaway spike *before* writing the
interface, because the interface must be shaped by two real implementations, not by one plus a guess.

The single strongest product argument is not cost and not latency (§9, §10). It is §11.1:
**ElevenLabs Conversational AI is a cascaded pipeline (STT → LLM → TTS), so the tutor reads a
transcript of what the learner said. `gpt-realtime` is speech-to-speech: it hears the audio.** For an
English tutor, that is the difference between an agent that cannot in principle correct
pronunciation and one that can.

## 3. What "ChatGPT live" is, in API terms

OpenAI's **Realtime API**, GA since 2025-08-28. Current models: `gpt-realtime` (alias) /
`gpt-realtime-2.1` (snapshot), plus `gpt-realtime-2.1-mini`, and the special-purpose
`gpt-realtime-translate` and `gpt-live-transcribe`.

Three transports: **WebRTC** (browser + mobile clients), **WebSocket** (server-to-server), **SIP**
(telephony). The RN SDK constraint we already know from ElevenLabs — *"webrtc is the only transport
the RN SDK supports; websocket throws"* (`tutor-session.tsx:994`) — points the same way here: WebRTC
is also the right transport for us, for the same reason (a WebSocket transport needs Web Audio to do
its own capture and playback, and React Native has none).

The GA shape of the flow, which differs from every pre-GA tutorial still on the internet:

| Step | Where | Call |
| --- | --- | --- |
| 1. mint an ephemeral credential | **our server** | `POST https://api.openai.com/v1/realtime/client_secrets` with the real `OPENAI_API_KEY`, body `{ session: { type: "realtime", model, instructions, audio: {...} } }` |
| 2. SDP exchange | **the client** | `POST https://api.openai.com/v1/realtime/calls`, `Authorization: Bearer <ephemeral>`, body = the SDP offer (`Content-Type: application/sdp`), or multipart with `sdp` + `session` |
| 3. read the call id | the client | the response's `Location: /v1/realtime/calls/rtc_…` header |
| 4. events | the client | an `RTCDataChannel` named **`oai-events`**, JSON in both directions |
| 5. *(optional)* server attaches | **our server** | `wss://api.openai.com/v1/realtime?call_id=rtc_…` with the real API key — the **sideband** connection (§8) |

Step 1 is the structural match for `/api/v2/words-agent/token`: the same shape of route, the same
"the API key never leaves the server, and the agent identity never reaches the app" property.

## 4. Native feasibility — the decisive finding

**The app already ships everything the OpenAI WebRTC transport needs.** Nothing new to install, no
prebuild change, no new Info.plist key.

`apps/mobile/src/app/_layout.tsx` imports `@elevenlabs/react-native`, whose module-scope side effect
calls LiveKit's `registerGlobals()` — a fact this repo already documents in `src/lib/ids.ts`. Reading
what that actually installs (`@livekit/react-native/lib/module/index.js` →
`@livekit/react-native-webrtc/src/index.ts`):

```js
global.navigator.mediaDevices.getUserMedia = …
global.RTCIceCandidate      = RTCIceCandidate;
global.RTCPeerConnection    = RTCPeerConnection;
global.RTCSessionDescription = RTCSessionDescription;
global.MediaStream          = MediaStream;
global.MediaStreamTrack     = MediaStreamTrack;
global.RTCRtpTransceiver / RTCRtpSender / RTCRtpReceiver / RTCErrorEvent = …
```

That is exactly the surface an OpenAI Realtime WebRTC client uses. Consequences, each checked
against a file in this repo rather than assumed:

- **Peer connection + data channel.** `@livekit/react-native-webrtc` 137.0.3 is a fork of
  `react-native-webrtc` and supports `RTCDataChannel`, so `oai-events` works.
- **Microphone and audio session.** Already configured for a voice call: `UIBackgroundModes: ["audio"]`
  and `NSMicrophoneUsageDescription` are in `app.config.ts`, and `AudioSession` is exported from
  `@livekit/react-native` and can be started by us (`AudioSession.startAudioSession()` /
  `configureAudio()`) rather than by the ElevenLabs SDK. The S1 result — *a locked screen keeps
  talking* — is a property of the AVAudioSession category, not of ElevenLabs, so it should carry
  over. **Must be verified on a device, not assumed.**
- **Remote audio playback.** On React Native, a remote audio track from a peer connection routes to
  the device output automatically; there is no `<audio>` element and none is needed.
- **Silencing the tutor.** This is the surprise: the ugly escape hatch in `src/lib/agent-audio.ts`
  gets *simpler*, not harder. `@livekit/react-native-webrtc/src/MediaStreamTrack.ts:190` defines
  `_setVolume(volume)` on the track itself. With a peer connection we own, the remote track is right
  there on the `track` event — no reaching through `useRawConversation()` into a `protected`
  `connection` field and hoping the SDK has not renamed it. The whole "returns how many tracks it
  reached, 0 means the tutor is still audible" defensiveness becomes unnecessary for this provider.
- **Muting the learner.** `localTrack.enabled = false`. (ElevenLabs `setMuted` throws with no active
  conversation — `release()` guards for that at `tutor-session.tsx:551`; a raw track does not throw.)

### 4.1 The one real cost: the iOS audio session is not ours by default

**Found by the spike on 2026-08-22, and it would not have been found by reading anything.** The first
run produced a flawless event stream and total silence — transcripts arriving, `output_audio_buffer.started`
firing, nothing audible. It became audible only if an **ElevenLabs lesson had been started first**,
which is the entire diagnosis.

`AudioSession.configureAudio()` and `startAudioSession()` do **not** set the Apple category or mode.
That is done by `useIOSAudioManagement`, which watches a LiveKit **`Room`**'s track state and applies
`getDefaultAppleAudioConfigurationForMode(state)` as tracks appear and vanish. Its table:

| track state | category | mode |
| --- | --- | --- |
| `none` | `soloAmbient` | `default` ← **cannot render a WebRTC audio unit** |
| `remoteOnly` | `playback` | `spokenAudio` |
| `localOnly` / `localAndRemote` | `playAndRecord` | `videoChat` |

A raw `RTCPeerConnection` has no `Room`, so nothing ever moves the session off `soloAmbient`. An
ElevenLabs lesson moves it to `playAndRecord` and **leaves it there** — so the spike was silently
free-riding on the other provider's setup, and "it works if you run a lesson first" is exactly the
shape that bug takes.

The fix is three lines: call `setAppleAudioConfiguration(getDefaultAppleAudioConfigurationForMode("localAndRemote", true))`
when the local track opens and **again** when the remote track arrives, because the WebRTC audio unit
reconfigures the session as it starts and iOS resets the category on some route changes. LiveKit
re-applies on every track-state change; this is the same answer with two states.

**The consequence is bigger than the fix, and it lands on §7.** AVAudioSession is one process-wide
resource that no provider can own privately: whichever adapter configures it last wins. Today the
ElevenLabs SDK owns it invisibly and that is fine because it is the only provider. With two, the
session cannot live inside the adapters at all.

It also generalises into a testing rule: **every spike or comparison run starts from a cold launch
with no prior lesson.** Otherwise you are measuring the other provider's audio session, and that false
pass looks exactly like a pass.

### 4.2 Remaining caveats

We would be hand-rolling the transport. The **OpenAI Agents SDK
(`@openai/agents-realtime`) does not work in React Native** (openai/agents-js#133) — it assumes Node
or a browser. Community reports of RN voice agents hearing themselves in a loop are echo-cancellation
problems, i.e. the AVAudioSession mode; using LiveKit's `AudioSession` configuration (the one
ElevenLabs already applies today) is the mitigation, and is precisely why *reusing* the installed
stack beats adding a bare `react-native-webrtc`.

## 5. What the app actually asks of a voice provider

Extracted from `apps/mobile/src/lib/tutor-session.tsx`, which is the only consumer that matters
(`apps/web`'s `LessonTutor.tsx` is deprecated UI). This is the real interface, whether or not we
write it down — so writing it down is most of the work.

**Commands** (what we call):

| We call | ElevenLabs (`@elevenlabs/react-native`) | OpenAI Realtime |
| --- | --- | --- |
| start a session | `startSession({ conversationToken, connectionType: "webrtc", dynamicVariables })` | mint client secret server-side → `getUserMedia` → `createOffer` → POST SDP → open `oai-events` |
| end it | `endSession()` | `pc.close()` (optionally `DELETE`/hangup on the call id) |
| say something as the learner | `sendUserMessage(text)` | `conversation.item.create` (role `user`) **+ `response.create`** |
| give the tutor context without provoking a turn | `sendContextualUpdate(text)` | `conversation.item.create` **without** `response.create` — exact equivalent |
| keep the turn timer alive | `sendUserActivity()` | **no equivalent needed** — see §6.3 |
| mute the mic | `setMuted(bool)` | `track.enabled = false` |
| silence the tutor | ✗ (no-op on RN; `agent-audio.ts` hack) | `remoteTrack._setVolume(0)` |
| barge in / stop the current turn | ✗ (emulated by `sendUserMessage(PAUSE_STOP_MESSAGE)` — costs a turn) | `response.cancel` + `output_audio_buffer.clear` — **cheaper and exact** |

**Events** (what we consume):

| We handle | ElevenLabs | OpenAI Realtime |
| --- | --- | --- |
| connected + id | `onConnect({ conversationId })` | `session.created` / the `Location` call id |
| a finished turn, either role | `onMessage({ message, role })` | `conversation.item.input_audio_transcription.completed` (learner) and `response.output_audio_transcript.done` (tutor) |
| barge-in correction | `onAgentResponseCorrection({ original, corrected })` | **partial** — §6.1 |
| status | `onStatusChange({ status })` | `pc.connectionState` + `session.*` |
| disconnect **with a reason** | `onDisconnect({ reason: "user"\|"agent"\|"error" })` | **we must synthesise it** — §6.2 |
| error, with `errorType`/`code`/`debugMessage` | `onError(message, context)` | `error` event on the data channel, different field names |
| is the tutor speaking right now | `isSpeaking` | derive from `response.output_audio.delta` / `output_audio_buffer.started`/`.stopped` |
| is the mic muted | `isMuted` | ours to track |

**Configuration** (what a "version" pins — `apps/web/src/agent/prompts/types.ts`):

| Knob | ElevenLabs | OpenAI Realtime |
| --- | --- | --- |
| system prompt | agent `prompt.prompt` + `{{items_list}}` dynamic variable | `session.instructions` — **interpolate `items_list` server-side**, there are no dynamic variables |
| LLM | `prompt.llm` | fixed: the realtime model *is* the LLM |
| voice | `tts.voice_id` (any ElevenLabs voice) | `audio.output.voice` — a small fixed set (`marin`, `cedar`, …) |
| TTS model | `tts.model_id` | n/a (speech-to-speech) |
| `maxDurationSeconds` | 60–7200, we run 1800 | **hard 60-minute ceiling**, not configurable |
| `turnTimeoutSeconds` (re-engage on silence) | 1–30 s | `server_vad.idle_timeout_ms` — close, not identical (§6.3), and **≥ 5000 ms** |
| `turnEagerness` `patient\|normal\|eager` | native | `semantic_vad.eagerness` `low\|medium\|high\|auto` — **clean mapping** |
| `silenceEndCallTimeoutSeconds` (`-1` = never hang up) | native | no such timeout exists — nothing to disable |
| `maxTokens` per turn | `prompt.max_tokens` | `response.max_output_tokens` |
| extra languages | `language_presets` | prompt-level only |

## 6. Where the model does not line up

Three candidates went into the spike. **One turned out not to be a gap at all** (§6.1); the other
two stand.

### 6.1 Barge-in transcript correction — RESOLVED, and it is parity

`onAgentResponseCorrection` exists because *"the record claims the teacher finished sentences the
learner cut off — in an app whose whole premise is interrupting freely"* (`tutor-session.tsx:373`).

**Measured on the device, 2026-08-22: the retained transcript is a PREFIX of what was generated.** On
a barge-in the server clears its output buffer, emits `conversation.item.truncated` carrying the
played `audio_end_ms`, and the item's transcript is **trimmed to what was actually heard** — not
deleted. Reading it back with `conversation.item.retrieve` returns the opening of the sentence, cut
where the learner cut in. That is full parity with `onAgentResponseCorrection`, and this section's
original worry is withdrawn.

The docs sentence that caused the worry — *"truncating audio will delete the server-side text
transcript to ensure there is not text in the context that hasn't been heard by the user"* — is
ambiguous, and the pessimistic reading was the wrong one: it deletes the text that was **not heard**,
it does not wipe the item. Only the device settled that, which is §12's ordering argument in one
sentence.

**What still differs is the SHAPE, and it is a design note for the adapter.** ElevenLabs *pushes* a
correction; OpenAI expects you to *ask*. There is no corrected-transcript callback — the adapter has
to notice `conversation.item.truncated`, send `conversation.item.retrieve`, and reconcile the answer
against the line it already appended. So `TutorTransport.onTurnCorrected` (§7) is a genuinely shared
event with two very different implementations behind it: a subscription on one side, a request /
response round trip on the other.

### 6.2 `onDisconnect(reason)` — we must synthesise it

`PauseReason` is documented as *"Sourced from `onDisconnect`, never inferred"* (`tutor-session.tsx:101`),
and the three values map one-to-one onto ElevenLabs' `"user" | "agent" | "error"`. OpenAI gives us
`pc.connectionState` transitions and an `error` event, and nothing that says *"the far end hung up on
purpose"*. So the provider adapter has to keep a small flag — *did we ask for this teardown* — and
classify the rest as `error`. Acceptable, but it means the comment above stops being true for the
OpenAI adapter, and that should be written down where `PauseReason` is defined, not buried here.

### 6.3 The heartbeat — a feature that stops being needed

The held pause pings `sendUserActivity()` every second (`TUTOR_HEARTBEAT_MS`) purely to stop
ElevenLabs' `turn_timeout` from making the tutor re-engage into a room nobody is listening to.
OpenAI has no equivalent default: with VAD on and nobody speaking, the model simply waits. The
heartbeat becomes a **no-op for this provider**, and the interface should express that as a
capability (`supportsUserActivity: false`) rather than as a silently-empty method.

The mirror image is podcast mode: words-1.5 pins `turnTimeoutSeconds: 3` so the tutor *continues on
its own* after a short gap (`docs/2026-08-18-podcast-mode-tutor.md`). On OpenAI that is
`server_vad.idle_timeout_ms`, which fires `input_audio_buffer.timeout_triggered` and *prompts the
model to check engagement* — a nudge, not the same re-engagement. **Spike item #2:** does podcast
pacing survive, or does the OpenAI adapter need to drive it from our side (a timer that sends a
`conversation.item.create` + `response.create` when the line has been quiet)? The latter is entirely
doable and arguably more controllable.

**ANSWERED by §17, and the answer is that the server-side mechanism is closer than "a nudge".** The
documented behaviour of `idle_timeout_ms` is that the server *commits the empty audio segment to the
conversation history and triggers a model response* — i.e. it re-engages exactly the way ElevenLabs'
`turn_timeout` does, and what the tutor SAYS when it does is the prompt's business in both cases.
What changed is the sentence this section opens with: **the heartbeat is not a feature that stops
being needed, it is a feature that changes mechanism.** A podcast version arms an idle timeout on
purpose, so a held pause has to disarm it, and `userActivity` becomes true for that session. §17.2.

**One thing the mapping cannot carry across: the ranges differ at the bottom.** ElevenLabs takes
`turn_timeout` down to 1 s and this repo pins podcast versions at 3 s; OpenAI rejects any
`idle_timeout_ms` below 5000 with `integer_below_min_value`, found when words-2.0's session request
came back `HTTP 400 … Expected a value >= 5000, but got 3000`. `openAiTurnDetection` clamps up to
`OPENAI_MIN_IDLE_TIMEOUT_MS` rather than making each OpenAI version carry a vendor minimum, so the
twins state the same pacing and this side simply resumes into silence two seconds later.

## 7. Where to cut the seam

The good news is that most of the session logic is **already provider-neutral and already in
`packages/shared`**: `KICKOFF_MESSAGE`, `RESUME_MESSAGE`, `PAUSE_CONTEXT`, `PAUSE_STOP_MESSAGE`,
`ABORTED_RESUME_MESSAGE`, `UNHEARD_RESUME_MESSAGE`, `formatResumeContext`, `formatHeldResumeContext`,
`formatItemsList`, `sanitizeTranscript`, `TranscriptLine`. None of it names ElevenLabs. The pause
state machine, the ownership machine, the journal, the lock-screen card and the persistence guard in
`tutor-session.tsx` are likewise about *the lesson*, not about *the vendor*.

What is vendor-shaped is a thin band: the `useConversation` call, its eight callbacks, the
`startSession` argument, `useRawConversation()`, and `tutorErrorMessage`'s reading of
`{ errorType, code, debugMessage }`.

So the cut is:

```
packages/shared/src/tutor-transport.ts     ← the CONTRACT (types only, zero deps)
apps/mobile/src/lib/transport/elevenlabs.ts ← wraps @elevenlabs/react-native, behaviour unchanged
apps/mobile/src/lib/transport/openai.ts     ← RTCPeerConnection + oai-events
apps/mobile/src/lib/tutor-session.tsx       ← consumes the contract, knows no vendor
```

Putting the *contract* in `packages/shared` follows the `mirror-store.ts` precedent exactly: an
interface both clients must agree on, with the one implementation living per-platform. It passes the
repo's own test in CLAUDE.md — a bug in the *contract* is a bug on the server too, because the server
mints the credential the contract describes.

A first sketch, deliberately narrower than `useConversation`:

```ts
export type TutorRole = "user" | "agent";
export type TutorStatus = "disconnected" | "connecting" | "connected";
export type TutorEndReason = "user" | "agent" | "error";

/** What a provider can actually do. The session reads these instead of calling and hoping. */
export interface TutorCapabilities {
  /** Can the tutor be silenced locally, mid-word? (EL on RN: only via the agent-audio hack.) */
  silenceOutput: boolean;
  /** Is a keep-alive needed to stop the platform re-engaging during a hold? (OpenAI: false.) */
  userActivity: boolean;
  /** Can a turn be stopped without spending a turn? (EL: false — it fakes it with a user message.) */
  cancelTurn: boolean;
  /** Does the provider report a corrected transcript after a barge-in? */
  responseCorrection: boolean;
}

export interface TutorTransportEvents {
  onStatus(status: TutorStatus): void;
  onTurn(line: { role: TutorRole; text: string }): void;
  onTurnCorrected(previous: string, corrected: string): void;
  onSpeakingChange(speaking: boolean): void;
  onEnd(reason: TutorEndReason): void;
  /** Already normalised to one learner-facing sentence — `tutorErrorMessage` moves INTO the adapter. */
  onError(message: string): void;
}

export interface TutorTransport {
  readonly capabilities: TutorCapabilities;
  start(input: TutorStartInput): Promise<void>;   // credential fetch included
  end(): void;
  say(text: string): void;                         // provokes a turn
  context(text: string): void;                     // does not
  cancelTurn(): void;
  setMicMuted(muted: boolean): void;
  /** Returns whether it actually worked — the honest-silence rule from agent-audio.ts, kept. */
  setOutputSilenced(silenced: boolean): boolean;
  keepAlive(): void;                               // no-op where !capabilities.userActivity
}
```

Two design notes that matter more than the shape:

- **`tutorErrorMessage` moves into the adapter.** Its whole value is that it reads ElevenLabs' wire
  fields and knows what an exhausted ElevenLabs quota looks like
  (`docs/2026-08-21-quota-outage-and-pause-panel.md`). An OpenAI 429 is a different sentence with a
  different remedy. Keeping one function that branches on both providers would recreate the exact
  bug it was written to fix — a hint that is right sometimes and misleading the rest of the time.
- **Capabilities, not silent no-ops.** The reason `setAgentAudioVolume` returns a count is that the
  paused screen must not claim a silence it did not deliver. Generalise that: the session asks the
  transport what it can do and renders accordingly, rather than calling a method that quietly does
  nothing.
- **The audio session is NOT part of the transport — but it cannot be taken away from one either.**
  §4.1 is the reason it must be hoisted: AVAudioSession is one process-wide resource, and an adapter
  that configures it privately fights the other one — last writer wins, and the loser fails as
  *silence* rather than as an error.

  An earlier draft of this bullet said the ElevenLabs adapter's job is to *stop* owning it. **That is
  not achievable, and the correction matters.** `@elevenlabs/react-native/src/index.react-native.ts`
  calls `AudioSession.configureAudio()` and `startAudioSession()` inside its own session setup and
  `stopAudioSession()` on detach, with no option to disable any of it. So the design is not
  *ownership transfer*, it is **policy ownership plus re-assertion**: one module above both adapters
  decides the category and re-applies it after any transport starts or any track changes, and the
  ElevenLabs adapter tolerates the SDK's internal calls rather than preventing them.

  The sharp end is that `stopAudioSession()` on detach is **global**. Today it is harmless because
  there is one provider. With two, ending an ElevenLabs session tears the audio session out from
  under a live OpenAI one — and per §4.1 that failure presents as silence, not as an error. This is
  why `lib/audio-session.ts` is part of stage 1 rather than a later tidy-up: it is what stops stage 2
  from reproducing the exact bug stage 0 already hit.
- **`onTurnCorrected` hides a round trip on one side.** §6.1: ElevenLabs pushes the correction,
  OpenAI has to be asked for it. The event is genuinely shared; the work behind it is not, and the
  adapter — not the session — is where that asymmetry gets absorbed.

## 8. Server side

`/api/v2/words-agent/token` becomes provider-aware, or gains a sibling. Its contract is already
close: it takes a `version`, resolves it to an agent, and returns `{ token, conversationId, version,
appEnv }`. For OpenAI it would return `{ clientSecret, conversationId, version, appEnv, model }` —
and `conversationId` **stays ours**, minted server-side, exactly as today. That decision
(`ConversationTokenResponse`, *"a DERIVED id is worse than no session"*) is provider-independent and
gets easier, not harder: OpenAI's `rtc_…` call id is a second, *advisory* id we store alongside,
playing the same tripwire role the LiveKit-derived id plays now.

The prompt registry needs one structural change. Today a version is *reconciled to a remote object*
(`pnpm sync:agents` → `agents.lock.json` → agent id). **OpenAI has no remote agent object** — the
session config is the agent, passed at credential-minting time. So:

- `PromptVersion` gains a `provider: "elevenlabs" | "openai"` discriminant (or a per-provider config
  block, if a version should be runnable on both — worth deciding early, see §13).
- `sync:agents` skips OpenAI versions entirely. The lockfile keeps only what needs an id.
- `{{items_list}}` interpolation moves from the ElevenLabs dynamic-variable mechanism to
  string interpolation in the token route for OpenAI versions. `formatItemsList` is unchanged;
  only who substitutes it changes.
- Watch the **16,384-token ceiling on `instructions` + tools**. words-1.6 is 15.3K *bytes*, so
  comfortably inside — but this is a real wall that ElevenLabs does not have.

## 9. Observability — the thing that is genuinely different

Today: ElevenLabs POSTs a signed post-call webhook with the full transcript, tool calls and token
usage, and `apps/web/src/app/api/words-agent/elevenlabs-webhook/route.ts` turns it into one LangSmith
trace. **OpenAI has no post-call webhook and no post-call transcript retrieval** (it is an open
feature request on their forum). Two options:

1. **Client-only.** Rely on the paths that already exist and already work — `onMessage` → journal →
   `/api/lessons/session`. The row is written; the LangSmith trace is not. This is the cheap path and
   it loses the observability the June work bought.
2. **The sideband WebSocket.** Because OpenAI supports *"two active connections to the same Realtime
   session"*, our backend can open `wss://api.openai.com/v1/realtime?call_id=…` with the real API key
   and watch the whole conversation live — same events, server-side. That reproduces the webhook's
   role and is arguably better (real-time, and it can also hold tools and `session.update` so the
   prompt never reaches the client at all).

Option 2 has three costs that must be priced in before choosing it:

- **The client must report the `call_id` back to us** (it is only minted at SDP exchange), so there is
  a new authenticated route and a race: the first seconds of the call happen before we attach.
- **The sideband drops on silence.** Multiple reports of the connection closing after ~a minute of
  quiet. Our *held pause is a long silence by construction*, so this is not a rare edge — the server
  needs reconnect logic keyed to the same call id.
- **A long-lived server WebSocket on Vercel.** Functions do support WebSockets on Fluid Compute now,
  but a connection that must live for a 30-minute lesson is a different operational animal from the
  stateless webhook we run today, and it bills for the duration.

**Recommendation:** ship option 1 first (transcripts are already safe through three independent
paths), and treat option 2 as its own piece of work with its own document. Do not let observability
block the transport spike.

**Outcome (2026-08-22): option 1 shipped and option 2 was rejected outright**, not deferred. The
three costs listed above turned out to be worse on inspection — the duration ceiling is beta-gated
and still short of OpenAI's own 60-minute limit — and the sideband is built for a server that
participates in the call, which this one does not. Full reasoning in
[the observability document](./2026-08-22-openai-lesson-observability.md).

## 10. Cost

Modelled, not measured. Audio tokenises at roughly 10 tokens/second (600/minute).

**ElevenLabs today:** $0.08/min (Business, annual) or $0.10/min (Creator/Pro), LLM cost currently
absorbed by ElevenLabs *but announced to be passed through later*. Flat, predictable, bundled into
plan minutes we are already paying for.

**OpenAI `gpt-realtime-2.1`:** $32/1M audio input, $64/1M audio output, **$0.40/1M cached input**.

- tutor speaking: 600 tok/min × $64/1M = **$0.038/min**
- learner speaking: 600 tok/min × $32/1M = **$0.019/min**
- at a tutor-heavy 70/30 split: **≈ $0.033/min** of raw speech

…plus the part that is easy to miss: **every turn re-sends the whole conversation as input**, cached
at $0.40/1M. That makes per-minute cost grow with session length until the 32,768-token window
truncates (28,672 usable; GA drops audio tokens once a transcript exists, which pushes the plateau a
long way out). Realistic landing zone from third-party measurements: **$0.06–$0.15/min** — i.e.
plausibly *worse* than ElevenLabs at the top end.

**`gpt-realtime-2.1-mini`:** $10/$20 per 1M ($0.30/1M cached) — roughly a third, so **≈$0.02–0.05/min**,
clearly cheaper than ElevenLabs.

**Reading:** cost is not the reason to do this. `gpt-realtime` is a wash or slightly worse;
`-mini` is a genuine saving but is a different quality tier and would need its own evaluation
against the words-1.6 prompt. The structural difference matters more than the number: ElevenLabs
bills **flat per minute**, OpenAI bills **per token with superlinear growth inside a session**. Our
`maxDurationSeconds` cost backstop stops being sufficient on its own.

## 11. What we gain, and what we lose

### 11.1 Gain: the tutor can hear

ElevenLabs Conversational AI is cascaded — speech-to-text, then an LLM over text, then TTS. The tutor
literally cannot perceive that the learner said *"comfortable"* with four syllables, because by the
time the model sees it, it is the string `comfortable`. `gpt-realtime` is native speech-to-speech: it
hears prosody, hesitation, stress and mispronunciation, and can be instructed to correct them.

For a vocabulary tutor this is not a nice-to-have; it is a category of lesson we cannot currently
offer. If OpenAI ships behind the interface, the honest framing is not *"the same tutor, cheaper"* —
it is **a pronunciation-capable lesson mode that the current provider cannot implement at all**. That
also means a new prompt version, not a port of words-1.6.

### 11.2 Gain: better primitives for the pause

The held pause currently barges in by **sending a fake user message** (`PAUSE_STOP_MESSAGE`), which
costs a turn and pollutes the transcript enough that `HIDDEN_KICKOFF_MESSAGES` has to filter it.
OpenAI has first-class `response.cancel` + `output_audio_buffer.clear`. And silencing output stops
being a documented hack against a `protected` field.

**Confirmed on the device (§14).** `_setVolume(0)` silenced the tutor instantly and mid-word, on a
track handed straight to us by the `track` event — no `useRawConversation()`, no reach through a
`protected` `connection.getRoom()`, and no need for `agent-audio.ts`'s "how many tracks did I actually
reach" defensiveness, which exists only because the ElevenLabs path cannot promise it.

### 11.3 Loss: the voice

ElevenLabs' voice catalogue and per-version `voiceId` is a real product asset for a language tutor —
accent choice, consistency, quality. OpenAI offers a handful of fixed voices. This is the clearest
reason **not** to migrate wholesale, and the clearest reason the abstraction should be a *choice*
offered per lesson or per version rather than a replacement.

### 11.4 Loss: session ceiling and context window

`maxDurationSeconds` is ours to set up to 7200s on ElevenLabs; OpenAI's 60 minutes is a hard wall.
More importantly the 32,768-token window silently truncates old turns mid-lesson, where ElevenLabs
manages its own context. For a 30-minute lesson over 20 words this probably never bites — but it is a
*silent* failure mode (the tutor forgets word #1), so it needs a deliberate check, and
`retention_ratio: 0.8` should be set so truncation invalidates the prompt cache less often.

### 11.5 Loss: the post-call webhook

§9. Recoverable via the sideband, at a cost.

## 12. Suggested order of work

Deliberately transport-first. Writing the interface before the second implementation exists produces
an interface shaped like ElevenLabs with OpenAI-shaped holes.

**Stage 0 — the spike (throwaway, one screen, no abstraction). ✅ DONE 2026-08-22 — all five green, §14.** A dev-only screen in `apps/mobile`
that mints a client secret from a new dev route, opens an `RTCPeerConnection` against
`/v1/realtime/calls`, opens `oai-events`, and holds a spoken conversation with a hardcoded prompt.
Answers, on a device:
1. does remote audio play, with echo cancellation, using the AudioSession we already configure?
2. **does it survive a screen lock** (the entire reason `apps/mobile` exists)?
3. what exactly arrives on barge-in — is there a corrected transcript? (§6.1)
4. does `_setVolume(0)` silence the remote track?
5. what does `idle_timeout_ms` actually do to pacing? (§6.3)

Nothing else starts until 1 and 2 are yes. **Both are yes.**

**Stage 1 — extract the interface from ElevenLabs alone. ✅ BUILT 2026-08-22 (§15).** Write `tutor-transport.ts`, wrap the
existing SDK in `transport/elevenlabs.ts`, and rewrite `tutor-session.tsx` against the contract with
**zero behaviour change**. This stage is verifiable — the app must behave identically — which is why
it is separate from stage 2.

**Stage 2 — the OpenAI adapter. ✅ BUILT 2026-08-22 (§15).**, shaped by what stage 0 learned, with `capabilities` telling the
truth about §6.

**Stage 3 — server: provider-aware versions. ✅ BUILT 2026-08-22 (§15.3).** `PromptVersion.provider`, `sync:agents` skips OpenAI,
the token route branches, `items_list` interpolated server-side.

**Stage 4 — a prompt version of its own on OpenAI. ✅ BUILT 2026-08-22 (§15.5), then RESHAPED the same
day (§17.2).** Built first as a pronunciation drill (§11.1), which is the payoff and is still owed;
shipped as words-1.6's podcast on the other provider, because that is the version that makes the
provider comparison answerable. Either way: a new version, not a port.

**Stage 5 (separate document) — observability. ✅ BUILT 2026-08-22, and the sideband was REJECTED.**
See [docs/2026-08-22-openai-lesson-observability.md](./2026-08-22-openai-lesson-observability.md).
§9's recommendation — ship the client path first — turned out to be the whole answer rather than a
first step: a lesson outlives a Vercel function (1800 s is beta-gated and Pro-only, and OpenAI's own
ceiling is 60 minutes), the sideband drops on a silence that our held pause creates deliberately, and
it bills half an hour of wall-clock to learn what the transcript write already carries. The trace now
rides along with `POST /api/v2/lessons/session`, carrying token usage the adapter collects from
`response.done`.

## 13. Open questions

**Q1 and Q2 were settled on 2026-08-22 and built in stage 3 (§15.3).** They are kept below with
their answers rather than deleted, because the reasoning is what the next provider will need.

1. ~~**Is a prompt version bound to one provider, or runnable on both?**~~ **SETTLED: bound to one.**
   `PromptVersion.provider`, defaulting to `"elevenlabs"` so every existing version keeps its exact
   meaning. Not because dual configs are hard but because the versions are genuinely different
   lessons (§11.1). The ElevenLabs-only fields — `llm`, `voiceId`, `ttsModelId`, the turn settings —
   are ignored for an OpenAI version and `types.ts` says so; `maxTokens` is the one that carries
   across, as `max_output_tokens`.
2. ~~**Who chooses the provider?**~~ **SETTLED: the version picker, by implication — then RE-OPENED
   and settled again as an explicit control (§17.1).** Picking a version is still picking a
   provider, and there is still exactly one piece of state. What changed is the question the UI
   asks: while the two providers ran different lessons, "which version" answered everything. Once
   `words-2.0` became the same lesson as `words-1.6` on the other service, "which service" became the
   interesting choice and reading it out of eight version labels became the wrong way to ask it. So
   the lesson screen shows a service picker beside the version one, and the service picker is a VIEW
   of the version state: it is read back from the selected version, and choosing a service selects
   that service's newest version.
3. ~~**Does the held pause stay identical across providers, or does OpenAI get the better one
   (§11.2)?**~~ **SETTLED: better, and the capability flags did exactly the job they were built
   for.** OpenAI barges in with `response.cancel` rather than a fake user message (`cancelTurn`), and
   as of §17.2 it holds the line by SUSPENDING the server-side idle timeout rather than by pinging it
   away (`userActivity`). Both differences live entirely inside the adapter; `planHold` reads the
   flags and the session never learns which provider it is talking to.
4. **`gpt-realtime-2.1` or `-mini` for the first real lesson?** Needs an evaluation pass, not a
   preference — the prompt is 15KB and dense. Stage 0 ran entirely on `-2.1`, so nothing here is
   evidence about the mini.
5. **Sideband or client-only transcripts (§9)?** Recommend client-only first.

## 14. Stage 0 results — 2026-08-22

**PASSED. All five questions green.** Run on a physical iPhone against the deployed backend
(`/api/v2/words-agent/openai-token` on production), model `gpt-realtime-2.1`, voice `marin`, session
pinned to `semantic_vad` / `eagerness: "low"`. The instrument is `apps/mobile/src/app/realtime.tsx`
and the scrollback is S1's (`hooks/use-event-log`), newest-first and wall-clock stamped.

| # | Question | Result |
| --- | --- | --- |
| 1 | remote audio plays, with echo cancellation, on the AudioSession we already configure | **PASS**, but only after §4.1's fix — see below |
| 2 | survives a screen lock | **PASS** on a **Release** build: `alive` heartbeats unbroken across the locked window, and `you:` lines timestamped inside it |
| 3 | is there a corrected transcript after a barge-in | **PASS — a prefix of what was generated.** §6.1 rewritten; the feared gap does not exist |
| 4 | does `_setVolume(0)` silence the remote track | **PASS** — instant, mid-word, and reversible |
| 5 | what semantic VAD does to pacing | **PASS** — turn-taking felt natural; the tutor waited rather than cutting in |

### 14.1 What the spike changed in this document

Two things, and neither was predictable from the documentation:

1. **§4.1 — the iOS audio session.** The headline finding, and the only genuine integration cost
   discovered. It also produced a constraint on §7 (the session cannot live inside the adapters) and
   a standing testing rule (cold launch, no prior lesson).
2. **§6.1 — barge-in.** Went in as *"the one gap that silently corrupts stored history rather than
   failing loudly"* and came out as parity. What remains is a shape difference — push versus ask —
   which is an adapter concern, not a product one.

Everything else in §5's tables held as written.

### 14.2 Not captured

Recorded as gaps rather than quietly omitted, in the manner of
[S1 §12](./2026-08-13-expo-s1-background-audio.md):

- **Device model and iOS version.** Only one handset was tested, and it is the only one.
- **Token usage.** `response.done` carries a `usage` block and the screen logged it, but no numbers
  were copied down. **Stage 5 made this permanent rather than manual**: the adapter now collects
  usage and every OpenAI lesson files it to LangSmith with a cost estimate, so §10 stops being
  arithmetic the first time anyone runs `words-2.0`.
- **The alpha–echo count.** Q2 passed on both halves, but "five of five" was not counted out the way
  S1 required. A partial uplink would have read as a pass here.
- **Echo cancellation was judged by ear**, not by checking that no `you:` line ever contained the
  tutor's own words — which is the criterion the screen actually makes checkable.

### 14.3 What Stage 1 inherits

- The transport works, hand-rolled, on the WebRTC stack the app already ships. **No native module was
  added and no prebuild was run** — §4's central claim, now demonstrated rather than argued.
- The spike screen and `/api/v2/words-agent/openai-token` are throwaway and marked as such. They exist
  to be deleted when the interface lands, not to be grown into it.
- Three of `TutorCapabilities`' four flags now have measured values for OpenAI: `silenceOutput: true`,
  `cancelTurn: true`, `responseCorrection: true` (via a round trip). `userActivity: false` follows
  from §6.3 and is still inference, not measurement.
- **`turnEagerness` / podcast mode is still open.** §6.3's question was whether `idle_timeout_ms` can
  reproduce a tutor that continues on its own after a 3-second gap. The spike answered ordinary
  teaching pacing, not that: its prompt is not a podcast prompt and `server_vad` was never exercised.
  Do not read Q5's pass as covering words-1.5.

## 15. Stages 1–4 — 2026-08-22

**Built; typecheck, lint, the shared property checks, the mobile logic checks and the iOS bundle all
pass. NOT device-verified.** Stage 1's whole criterion is *zero behaviour change*, and no compiler
can check that — a lesson that starts, holds, resumes, mutes, silences, survives a lock and files its
transcript is the only proof, and it has not been run.

| | |
| --- | --- |
| `packages/shared/src/tutor-transport.ts` | the contract: state, controls, capabilities, events |
| `apps/mobile/src/lib/audio-session.ts` | the category policy (§4.1) |
| `apps/mobile/src/lib/transport/elevenlabs.ts` | absorbed `tutor-error.ts`, `agent-audio.ts`, the token mint, `formatItemsList` |
| `apps/mobile/src/lib/transport/openai.ts` | the second adapter |
| `apps/mobile/src/lib/transport/index.ts` | the registry and `DEFAULT_TUTOR_PROVIDER` |
| `apps/web/.../v2/words-agent/openai-token/route.ts` | the spike route, promoted: mints the row key, interpolates the words |

The stage-0 spike screen and its route are **deleted**, as §14.3 said they would be. Keeping a second
OpenAI client alongside the adapter is exactly the drift the interface exists to prevent.

### 15.1 What writing the SECOND adapter changed about the interface

This is the argument of §12 doing its job, so it is worth being specific about.

1. **`managesAudioSession` was a capability and is now nothing.** The idea was that the session would
   assert the iOS category for any transport whose SDK did not. The second adapter showed it cannot
   work: the assertion has to happen when the local track opens and again when the remote track
   arrives — moments only the transport can see, both *before* it ever reports `"connected"`. A
   session-level effect keyed on status fires too late and too coarsely. The module owns *what*, the
   adapter decides *when*, the session is not involved. Had stage 2 been skipped, this would have
   shipped as a flag that looked principled and did nothing.
2. **`TutorTransport` had to split into state and controls.** Bundling them meant the object changed
   identity on every `isSpeaking` toggle, which would have made `useTutorControls()` unstable — and
   `lessons/[id]/index.tsx` puts `focusLesson` and `syncMeta` in effect dependency arrays. Several
   re-runs a minute for the whole of a lesson, from a refactor whose criterion was *no behaviour
   change*. Found by reading, not by running; it is the kind of thing a device test would not have
   caught either.
3. **`TutorStatus` has five values, not four.** The ElevenLabs SDK uses two different unions — the
   render field carries `"error"`, the callback carries `"disconnecting"` — and the session branches
   on both. Collapsing either into `"disconnected"` would let a screen steal focus from a session
   mid-hangup and would release ownership on error.
4. **`start` needed a seam, not a return value.** The row key must be seeded, the parked state spent
   and ownership claimed *between* minting the credential and connecting. Returning a descriptor puts
   all three after the connect, which is too late — a turn can arrive on the first frame.

### 15.2 What stage 2 knowingly deferred

- ~~**Nothing selects the provider.**~~ Resolved by stage 3: the chosen version names it.
  `DEFAULT_TUTOR_PROVIDER` survives as the fallback for the frames before `/api/v2/agent-versions`
  has answered, and nothing else.
- ~~**The OpenAI route serves words-1.x prompts, which is a PORT.**~~ Resolved by stage 3 in the only
  honest direction: the route now refuses every ElevenLabs version, so it serves nothing until a
  version is written for it (stage 4, §15.4).
- **The end reason is synthesised** (§6.2), so `PauseReason` is less trustworthy on this provider
  than the session's "read rather than inferred" comment claims. The asymmetry is absorbed in the
  adapter and documented there.
- ~~**No fake transport.**~~ **Built 2026-08-22 — see §15.8.** It did what it was supposed to: the
  contract compiled against a plain factory with no React in it, and the held pause is now checked
  without a device.

### 15.3 Stage 3 — provider-aware versions

The server now owns version → provider the way it already owned version → agent id, and for the same
reason: a client that inferred either would be running a copy of a rule that cannot be hot-fixed.

| | |
| --- | --- |
| `PromptVersion.provider` | defaults to `"elevenlabs"`; changing an existing version's provider retires its agent, so bump instead |
| `effectiveConfig` | carries `provider` — and deliberately **not** into `hashConfig` |
| `elevenLabsVersions()` | the one answer to "which versions does ElevenLabs know about" |
| `sync:agents` | manages only those; a version switched away becomes an orphan and is retired by the existing prune |
| `agent-registry` | `resolveVersion` (any provider) beside `resolveAgent` (ElevenLabs only, `agentId` non-null) |
| both token routes | resolve first, then **refuse** the other provider's version with `wrong_provider` |
| `AgentVersionSummary.provider` | what the client picks its transport from |

Two details worth keeping:

- **`pnpm sync:agents --dry-run` reports seven no-ops** after the change. That is the check that
  `provider` did not leak into the agent hash — had it, the next sync would have re-PATCHED all seven
  agents to send a byte-identical body.
- **The refusal is deliberate, not defensive.** Asking the ElevenLabs route for an OpenAI version is
  a 400 rather than a redirect, because these prompts are written for different pipelines and running
  one on the other is a different lesson (§11.1), not a fallback.

On the client, `TutorProviderId` moved into `@tutor/shared` (the server names providers now too) and
the adapter registry is typed `Record<TutorProviderId, TutorTransportHook>` — so a provider the server
can name but this build cannot open is a compile error rather than a lesson that will not start.

One thing stage 3 forced that stages 1 and 2 had not: **every adapter is instantiated on every
render** (the rules of hooks require it), so both are live objects listening at all times while only
one carries a lesson. Each now receives its own events object, filtered against the active provider.
Without that, the idle transport's status changes would land in `statusRef` — which is unguarded by
design because it tracks the transport rather than the conversation — and a `"disconnected"` from the
provider nobody is using would read as the live session dropping.

### 15.4 The state stage 3 leaves the app in

**No OpenAI version exists, so the OpenAI route currently refuses everything.** That is the honest
end state for this stage rather than a gap: §11.1 says the reason to run this provider is that it
hears audio rather than reading a transcript, which wants a prompt written for it — stage 4. Shipping
a port of words-1.6 to have something to select would be the wrong kind of progress, and the route
says so where someone changing it will read it.

So the app's behaviour today is unchanged: seven ElevenLabs versions in the picker, one of which is
the default, and a whole second provider wired end to end waiting for a prompt.

### 15.5 Stage 4 — `words-2.0`, the lesson that needed the other provider

**SUPERSEDED THE SAME DAY by §17.2 — kept because the reasoning is right and only the sequencing was
wrong.** What follows describes the pronunciation drill that `words-2.0` originally was. It is now
`words-2.1`-shaped work, waiting to be written; `words-2.0` is words-1.6's podcast on OpenAI, because
a drill and a podcast differ in everything at once and comparing them tells you nothing about the two
providers. Everything below about *why* a speech-to-speech tutor deserves its own prompt still holds.

The payoff, and the first version that is not a words-1.x lesson. `apps/web/src/agent/prompts/words-2.0.ts`,
`provider: "openai"`.

**It inverts almost every rule words-1.6 is built on**, which is the clearest evidence that §11.1 was
right to say "a new version, not a port":

| words-1.6 (cascaded) | words-2.0 (speech-to-speech) |
| --- | --- |
| *NEVER ask a question you expect an answer to* | asking is the lesson |
| *NEVER ask the learner to SPEAK, REPEAT or PRODUCE anything* | that is the one thing it is for |
| *SILENCE IS NORMAL AND MEANS NOTHING* | silence is the learner thinking; the tutor waits, models the answer, moves on |
| a podcast for a locked phone with the mic off | a conversation with the mic open |

What carries across unchanged is the DATA — the same `{{items_list}}`, the same curated
`words.details` block, the same rule never to read the labels aloud or contradict the provided
Russian. That is the shareable core doing its job.

The prompt is sectioned the way OpenAI's realtime prompting guide recommends (Role & Objective,
Personality & Tone, Context, Reference Pronunciations, Rules, Conversation Flow) and carries the two
things that guide singles out as what realtime prompts get wrong: an **unclear-audio** block that
says never to guess and to stop asking after two failures, and a **variety** rule so corrections and
praise do not come out identically every time.

The Reference Pronunciations section is the part with real content: final-consonant devoicing,
unstressed vowels given full value, word stress across a family, TH, W/V, ship–sheep, the /æ/ gap, NG,
aspiration. It is framed as *what to listen for*, with **CORRECT WHAT YOU HEARD, NEVER WHAT YOU
EXPECTED** above it, because a model handed a list of likely faults will otherwise find them whether
or not they happened.

### 15.6 The default stopped being positional, and had to

`PROMPT_VERSIONS` was documented as *"the last entry is the UI default"*. Appending `words-2.0` would
therefore have moved **every learner who never opens the picker** onto a second provider, a different
lesson format, and a code path nobody has spoken to — as a side effect of adding to a list.

Positional defaults are fine while every entry is interchangeable. These are not, so the default is
now a name: `DEFAULT_PROMPT_VERSION = "words-1.6"`, read by `resolveVersion(null)` and echoed by
`/api/v2/agent-versions` so no client re-derives it. Promoting a version is a deliberate one-line
edit. `resolveVersion` still falls back to the newest active version if the name is ever wrong, so a
mistake degrades instead of breaking.

Verified: `activeVersions()` lists eight versions, `words-2.0` among them with `provider: "openai"`
and no agent id; `resolveVersion(null)` still answers `words-1.6` on ElevenLabs; and
`pnpm sync:agents --dry-run` reports the same seven no-ops, because `words-2.0` is invisible to it.

### 15.7 What stage 4 did NOT do

- **Nobody has spoken to `words-2.0`.** It compiles, it resolves, the route will mint a credential for
  it. Whether the lesson is any good — whether the model actually corrects pronunciation instead of
  agreeing that everything sounded fine, whether it hears a devoiced ending, whether the loop paces
  well — is unknown, and is exactly the kind of thing only a device answers.
- **The pronunciation list is from linguistics, not from this learner.** The traps are the standard
  L1-Russian set. Which ones matter for the person using this app is a different question and one the
  transcripts could eventually answer.
- **No evaluation.** There is no way to compare `words-2.0` against `words-1.6` other than by using
  both, and the LangSmith trace that would make that comparison durable is stage 5 (§9).

### 15.8 The fake transport, and the pause finally being testable

`packages/shared/src/tutor-transport-fake.ts` — a plain factory that implements
`TutorTransportControls`, records every call in order, and simulates no provider. Two jobs:

**It settles a claim that was untested.** The contract lives in `packages/shared` precisely so it is
not shaped by whichever SDK was first, but until now both implementations were React hooks in
`apps/mobile`, so "React-free" was an assertion about a file nobody had written. This is that file. It
compiles against the same interface the ElevenLabs adapter does, and that is the evidence.

**It made the held pause checkable.** The pause is the highest-risk logic in the app and the least
observable: get it wrong and the tutor says a plausible wrong thing that nobody can distinguish from
a model wandering. It lived inside a React provider that only runs on a phone against a billed
session, so every branch was checked by hand or not at all.

`packages/shared/src/tutor-pause.ts` splits DECISION from EFFECT — `planHold`/`planRelease` are pure
and total, `applyHold`/`applyRelease` are the few lines that call a transport — and
`pnpm check:shared` now runs **64 cases** over the full cross-product of `speaking × cancelTurn ×
userActivity × wasMuted × what landed while held`. What is pinned:

- barging in happens **iff** there was a turn to interrupt, and which mechanism is the *provider's*
  answer rather than the rule's guess;
- a keep-alive timer exists **iff** the platform would otherwise re-engage into the silence;
- the learner's own mute is restored, never overridden;
- **at most one turn is ever owed** — an unbounded resume was the bug the three messages fixed;
- **a cut-off turn outranks an unheard one**, which is the branch most likely to be "simplified"
  later because the two read as interchangeable;
- output is silenced **before** the microphone is muted (between them, the whole of what a pause
  feels like);
- a transport that cannot silence **says so**, so a paused screen cannot claim a silence it did not
  deliver;
- on a provider that can `cancelTurn`, the transcript never receives the fake user message — the
  §11.2 improvement, pinned so a refactor cannot quietly hand it back.

The session now calls these rather than duplicating them, so what is checked is what runs. Four refs
(`heldAtLineRef`, `heldSinceRef`, `abortedRef`, `wasMutedRef`) collapsed into one `HoldSnapshot` on
the way through — they always described one moment, and four refs that can drift apart were four
ways to answer the wrong question on the way back.

**Still not device-verified**, like everything since stage 0. What these checks buy is that the
branch table is now wrong-proof by construction rather than by memory; whether the whole pause
behaves on a phone is a separate question and unchanged.

## 17. The comparison this was for — 2026-08-22, later

Stages 1–5 built a second provider and a lesson to run on it, and then could not answer the question
the whole document opens with: **is ChatGPT a better tutor than ElevenLabs for this app?** Two things
were in the way, and they turn out to be the same thing twice.

`words-2.0` was a pronunciation drill and `words-1.6` is a podcast, so preferring one told you
nothing about the providers — the versions differed in every respect at once. And the only way to
reach the drill was to find its label in a list of eight, which is a fine way to pick a lesson and a
poor way to pick a service. **Built; typecheck, lint, the shared property checks, the mobile logic
checks and the iOS bundle all pass; still not device-verified**, which remains true of everything
since stage 0.

### 17.1 A service picker, built and then deleted by §18

The lesson screen briefly showed **Tutor service** above **Tutor version**, as a view of the version
state rather than a second piece of it. §18 removed it: once the registry held one lesson per
service, the version list WAS the service list and two controls over one decision was one more thing
that can look wrong. The reasoning it was built on is what survived — the version picker's labels now
name the service, which is the same idea with one control instead of two.

### 17.2 Podcast pacing on OpenAI, and the capability that flipped

`words-2.0` became words-1.6's prompt, close to verbatim, with three departures: **no spelling in
either direction** (it is dictation in an audio lesson, and letter names are where speech-to-speech
output is least reliable), an explicit **unclear-audio** block, and a rule naming what an **empty
turn** means. The third one is not cosmetic — it is where the mechanics leak into the prompt.

The mechanics: **a realtime model answers input, and silence is not input.** With the
`semantic_vad` block stage 2 hardcoded, a monologue lesson says its first paragraph and stops for
good. The fix is `server_vad` with `idle_timeout_ms`, which commits an empty audio segment and
provokes a response — the same job ElevenLabs' `turn_timeout` does, arriving in a different envelope.
Hence the prompt rule: what the model sees is the learner saying nothing, and a model left to
interpret that asks whether they are still there.

Three consequences, and the last one is the interesting one.

1. **Turn-taking became per VERSION.** `turnTimeoutSeconds` and `turnEagerness` were documented as
   ElevenLabs-only and ignored here; they are now the two halves of `audio.input.turn_detection`
   (`openAiTurnDetection`). Set → `server_vad` + idle timeout (podcast). Unset → `semantic_vad` +
   eagerness (the tutor waits, which is what a future drill version wants). Read off the RAW version
   rather than `effectiveConfig`, because the effective config defaults the timeout to seven seconds
   and would otherwise give every OpenAI version podcast pacing — including one written to wait,
   which would then nag the learner every seven seconds.
2. **The client is told which block it got — the WHOLE `audio.input` block.**
   `RealtimeTokenResponse.audioInput`, and the "whole" is the part worth writing down. The adapter
   cannot put back pacing it was never given, so something had to travel; sending only
   `turn_detection` would additionally have been a bet on how the server merges a nested object, and
   if it replaces `audio.input` then `transcription` goes with it — costing every learner transcript
   from the first pause onward, silently, because the model still hears the audio and still answers
   and only the stored record is missing half of itself. Round-tripping the block makes the question
   moot. Not required by the response guard: a missing block degrades to "no idle timeout", which is
   a lesson that works, and refusing to start one over pacing would be the worse trade.
3. **`userActivity` flipped, and stopped being a constant.** Stage 2 measured it as `false` with the
   reasoning *"with VAD on and nobody speaking the model simply waits"*. That was true of the
   `semantic_vad` session it was measured on and is false of a podcast one, which arms a timeout
   precisely SO the server takes the floor back — the one thing a held pause must not allow. So the
   OpenAI adapter reports capabilities **per session**: `capabilities` is a getter over a ref settled
   during `start`, which is safe because nothing renders it (`tutor-session.tsx` reads it once,
   inside `hold()`).

   What `keepAlive` then does is the mirror image of the other provider's: ElevenLabs pings every
   second to push a server-side timer out, OpenAI tells the server once to stop running one and
   `say`/`context` put it back on the way out of the pause. **Same capability, same guarantee,
   opposite mechanics** — which is §6.1's `onTurnCorrected` pattern a second time, and the second
   piece of evidence that the flags are carrying real weight rather than describing ElevenLabs.

   One session-level change came with it: the keep-alive now fires **once immediately** at the hold
   and then on the interval. `setInterval` first fires a whole `TUTOR_HEARTBEAT_MS` late, and the
   platform's turn timer does not restart when the learner presses Pause — it may already be a hair
   from expiring. On ElevenLabs that gap costs one extra ping; on OpenAI it is the difference between
   a suspension that lands before the timeout and one that lands after it.

### 17.3 What this still does not know

- **Nobody has spoken to `words-2.0` in either shape.** Everything above is compiler-green and
  device-untested, and the pacing in particular is the kind of thing only a phone answers: whether a
  three-second idle timeout reads as a breath or as a stall, whether the empty-turn rule actually
  stops the model asking if you are there, and whether a held pause on this provider is really quiet.
- **The pronunciation drill is deferred, not dropped.** §11.1 is still the strongest reason to run
  this provider at all, and it wants a `words-2.1` written for it — a different lesson, not a mode of
  this one. Its turn detection is already expressible: leave `turnTimeoutSeconds` unset.
- **Cost is now easier to get wrong in the podcast direction.** §10's superlinear growth is worst for
  a long tutor-heavy monologue, which is exactly what this version is, and the empty commits add a
  turn boundary every few seconds. Stage 5's LangSmith trace should make the first real lesson
  answer this rather than the arithmetic.

## 18. The registry collapsed to two — 2026-08-22, later still

§17 made the two providers comparable and then left eight versions in the picker to compare them
through. This is the cleanup, and it is mostly deletion.

**The registry is now two entries, and they are the same lesson twice.** `apps/web/src/agent/prompts/podcast-lesson.ts`
holds the text; `words-1.0` runs it on ElevenLabs and `words-2.0` runs it on OpenAI, byte for byte.
Everything from `words-1.1` to `words-1.6` is deleted from the filesystem and removed from
ElevenLabs. `DEFAULT_PROMPT_VERSION` is `words-1.0`.

### 18.1 Why one prompt in a module rather than two prompt files

Because the comparison is the product of §17 and a copy is how you lose it. Two files that drifted by
a sentence would silently turn "which tutor sounds better" into "which prompt is better", and the
drift would not announce itself. One exported constant, imported twice.

The versions still bind one-to-one to providers, but for a better reason than §13 Q1's original one
(*"they are genuinely different lessons"*, which is now false). The two sides need different CONFIG
around the same text — `ttsModelId` and `additionalLanguages: ["ru"]` on one, a turn-detection block
derived from `turnTimeoutSeconds` on the other — and a version is where that config lives. So
"picking a version is picking a provider" holds, and the labels say which: **"1.0 · ElevenLabs"** and
**"2.0 · ChatGPT"**.

One wording change came out of merging the two texts. §17.2's empty-turn rule was written for
OpenAI's idle-timeout re-engagement, which hands the model a literal empty audio segment; ElevenLabs
just gives the floor back. It is now phrased for both — *"an empty or silent turn, or simply the floor
with nothing said"* — so the shared text is honest on both providers rather than carrying a line that
is a no-op on one.

### 18.2 The name collision, stated rather than hidden

**`words-1.0` is a reused name.** It meant the very first prompt (2026-08-16) and now means
words-1.6's. `lesson_sessions.agent_version` is free text, so rows written before this change that
say `words-1.0` describe the old prompt and will read as the new one — in the session list and in the
LangSmith trace. Rows saying `words-1.1` … `words-1.6` stay unambiguous, because those names are
retired rather than reused.

It also means no new agent: `pnpm sync:agents` sees `words-1.0` on both sides and PATCHES the
existing agent id with the new config, rather than creating one. The dry run says `update words-1.0`
and six removals, which is the shape to expect.

**Applied with `--prune=delete`, deliberately.** The default, `--prune=retire`, renames the six
agents with a ` [retired]` suffix and keeps their lockfile entries, so `versionForAgentId` can still
resolve a post-call webhook that arrives for one mid-flight; `delete` removes them from ElevenLabs
outright and drops the entries. Delete was chosen to get them off the dashboard, and the price is
named rather than discovered: **`agents.lock.json` now holds one entry**, so a late ElevenLabs
webhook for a session started on any of the six would file with no version. That window closes as
soon as those sessions are over, and it is the only thing retire would have bought.

The applied run: `～ update words-1.0` (same agent id, `agent_5001kw…`, new config) plus six deletes.
A second dry run reports one no-op, which is the check that the lockfile and ElevenLabs agree.

### 18.3 What this does not change

The transport layer, the pause machinery, the per-version turn detection and the OpenAI adapter's
suspend-the-idle-timeout keep-alive are all exactly as §17 left them. This is a registry and a UI
change; nothing under it moved. And it is still not device-verified — deleting six versions does not
make the two that are left any more tested than they were.

## 16. Sources

- OpenAI, *Realtime API with WebRTC* — https://developers.openai.com/api/docs/guides/realtime-webrtc
- OpenAI, *Realtime and audio* — https://developers.openai.com/api/docs/guides/realtime
- OpenAI, *Realtime conversations* — https://developers.openai.com/api/docs/guides/realtime-conversations
- OpenAI, *Webhooks and server-side controls* (sideband) — https://developers.openai.com/api/docs/guides/realtime-server-controls
- OpenAI, *Voice activity detection* — https://developers.openai.com/api/docs/guides/realtime-vad
- OpenAI, *Developer notes on the Realtime API* — https://developers.openai.com/blog/realtime-api
- OpenAI, *Pricing* — https://developers.openai.com/api/docs/pricing
- openai/openai-agents-js#133, *The Realtime SDK does not work with React Native* — https://github.com/openai/openai-agents-js/issues/133
- thorwebdev/expo-webrtc-openai-realtime — https://github.com/thorwebdev/expo-webrtc-openai-realtime
- ElevenLabs, *We cut our pricing for Conversational AI* — https://elevenlabs.io/blog/we-cut-our-pricing-for-conversational-ai
- OpenAI community, *Realtime API: durable post-call transcript retrieval* — https://community.openai.com/t/realtime-api-durable-post-call-transcript-retrieval/1384207
- OpenAI community, *Side-band websocket … drops out after period of silence* — https://community.openai.com/t/side-band-websocket-connection-to-webrtc-call-for-gpt-realtime-api-drops-out-after-period-of-silence/1368689
