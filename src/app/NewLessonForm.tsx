"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  createLessonLocal,
  defaultLessonTitle,
  flushOutboxNow,
  requestFlush,
  MAX_ITEMS,
} from "../lib/sync/engine";
import { useNavigationTransition } from "./nav-progress";

/**
 * "New lesson" — an optimistic, offline-capable create. Mints all ids client-side, writes the
 * lesson + items to the mirror and queues the create op (so it appears in the list instantly and
 * survives offline), then:
 *  - online: flushes so the server has the row, then opens the lesson page;
 *  - offline: leaves it queued (it shows in the list; opening it needs a connection for now).
 */
export function NewLessonForm() {
  const router = useRouter();
  // Puts the hop to the new lesson on the top progress bar, like a <NavLink> click.
  const startNavigation = useNavigationTransition();
  const formRef = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const fd = new FormData(e.currentTarget);
    const items = String(fd.get("items") ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, MAX_ITEMS);
    if (!items[0]) return;

    const title = (String(fd.get("title") ?? "").trim() || (await defaultLessonTitle())).slice(
      0,
      120,
    );
    const id = crypto.randomUUID();

    setBusy(true);
    try {
      await createLessonLocal({
        id,
        title,
        items: items.map((text) => ({ id: crypto.randomUUID(), text })),
      });
      formRef.current?.reset();
      if (typeof navigator !== "undefined" && navigator.onLine) {
        await flushOutboxNow(); // apply the create so the RSC lesson page can load it
        startNavigation(() => router.push(`/lessons/${id}`));
      } else {
        requestFlush(); // queued — will apply on reconnect; already visible in the list
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form ref={formRef} onSubmit={onSubmit}>
      <input
        name="title"
        placeholder="Title (optional — defaults to today's date)"
        maxLength={120}
        style={{ marginBottom: "0.5rem" }}
      />
      <textarea
        name="items"
        required
        rows={5}
        placeholder={
          "One word, phrase, or sentence per line, e.g.\nephemeral\nbreak the ice\nI couldn't agree more"
        }
      />
      <button type="submit" disabled={busy}>
        {busy ? "Creating…" : "Create lesson"}
      </button>
    </form>
  );
}
