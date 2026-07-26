"use client";

import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { getDb, type MirrorLesson } from "../lib/sync/db";
import { ensureOwner, seedLessons } from "../lib/sync/mirror";
import { deleteLessonLocal, requestFlush } from "../lib/sync/engine";
import { formatDate } from "../lib/format-date";
import { NavLink } from "./NavLink";
import { TrashIcon } from "./icons";

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

  // Which lesson's delete is awaiting confirmation (inline, not a blocking window.confirm — which
  // would stall the optimistic offline write).
  const [confirmId, setConfirmId] = useState<string | null>(null);

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

  async function onDelete(lessonId: string) {
    setConfirmId(null);
    await deleteLessonLocal(lessonId);
    requestFlush();
  }

  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {lessons.map((l) => (
        <li key={l.id} style={{ padding: "0.6rem 0", borderBottom: "1px solid var(--border)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem" }}>
            <NavLink href={`/lessons/${l.id}`} style={{ fontWeight: 600 }}>
              {l.title}
            </NavLink>
            {confirmId === l.id ? null : (
              <button
                type="button"
                onClick={() => setConfirmId(l.id)}
                aria-label={`Delete ${l.title}`}
                title="Delete lesson"
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: 0,
                  flexShrink: 0,
                  color: "var(--error)",
                  display: "inline-flex",
                  alignItems: "center",
                }}
              >
                <TrashIcon size={18} />
              </button>
            )}
          </div>
          <div className="muted" style={{ fontSize: "0.9rem" }}>
            {l.items.length} {l.items.length === 1 ? "item" : "items"} · {l.sessionCount}{" "}
            {l.sessionCount === 1 ? "conversation" : "conversations"} ·{" "}
            {formatDate(l.created_at)}
          </div>
          <div className="muted" style={{ fontSize: "0.9rem" }}>
            {l.items.join(" · ")}
          </div>
          {confirmId === l.id ? (
            <div
              style={{
                marginTop: "0.5rem",
                display: "flex",
                alignItems: "center",
                gap: "0.75rem",
                flexWrap: "wrap",
              }}
            >
              <span className="muted" style={{ fontSize: "0.9rem" }}>
                Delete this lesson? Your words and their practice history stay in your collection.
              </span>
              <span style={{ display: "flex", gap: "0.5rem", flexShrink: 0 }}>
                <button type="button" onClick={() => void onDelete(l.id)} style={{ color: "var(--error)" }}>
                  Delete
                </button>
                <button type="button" onClick={() => setConfirmId(null)}>
                  Cancel
                </button>
              </span>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
