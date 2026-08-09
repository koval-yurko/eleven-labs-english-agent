import { notFound } from "next/navigation";
import { getOwnerId } from "../../../lib/auth/session";
import { getLesson, listLessonSessions, listLessonItemHistory } from "../../../lib/lessons";
import type { LessonItem, LessonSession } from "@tutor/shared/lesson-types";
import { activeVersions } from "../../../lib/agent-registry";
import { NavLink } from "../../NavLink";
import { Disclosure } from "../../Disclosure";
import { LessonTutor } from "./LessonTutor";
import { LessonItemsView } from "./LessonItemsView";

// Per-request rendering: owner-scoped data + the lockfile registry may change between deploys.
export const dynamic = "force-dynamic";

function formatDuration(secs: number | null): string | null {
  if (secs == null) return null;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/**
 * The lesson's add/remove log, derived straight from the item rows: each row is an "added"
 * event (created_at) and, if soft-deleted, also a "removed" event (removed_at). Newest first.
 */
function ItemChanges({ history }: { history: LessonItem[] }) {
  const events = history
    .flatMap((it) => {
      const evs: { at: string; kind: "added" | "removed"; text: string }[] = [
        { at: it.created_at, kind: "added", text: it.text },
      ];
      if (it.removed_at) evs.push({ at: it.removed_at, kind: "removed", text: it.text });
      return evs;
    })
    .sort((a, b) => (a.at < b.at ? 1 : -1));

  if (events.length === 0) return null;

  return (
    <Disclosure
      className="panel"
      summary={
        <>
          <strong>Word changes</strong>{" "}
          <span className="muted">
            — {events.length} {events.length === 1 ? "event" : "events"}
          </span>
        </>
      }
    >
      <ul style={{ listStyle: "none", padding: 0, marginTop: "0.5rem" }}>
        {events.map((e, i) => (
          <li key={i} style={{ marginBottom: "0.35rem" }}>
            <span style={{ color: e.kind === "added" ? "var(--ok)" : "var(--error)" }}>
              {e.kind === "added" ? "＋ added" : "－ removed"}
            </span>{" "}
            <strong>{e.text}</strong>{" "}
            <span className="muted">— {new Date(e.at).toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </Disclosure>
  );
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
            <Disclosure
              key={s.id}
              style={{ padding: "0.5rem 0", borderBottom: "1px solid var(--border)" }}
              summary={
                <>
                  <strong>Conversation</strong> <span className="muted">— {meta}</span>
                </>
              }
            >
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
            </Disclosure>
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

  const [sessions, itemHistory] = await Promise.all([
    listLessonSessions(ownerId, lesson.id),
    listLessonItemHistory(ownerId, lesson.id),
  ]);
  // Active items (with ids), in display order — seeds the mirror-backed items island.
  const activeItems = itemHistory
    .filter((it) => it.removed_at === null)
    .sort((a, b) => a.position - b.position);
  const versions = activeVersions();
  // Newest active version is the default (registry is ordered oldest → newest).
  const defaultVersion = versions[versions.length - 1]?.version ?? "";

  return (
    <>
      <h1>{lesson.title}</h1>
      <p className="muted">
        Created {new Date(lesson.created_at).toLocaleDateString()} ·{" "}
        <NavLink href="/lessons">← all lessons</NavLink>
      </p>

      <section className="panel">
        <h2>Words in this lesson</h2>
        <LessonItemsView
          ownerSub={ownerId}
          lessonId={lesson.id}
          initial={activeItems.map((it) => ({
            id: it.id,
            lesson_id: lesson.id,
            text: it.text,
            position: it.position,
          }))}
        />
      </section>

      {versions.length > 0 ? (
        <LessonTutor
          lessonId={lesson.id}
          items={lesson.itemsDetailed}
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

      <ItemChanges history={itemHistory} />
      <SessionHistory sessions={sessions} />
    </>
  );
}
