# Voicebox plugins for the Node.js voice worker (STT + TTS)

Card: "LiveKit - Voicebox plugins". Goal: build, in this repo, Node.js LiveKit plugins with the same
logic as the Python plugins in `koval-yurko/voicebox`, branch `custom/main`,
`integrations/livekit` (package `voicebox_livekit`, Voicebox `0.6.0-custom.1`).

Status: built (section 7). Sections 1–5 are the research as written before the build.

## 1. What the Python integration contains

| File | Lines | What it does |
|---|---|---|
| `voicebox_livekit/stt.py` | 367 | `VoiceboxSTT` + `SpeechStream`: streaming STT over `WS /stt/ws`, plus batch `recognize` |
| `voicebox_livekit/tts.py` | 214 | `VoiceboxTTS` + `SynthesizeStream`: streaming TTS over `WS /tts/ws` |
| `voicebox_livekit/_common.py` | 6 | `ensure_ws_url`: `http://` → `ws://` |
| `tests/test_plugins.py` | 252 | 6 tests with fake WebSocket servers |
| `examples/voice_agent.py` | 111 | Local agent: Voicebox STT + TTS + Silero VAD (+ Ollama, or echo mode) |
| `scripts/smoke_stt.py`, `scripts/e2e_session.py` | 315 | STT on a WAV file; full `AgentSession` with a fake mic, checks transcripts and barge-in |

### 1.1 `VoiceboxSTT` (the new part)

Protocol `WS /stt/ws` (Voicebox `docs/research/stt-streaming-design.md` §7):

- Client → server: `start` `{model, language, sample_rate: 16000, vad, interim, interim_interval_ms,
  max_segment_s, delay_ms?}`, then binary PCM16 LE mono 16 kHz, `end_segment`, `cancel_segment`, `end`.
- Server → client: `ready {capabilities}`, `speech_start {segment_id, start_s}`,
  `interim {segment_id, text, stable_text}`, `final {segment_id, text, language, start_s, end_s}`,
  `speech_end {segment_id, end_s}`, `error {message}`, `end`.
- `text` is always the full segment text, not a delta.

Plugin logic:

1. Options: `model` (default `qwen-asr-0.6B`), `language` (none = detect), `base_url`
   (default `http://127.0.0.1:17493`), `vad` (default true = server VAD), `interim` (true),
   `interim_interval_ms` (500), `max_segment_s` (30), `delay_ms` (Voxtral only).
2. Capabilities: `streaming=True`, `interim_results` starts false and then follows
   `ready.capabilities.interim_results && interim`. `manual_flush=True`.
3. Stream `_run`: connect, send `start`, wait for `ready` (a server `error` here is not retryable:
   bad model, model not downloaded). Then 2 tasks:
   - send: audio frames (the base class resamples to 16 kHz; the plugin down-mixes to mono) as
     binary; a framework flush → `end_segment`; end of input → `end`.
   - receive: map events: `speech_start` → `START_OF_SPEECH`, `interim` → `INTERIM_TRANSCRIPT`,
     `final` → `FINAL_TRANSCRIPT`, `speech_end` → `END_OF_SPEECH`. A mid-stream `error` only logs:
     it concerns 1 segment, and the stream stays open.
4. If the stream ends inside speech, it emits a last `END_OF_SPEECH`, so the agent does not stay in
   "user speaking".
5. Server times `start_s` / `end_s` count from the first audio sample. The plugin adds the stream
   start offset.
6. Batch `recognize`: the same socket with `vad: false`, all audio as 1 segment, `end`, then joins
   the `final` texts.

### 1.2 `VoiceboxTTS`

1 `/tts/ws` session per stream: `start {profile_id, language, model_size, interval_ms, engine?,
instruct?}` → `ready {sample_rate}` → `text` / `flush` / `end` out, PCM frames in, `end` closes.
Barge-in closes the socket. The sample rate comes from `ready`.

## 2. What this repo already has

`services/voice-worker/src/voicebox-tts.ts` (466 lines) is already a Node.js port of the TTS
plugin, and it does more than the Python one:

- 2 transports: `ws` (`/tts/ws`, the live profile) and `http` (`POST /tts/stream`, kept, no profile).
- `qwen-socket-pool.ts`: the next socket is open and `start`ed before the reply needs it.
- Barge-in sends `cancel` before the close. `warm()` calls `/tts/warmup` during the greeting.
- An API key for the Cloudflare tunnel; per-reply timing logs; the last frame is marked `final`.
- Covered by `src/check.ts` (fake servers, http and ws).

Gaps compared with the Python TTS (small):

| Python option | Node today |
|---|---|
| `engine` (`qwen`, `kokoro`, ...) | not sent: the profile default is used |
| `instruct` | not sent |
| sample rate from `ready` | fixed 24 kHz; any other rate is refused |

**STT is the real gap.** The worker always uses Deepgram Flux (`src/pipeline.ts`, `createStt()`),
and there is no STT registry like `tts-profiles.ts`.

## 3. Facts checked on this machine (2026-10-30)

1. **The Voicebox app was `0.5.1-custom.3`** (`GET /` on `127.0.0.1:17493`), and a `/stt/ws` upgrade
   returned **HTTP 403**: that build has no such route. `/stt/ws` comes with `0.6.0-custom.1`
   (`custom/main`, commit `9e3adb1`), installed later the same day.
2. **The tunnel does not let STT through.** `backend/utils/api_keys.py`:
   `EXTERNAL_PATH_PREFIXES = ("/tts/",)`. An external `/stt/ws` gets 403 even with a valid key. So
   Voicebox STT works only for the Mac worker (`tutor-local`, `words-4.4`), not for the LiveKit
   Cloud worker. A Cloud worker would also send the learner's microphone audio through the tunnel.
3. **`@livekit/agents` 1.9.1 for Node has no `manualFlush` capability**, and the session never
   flushes the STT stream on VAD end of speech (`voice/audio_recognition.js` flushes only the VAD
   and the turn detector streams). So the Python path "agent VAD end → `end_segment`" does not exist
   in Node. The Node plugin must use the **server VAD (`vad: true`)**. That is also the start mode
   that the Voicebox design doc recommends (§8). The plugin still maps a framework flush to
   `end_segment`, for callers that flush.
4. The Node `SpeechStream` takes `sampleRate` in its constructor and resamples every frame (like
   Python). `_recognize` is abstract and must exist. `prewarm()` exists and can open the first
   socket early.
5. Node `SpeechEvent.speechEndTime` is wall-clock **milliseconds**; `SpeechData.startTime/endTime`
   are seconds. Python uses seconds for both.

## 4. Proposed design

### 4.1 Location

Recommended: **`services/voice-worker/src/voicebox/`**, next to the code that uses it.

```text
services/voice-worker/src/voicebox/
  stt.ts      # VoiceboxSTT + VoiceboxSpeechStream (new)
  tts.ts      # today's voicebox-tts.ts, moved; + engine, instruct
  common.ts   # wsUrl(), parse(), toArrayBuffer(), auth headers
  index.ts    # export { VoiceboxSTT, VoiceboxTTS }
```

Reasons: the voice worker is the only user; `qwen-socket-pool.ts` and `gate.ts` are shared with
`qwen-tts.ts`; the Dockerfile and `local-worker.sh` need no change.

Alternative: a workspace package `packages/livekit-voicebox` (`@tutor/livekit-voicebox`). It is
cleaner to reuse or publish later, but it needs a new `package.json`, ESLint and tsconfig, an entry
in the Dockerfile copy list, and `local-worker.sh` must install it. Not needed for 1 user.

### 4.2 `VoiceboxSTT` API

```ts
export interface VoiceboxSttOptions {
  url: string;                 // default http://127.0.0.1:17493
  model?: string;              // default "qwen-asr-0.6B"; undefined = server capture default
  language?: string;           // undefined = detect (EN + RU learners: keep undefined)
  vad: boolean;                // default true (see §3 fact 3)
  interim: boolean;            // default true
  interimIntervalMs: number;   // default 500
  maxSegmentS: number;         // default 30
  delayMs?: number;            // voxtral-realtime-4B only
  apiKey?: string;             // only if the server ever allows /stt/ through the tunnel
}

export class VoiceboxSTT extends stt.STT {
  label = "voicebox.STT";
  // capabilities: { streaming: true, interimResults: false } → updateCapabilities() on `ready`
  get model(); get provider(); // "voicebox"
  get serverCapabilities(): Record<string, unknown> | undefined;
  stream(options?): VoiceboxSpeechStream;
  protected _recognize(buffer, abortSignal): Promise<SpeechEvent>;   // vad:false, 1 segment
  prewarm(): void;                                                    // optional: open the socket early
}
```

Same rules as the Python stream (§1.1 points 3–5), written in the style of `voicebox-tts.ts`: the
`ws` package, a `[voicebox stt …]` log line per segment (time to `final`, text length), errors as
`APIStatusError` (start refused, not retryable) or `APIConnectionError` (socket lost, retryable).

### 4.3 Using it in the worker

1. Add an STT registry `src/stt-profiles.ts` (like `tts-profiles.ts`): `deepgram` (today, default)
   and `voicebox-local` (Voicebox on this Mac, `VOICEBOX_LOCAL_URL`).
2. Add `stt?: string` to the dispatch metadata (`packages/shared/src/tutor/livekit-wire.ts`) and to
   `PromptVersion` (`packages/server/src/agent/prompts/types.ts`), the same way as `tts`.
3. A new version (for example `words-4.5`, `worker: "local"`, `tts: "voicebox-local"`,
   `stt: "voicebox-local"`) turns it on, so `words-4.4` stays as the comparison point.
4. Env: `VOICEBOX_STT_MODEL`, `VOICEBOX_STT_LANGUAGE`, `VOICEBOX_STT_VAD` in `.env.example`.

Risk: Deepgram Flux gives the turn detector end-of-turn signals. With Voicebox STT, the session's
own VAD and turn detector decide the turn, and `speech_end` comes from the Voicebox server VAD.
Measure the end-of-speech → first-audio time against `words-4.4`. Also: STT steps and TTS chunks
share 1 GPU on the Mac (Voicebox design doc, "Risks").

### 4.4 Tests

Extend `src/check.ts` (the worker's test harness, `pnpm --filter voice-worker check`) with a fake
`/stt/ws` server, the same cases as Python `tests/test_plugins.py`:

1. A stream sends `start` with 16 kHz, sends audio as binary, and maps the 4 event types.
2. `interimResults` follows the `ready` capabilities.
3. A start `error` fails at once and is not retried.
4. `recognize` sends 1 segment with `vad: false` and joins the finals.
5. A framework flush sends `end_segment`; the end of input sends `end`.
6. A stream that closes inside speech emits `END_OF_SPEECH`.

Plus a live script `src/voicebox-stt-smoke.ts` (like Python `smoke_stt.py`): a WAV file → the real
server → print the events. It needs Voicebox `0.6.0-custom.1`.

## 5. Plan

1. Move `voicebox-tts.ts` to `src/voicebox/tts.ts`; add `engine` and `instruct`. No behaviour change.
2. Write `src/voicebox/stt.ts` and its `check.ts` cases.
3. STT registry + `stt` in dispatch metadata + a new local version.
4. Install Voicebox `0.6.0-custom.1`, run the smoke script, then 1 real lesson on `tutor-local`.

## 6. Decisions

1. Location: `services/voice-worker/src/voicebox-stt.ts`, next to `voicebox-tts.ts` (the flat layout
   the worker already uses). The TTS file did not move, and its small gaps (`engine`, `instruct`) are
   not part of this card.
2. Switch: a new version `words-4.5` = `words-4.4` + a Voicebox STT. `words-4.4` stays on
   Deepgram Flux. Later the same day, `words-4.5` also got the voice "Woman 2" (TTS profile
   `voicebox-local-woman-2`, Voicebox profile `b3b92303-6ba8-40e9-a1c6-6b13be5452ce`), so 4.4 against
   4.5 now differs in the STT and the voice.
3. Voicebox `0.6.0-custom.1` is installed on the Mac (2026-10-30), with `qwen-asr-0.6B` downloaded.

## 7. What was built

| File | What |
|---|---|
| `services/voice-worker/src/voicebox-stt.ts` | `VoiceboxSTT` + `VoiceboxSpeechStream` (§4.2), `prewarm()` loads the model, batch `recognize` |
| `services/voice-worker/src/stt-profiles.ts` | STT registry: `deepgram` (default) and one Voicebox profile per model: `voicebox-qwen-asr-0.6b` (`words-4.5`), `voicebox-qwen-asr-1.7b`, `voicebox-whisper-turbo`, `voicebox-whisper-base` |
| `packages/shared/src/tutor/livekit-wire.ts`, `packages/server/src/agent/prompts/types.ts` | `stt?: string`, like `tts` |
| `services/api/.../livekit-token/route.ts` | puts the version's `stt` in the dispatch metadata |
| `packages/server/src/agent/prompts/words-4.5.ts` | the new version |
| `services/voice-worker/src/check.ts` | registry cases + a fake `/stt/ws` server (§4.4 cases 1–6) |
| `services/voice-worker/src/voicebox-stt-smoke.ts` | `pnpm --filter voice-worker stt:voicebox <wav> [--profile <id>]` against the real app |

Live result (2026-10-30, `qwen-asr-0.6B`, the Python fixture `speech_pause_speech_16k.wav` sent in
real time): 2 segments, both finals correct, `ready` in 1.5 s on a cold model, `final` 82–257 ms after
`speech_end`. A Russian sentence from macOS `say` (Milena) came back correct with the language
detected. The server sends no `language` for Qwen3-ASR, so the events carry an empty one.

Still to measure in a real lesson: the session's own VAD and turn detector decide the turn, and
the Voicebox `final` comes ~500 ms (server VAD) plus the decode after the learner stops. With the
`patient` plan (800 ms minimum delay) the final should land first; if the worker logs "transcript
arrives after turn has been committed", that is this race.

The model is part of the STT profile name, fixed in code, so a version records the exact model
(decided 2026-10-30). An env override (`VOICEBOX_STT_MODEL`) was rejected: the Mac worker shares its
`.env` with the Cloud worker, and a stored lesson would not show which model it ran.

First comparison of the 4 profiles (2026-10-30, `stt:voicebox --profile <id>`, warm models, the
English fixture `speech_pause_speech_16k.wav` and one Russian sentence from macOS `say`). "Final"
is the time from the server's `speech_end` to its `final`; the server VAD adds ~500 ms before that.

| Profile | Interim text | Final (EN) | Final (RU) | Result |
|---|---|---|---|---|
| `voicebox-qwen-asr-0.6b` | yes | 91–98 ms | 108 ms | both correct; RU without punctuation |
| `voicebox-qwen-asr-1.7b` | yes | 133–185 ms | 225 ms | both correct, best punctuation |
| `voicebox-whisper-turbo` | no | 441–445 ms | 444 ms | both correct |
| `voicebox-whisper-base` | no | 326–335 ms | 13 s | EN with trailing dots; RU hallucinated ("Я Я Я …") — not usable for lessons |

One clip each, so this only rules out `whisper-base`. A real lesson decides between the other three.
