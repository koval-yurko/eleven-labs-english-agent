# Qwen-Audio TTS (words-4.1): rate limits, slowness, and what we built

Date: 2026-10-09. Follows `2026-10-08-livekit-tts-candidates-qwen-gemini.md` (which chose Qwen as
the candidate; Gemini was dropped the same day, see its Outcome note).

## 1. Summary

- Lessons on `words-4.1` died or stalled for **one root cause with three faces**: the adapter made
  one Model Studio request per sentence, all at once. Model Studio allows **3 requests per second per
  model, shared across the whole Alibaba account** (§2).
- The fix is structural, not a tuning: a reply is now **one task on one connection**, fed in
  sentence-sized pieces and **paced to playback** (§4). That is ~1 request per reply instead of 10–30.
- Verified against the live service with a token-by-token feed and an interrupt. **Not yet verified in
  a real lesson on the phone** — deploy and read `lk agent logs` (§6).

## 2. What Alibaba documents (read 2026-10-09)

| Topic | Finding | Source |
|---|---|---|
| Rate limit | `qwen-audio-3.0-tts-plus` and `-flash`: **3 RPS** each (Singapore). No TTS-specific concurrency limit listed. Applies to the **main account**, summed over RAM users, workspaces and API keys. | rate-limit page |
| Raising it | "Contact your business manager to apply"; top-ups do not raise limits. | rate-limit page |
| Error text | "Requests rate limit exceeded" = RPM/RPS hit; "Request rate increased too quickly" = burst protection, can fire below the limit. Advice: spread requests evenly, exponential backoff, queue. `Throttling.RateQuota` itself is not documented. | rate-limit page |
| Connection reuse | "Reuse the WebSocket connection across tasks instead of creating a new one for each." After a *cancel* a new `run-task` on the same socket is documented; after a normal `task-finished` "the client can close the connection or reuse it". Idle timeout: not stated. | websocket-api, client/server events |
| Duplex streaming | Send text with several `continue-task`; complete sentences are synthesized at once, an unfinished one is buffered; `finish-task` forces the rest. **≤ 20,000 chars per message, ≤ 200,000 per task, and a send must follow within 23 s or the connection times out.** | client events |
| Cancel | `finish-task` with `directive: "cancel"` → immediate `task-finished`, no more audio. | client events |
| Events | `task-started`, `result-generated` (sub-types sentence-begin / -synthesis / -end; word timestamps only in -end, and only with `word_timestamp_enabled`), `task-finished`, `task-failed`. Billing: `characters` in usage. | server events |
| Regions | WebSocket TTS endpoints documented for **Singapore** and **Beijing** only. Model Studio also has Germany (Frankfurt, `eu-central-1`) and US (Virginia) regions generally; **TTS availability there is unconfirmed**. API keys and model lists are per region. | websocket-api, regions |

Sources: [WebSocket API](https://www.alibabacloud.com/help/en/model-studio/qwen-audio-tts-websocket-api) ·
[client events](https://www.alibabacloud.com/help/en/model-studio/qwen-audio-tts-client-events) ·
[server events](https://www.alibabacloud.com/help/en/model-studio/qwen-audio-tts-server-events) ·
[rate limit](https://www.alibabacloud.com/help/en/model-studio/rate-limit) ·
[rate-limiting best practices](https://help.aliyun.com/en/model-studio/rate-limiting-best-practices) ·
[regions](https://www.alibabacloud.com/help/en/model-studio/regions.md).

## 3. Evidence from our own sessions (worker logs, `lk agent logs`)

| Session | What the log showed | Reading |
|---|---|---|
| `b6184945` (4.1, 14:52) | `tts:Error (fatal)`, no message; event loop blocked 400–570 ms in the Qwen write path | message was not logged, so the cause was invisible |
| `36df4fed` / report `5c2e2ea1` (15:58) | `Throttling.RateQuota` after ~20 requests in seconds | per-sentence requests × 3 RPS |
| `37714703` (16:11) | tutor never joined; no `[qwen]` lines | **not Qwen** — phone↔room connectivity |
| `d688e87d` / report `6ecb5858` (16:18) | 28 requests, no throttling, but requests waited **up to ~19 s** for a slot; two replies of 1,636 and 3,388 output tokens | the concurrency cap queued a monologue's chunks ahead of live ones; aborted chunks still took their turn |

Measured per request (Singapore from `eu-central`): WebSocket open **0.5–1.5 s**, first audio **~2 s**
after the request, ~3–4 s for a sentence; audio is produced ~2–3× faster than it plays.

## 4. What we changed, in order (all in `apps/voice-worker`)

1. **Error logging** (`agent.ts`): the framework's TTS error *message*, not just its class.
2. **Gemini removed** (profile, adapter, its `words-4.2` module, dependency, secrets; the number `4.2` was then reused for step 9) — its quota (10/min, 100/day on the key's project) could not carry a lesson.
3. **Per-request tracing** (`qwen-tts.ts`): one `[qwen <id>]` line at start and a summary at the end — socket-open / task-started / first-audio / finished times, bytes and seconds of audio, event counts, refused upgrades with HTTP status and body, `task-failed` verbatim, early socket close with code, aborts, `FINISHED WITH NO AUDIO`.
4. **Batching + concurrency cap + throttle retry**: sentences merged to ≥ 80 chars, ≤ 3 requests in flight, retry with backoff (0.4–3.2 s, fresh `task_id`) when `Throttling.*` arrives before any audio. *This stopped the throttling but introduced head-of-line blocking (§3, last row).*
5. **Abortable queue**: a request aborted while waiting leaves the line at once and never opens a socket. Cap raised to 5.
6. **Pacer** (`pacer.ts`): LiveKit's sentence adapter calls `synthesize()` for every sentence the moment it appears and only holds back the *forwarding* of audio. The pacer models playback (1× speed) and admits new text only while ≤ 12 s of audio is queued ahead; reset on interrupt.
7. **One task per reply** (`QwenSynthesizeStream`, `speech-segments.ts`): the whole answer over one socket; pieces of 60–250 chars cut at sentence ends (the cap keeps the gap between sends under the 23 s limit); each piece admitted by the pacer; interrupt = `finish-task` + `directive: cancel`; final frame marked `final`; throttle retry replays the pieces; logs `paced:` holds and a per-task summary.

8. **Warm socket pool** (`qwen-socket-pool.ts`, option B): one parked socket, opened when the session starts (`QwenTTS.warm()` from `agent.ts`), returned after every reply (also after a cancel), retired at 45 s idle and renewed up to 3 times, closed with the session. A parked socket the server already closed is retried on a fresh one. Probe and results in §4a.
9. **`words-4.2` = `words-4.1` on `qwen-audio-3.0-tts-flash`** (option C): profile `qwen-flash` (`QWEN_FLASH_MODEL` / `QWEN_FLASH_VOICE` override), same adapter, so the two versions differ in the model only. Result in §4b.

Checks: `pnpm --filter voice-worker check` (76 properties, incl. segmenter, pacer and the pool against a local WebSocket server).

### 4a. Probe: can a socket be reused, and for how long? (2026-10-09, live service)

| Step | Result |
|---|---|
| Fresh socket → first task | upgrade 2.1 s (from the laptop), `task-started` 258 ms, first audio 943 ms |
| Same socket, second task, 0 s idle | works, first audio 1006 ms |
| … after 20 s idle | works, first audio 993 ms |
| … after 45 s idle | works, first audio 874 ms |
| … idle further | **server closed it, `1000 Bye`, ~60 s after the last task** |

So reuse after a normal `task-finished` works (the docs only promise it after a cancel), and the idle
limit is ~60 s: the pool retires its socket at 45 s. The docs state no idle timeout.

Live, through the adapter (`firstAudio` = from the first text to the first frame of audio):

| Reply | Plus | Flash |
|---|---|---|
| 1 — socket warmed at session start | 983 ms | 960 ms |
| 2 — socket returned by reply 1 | 909 ms | 821 ms |
| 3 — after 20 s idle | 885 ms | 833 ms |
| 4 — cut at 4 s (cancel) | first audio 886 ms, cancelled cleanly | 777 ms |
| 5 — **fresh** socket (no warm one available) | 2,746 ms (1.8 s of it opening the socket) | 2,502 ms (1.6 s opening) |
| B — reply 1.5 s after a cancel | 940 ms, **on the cancelled task's socket** (idle 0.4 s) | — |

**A warm socket cuts first audio from ~2.5–2.7 s to ~0.8–1.0 s**, i.e. it removes the whole
connection cost. The warm socket for the first reply opens in 0.9–1.6 s while the greeting is
generated, so even the opening line is warm.

### 4b. Plus vs Flash

On this short text the two are indistinguishable in first-audio latency (Flash 777–960 ms, Plus
885–983 ms) — the connection cost dominated what we measured before. Flash produced slightly more
audio for the same text (13.9–14.0 s vs 11.9–12.5 s: a slower delivery, or different pacing), which
is a reason to listen rather than assume. **Compare by ear and over a long reply on the phone
(4.1 vs 4.2); the numbers above do not separate them.**

### 4c. Worker size (option G) — what the logs say

- LiveKit Cloud reports the agent at **2 CPU / 4 GB** (`lk agent status`). The CLI offers no flag for
  it (`lk agent deploy/update` take secrets, region, attributes only); it is a plan-level setting, so
  there is nothing to change from the repo.
- The "event loop blocked" warnings occur **only in the first ~1.5 s after a job starts** (0.3–0.6 s each,
  2–3 of them, in both sessions inspected; a single 103 ms one later). None during the conversation.
  The "worker at full capacity" notices are the same startup spike. So CPU is not what makes replies
  slow mid-lesson.
- The likely source is process start-up (TypeScript loaded through `tsx`, local VAD model). It is
  unverified and costs well under a second; precompiling with `tsc` would be the lever, and is not
  worth the Dockerfile change until a profile says so.
- `lk agent status` showed **Sleeping** between lessons. That is a cold start for the *first* lesson
  after idle — a different, larger delay than the above (`2026-10-01-livekit-cold-start-ready-timeout.md`).

### Live result of step 7 (real key, text fed 4 words / 40 ms like an LLM)

| | 6-sentence reply (47 s of speech) | Interrupt at 8 s |
|---|---|---|
| Tasks / connections | **1 / 1** (was ~6) | 1 |
| First audio | 2.7 s | 6.1 s (pacer was still holding from the previous test reply — an artifact of back-to-back runs) |
| Text fully sent at | 29.4 s (paced; audio ran 46.8 s) | cancelled at 8.0 s, 7.3 s of audio delivered |
| Final frame marked | yes | n/a |

## 5. Options, with a recommendation

| # | Option | Effect | Cost / risk | Recommend |
|---|---|---|---|---|
| A | **Ship step 7** and read the logs from a real lesson *(built; deploy pending)* | removes the burst; 1 request per reply | the 23 s send rule: an LLM stall (e.g. a tool call) longer than 23 s would time the task out; not handled yet | **Yes — first** |
| B | **Warm connection** *(built — §4a)*: open the socket at session start / keep one idle and reuse it for the next reply | saves the 0.5–1.5 s handshake on every reply's first audio | idle timeout ~60 s (probed); a stale socket is retried on a fresh one | **Done**: first audio ~0.9 s warm vs ~2.6 s cold |
| C | **`qwen-audio-3.0-tts-flash`** *(built as `words-4.2` — §4b)* | latency not separable from Plus on short text; same 3 RPS | quality/voice differ; compare by ear | **Done** — pick 4.1 or 4.2 by listening |
| D | **Region**: ask Alibaba / console whether Qwen-Audio TTS runs in Frankfurt (`eu-central-1`) | handshake RTT from `eu-central` drops several-fold | unconfirmed; separate key and workspace per region | Research only |
| E | **Raise the quota** via the business manager | headroom beyond 3 RPS/account | manual, slow | Not needed yet: one task per reply is ~0.1–0.3 RPS per learner, so ~10 simultaneous learners fit |
| F | **Cap reply length** in the prompt | every cost above falls; the 3,388-token answers are ~15 min of speech | changes tutor behaviour; shared by all `words-4.x` prompts | Yes — separate decision |
| G | **Bigger worker** *(investigated — §4c)* | none expected: already 2 CPU / 4 GB, and stalls are confined to the first ~1.5 s | not settable from the CLI | No change; precompile only if a profile asks |
| H | **Restore word timestamps** (`word_timestamp_enabled` → `sentence-end`) for transcript sync | the per-sentence alignment `StreamAdapter` used to give is gone | extra parsing | Only if the mobile transcript highlighting needs it |
| I | **Tune** `LOOKAHEAD_MS` (12 s), piece sizes, `CHARS_PER_SEC` (17) from real `paced:` lines | fewer holds or less waste on interrupt | none | After A |

## 6. How to verify after deploying

```bash
lk agent deploy . --skip-sdk-check --yes      # from apps/voice-worker
lk agent logs --id CA_snjh6ZRrzUh7
```

Look for, per reply, the `[qwen stream <id>]` lines:

- `done in … firstAudio=…ms … — warm socket (idle …s)` or `— fresh socket (…ms to open)` — one per reply; warm should be ~0.9 s, fresh ~2.5 s;
- `[qwen pool]` lines: `warm socket ready in …ms`, `idle socket retired … renewing`, `a parked socket was closed by the server`;
- `paced: held piece N` — expected on long answers, not on short ones;
- `throttled (attempt n/5)` — should be rare now; if frequent, the cap or another consumer of the same account is the cause;
- `FAILED … : <message>` / `task-failed:` — the reason, verbatim;
- `cancelled by the framework` — a barge-in; the next reply should start promptly (no `waited … for a free slot`).

## 7. Open questions

- Does the account's 3 RPS also count the WebSocket upgrade, or only `run-task`? (The pool opens ~1 upgrade per reply plus a few renewals.)
- Is a `continue-task` with empty text accepted as a keep-alive for the 23 s rule? Unverified.
- Frankfurt/Virginia availability of `qwen-audio-3.0-tts-*` over the WebSocket API.
