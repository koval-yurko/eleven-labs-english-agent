"use client";

import { useRef, useState } from "react";
import { Field } from "@base-ui/react/field";
import { Button } from "../Button";
import { useOnline } from "../useOnline";
import { addWordAction } from "./actions";

type Feedback = { tone: "ok" | "warn"; message: string } | null;

/**
 * Add one word straight to the collection, with no lesson.
 *
 * Single-line on purpose: the ask is an *individual* word. A textarea would invite bulk paste, and
 * a bulk paste wants a lesson to live in — that flow already exists on the lesson page.
 *
 * Online-only (see `addWordAction`), so the form says so rather than queueing an intent this page
 * cannot render. No item cap either: the 50 is a per-LESSON constraint and there is no lesson here.
 */
export function AddWordForm() {
  const formRef = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  // Hydration-safe by construction — see `useOnline`, which this effect used to be a copy of.
  const offline = !useOnline();

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const text = String(new FormData(e.currentTarget).get("text") ?? "").trim();
    if (!text || busy) return;

    setBusy(true);
    setFeedback(null);
    try {
      const result = await addWordAction(text);
      if (result.status === "added") {
        setFeedback({ tone: "ok", message: `Added “${result.text}”.` });
        formRef.current?.reset();
      } else if (result.status === "already-present") {
        // The list wouldn't change (owner_items groups by norm_key), so say it out loud — with the
        // count, because the add DID something: a duplicate bumps the word's popularity (0017).
        setFeedback({
          tone: "warn",
          message:
            result.popularity === null
              ? `“${result.text}” is already in your collection.`
              : `“${result.text}” is already in your collection — met ${result.popularity} ${
                  result.popularity === 1 ? "time" : "times"
                }.`,
        });
        formRef.current?.reset();
      } else {
        setFeedback({ tone: "warn", message: "Type a word first." });
      }
    } catch {
      setFeedback({ tone: "warn", message: "Couldn’t save that — check your connection." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2>Add a word</h2>
      <form ref={formRef} onSubmit={onSubmit}>
        <Field.Root>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <Field.Control
              type="text"
              name="text"
              placeholder="ubiquitous"
              aria-label="Word, phrase, or sentence to add"
              autoComplete="off"
              disabled={offline}
              style={{ flex: 1 }}
            />
            <Button type="submit" disabled={busy || offline}>
              {busy ? "Adding…" : "Add"}
            </Button>
          </div>

          {/* This line was a loose <p> next to the form: nothing connected it to the input, so a
              screen reader never read it as the field's description, and the result of a submit
              ("Added “x”.") changed silently. As Field.Description it's wired via aria-describedby;
              role="status" is what makes the swap to feedback announced rather than merely visible. */}
          <Field.Description
            // Field.Description renders a <div>; `render` keeps the original <p>, whose default
            // top margin is the spacing this block has always had.
            render={<p />}
            className="muted"
            role="status"
            style={{ marginBottom: 0 }}
          >
            {offline ? (
              "Offline — adding a word needs a connection."
            ) : feedback ? (
              <span style={{ color: feedback.tone === "ok" ? "var(--ok)" : "var(--warn)" }}>
                {feedback.message}
              </span>
            ) : (
              "Goes straight to your collection — you can put it in a lesson any time."
            )}
          </Field.Description>
        </Field.Root>
      </form>
    </section>
  );
}
