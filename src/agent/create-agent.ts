// Provision the "English words tutor" ElevenLabs Conversational AI agent.
//
// A deliberately MINIMAL agent (see docs/2026-06-26-minimal-english-words-voice-agent.md):
//   - the PINNED teacher voice (voice consistency),
//   - a native Claude LLM (Sonnet 4.6 by default — explanation depth over latency),
//   - the VERSIONED teacher system prompt from ./agent-prompt.ts
//     (prompts live in source control, never as untracked strings),
//   - NO client tools (the tutor just talks; nothing in the browser to call back),
//   - a SINGLE dynamic-variable placeholder ({{items_list}}) filled per session from the
//     UI textbox at startSession.
//
// Prints the agent_id to put in ELEVENLABS_STORY_AGENT_ID.
//
// Idempotency: this CREATES a new agent each run. Run it once, save the id, and don't re-run
// unless you intend to provision a fresh agent.
//
//   pnpm provision:agent                                  # create from your .env keys
//   LIVE_STORY_LLM=claude-haiku-4-5 pnpm provision:agent  # cheaper/faster LLM
//   LIVE_STORY_TTS_MODEL=eleven_turbo_v2 pnpm provision:agent  # override the TTS model
//
// Reads ELEVENLABS_API_KEY + ELEVENLABS_TEACHER_VOICE_ID (and optional LIVE_STORY_LLM,
// LIVE_STORY_TTS_MODEL) from .env / .env.local — the api key never leaves your machine.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import {
  WORDS_TUTOR_SYSTEM_PROMPT,
  WORDS_TUTOR_PROMPT_VERSION,
} from "./agent-prompt";

// src/agent/ → src → repo root.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
for (const f of [".env", ".env.local"]) {
  dotenv.config({ path: join(root, f) });
}

const env = process.env;
const apiKey = env.ELEVENLABS_API_KEY?.trim();
const voiceId = env.ELEVENLABS_TEACHER_VOICE_ID?.trim();
// Real-time conversational TTS model. English agents require an English v2 model — Flash v2
// (`eleven_flash_v2`) or Turbo v2 (`eleven_turbo_v2`); multilingual v2.5 / Eleven v3 are
// rejected/gated. Flash v2 is the low-latency default.
const ttsModelId = env.LIVE_STORY_TTS_MODEL?.trim() || "eleven_flash_v2";
// Sonnet by default: this tutor explains meaning/forms/usage per item, where depth matters
// more than the ~100ms latency edge.
const llm = env.LIVE_STORY_LLM?.trim() || "claude-sonnet-4-6";

if (!apiKey) {
  console.error("✗ Missing ELEVENLABS_API_KEY in .env / .env.local");
  process.exit(1);
}
if (!voiceId) {
  console.error("✗ Missing ELEVENLABS_TEACHER_VOICE_ID — the tutor needs a pinned teacher voice.");
  process.exit(1);
}

// Per-session grounding is injected at runtime via the items_list dynamic variable; this is
// just the placeholder default the agent validates its prompt against. The key must match the
// {{items_list}} placeholder in agent-prompt.ts.
const body = {
  name: `english-words-tutor (${WORDS_TUTOR_PROMPT_VERSION})`,
  conversation_config: {
    agent: {
      prompt: { prompt: WORDS_TUTOR_SYSTEM_PROMPT, llm },
      first_message: "", // teaching begins on the kickoff contextual update, not a greeting
      language: "en",
      dynamic_variables: {
        dynamic_variable_placeholders: {
          // items may be single words OR phrases/sentences
          items_list: "1. ephemeral; 2. break the ice; 3. I couldn't agree more",
        },
      },
    },
    tts: { model_id: ttsModelId, voice_id: voiceId },
  },
};

console.log("▶ creating english-words-tutor agent");
console.log(`  llm:   ${llm}   (override with LIVE_STORY_LLM)`);
console.log(`  voice: ${voiceId}   tts model: ${ttsModelId}`);
console.log(`  prompt version: ${WORDS_TUTOR_PROMPT_VERSION}`);

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
        "    LIVE_STORY_TTS_MODEL=eleven_flash_v2 pnpm provision:agent\n" +
        "    LIVE_STORY_TTS_MODEL=eleven_turbo_v2 pnpm provision:agent",
    );
  } else if (lower.includes("llm")) {
    console.error(
      `\n  Hint: the LLM id "${llm}" may not be valid for your account. Open the agent\n` +
        "  dashboard, pick the Claude model from the LLM dropdown to see its exact id,\n" +
        "  then re-run with LIVE_STORY_LLM=<that-id>.",
    );
  }
  process.exit(1);
}

const data = JSON.parse(text) as { agent_id?: string };
if (!data.agent_id) {
  console.error(`\n✗ unexpected response (no agent_id):\n  ${text}`);
  process.exit(1);
}

console.log(`\n✅ created english-words-tutor agent: ${data.agent_id}`);
console.log("\n  Add this to .env (server-only):");
console.log(`\n    ELEVENLABS_STORY_AGENT_ID=${data.agent_id}\n`);
