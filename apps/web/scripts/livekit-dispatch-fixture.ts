// Print dispatch metadata for a LiveKit lesson, shaped exactly like what the real token route will
// build once it exists (research doc §1, task plan Phase 3) — but from here, by hand, so Phase 1's
// worker can be walked through against the REAL `words-4.0` prompt instead of a placeholder.
//
// `apps/voice-worker` never imports `apps/web` (the worker is prompt-agnostic — see words-4.0.ts's
// own docblock), so this is the one place allowed to read the prompt registry and hand the result
// across the process boundary as plain JSON, the same way the future token route will hand it
// across the network boundary as dispatch metadata.
//
// Usage, from apps/web/:
//   pnpm dispatch:fixture > ../voice-worker/.local/dispatch.json
// then run the worker with:
//   DISPATCH_METADATA_FILE=.local/dispatch.json pnpm --filter voice-worker dev
// (or however `lk agent console --text` is told to pass it through — see apps/voice-worker/src/agent.ts).
import { randomUUID } from "node:crypto";
import process from "node:process";

import { findVersion } from "../src/agent/prompts";
import { formatItemsList, type TutorItem } from "@tutor/shared/tutor/session";
import type { LiveKitDispatchMetadata } from "@tutor/shared/tutor/livekit-wire";

const VERSION = process.argv[2] ?? "words-4.0";

const SAMPLE_ITEMS: TutorItem[] = [
  {
    text: "ubiquitous",
    details: {
      pos: "adjective",
      translations_ru: ["вездесущий", "повсеместный"],
      forms: [{ text: "ubiquity", pos: "noun", translations_ru: ["вездесущность"] }],
      examples: [{ text: "Smartphones have become ubiquitous in modern life.", form: "base" }],
    },
  },
  {
    text: "mitigate",
    details: {
      pos: "verb",
      translations_ru: ["смягчать", "ослаблять"],
      forms: [{ text: "mitigation", pos: "noun", translations_ru: ["смягчение"] }],
      examples: [{ text: "The new policy aims to mitigate the risk of flooding.", form: "base" }],
    },
  },
];

const version = findVersion(VERSION);
if (!version) {
  console.error(`livekit-dispatch-fixture: no prompt version named "${VERSION}" in the registry.`);
  process.exit(1);
}

const instructions = version.prompt.replaceAll("{{items_list}}", formatItemsList(SAMPLE_ITEMS));

const metadata: LiveKitDispatchMetadata = {
  conversationId: randomUUID(),
  version: version.version,
  instructions,
  llm: version.llm,
};

process.stdout.write(JSON.stringify(metadata, null, 2) + "\n");
