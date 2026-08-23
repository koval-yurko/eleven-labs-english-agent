/**
 * words-3.0 — the podcast lesson, orchestrated by Vapi.
 *
 * The third twin. `words-1.0` runs `./podcast-lesson.ts` on ElevenLabs, `words-2.0` runs the same
 * text on OpenAI Realtime, and this runs it on Vapi — byte-identical prompt, third service. The
 * design rule from 2.0 holds and is the only reason the comparison means anything: the TEXT is held
 * constant, so what a version choice changes is the service carrying it.
 *
 * ## What this version is FOR
 *
 * An earlier draft of this file claimed Vapi reaches a cell the others cannot — *Claude's teaching in
 * ElevenLabs' voice*. **That was wrong, and it is worth recording why.** An ElevenLabs agent already
 * chooses its own LLM (`agentBody` sends `prompt.llm`), and `DEFAULT_LLM` is `claude-sonnet-4-6` —
 * so words-1.0 IS Claude speaking in the ElevenLabs voice. There was no gap there to fill.
 *
 * What Vapi actually offers is a different **orchestration layer**, and that is a narrower but real
 * question:
 *
 *   - **Turn-taking is Vapi's own.** `startSpeakingPlan` / `stopSpeakingPlan` — including smart
 *     endpointing and an interruption model tuned by word count rather than raw voice activity — are
 *     a genuinely different mechanism from ElevenLabs' single `turn_eagerness`. For a learner
 *     composing English aloud, whether the tutor waits or barges in IS the lesson's felt quality, and
 *     it is the most likely place a third service beats the two we run.
 *   - **`end-of-call-report`** hands back `endedReason`, the transcript and a cost breakdown in one
 *     webhook — restoring what §11.5 of the OpenAI note listed as a loss when that provider arrived.
 *   - **Vendor independence later.** Transcriber, model and voice are separate fields, so swapping
 *     any of them is a config change rather than a new adapter.
 *
 * So the thing to judge this version on is not its voice but its CONVERSATION: does it interrupt
 * better, wait better, recover better? That is §11 Q1 of
 * docs/2026-08-27-vapi-third-voice-provider.md, and the price is $0.05/min on top of a model we
 * already pay for directly.
 *
 * ## Two things vary against words-1.0, not one
 *
 * The orchestrator AND the voice. We are deliberately not giving Vapi our ElevenLabs key
 * (2026-08-28), so Vapi speaks in its own default voice — see ../vapi-assistant.ts for why paying
 * twice for the same voice was the worse trade. words-2.0 already lives with the same compromise on
 * OpenAI. The prompt is what stays constant across all three, and it is the variable that would
 * actually invalidate a comparison.
 *
 * ## Why it is not in the picker yet
 *
 * It has an assistant — `pnpm sync:agents` provisions it like any ElevenLabs version and records the
 * id in agents.lock.json — but no MOBILE ADAPTER. `activeVersions()` (../../lib/agent-registry.ts)
 * therefore withholds it, so it cannot reach a learner's picker or a token route until
 * `apps/mobile/src/lib/transport/vapi.ts` is real. Provisioned and un-offerable is a deliberate
 * state, not a half-finished one: it lets the assistant exist, be reviewed and be corrected before
 * anyone writes a client for it.
 *
 * Note that "evaluate it in Vapi's dashboard" is NOT straightforwardly available: Vapi has no
 * equivalent of ElevenLabs' `dynamic_variable_placeholders`, so a test call from their console sees
 * the literal `{{items_list}}` rather than a word list. Judging this version on a real lesson means
 * driving it from a client that can send `assistantOverrides.variableValues`.
 *
 * ## Which fields apply here
 *
 * Vapi is the FIRST provider that is neither "a remote agent object we bake" (ElevenLabs) nor "no
 * remote object at all" (OpenAI) — it is a remote object whose vocabulary differs field by field.
 * See `vapiAssistantBody` in ../vapi-assistant.ts for the mapping and ./types.ts for the rules.
 * The three that bite:
 *
 *   - **`turnTimeoutSeconds` has no equivalent and is IGNORED.** Vapi's only silence timer ends the
 *     call; it has nothing that re-engages a quiet learner. That is why this version omits it while
 *     its two twins pin 3 s, and it is a real gap rather than a tuning difference: podcast pacing on
 *     Vapi has to come from a client-side timer driving `vapi.say()`, which is stage-3 work.
 *   - **`silenceEndCallTimeoutSeconds: -1`** still means "never hang up on a deliberate silence",
 *     but Vapi has no -1 — the mapper converts it to that platform's maximum. Same intent, and the
 *     held pause depends on it.
 *   - **`voiceId` and `ttsModelId` are IGNORED**, as they are on an OpenAI version. Vapi uses its own
 *     default voice; see the note above.
 */
import { PODCAST_LESSON_PROMPT } from "./podcast-lesson";
import type { PromptVersion } from "./types";

const version: PromptVersion = {
  version: "words-3.0",
  provider: "vapi",
  // Same lesson as 1.0 and 2.0, so — as there — the service is the label.
  label: "3.0 · Vapi — podcast lesson",
  prompt: PODCAST_LESSON_PROMPT,
  /**
   * The same brain words-1.0 runs, pinned rather than inherited.
   *
   * `DEFAULT_LLM` supplies this exact value today, so this line changes nothing right now — it
   * exists so that a future edit to that constant cannot silently move this version's model out from
   * under the comparison. Holding the model equal to words-1.0's is what makes the difference
   * between them readable as *orchestration and voice*, rather than as three things at once.
   *
   * Drop this line if you want to hear Vapi's own default model too; that is a different and
   * broader question than the one this version was added to ask.
   *
   * `vapiModelRef` in ../vapi-assistant.ts maps the `claude-` prefix to Vapi's `anthropic` provider.
   */
  llm: "claude-sonnet-4-6",
  /**
   * Patience, in Vapi's vocabulary rather than ElevenLabs'.
   *
   * It becomes a `startSpeakingPlan.waitSeconds` plus a `stopSpeakingPlan` that requires several
   * words before treating the learner as interrupting — the same question `words-1.5` answered on
   * ElevenLabs, asked of a platform with two knobs instead of one. The learner is composing English
   * aloud and a half-second gap mid-sentence is normal for them.
   *
   * Without `turnTimeoutSeconds` beside it this is doing less work than on the twins: it governs how
   * readily the tutor takes the floor, not whether it takes it back after silence. See the note
   * above.
   */
  turnEagerness: "patient",
  /**
   * Never hang up on a silence the learner chose. Mapped to Vapi's maximum rather than sent as -1.
   * `maxDurationSeconds` (inherited: 30 min) stays the backstop and the cost limit.
   */
  silenceEndCallTimeoutSeconds: -1,
};

export default version;
