import { getOwnerId } from "../lib/auth/session";
import { listLessons } from "../lib/lessons";
import { createLessonAction } from "./lessons/actions";

// Per-request rendering: the list is owner-scoped (cookies) and changes between visits.
export const dynamic = "force-dynamic";

/** Home page: the learner's word sets — create a new lesson or open one to practice. */
export default async function HomePage() {
  const ownerId = await getOwnerId();
  const lessons = ownerId ? await listLessons(ownerId) : [];

  return (
    <>
      <h1>Lessons</h1>
      <p className="muted">
        A lesson is a set of words, phrases, or sentences you&apos;re learning. Open one to talk
        it through with the tutor and revisit past conversations.
      </p>

      <section className="panel">
        <h2>New lesson</h2>
        <form action={createLessonAction}>
          <input
            name="title"
            placeholder="Title (optional — defaults to the first word)"
            maxLength={120}
            style={{ marginBottom: "0.5rem" }}
          />
          <textarea
            name="items"
            required
            rows={5}
            placeholder={"One word, phrase, or sentence per line, e.g.\nephemeral\nbreak the ice\nI couldn't agree more"}
          />
          <button type="submit">Create lesson</button>
        </form>
      </section>

      <section className="panel">
        <h2>Your lessons</h2>
        {lessons.length === 0 ? (
          <p className="muted">No lessons yet — create your first one above.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {lessons.map((l) => (
              <li key={l.id} style={{ padding: "0.6rem 0", borderBottom: "1px solid var(--border)" }}>
                <a href={`/lessons/${l.id}`} style={{ fontWeight: 600 }}>
                  {l.title}
                </a>
                <div className="muted" style={{ fontSize: "0.9rem" }}>
                  {l.items.length} {l.items.length === 1 ? "item" : "items"} · {l.sessionCount}{" "}
                  {l.sessionCount === 1 ? "conversation" : "conversations"} ·{" "}
                  {new Date(l.created_at).toLocaleDateString()}
                </div>
                <div className="muted" style={{ fontSize: "0.9rem" }}>
                  {l.items.slice(0, 4).join(" · ")}
                  {l.items.length > 4 ? " · …" : ""}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
