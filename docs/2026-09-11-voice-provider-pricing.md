# Voice provider pricing: ElevenLabs, OpenAI, Vapi — what a lesson costs, and what else to test

**Date:** 2026-09-11 · **Status:** research, no code changed · **Prices:** public list prices, USD, checked
2026-09-11 (§10). Anything marked *(E)* is modelled, not quoted.

**Why this note exists.** The app now has three live voice providers (ElevenLabs, OpenAI Realtime, Vapi —
`docs/2026-08-22-openai-realtime-second-provider.md`, `docs/2026-08-27-vapi-third-voice-provider.md`)
and no single place that says what a lesson costs on each, at the usage we expect.

## TL;DR

- **At today's configuration, ElevenLabs and OpenAI `gpt-realtime` cost the same — about $0.10 per lesson
  minute.** Vapi with the same ElevenLabs voice is the most expensive option (≈ $0.17/min), because it
  bills its $0.05 orchestration fee *and* the voice by the character, and our tutor talks almost
  continuously (§2).
- **The usage profile makes voice the dominant cost of the product.** 20-minute lessons, 1–3 a day, is
  600–1,800 minutes per learner per month: **≈ $60–190 per learner per month at $0.10/min**, i.e. ≈ $1.2k/mo
  at 10 learners and ≈ $12k/mo at 100 (§5).
- **The biggest cheap wins, in order:** try `gpt-realtime-mini` (one env var, ≈ $0.035/min); buy
  ElevenLabs annually (≈ $0.056/min on included minutes); make the learner talk more (halves cost on every
  token- or character-billed stack, and is better teaching); kill idle minutes (§7).
- **Worth testing next:** Hume EVI (keeps Claude, ≈ $0.05–0.11/min), Deepgram Voice Agent with our own
  Claude (≈ $0.08–0.10), Ultravox (≈ $0.05, React Native SDK, not Claude), and — the long-term floor if we
  keep Claude — our own LiveKit Agents pipeline (≈ $0.05–0.08; the app already ships LiveKit's WebRTC)
  (§8).

---

## 1. The usage profile

Given: **a lesson is ~20 minutes, 1–3 lessons per learner per day.**

| Learners | 1 lesson/day | 2 lessons/day | 3 lessons/day |
| --- | ---: | ---: | ---: |
| 1 | 600 min/mo | 1,200 min/mo | 1,800 min/mo |
| 10 | 6,000 | 12,000 | 18,000 |
| 100 | 60,000 | 120,000 | 180,000 |

Two consequences of the *shape*, not just the volume:

- **Long sessions.** 20 minutes is where per-token providers get more expensive per minute: every turn
  re-sends the conversation so far (§3.2). A per-minute price (ElevenLabs, Vapi's fee, Hume, Ultravox) does
  not care how long a session runs.
- **Concurrency only matters at 100 learners.** If ~40% of lessons land in a two-hour evening peak,
  100 learners × 2 lessons is ≈ 13 sessions on average in that window, peaks of 25–40. At 10 learners, peaks
  of 3–5 — inside every plan's limit.

## 2. What our own lessons measured

From the lesson traces in LangSmith (`English Voice Agent - Dev`/`- Prod`, exported 2026-09-11) joined to
`lesson_sessions.transcript` in Supabase:

**The tutor talks ~90% of the lesson.** Tutor text runs **850–920 characters per minute** of lesson
(ElevenLabs lesson `conv_2101…`: 11,482 tutor characters in 749 s; Vapi `cad6fb8b…`: 1,482 in 121 s). The
learner's lines are a few percent of the transcript. OpenAI's audio-token counts agree independently:
output audio runs at 20 tokens/s, and characters ÷ (tokens/20) comes out at 15.2–15.9 characters per
second of speech in all four lessons — normal speaking pace, back to back.

This single number drives most of what follows. Any provider that bills TTS by the character (Vapi, every
DIY cascade) or output audio by the token (OpenAI, Gemini) charges for ~54 seconds of speech per minute.
A flat per-minute price (ElevenLabs Agents) does not.

**OpenAI lessons cost ≈ $0.09–0.10 per minute of lesson** once priced correctly:

| Lesson | Turns | Tutor speech | Trace estimate | Corrected cost | $/min at 90% talk |
| --- | ---: | ---: | ---: | ---: | ---: |
| `cead7615` (Prod, words-2.0) | 35 | 10.6 min | $1.88 | **$1.16** | $0.099 |
| `8228b9a3` (Dev, words-2.1) | 12 | 5.4 min | $1.01 | **$0.53** | $0.088 |
| `9b3ee22a` (Dev, words-2.0) | 14 | 4.2 min | $0.91 | **$0.43** | $0.092 |
| `5e98a430` (Dev, words-2.1) | 14 | 2.7 min | $0.84 | **$0.31** | $0.105 |

**The trace estimate is 60–170% too high.** `estimateCostUsd` in `apps/web/src/lib/langsmith-trace.ts`
prices *all* uncached input at the audio-input rate ($32/1M) and *all* output at the audio-output rate
($64/1M), but most input is text ($4/1M) and ~20% of output is the text transcript ($24/1M). The trace
already carries `input_audio_tokens`/`output_audio_tokens`, so the fix is a four-rate formula. Until then,
read the LangSmith number as an upper bound.

**Not measured:** Vapi and ElevenLabs lesson cost. The Vapi `end-of-call-report` carries `cost`, but
`apps/web/src/app/api/v2/vapi/webhook/route.ts` does not persist it, and OpenAI/Vapi sessions leave
`lesson_sessions.duration_secs` null — so no provider has a measured $/min in our own data. Both are
one-line additions (§9).

## 3. How the three current providers bill

### 3.1 ElevenLabs Agents — flat per minute, LLM on top

| Plan | $/month | Agent minutes | Concurrency |
| --- | ---: | ---: | ---: |
| Starter | 6 | 75 | 6 |
| Creator | 22 | 275 | 10 |
| Pro | 99 | 1,238 | 20 |
| Scale | 299 | 3,738 | 30 |
| Business | 990 | 12,375 | 40 |

- **Every tier is $0.08/min**, and extra minutes are $0.08. Burst beyond the concurrency limit (up to 3×)
  is $0.16/min.
- The minute covers STT, the `eleven_v3_conversational` voice, turn-taking and the orchestration.
- **The LLM is billed on top** at token rates. The pricing page says so today; our August note said it was
  absorbed "for now". Check the account's usage page to see which is true for us.
- **Silence longer than 10 s is billed at 5%** (`docs/2026-08-16-tutor-pause-hold-the-line.md`, F5). That
  is what makes a held pause cheap on this provider.
- **Annual billing:** Pro $825/yr, Scale $2,490/yr, Business $8,250/yr — **≈ $0.056/min** on included minutes
  if annual plans carry the same monthly allowance (confirm before buying).

### 3.2 OpenAI Realtime — per token, grows with session length

Current `apps/web/src/lib/config.ts` default: `gpt-realtime` (alias; same audio rates as `-2.1`).

| Model | Audio in | Audio out | Text in | Text out | Cached in |
| --- | ---: | ---: | ---: | ---: | ---: |
| `gpt-realtime` / `-2` / `-2.1` | $32 | $64 | $4 | $16–24 | $0.40 |
| `gpt-realtime-mini` / `-2.1-mini` | $10 | $20 | $0.60 | $2.40 | $0.30 / $0.06 |

(per 1M tokens)

- Output audio is 20 tokens per second of speech, so **a minute of tutor speech is ≈ $0.077 of output
  audio alone** on `gpt-realtime`, ≈ $0.024 on mini.
- Every turn re-sends the conversation. Cached input is cheap ($0.40/1M), but only 0–65% of input was
  cached in the traced lessons — short lessons got no cache hits at all.
- Pausing costs nothing: no audio is committed, so no tokens are billed.
- There is no concurrency fee; the limit is the account's rate-limit tier.
- *(E)* **`gpt-realtime` ≈ $0.09–0.12/min** for a 20-minute lesson (measured $0.09–0.10 on shorter ones).
  **`gpt-realtime-mini` ≈ $0.03–0.045/min.**

### 3.3 Vapi — $0.05/min orchestration, everything else at cost

- **$0.05/min platform fee.** STT, LLM and TTS are billed at cost, or $0 through Vapi if we bring our own
  key.
- 10 concurrent calls included, then $10 per extra line per month. There is no minimum.
- The pieces for our shape: Deepgram Nova-3 STT is $0.0048–0.0077/min (promo/regular). ElevenLabs v3 TTS
  is $0.10 per 1k characters, **≈ $0.085/min at our talk ratio**; Flash is half that. Deepgram Aura-2 is
  $0.03 per 1k (≈ $0.026/min). Sonnet 4.6 runs ≈ $0.01–0.04/min.
- **A pause is not cheap here.** The platform fee and STT keep running while the line is held.
- *(E)* **≈ $0.15–0.18/min with the ElevenLabs v3 voice**, $0.11–0.14 with ElevenLabs Flash, and
  $0.085–0.095 with Aura-2 and Haiku.
- Our `words-3.x` assistant sends no `voice` or `transcriber` block (`apps/web/src/agent/vapi-assistant.ts`),
  so today's Vapi lessons use Vapi's default voice. That rate is visible in the dashboard, not modelled here.

### 3.4 The LLM share (ElevenLabs, Vapi, and any Claude cascade)

Model: ~2 tutor turns per minute, and context averages ≈ 5.8k tokens across a 20-minute lesson (≈ 3.5k of
prompt, plus the transcript growing at ~230 tokens per minute). That is ≈ 11.6k input and ≈ 210 output
tokens per minute.

| Model | $/1M in / out | No cache | With cache *(E)* |
| --- | --- | ---: | ---: |
| Claude Sonnet 4.6 (current `DEFAULT_LLM`) | $3 / $15 | $0.038/min | $0.010/min |
| Claude Haiku 4.5 | $1 / $5 | $0.013/min | $0.003/min |

The LLM is **10–35% of a lesson minute**. The voice is the rest.

## 4. All-in cost per lesson minute

*(E)* unless noted. Uses our measured talk ratio: ~850 TTS characters per minute, ~90% tutor speech.
There is no telephony cost in any row.

| Option | $/min | Claude? | Notes |
| --- | ---: | :---: | --- |
| **ElevenLabs Agents** + Sonnet (today) | **0.090–0.118** | ✓ | $0.08 flat; annual plan → 0.066–0.094 |
| ElevenLabs Agents + Haiku | 0.083–0.093 | ✓ | |
| **OpenAI `gpt-realtime`** (today) | **0.09–0.12** | ✗ | measured 0.09–0.10 on short lessons |
| **OpenAI `gpt-realtime-mini`** | **0.030–0.045** | ✗ | one env var: `OPENAI_REALTIME_MODEL` |
| **Vapi** + ElevenLabs v3 + Sonnet | **0.15–0.18** | ✓ | same voice as ElevenLabs, priced per character |
| Vapi + ElevenLabs Flash + Sonnet | 0.11–0.14 | ✓ | |
| Vapi + Aura-2 + Haiku | 0.085–0.095 | ✓ | cheapest Vapi, weaker voice |
| Hume EVI + our Sonnet key | 0.05–0.11 | ✓ | $0.04–0.07/min by plan; Hume doesn't bill the LLM on your key |
| Deepgram Voice Agent, our Sonnet | 0.075–0.10 | ✓ | $0.065 base (promo $0.05 ends 2026-09-12) |
| Deepgram Voice Agent, managed Sonnet | 0.163 *(Q)* | ✓ | Standard tier with Haiku: $0.075 |
| Retell AI, Sonnet | ≈ 0.15 | ✓ | phone-first; LLM billed per minute |
| Ultravox | 0.05 *(Q)* | ✗ | own open-weight model; RN + Swift SDKs |
| Gemini Live (3.1 Flash) | 0.03–0.08 | ✗ | re-bills full context every turn |
| Grok Voice | 0.08 *(Q)* | ✗ | |
| AssemblyAI Voice Agent | 0.075 *(Q)* | ✗ | their LLM included |
| **DIY: LiveKit + Flux STT + Inworld TTS-2 + Sonnet** | **0.049–0.078** | ✓ | we run the agent worker |
| DIY: same with Haiku | 0.042–0.053 | ✓ | |
| DIY floor: AssemblyAI + gpt-oss on Groq + Inworld Flash | ≈ 0.028 | ✗ | quality unknown |

The comparison hinges on this: **once we pay for Claude ourselves, orchestration plus speech can be
bought for ~$0.03–0.04/min.** Everything above that is platform margin, or a more expensive voice.

## 5. Monthly cost at 1, 10 and 100 learners

At **2 lessons/day** (1,200 min per learner per month). The 1/day and 3/day figures are ½× and 1.5× these.
List prices, before any volume deal.

| Option | $/min (mid) | 1 learner | 10 learners | 100 learners | Per learner/mo (1–3/day) |
| --- | ---: | ---: | ---: | ---: | ---: |
| ElevenLabs + Sonnet, monthly | 0.104 | $125 | $1,250 | $12,500 | $62–187 |
| ElevenLabs + Sonnet, annual plan | ≈ 0.080 | $96 | $960 | *enterprise* | $48–144 |
| OpenAI `gpt-realtime` | 0.105 | $126 | $1,260 | $12,600 | $63–189 |
| **OpenAI `gpt-realtime-mini`** | **0.037** | **$45** | **$450** | **$4,500** | **$22–68** |
| Vapi + ElevenLabs v3 + Sonnet | 0.166 | $199 | $1,990 | $19,900 | $99–298 |
| Vapi + Aura-2 + Haiku | 0.090 | $108 | $1,080 | $10,800 | $54–161 |
| Hume EVI + Sonnet | 0.079 | $95 | $950 | $9,500 | $47–142 |
| Ultravox | 0.050 | $60 | $600 | $6,000 | $30–90 |
| DIY LiveKit + Sonnet | 0.063 | $76 | $760 | $7,600 | $38–114 |
| DIY LiveKit + Haiku | 0.047 | $57 | $570 | $5,700 | $28–85 |

The plans line up neatly with the profile. **One learner at 2/day is 1,200 minutes, which is exactly Pro
(1,238). Ten learners is 12,000, which is exactly Business (12,375).** At 100 learners every vendor is in
negotiated-contract territory, and these list prices are the ceiling.

The number to hold against a subscription price is the last column. **At $0.10/min a learner on this
profile costs $60–190 a month in voice alone.** Getting that under ~$20 at 2 lessons a day needs
≤ $0.017/min, and only a DIY stack with non-Claude components gets near it. So the real choice is between
fewer or shorter live minutes and a cheaper model tier, not between vendors (§7).

## 6. Which provider for which scenario

| Scenario | Best fit | Why |
| --- | --- | --- |
| Solo / testing (< 300 min/mo) | **Any** — ElevenLabs Starter/Creator or Vapi pay-as-you-go | differences are single dollars; Vapi and OpenAI have no minimum |
| 1–10 learners, current voice quality | **ElevenLabs, annual plan** | flat price suits a tutor that talks 90% of the time; the plans match the profile; lowest ops |
| Same, budget first | **OpenAI `gpt-realtime-mini`** | ~⅓ of the cost; already integrated; needs a quality check |
| 100 learners, keep Claude | **DIY on LiveKit**, or Hume EVI as a managed middle ground | platform margin is ~half the bill at this scale ($12.5k → $6–8k/mo) |
| 100 learners, Claude optional | `gpt-realtime-mini`, Ultravox, Gemini Live | $0.03–0.05/min |
| Experimenting with voices/STT/turn-taking | **Vapi** | one transport, many providers behind it, itemised cost per call — a test bench, not the cheapest production path |
| Held pauses, learner walks away mid-lesson | ElevenLabs (5% silence rate) or OpenAI (no tokens) | Vapi keeps billing the platform fee and STT |

## 7. Ways to make it cheaper

Ranked by saving ÷ effort for **this** app.

1. **Try `gpt-realtime-mini`** — about −65% on OpenAI lessons, with no code change.
   Set `OPENAI_REALTIME_MODEL=gpt-realtime-mini` (or `-2.1-mini`) and run the words-2.x lessons against it.
   What's at risk is correction quality and instruction-following on the tutor prompt. It's the cheapest
   test on this list.
2. **Buy ElevenLabs annually** — about −30% on included minutes. Pro at 1 learner and Business at 10 fit
   the profile almost exactly. The risk is paying for minutes nobody uses; the mitigation is to buy after a
   month of real usage, not before.
3. **Make the learner talk more** — up to −40% on OpenAI, Vapi and DIY stacks. The tutor currently speaks
   ~54 s of every minute. For a speaking tutor, the learner talking 30–40% of the time is also the better
   lesson. It's a prompt change (shorter turns, more questions; see
   `docs/2026-08-17-short-turns-and-chunked-pause.md`), and it lowers output audio and TTS characters in
   proportion. It saves nothing on ElevenLabs, which bills the minute either way.
4. **Kill idle minutes** — the saving depends on behaviour. `silenceEndCallTimeoutSeconds` already maps to
   ElevenLabs and Vapi (`apps/web/src/agent/sync-agents.ts`, `apps/web/src/agent/vapi-assistant.ts`). The
   remaining gap is a held pause on Vapi, which bills $0.05 plus STT per minute. Cap it, or end and resume
   the call, on that provider.
5. **Use Haiku 4.5 instead of Sonnet** on ElevenLabs, Vapi and DIY stacks — −$0.007 to −$0.025/min. The LLM
   is only 10–35% of the minute, so this is worth it on DIY and marginal elsewhere. Anthropic's cache
   threshold is higher on Haiku; check that the prompt clears it.
6. **Maximise prompt caching** — up to −$0.03/min on Claude, and less on OpenAI. Keep the stable part of the
   instructions first and anything that changes (word list, lesson state) after it. The traced OpenAI
   lessons cached 0–65% of input.
7. **Cap context growth in 20-minute sessions** — the saving grows with lesson length (OpenAI, Gemini).
   Use Realtime truncation or retention settings, or summarise older turns into the instructions.
8. **Pick a cheaper voice on character-billed stacks** — −$0.04 to −$0.06/min. ElevenLabs Flash ($0.05/1k)
   halves v3. Inworld TTS-2, Cartesia Sonic and Aura-2 are $0.015–0.04/1k. For a language tutor the voice
   is the product, so do a blind listening check before switching.
9. **Pre-render one-way audio** — large, but it's a product change. Stretches where the tutor narrates
   (explanations, the podcast mode in `apps/web/src/agent/prompts/podcast-lesson.ts`) don't need a live
   duplex session. Batch TTS at $0.015–0.10 per 1k characters, with no per-minute platform fee and
   replayable for free, can carry them, with the live session opened only for the speaking parts. This is
   a design question, not a config change.
10. **Negotiate at 100 learners** — typically 20–40%. ElevenLabs Enterprise, Vapi Scale and OpenAI volume
    tiers are all unpublished; the numbers in §5 are the ceiling to bargain from.

## 8. Other providers worth testing

The app already has the pieces a new provider needs. `TutorTransport` (`packages/shared/src/tutor/transport.ts`)
is the contract. `@livekit/react-native-webrtc` is already in the bundle, and the OpenAI transport is a
~250-line hand-rolled WebRTC client on top of it. The registry and `pnpm sync:agents` provision agents per
prompt version. So a provider costs one transport plus one sync adapter; the app itself doesn't change.

| # | Candidate | Keeps Claude | $/min *(E)* | Transport effort | What the test answers |
| --- | --- | :---: | ---: | --- | --- |
| 1 | **`gpt-realtime-mini`** | ✗ | 0.03–0.045 | none (env var) | Is a 3× cheaper realtime model good enough to teach? |
| 2 | **Vapi with a cheap voice** (Aura-2 / Cartesia / Inworld) + Haiku | ✓ | 0.085–0.10 | none (add a `voice` block) | How much voice quality do we give up per dollar, before building a DIY stack? |
| 3 | **Hume EVI** + our Claude key | ✓ | 0.05–0.11 | new WebSocket audio transport | Managed, expressive voice with our prompt and model — the closest like-for-like to ElevenLabs |
| 4 | **Deepgram Voice Agent** + our Claude endpoint | ✓ | 0.075–0.10 | new WebSocket transport | Same question as Hume, from the STT vendor; $200 free credit |
| 5 | **Ultravox** | ✗ | 0.05 | small — official React Native SDK | Cheapest managed per-minute price; is their model good enough to tutor? |
| 6 | **LiveKit Agents (DIY)** — Flux/AssemblyAI STT, Inworld/Cartesia TTS, Claude | ✓ | 0.045–0.08 | largest: an agent worker on the server; client over LiveKit, whose WebRTC we already ship | The long-term cost floor with Claude; worth it from ~100 learners. Stub: `docs/2026-09-11-livekit-claude-diy-provider.md` |
| 7 | Gemini Live (3.1 Flash) | ✗ | 0.03–0.08 | new WebSocket transport | Cheap, but the price grows with session length; test only if Claude is optional |

Not worth testing. **Retell** and **Bland** are built for phone calls and are pricier with Claude.
**Synthflow** is enterprise-only. **Grok Voice** is $0.08 without Claude, so no gain over ElevenLabs. The
**Speechmatics Flow** and **Layercode** products appear discontinued.

Suggested order: **1 → 2 → 3/4 → 6.**

- Steps 1 and 2 cost an afternoon and tell us how quality trades against price on stacks we already run.
- Hume or Deepgram only if 1 and 2 show we want Claude with a cheaper voice than ElevenLabs.
- LiveKit Agents only once usage is heading toward the 100-learner column, where the platform margin (§4)
  is thousands a month.

## 9. What to verify, and the one-line fixes that would replace estimates with measurements

- **Persist cost per lesson.**
  - Vapi: store the `end-of-call-report` `cost`/`costBreakdown` from `apps/web/src/app/api/v2/vapi/webhook/route.ts`.
  - ElevenLabs: `metadata.cost` and `metadata.charging` are already in the post-call payload
    (`apps/web/src/lib/langsmith-trace.ts` `PostCallData`).
  - Every provider: write `lesson_sessions.duration_secs` — it's null for OpenAI and Vapi today.
- **Fix `estimateCostUsd`** to price audio and text tokens separately (§2). It currently overstates by
  60–170%.
- **ElevenLabs:** is the LLM billed to us yet, or still absorbed? Do annual plans carry the same agent
  minutes?
- **Deepgram promotional prices** (STT and Voice Agent) end 2026-09-12; the regular rates above are what
  to plan on.
- **Model assumptions** behind the Claude-cascade rows: 2 LLM turns per minute and ~5.8k average context.
  The talk ratio (850–920 chars/min) is measured; the turn rate varied from 0.5 to 4 per minute across
  lessons.

## 10. Sources

Vendor pricing (checked 2026-09-11):
[ElevenAgents pricing](https://elevenlabs.io/pricing/agents) ·
[ElevenLabs plans](https://elevenlabs.io/pricing) ·
[ElevenLabs API](https://elevenlabs.io/pricing/api) ·
[OpenAI API pricing](https://developers.openai.com/api/docs/pricing) ·
[Vapi pricing](https://vapi.ai/pricing) ·
[Claude pricing](https://claude.com/pricing) ·
[Deepgram](https://deepgram.com/pricing) · [Deepgram Voice Agent LLM tiers](https://developers.deepgram.com/docs/voice-agent-llm-models) ·
[Hume](https://www.hume.ai/pricing) · [Hume billing (own LLM)](https://dev.hume.ai/docs/resources/billing) ·
[Ultravox](https://www.ultravox.ai/pricing) · [Ultravox SDKs](https://docs.ultravox.ai/apps/sdks.md) ·
[Gemini API](https://ai.google.dev/gemini-api/docs/pricing) · [Gemini Live](https://ai.google.dev/gemini-api/docs/live) ·
[xAI](https://docs.x.ai/docs/pricing) ·
[AssemblyAI](https://www.assemblyai.com/pricing) ·
[Retell](https://www.retellai.com/pricing) · [Bland](https://www.bland.ai/pricing) · [Synthflow](https://synthflow.ai/pricing) ·
[LiveKit](https://livekit.com/pricing) · [LiveKit inference](https://livekit.com/pricing/inference) ·
[Pipecat Cloud](https://www.daily.co/pricing/pipecat-cloud/) ·
[Cartesia](https://cartesia.ai/pricing) · [Inworld](https://inworld.ai/pricing) · [Rime](https://rime.ai/pricing) ·
[Soniox](https://soniox.com/pricing) · [Gladia](https://www.gladia.io/pricing)

Secondary (used where the vendor page lacked numbers):
[Layer3Labs — Vapi](https://www.layer3labs.io/guides/vapi-pricing) ·
[PXLPeak — ElevenLabs agents math](https://pxlpeak.com/blog/ai-tools/elevenlabs-pricing-guide) ·
[Gemini Live cumulative billing thread](https://discuss.ai.google.dev/t/does-gemini-live-native-audio-bill-cumulative-prompt-tokens-on-every-turn-cost-seems-to-scale-with-turn-count-not-call-duration/173248) ·
[Nova 2 Sonic (The Batch)](https://www.deeplearning.ai/the-batch/nova-2-family-boosts-cost-effective-performance-adds-new-agentic-features)

Our data: LangSmith projects `English Voice Agent - Dev` / `- Prod` (lesson traces, exported 2026-09-11);
Supabase `lesson_sessions` (transcripts, `duration_secs`).
