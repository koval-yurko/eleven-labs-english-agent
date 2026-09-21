/**
 * words-4.0 — the podcast lesson, spoken through our own LiveKit + Claude worker.
 *
 * The same lesson as `words-1.0` / `words-2.0` / `words-3.0`, byte-identical prompt
 * (`./podcast-lesson.ts`), on the fourth service. Comparing this version against the other three is
 * therefore a comparison of pipelines — our own cascaded STT→Claude→TTS worker
 * (`apps/voice-worker/`) versus each vendor's managed one — with the lesson itself held constant,
 * the same reason `words-1.0`/`2.0`/`3.0` share this text.
 *
 * ## Not provisioned, and not offered — on purpose, for now
 *
 * Unlike ElevenLabs and Vapi, LiveKit has no remote agent object `pnpm sync:agents` reconciles: the
 * worker is prompt-agnostic and reads this version's `prompt`/`items` from dispatch metadata at
 * session start (research doc §1), the same shape OpenAI already runs. So this version needs no
 * lockfile entry — `elevenLabsVersions()`/`vapiVersions()` (./index.ts) correctly skip it, being
 * filtered by provider.
 *
 * It is also withheld from the learner picker: `CLIENT_READY` in `apps/web/src/lib/agent-registry.ts`
 * does not list `"livekit"` yet, because there is no `apps/mobile/src/lib/transport/livekit.ts` for a
 * phone to open it with (Phase 3 of docs/2026-09-20-livekit-spike-task-plan.md). Until then this
 * module exists so the worker's own text-only walkthrough (`apps/voice-worker/`, Phase 1) has a real
 * prompt to run against instead of a fixture — see `apps/web/scripts/livekit-dispatch-fixture.ts`.
 *
 * ## Why `llm` is pinned here rather than left to the registry default
 *
 * `DEFAULT_LLM` (./index.ts) is `claude-sonnet-4-6` — what the ElevenLabs/Vapi agents already baked
 * are pinned to, and changing it would re-PATCH every one of them. This worker is a new provider
 * making its own choice (research doc §0's recommendation), so it names its model directly rather
 * than inheriting a default that exists for a different pipeline. `apps/voice-worker/src/claude-llm.ts`
 * defaults to the same string independently, so the two only ever agree by both saying so, not by
 * one silently following the other.
 */
import { PODCAST_LESSON_PROMPT } from "./podcast-lesson";
import type { PromptVersion } from "./types";

const version: PromptVersion = {
  version: "words-4.0",
  provider: "livekit",
  label: "4.0 · LiveKit — podcast lesson (spike)",
  prompt: PODCAST_LESSON_PROMPT,
  llm: "claude-sonnet-5",
  // turnTimeoutSeconds / turnEagerness / ttsModelId / additionalLanguages / maxTokens: all ElevenLabs
  // agent-body fields (types.ts), all ignored for a provider with no baked agent — like words-2.0,
  // not like words-1.0. The LiveKit equivalent (turn-taking presets, research doc §2 Q4) is a Phase 2
  // concern: a typed constant the token route maps `turnPlan` onto, not a field on this module.
};

export default version;
