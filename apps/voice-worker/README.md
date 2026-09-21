# LiveKit voice worker

This is the server process behind the mobile app's **LiveKit English tutor** (`words-4.0`).
It joins a learner's LiveKit room and runs the voice conversation:

```text
Mobile microphone → LiveKit → Deepgram speech recognition
                            → Claude tutor + collection tool
                            → ElevenLabs speech synthesis → LiveKit → mobile speaker
```

The worker uses Deepgram Flux with English/Russian language hints, our Claude adapter, and
ElevenLabs Flash v2.5. Turn-taking presets control how long it waits for the learner and when
speech can interrupt the tutor.

The web backend creates the room token and dispatch metadata: lesson instructions, model, voice,
turn plan, and a short-lived lesson grant. The worker registers as `tutor`, accepts the dispatch,
and handles the phone's kickoff, context updates, cancellation, and lifecycle signals.
It saves transcripts and per-turn usage/latency records through the backend and can call
`add_words_to_collection` with the learner's grant. It has no direct Supabase access.

**This deploys separately from the web backend on Vercel and the mobile app.** A Vercel deploy
does not deploy this worker. The worker must be running locally or on LiveKit Cloud for a
LiveKit lesson to connect.

## Where things live

| File | Purpose |
| --- | --- |
| `src/agent.ts` | Room lifecycle, phone controls, pipeline, transcript and ledger writes |
| `src/claude-llm.ts`, `src/claude-request.ts` | Claude streaming adapter, tools and prompt caching |
| `src/pipeline.ts` | Deepgram STT and ElevenLabs TTS configuration |
| `src/turn-plans.ts` | `patient` (default), `normal`, `eager` turn-taking presets |
| `src/backend.ts`, `src/save-words-tool.ts` | Grant-authenticated backend calls |
| `src/turn-ledger.ts` | Per-turn token counts, timings, interruptions and errors |
| `src/replay.ts` | Recorded learner audio replay for turn-plan evaluation |
| [`../../packages/shared/src/tutor/livekit-wire.ts`](../../packages/shared/src/tutor/livekit-wire.ts) | Shared worker/mobile/backend protocol |
| [`../../apps/web/src/agent/prompts/words-4.0.ts`](../web/src/agent/prompts/words-4.0.ts) | Versioned tutor prompt; sent by the backend at dispatch time |
| [`../../Dockerfile`](../../Dockerfile), [`../../livekit.toml`](../../livekit.toml) | Container build and existing cloud agent identity |

## Run locally

All commands below run from the **repository root**, unless stated otherwise.
Use Node 22 and the pnpm version pinned in the root `package.json` (currently 11.20.0).
Install the [LiveKit CLI](https://docs.livekit.io/reference/developer-tools/livekit-cli/)
when using console, simulation or deployment commands.

```sh
pnpm install --frozen-lockfile
cp apps/voice-worker/.env.example apps/voice-worker/.env
```

Fill the new `.env` using the existing project/vendor credentials:

| Setting | Purpose |
| --- | --- |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Same LiveKit project as the backend; needed locally, injected by LiveKit Cloud in production |
| `ANTHROPIC_API_KEY` | Claude API access |
| `DEEPGRAM_API_KEY` | Speech recognition |
| `ELEVENLABS_API_KEY` | Speech synthesis; explicitly passed to the plugin |
| `ELEVENLABS_TEACHER_VOICE_ID` | Default tutor voice |
| `LIVEKIT_GRANT_SECRET` | Must match the backend's value exactly |
| `API_BASE_URL` | Backend origin used for transcript/ledger/collection writes |

The worker reads **its own** `.env`, not `apps/web/.env`. Shell environment variables take precedence.
See [`.env.example`](.env.example) for optional model and fixture overrides.

```sh
pnpm --filter voice-worker dev             # register a local worker; accept dispatched lessons
pnpm --filter voice-worker console         # text conversation
pnpm --filter voice-worker console:voice   # microphone/speaker conversation
```

Without dispatch metadata or a fixture, console mode uses a small diagnostic prompt, not the
real lesson prompt. To use a real prompt with sample vocabulary:

```sh
mkdir -p apps/voice-worker/.local
pnpm --filter web --silent dispatch:fixture > apps/voice-worker/.local/dispatch.json
DISPATCH_METADATA_FILE=.local/dispatch.json pnpm --filter voice-worker console:voice
```

That fixture has no lesson grant, so it does not persist sessions or expose the collection tool.
Local audio, fixtures and ledgers stay in the gitignored `apps/voice-worker/.local/` directory.

## Check changes

```sh
pnpm --filter voice-worker typecheck
pnpm --filter voice-worker lint
pnpm --filter voice-worker check
pnpm --filter @tutor/shared typecheck
pnpm --filter @tutor/shared lint
pnpm check:shared
```

These are offline checks. `smoke`, `stt:check`, `replay` and cloud audio simulations call real
services and consume usage. Replay needs real learner clips; see the
[completion checklist](../../docs/2026-09-25-livekit-completion-checklist.md).

## Deploy after changes

The existing production agent is `tutor` (`CA_snjh6ZRrzUh7`) in `eu-central`.
The repository-root `livekit.toml` selects it. **Use `deploy`, not `create`, for updates.**

1. Run the checks above.
2. Authenticate the CLI to the existing project with `lk cloud auth` if needed.
3. From the repository root, deploy and inspect the result:

   ```sh
   lk agent deploy . --skip-sdk-check --yes
   lk agent status
   lk agent logs
   ```

Use CLI 2.18.8, the version used for this deployment and pinned in CI. Its SDK discovery looks
at the root `package.json`, while our SDK is in `apps/voice-worker`; `--skip-sdk-check` bypasses
that discovery mismatch. It does not skip our typechecks, tests or Docker build.

LiveKit uploads the root build context and builds the Linux image remotely. No local Docker
build is needed. The context must be the repository root because the lockfile and shared package
are outside this app. The container runs TypeScript with `tsx`; there is no separate emitted-JS
build. Installed executables are invoked directly after dependency installation to avoid pnpm
re-resolving the pruned workspace.

Existing cloud runtime secrets survive a code deploy. Local `.env` files are excluded from the
build context. To update secrets separately:

```sh
pnpm env:push --target worker                  # inspect the proposed changes
pnpm env:push:apply --target worker --secrets  # apply values from the worker's .env
```

The second command sends the registered values to LiveKit and restarts the worker; `--secrets`
includes existing write-only values. `LIVEKIT_URL` and project credentials are runtime-injected
and are not uploaded by this sync. Do not change the grant secret on only one side.

After deployment, run a short mobile lesson and check the transcript/ledger write-back. A `Running`
status confirms the deployment, not the full lesson flow. The Build plan can cold-start; dispatch
readiness remains part of the device checks.

A prompt-only edit under `apps/web/src/agent/prompts/` needs a backend deployment: the prompt is
sent with each new lesson. Worker logic, turn plans, dependencies and shared protocol changes
need a worker deployment. Protocol changes may also require coordinated backend/mobile releases.

## Automatic deployment on pushes to master

[`.github/workflows/deploy-voice-worker.yml`](../../.github/workflows/deploy-voice-worker.yml)
implements this:

1. A push to `master` touching the worker, shared package, build inputs or workflow runs checks.
2. If all checks pass, CI deploys the existing agent from the repository root.
3. Deployments are serialized; an active remote build is not canceled by a newer push.

Unrelated backend/mobile source changes do not redeploy the worker. Their manifests and the root
lockfile do trigger it because they are Docker build inputs. You can also use **Actions → Deploy
voice worker → Run workflow**, selecting `master`. Other branches cannot deploy through this workflow.

### One-time GitHub setup

Add these **repository Actions secrets** in
[Settings → Secrets and variables → Actions](https://github.com/koval-yurko/eleven-labs-english-agent/settings/secrets/actions):

- `LIVEKIT_URL`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`

Use credentials for the same project named in root `livekit.toml`. These grant CI deployment
access. Anthropic, Deepgram, ElevenLabs and lesson-grant secrets already live in LiveKit Cloud;
CI does not need copies of them or a `SECRET_LIST`.

Commit and push the workflow, this README, root `livekit.toml`, and the related worker/build changes
to `master`. Automatic deployment becomes usable once those files and the three GitHub secrets
are present. Missing credentials fail the workflow with their names, without printing values.

The workflow runs the CLI directly because this monorepo needs `--skip-sdk-check`, which the
standard action does not expose as an input. It downloads the pinned official CLI release and
verifies its published checksum. See [LiveKit deployment documentation](https://docs.livekit.io/deploy/agents/managing-deployments/).

## Status and remaining validation

The cloud worker has completed an impaired-audio smoke test and an existing-word tool exercise.
This does not complete the spike's release gates: phone tests, recorded-corpus tuning, blind
quality comparison, load testing and the full invoice-based cost measurement remain.

See the [task plan](../../docs/2026-09-20-livekit-spike-task-plan.md) and
[completion checklist](../../docs/2026-09-25-livekit-completion-checklist.md) for evidence and blockers.
