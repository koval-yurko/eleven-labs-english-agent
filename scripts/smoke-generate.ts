// Live smoke test: runs the REAL Claude adapter against your .env key, generates a one-item
// lesson SCRIPT, and asserts it is valid. Verifies the generation path end-to-end without
// Auth0/Supabase. Generation is script-only (007-live-only) — it writes NO audio file.
// Makes one real (small) Claude call.
//
//   pnpm smoke:generate            # default item: "break the ice"
//   pnpm smoke:generate "piece of cake"   # custom item

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import process from "node:process";
import dotenv from "dotenv";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const f of [".env", ".env.local", "apps/web/.env.local"]) {
  dotenv.config({ path: join(root, f) });
}

const { classifyInput, generateLesson, loadGeneratorConfig, ClaudeLlmAdapter, LessonScript } =
  await import("../packages/generator/src/index.ts");

const env = process.env;
if (!env.ANTHROPIC_API_KEY) {
  console.error("✗ Missing ANTHROPIC_API_KEY in .env");
  process.exit(1);
}

const item = process.argv[2] ?? "break the ice";
const config = loadGeneratorConfig(env);
const { accepted } = classifyInput([item]);

console.log(`▶ generating a lesson script for "${item}"`);
console.log(`  model: ${config.modelId}`);
console.log(`  voices: teacher=${config.teacherVoiceId} learner=${config.learnerVoiceId}`);

const t0 = Date.now();
try {
  const result = await generateLesson(accepted, {
    llm: new ClaudeLlmAdapter(env.ANTHROPIC_API_KEY, config.modelId),
    config,
  });

  // Assert the script is structurally valid against the shared contract.
  LessonScript.parse(result.script);
  if (result.script.coverage.length === 0) {
    throw new Error("script covered no items");
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n✅ success in ${secs}s (script only — no audio written)`);
  console.log(`  segments:   ${result.script.segments.length}`);
  console.log(`  coverage:   ${result.script.coverage.length} item(s)`);
  console.log(`  model:      ${result.metadata.modelId}  |  prompt: ${result.metadata.promptVersion}`);
  console.log(`\n  first teacher line:`);
  const teacher = result.script.segments.find((s) => s.speaker === "teacher");
  if (teacher) console.log(`    "${teacher.text.slice(0, 140)}${teacher.text.length > 140 ? "…" : ""}"`);
} catch (err) {
  console.error(`\n✗ generation failed:`);
  console.error(`  ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
