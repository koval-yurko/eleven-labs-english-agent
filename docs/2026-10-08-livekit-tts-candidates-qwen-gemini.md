# LiveKit TTS candidates: Qwen-Audio TTS Plus (4.1) and Gemini 3.8 Flash TTS (4.2)

Date: 2026-10-08. Baseline: `words-4.0` — Deepgram Flux STT → Claude → Deepgram Aura-2 TTS
(`34a2fc8`). 4.1 and 4.2 change **only the TTS stage**.

> **Outcome (2026-10-08, later the same day): `words-4.2` (Gemini) was tried and removed; only
> `words-4.1` (Qwen) remains.** Both lessons on 4.2 died in their first reply. The deployed key's
> project allowed 10 requests/min and 100/day on `gemini-3.8-flash-tts`, and the worker's
> one-request-per-sentence synthesis (with retries) sent ~30 requests in 5 s. A probe from a Tier 1
> key accepted only 11–17 of 20/30/50/100 simultaneous requests and then hit the daily cap. The
> Gemini profile, adapter, `words-4.2` module, the `@livekit/agents-plugin-google` dependency and
> the `GOOGLE_API_KEY` / `GEMINI_TTS_*` settings were deleted. §3 and the 4.2 rows below are kept
> as the record of what was researched, not as current setup. The open Qwen problem (a fatal TTS
> error mid-reply, report `b6184945`) is being chased with per-request tracing in
> `src/qwen-tts.ts` (`[qwen <id>]` lines in `lk agent logs`).

Sources are vendor docs where I could read them and third-party write-ups where I could not;
each claim says which. Nothing here was run against a live key.

## 1. Verdicts

| | Qwen-Audio TTS Plus (4.1) | Gemini 3.8 Flash TTS (4.2) |
|---|---|---|
| Integration | No LiveKit plugin → custom adapter (`src/qwen-tts.ts`, written, **untested**) | Official `@livekit/agents-plugin-google` (`beta.TTS`), already lists `gemini-3.8-flash-tts` |
| Russian | Yes — `language_hints` includes `ru` (Alibaba client-events doc) | Yes, auto-detected (Google speech-generation doc) — **fixes Aura-2's English-only gap** |
| Streaming | Duplex WebSocket (Alibaba doc) | Streaming via the Interactions API, raw PCM16 24 kHz (Google doc); the LiveKit plugin's streaming behaviour is unmeasured |
| Price | Unverified, see §2.3 | $0.50/M text in + $9.00/M audio out ⇒ ≈ 1.35 ¢/min until 2026-12-31, **doubles 2027-01-01** (cellcog.ai, matches Google's token basis) |
| Biggest risk | `qwen-audio-3.1-tts-plus` does not exist (§2.2); 4.1 is the 3.0 Plus model | Latency: only one reviewer figure (10–19 s per reading for the 3.1 *preview*, non-streaming); 3.8 is unmeasured |

~~Recommendation: ship 4.2 first (plugin exists, one key).~~ Superseded by the outcome above.

## 2. Alibaba Qwen-Audio TTS Plus

### 2.1 What is documented
- Qwen-Audio-3.1 launched 2026-09-23 as five hosted models (ai-tldr.dev). Only `qwen-audio-3.1-tts-next` has an id in that article (China-Beijing $0.848/M input, $1.696/M output tokens; Chinese+English; 3 req/s).
- The official docs' examples use `qwen-audio-3.0-tts-flash` / `qwen-audio-3.0-tts-plus`.
- WebSocket (Alibaba docs): `wss://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference` (Singapore) or `...cn-beijing...`; header `Authorization: Bearer <key>`. Flow: `run-task` → `task-started` → `continue-task`(text) → `finish-task` → `task-finished`; audio = binary frames after each `sentence-synthesis` event. Formats pcm/wav/mp3/opus, 8–48 kHz.
- Limits: 20,000 chars per `continue-task`, ≤ 23 s between sends, new `task_id` per task.

### 2.2 Probe results (2026-10-08, Singapore, this account) — supersedes the guesses below
| model | result |
|---|---|
| `qwen-audio-3.1-tts-plus` | `InvalidParameter: Model not exist` — **there is no 3.1 Plus** (also not `3.1-tts`, `-plus-latest`) |
| `qwen-audio-3.1-tts-flash`, `qwen-audio-3.1-tts-next` | `AccessDenied` — exist, not enabled for this key/workspace |
| `qwen-audio-3.0-tts-plus` | works with `longanhuan_v3.6`; fails with `longanlingxi` (engine error 411 — voices are model-specific) |
| `qwen-audio-3.0-tts-flash` | works with both voices |

So **4.1 runs Qwen-Audio 3.0 TTS Plus**. To test 3.1, enable access to flash/next in the Model Studio console, then set `QWEN_TTS_MODEL`. The "not confirmed" list below is kept for what is still open.

#### Still open
- **The id `qwen-audio-3.1-tts-plus`.** The search found the 3.0 Plus/Flash ids and the 3.1 `tts-next` id, but no page naming a 3.1 "Plus". Open the Model Studio console model list (Singapore region) and set `QWEN_TTS_MODEL`. If only `3.0-tts-plus` exists, 4.1 is a 3.0 test.
- English voice names — the docs' sample voice `longanlingxi` is a default placeholder; pick one from the voice list page and set `QWEN_TTS_VOICE`.
- First-audio latency, and whether `pcm` at 24 kHz is accepted by Plus (docs list it for Flash).

### 2.3 Price
Third-party figures conflict: OpenRouter lists **3.0** Plus at $20/M characters; another write-up $27.6/M. Alibaba cut 3.1 TTS by ~70%. No official 3.1 Plus price found — read it in the console before comparing against Aura-2 (~$30/M chars).

## 3. Google Gemini 3.8 Flash TTS (removed — see the outcome above)

- Ids: `gemini-3.8-flash-tts`, `gemini-3.8-flash-lite-tts` (≈ 0.9 ¢/min, "high volume, voice agents"). GA per the 2026-09-22 changelog (cellcog.ai); third parties still call the line preview — verify.
- Text in, audio out only. 30 prebuilt voices (Kore, Puck…), larger library via `/v1beta/voices`; voice design/replication available. SynthID watermark on all output.
- Style is steered by natural-language `instructions` (plugin option), a feature neither Aura-2 nor Qwen-Plus exposes in the same way — useful for the "podcast host" tone.
- Auth: Gemini API key. LiveKit plugin reads `GOOGLE_API_KEY` (Vertex alternative: `GOOGLE_APPLICATION_CREDENTIALS`). Google's own REST examples use `GEMINI_API_KEY`; the profile passes `GOOGLE_API_KEY` explicitly.
- Open question: time-to-first-audio. Test the Flash and Flash-Lite ids both; Lite is the probable pick for a voice loop.

## 4. Secrets you must provide

| Variable | For | Where to get it | Notes |
|---|---|---|---|
| `DASHSCOPE_API_KEY` | 4.1 | Alibaba Cloud **Model Studio** console → API keys | **Per region.** Must be issued in the same region as `QWEN_REGION` (default `ap-southeast-1`, Singapore). |
| `QWEN_WORKSPACE_ID` | 4.1 | Model Studio console → workspace | Not a secret, but the endpoint host needs it. Marked `# secret` only for convenience of `env:push`. |
| `DEEPGRAM_API_KEY` | all (STT) | already set | |

Optional overrides (no secret): `QWEN_REGION`, `QWEN_TTS_MODEL`, `QWEN_TTS_VOICE`, `QWEN_TTS_LANGUAGE`.
Local: `apps/voice-worker/.env`. LiveKit Cloud: `pnpm env:push --target worker` (then `:apply`). `apps/web` needs nothing new.

## 5. The infrastructure for future TTS candidates

```
PromptVersion.tts ("qwen") → livekit-token route → dispatch metadata.tts → worker createTtsFor() → TTS_PROFILES["qwen"]
```

To test another model:
1. `apps/voice-worker/src/tts-profiles.ts`: add `{ label, secrets: [env names], create() }`. If LiveKit has a plugin, `create()` is one line; otherwise write an adapter like `qwen-tts.ts` (a `tts.TTS` subclass; `stream()` via `tts.StreamAdapter` for non-streaming APIs).
2. `apps/web/src/agent/prompts/words-4.N.ts`: `{ ...words40, version, label, tts: "<id>" }` and register it in `index.ts`.
3. Add its env names to `apps/voice-worker/.env.example` with `# secret`.
4. `pnpm --filter voice-worker check` covers resolve/fallback/missing-key/build for every registered profile automatically.

Behaviour worth knowing: an unknown `tts` name falls back to Deepgram and the worker logs it; a profile whose secret is absent refuses to start the lesson naming the variable (no silent lesson, cf. `2026-10-02-livekit-silent-tts-on-spent-quota.md`). No `pnpm sync:agents` change is needed (LiveKit versions have no remote agent); 4.1 stays behind `CLIENT_READY` like 4.0.

## 6. How to compare
Run the same lesson on 4.0/4.1 and read `ttsTtfbMs` and `e2eLatencyMs` from the turn ledger (`pnpm report <id>`); judge Russian inserts by ear, since that is the one place Aura-2 is known to fail.

## Sources
- Alibaba: [WebSocket API](https://www.alibabacloud.com/help/en/model-studio/qwen-audio-tts-websocket-api), [client events](https://www.alibabacloud.com/help/en/model-studio/qwen-audio-tts-client-events), [server events](https://www.alibabacloud.com/help/en/model-studio/qwen-audio-tts-server-events), [realtime TTS guide](https://www.alibabacloud.com/help/en/model-studio/realtime-tts-user-guide)
- [Qwen-Audio-3.1 release summary](https://ai-tldr.dev/releases/alibaba-qwen-audio-3-1/), [OpenRouter Qwen-Audio-3.0-TTS Plus](https://openrouter.ai/qwen/qwen-audio-3.0-tts-plus), [Qwen-Audio-3.1 review](https://blog.buildfastwithai.com/qwen-audio-3-1-review)
- Google: [speech generation docs](https://ai.google.dev/gemini-api/docs/speech-generation), [Gemini 3.8 Flash TTS summary](https://cellcog.ai/blog/gemini-3-8-flash-tts/), [LiveKit Gemini TTS](https://docs.livekit.io/agents/models/tts/gemini)
