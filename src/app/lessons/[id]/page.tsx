import { notFound } from "next/navigation";
import { getOwnerId } from "../../../lib/auth/session";
import { getLesson, listLessonSessions, type LessonSession } from "../../../lib/lessons";
import { activeVersions } from "../../../lib/agent-registry";
import { LessonTutor } from "./LessonTutor";

// Per-request rendering: owner-scoped data + the lockfile registry may change between deploys.
export const dynamic = "force-dynamic";

function formatDuration(secs: number | null): string | null {
  if (secs == null) return null;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function SessionHistory({ sessions }: { sessions: LessonSession[] }) {
  return (
    <section className="panel">
      <h2>History</h2>
      {sessions.length === 0 ? (
        <p className="muted">No conversations yet — start one above and it will appear here.</p>
      ) : (
        sessions.map((s) => {
          const duration = formatDuration(s.duration_secs);
          const meta = [
            new Date(s.created_at).toLocaleString(),
            s.agent_version,
            duration,
            `${s.transcript.length} turns`,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <details key={s.id} style={{ padding: "0.5rem 0", borderBottom: "1px solid var(--border)" }}>
              <summary style={{ cursor: "pointer" }}>
                <strong>Conversation</strong> <span className="muted">— {meta}</span>
              </summary>
              {s.summary ? (
                <p className="muted" style={{ fontStyle: "italic" }}>
                  {s.summary}
                </p>
              ) : null}
              <ul style={{ listStyle: "none", padding: 0 }}>
                {s.transcript.map((l, i) => (
                  <li key={i} style={{ marginBottom: "0.5rem" }}>
                    <strong>{l.role === "agent" ? "Teacher" : "You"}:</strong>{" "}
                    <span className="muted">{l.text}</span>
                  </li>
                ))}
              </ul>
            </details>
          );
        })
      )}
    </section>
  );
}

/** One lesson: its words, a live tutor session, and the history of past conversations. */
export default async function LessonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ownerId = await getOwnerId();
  if (!ownerId) notFound();

  const lesson = await getLesson(ownerId, id).catch(() => null);
  if (!lesson) notFound();

  const sessions = await listLessonSessions(ownerId, lesson.id);
  const versions = activeVersions();
  // Newest active version is the default (registry is ordered oldest → newest).
  const defaultVersion = versions[versions.length - 1]?.version ?? "";

  return (
    <>
      <h1>{lesson.title}</h1>
      <p className="muted">
        Created {new Date(lesson.created_at).toLocaleDateString()} ·{" "}
        <a href="/">← all lessons</a>
      </p>

      <section className="panel">
        <h2>Words in this lesson</h2>
        <ul style={{ margin: 0 }}>
          {lesson.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      </section>

      {versions.length > 0 ? (
        <LessonTutor
          lessonId={lesson.id}
          items={lesson.items}
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

      <SessionHistory sessions={sessions} />
    </>
  );
}
