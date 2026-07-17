"use client";

import { useEffect } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { getDb, type MirrorLesson } from "../lib/sync/db";
import { ensureOwner, seedLessons } from "../lib/sync/mirror";

/**
 * The "Your lessons" list, rendered from the IndexedDB mirror. On the online home page the server
 * passes `ownerSub` + its freshly rendered `initial` payload: the island seeds the mirror and then
 * reads it via a live query, so the mirror (not the server HTML) is authoritative — and `initial`
 * doubles as the SSR/first-render result, so there's no hydration flash. In the OFFLINE app-shell
 * both props are omitted: no seeding happens and it renders whatever the mirror already holds.
 */
export function LessonsList({ ownerSub, initial }: { ownerSub?: string; initial?: MirrorLesson[] }) {
  useEffect(() => {
    if (!ownerSub || !initial) return; // offline shell: read-only from the mirror, don't seed
    void (async () => {
      await ensureOwner(ownerSub);
      await seedLessons(initial);
    })();
  }, [ownerSub, initial]);

  const lessons =
    useLiveQuery(
      () => getDb().lessons.orderBy("created_at").reverse().toArray(),
      [],
      initial,
    ) ??
    initial ??
    [];

  if (lessons.length === 0) {
    return <p className="muted">No lessons yet — create your first one above.</p>;
  }

  return (
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
            {l.items.join(" · ")}
          </div>
        </li>
      ))}
    </ul>
  );
}
