// Provision the adaptive live-STORY ElevenLabs Conversational AI agent (006-adaptive-live-story).
//
// This is the live-narrated story agent — the sole live experience (007-live-only). It creates
// an agent configured to match what the live-story client expects:
//   - the PINNED teacher voice (Constitution I — the single teacher voice),
//   - a native Claude LLM (Haiku 4.5 by default — narration latency),
//   - the VERSIONED narrator/tutor/steering system prompt from
//     apps/web/lib/live-story/agent-prompt.ts (Constitution III — no untracked prompts),
//   - the FOUR client tools the narration loop calls (advanceNarration, markItemTaught,
//     setScenario, concludeLesson), declared inline with expects_response so the agent reads
//     each tool's returned instruction string, and
//   - the five dynamic-variable placeholders the plan grounding fills at startSession.
//
// Prints the agent_id to put in ELEVENLABS_STORY_AGENT_ID.
//
// Idempotency: this CREATES a new agent each run. Run it once, save the id, and don't re-run
// unless you intend to provision a fresh agent.
//
//   pnpm provision:story-agent                                   # create from your .env keys
//   LIVE_STORY_LLM=claude-sonnet-4-6 pnpm provision:story-agent  # override the LLM
//   LIVE_STORY_TTS_MODEL=eleven_turbo_v2 pnpm provision:story-agent  # override the TTS model
//
// Reads ELEVENLABS_API_KEY + ELEVENLABS_TEACHER_VOICE_ID (and optional LIVE_STORY_LLM,
// LIVE_STORY_TTS_MODEL) from .env / .env.local / apps/web/.env.local — the api key never
// leaves your machine.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import process from "node:process";
import dotenv from "dotenv";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const f of [".env", ".env.local", "apps/web/.env.local"]) {
  dotenv.config({ path: join(root, f) });
}

const { LIVE_STORY_SYSTEM_PROMPT, LIVE_STORY_PROMPT_VERSION, LIVE_STORY_CLIENT_TOOL_DESCRIPTIONS } =
  await import("../apps/web/lib/live-story/agent-prompt.ts");

const env = process.env;
const apiKey = env.ELEVENLABS_API_KEY?.trim();
const voiceId = env.ELEVENLABS_TEACHER_VOICE_ID?.trim();
// Real-time conversational TTS model. English agents require an English v2 model — Flash v2
// (`eleven_flash_v2`) or Turbo v2 (`eleven_turbo_v2`); multilingual v2.5 / Eleven v3 are
// rejected/gated. Flash v2 is the low-latency default. The voice id stays the pinned teacher
// voice so voice consistency (Constitution I) holds across the scripted, 005, and 006 surfaces.
const ttsModelId = env.LIVE_STORY_TTS_MODEL?.trim() || "eleven_flash_v2";
const llm = env.LIVE_STORY_LLM?.trim() || "claude-haiku-4-5";

if (!apiKey) {
  console.error("✗ Missing ELEVENLABS_API_KEY in .env / .env.local / apps/web/.env.local");
  process.exit(1);
}
if (!voiceId) {
  console.error(
    "✗ Missing ELEVENLABS_TEACHER_VOICE_ID — the live story MUST reuse the scripted\n" +
      "  podcast's teacher voice (Constitution I voice consistency).",
  );
  process.exit(1);
}

const D = LIVE_STORY_CLIENT_TOOL_DESCRIPTIONS;

// The four client tools the narrator agent calls (contracts/live-story.schema.json →
// ClientToolContract). Each handler runs in the browser (lib/live-story/client-tools.ts) and
// returns a short instruction string — so expects_response is true (the agent waits for it).
const tools = [
  {
    type: "client",
    name: "advanceNarration",
    description: D.advanceNarration,
    parameters: { type: "object", properties: {}, required: [] },
    expects_response: true,
    response_timeout_secs: 10,
  },
  {
    type: "client",
    name: "markItemTaught",
    description: D.markItemTaught,
    parameters: {
      type: "object",
      properties: {
        itemId: { type: "string", description: 'The item\'s text, e.g. "break the ice".' },
      },
      required: ["itemId"],
    },
    expects_response: true,
    response_timeout_secs: 10,
  },
  {
    type: "client",
    name: "setScenario",
    description: D.setScenario,
    parameters: {
      type: "object",
      properties: {
        scenario: { type: "string", description: "The new story setting, in a few words." },
      },
      required: ["scenario"],
    },
    expects_response: true,
    response_timeout_secs: 10,
  },
  {
    type: "client",
    name: "concludeLesson",
    description: D.concludeLesson,
    parameters: { type: "object", properties: {}, required: [] },
    expects_response: true,
    response_timeout_secs: 10,
  },
];

// Per-session grounding is injected at runtime via dynamic variables (lib/live-story/
// plan-context.ts); these are just the placeholder defaults the agent validates its prompt
// against. Keys must match the {{...}} placeholders in agent-prompt.ts.
const body = {
  name: `idiomatic-live-story (${LIVE_STORY_PROMPT_VERSION})`,
  conversation_config: {
    agent: {
      prompt: { prompt: LIVE_STORY_SYSTEM_PROMPT, llm, tools },
      first_message: "", // narration begins on the kickoff contextual update, not a greeting
      language: "en",
      dynamic_variables: {
        dynamic_variable_placeholders: {
          lesson_summary: "A short spoken English lesson told as a story.",
          items_list: "1. break the ice; 2. piece of cake",
          beats_outline: "1. Two strangers meet (teaches: break the ice)",
          target_minutes: "7",
          scenario: "the lesson's original everyday setting",
        },
      },
    },
    tts: { model_id: ttsModelId, voice_id: voiceId },
  },
};

console.log("▶ creating live-story agent");
console.log(`  llm:   ${llm}   (override with LIVE_STORY_LLM)`);
console.log(`  voice: ${voiceId}   tts model: ${ttsModelId}`);
console.log(`  prompt version: ${LIVE_STORY_PROMPT_VERSION}`);
console.log(`  client tools:   ${tools.map((t) => t.name).join(", ")}`);

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
        "    LIVE_STORY_TTS_MODEL=eleven_flash_v2 pnpm provision:story-agent\n" +
        "    LIVE_STORY_TTS_MODEL=eleven_turbo_v2 pnpm provision:story-agent",
    );
  } else if (lower.includes("llm")) {
    console.error(
      `\n  Hint: the LLM id "${llm}" may not be valid for your account. Open the agent\n` +
        "  dashboard, pick the Claude model from the LLM dropdown to see its exact id,\n" +
        "  then re-run with LIVE_STORY_LLM=<that-id>.",
    );
  } else if (lower.includes("tool")) {
    console.error(
      "\n  Hint: the client-tools schema was rejected. Verify your account/API version still\n" +
        "  accepts inline conversation_config.agent.prompt.tools with type:\"client\".",
    );
  }
  process.exit(1);
}

const data = JSON.parse(text) as { agent_id?: string };
if (!data.agent_id) {
  console.error(`\n✗ unexpected response (no agent_id):\n  ${text}`);
  process.exit(1);
}

console.log(`\n✅ created live-story agent: ${data.agent_id}`);
console.log("\n  Add this to apps/web/.env.local (server-only):");
console.log(`\n    ELEVENLABS_STORY_AGENT_ID=${data.agent_id}\n`);
console.log("  Then (Supabase optional — without it the app runs in-memory):");
console.log("    pnpm db:migrate && pnpm --filter @idiomatic/web dev");
console.log("  Open a ready lesson → “Live Story” → Start. (See quickstart.md §5–6.)");
