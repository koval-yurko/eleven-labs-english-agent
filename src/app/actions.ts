"use server";

import { revalidatePath } from "next/cache";
import { getOwnerId } from "../lib/auth/session";
import { getServiceSupabase } from "../lib/supabase/server";
import { askClaude } from "../lib/llm";

/** Insert an owner-scoped row — proves Supabase write + the owner_id pattern. */
export async function addPing(formData: FormData): Promise<void> {
  const ownerId = await getOwnerId();
  if (!ownerId) return;
  const note = String(formData.get("note") ?? "").slice(0, 200);
  await getServiceSupabase().from("health_pings").insert({ owner_id: ownerId, note });
  revalidatePath("/");
}

/** Ask Claude (via LangChain) — proves the LLM path end-to-end. Returns the answer text. */
export async function askClaudeAction(
  _prev: string | null,
  formData: FormData,
): Promise<string> {
  const prompt = String(formData.get("prompt") ?? "").slice(0, 1000);
  if (!prompt.trim()) return "";
  try {
    return await askClaude(prompt);
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}
