"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Field } from "@base-ui/react/field";
import { Button } from "../../Button";
import { useLiveQuery } from "dexie-react-hooks";
import { getDb, type MirrorItem } from "../../../lib/sync/db";
import { ensureOwner, seedLessonItems } from "../../../lib/sync/mirror";
import { addItemsLocal, removeItemLocal, requestFlush, MAX_ITEMS } from "../../../lib/sync/engine";

/**
 * "Words in this lesson", backed by the IndexedDB mirror. The server passes the active items as
 * `initial`; this island seeds the mirror (reconciling removals) and reads it via a live query,
 * so it stays correct online and offline. Add/remove are optimistic: they update the mirror +
 * queue an outbox op (instant UI via the live query) and request a flush, which the SyncProvider
 * drains to the server and pulls back.
 */
export function LessonItemsView({
  ownerSub,
  lessonId,
  initial,
}: {
  ownerSub?: string;
  lessonId: string;
  initial?: MirrorItem[];
}) {
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!ownerSub || !initial) return; // offline shell: read/edit the mirror, don't seed
    void (async () => {
      await ensureOwner(ownerSub);
      await seedLessonItems(lessonId, initial);
    })();
  }, [ownerSub, lessonId, initial]);

  const items =
    useLiveQuery(
      () => getDb().items.where("lesson_id").equals(lessonId).sortBy("position"),
      [lessonId],
      initial,
    ) ??
    initial ??
    [];

  const atCap = items.length >= MAX_ITEMS;

  async function onAdd(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const form = e.currentTarget;
    const room = Math.max(0, MAX_ITEMS - items.length);
    const texts = String(new FormData(form).get("items") ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, room);
    if (texts.length === 0) return;
    setBusy(true);
    try {
      await addItemsLocal(lessonId, texts);
      form.reset();
      requestFlush();
    } finally {
      setBusy(false);
    }
  }

  async function onRemove(itemId: string) {
    await removeItemLocal(lessonId, itemId);
    requestFlush();
  }

  return (
    <>
      {items.length === 0 ? (
        <p className="muted">No words yet — add some below.</p>
      ) : (
        <ul style={{ margin: 0, listStyle: "none", padding: 0 }}>
          {items.map((it) => (
            <li
              key={it.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "0.75rem",
                padding: "0.25rem 0",
              }}
            >
              <span>{it.text}</span>
              <Button
                variant="inline"
                tone="danger"
                onClick={() => void onRemove(it.id)}
                aria-label={`Remove ${it.text}`}
              >
                remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      <form
        onSubmit={onAdd}
        style={{ marginTop: "1rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}
      >
        <Field.Root>
          <Field.Control
            render={<textarea rows={3} />}
            name="items"
            // The placeholder was the only thing naming this control, and a placeholder disappears
            // the moment you type into it.
            aria-label="Words or sentences to add — one per line"
            placeholder="Add words or sentences — one per line"
            style={{ width: "100%" }}
            disabled={atCap}
          />
          <div>
            <Button type="submit" disabled={atCap || busy}>
              Add words
            </Button>{" "}
            {/* The count and the cap notice are this field's description, not loose prose beside
                it — as Field.Description they reach a screen reader with the control. */}
            <Field.Description render={<span />} className="muted">
              {atCap ? "Lesson is full (50 items)." : `${items.length}/50 items`}
            </Field.Description>
          </div>
        </Field.Root>
      </form>
    </>
  );
}
