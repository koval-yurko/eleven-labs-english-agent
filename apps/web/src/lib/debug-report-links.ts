import { Client } from "langsmith";

import { resolveVersion } from "./agent-registry";

/**
 * The links that make a report worth opening, rather than a JSON blob with better fonts.
 *
 * Every one of them is a DETERMINISTIC string built from a join key the report already carries —
 * nothing here fetches, and nothing here can fail. That matters because the page renders them for
 * a conversation that may never have connected, on a build whose version may since have been
 * retired: a link that is wrong is a dead end, but a link that throws takes the page with it.
 *
 * See docs/2026-09-09-mobile-debug-reports-and-feedback.md §12.3.
 */

/**
 * The LangSmith trace for a conversation — **looked up, not constructed.**
 *
 * This is the link that pays for the whole page: it turns "the tutor said something wrong" into the
 * actual model turn, with its usage and its tool calls, in two clicks.
 *
 * §12.3 assumed the URL was a deterministic string, and it is not. A LangSmith run lives at
 * `/o/<tenant>/projects/p/<project-uuid>/r/<run-uuid>` — three ids, none of which is derivable from
 * a conversation id. What IS deterministic is the run's NAME: `lib/langsmith-trace.ts` names every
 * root run `lesson <conversation_id>`, from both the webhook bridge and the client-side write. So
 * this searches on that name and asks the SDK for the run's own URL.
 *
 * That makes it a network call on a page render, which is why:
 *
 *  - it is **bounded by a timeout**. An operator page must not hang on LangSmith being slow, and a
 *    missing link is a far smaller loss than a page that never paints. Two round trips happen here
 *    — the run search and the project lookup `getRunUrl` does — so the budget covers both.
 *  - it **swallows everything**. The same posture every other LangSmith call in this repo takes: an
 *    observability read must never be able to fail the thing it observes.
 *
 * Null when there is no key, no project, no matching run, or the lookup did not answer in time. The
 * caller then renders the trace name as copyable text, which is the manual version of the same
 * search.
 */
const LANGSMITH_LOOKUP_MS = 4000;

export async function langsmithTraceUrl(conversationId: string): Promise<string | null> {
  const project = process.env.LANGSMITH_PROJECT?.trim();
  if (!project || !process.env.LANGSMITH_API_KEY?.trim()) return null;

  const lookup = async (): Promise<string | null> => {
    const client = new Client();
    for await (const run of client.listRuns({
      projectName: project,
      filter: `eq(name, "lesson ${conversationId}")`,
      isRoot: true,
      limit: 1,
    })) {
      return await client.getRunUrl({ run, projectOpts: { projectName: project } });
    }
    return null;
  };

  try {
    return await Promise.race([
      lookup(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), LANGSMITH_LOOKUP_MS)),
    ]);
  } catch {
    // No key, no project, a network failure, or a lesson that was never traced. All of them mean
    // the same thing to this page: no link.
    return null;
  }
}

/** The search that finds it by hand, for when the lookup above cannot. */
export function langsmithTraceName(conversationId: string): string {
  return `lesson ${conversationId}`;
}

/**
 * The provider's own console, for the same conversation.
 *
 * One function rather than three call sites, so a report from a provider this deployment has never
 * seen renders no link instead of a broken one. OpenAI is deliberately absent and that absence is
 * itself information: the Realtime API has no per-call console page, which is exactly why the
 * client-side write is the only witness there (`docs/2026-08-22-openai-lesson-observability.md`).
 */
export function providerConsoleUrl(
  provider: string | null,
  conversationId: string,
): { label: string; url: string } | null {
  if (provider === "elevenlabs") {
    return {
      label: "ElevenLabs conversation",
      url: `https://elevenlabs.io/app/conversational-ai/history/${encodeURIComponent(conversationId)}`,
    };
  }
  if (provider === "vapi") {
    return {
      label: "Vapi call",
      url: `https://dashboard.vapi.ai/calls/${encodeURIComponent(conversationId)}`,
    };
  }
  return null;
}

/**
 * What `agent_version` actually WAS at the time — resolved through the registry, not echoed.
 *
 * The version string alone says which prompt module was named; this says which agent OBJECT was
 * running and on which provider, which is the difference between "words-3.0" and a specific
 * ElevenLabs agent id you can paste into their console.
 *
 * `resolveVersion` returns null for a version this build has retired or never had. That is reported
 * rather than hidden: a report from a build running a version the server no longer offers is a
 * finding, and blanking the row would erase it.
 */
export function resolveReportAgent(
  version: string | null,
): { version: string; provider: string; agentId: string | null } | null {
  if (!version) return null;
  const resolved = resolveVersion(version);
  if (!resolved) return null;
  return { version: resolved.version, provider: resolved.provider, agentId: resolved.agentId };
}
