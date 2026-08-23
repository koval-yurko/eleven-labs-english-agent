# Vapi as a third voice provider: what it would cost, and what to create on their dashboard

Research note, 2026-08-27. Companion to `docs/2026-08-22-openai-realtime-second-provider.md`, which
established the `TutorTransport` seam this evaluates Vapi against.

---

## 1. The question

We have two providers behind one interface: ElevenLabs (`elevenlabs.ts`, 217 lines, mostly SDK
glue) and OpenAI Realtime (`openai.ts`, 568 lines, hand-rolled WebRTC). Vapi is proposed as a third.

Two things need answering, and they are not the same question:

1. **Can Vapi satisfy `TutorTransportControls`** — the eight methods and seven callbacks in
   `packages/shared/src/tutor/transport.ts` that a lesson actually needs?
2. **What do we have to create in Vapi's dashboard** to run our lesson on it?

The answer to (1) decides whether (2) is worth doing. So (1) first.

---

## 2. Verdict

**The contract fit is good — better than OpenAI's on three of the four capability flags. The
native client was the hard part, and as of 2026-08-27 it works on device (§12.6) — on a shim.**

Vapi's React Native SDK wraps Daily, which vendors its own hard-pinned fork of
`react-native-webrtc`; we already ship LiveKit's, because the ElevenLabs SDK requires it. Two forks
cannot coexist in one iOS binary, and this note originally concluded that closed the matter. It does
not: deleting Daily's fork and aliasing it to LiveKit's leaves one WebRTC package, and Daily's JS
runs against it once four fork-specific methods are shimmed (§12.2b, §12.2c).

Measured on hardware: a Vapi call connects and is audible, **and so is an ElevenLabs lesson before
and after it** — the AVAudioSession contention test that §4 predicted would fail (§12.6).

What that buys is a working transport, not a supportable one. It rests on a cross-vendor package
alias, four stubbed native methods, and a Daily version Vapi's caret pins to `0.78.x`. Nothing
upstream endorses any of it.

So the real question is no longer *can it work* but *is it worth carrying* — which is §11 Q1, still
unanswered, and cheap to answer (§10 stage 0). If the product answer is yes, **Vapi's WebSocket
transport** (§6.3) deserves re-pricing: it bypasses Daily entirely, needs no shim, and fits our
server-owns-the-prompt architecture better than either provider we already run — at the cost of a
native PCM module we do not have.

The paths, then:

| Path | Cost | Verdict |
|---|---|---|
| **A.** `@vapi-ai/react-native` (Daily/WebRTC) | Package alias + a 4-method JS shim | **WORKS on device (§12.6)** — but unsupported by anyone upstream |
| **B.** Vapi WebSocket transport + native PCM module | ~1 native module, ~600 line adapter | **Viable**, the honest option |
| **C.** Vapi on web only | Near zero | Pointless — web is deprecated (CLAUDE.md) |

If Vapi is wanted for *evaluation* rather than for shipping, there is a fourth path worth naming:
run it in the dashboard's own test console against our prompt, decide whether its orchestration is
better than what we have, and only then pay for path B. §11 sketches that.

---

## 3. What Vapi is, in the terms this repo already uses

Vapi is an **orchestration layer**, which places it somewhere between our two existing providers
rather than beside them.

- **ElevenLabs** is a cascaded STT → LLM → TTS pipeline with a provisioned remote agent object.
- **OpenAI Realtime** is a single speech-to-speech model with no remote object at all — the session
  config *is* the agent (`openai-token/route.ts`).
- **Vapi is both, by configuration.** An assistant names a transcriber, a model and a voice, each
  from a different vendor — or it names `gpt-realtime-2025-08-28` and becomes speech-to-speech with
  the transcriber field ignored.

That is the genuinely new thing on offer. §11.1 of the OpenAI note framed the provider choice as a
trade: ElevenLabs' voice against OpenAI's ability to *hear* the learner's pronunciation. Vapi does
not resolve that trade, but it does let one prompt version be re-pointed across it without a new
adapter — swap `model.provider` and the transport code does not change.

What it costs is a layer we do not currently have between us and the model, plus $0.05/min for it.

---

## 4. The decisive finding: two WebRTC forks

`@vapi-ai/react-native` requires, exactly:

```bash
npm install @vapi-ai/react-native @daily-co/react-native-daily-js \
  @react-native-async-storage/async-storage react-native-background-timer \
  react-native-get-random-values
npm install --save-exact @daily-co/react-native-webrtc@118.0.3-daily.4
```

`apps/mobile/package.json` ships:

```json
"@livekit/react-native-webrtc": "137.0.3",
"@config-plugins/react-native-webrtc": "^15.0.1"
```

Both packages are forks of the same upstream `react-native-webrtc`. Both vendor a `WebRTCModule`
native module and a WebRTC binary under the same framework name. Installing both means duplicate
native class registration on iOS.

**Spiked 2026-08-27, and this section is the prediction that spike falsified.** The first build did
fail at `pod install`, before a single file compiled. The second deleted Daily's fork, aliased it to
LiveKit's, and shipped a working Vapi call on device (§12). So the collision is real and the
conclusion drawn from it — that the two SDKs cannot share a binary — was wrong: they can, because
only ONE of the two forks ever needs to be installed.

Read the rest of this section as the reasoning that had to be dismantled, not as current findings.
§12.2b–§12.2c are what actually happened.

Three aggravating details:

1. **The pin is exact** (`--save-exact`, `118.0.3-daily.4`). There is no version to negotiate
   toward. LiveKit is on 137; Daily is on 118 and Vapi pins even below Daily's own current
   `124.0.6-daily.1`.
2. **We cannot drop LiveKit.** `@elevenlabs/react-native` calls LiveKit's `registerGlobals()`, and
   `transport/openai.ts` imports `RTCPeerConnection` directly from `@livekit/react-native-webrtc`.
   Both existing providers depend on it.
3. **New Architecture.** We are on Expo SDK 57 / RN 0.86, where the New Architecture is default and
   bridgeless. Vapi's own README still instructs `newArchEnabled=false` for Android, and Daily's
   published Expo compatibility matrix currently tops out at SDK 54. Unverified for 57 — but the
   direction of the evidence is not encouraging.

**A third owner for AVAudioSession.** Even if the module conflict were solved, `audio-session.ts`
documents at length that AVAudioSession is one process-wide resource, that LiveKit's
`useIOSAudioManagement` owns the category policy, and that the OpenAI spike's total-silence bug came
from a *second* owner racing the first. Daily's native layer configures the audio session too, with
no opt-out we found. That is a third writer to a resource whose last-writer-wins failure mode is
silence — the hardest failure in this codebase to diagnose, by that file's own account.

> **FALSE, and this was the biggest wrong call in the note.** Daily's audio-session code lives
> entirely in `WebRTCModule+Daily.m`, a category **in the fork** — which the fix deletes.
> `react-native-daily-js`'s own iOS source (`DailyNativeUtils.m`) contains no AVAudioSession
> references at all. There is no third owner. Measured on device: an ElevenLabs lesson is audible
> both before and after a Vapi call (§12.6). See §12.2c.

**Also note the background mode mismatch — this one held.** Vapi's README asks for
`UIBackgroundModes: ["voip"]`.
`app.config.ts:127` sets `["audio"]`, deliberately, and that is the whole point of stage S1. Apple
restricts `voip` to apps that actually register with CallKit/PushKit; adding it to satisfy an SDK
README is an App Store review risk we should not take on. Lower stakes than the above, but it tells
you the SDK was written for a call app, not a media app.

---

## 5. What the app asks of a provider, scored

The contract is `TutorTransportControls` + `TutorTransportEvents`. Scored against Vapi's client SDK
surface and assistant config:

### 5.1 Controls

| Contract | Vapi | Notes |
|---|---|---|
| `start(request, onIdentified)` | ✅ `vapi.start(assistant, overrides?)` | Takes an assistant id **or** an inline transient assistant, plus `assistantOverrides`. See §6.1. |
| `end()` | ✅ `vapi.stop()` | |
| `say(text)` | ✅ `vapi.say(text, endCallAfterSpoken?, interruptionsEnabled?, interruptAssistantEnabled?)` | **Richer than either provider we have.** EL's `say` is `sendUserMessage` — a fake learner turn. Vapi's puts words in the *tutor's* mouth without spending a model turn, and the interruption flags are exactly the knobs the held pause wants. |
| `context(text)` | ✅ `vapi.addMessage({ role: 'system', content })` | Direct analogue of EL's `sendContextualUpdate`. |
| `cancelTurn()` | ⚠️ No documented client method | The `stopSpeakingPlan` handles *learner-initiated* barge-in server-side. A programmatic "stop talking now" is not in the SDK surface. `getDailyCallObject()` is an escape hatch, but only on path A. **Assume `false`** until measured. |
| `keepAlive()` | ✅ Not needed, if configured | `silenceTimeoutSeconds` is the platform's hang-up-on-silence timer and it is settable per assistant. Set it high (or use `maxDurationSeconds` as the only backstop) and a held pause survives without a heartbeat — the same conclusion §6.3 of the OpenAI note reached for `semantic_vad`. |
| `setMicMuted(muted)` | ✅ `vapi.setMuted(bool)` / `isMuted()` | |
| `setOutputSilenced(silenced)` | ⚠️ No first-class method | On path A, `getDailyCallObject()` → `updateParticipant` can unsubscribe or zero the remote track. On path B (WebSocket) it is trivial — drop the frames. **`true` on B, `unknown` on A.** |

### 5.2 Events

| Contract | Vapi | Notes |
|---|---|---|
| `onStatus` | ✅ | `call-start`, `call-end`, plus `call-start-progress` / `-success` / `-failed`, which are *finer* than `pc.connectionState`. |
| `onTurn(line)` | ✅ | `message` events of `type: 'transcript'` carrying `role` + `transcript`. |
| `onTurnCorrected(prev, corrected)` | ⚠️ Probably | `user-interrupted` fires on barge-in and `conversation-update` commits the authoritative history. That is the *material* for a correction, but not the ready-made `(previous, corrected)` pair ElevenLabs hands us. Expect to reconstruct it by diffing `conversation-update` against what we already emitted — closer to OpenAI's `item.truncated` → `item.retrieve` round trip than to EL's callback. |
| `onEnd(reason)` | ✅ **Better than OpenAI** | `endedReason` is a real field on both `end-of-call-report` and the call object. §6.2 of the OpenAI note had to *synthesise* this. Vapi gives it to us, with a documented vocabulary (`hangup`, `silence-timed-out`, …). |
| `onError` | ✅ | `error` event. |
| `onTransportId(id)` | ✅ | The Vapi call id — a real server-side object, unlike OpenAI where we had to mint our own. |
| `onUsage(usage)` | ⚠️ **Different shape** | See §8. Vapi bills in **minutes and dollars**, not tokens. `TutorUsage` is five token counters. This does not map. |

**Score: 6½ / 8 controls, 5½ / 7 events.** The gaps are `cancelTurn`, `setOutputSilenced` (both
path-dependent) and `onUsage` (a genuine model mismatch, §8).

---

## 6. Where to cut the seam

### 6.1 The prompt must not leave the server

This is settled policy, not a preference. `openai-token/route.ts` says it plainly: *"Anything the
client could pass instead is something a shipped binary could be made to lie about, which is why
the words arrive in the request body as DATA and the prompt they go into never leaves this
process."*

Vapi offers three ways to configure a call, and only two respect that.

| Mechanism | Where the prompt lives | Verdict |
|---|---|---|
| **Transient assistant** — full JSON inline at `start()` | In the client request body | ❌ Violates the rule. Vapi's own docs warn: *"Full configuration visible in API requests — avoid sensitive data."* |
| **Assistant id + `variableValues`** | On Vapi's servers; client sends only the word list | ✅ **The fit.** Direct analogue of the ElevenLabs path. |
| **Server-created call** (`POST /call`, private key) | Never leaves us | ✅ **The best fit**, and it is what path B uses anyway. |

The middle row is the one to design against on path A, and it maps onto our existing machinery
almost exactly:

- `PromptVersion.prompt` already carries the `{{items_list}}` placeholder.
- Vapi's dynamic variables use the identical `{{name}}` syntax.
- `pnpm sync:agents` already reconciles filesystem → remote agent and writes `agents.lock.json`.
  A `provider: "vapi"` version would sync to `POST/PATCH /assistant` instead of ElevenLabs, and
  record the returned assistant id in the same lockfile — `agent-registry.ts` already models
  `agentId` as nullable-per-provider, so the shape holds.
- The client then calls:

```ts
vapi.start(assistantId, {
  variableValues: { items_list: formatItemsList(items) },
});
```

**One catch, and it is a real one.** `variableValues` cannot be set from the dashboard — API only —
which is fine. But on path A the *client* supplies them, and a shipped binary can lie about
`items_list` just as easily as about a prompt. On the ElevenLabs path we accept the equivalent
exposure; if we want better, path B closes it completely.

**A second catch: `assistant-request` does not help here.** Vapi's "ask your server for the config
at call time" webhook — which would be the ideal answer — is documented for *inbound phone calls
only*. Do not design around it for web/mobile calls without verifying it first.

### 6.2 Securing the client credential

`new Vapi(key)` takes either a public API key or a **public-scope JWT** minted server-side with the
private key. Take the JWT. It is a per-session credential our token routes already know how to mint,
and it carries real restrictions:

```js
const payload = {
  orgId: process.env.VAPI_ORG_ID,
  token: {
    tag: "public",
    restrictions: {
      enabled: true,
      allowedOrigins: ["https://…"],
      allowedAssistantIds: ["<the words-3.0 assistant id>"],
      allowTransientAssistant: false,   // ← enforces §6.1
    },
  },
};
// signed with VAPI_PRIVATE_KEY, expiresIn: "1h"
```

`allowTransientAssistant: false` is the one to note: it makes the "prompt stays server-side" rule
something Vapi enforces, not something we merely observe.

⚠️ **`allowedOrigins` is a browser concept.** A React Native client sends no `Origin` header. Either
that restriction is a no-op for us or it rejects us outright — this must be tested, not assumed. If
it turns out to be load-bearing, short expiry + `allowedAssistantIds` is the remaining defence.

This slots into `/api/v2/words-agent/vapi-token`, beside the two token routes we already have.

### 6.3 Path B — the WebSocket transport

This is the finding worth the research. Vapi supports a transport that has nothing to do with Daily
or WebRTC:

```jsonc
// POST https://api.vapi.ai/call   (private key, from OUR server)
{
  "assistantId": "…",
  "assistantOverrides": { "variableValues": { "items_list": "…" } },
  "transport": {
    "provider": "vapi.websocket",
    "audioFormat": { "format": "pcm_s16le", "container": "raw", "sampleRate": 16000 }
  }
}
```

Response:

```json
{
  "id": "7420f27a-30fd-4f49-a995-5549ae7cc00d",
  "type": "vapi.websocketCall",
  "transport": {
    "provider": "vapi.websocket",
    "websocketCallUrl": "wss://api.vapi.ai/7420f27a-…/transport"
  }
}
```

The socket then carries **binary PCM frames both ways** plus **JSON control messages** (`say`,
`add-message`, `control`/hangup+mute, and inbound `transcript` / `speech-update` / `end-call`).

Why this is architecturally the *best* of the three providers for us:

- **The prompt and the word list never touch the client.** Our server mints the call with the
  private key and hands the phone an opaque `wss://` URL that expires with the call. This is
  strictly better than what either existing provider gives us — it is the guarantee
  `openai-token/route.ts` wants and can only approximate.
- **No Daily, no second WebRTC fork, no third AVAudioSession owner.** Every objection in §4
  evaporates.
- **The row key arrives before the client connects.** `id` comes back to our server at mint time,
  so `lesson_sessions` is keyed without OpenAI's mint-our-own-uuid workaround.
- **`setOutputSilenced` and `cancelTurn` become easy.** We hold the frames; silencing is dropping
  them, and hangup/mute are documented control messages.

What it costs, stated honestly:

- **A native audio module we do not have.** 16 kHz mono PCM capture and playback, streaming, with
  the audio session integrated into `audio-session.ts`'s policy. Expo has no raw-PCM streaming
  primitive; this is a Swift module under `apps/mobile/modules/`. The OpenAI hand-roll was cheap
  *because the WebRTC stack was already in the binary* — this one is not.
- **We own echo cancellation, jitter buffering and endpointing-adjacent audio plumbing** that WebRTC
  was doing for free. On a speakerphone tutor lesson, AEC is not optional. This is the part most
  likely to be underestimated: budget for `AVAudioEngine` + `kAudioUnitSubType_VoiceProcessingIO`,
  not for a naive recorder.
- **Continuous frames are mandatory.** Vapi's docs warn that gaps in the stream trigger
  `silence-timed-out`. A held pause must keep sending silence, not stop sending — which is
  `keepAlive()` reincarnated as an audio-level concern.

---

## 7. Configuring our actual lesson

Mapping `PromptVersion` (`apps/web/src/agent/prompts/types.ts`) onto Vapi's assistant object:

| `PromptVersion` field | Vapi equivalent | Notes |
|---|---|---|
| `prompt` | `model.messages[0].content` (role `system`) | `{{items_list}}` works verbatim — same syntax. |
| `llm` | `model.provider` + `model.model` | Any of OpenAI / Anthropic / Google. NOT where this version earns its keep — an ElevenLabs agent already names its own LLM, and `DEFAULT_LLM` is Claude. What Vapi adds is its ORCHESTRATION: `startSpeakingPlan` / `stopSpeakingPlan` and `end-of-call-report`. |
| `voiceId` | — | **IGNORED.** No `voice` block is sent; Vapi uses its own default. See §9.2. |
| `ttsModelId` | — | **IGNORED**, for the same reason. |
| `maxTokens` | `model.maxTokens` | |
| `maxDurationSeconds` | `maxDurationSeconds` | Vapi default 600 — **the same 600 that silently cut sessions in S1**. Pin it, for the same reason and with the same care. |
| `silenceEndCallTimeoutSeconds` | `silenceTimeoutSeconds` | The held-pause backstop. |
| `turnTimeoutSeconds` | ⚠️ No direct equivalent | Vapi has no "re-engage the learner after N seconds of silence" timer; its silence timer *ends the call*. Podcast pacing (`words-1.5`, `words-2.0`) would need `vapi.say()` driven by a client-side timer — which, given §5.1, is actually a **cleaner** mechanism than either the EL re-engage timer or OpenAI's `idle_timeout_ms`. |
| `turnEagerness` | `startSpeakingPlan` + `stopSpeakingPlan` | Richer than either: `waitSeconds`, `smartEndpointingPlan`, and for interruptions `numWords` / `voiceSeconds` / `backoffSeconds`. `patient` → higher `waitSeconds` + higher `numWords`. |
| `additionalLanguages` | transcriber/voice language config | Verify per provider. |

**Speech-to-speech caveat.** If a Vapi version uses `gpt-realtime-2025-08-28`, then: the transcriber
config is ignored, six OpenAI voices are unavailable (`ash`, `ballad`, `coral`, `fable`, `onyx`,
`nova`), knowledge bases and voice cloning are off, and *"transcripts may differ slightly from
traditional STT output"* — which matters, because our transcripts are a stored artifact. Tool calling
is supported unchanged.

**Tools.** If a Vapi version should reach our MCP-style word tools
(`docs/2026-08-23-mcp-server-add-words.md`), use **server tools**, not client-side ones. Vapi's
client-side tools are documented as fire-and-forget: *"Client-side tools cannot send a tool 'result'
back to the model."* Anything whose output the tutor must reason about has to be a server tool
pointing at our API, which is where the Auth0 session lives anyway.

---

## 8. Observability and cost accounting

**The good news.** Vapi has a real `end-of-call-report` webhook carrying `endedReason`, the full
`artifact.transcript`, `artifact.messages` and a recording. That is a direct replacement for the
ElevenLabs post-call webhook whose *loss* §11.5 of the OpenAI note listed as a downside — and it
would feed the same `sanitizeTranscript` → `lesson_sessions` path, with the same
`conversation_id`-keyed upsert. Set up alongside our existing webhook, this is the least novel piece
of the whole integration.

**The mismatch.** `TutorUsage` is five token counters. Vapi bills **per minute, in dollars**:

- $0.05/min Vapi platform fee, plus pass-through for STT, LLM and TTS.
- Realistic all-in for our shape (ElevenLabs voice, a good LLM): **~$0.15–0.30/min**.
- Rock-bottom (Deepgram Nova + small LLM + Deepgram Aura): ~$0.10/min.
- Telephony is not in our path — web/WebSocket calls skip it.

Two consequences worth deciding before building:

1. **`onUsage(TutorUsage)` has no honest implementation on Vapi.** Options: leave it unreported (the
   adapter simply never calls it) and take cost from the `end-of-call-report`'s cost breakdown
   server-side, which is more accurate anyway; or widen `TutorUsage` with an optional
   `costUsd`/`durationSeconds`. **Prefer the first** — it keeps the shared contract honest instead of
   growing a union that means different things per provider.
2. **This is a markup on providers we already pay directly, and §9.2's decision sharpens it.**
   Without our ElevenLabs key on Vapi, TTS is billed through Vapi's own relationship — so a Vapi
   lesson costs $0.05/min for orchestration PLUS a marked-up voice, against an ElevenLabs lesson we
   pay wholesale for. Adding an **Anthropic** key would remove that half of the markup and carries
   none of the coupling the ElevenLabs key does, since the tutor's voice does not depend on it.
   Whether the remainder buys something — the endpointing plans, `end-of-call-report`, the call
   analysis — is a product judgement, not a technical one.

---

## 9. What to create in the Vapi dashboard

Assuming the decision is to proceed. In order.

### 9.1 Account and keys

1. **Create the organization** at dashboard.vapi.ai. Note the **Org ID** — the JWT payload needs it.
2. **API Keys** page → copy both:
   - **Private key** → `VAPI_PRIVATE_KEY`, web backend only. Signs JWTs, creates calls, runs
     `sync:agents`. Never ships.
   - **Public key** → not needed if we mint JWTs (§6.2), which we should. Keep it for dashboard
     testing.
3. **Billing** → add a card, set a spend limit. Pay-as-you-go; there is a small free credit to spike
   against first.

### 9.2 Provider keys (BYOK) — DECIDED AGAINST, 2026-08-28

This section used to say: add our own ElevenLabs key to Vapi's **Provider Keys** page so the tutor
keeps the voice we ship and TTS is billed to our existing account rather than marked up.

**We are not doing that.** Vapi speaks in its own default voice, and `vapiAssistantBody`
(`apps/web/src/agent/vapi-assistant.ts`) sends no `voice` block at all.

The reasoning, since the original recommendation was not wrong so much as differently weighted:

- **It means handing a third party our `xi-api-key`** — the credential `lib/config.ts` guards as
  server-side-only and that a live product depends on. The mitigation available (a separate scoped
  ElevenLabs key) reduces the blast radius; it does not remove the link between the two accounts.
- **The benefit it was bought for evaporated.** BYOK was justified by "keep the voice constant
  against words-1.0". But holding the voice constant was never the point of this version — see the
  correction in `prompts/words-3.0.ts`: an ElevenLabs agent already runs whatever LLM we name, and
  `DEFAULT_LLM` is Claude, so words-1.0 *is* Claude in the ElevenLabs voice. There is no cell here
  that only BYOK unlocks.
- **Without the key, `voice.provider: "11labs"` would be billed through Vapi's own ElevenLabs
  relationship, at a markup, on top of the ElevenLabs bill we already pay directly.** Paying twice
  to make a comparison prettier is a bad trade.

The cost of the decision, stated plainly: a Vapi lesson does not sound like an ElevenLabs one, so
this version varies the voice as well as the orchestrator. `words-2.0` already lives with exactly
that on OpenAI (§11.3 of the OpenAI note). The prompt is what is held constant across all three, and
it is the variable that would actually invalidate a comparison.

Consequence for §7's table: `voiceId` and `ttsModelId` are IGNORED on a Vapi version, the same way
they are on an OpenAI one.

Model and transcriber keys are a separate question and are NOT foreclosed by this. Adding an
Anthropic key would stop Vapi marking up a model we already pay for — worth doing before this
version runs at any volume, and it carries none of the coupling that the ElevenLabs key does,
because the tutor's voice does not depend on it.

### 9.3 The assistant

Create **one assistant per prompt version**, named to match — `words-3.0` — exactly as
`sync:agents` names ElevenLabs agents today. Configure:

- **Model**: provider + model + `maxTokens`, and a system message that is our version's `prompt`
  **verbatim, `{{items_list}}` included**.
- **Voice**: none — leave Vapi's default. See §9.2; we are not linking the ElevenLabs account.
- **Transcriber**: leave Vapi's default too — the registry has never had a field for one.
- **First message**: leave empty or set `firstMessageMode` so the tutor opens from the prompt, not
  from a canned line.
- **`maxDurationSeconds`**: pin it. Do not inherit 600 (§7).
- **`silenceTimeoutSeconds`**: high, or effectively disabled — a held pause is a long silence by
  construction.
- **`startSpeakingPlan` / `stopSpeakingPlan`**: the `turnEagerness` translation.
- **Client messages**: enable at least `transcript`, `conversation-update`, `speech-update`,
  `status-update` — the adapter's event sources. Enable `tool-calls` only if a version uses
  client-side tools.
- **Server messages**: enable `end-of-call-report` (§8), and `status-update` if we want live status
  server-side.

**Do this by API, not by hand, as soon as it works.** The filesystem is the source of truth for
prompts (CLAUDE.md), and a hand-edited dashboard assistant is a prompt version that drifts silently.
Create it in the UI once to learn the shape, then extend `pnpm sync:agents` to reconcile it and
record the assistant id in `agents.lock.json` — the same rule, the same lockfile, a second remote.

### 9.4 Server URL and webhook secret

**Settings → Server URL** (or per-assistant, which is better — it lets a version opt out):

- URL: `https://<our-host>/api/v2/vapi/webhook`
- **Set a webhook secret** and verify it on every request. Our ElevenLabs post-call webhook already
  establishes this pattern; do not ship the route without it.
- Subscribe to `end-of-call-report`. Add `status-update` if useful. Do **not** subscribe to
  `transcript` server-side — it fires per partial and would be a firehose against a route whose only
  job is the final upsert.

### 9.5 What you do NOT need

- **A phone number.** Our calls are web/WebSocket. Buying one is a monthly charge for nothing, and
  the WebSocket transport explicitly forbids `phoneNumber`/`phoneNumberId`.
- **A Squad.** One tutor, one assistant.
- **A workflow.** Our lesson is a single prompt, not a branching flow.
- **A knowledge base.** The word list arrives as a dynamic variable, per lesson.

---

## 10. Suggested order of work

Stage 0 is a spike whose purpose is to *kill the project cheaply if it deserves killing*. That is how
the OpenAI note was structured and it paid for itself.

**Stage 0 — dashboard only, no code (½ day).**
Create the org, add the ElevenLabs provider key, create a `words-3.0` assistant with our real
`words-2.0` prompt text and our teacher voice, paste a realistic `items_list` in as literal text, and
run a lesson in the dashboard's test console. This answers the only question that matters first:
**is a Vapi-orchestrated lesson as good as the one we ship?** If the answer is no, stop here having
spent nothing.

**← THIS IS THE NEXT STEP, and as of 2026-08-27 it has not been done.** The transport question is
settled; this one is not, and §12.4 sharpens it: the comparison is not *Vapi vs ElevenLabs* but
*Vapi-on-a-shim vs ElevenLabs*, because path A's client rests on an unsupported package alias. The
gain to weigh it against is the one neither current provider can reach — Claude's teaching with
ElevenLabs' voice — at \$0.05/min plus that maintenance liability.

**Stage 0b — the native question. ✅ DONE 2026-08-27. Path A WORKS on device — §12.**
Three blockers, none of them the one §4 predicted: a framework-name collision at `pod install`, four
fork-only native methods missing at runtime, and a Metro transform-cache trap. All cleared. The
silence test `audio-session.ts` predicts was run and **passed in both orderings** (§12.6).

Stage 0b is now the ANSWERED question and stage 0 is the open one — note the inversion. The cheap
gate was skipped because the interesting question looked like the technical one; it was not. Nothing
below should start until stage 0 has an answer.

**Stage 1 — server side (1–2 days).**
`VAPI_PRIVATE_KEY` in `config.ts`. `provider: "vapi"` added to `TutorProviderId`
(`packages/shared/src/tutor/transport.ts`) — a one-line change that the `satisfies` in
`transport/index.ts` will immediately make into a compile error until the client has an adapter,
which is the registry doing its job. A `vapi-token` route that mints a call and returns
`{ callId, websocketCallUrl }` (path B) or `{ jwt, assistantId, variableValues }` (path A). The
webhook route. `sync:agents` extended.

**Stage 2 — the audio module (path B; the real cost, ~1 week).**
A Swift Expo module for 16 kHz PCM in/out with voice-processing AEC, integrated into
`audio-session.ts`'s ownership policy rather than beside it. Prove it standalone — record and play
back — before any Vapi code touches it.

**Stage 3 — the adapter (2–3 days).**
`apps/mobile/src/lib/transport/vapi.ts`, one line in `TUTOR_PROVIDERS`. `capabilities` measured on a
device, not hoped for — `capsFor` in `openai.ts` is the precedent for capabilities that vary by
session rather than by provider. The spike screen already exercises `say()` and `setMuted`; the two
flags still unmeasured are `cancelTurn` and `setOutputSilenced` (§5.1), and both should be measured
before the adapter claims them.

Before this stage, promote the spike's shim out of `lib/spike/`: an adapter depending on a file
labelled NEVER MERGE is a contradiction, and the decision to carry that shim deserves its own review
rather than arriving as a side effect.

**Stage 4 — a `words-3.0` version**, and the picker gets a third entry for free.

---

## 11. Open questions

1. **What is Vapi actually buying us?** ElevenLabs gives us the voice; OpenAI gives us a tutor that
   hears pronunciation. Vapi gives us a *matrix* — Claude's teaching with ElevenLabs' voice is the
   most interesting cell, and it is one neither current provider can reach. Is that worth \$0.05/min
   plus either a shimmed client (path A) or a native audio module (path B)? **Stage 0 answers this
   for the price of an afternoon.** Now the ONLY blocking question — everything technical that stood
   in front of it has been answered.
2. **Does `allowedOrigins` reject a React Native client?** (§6.2) **Un-mooted** — it was retired when
   path A looked dead, and path A is alive, so it matters again: a working path-A adapter ships a
   client credential, and this is what would restrict it. RN sends no `Origin` header, so the
   restriction is either a no-op or a rejection. Untested. Path B still sidesteps it entirely.
3. ~~**Does Daily's stack work on Expo SDK 57 / New Architecture?**~~ **ANSWERED: yes** (§12.6). It
   runs on device under the New Architecture — Daily's JS against LiveKit's M137 native code, with
   four fork-only methods shimmed. `react-native-background-timer` remains the weakest link:
   unmaintained, untested on New Arch, and reached through the interop layer.
4. **Is `onTurnCorrected` reconstructible from `conversation-update`?** (§5.2) If not, barge-in
   transcripts on Vapi are worse than on both current providers — and §6.1 of the OpenAI note treated
   that as important enough to be a gating concern.
5. **Does `assistant-request` work for non-phone calls?** (§6.1) **Now the highest-value cheap
   question**, because path A works: if yes, path A gets path B's prompt-stays-server-side guarantee
   without the PCM module, and the two paths collapse into one. Documented for inbound phone calls
   only. Worth twenty minutes with Vapi support before any adapter work.
6. **Should `TutorUsage` change, or should the adapter stay silent?** (§8) Recommendation: stay
   silent, take cost from the webhook.
7. ~~**Does a Vapi call survive a locked screen?**~~ **ANSWERED: yes** (§12.6, 2026-08-28). Locked
   mid-call, the conversation continues. This was the highest-risk unmeasured item, because the shim
   no-ops `enableNoOpRecordingEnsuringBackgroundContinuity` — Daily's own mechanism for it. The bet
   that `UIBackgroundModes: ["audio"]` plus `audio-session.ts` already covers it held, which means
   Vapi matches ElevenLabs on the capability this native app was built for.

---

## 12. Stage 0b results — 2026-08-27

Run on branch `spike/vapi-webrtc-daily`. **Path A WORKS on device.** It took three attempts and two
blockers that had nothing to do with each other, and the result is qualified rather than clean — see
§12.6 for what that qualification costs.

The short version, in the order the blockers appeared:

| # | Blocker | Resolution |
|---|---|---|
| 1 | Two `WebRTC.xcframework`s — `pod install` refuses | Delete Daily's fork, alias it to LiveKit's (§12.2b) |
| 2 | Daily's JS calls four methods LiveKit's fork lacks | A JS shim routing them into `audio-session.ts` (§12.2c) |
| 3 | `EXPO_PUBLIC_*` stale in Metro's transform cache | Read from the manifest via `extra`, not `process.env` |

None was predicted by §4, which expected a duplicate-class disaster and got a packaging error, a
missing-method error, and a caching error instead.

### 12.1 What was installed

Exactly what `@vapi-ai/react-native@0.3.0` asks for, peer deps satisfied rather than fought:

```
@vapi-ai/react-native              0.3.0
@daily-co/react-native-daily-js    0.78.0
@daily-co/react-native-webrtc      118.0.3-daily.4   (exact — the SDK pins it)
@react-native-async-storage/async-storage  1.24.0    (downgraded from 3.1.1 to satisfy Daily)
react-native-get-random-values     1.11.0            (downgraded from 2.0.0 to satisfy Daily)
```

`pnpm add` succeeded. Both forks sat in `apps/mobile/node_modules` side by side —
`@livekit/react-native-webrtc@137.0.3` and `@daily-co/react-native-webrtc@118.0.3-daily.4`. JS-level
installation is not where this fails, which is worth knowing: **nothing warns you until CocoaPods.**

Note the two downgrades. `^0.78.0` on a `0.x` package means `0.78.x` only, so Vapi's caret pins the
whole Daily stack to its 2023-era release — and drags async-storage back two majors with it.

### 12.2 The failure

`npx expo prebuild --clean --platform ios`. Autolinking found both, CocoaPods resolved both, and
then refused:

```
Installing WebRTC-SDK (137.7151.09)
Installing livekit-react-native-webrtc (137.0.3)
Installing react-native-daily-js (0.78.0)
Installing react-native-webrtc (118.0.3-daily.4)

[!] The 'Pods-EnglishTutorDev' target has frameworks with conflicting names: webrtc.xcframework.
```

The mechanism, from the two podspecs:

| | LiveKit fork | Daily fork |
|---|---|---|
| Pod name | `livekit-react-native-webrtc` | `react-native-webrtc` |
| Binary dependency | `WebRTC-SDK` `= 137.7151.09` | `JitsiWebRTC` `~> 118.0.0` |
| Vendored framework | `WebRTC.xcframework` | `WebRTC.xcframework` |

The *pod* names differ, which is why resolution gets as far as it does. The *framework* names are
identical, and CocoaPods will not link two frameworks with one name into one target. M137 and M118
of the same library, both called WebRTC.

**Control:** reverting the five packages and re-running the same prebuild → `✔ Installed CocoaPods`.
The Daily stack is the only variable.

### 12.2b Attempt 2 — one WebRTC package, and `pod install` passes

The failure above was reproduced on the EAS build machine (`Pods-EnglishTutorPreview`), which
settles that it is not local toolchain state. The obvious next move — pin the two forks to a common
version — does not work, for two independent reasons worth recording:

1. **The error is name-based, not version-based.** CocoaPods is refusing two vendored frameworks
   both called `WebRTC.xcframework`. Aligning versions would still leave two of them.
2. **No common version exists.** Daily's fork stops at `124.0.6-daily.2`; LiveKit's published line
   runs `…125.0.12, 137.x, 144.x`. The ranges never overlap.

So the fork had to be removed rather than reconciled, and three findings said it could be:

- **`react-native-daily-js`'s podspec depends on `React-Core` and its own screen-share extension —
  not on the webrtc pod.** Daily's native layer never needed Jitsi; only the JS peer dependency did.
  This is the finding the whole fix rests on.
- **LiveKit's fork is a JS superset of Daily's**: 36 modules vs 45, all 36 present, the extra 9
  being LiveKit additions (`RTCAudioSession`, frame cryptors, `RTCPIPView`).
- The one re-exported API that looked like a gap — `mediaDevices.ondevicechange` / `devicechange` —
  is present in LiveKit's `MediaDevices.ts`.

`@daily-co/react-native-webrtc` is therefore uninstalled, with `metro.config.js` and a `tsconfig`
`paths` entry redirecting its imports to `@livekit/react-native-webrtc`. The pod graph becomes:

```
livekit-react-native-webrtc (137.0.3) → WebRTC-SDK (137.7151.09)   ← the only WebRTC.xcframework
react-native-daily-js (0.78.0)        → ReactNativeDailyJSScreenShareExtension (0.0.1)
```

`pod install`, `typecheck`, `lint` and a Metro bundle all pass. `UIBackgroundModes` stays `["audio"]`
— verified in the generated Info.plist; Daily's plugin only mentions `voip` in its README and does
not inject it.

**This changes the verdict from "closed" to "untested on device", not to "works".** §12.3 below
listed rename-the-framework as a dead end because it left two definitions of every ObjC class; this
approach avoids that specific trap — there is genuinely one `WebRTCModule`, one `RTCPeerConnection`,
one `RTCAudioSession` now. What it does not do is make Daily's M118-era JS correct against LiveKit's
M137 native code. Every API that changed shape between those generations is now a **runtime** failure
on device, and the A/B silence test in §12.2 is still the thing that decides it.

### 12.2c The second blocker: four methods that only exist in Daily's fork

Getting `pod install` green exposed a failure that would not have surfaced until the first tap, and
was found by reading Daily's source rather than by waiting for it.

`WebRTCModule+Daily.m` is a 171-line ObjC category that exists **only in Daily's fork**. It exports
four methods LiveKit's has never had:

```
setDailyAudioMode                                ← sets the AVAudioSession category
setAudioDevice / getAudioDevice                  ← output routing
enableNoOpRecordingEnsuringBackgroundContinuity  ← keeps audio alive in the background
```

`react-native-daily-js` reads all four off `NativeModules.WebRTCModule` as **plain properties** while
building its `nativeUtils` object. Missing properties are `undefined`, which does not throw at
import — it throws on join, as `nativeUtils.setAudioMode is not a function`. Build green, app
launches, dies on Start.

`apps/mobile/src/lib/spike/daily-webrtc-shim.ts` supplies them, and the no-ops are the *right* answer
rather than a stub: all four are AVAudioSession concerns, and this app already has an owner for those.
`setDailyAudioMode` routes into `applyVoiceLessonCategory()` — same intent, asserted by the module
that is allowed to assert it — and the other three are honest no-ops, because `videoChat` already
routes to the speaker and `UIBackgroundModes: ["audio"]` already keeps the app alive.

The no-op on `enableNoOpRecordingEnsuringBackgroundContinuity` was the riskiest line in the shim,
since it discards Daily's background-audio mechanism outright. **Measured on device: a Vapi call
survives a locked screen** (§12.6), so the app's own background handling does cover it.

**This retires a §4 worry outright.** `react-native-daily-js`'s own iOS code (`DailyNativeUtils.m`)
contains no AVAudioSession references at all. Every bit of Daily's audio policy lived in the fork
category we no longer compile — so Daily is **not** a third audio-session owner, and the fear that
drove most of §4's pessimism does not apply once the fork is gone.

### 12.2d The third blocker: `EXPO_PUBLIC_*` and Metro's transform cache

Not a Vapi problem, but it cost real time and it will recur, so it is recorded here.

The spike screen read `process.env.EXPO_PUBLIC_VAPI_PUBLIC_KEY`. Those reads are inlined by
`babel-preset-expo` at **transform** time, and Metro caches transforms per file — so editing `.env`
leaves a stale `undefined` compiled into the bundle. The build succeeds; the screen reports the
variable as undefined. Confirmed by bisecting the cache rather than by argument:

| Command | Value in bundle |
|---|---|
| `expo export` | **absent** |
| `expo export --clear` | **present** |

Same source, same `.env`. The fix was to stop using `process.env` in app code: `app.config.ts`
publishes `extra.spikeVapi` and the screen reads `Constants.expoConfig`. `app.config.ts` is
re-evaluated on every start / prebuild / build and lands in the manifest, which no transform cache
sits in front of — and it is the path the app's four real variables already take. Verified against a
live dev server: the served manifest carries `extra.expoClient.extra.spikeVapi` with both values.

**The general lesson for this repo:** `extra` is cache-proof, `process.env.EXPO_PUBLIC_*` is not.
That is a good reason the existing env pipeline is built the way it is, and a good reason not to
add a second one.

### 12.3 Why there is no way to force it (attempt 1)

Superseded in part by §12.2b — door 3 turned out to have a variant that works. Kept because doors 1
and 2 still stand, and because door 3's reasoning is why the fix took the shape it did.

Three doors, all checked:

1. **Align the versions.** Not available in either direction. `@elevenlabs/react-native` declares
   `peerDependencies["@livekit/react-native-webrtc"]: "^137.0.2"`, and `@vapi-ai/react-native` pins
   `118.0.3-daily.4` exactly. Neither range can move toward the other, and Daily's own current
   release is `124.0.6-daily.1` — so Vapi is pinned below even Daily's own line.
2. **Drop LiveKit.** Not available. LiveKit's fork is not our choice; it is a hard peer dependency
   of the ElevenLabs SDK, which is the primary provider. Removing it means removing ElevenLabs.
3. **Rename one framework in a `post_install` hook.** This is the one that looks clever and is not.
   The two forks share **39 identically-named ObjC source files** — `WebRTCModule.m`,
   `RTCVideoViewManager.m`, `SerializeUtils.m`, `VideoCaptureController.m`, the lot. ObjC has a flat
   class namespace, so getting past CocoaPods only buys you two definitions of every class from two
   different WebRTC generations, with the runtime picking one arbitrarily. `RTCAudioSession` is in
   that set — which means the failure mode is a lesson that renders no sound, the exact bug
   `audio-session.ts` was written to prevent and the hardest one in this codebase to diagnose.

So the honest summary: this is not a configuration problem, and it is not ours to fix. It resolves
only if Vapi/Daily and LiveKit ship the same WebRTC binary, or if Vapi's SDK stops vendoring one.

### 12.4 What this does and does not say

**It says the transport works.** Vapi places and holds a call in a binary where Daily's 2023-era JS
is driving LiveKit's M137 native code, with the app's own audio policy in charge. That was the open
question and it is answered.

**It does not say path A is production-ready**, and the gap is not a detail. What holds it up:

- an alias redirecting one vendor's package to another vendor's fork, three WebRTC generations apart;
- four native methods stubbed in JS because the fork we kept never had them;
- `@daily-co/react-native-daily-js` pinned to `0.78.x` by Vapi's caret, with `async-storage` dragged
  back two majors to match;
- `react-native-background-timer`, flagged unmaintained and untested on the New Architecture, running
  through the interop layer.

None of that is endorsed by anyone upstream. Any Vapi or Daily release can break it silently, and no
contract says it should work at all. That is acceptable for answering a question and is a standing
liability as a dependency.

So the honest framing for the next decision is not *"Vapi vs ElevenLabs"* but **"Vapi-on-a-shim vs
ElevenLabs"** — and if the product answer in §11 Q1 turns out to be a clear yes, path B (§6.3) is
worth re-pricing, because it needs no shim, no Daily, and keeps the prompt server-side.

§5's scoring is unchanged and still favourable: 6½/8 controls, 5½/7 events, with `vapi.say()` better
than anything either current provider offers and `end-of-call-report` restoring what §11.5 of the
OpenAI note listed as a loss.

### 12.5 Reproducing

The branch carries the working configuration; nothing needs installing by hand.

```bash
git checkout spike/vapi-webrtc-daily
pnpm install
cd apps/mobile
# EXPO_PUBLIC_VAPI_PUBLIC_KEY + EXPO_PUBLIC_VAPI_ASSISTANT_ID in .env (or on EAS)
npx expo prebuild --clean --platform ios
pnpm device                      # a REAL device; the simulator does not exercise AVAudioSession
```

Then: sign in, tap the red **SPIKE** pill bottom-left, tap **Start Vapi**. `SPIKE-VAPI.md` is the
runbook, including the 3-minute Vapi assistant recipe.

Unlike attempt 1, this branch is **not** reverted after measurement — the configuration is the
finding, and it is what a stage-3 adapter would start from.

### 12.6 What was measured on device — 2026-08-27

Verified on hardware, development variant:

| Check | Result |
|---|---|
| `pod install` with one WebRTC package | pass |
| SDK loads; Daily's JS accepts LiveKit's fork | pass |
| Shim installs all four methods | pass |
| Call connects and the agent is **audible** | pass |
| **(b)** ElevenLabs lesson → end → Vapi call, audible | **pass** |
| **(c)** Vapi call → stop → ElevenLabs lesson, audible | **pass** |
| **Locked screen** — lock the phone mid-call, conversation continues | **pass** |

**(b) and (c) are the result that matters.** They are the AVAudioSession contention test, and a
failure there would have presented as silence rather than as an error — the failure mode
`audio-session.ts` exists to prevent and the one that cost the OpenAI spike a day. Both orderings
audible means the two providers genuinely coexist in one process, with `audio-session.ts` as the
single owner and the shim deferring to it. That is the strongest single result of this spike, and it
is the one §4 predicted would fail.

**The locked-screen pass is the second real result, and it validates the shim's central bet.** The
shim no-ops `enableNoOpRecordingEnsuringBackgroundContinuity` — Daily's own mechanism for holding an
audio unit open so iOS does not suspend the app. The bet was that this app does not need it, because
`UIBackgroundModes: ["audio"]` plus `audio-session.ts` already solve that problem; solving it is the
reason the native app exists (`docs/2026-08-13-expo-s1-background-audio.md`). Locking the phone
mid-call and having the conversation continue is that bet paying off, and it is the strongest
evidence that routing Daily's audio concerns into this app's existing owner was the right shape for
the shim rather than a convenient stub.

It also means the two providers now match on the capability the whole native app was built for.
A Vapi lesson survives a locked screen exactly as an ElevenLabs one does.

Still unmeasured, and cheap: `say()`, `setMuted`, and a second call after teardown (where
lifecycle bugs usually surface). None of these is disqualifying — they are adapter details, not
feasibility questions. `cancelTurn` and `setOutputSilenced` (§5.1) remain the two capability flags
that must be measured before an adapter claims them.

## Sources

- [Vapi introduction](https://docs.vapi.ai/quickstart/introduction) ·
  [Web SDK](https://docs.vapi.ai/quickstart/web) ·
  [React Native SDK](https://github.com/VapiAI/client-sdk-react-native)
- [WebSocket transport](https://docs.vapi.ai/calls/websocket-transport) ·
  [Dynamic variables](https://docs.vapi.ai/assistants/dynamic-variables) ·
  [Transient vs permanent](https://docs.vapi.ai/assistants/concepts/transient-vs-permanent-configurations)
- [Server URL events](https://docs.vapi.ai/server-url/events) ·
  [Personalization](https://docs.vapi.ai/assistants/personalization) ·
  [Client-side tools](https://docs.vapi.ai/tools/client-side-websdk)
- [JWT authentication](https://docs.vapi.ai/customization/jwt-authentication) ·
  [API keys](https://docs.vapi.ai/security-and-privacy/api-keys) ·
  [Provider keys](https://docs.vapi.ai/customization/provider-keys)
- [OpenAI Realtime on Vapi](https://docs.vapi.ai/openai-realtime) ·
  [Speech configuration](https://docs.vapi.ai/customization/speech-configuration)
- [Daily React Native](https://docs.daily.co/docs/react-native) ·
  [Expo config plugin](https://github.com/daily-co/rn-daily-js-expo-config-plugin)
- Pricing: [Vapi pricing math](https://vapi.health/learn/vapi-pricing-per-minute) ·
  [Cekura breakdown](https://www.cekura.ai/blogs/vapi-ai-pricing) ·
  [Layer3Labs](https://www.layer3labs.io/guides/vapi-pricing)
