# Two voice providers behind one interface: ElevenLabs and the OpenAI Realtime API

Research, 2026-08-22. **Status: research only — nothing built.**

## 1. The question

Can "ChatGPT live" — OpenAI's Realtime API, the thing behind ChatGPT Advanced Voice — be used as a
second tutor backend in this app, behind a provider-neutral interface that today's ElevenLabs
implementation also fits?

Two sub-questions, and they have very different answers:

1. **Can it run at all on the client we ship?** (Expo SDK 57, `apps/mobile`, iOS, background audio,
   lock-screen controls.) — **Yes, and with no new native module.** §4.
2. **Does the app's session model survive the swap?** — **Mostly, with two real losses and one real
   gain.** §5, §10, §11.

## 2. Verdict

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

Caveats worth naming now: we would be hand-rolling the transport. The **OpenAI Agents SDK
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
| `turnTimeoutSeconds` (re-engage on silence) | 1–30 | `server_vad.idle_timeout_ms` — close, not identical (§6.3) |
| `turnEagerness` `patient\|normal\|eager` | native | `semantic_vad.eagerness` `low\|medium\|high\|auto` — **clean mapping** |
| `silenceEndCallTimeoutSeconds` (`-1` = never hang up) | native | no such timeout exists — nothing to disable |
| `maxTokens` per turn | `prompt.max_tokens` | `response.max_output_tokens` |
| extra languages | `language_presets` | prompt-level only |

## 6. The three places the model does not line up

### 6.1 Barge-in transcript correction — a partial loss

`onAgentResponseCorrection` exists because *"the record claims the teacher finished sentences the
learner cut off — in an app whose whole premise is interrupting freely"* (`tutor-session.tsx:373`).

OpenAI's WebRTC transport does hold the output-audio buffer server-side and *"knows how much audio has
been played at a given moment"*, and *"the server will automatically truncate unplayed audio when
there's a user interruption"*. So the mechanism exists. What is **not** confirmed from the docs is
whether the *stored item's transcript text* is trimmed to match, i.e. whether we can read a corrected
string the way `onAgentResponseCorrection` hands us one. **This is spike item #1** — it is the one
gap that silently corrupts stored history rather than failing loudly.

Fallback if the text is not trimmed: send `conversation.item.truncate` with the played `audio_end_ms`
ourselves and trim our own line proportionally. That is an approximation, and it should be labelled
as one in the code rather than pretended otherwise.

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

**Stage 0 — the spike (throwaway, one screen, no abstraction).** A dev-only screen in `apps/mobile`
that mints a client secret from a new dev route, opens an `RTCPeerConnection` against
`/v1/realtime/calls`, opens `oai-events`, and holds a spoken conversation with a hardcoded prompt.
Answers, on a device:
1. does remote audio play, with echo cancellation, using the AudioSession we already configure?
2. **does it survive a screen lock** (the entire reason `apps/mobile` exists)?
3. what exactly arrives on barge-in — is there a corrected transcript? (§6.1)
4. does `_setVolume(0)` silence the remote track?
5. what does `idle_timeout_ms` actually do to pacing? (§6.3)

Nothing else starts until 1 and 2 are yes.

**Stage 1 — extract the interface from ElevenLabs alone.** Write `tutor-transport.ts`, wrap the
existing SDK in `transport/elevenlabs.ts`, and rewrite `tutor-session.tsx` against the contract with
**zero behaviour change**. This stage is verifiable — the app must behave identically — which is why
it is separate from stage 2.

**Stage 2 — the OpenAI adapter**, shaped by what stage 0 learned, with `capabilities` telling the
truth about §6.

**Stage 3 — server: provider-aware versions.** `PromptVersion.provider`, `sync:agents` skips OpenAI,
the token route branches, `items_list` interpolated server-side.

**Stage 4 — a pronunciation-mode prompt version** on OpenAI (§11.1). This is the payoff, and it
should be a new version, not a port.

**Stage 5 (separate document) — sideband observability.** §9.

## 13. Open questions to settle before stage 1

1. **Is a prompt version bound to one provider, or runnable on both?** One-provider-per-version is far
   simpler and matches §11.1 (the OpenAI versions will be *different lessons* anyway). Recommend the
   discriminant, not the dual config.
2. **Who chooses the provider — the learner, the version picker, or a server flag?** The version
   picker already exists and already carries a `version` through the token route, so folding provider
   into version costs nothing new in the UI. Recommend that.
3. **Does the held pause stay identical across providers, or does OpenAI get the better one (§11.2)?**
   Identical is easier to reason about; better is better. Recommend better, with the capability flags
   making the difference explicit rather than accidental.
4. **`gpt-realtime-2.1` or `-mini` for the first real lesson?** Needs an evaluation pass, not a
   preference — the prompt is 15KB and dense.
5. **Sideband or client-only transcripts (§9)?** Recommend client-only first.

## 14. Sources

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
