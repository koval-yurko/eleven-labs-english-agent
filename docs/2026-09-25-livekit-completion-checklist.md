# LiveKit completion evidence and device checklist

Companion to `2026-09-20-livekit-spike-task-plan.md`. Measurements are pending unless evidence is recorded below.

## Verified on 2026-09-25

- Vercel production environment audit: LiveKit URL/key/secret, grant secret, and LangSmith settings match the local backend. `LIVEKIT_PROJECT_ID` remains optional/unset.
- Local backend and worker: LiveKit URL/key/secret and grant secret match byte-for-byte; all six deployment settings are present.
- First device lesson `a676a70d-9de5-4f1f-b9d6-9a82815cc998`: 138 seconds, eight ledger rows, model `claude-sonnet-5`, no saved-word tool call.
- LangSmith read returned HTTP 200 for that conversation: completed trace, no root error, ten child IDs. This confirms filing, not a one-child-per-ledger-row audit.
- Cost report: `pnpm --filter web livekit:cost --help`. Arithmetic checks: `pnpm --filter web exec tsx scripts/check-livekit-cost.ts`.

- Real-prompt cloud tool exercise `2e99a65e-f283-43d5-ac86-c991369e34d5`: received `tutor.ready`, sent `tutor.say`, observed the tutor's `already_present` confirmation, and read one persisted ledger row containing `add_words_to_collection`. Existing owner-scoped vocabulary entry was preserved. Evidence: `.local/tool-smoke.json`.
- A preceding attempt received no `tutor.ready` within 45 seconds; retry succeeded without a code change. Keep dispatch readiness in the reliability/device pass; one successful retry does not establish reliable cold starts.
- Validation: backend and worker typechecks; lint for changed backend code and the worker; 39 worker properties; cost arithmetic checks including incomplete ledgers; `git diff --check`.

## Deployment findings

- Agent `CA_snjh6ZRrzUh7`, `tutor`, created in `eu-central`; root `livekit.toml` records the project/agent. Six allowlisted settings were provisioned with the approved create command.
- Monorepo create requires `--skip-sdk-check` because CLI 2.18.8 searches the root manifest; the SDK lives in the worker workspace. Noninteractive create requires `--region eu-central`.
- First cloud dispatch failed: the TTS plugin defaults to `ELEVEN_API_KEY`, while our secret is `ELEVENLABS_API_KEY`. `pipeline.ts` now passes the key explicitly; an offline constructor regression check reproduces and guards it.
- Cloud build logs showed `pnpm ... exec` re-resolving dependencies after other workspace apps were deleted. The Dockerfile now invokes installed binaries directly after the frozen install, including startup.
- Environment sync now locates `livekit.toml` at the repo root. Docker context excludes all dotenv variants, local artifacts, credentials and package-manager cache.
- Final deployment `2ULQA64mPu6k` is running. The audio simulation dispatched to this worker and completed real STT → Claude → TTS turns; logs confirm registration and job acceptance.
- Audio impairment run [SR_NtkQ7ghE8grg](https://cloud.livekit.io/projects/p_4rhidvfhevj/simulations/runs/SR_NtkQ7ghE8grg): one scenario, all three flags (`--background-noise --low-quality-microphone --packet-loss`), automated judge 1/1 pass. Export: `.local/audio-smoke-result.json`. The transcript **does not contain the requested Russian phrase** despite the judge claiming success. This is audio-pipeline evidence only, not Russian correctness, L4, or L8. It used the fallback fixture, not the real lesson prompt.
- L6 attempt failed after about five seconds: CLI 2.18.8 panicked in `LoadTestRoom.onParticipantDisconnected`, [`agentloadtester.go:285`](https://github.com/livekit/livekit-cli/blob/v2.18.8/pkg/loadtester/agentloadtester.go#L285), dereferencing `firstParticipant` before initialization. Local evidence: `.local/load-test.log`. There is no valid 40-room/20-minute reliability measurement. All temporary load-test rooms have since closed.
- **The plan missed a second L6 prerequisite:** [LiveKit's Build limit is five concurrent hosted agent sessions](https://docs.livekit.io/deploy/admin/quotas-and-limits/#agent-session-concurrency). Forty hosted sessions require a project quota of at least 40 before retrying with a fixed load runner. Do not confuse this with the separately deferred Anthropic tier check. No paid-plan upgrade was performed.

## First cost baseline — not the L7 gate

The report read the original eight ledger rows and 138-second session from Supabase successfully.
At [Anthropic's standard rates verified 2026-09-25](https://platform.claude.com/docs/en/about-claude/pricing),
Claude cost is **$0.019227 total / $0.00835957 per minute**. This excludes LiveKit, Deepgram,
ElevenLabs and observability, and it is one short session rather than five 20-minute lessons.
`costThreshold` correctly remains `unmeasured`.

The dated rate input is committed at `docs/2026-09-25-livekit-cost-rates.json`. It covers
`claude-sonnet-5`, standard API requests and the adapter's default five-minute cache TTL. Copy it to
`.local/` and add allocated invoices for the actual L7 sample. Re-verify rates for later measurement dates.
The baseline JSON is local at `apps/voice-worker/.local/first-lesson-cost.json`.

## Cost report inputs

Run from the repo root:

```sh
pnpm --filter web livekit:cost --owner '<Auth0 sub>' \
  --conversation '<conversation UUID>' \
  --evidence ../../docs/2026-09-25-livekit-cost-rates.json
```

For the all-in run, replace `--evidence` with your local rate-plus-invoice file. Repeat `--conversation` for the five scripted lessons. The report reads owner-scoped Supabase session durations and paginated ledger rows. It prints JSON without transcripts. Its denominator is total session minutes, not the last turn timestamp or an average of per-lesson rates.

The evidence JSON has this shape (replace placeholders with numeric values):

```text
{
  "rateSource": "dated billing rate source, model and cache TTL",
  "rates": {
    "<exact ledger model>": {
      "input": <USD per million uncached tokens>,
      "cacheRead": <USD per million cache-read tokens>,
      "cacheWrite": <USD per million cache-write tokens>,
      "output": <USD per million output tokens>
    }
  },
  "invoiceSource": "invoice IDs, period, and allocation method for ONLY these lessons",
  "invoices": {
    "livekit": <allocated USD>,
    "deepgram": <allocated USD>,
    "elevenlabs": <allocated USD>,
    "observability": <allocated USD>
  }
}
```

Omit both invoice fields to get a Claude-only report. Missing invoices are unmeasured, never zero. Explicit zero is appropriate only when supported by the billing evidence. Unknown models, incomplete/duplicate ledger sequences and invalid counts/rates/durations fail. `costThreshold` checks $0.08/min; it does **not** certify the five-lesson protocol or the other spike gates. Reconcile ledger totals with vendor usage: a request interrupted at shutdown may not reach a completed turn.

## Phone pass — prepare for later

Use the same preview build throughout. Confirm the deployed worker accepts a dispatch first. For each row record build, provider/version, conversation ID, elapsed time, expected/observed behavior, and the feedback report ID. File feedback immediately after a failure while events remain available.

1. **Screen lock first:** start LiveKit, lock for 20 minutes, continue speaking and listening. Confirm audio, mic, transcript and persisted ledger survive. Stop the pass if this fails.
2. **Save a word:** ask the tutor to add a distinctive word to your collection; confirm it appears once under your account and `add_words_to_collection` appears in the ledger. Capture the conversation ID.
3. **Pause/resume:** pause five minutes while the tutor is speaking, resume; repeat while silent. No speech during pause; one coherent continuation on resume.
4. **AirPods:** connect and disconnect mid-turn. Confirm mic/output route and the next response recover.
5. **Interruptions:** incoming call, return to lesson; then Siri. Confirm recovery and resumed conversation.
6. **Network:** switch Wi-Fi to LTE during a lesson. Record reconnect delay, any lost/duplicated speech, and the final saved transcript.
7. **Speakerphone:** quiet room, then noisy room. Record self-interruptions separately from legitimate learner interruptions.
8. **Provider switching:** ElevenLabs → LiveKit, then LiveKit → ElevenLabs in the same app process. Confirm audio both ways.
9. **Worker crash:** coordinate an intentional worker termination mid-turn. Expect a dropped-session card and a working resume path. Do not substitute a normal lesson end or mark this passed from code inspection.
10. **Latency baselines:** one short lesson each on ElevenLabs, OpenAI, Vapi; file feedback immediately and check for `turn.gap`. Keep each below the debug-event trimming threshold.

## Corpus recording

Store 30–50 real learner recordings in `apps/voice-worker/.local/corpus/`. Use mono 16-bit PCM WAV; trim trailing silence so the clip ends when speech ends. Include 1–3 second word-search pauses inside sentences, fillers, Russian inserts, one-word answers, and backchannels. Keep a local clip manifest with category and intended end. This is the current learner's own recording; reassess consent before introducing another learner.

Then run `pnpm --filter voice-worker replay` against all three plans. Preserve its output and exact preset values. Synthetic speech does not replace this corpus. Review the harness's state-based cutoff/self-interruption scores against audio before treating them as gate measurements.

## Blind quality comparison

Use identical vocabulary/items and comparable scenarios on `words-1.x` and `words-4.0`. Hide provider labels and randomize A/B order before rating pacing, interruptions, Russian correctness and five-thread coverage. Preserve ratings before revealing labels. Voice gate: Flash no worse on Russian inserts.

## Operator measurements after deployment

- Simulate audio separately with background noise, low-quality microphone and packet loss; preserve scenario, flags and output.
- L6: 40 rooms × 20 minutes; record dispatch-to-join, job crashes, stalled turns, start/end RSS per job, 429/529 counts and STT reconnects. A rate-limit failure requires resolving Anthropic capacity before interpreting the reliability gate.
- L7: five scripted 20-minute lessons with stored ledger and session IDs, dated model rates and allocated invoices including observability.
- Latency: p50/p95 for the final five minutes of a 20-minute lesson; exclude missing sentinel values and kickoff turns.
- Fill all five gate cells in the task plan and record a go/no-go decision. Human/device tests and missing invoices remain pending, not presumed passed.
