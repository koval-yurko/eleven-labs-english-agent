/**
 * `pnpm eval:generation` — the generation-quality gate (T051, Constitution III).
 *
 * Runs the eval dataset through the real generation pipeline and scores every case on
 * coverage, two-voice, story-not-definition, and length. Exits non-zero if any gating
 * scorer fails. With ANTHROPIC + ELEVENLABS keys it evaluates LIVE output and gates on all
 * four scorers; without keys it runs the deterministic mocks (length is reported but not
 * gated). With LANGSMITH_API_KEY it also uploads each run + scores to LangSmith.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import {
  loadGeneratorConfig,
  ClaudeLlmAdapter,
  ElevenLabsTtsAdapter,
  MockLlmAdapter,
  MockTtsAdapter,
} from "../index";
import { EVAL_DATASET } from "./dataset";
import { evaluateSuite, ALL_GATING, MOCK_GATING } from "./harness";
import { uploadEvalRun, isLangSmithEnabled, langSmithProject } from "./langsmith";

// Load env BEFORE reading any provider keys (modules above don't read env at import time).
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
for (const f of [".env", ".env.local", "apps/web/.env.local"]) {
  dotenv.config({ path: join(root, f) });
}

const env = process.env;
const live = Boolean(env.ANTHROPIC_API_KEY && env.ELEVENLABS_API_KEY);

const config = loadGeneratorConfig({
  // Provide harmless defaults for voice IDs so mock runs don't fail config validation.
  ELEVENLABS_TEACHER_VOICE_ID: env.ELEVENLABS_TEACHER_VOICE_ID ?? "mock-teacher-voice",
  ELEVENLABS_LEARNER_VOICE_ID: env.ELEVENLABS_LEARNER_VOICE_ID ?? "mock-learner-voice",
  ...env,
});

const deps = live
  ? {
      llm: new ClaudeLlmAdapter(env.ANTHROPIC_API_KEY!, config.modelId),
      tts: new ElevenLabsTtsAdapter(env.ELEVENLABS_API_KEY!, {
        modelId: config.ttsModelId,
        bitrate: config.ttsBitrate,
        teacherVoiceId: config.teacherVoiceId,
        learnerVoiceId: config.learnerVoiceId,
        batchConcurrency: config.ttsBatchConcurrency,
      }),
      config,
    }
  : { llm: new MockLlmAdapter(), tts: new MockTtsAdapter(config.wordsPerMinute), config };

console.log(`▶ generation eval — mode: ${live ? "LIVE (Claude + ElevenLabs)" : "MOCK"}`);
console.log(`  cases: ${EVAL_DATASET.length}  |  model: ${config.modelId}`);
if (!live) console.log("  (no provider keys — length scorer is reported but not gated)\n");
else console.log("");

const evaluations = await evaluateSuite(EVAL_DATASET, deps, {
  lengthWindow: { minSeconds: config.targetMinSeconds, maxSeconds: config.targetMaxSeconds },
  gatingKeys: live ? ALL_GATING : MOCK_GATING,
});

let failed = 0;
for (const ev of evaluations) {
  const mark = ev.pass ? "✅" : "❌";
  console.log(`${mark} ${ev.case.id} — ${ev.case.description}`);
  if (ev.error) console.log(`     error: ${ev.error}`);
  for (const s of ev.scores) {
    const sm = s.pass ? "·" : "✗";
    console.log(`     ${sm} ${s.key.padEnd(20)} ${(s.score * 100).toFixed(0).padStart(3)}%  ${s.detail}`);
  }
  if (!ev.pass) failed += 1;
}

if (isLangSmithEnabled(env)) {
  const res = await uploadEvalRun(evaluations, env);
  if (res) console.log(`\n↥ uploaded ${res.uploaded} run(s) to LangSmith project "${res.project}"`);
  else console.log(`\n(LangSmith key set but upload unavailable — install the \`langsmith\` package)`);
} else {
  console.log(`\n(LangSmith disabled — set LANGSMITH_API_KEY to upload to "${langSmithProject(env)}")`);
}

console.log(`\n${failed === 0 ? "✅ PASS" : `❌ FAIL — ${failed}/${evaluations.length} case(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
