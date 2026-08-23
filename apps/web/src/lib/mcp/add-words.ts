/**
 * `add_words_to_collection` — the one MCP tool, and the first of several.
 *
 * The name is not decoration: it is what a model reads when deciding whether to call this, and
 * "add words" without a noun invites it to keep a shopping list here. It says *collection* because
 * that is the domain word the rest of the app uses.
 *
 * The tool is deliberately WRITE-ONLY AND BLIND — it cannot read the collection, cannot delete from
 * it, and cannot reach another learner. That is the entire threat model for a tool a model can be
 * talked into calling: the worst outcome is junk vocabulary in the caller's own collection, cleaned
 * up with the existing delete. A `list_words` or `search_words` tool would make this an
 * exfiltration channel instead, which is a different class of thing and needs its own review before
 * it is written. See docs/2026-08-23-mcp-server-add-words.md §8.2 and §11.4.
 *
 * `zod4`, not `zod`: the SDK advertises a tool's arguments from `~standard.jsonSchema`, which
 * `zod@3.25`'s `zod/v4` subpath does NOT implement (it has `~standard.validate` and nothing else).
 * The alias in package.json is a real Zod 4 beside the app's Zod 3, so the LangChain jobs — the
 * only other zod callers — keep the version `@langchain/core` was built against.
 */
import { MAX_ITEMS } from "@tutor/shared/offline/ops";
import { MAX_WORD_LENGTH } from "@tutor/shared/words/key";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod4";

import { scheduleWordJobs } from "../sync-flush";
import { addWords } from "../words";
import { mcpOwnerId } from "./owner";

/**
 * Both caps are the ones this codebase already chose, imported rather than re-picked: `MAX_ITEMS`
 * is "one batch of words" in the offline op algebra, `MAX_WORD_LENGTH` is what `wordInputKey`
 * truncates to. They are also the whole of the tool's abuse mitigation, which is enough for a tool
 * that can only create rows the caller already owns.
 */
const inputSchema = z.object({
  words: z
    .array(z.string().min(1).max(MAX_WORD_LENGTH))
    .min(1)
    .max(MAX_ITEMS)
    .describe("English words, phrases or full sentences. One entry per item."),
});

const outputSchema = z.object({
  added: z.array(z.object({ id: z.string(), text: z.string() })),
  already_present: z.array(
    z.object({ id: z.string(), text: z.string(), popularity: z.number().nullable() }),
  ),
  skipped: z.array(z.string()),
});

export function registerAddWords(server: McpServer): void {
  server.registerTool(
    "add_words_to_collection",
    {
      title: "Add words to the English collection",
      description:
        "Add English words, phrases or sentences to the learner's vocabulary collection. " +
        "Each entry is checked first: one that is already in the collection is reported as such " +
        "and is not duplicated. Use for vocabulary the learner wants to practise later.",
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ words }, ctx) => {
      const ownerId = mcpOwnerId(ctx);
      const result = await addWords(ownerId, words);

      // The same rule as every other write path: without this an MCP-added word has no CEFR level
      // and no `details` until the next sweep, and nothing about that is visible at the time. It is
      // the failure `/api/v2/lesson-items` calls out, in a third place.
      if (result.added.length > 0) scheduleWordJobs(ownerId);

      const structured = {
        added: result.added,
        already_present: result.alreadyPresent,
        skipped: result.skipped,
      };

      return {
        content: [{ type: "text" as const, text: summarize(structured) }],
        structuredContent: structured,
      };
    },
  );
}

/**
 * What the model reads back. Prose rather than the JSON again, because the JSON is already in
 * `structuredContent` and a second copy just costs tokens.
 *
 * The popularity line is here on purpose. A retried call is NOT idempotent — the words are (the RPC
 * is an upsert) but the counter is not, because a duplicate add bumps `popularity` exactly as every
 * other duplicate branch in the app does. Saying so is cheaper than an MCP path that quietly
 * behaves differently from the rest (§2.2).
 */
function summarize(r: z.infer<typeof outputSchema>): string {
  const lines: string[] = [];

  if (r.added.length > 0) {
    lines.push(`Added ${r.added.length}: ${r.added.map((w) => w.text).join(", ")}`);
  }
  if (r.already_present.length > 0) {
    const listed = r.already_present.map((w) => `${w.text} (met ${w.popularity ?? "?"}×)`);
    lines.push(`Already in the collection — met again, not duplicated: ${listed.join(", ")}`);
  }
  if (r.skipped.length > 0) {
    lines.push(`Skipped ${r.skipped.length} (empty, or a duplicate of another entry in this call).`);
  }
  if (lines.length === 0) lines.push("Nothing to add.");

  return lines.join("\n");
}
