// Provision the live-tutor ElevenLabs Conversational AI agent (005-live-tutor-qa, T041).
//
// Creates an agent configured to match what the app expects: the PINNED teacher voice
// (Constitution I), a native Claude LLM (Haiku 4.5 by default — latency, research R2), and
// the VERSIONED system prompt from apps/web/lib/live-tutor/agent-prompt.ts (Constitution
// III — no untracked prompts). Prints the agent_id to put in ELEVENLABS_AGENT_ID.
//
// Idempotency: this CREATES a new agent each run. Run it once, save the id, and don't
// re-run unless you intend to provision a fresh agent.
//
//   pnpm provision:agent                 # create the agent from your .env keys
//   LIVE_TUTOR_LLM=claude-sonnet-4-5 pnpm provision:agent          # override the LLM
//   LIVE_TUTOR_TTS_MODEL=eleven_turbo_v2 pnpm provision:agent      # override the TTS model
//
// Reads ELEVENLABS_API_KEY + ELEVENLABS_TEACHER_VOICE_ID (and optional LIVE_TUTOR_LLM,
// LIVE_TUTOR_TTS_MODEL) from .env / .env.local / apps/web/.env.local — the api key never
// leaves your machine.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import process from "node:process";
import dotenv from "dotenv";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const f of [".env", ".env.local", "apps/web/.env.local"]) {
  dotenv.config({ path: join(root, f) });
}

const { LIVE_TUTOR_SYSTEM_PROMPT, LIVE_TUTOR_PROMPT_VERSION } = await import(
  "../apps/web/lib/live-tutor/agent-prompt.ts"
);

const env = process.env;
const apiKey = env.ELEVENLABS_API_KEY?.trim();
const voiceId = env.ELEVENLABS_TEACHER_VOICE_ID?.trim();
// Real-time conversational TTS model. English agents require an English v2 model — Flash
// v2 (`eleven_flash_v2`) or Turbo v2 (`eleven_turbo_v2`); the multilingual v2.5 models and
// Eleven v3 ("expressive") are rejected for an English agent / gated on some plans. Flash
// v2 is the low-latency default (<1.5s budget). The voice id stays the pinned teacher voice
// either way, so voice consistency (Constitution I) holds across both surfaces.
const ttsModelId = env.LIVE_TUTOR_TTS_MODEL?.trim() || "eleven_flash_v2";
const llm = env.LIVE_TUTOR_LLM?.trim() || "claude-haiku-4-5";

if (!apiKey) {
  console.error("✗ Missing ELEVENLABS_API_KEY in .env / .env.local / apps/web/.env.local");
  process.exit(1);
}
if (!voiceId) {
  console.error(
    "✗ Missing ELEVENLABS_TEACHER_VOICE_ID — the live tutor MUST reuse the scripted\n" +
      "  podcast's teacher voice (Constitution I voice consistency).",
  );
  process.exit(1);
}

// Per-session grounding is injected at runtime via dynamic variables; these are just the
// placeholder defaults the agent validates its prompt against (lib/live-tutor/context.ts).
const body = {
  name: `idiomatic-live-tutor (${LIVE_TUTOR_PROMPT_VERSION})`,
  conversation_config: {
    agent: {
      prompt: { prompt: LIVE_TUTOR_SYSTEM_PROMPT, llm },
      first_message: "", // no greeting — the learner speaks first
      language: "en",
      dynamic_variables: {
        dynamic_variable_placeholders: {
          lesson_summary: "A short English lesson taught as a two-voice story.",
          items_list: "1. break the ice",
          current_item: "the lesson introduction",
        },
      },
    },
    tts: { model_id: ttsModelId, voice_id: voiceId },
  },
};

console.log("▶ creating live-tutor agent");
console.log(`  llm:   ${llm}   (override with LIVE_TUTOR_LLM)`);
console.log(`  voice: ${voiceId}   tts model: ${ttsModelId}`);
console.log(`  prompt version: ${LIVE_TUTOR_PROMPT_VERSION}`);

const res = await fetch("https://api.elevenlabs.io/v1/convai/agents/create", {
  method: "POST",
  headers: { "xi-api-key": apiKey, "content-type": "application/json" },
  body: JSON.stringify(body),
});

const text = await res.text();
if (!res.ok) {
  console.error(`\n✗ create failed: HTTP ${res.status}`);
  console.error(`  ${text}`);
  const lower = text.toLowerCase();
  if (
    lower.includes("expressive") ||
    lower.includes("tts") ||
    lower.includes("flash") ||
    lower.includes("turbo") ||
    lower.includes("conversation config")
  ) {
    console.error(
      `\n  Hint: the TTS model "${ttsModelId}" isn't accepted for this agent. English agents\n` +
        "  must use an English v2 model; Eleven v3 / multilingual v2.5 are rejected/gated.\n" +
        "  Re-run with one your account allows, e.g.:\n" +
        "    LIVE_TUTOR_TTS_MODEL=eleven_flash_v2 pnpm provision:agent\n" +
        "    LIVE_TUTOR_TTS_MODEL=eleven_turbo_v2 pnpm provision:agent",
    );
  } else if (lower.includes("llm")) {
    console.error(
      `\n  Hint: the LLM id "${llm}" may not be valid for your account. Open the agent\n` +
        "  dashboard, pick the Claude model from the LLM dropdown to see its exact id,\n" +
        "  then re-run with LIVE_TUTOR_LLM=<that-id>.",
    );
  }
  process.exit(1);
}

const data = JSON.parse(text) as { agent_id?: string };
if (!data.agent_id) {
  console.error(`\n✗ unexpected response (no agent_id):\n  ${text}`);
  process.exit(1);
}

console.log(`\n✅ created agent: ${data.agent_id}`);
console.log("\n  Add this to apps/web/.env.local (server-only):");
console.log(`\n    ELEVENLABS_AGENT_ID=${data.agent_id}\n`);
console.log("  Then: pnpm db:migrate && pnpm --filter @idiomatic/web dev");
console.log("  Open a ready lesson → the “Live tutor” panel appears. (See quickstart.md.)");
