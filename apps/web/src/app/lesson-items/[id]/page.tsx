import { notFound } from "next/navigation";
import { getOwnerId } from "../../../lib/auth/session";
import { getItem } from "../../../lib/lesson-items";
import type { ItemDetail } from "@tutor/shared/words/types";
import { NavLink } from "../../NavLink";
import { RefreshButton } from "../../RefreshButton";
import { PopularityButton } from "../PopularityButton";

// Per-request rendering: owner-scoped data that changes as the word is practiced / re-levelled.
export const dynamic = "force-dynamic";

/**
 * One word / phrase / sentence: its attributes, cross-lesson stats, the lessons it currently
 * participates in, and the LLM-generated enrichment (translations, word-family forms, examples)
 * filled in by the word-details job. See docs/2026-07-18-word-details-enrichment-job.md.
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
      {/* The page stays a server component: only the button is a client island, exactly as the
          popularity control below already is. Enrichment lands after the write, so this row is where
          the learner asks again for the details section further down. */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <p className="muted" style={{ flex: 1 }}>
          <NavLink href="/lesson-items">← words &amp; sentences</NavLink>
        </p>
        <RefreshButton label="Refresh word" />
      </div>

      <div style={{ display: "flex", alignItems: "baseline", gap: "0.6rem" }}>
        {/* Where the favourite star stood. It counts meetings with the word instead of flagging it
            — see `PopularityButton` for why this one is a control and the list's copy is not. */}
        <PopularityButton id={item.id} text={item.text} initial={item.popularity} />
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

      <WordDetailsSection details={item.details} attemptedAt={item.details_at} />

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

      {/* Kept at the bottom: the enrichment (translation / forms / examples) is what the learner
          opens this page for; the lesson membership is secondary context. */}
      <section className="panel">
        <h2>In lessons</h2>
        {item.lessons.length > 0 ? (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {item.lessons.map((l) => (
              <li key={l.id} style={{ padding: "0.35rem 0", borderBottom: "1px solid var(--border)" }}>
                <NavLink href={`/lessons/${l.id}`}>{l.title}</NavLink>
              </li>
            ))}
          </ul>
        ) : (
          // Removal detaches a word from a lesson; it never deletes it — so this is a real state.
          <p className="muted">In no lesson right now.</p>
        )}
      </section>
    </>
  );
}

/**
 * The enrichment payload from the word-details job. Three states, per `getItem`:
 *   - `details` set → render translations / forms / examples.
 *   - both null → queued or in flight (the job runs after the write / on the next sweep).
 *   - `details` null but `attemptedAt` set → the model had no usable answer (a non-English token, a
 *     made-up word). A terminal, normal state.
 */
function WordDetailsSection({
  details,
  attemptedAt,
}: {
  details: ItemDetail["details"];
  attemptedAt: string | null;
}) {
  if (!details) {
    return (
      <section className="panel">
        <h2>Details</h2>
        <p className="muted">
          {attemptedAt ? "No extra details for this one." : "Details are being prepared…"}
        </p>
      </section>
    );
  }

  return (
    <>
      <section className="panel">
        <h2>Translation</h2>
        <p style={{ margin: 0 }}>
          <span className="muted" style={{ fontSize: "0.9rem" }}>
            {details.pos}
          </span>
          {details.translations_ru.length > 0 ? (
            <>
              {" — "}
              {details.translations_ru.join(", ")}
            </>
          ) : null}
        </p>
      </section>

      {details.forms.length > 0 ? (
        <section className="panel">
          <h2>Forms</h2>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {details.forms.map((f) => (
              <li
                key={`${f.pos}:${f.text}`}
                style={{ padding: "0.35rem 0", borderBottom: "1px solid var(--border)" }}
              >
                <strong>{f.text}</strong>{" "}
                <span className="muted" style={{ fontSize: "0.85rem" }}>
                  {f.pos}
                </span>
                {f.translations_ru.length > 0 ? (
                  <div className="muted" style={{ fontSize: "0.9rem" }}>
                    {f.translations_ru.join(", ")}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {details.examples.length > 0 ? (
        <section className="panel">
          <h2>Examples</h2>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {details.examples.map((e, i) => (
              <li key={i} style={{ padding: "0.4rem 0", borderBottom: "1px solid var(--border)" }}>
                <div>
                  {e.text}
                  {e.form ? (
                    <span className="muted" style={{ fontSize: "0.8rem" }}>
                      {" "}
                      · {e.form}
                    </span>
                  ) : null}
                </div>
                {e.translation_ru ? (
                  <div className="muted" style={{ fontSize: "0.9rem" }}>
                    {e.translation_ru}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
