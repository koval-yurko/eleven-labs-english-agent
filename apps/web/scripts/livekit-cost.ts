// Read-only L7 report. No transcripts or credentials are printed.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { costSummary, type CostEvidence } from "../src/lib/livekit-cost";
import { getServiceSupabase } from "../src/lib/supabase/server";
import type { TurnRecord } from "@tutor/shared/tutor/livekit-wire";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    conversation: { type: "string", multiple: true },
    evidence: { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "pnpm --filter web livekit:cost --owner <sub> --conversation <id> [--conversation <id> ...] --evidence <json>",
  );
  process.exit(0);
}
if (!values.owner || !values.conversation?.length || !values.evidence) {
  throw new Error("Required: --owner, --conversation (repeatable), --evidence. See --help.");
}
for (const file of [".env.local", ".env"]) {
  dotenv.config({ path: fileURLToPath(new URL(`../${file}`, import.meta.url)), quiet: true });
}
const evidence = JSON.parse(readFileSync(values.evidence, "utf8")) as CostEvidence;
const db = getServiceSupabase();
const lessons = [];
for (const conversationId of values.conversation) {
  const { data: session, error } = await db
    .from("lesson_sessions")
    .select("duration_secs")
    .eq("owner_id", values.owner)
    .eq("conversation_id", conversationId)
    .single();
  if (error) throw new Error(`Session ${conversationId}: ${error.message}`);
  const turns: TurnRecord[] = [];
  // Explicit paging avoids Supabase's default 1000-row truncation.
  for (let offset = 0; ; offset += 500) {
    const { data, error: ledgerError } = await db
      .from("livekit_turn_ledger")
      .select("record")
      .eq("owner_id", values.owner)
      .eq("conversation_id", conversationId)
      .order("seq")
      .range(offset, offset + 499);
    if (ledgerError) throw new Error(ledgerError.message);
    turns.push(...(data ?? []).map((row) => row.record as TurnRecord));
    if ((data ?? []).length < 500) break;
  }
  lessons.push({ conversationId, durationSecs: session.duration_secs as number, turns });
}
console.log(JSON.stringify(costSummary(lessons, evidence), null, 2));
