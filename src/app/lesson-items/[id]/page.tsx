import { notFound } from "next/navigation";
import { getOwnerId } from "../../../lib/auth/session";
import { getItem } from "../../../lib/lesson-items";
import { FavoriteButton } from "../FavoriteButton";

// Per-request rendering: owner-scoped data that changes as the word is practiced / re-levelled.
export const dynamic = "force-dynamic";

/**
 * One word / phrase / sentence: its attributes, cross-lesson stats, and the lessons it currently
 * participates in. Deliberately thin for now — the placeholder sections below mark where the richer
 * details (translations, word forms, examples, notes) will land later. See
 * docs/2026-07-17-lesson-items-multiselect-and-word-detail.md.
 */
export default async function WordDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ownerId = await getOwnerId();
  if (!ownerId) notFound();

  const item = await getItem(ownerId, id).catch(() => null);
  if (!item) notFound();

  const stats = [
    `${item.practice_count} ${item.practice_count === 1 ? "conversation" : "conversations"}`,
    `${item.lesson_count} ${item.lesson_count === 1 ? "lesson" : "lessons"}`,
    `added ${new Date(item.first_added_at).toLocaleDateString()}`,
    item.last_practiced_at
      ? `last practiced ${new Date(item.last_practiced_at).toLocaleDateString()}`
      : null,
  ].filter(Boolean);

  const categories = Object.entries(item.categories);

  return (
    <>
      <p className="muted">
        <a href="/lesson-items">← words &amp; sentences</a>
      </p>

      <div style={{ display: "flex", alignItems: "baseline", gap: "0.6rem" }}>
        <FavoriteButton normKey={item.norm_key} text={item.text} initial={item.is_favorite} />
        <h1 style={{ margin: 0, flex: 1 }}>{item.text}</h1>
        {item.level ? (
          <span
            className="muted"
            style={{ fontSize: "0.9rem", border: "1px solid var(--border)", borderRadius: 999, padding: "0.1rem 0.6rem" }}
          >
            {item.level}
          </span>
        ) : null}
        <span className="muted" style={{ fontSize: "0.9rem" }}>
          {item.kind}
        </span>
      </div>

      <p className="muted" style={{ marginTop: "0.4rem" }}>
        {stats.join(" · ")}
      </p>

      <section className="panel">
        <h2>In lessons</h2>
        {item.lessons.length > 0 ? (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {item.lessons.map((l) => (
              <li key={l.id} style={{ padding: "0.35rem 0", borderBottom: "1px solid var(--border)" }}>
                <a href={`/lessons/${l.id}`}>{l.title}</a>
              </li>
            ))}
          </ul>
        ) : (
          // Removal detaches a word from a lesson; it never deletes it — so this is a real state.
          <p className="muted">In no lesson right now.</p>
        )}
      </section>

      {categories.length > 0 ? (
        <section className="panel">
          <h2>Categories</h2>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {categories.map(([name, value]) => (
              <li key={name}>
                <span className="muted">{name}:</span> {value}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Room for the richer word details (translations, forms, example sentences, notes) added
          later — see docs/2026-07-17-lesson-items-multiselect-and-word-detail.md. */}
      <section className="panel">
        <h2>Details</h2>
        <p className="muted">More about this word is coming soon.</p>
      </section>
    </>
  );
}
