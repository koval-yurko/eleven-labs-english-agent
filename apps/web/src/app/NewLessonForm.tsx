"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Field } from "@base-ui/react/field";
import { Form } from "@base-ui/react/form";
import { Button } from "./Button";
import {
  createLessonLocal,
  defaultLessonTitle,
  flushOutboxNow,
  requestFlush,
} from "../lib/sync/engine";
import { MAX_ITEMS } from "@tutor/shared/offline/ops";
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
    const texts = String(fd.get("items") ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, MAX_ITEMS);
    if (!texts[0]) return;

    // `createLessonLocal` normalizes and caps the title itself; an empty box falls back to today's
    // date. Item ids are minted inside the engine, from the same rule the add path uses.
    const title = String(fd.get("title") ?? "").trim() || (await defaultLessonTitle());
    const id = crypto.randomUUID();

    setBusy(true);
    try {
      await createLessonLocal({ id, title, texts });
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
    // Base UI's Form sets `noValidate` and focuses the first invalid control itself. That's the
    // point of using it here: the `required` textarea below used to fail into the browser's own
    // validation bubble, which Chrome, Safari and Firefox each draw differently and which vanishes
    // on its own — the same OS-widget problem as the old <select>. The message is now ours, in the
    // page, styled like everything else.
    <Form ref={formRef} onSubmit={onSubmit}>
      <Field.Root name="title">
        <Field.Control
          // Placeholder-only was the whole accessible name, and it disappears once you type.
          aria-label="Lesson title (optional)"
          placeholder="Title (optional — defaults to today's date)"
          maxLength={120}
          style={{ marginBottom: "0.5rem" }}
        />
      </Field.Root>

      <Field.Root name="items">
        <Field.Control
          render={<textarea rows={5} />}
          required
          aria-label="Words, phrases, or sentences — one per line"
          placeholder={
            "One word, phrase, or sentence per line, e.g.\nephemeral\nbreak the ice\nI couldn't agree more"
          }
        />
        <Field.Error className="field-error" match="valueMissing">
          Add at least one word, phrase, or sentence.
        </Field.Error>
      </Field.Root>

      <Button type="submit" disabled={busy}>
        {busy ? "Creating…" : "Create lesson"}
      </Button>
    </Form>
  );
}
