import { elevenLabsConfig } from "../../lib/config";
import { WordsTutor } from "./WordsTutor";

// Read the env gate at request time, not build time (the agent id may be set after build).
export const dynamic = "force-dynamic";

/** Voice page: talk through a list of English words/sentences with the proactive tutor agent. */
export default function WordsPage() {
  const { agentId } = elevenLabsConfig();

  return (
    <>
      <h1>English words tutor</h1>
      <p className="muted">
        Paste a few words or sentences, press start, and discuss them out loud with a proactive
        English teacher. Interrupt any time to ask follow-ups. <a href="/">← back</a>
      </p>

      {agentId ? (
        <WordsTutor />
      ) : (
        <section className="panel">
          <p className="muted" style={{ color: "var(--error)" }}>
            <code>ELEVENLABS_STORY_AGENT_ID</code> is not set. Run{" "}
            <code>pnpm provision:agent</code>, paste the printed id into your env, and restart
            the dev server.
          </p>
        </section>
      )}
    </>
  );
}
