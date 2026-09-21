# LiveKit spike — task plan by phase

**Date:** 2026-09-20 · **Status:** Phases 1–3 done (2026-09-25); L5 device matrix deferred to one
end-to-end pass at the end; Phase 4 deployment and verification in progress · **Parent research:**
`docs/2026-09-11-livekit-claude-diy-provider.md` (the "research doc" below).

**Decision (2026-09-20): phase by technical risk** — option 1 of the phasing options the research doc's
own §7 already proposed (text → laptop voice → phone → measure), chosen over spend-staged, risk-category
and parallel-seam framings. Those three aren't discarded: §7's five-gate pass/fail at the end of Phase 4
here is exactly what triggers moving into the *spend-staged* pilot (Ship plan, real learners) described in
the research doc's §9.5, and the portability seams in the research doc's §10 still apply to whatever this
spike builds. This document exists to turn that one option into tasks a single engineer can work from
top to bottom, one phase at a time, without re-deriving them from the research doc's prose each time.

**How to use this doc.** Each phase is a checklist and an exit criterion. Don't start the next phase until
the current one's exit criterion is true — that ordering is the entire point of phasing by risk: the
riskiest, cheapest-to-fail-fast checks (does the Claude adapter work at all?) come before the ones that
cost real setup (a phone build, a load test). Every task cites the research doc section it comes from, so
"why is this here" is one click away rather than re-explained.

---

## What is left — every phase, in one place

Phases 1–3 are done and Phase 4's code is written, but "done" in three of those phases carried a
deferral with it. Everything still outstanding across all four phases is listed here once, tagged
with the phase it came from and grouped by what actually blocks it — so the state of the spike is one
section rather than a reading of four. Detail for each item lives in its own phase below.

### 1. Code — completed 2026-09-25

- [x] **The L7 cost report** *(Phase 4)*. `pnpm --filter web livekit:cost` reads owner-scoped,
      paginated ledger rows and session durations; applies explicit per-model token rates; adds
      allocated LiveKit, Deepgram, ElevenLabs and observability invoices. Missing invoices leave
      the all-in threshold unmeasured. Usage and remaining human checks:
      [`2026-09-25-livekit-completion-checklist.md`](2026-09-25-livekit-completion-checklist.md).

### 2. Provisioning — completed 2026-09-25 *(Phase 4, moved from Phase 2)*

- [x] **`lk agent create . --skip-sdk-check --region eu-central` from the repo root.** Builds remotely on LiveKit's x86 infrastructure;
      see "The Docker image" under Phase 4 for why the context is the repo root.
- [x] **Secrets provisioned with `lk agent create --secrets-file`** — `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`,
      `ELEVENLABS_TEACHER_VOICE_ID`, `LIVEKIT_GRANT_SECRET`, `API_BASE_URL`. **This sends real
      credentials to LiveKit Cloud**; approved and provisioned 2026-09-25. Agent `CA_snjh6ZRrzUh7`.
- [x] Confirm the deployed agent registers and takes a dispatch (`lk dispatch create --agent-name
      tutor`), the same check that diagnosed the first failed device run.
- [x] **Audit the Vercel environment**, checked 2026-09-25 against local production settings (all required values match):
      `LIVEKIT_URL`/`_API_KEY`/`_API_SECRET` must name the **same project** the worker registers with;
      `LIVEKIT_GRANT_SECRET` must be **byte-identical** or every write-back fails closed at the end of
      a lesson; `LANGSMITH_API_KEY` must be set or Phase 4 reads an empty project; `LIVEKIT_PROJECT_ID`
      is optional and only feeds the operator link.

### 3. Needs a person — no script substitutes

- [ ] **`turn.gap` on the three shipped providers** *(Phase 2, deferred into Phase 3)*. File a debug
      report from a short lesson on ElevenLabs, OpenAI and Vapi each, and confirm the event is there.
      Keep the lessons short: `turn.gap` is `debug`-level and `trimDebugEvents` sacrifices `debug`
      first past 300 events. **This is the provider-agnostic latency baseline** — until it exists,
      LiveKit's numbers have nothing to be compared against, which is half of what Phase 4 is for.
- [ ] **Record the L4 corpus** *(Phase 4)*, 30–50 clips, roughly ten minutes of talking. The blocker
      the research doc called "consent" does not apply: this is a single-learner app and the learner
      is the person reading this. Keep it in `.local/corpus/`.
- [ ] **L8 — the blind quality comparison** *(Phase 4)*. Same learner, same items, `words-1.x`
      against `words-4.0`, rated without knowing which is which.
- [ ] **The L5 device matrix** *(Phase 3)*, deferred to one end-to-end pass once the feature is
      complete. The screen-locked row is the one to run first regardless: it is the reason this app
      is native. The worker-crash row has never executed at all.
- [ ] The end-to-end device pass, with issues filed through the feedback flow.

### 4. Verification of what already shipped

- [x] **Confirm a LangSmith trace was actually filed** *(Phase 3)*. The first real lesson
      (`a676a70d-9de5-4f1f-b9d6-9a82815cc998`) wrote its transcript and its 8 ledger rows, but the
      trace runs in `after()` on Vercel. Verified 2026-09-25: HTTP 200, completed root with no
      error and ten child IDs. Trace presence is confirmed; child-to-ledger reconciliation remains
      distinct from this check.
- [x] **Exercise `add_words_to_collection` once** *(Phase 1, deliberately skipped then)*.
      Cloud lesson `2e99a65e-f283-43d5-ac86-c991369e34d5` used the real `words-4.0` prompt and
      a lesson-scoped grant. The tutor called the tool for an existing entry, reported
      `already_present`, and persisted the tool call in its ledger. The existing word was preserved.
      A fresh-word insertion remains part of the later phone pass.

### 5. Measurements — once the sections above exist

- [ ] Run `pnpm --filter voice-worker replay` across all three turn plans *(Phase 4)*; tune the
      thresholds in `turn-plans.ts` against what the corpus shows.
- [x] `lk agent simulate audio` with all three impairment flags. Run `SR_NtkQ7ghE8grg` completed; pipeline smoke only, not a Russian-quality result (see completion checklist).
- [ ] **L6 — blocked**, 40 rooms × 20 minutes: CLI 2.18.8 crashes in its disconnect handler, and the Build plan permits only five hosted agent sessions. Fix the runner and provision ≥40-session quota before retrying. Watch RSS growth,
      dispatch → joined, the Anthropic 429 rate and STT reconnects.
- [ ] **L7 — cost**, five scripted 20-minute lessons plus allocated invoices. First short-session Claude-only baseline: $0.019227 total / $0.00835957 per minute; this is not the all-in gate.
- [ ] **Fill the go/no-go gate table and write the decision down**, which is the point of the spike.

### Completion pass, 2026-09-25

Code report, production environment audit, trace-presence check, save-word tool exercise and cloud deployment are complete.
Phone/corpus/blind-rating work is explicitly deferred by the learner to the
[completion checklist](2026-09-25-livekit-completion-checklist.md). L6 has concrete harness and
capacity blockers recorded below. **Decision: hold the pilot; go/no-go remains unmeasured.** This is
not a provider rejection: the remaining gates have not been measured under the required protocol.

### Known risks carried into this

- **The Anthropic rate-limit tier was deliberately skipped.** A 429 during L6 is that decision coming
  due, not a LiveKit finding (open question 3).
- **The latency gate is already known to be tight**: the first device lesson measured 3109 ms e2e
  against a gate of p50 ≤ 1.5 s, with TTS answering in 187 ms. It will be won in turn-plan tuning or
  not at all.
- **Consent returns the moment a second learner does** — and so does the ownership split the LiveKit
  path introduced (`docs/2026-09-25-lesson-grant-tool-authorization.md`).

---

## Open questions before Phase 1

Four things are genuinely unresolved rather than merely estimated, and two of them are worth starting
now because they have lead time outside this repo. Everything else marked `(verify)`/`(estimate)` in the
research doc is deliberately left for the phase that measures it (region choice in Phase 4's L6, the
$/min model in Phase 4's L7, the thinking-block/tool-result interaction and the cache/ITPM rate-limit
question inside Phase 1's own adapter work) — those aren't blockers, they're what the phases exist to
answer.

1. **~~How does the per-lesson grant actually authorize `add_words_to_collection`?~~ — designed
   2026-09-25, `docs/2026-09-25-lesson-grant-tool-authorization.md`.** It is the third of the three
   mechanisms guessed at below: **the worker doesn't use MCP at all.** MCP is the seam that lets
   a *hosted* agent call our backend, and the LiveKit worker is our code — Phase 1's own Claude adapter
   already owns the `tools` array. So the tool becomes a worker-local tool whose handler is one call to
   a new grant-authenticated route, `/api/v2/livekit/collection-items`, which stamps the real owner via
   the same `addWords(ownerId, …)` the mobile app's own add uses. `/api/mcp`, `MCP_TOKEN` and the
   `ANONYMOUS` write are untouched, so the three shipped providers are unaffected. The grant is an HS256
   JWT signed with `LIVEKIT_GRANT_SECRET` (the `jose` pattern the Vapi token route already uses), and
   one helper verifies it for both new routes. **Phase 3's tasks below are unblocked.** Read the doc
   before writing either route — it also names what the design costs.

   *Original question, for the record:*
   The research doc specs the grant for the session-end write-back (§1, §5.2: "grant-verified") in
   detail, but never says how the *tool call* itself validates it. Today that tool runs on a shared
   `MCP_TOKEN` and writes as `ANONYMOUS` (`apps/web/src/agent/prompts/types.ts:197-203`,
   `docs/2026-08-27-mcp-static-token-auth.md`); the research doc's §1 and §3.10 both assume this gets
   replaced by the grant, but the actual mechanism — does the worker call the existing MCP server at
   `/api/mcp` with a grant-derived header, does the MCP server need new code to accept a per-lesson token
   alongside the static one, or does the worker call a new authenticated route instead of MCP entirely —
   is undesigned. **This blocks Phase 1's own walkthrough item** ("`add_words_to_collection` is called
   with the right words"), which as written would still exercise the old `ANONYMOUS` path. Resolve this
   before writing that part of Phase 1, not after.

2. **~~Does the dispatch metadata actually stay private to the agent job?~~ — resolved 2026-09-21,
   research doc §3.10. No action needed.** Checked against LiveKit's documented token format and server
   SDK source. Job/dispatch metadata doesn't leak to *other* room participants (it's architecturally a
   distinct field from room/participant metadata). It is readable by the learner's own device — `roomConfig`
   is a JWT claim, and JWTs are signed, not encrypted, so the phone can decode its own token. **Decided:
   not a problem** — `{conversationId, version, instructions, turnPlan, llm, voice, grant}` carries no
   secrets, just this lesson's own prompt and items, which the learner's device already has the content
   of by the time it's spoken to them. The real credentials never go anywhere near dispatch metadata.
   Original token-route design (§1's `AccessToken` + `roomConfig`) stands as written; no Phase 3 change.

3. **~~Anthropic org rate-limit tier — check now, not in Phase 4.~~ — deliberately skipped 2026-09-25.**
   §3.3 flags that Phase 4's 40-room load test needs roughly 1–1.5M input tokens/minute at scale, and
   that a 429 mid-lesson is a silent tutor. The original advice was to check the tier early because
   *raising* one goes through Anthropic support and has its own lead time. **Decided not to.** Nothing
   before Phase 4's L6 generates that load, and a spike that never reaches L6 would have spent the
   effort for nothing. **The cost of the skip, so it is not a surprise:** if the tier turns out to be
   too low, L6 stalls for however long a support ticket takes, and the load-test gate is the one that
   blocks the go/no-go call. L6 already lists "Anthropic 429/529 rate" among what it watches — treat a
   429 there as this question coming due, not as a finding about LiveKit.

4. **Consent and data handling for the L4 replay corpus — no existing process.** Phase 4 needs 30–50 real
   learner utterances "with consent" (research doc §4 L4), but nothing in this repo's docs describes a
   consent flow, a retention policy, or who owns that call for this app. This is a product/legal question,
   not an engineering one, and it has no assigned owner yet. Raise it early — Phase 4 cannot start on
   schedule if this is still unresolved when Phase 3 finishes.

**Cheap to resolve standalone, before Phase 2 commits to it:** whether Deepgram Flux actually handles a
learner answering in Russian (research doc §2 Q5) is one API call away from an answer and doesn't need
any worker code written first — test it directly against Deepgram's API with a mixed-language sample
before wiring the plugin into `apps/voice-worker` in Phase 2, so a bad answer doesn't cost a rewrite.

---

## Phase 1 — Text only (day 1–2) — ✅ done 2026-09-21

**Goal:** prove the Claude integration is correct, offline, before any audio or room exists.

- [x] Scaffold `apps/voice-worker` as a new pnpm workspace app (Node 22, TS), per the research doc's §6
      "What we'd build" table.
- [x] Add the prompt version file `apps/web/src/agent/prompts/words-4.0.ts` with `provider: "livekit"`,
      reusing `PODCAST_LESSON_PROMPT` unchanged (research doc §6 — no lockfile entry, not provisioned).
- [x] Build the wire-contract skeleton `packages/shared/src/tutor/livekit-wire.ts`: RPC and text-stream
      names, payload codecs with size guards (RPC payloads cap at 15 KiB — research doc §2 Q6), and the
      `TurnRecord` ledger shape (research doc §5.2).
- [x] Write the L0 checks into `pnpm check:shared` (research doc §4 L0):
  - round-trip: `decode(encode(x)) === x`
  - size routing: anything over 15 KiB routes to a text stream — include a Cyrillic 20-turn resume
    context as a fixture (UTF-8 Cyrillic is 2 bytes/char, so this is the real failure case, not a
    theoretical one)
  - pause coverage: the held-pause cross-product runs for the new capability set, via
    `packages/shared/src/testing/fake-transport.ts`
- [x] Implement the Claude LLM adapter (~300 lines — research doc §3.2's mitigation list, all required,
      not optional extras):
  - top-level `cache_control: {type: "ephemeral"}` so the cache breakpoint follows the growing history
  - `thinking: {type: "disabled"}` for Sonnet 5, and no sampling params (`temperature` 400s on Sonnet 5)
  - never hoist `system`/`developer` messages — context notes become user-role markers
    (`[lesson app] The learner paused.`), never system, and consecutive user items are merged
  - never end a request on an assistant turn, and never insert a dummy user turn after an unresolved
    `tool_use` (the second trap named in livekit/agents#7217)
  - report `cache_read_input_tokens` / `cache_creation_input_tokens` into the `TurnRecord`
- [x] Write the L2 checks (research doc §4 L2), as a pure request-builder test suite:
  - never ends on an assistant turn
  - never puts a user turn between `tool_use` and its `tool_result`
  - no `temperature`; `thinking.type === "disabled"` for Sonnet 5
  - byte-identical `tools` + `system` prefix across turns (the cache invariant)
  - context notes always become user-role markers
- [x] Add one live smoke test: three sequential turns, asserting `cache_read_input_tokens > 0` from
      turn 2 — "the test that would have caught #7217 and the hoisting bug" (research doc §4 L2).
- [x] Run the worker in `lk agent console --text`, fed the real prompt and a real item list shaped like
      dispatch metadata, and manually walk through: kickoff, a pause context, a Russian answer, "skip
      this one", 30 turns deep still following the five threads (research doc §4 L1's scenario list —
      doing this by hand here, not yet as an automated eval). **Skip the `add_words_to_collection` call
      for now** — how the per-lesson grant authorizes that tool is still undesigned (open question 1
      above, deliberately deferred); exercise it once that's resolved, not before.
- [x] Add `"livekit"` to the hardcoded provider lists (research doc §3.9), even though nothing renders
      yet — everything downstream is inert without it: `TutorProviderId` (`transport.ts:14`),
      `TUTOR_PROVIDERS` (`apps/mobile/src/lib/transport/index.ts:23-32`), `useTutorTransports`
      (`tutor-session.tsx:238-250`), `CLIENT_READY`/`PROVISIONED` (`agent-registry.ts:65-86`), `PROVIDERS`
      in the debug-report sanitizer (`packages/shared/src/debug/report.ts:270`), `providerConsoleUrl`
      (`debug-report-links.ts:84-101`).

**Exit criterion:** L0 and L2 checks pass; the live smoke test shows cache reads from turn 2; a full
text-only conversation against the real prompt runs correctly in the console, including one pause and one
Russian answer.

**Outcome (2026-09-21, commit `55d800a`):** all three hold.

- L0: `pnpm check:shared` passes, including the Cyrillic resume fixture. At its worst case (20 turns ×
  400 chars of solid Cyrillic) it measures just over 15 KiB, so the routing decision is proven at the
  boundary rather than far from it. A natural sentence with spaces lands *under* 15 KiB, which is why
  the byte counter is exact and the fixture is dense.
- L2: 19 property checks pass (`pnpm --filter voice-worker check`).
- Live smoke (`pnpm --filter voice-worker smoke`, Sonnet 5): turn 1 wrote 5502 tokens to the cache;
  turns 2 and 3 read 5502 / 5566 back and wrote only a 64–65-token delta each. The breakpoint follows
  the history as designed.
- Console walkthrough: passed by hand. The pause was simulated by typing the note text as a learner
  turn, because `--text` mode has no way to send a no-reply note. That tests the prompt's handling of a
  pause, not the adapter's `[lesson app]` path, which L2 covers instead.

Found while building, and not in the plan above:

- `@livekit/agents-plugin-anthropic` 1.9.0 still has every §3.2 bug (read from its source), so the
  adapter replaces it rather than wrapping it.
- `lk agent console` runs the entrypoint through Node's own ESM resolver, not `tsx`, so relative imports
  in `apps/voice-worker` need explicit `.ts` extensions (`allowImportingTsExtensions`).
- A script that drives the adapter outside a worker must call `initializeLogger()` first, or
  `LLMStream` throws "logger not initialized".
- Adding `"livekit"` to `TutorProviderId` forces a mobile hook to exist, so
  `apps/mobile/src/lib/transport/livekit.ts` is a placeholder that throws on `start()` until Phase 3,
  and `CLIENT_READY` keeps it out of the picker.
- `providerConsoleUrl` returns `null` for LiveKit until the room-naming convention exists (Phase 3).
- The real prompt reaches the worker through `pnpm --filter web dispatch:fixture`, since the worker may
  not import `apps/web`. Its output goes to `apps/voice-worker/.local/` (gitignored).

Still open from before Phase 1: open question 3 (the Anthropic rate-limit tier) has not been checked —
and as of 2026-09-25 will not be, by decision. See the amended question above for what that costs.

---

## Phase 2 — Voice on a laptop (day 2–3) — ✅ done 2026-09-25

**Goal:** prove the voice loop end-to-end, and start the latency baseline immediately — for every
provider, not just this one.

- [x] Create the LiveKit Cloud project (Build plan, $0). ~~and run `lk agent create` from
      `apps/voice-worker/`~~ — **the deploy is deferred to Phase 4** (2026-09-25, see below); the
      project and its credentials are what Phase 2 and 3 actually need.
- [x] Add the new env vars to `apps/web/.env.example` and a new `apps/voice-worker/.env.example`
      (research doc §10.1 has the full table): `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`,
      `LIVEKIT_GRANT_SECRET` (mint with `openssl rand -hex 32`), `LIVEKIT_AGENT_NAME`; the worker's own
      copies of `ANTHROPIC_API_KEY` and `ELEVENLABS_API_KEY`, an STT vendor key, and `API_BASE_URL`.
- [x] Register the STT vendor account (Deepgram Flux) and wire it into the `AgentSession`. The EN/RU
      language-mode check (research doc §2 Q5) **passed on 2026-09-25** — see below.
- [x] Wire ElevenLabs Flash into the `AgentSession` as the first TTS, on our own key (research doc §2 Q5
      — the known-good voice, chosen specifically to remove one unknown from the spike).
- [x] Define the turn-taking presets as one typed constant (research doc §2 Q4's table: patient / normal
      / eager → `turn_handling.endpointing`/`interruption` values) — this is the "keep config in code"
      seam from research doc §10.3 point 2, so start it here rather than hand-typing values at the
      dispatch call site later.
- [x] Start writing the `TurnRecord` ledger per turn (research doc §5.2) — even to a local file or stdout
      at this stage; the storage route doesn't exist until Phase 3.
- [x] Add `turn.gap` to `tutor-session.tsx`, **not** to any one provider adapter (research doc §5.3): time
      from the learner's last `onTurn` to `isSpeaking` becoming true. This is the provider-agnostic
      latency probe — adding it now means the ElevenLabs/OpenAI/Vapi baseline starts accumulating in
      parallel with this spike, instead of only once LiveKit ships.
- [ ] Run `lk agent console` in voice mode against the laptop mic; confirm a full turn (mic → STT →
      Claude → TTS → speaker) sounds right, including a Russian mid-sentence insert.

**Exit criterion:** a full voice turn works locally end-to-end; the ledger has real per-turn entries;
`turn.gap` events are showing up in debug reports for all four providers, not just this one.

**Progress (2026-09-21):** the code is done. What's left needs accounts and a person at a mic.

- STT is `deepgram.STTv2` on **`flux-general-multi` with an `["en", "ru"]` language hint**, not
  `flux-general-en`. The 1.9.0 plugin ships a multilingual Flux model, so the §2 Q5 question is now
  "does multi handle a Russian insert", not "is Flux English-only". `pnpm --filter voice-worker
  stt:check` answers it: it voices three EN/RU sentences with ElevenLabs and prints what both Flux
  models transcribe. Run it before the console walkthrough. `DEEPGRAM_MODEL` switches the model.
- TTS is `eleven_flash_v2_5`, using `ELEVENLABS_TEACHER_VOICE_ID` when a lesson names no voice.
  That's the ElevenLabs tutor's own voice, so the L8 test compares the pipelines, not two voices.
- Turn plans: `apps/voice-worker/src/turn-plans.ts`, the §2 Q4 table in milliseconds. A lesson that
  names no plan gets `patient`.
- Ledger: `src/turn-ledger.ts` is pure and property-checked (`pnpm --filter voice-worker check`, now
  38 checks). It writes `.local/ledger/<conversationId>.jsonl` and prints one line per turn.
  `agentText` is the full completion, taken from a new `onCompletion` hook on `ClaudeLLM`, and
  `agentHeardText` is what played. Tokens are summed over every billed request, discarded
  preemptive ones included, so L7's $/min can be read straight off the ledger.
- `turn.gap` is a `debug`-level event. Under ring pressure the oldest gaps are evicted first, so a
  long lesson keeps its most recent ones. A learner line that lands while the tutor is already
  speaking doesn't start a gap, and neither does a pause.
- **Not an env var:** `LIVEKIT_AGENT_NAME`. It's a constant in `livekit-wire.ts`, which is what §10.1
  asks for ("one constant, not three hand-typed strings"). An env var next to it would be a second
  source of truth. The worker registers under it, so automatic dispatch is off.
- The VAD and the turn detector are the session's defaults. **Without LiveKit credentials the
  detector quietly falls back to the local `v1-mini` model.** That's fine for `console`, but it isn't
  what Phase 4 measures.
- Fixed: the `console` script was `tsx src/agent.ts console`, and that can't work, because the
  subcommand needs the broker `lk agent console <entry>` starts. It is now `lk agent console --text
  src/agent.ts`, and `console:voice` drops `--text`.
- `apps/voice-worker/.env` is loaded by `src/env.ts`. `.gitignore` now keeps `.env.example` files.

**§2 Q5 answered: `flux-general-multi` passes (2026-09-25).** The learner may answer in Russian and be
heard. Measured with `pnpm --filter voice-worker stt:check`:

| what the learner says | `flux-general-en` | `flux-general-multi` |
|---|---|---|
| pure Russian sentence | **nothing at all** | transcribed, `[ru]` |
| code-switch at a clause boundary | "The vice leader shows lower" | both halves correct |
| one Russian word mid-question | `slozny` | `сложный` |
| one Russian word mid-sentence | `mimolotny` | `mimolotni` — Latin, not Cyrillic |

The English-only model is not a degraded option, it is a broken one: a learner who switches to Russian
for a whole sentence — the exact moment they most need help — gets **silence** back, and the tutor
answers a question nobody asked. That settles the model choice.

**The first run of this check lied, and the fix is part of the answer.** It reported `multi` silently
dropping `мимолётный` and losing the first word of a sample. Both were the harness: the English
teacher voice was pronouncing the Cyrillic (testing the TTS, not the STT), and audio started in frame
zero, so Flux's turn began mid-word. The script now voices every sample — English ones included — with
a Russian-native ElevenLabs voice, because Russian-accented English is what the tutor hears all
lesson, and pads 500 ms of leading silence. Neither failure survives.

**Residual, and it is minor:** a lone Russian word inside an English sentence sometimes comes back
transliterated into Latin (`mimolotni`) rather than Cyrillic, inconsistently — `сложный` came back
correctly in the very next sample. The word is preserved either way, so the tutor sees a learner
reaching for a word rather than a hole in the sentence, which is what matters for the prompt. Whether
it is frequent enough to matter is an L4 question, on real recordings, not synthetic ones.

**Keyterms changed nothing.** `STTv2` takes `keyterms`, and the worker knows the lesson's words before
the learner speaks, so `createStt` now accepts them and the check runs a third `multi + keyterms`
variant. Seeding both the English word and its Russian translation did not move either transliteration
case. The plumbing stays because it costs nothing and the English items are the untested half, but
nothing should be built on the assumption that keyterms rescue Cyrillic — re-measure against the L4
corpus in Phase 4 before relying on it.

**Cloud deploy deferred to Phase 4 (2026-09-25).** `lk agent create` fails in this monorepo, and the
fix is bigger than Phase 2 needs. The Dockerfile the CLI generates assumes a standalone Node project,
and three things break here:

1. `COPY package.json pnpm-lock.yaml ./` — the build context is `apps/voice-worker/`, but the lockfile
   is only at the repo root. This is the error the build stops on.
2. `@tutor/shared` is a `workspace:*` dependency and isn't in that context either, so a fixed lockfile
   copy would only move the failure one line down.
3. There is no `build`/`start` script, and `tsc` **cannot** emit: Phase 1 turned on
   `allowImportingTsExtensions` so the source could use explicit `.ts` imports, and TypeScript requires
   `noEmit` alongside it. A container needs a bundler (tsup/esbuild) or `tsx` in production first.

**None of that blocks Phase 2 or Phase 3.** The worker dials *out* to LiveKit Cloud as a registered
worker, so a locally-run `pnpm --filter voice-worker dev` serves a real phone in Phase 3 exactly as a
hosted one would. A hosted agent is first genuinely required by Phase 4's L6 load test, which is where
the Dockerfile and the bundler choice now live. The generated `Dockerfile`/`.dockerignore` were deleted
rather than left half-working; `lk agent dockerfile` regenerates them in one command when Phase 4 wants
a starting point. The stub agent the failed create left behind (`CA_eujeQufSFkHg`, `<Pending>`, no
version) was deleted, so `lk agent list` is empty again.

**To finish Phase 2:**

~~1. Sign up for Deepgram…~~ done 2026-09-25. Every key the worker needs is in
`apps/voice-worker/.env`, including the four `LIVEKIT_*` values (from the `lk` CLI config) and a
minted `LIVEKIT_GRANT_SECRET`. Phase 3 needs those same four in `apps/web/.env`, byte-identical.

~~2. `pnpm --filter voice-worker stt:check`…~~ done 2026-09-25, passed — see above.

**Phase 2 closed 2026-09-25**, with the exit criterion met in substance rather than to the letter. The
voice loop works end to end and the ledger has real per-turn entries. The one walkthrough below did not
cover a learner Russian answer, a pause or "skip this one" — **accepted by decision**, on the grounds
that `stt:check` already answered the Russian question against the STT directly, the pause path is
covered by L2 and by the held-pause cross-product in `pnpm check:shared`, and the remaining value of a
second hand-walkthrough is small next to Phase 3, which exercises all of it on a real device anyway.
**The tutor's conversational behaviour is taken as working as intended** — the over-talking noted below
is a turn-plan question for L4, not a defect. Whatever is still wrong will show up in the L5 matrix or
in L4's corpus, both of which measure it better than a laptop mic does.
2. ~~File a debug report on each of the three shipped providers~~ — **moved to Phase 3 (2026-09-25, by
   decision).** `turn.gap` is a phone-side probe, so it gets checked on the real device alongside the
   Phase 3 L5 device matrix rather than in a separate pass now. The code ships either way, so the
   ElevenLabs/OpenAI/Vapi baseline starts accumulating from the next build regardless — checking it
   twice would only have confirmed the same emitter.

### First console walkthrough — 2026-09-25, partial

102 seconds, 5 turns, `words-4.0` on Sonnet 5, items *ubiquitous* and *mitigate*. Ledger:
`.local/ledger/7048f14f-….jsonl`, audio under `console-recordings/`.

**The loop works.** Mic → Flux → Claude → Flash → speaker, with real numbers per turn:

| | turn 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| TTS TTFB | 175 ms | 160 | 143 | 166 | 149 |
| LLM TTFT | 1271 ms | 1300 | 1056 | 1052 | 1071 |
| end-of-turn delay | — | 1388 ms | — | 801 | 3999 |
| e2e | — | 2763 ms | 2830 | 2522 | 4152 |
| cache read / write | 0 / 4023 | 4023 / 1859 | 5883 / 4 | 5882 / 230 | 6112 / 149 |

**The cache breakpoint follows the history exactly as Phase 1 designed it**, now over a voice session:
4023 written on the kickoff, then read back on every subsequent turn with only a small delta written.

**Where the latency actually goes.** TTS is not the problem — 143-175 ms to first byte. Claude is
~1.1 s. The variable is the turn detector: `patient` waited 3999 ms before deciding turn 5 had ended.
Phase 4's gate is p50 ≤ 1.5 s / p95 ≤ 2.5 s, and these runs sit at 2.5-4.2 s, so **the gate will be
decided by turn-plan tuning (L4), not by the model or the vendors.** That is the single most useful
thing this walkthrough measured, and it was invisible in Phase 1's text-only run.

**Not yet covered, which is why Phase 2 stays open:** no Cyrillic appears in any `userText`, so the
learner never answered in Russian; there was no mid-sentence pause and no "skip this one". The
scenario was mostly meta-commands ("Stop", "Which words do we have?", "We finished").

**Two things to look at, neither yet diagnosed:**

- **A tutor reply with no learner turn.** Record `seq: 2` has an empty `userText`, 10 ms after `seq: 1`,
  and the tutor said "could you say that once more?". An empty final transcript became a user turn and
  drew a real reply. Whether that is a bug or the correct answer to an unintelligible utterance is a
  judgement call — Flux returning empty *because the speech was unintelligible* makes "say that again"
  exactly right. Decide it against the L4 corpus, not against one sample.
- **The tutor over-talks and gets cut off.** Turn 1 generated 1790 output tokens, and 3 of 5 turns
  ended `interrupted: true`. Whether that is the prompt's opening monologue or a `patient` plan that
  lets the learner talk over it is the same L4 question.

---

## Phase 3 — Phone (day 3–5)

**Goal:** the same loop, over the real transport, with pause/resume and persistence — the parts that
only show up once a real device and a real backend are in the loop.

- [x] Build the token route `apps/web/src/app/api/v2/words-agent/livekit-token/route.ts` (research doc
      §1, §6): resolve version + items, build `instructions`, mint the room token with `roomConfig`
      dispatch, sign the per-lesson HMAC grant (`{conversationId, ownerId, exp}` — **plus `lessonId`,
      see below**), and put `{conversationId, version, instructions, turnPlan, llm, voice, grant}`
      into dispatch metadata (512 KiB limit).
- [x] Build the session-end route `apps/web/src/app/api/v2/livekit/session-end/route.ts` (research doc
      §5.2, §6): verify the grant, run `sanitizeTranscript` → upsert `lesson_sessions`, store the ledger
      (partial batches during the lesson, the full ledger at the end), build the LangSmith run tree in
      `after()` with one child run per turn.
- [x] Build the mobile adapter `apps/mobile/src/lib/transport/livekit.ts` (research doc §2 Q6's full
      contract table):
  - `connected` only once the agent participant has joined / a `tutor.ready` RPC lands — every other
    provider raced here first, don't repeat it
  - `say(text)` → RPC `tutor.say` → `session.generateReply({userInput})`, `opensUnprompted: false`
  - `context(text)` → **text stream** `tutor.context`, never RPC (the 15 KiB cap plus Cyrillic resume
    context makes RPC unsafe here — research doc §2 Q6)
  - `cancelTurn()` → RPC → `session.interrupt()`
  - `setMicMuted` / `setOutputSilenced` on both the local track and the worker's session I/O
  - `lk.transcription` text streams → `onTurn`, synced to playback
  - agent-left without `tutor.ending` → `onEnd("error")`
- [x] Wire pause/resume through the existing `pause.ts` logic against the new capability set:
      `{silenceOutput: true, userActivity: false, cancelTurn: true, responseCorrection: false,
      opensUnprompted: false}` (research doc §2 Q6) — **no new code was needed.** `check.ts:699-712`
      already instantiates the fake transport with `LIVEKIT_CAPABILITIES` and asserts the two branches
      that set reaches (`bargeIn: "cancel"`, `heartbeat: false`), on top of the full cross-product.
- [x] Update `audio-session.ts` call sites for the new adapter: `ensureStarted()` at connect,
      `applyVoiceLessonCategory()` on `TrackSubscribed`, matching `openai.ts:622-629` — and confirm
      `audio-session.ts` stays the single owner even though a LiveKit `Room` now exists (research doc
      §2 Q7). **Confirmed and acted on:** LiveKit's own `useIOSAudioManagement` would configure
      AVAudioSession for the `Room`, which is precisely the second owner that module exists to
      prevent, so the adapter calls the module instead — before the room, after the local track, and
      again on every subscribed remote track.
- [x] Add the new debug codes to `packages/shared/src/debug/codes.ts` (research doc §5.3):
      `transport.agent_joined`, `transport.agent_left`, `transport.rpc_failed`, `transport.stream_sent`.
- [x] **Not in the original plan, and Phase 3 does not work without it: the worker's half of the wire.**
      RPC handlers for `tutor.say`/`tutor.cancel`, the `tutor.context` text-stream handler,
      `tutor.ready`/`tutor.ending`, batched ledger + transcript posts to the session-end route, and
      `add_words_to_collection` as a worker-local tool. The plan listed only the phone's half, as
      though the worker already spoke this protocol; it did not.
- [x] **A lesson connects and speaks on a real device — 2026-09-25, iPhone, preview build.** The first
      attempt failed and the report (`27c60661`) is worth keeping, because the failure was not in the
      code: the token minted, the phone joined the room, and no `transport.agent_joined` ever
      arrived, so the 15 s ready timeout fired with "The tutor never joined the lesson". **There was
      no worker running.** Until Phase 4 deploys one, the worker exists only while
      `pnpm --filter voice-worker dev` is up on a laptop, and every device test needs it running.
      Confirmed by dispatching a job straight to the worker with
      `lk dispatch create --agent-name tutor`, which it accepted immediately — proof that
      registration, the agent name and the job entrypoint were all fine.

      **The write-back works end to end** (`a676a70d…`): 138 s, 15 transcript lines in
      `lesson_sessions`, 8 rows in `livekit_turn_ledger`. That one lesson exercises the grant, both
      new routes and migration 0020 at once.

      **First real-device numbers**, and they say the same thing the laptop did: TTS answered in
      **187 ms** on average, while **e2e averaged 3109 ms**. Cache reads were **28,735 tokens against
      700 written** — the Phase 1 breakpoint design holds over a live phone lesson. The latency gate
      is p50 ≤ 1.5 s, so it will be won or lost in L4's turn-plan tuning, not on the vendors.
- [~] **Deferred 2026-09-25 to one end-to-end pass once the whole feature is built.** Run the L5
      device-matrix rows (research doc §4 L5): 20 minutes screen-locked, AirPods connect/disconnect
      mid-turn, incoming call then Siri, Wi-Fi → LTE handover, pause 5 min → resume (tutor speaking
      and not speaking), speakerphone in quiet and noisy rooms, an ElevenLabs lesson then a LiveKit
      lesson in the same process and the reverse (guards the global `stopAudioSession`), and killing
      the worker mid-turn to confirm the "dropped" card + resume path (research doc §3.7).

      **What the deferral costs, so it is a decision and not an oversight.** None of the five
      go/no-go gates is an L5 row, so this does not block the Phase 4 measurements or the call at the
      end of them — that is why it can move. But three things stay unknown until it runs, and each
      would invalidate a Phase 4 number rather than merely add a bug:

      - **20 minutes screen-locked is the reason this app is native at all** (`CLAUDE.md`: iOS
        revokes the microphone and drops the socket when Safari backgrounds). If LiveKit cannot hold
        a locked-screen session, the provider fails on the one axis the whole project exists to
        satisfy, and a latency gate measured in the foreground would be measuring the wrong thing.
      - **The worker-crash path has never executed.** `tutor.ending`'s absence turning into
        `onEnd("error")` and a resumable "dropped" card is written and typechecked, not observed.
      - **Provider-switching in one process guards the global `stopAudioSession`**, whose failure
        mode is silence rather than an error — the kind of bug that surfaces as a confusing L8
        quality score instead of as a crash.

**Exit criterion (amended 2026-09-25):** a full lesson runs end-to-end on a phone dev build with the
transcript and ledger landing in Supabase — **met**. The L5 matrix moves to a single end-to-end pass
after the feature is complete; a Phase 4 number that looks wrong should be re-read with the three
unknowns above in mind before it is believed.

### Phase 3 code — done 2026-09-25, device testing outstanding

Everything above except the L5 matrix is written, typechecks across all four packages, and passes
`pnpm check:shared` (17) and `pnpm --filter voice-worker check` (38). **The first phone lesson has passed** (see above); the L5 matrix remains unexecuted. Five things the code pass settled that the plan had not:

1. **Every real lesson would have started twice.** The worker sent its own kickoff — correct in
   Phase 2, where no phone existed — while the adapter's `opensUnprompted: false` makes the phone's
   session send one the instant it sees `connected`. Two opening monologues over each other. The
   worker now opens a lesson only when nothing else will, decided from the job's own metadata rather
   than from who is in the room: participants arrive on their own schedule, and "is anyone here yet"
   is a race where this is a fact.
2. **The grant carries `lessonId`.** It has to: dispatch metadata carries a lesson's content but
   never its id, and `lesson_sessions.lesson_id` is NOT NULL. Which surfaced a hole — **this provider
   would otherwise have lost the ownership check entirely.** On the others the phone reports the
   transcript and `persistTutorSessionFor` calls `getLesson(ownerId, lessonId)`; here the worker
   writes, holding a grant and no session. The token route now resolves the lesson before signing it.
3. **The ledger is a row per turn** (`0020_livekit_turn_ledger.sql`), not the single jsonb document
   §5.2 imagined. Partial batches make a lone document a read-modify-write, where two in flight erase
   each other; keyed `(conversation_id, seq)` the write is an idempotent upsert.
4. **The agent is recognised by `ParticipantKind.AGENT`, never by `LIVEKIT_AGENT_NAME`.** That
   constant is what the token route dispatches by; the identity a worker actually gets in the room is
   assigned by LiveKit, so matching on the name would have quietly never fired.
5. **`traceLiveKitLesson` is a sibling of `traceClientLesson`, not a flag on it**, and carries no
   `estimateCostUsd`: where exact per-turn tokens and cache splits exist, an estimate the pricing note
   found overstates by 60-170% would be a worse number wearing the same name.

**Before the first device run:** `API_BASE_URL` must be set in `apps/voice-worker/.env` (done
2026-09-25) or the worker writes nothing back — no transcript, no ledger, no saved words, and no tool
offered to the tutor. Migration `0020` must be applied (done 2026-09-25). **And a worker must be
running** — see the first device run below; that one cost a test cycle.

---

## Phase 4 — Measure (day 5–7)

**Goal:** replace every estimate in the research doc with a real number, and make the go/no-go call.

### Readiness, checked 2026-09-25 before starting

Phase 4 is **partly** startable. Three of its eight tasks can begin today; the rest are each waiting
on something specific, and two of those are not engineering problems.

| Task | Ready? | Waiting on |
|---|---|---|
| Replay client (scripted WAV participant) | ✅ **built 2026-09-25** | a corpus to feed it |
| `lk agent simulate audio` (noise, bad mic, packet loss) | ✅ now | — |
| Deploy the worker to LiveKit Cloud | ✅ deployed | Deployed as `CA_snjh6ZRrzUh7` in `eu-central`; see completion checklist |
| L4 corpus of 30–50 real utterances | ❌ | Current learner recording their own clips; recording deferred to the later human pass. Revisit consent for any second learner. |
| Score turn plans against the corpus | ❌ | the corpus above |
| L6 load test (40 rooms × 20 min) | ❌ | CLI disconnect panic, hosted concurrency quota ≥40; and **open question 3** — the Anthropic tier was deliberately skipped, so a 429 here is that decision coming due, not a LiveKit finding |
| L7 cost | ⚠️ | the deploy for realistic infra; the ledger already carries exact per-turn tokens, so the arithmetic is ready |
| L8 blind quality comparison | ❌ | **a human listener.** Same learner, same items, `words-1.x` against `words-4.0`, blind-rated. No script produces this. |

### Phase 4 development work — done 2026-09-25

Everything in Phase 4 that is *code* is written, including the cost report added 2026-09-25. What remains is running
things, which needs a corpus, a person, or a provisioned agent.

| Built | Where |
|---|---|
| The deployable image | `Dockerfile` (repo root), `.dockerignore`, and a `start` script |
| L7 cost report | `apps/web/scripts/livekit-cost.ts` — `pnpm --filter web livekit:cost` |
| L4's replay harness | `apps/voice-worker/src/replay.ts` — `pnpm --filter voice-worker replay` |
| The operator's LiveKit link | `providerConsoleUrl`, gated on an optional `LIVEKIT_PROJECT_ID` |

**The replay harness** dispatches the tutor itself, joins the room as the learner, plays a corpus of
WAV clips in real time, and scores each clip against the moment its audio ended: false cutoffs,
missed ends, self-interruptions, and reply p50/p95. It reads the agent's own `lk.agent.state` rather
than watching an audio track, so "the tutor started speaking" is the tutor's opinion rather than an
inference drawn from audio. Corpus lives in `.local/corpus/`, gitignored — it is a recording of
someone's voice.

**The operator link is not a deep link and does not pretend to be.** A LiveKit session is not
addressable by `conversationId`: the room is `lesson-<conversationId>`, but the dashboard keys its
session pages on its own id, which nothing on our side ever sees. So it links the project and names
the room to search for, and returns nothing at all when `LIVEKIT_PROJECT_ID` is unset.

### The Docker image: three problems, and why the build moved to LiveKit

The first image built and ran (it reached `MissingCredentialsError`, which is the correct fail-closed
path, proving `tsx` runs the TypeScript inside the container). It was also 2.35 GB and unusable in
production, for three separate reasons:

1. **`--filter voice-worker...` does not stop pnpm installing the rest of the workspace** under
   `nodeLinker: hoisted`. The image carried **793 MB of Expo and 445 MB of Next.js** wrapped around a
   worker whose own dependencies are 264 MB. They are present only so `--frozen-lockfile` can
   validate the lockfile against the whole workspace, so the build now deletes them the moment it
   has. That fixes the *image*; the install still resolves them, and the build log shows it fetching
   `@next/swc-*` and every platform variant — darwin, win32, arm64-musl — which is why the build is
   slow rather than merely large.
2. **On Apple Silicon the image is arm64.** Docker defaults to the host platform, and every native
   dependency here — `rtc-ffi-bindings`, `local-inference`, `av` — resolved to its arm64 build. That
   image runs perfectly on the laptop and **cannot run on LiveKit Cloud**. `--platform linux/amd64`
   fixes it and makes the entire install run under emulation, which is slower than the thing it is
   fixing.
3. **So the build moved off this machine.** `lk agent create [working-dir]` uploads the directory as
   a *remote* build context and builds on LiveKit's own x86 infrastructure. That gets the right
   architecture by construction and needs no local image at all. Its one requirement is that the
   Dockerfile sits at the root of the context it is given — and the context must be the workspace,
   since the lockfile and `@tutor/shared` both live above `apps/voice-worker/`. **Hence `Dockerfile`
   and `.dockerignore` at the repo root**, a deviation from §10.2's assumption that `livekit.toml`
   and friends live in the app directory. The app directory cannot be the context, so they cannot.

**Original deployment note (completed 2026-09-25; see completion checklist for failures/fixes):** `lk agent create .` from
the repo root, then `lk agent update-secrets` for the Anthropic, Deepgram, ElevenLabs and grant
secrets. That last step sends real credentials to LiveKit Cloud, which is why it has not been run.

**So the honest order is: deploy → simulate → replay client → L6 → L7, with L4 and L8 waiting for the learner’s recordings and blind ratings respectively.** Starting with the deploy is not enthusiasm for
infrastructure: L6 and L7 both need a worker that is not a laptop, and the deploy carries the three
unfinished pieces named in the Phase 2 note (a bundler, since `tsc` cannot emit under
`allowImportingTsExtensions`; a root-context Dockerfile; secrets via `lk agent update-secrets`).

**One number is already in from Phase 3 and it aims the whole phase:** on a real device, TTS answered
in 187 ms while e2e averaged 3109 ms against a gate of p50 ≤ 1.5 s. The latency gate is a turn-taking
problem, not a vendor problem, so L4's tuning is where it is won — which makes recording the corpus a prerequisite for useful tuning.

- [ ] Record the L4 replay corpus (research doc §4 L4): 30–50 real learner utterances with consent —
      mid-sentence word-search pauses (1–3 s), "ehm" fillers, Russian inserts, one-word answers,
      backchannels while the tutor talks.
- [x] Build the small Node client that replays the corpus into a room as a scripted WAV participant.
- [ ] Score each turn plan against the corpus: false cutoffs, missed ends, self-interruptions; tune the
      Phase 2 turn-taking presets against what the corpus actually shows, not the starting estimates.
- [x] Run `lk agent simulate audio` with `--background-noise`, `--low-quality-microphone` and
      `--packet-loss` (research doc §4 L4 — beta, runs on LiveKit Cloud).
- [x] **Deploy the worker to LiveKit Cloud — moved here from Phase 2 (2026-09-25), and the L6 load
      test is the first thing that actually needs it.** Three pieces, in order: (a) a production build,
      since `tsc` can't emit under `allowImportingTsExtensions` — bundle with tsup/esbuild, or run
      `tsx` in the container and accept it, then add the `build`/`start` scripts the CLI's `CMD`
      expects; (b) a Dockerfile whose context is the repo root, so the root `pnpm-lock.yaml` and the
      `@tutor/shared` workspace package are both reachable — `lk agent create <working-dir>` takes the
      context as an argument, and `--image`/`--image-tar` accept an image built locally instead;
      (c) the secrets, via `lk agent update-secrets` rather than a committed `.env`.
- [ ] Run the L6 load test: `lk perf agent-load-test --rooms 40 --agent-name tutor
      --echo-speech-delay 10s --duration 20m` against staging; watch CPU/RSS per job over 20 minutes (the
      known agents-js leaks — #2053, #1950, #2046), dispatch → joined time, Anthropic 429/529 rate, and
      STT reconnects (#2469 — Deepgram never reconnecting is the one that goes silent and doesn't page).
- [ ] Run the L7 cost measurement: five scripted 20-minute lessons; compute $/min from the ledger's exact
      per-turn Claude usage plus the LiveKit, STT and TTS invoices; compare against the research doc's
      $0.045–0.08/min model (§9).
- [ ] Run the L8 side-by-side quality check: the same learner and items on `words-1.x` (ElevenLabs) and
      on this LiveKit version, blind-rated on pacing, interruptions, Russian correctness, and whether the
      five threads were covered (research doc §4 L8).
- [ ] Fill in the go/no-go gate table below with the measured numbers.

**Exit criterion:** every gate below has a real measurement, not an estimate, and a go/no-go decision is
written down.

### Go/no-go gates (research doc §7)

| Gate | Pass condition | Measured |
|---|---|---|
| Latency | p50 `e2eLatencyMs` ≤ 1.5 s, p95 ≤ 2.5 s, over the last 5 minutes of a 20-minute lesson | — |
| Turn-taking | ≤ 5% false cutoffs on the L4 corpus under "patient"; zero self-interruptions in the speakerphone rows | — |
| Voice | Flash no worse than `eleven_v3_conversational` in the blind test on Russian inserts | — |
| Reliability | 40-room, 20-minute load test: no job crash, RSS growth < 20%, no stalled turn | Blocked: CLI load runner panic; hosted Build quota 5 < 40. No valid measurement. |
| Cost | measured ≤ $0.08/min, all-in, including observability | — |

**On pass:** move into the *spend-staged* pilot phase from the research doc's §9.5 — Ship plan, Level A
infra, a small real-learner group — not a full rollout. **On fail:** the research doc's §8 names Pipecat
as the fallback if the agents-js reliability bugs in L6 reproduce; otherwise stop and say why here.

---

## What this doc deliberately doesn't cover

- The other three phasing options (spend-staged, risk-category, parallel-seam) — recorded on the
  published research artifact's decision log, not repeated here.
- Anything past the go/no-go gate — the pilot's own tasks belong in a doc written once Phase 4 passes,
  since a pilot's task list depends on what Phase 4 actually measures.
