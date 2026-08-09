"use client";

import { useEffect, useState } from "react";
import { useMirrorLessons } from "../lib/sync/live";
import type { MirrorLesson } from "@tutor/shared/mirror-store";
import { ensureOwner, seedLessons } from "../lib/sync/mirror";
import { deleteLessonLocal, requestFlush } from "../lib/sync/engine";
import { formatDate } from "../lib/format-date";
import { NavLink } from "./NavLink";
import { TrashIcon } from "./icons";
import { ConfirmDialog } from "./ConfirmDialog";
import { Tooltip } from "./Tooltip";
import { Button } from "./Button";

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

  // The lesson whose delete is awaiting confirmation. Still React state rather than a blocking
  // window.confirm (which would stall the optimistic offline write) — it just drives an
  // AlertDialog now instead of an inline row, so the prompt traps focus and is announced.
  //
  // Two pieces, because they have different lifetimes: `confirmOpen` flips the moment the user
  // answers, while `confirmTarget` has to outlive it until the close animation ends. It also holds
  // the title itself rather than an id to look up — by the time a confirmed delete finishes closing,
  // the lesson is gone from the list and the lookup would come back empty mid-fade.
  const [confirmTarget, setConfirmTarget] = useState<{ id: string; title: string } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const lessons = useMirrorLessons(initial);

  if (lessons.length === 0) {
    return <p className="muted">No lessons yet — create your first one above.</p>;
  }

  // The dialog's own Close button drives the closing; this only does the delete.
  async function onDelete(lessonId: string) {
    await deleteLessonLocal(lessonId);
    requestFlush();
  }

  return (
    <>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {lessons.map((l) => (
          <li key={l.id} style={{ padding: "0.6rem 0", borderBottom: "1px solid var(--border)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem" }}>
              <NavLink href={`/lessons/${l.id}`} style={{ fontWeight: 600 }}>
                {l.title}
              </NavLink>
              <Tooltip label="Delete lesson">
                <Button
                  variant="icon"
                  tone="danger"
                  onClick={() => {
                    setConfirmTarget({ id: l.id, title: l.title });
                    setConfirmOpen(true);
                  }}
                  aria-label={`Delete ${l.title}`}
                >
                  <TrashIcon size={18} />
                </Button>
              </Tooltip>
            </div>
            <div className="muted" style={{ fontSize: "0.9rem" }}>
              {l.items.length} {l.items.length === 1 ? "item" : "items"} · {l.sessionCount}{" "}
              {l.sessionCount === 1 ? "conversation" : "conversations"} ·{" "}
              {formatDate(l.created_at)}
            </div>
            <div className="muted" style={{ fontSize: "0.9rem" }}>
              {l.items.join(" · ")}
            </div>
          </li>
        ))}
      </ul>

      {/* One dialog for the whole list, driven by which row is pending — not one mounted per row. */}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onOpenChangeComplete={(open) => {
          if (!open) setConfirmTarget(null);
        }}
        title={confirmTarget ? `Delete “${confirmTarget.title}”?` : ""}
        description="Your words and their practice history stay in your collection."
        confirmLabel="Delete"
        onConfirm={() => {
          if (confirmTarget) void onDelete(confirmTarget.id);
        }}
      />
    </>
  );
}
