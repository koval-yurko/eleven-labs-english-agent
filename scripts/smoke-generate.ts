// Live smoke test: runs the REAL Claude + ElevenLabs adapters against your .env keys,
// generates a one-item lesson, and writes the MP3 to disk. Verifies the generation path
// end-to-end without Auth0/Supabase. Makes real (small) API calls.
//
//   pnpm smoke:generate            # default item: "break the ice"
//   pnpm smoke:generate "piece of cake"   # custom item

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import process from "node:process";
import dotenv from "dotenv";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const f of [".env", ".env.local", "apps/web/.env.local"]) {
  dotenv.config({ path: join(root, f) });
}

const {
  classifyInput,
  generateLesson,
  loadGeneratorConfig,
  ClaudeLlmAdapter,
  ElevenLabsTtsAdapter,
} = await import("../packages/generator/src/index.ts");

const env = process.env;
if (!env.ANTHROPIC_API_KEY || !env.ELEVENLABS_API_KEY) {
  console.error("✗ Missing ANTHROPIC_API_KEY and/or ELEVENLABS_API_KEY in .env");
  process.exit(1);
}

const item = process.argv[2] ?? "break the ice";
const config = loadGeneratorConfig(env);
const { accepted } = classifyInput([item]);

console.log(`▶ generating a lesson for "${item}"`);
console.log(`  model: ${config.modelId}  |  tts: ${config.ttsModelId}`);
console.log(`  voices: teacher=${config.teacherVoiceId} learner=${config.learnerVoiceId}`);

const t0 = Date.now();
try {
  const result = await generateLesson(accepted, {
    llm: new ClaudeLlmAdapter(env.ANTHROPIC_API_KEY, config.modelId),
    tts: new ElevenLabsTtsAdapter(env.ELEVENLABS_API_KEY, {
      modelId: config.ttsModelId,
      bitrate: config.ttsBitrate,
      teacherVoiceId: config.teacherVoiceId,
      learnerVoiceId: config.learnerVoiceId,
      batchConcurrency: config.ttsBatchConcurrency,
    }),
    config,
  });

  const out = "/tmp/idiomatic-smoke.mp3";
  writeFileSync(out, result.audio.bytes);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n✅ success in ${secs}s`);
  console.log(`  segments:   ${result.script.segments.length}`);
  console.log(`  coverage:   ${result.script.coverage.length} item(s)`);
  console.log(`  audio:      ${result.audio.durationSeconds}s, ${result.audio.bytes.length} bytes`);
  console.log(`  wrote:      ${out}`);
  console.log(`\n  first teacher line:`);
  const teacher = result.script.segments.find((s) => s.speaker === "teacher");
  if (teacher) console.log(`    "${teacher.text.slice(0, 140)}${teacher.text.length > 140 ? "…" : ""}"`);
} catch (err) {
  console.error(`\n✗ generation failed:`);
  console.error(`  ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
