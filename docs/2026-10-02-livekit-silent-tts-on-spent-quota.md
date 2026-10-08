# LiveKit: a spent ElevenLabs quota is a tutor with no voice

Debug report `d2a257ee` (2026-10-02, preview build 1.0.0 (1), iPhone 14 Pro, `words-4.0`). The
learner's note: _"Does not work"_. A follow-up to `2026-10-01-quota-refusal-with-no-error.md`: the
same outage, on the provider that doc did not cover.

> **Update 2026-10-08: superseded for LiveKit.** The worker's TTS moved from ElevenLabs Flash to
> **Deepgram Aura-2** (`aura-2-asteria-en`, `DEEPGRAM_TTS_MODEL`), so a spent ElevenLabs quota can no
> longer silence this stack. Fixes 1 and 3 below (the token-route credit check and the worker's
> `src/credits.ts` lookup) were **removed** in the same change; see "What changed since" at the end.
> The cause, the silent-socket behaviour and fixes 2, 4 and 5 describe the incident as it happened, and
> 2, 4 and 5 are still in place.

## What the report shows

Everything that can be seen from the phone worked. The token minted (200), the phone joined
`lesson-d1db18dd-…`, the worker joined 15.3 s later (a cold start, inside the 45 s budget),
`tutor.ready` landed and the kickoff was sent. No error was recorded.

Then nothing. The stored conversation ran 115 s and holds two lines, both the learner's
("Continue." at 24 s, "Test test the serum." at 68 s). `livekit_turn_ledger` has **zero rows** for
it. So speech-to-text was working, and no tutor turn was ever committed.

`lk agent logs` could not add anything: it tails the current pod only, and a deploy replaced the pod
that ran this lesson 24 s after its worker joined.

## The cause

The ElevenLabs account was at 30,000 / 30,000 characters. Over REST that is a refusal anyone can
read:

    401 quota_exceeded — You have 0 credits remaining, while 1 credits are required for this request.

Over the streaming socket the worker's TTS uses (`multi-stream-input`), it is not an error at all.
A request with text in it is answered, ~40 ms later, with

    {"audio":null,"isFinal":true,"normalizedAlignment":null,"alignment":null,"contextId":"c1"}

The plugin reads that as a synthesis that finished cleanly and produced nothing. Measured with the
worker's own `createTts()` on 2026-10-02: 33 speakable characters in, 0 frames out, no `error`
event, nothing thrown.

Every signal the worker listened to was waiting for an event that never came:

| Signal | Why it stayed quiet |
|---|---|
| `AgentSession` `Error` event | no `tts_error` was emitted, so the unrecoverable-error count never moved and the session never closed |
| TTS metrics | emitted per request id, which is taken from the first audio frame |
| Turn ledger | a turn closes on the tutor's committed message; nothing played, so nothing was committed, and the billed Claude tokens stayed in memory |
| The phone | a connected room with an agent in it; a tutor that is thinking looks exactly like this |

Anthropic and Deepgram were both healthy, which is why the learner's lines were transcribed.

## The fixes

**No code change makes a lesson speak.** The account needs topping up, or the quota resets on
2026-10-11. These make the failure say so.

1. **The token route refuses the Start.** `words-agent/livekit-token` now runs the same
   `elevenLabsCreditsExhausted` check the ElevenLabs route got on 2026-10-01, beside the lesson
   read, and answers 402 `quota` with the sentence. A backend with no `ELEVENLABS_API_KEY` skips it.
   It reads the backend's key; the worker's cloud secret is assumed to be the same account.

2. **The worker notices a reply that was never spoken** (`apps/voice-worker/src/speech-watch.ts`).
   The tutor's `ttsNode` is tapped on both sides: speakable characters in, audio frames out. Text in
   and no frames out, on a synthesis that ran to its own end, is a silent reply. A barge-in cancels
   the stream and is never judged; punctuation alone is legitimately silent.

3. **A silent reply ends the lesson, with the reason.** The worker asks the account
   (`src/credits.ts`). If it is out of credits, the lesson ends at once with that sentence. If the
   account will not confirm it, the lesson continues and ends on the second silent reply in a row
   with a generic one. An outright `tts_error` counts the same way.

4. **`tutor.failed`** is the new lifecycle signal (`LIVEKIT_LIFECYCLE.FAILED`): an RPC to the phone
   whose payload is the sentence. The worker sends it INSTEAD of `tutor.ending` and leaves. The
   phone raises `onError` with the sentence and ends the session as `"error"`.

5. **The ledger writes down the turn that never closed.** `TurnLedger.flush()` runs at session
   end and emits a record when LLM calls or errors are pending — empty `agentHeardText`, the
   generated text, the tokens, and `tts:silent` in `errors`.

The decision "is this account out" moved to `@tutor/shared/tutor/elevenlabs-credits` because two
deployables now act on it. It keeps its rule: anything but a clean, fully-typed "used up and not
allowed to go over" is not "out".

## Rollout

Three deployables, and the order does not matter:

| Piece | What it gives on its own |
|---|---|
| Backend | Start is refused with the sentence. Covers every build already installed. |
| Worker | A lesson that goes silent mid-way ends within a moment instead of hanging. An installed build rejects `tutor.failed` as an unknown method and shows the "dropped" card with no sentence. |
| Phone | Shows the worker's sentence. Needs a new build. |

## What was and was not verified

Verified on 2026-10-02 against the exhausted account: the socket's answer above; the tap reporting
`{speakableChars: 33, frames: 0}` around the real plugin; both credit lookups returning the reset
date; `pnpm --filter voice-worker check` and `pnpm check:shared`.

Not verified: the `tutor.failed` RPC and the worker's shutdown in a real room, and the phone's
handler on a device. Those need the worker deployed and a lesson started from a new build while the
account is still dry — or with the backend check bypassed, since it now refuses that Start first.

## What changed since (2026-10-08)

The incident was an ElevenLabs-specific failure on a stack that only spoke through ElevenLabs. That
stopped being true when the worker's TTS became Deepgram Aura-2 (`createTts` in
`apps/voice-worker/src/pipeline.ts`; roughly $0.03 per 1k characters against $0.05 for Flash).

| Piece | Now |
|---|---|
| Token route `words-agent/livekit-token` | No credit check. It reads the lesson and mints. The ElevenLabs route (`words-1.x`) keeps its own check, since it still runs on ElevenLabs. |
| `apps/voice-worker/src/credits.ts` | Deleted. The worker no longer asks ElevenLabs anything. |
| Silent-reply handling (`speech-watch.ts`, `tutor.failed`, ledger flush) | Unchanged. A reply that never becomes audio is still detected. With no account to ask, the lesson now ends on the **second** silent reply in a row (`SILENT_REPLIES_BEFORE_FAILING`) with the generic "voice service returned no audio" sentence. |
| `ELEVENLABS_API_KEY` in the worker | Only `stt:check` uses it (it synthesizes test speech). The tutor does not. |

The shared `@tutor/shared/tutor/elevenlabs-credits` decision is still used by the ElevenLabs token route.

**Limits of the Deepgram voice.** Every Aura-2 voice is English-only, so a Russian translation moment
inside an item is not spoken in Russian. The lesson's `voiceId` (an ElevenLabs id) is ignored on this
stack, because a Deepgram voice is a model name.

**Deepgram Flux TTS was tried and not adopted.** Tested 2026-10-08 with a standalone script against
`wss://api.deepgram.com/v2/speak?model=flux-haley-en` on our key: English round-tripped word for word
through STT, first audio in about 1.0 s; Russian came back as garbage (all Flux voices are English).
`@livekit/agents-plugin-deepgram` 1.9.1 (latest) only speaks `/v1/speak`, so using it would mean a
custom plugin, for a product in Early Access that costs about $0.045 per 1k characters against
$0.030 for Aura-2.

**Rollout.** Merging to master deploys the worker through `.github/workflows/deploy-voice-worker.yml`
(it triggers on `apps/voice-worker/**`); nothing is deployed by hand. The web route change ships with
the normal backend deploy. `DEEPGRAM_API_KEY` was already a worker secret for STT.

**Not verified:** a live lesson on the Aura-2 voice, by ear or through the phone.
