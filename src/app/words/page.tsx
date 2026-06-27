import { activeVersions } from "../../lib/agent-registry";
import { WordsTutor } from "./WordsTutor";

// Read the registry at request time, not build time (the lockfile may change between deploys).
export const dynamic = "force-dynamic";

/** Voice page: talk through a list of English words/sentences with the proactive tutor agent. */
export default function WordsPage() {
  const versions = activeVersions();
  // Newest active version is the default (registry is ordered oldest → newest).
  const defaultVersion = versions[versions.length - 1]?.version ?? "";

  return (
    <>
      <h1>English words tutor</h1>
      <p className="muted">
        Paste a few words or sentences, press start, and discuss them out loud with a proactive
        English teacher. Interrupt any time to ask follow-ups. <a href="/">← back</a>
      </p>

      {versions.length > 0 ? (
        <WordsTutor
          versions={versions.map((v) => ({ version: v.version, label: v.label ?? v.version }))}
          defaultVersion={defaultVersion}
        />
      ) : (
        <section className="panel">
          <p className="muted" style={{ color: "var(--error)" }}>
            No tutor agents are provisioned yet. Run <code>pnpm sync:agents</code> to create them
            from <code>src/agent/prompts/</code>, commit <code>agents.lock.json</code>, and restart
            the dev server.
          </p>
        </section>
      )}
    </>
  );
}
