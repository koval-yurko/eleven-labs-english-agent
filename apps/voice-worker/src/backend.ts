import process from "node:process";

import type { TranscriptLine } from "@tutor/shared/tutor/session";
import type { TurnRecord } from "@tutor/shared/tutor/livekit-wire";

/**
 * The worker's only way to write anything down.
 *
 * It holds no Supabase key, no `MCP_TOKEN` and no LangSmith key (research doc §10.1). Everything it
 * records goes through two backend routes, authenticated by the per-lesson grant that arrived in
 * dispatch metadata — a credential that can write THIS lesson and nothing else. See
 * docs/2026-09-25-lesson-grant-tool-authorization.md.
 *
 * **Nothing here may throw into the voice loop.** A ledger batch that fails is a measurement lost;
 * a tool call that fails is a word the tutor must admit it did not save. Neither is worth killing a
 * lesson the learner is in the middle of, so every call resolves to a result the caller can report
 * instead of rejecting.
 */

const SESSION_END_PATH = "/api/v2/livekit/session-end";
const COLLECTION_ITEMS_PATH = "/api/v2/livekit/collection-items";

/** How many turns accumulate before a partial batch is posted (research doc §5.2). */
export const LEDGER_BATCH_SIZE = 5;

export interface AddWordsResult {
  added: { id: string; text: string }[];
  already_present: { id: string; text: string }[];
  skipped: string[];
}

export class Backend {
  readonly #baseUrl: string;
  readonly #grant: string;

  /**
   * Built only when BOTH a base URL and a grant exist. A console run has neither, and a worker that
   * posted a fixture lesson to a real backend would be worse than one that stays local — so the
   * caller checks `Backend.from(...)` for null rather than this class inventing a fallback.
   */
  static from(grant: string | undefined): Backend | null {
    const baseUrl = process.env.API_BASE_URL?.trim().replace(/\/$/, "");
    if (!baseUrl || !grant) return null;
    return new Backend(baseUrl, grant);
  }

  private constructor(baseUrl: string, grant: string) {
    this.#baseUrl = baseUrl;
    this.#grant = grant;
  }

  async #post(path: string, body: unknown): Promise<Response | null> {
    try {
      const res = await fetch(`${this.#baseUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#grant}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        // The status matters and the body usually says why: a 401 here is an expired or
        // mismatched grant, which is a deployment fault rather than a lesson fault.
        console.error(`[backend] ${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
        return null;
      }
      return res;
    } catch (e) {
      console.error(`[backend] ${path} → ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /** A batch of turns, mid-lesson. Losing one costs those turns' measurements, never the lesson. */
  async postLedgerBatch(turns: TurnRecord[]): Promise<void> {
    if (turns.length === 0) return;
    await this.#post(`${SESSION_END_PATH}?partial=1`, { turns });
  }

  /**
   * The final write: the last turns, the transcript and how long it ran. This is the post that
   * upserts `lesson_sessions` and files the LangSmith trace.
   */
  async postSessionEnd(input: {
    turns: TurnRecord[];
    lines: TranscriptLine[];
    version: string;
    durationSecs: number;
  }): Promise<void> {
    await this.#post(SESSION_END_PATH, input);
  }

  /**
   * `add_words_to_collection`. Returns null when the write did not happen, which the tool turns
   * into something the tutor can say out loud — the one failure here the learner should hear about,
   * because they asked for a word to be saved and it was not.
   */
  async addWords(words: string[]): Promise<AddWordsResult | null> {
    const res = await this.#post(COLLECTION_ITEMS_PATH, { words });
    if (!res) return null;
    try {
      return (await res.json()) as AddWordsResult;
    } catch {
      return null;
    }
  }
}
