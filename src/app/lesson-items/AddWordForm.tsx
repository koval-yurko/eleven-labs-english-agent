"use client";

import { useEffect, useRef, useState } from "react";
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
  const [offline, setOffline] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  // navigator.onLine is only read in the browser: rendered offline state would be a hydration
  // mismatch, and the server has no opinion about the client's connection.
  useEffect(() => {
    const sync = () => setOffline(!navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

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
        // The list wouldn't change (owner_items groups by norm_key), so say it out loud.
        setFeedback({ tone: "warn", message: `“${result.text}” is already in your collection.` });
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
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <input
            type="text"
            name="text"
            placeholder="ubiquitous"
            aria-label="Word, phrase, or sentence to add"
            autoComplete="off"
            disabled={offline}
            style={{ flex: 1 }}
          />
          <button type="submit" disabled={busy || offline}>
            {busy ? "Adding…" : "Add"}
          </button>
        </div>
      </form>

      <p className="muted" style={{ marginBottom: 0 }}>
        {offline ? (
          "Offline — adding a word needs a connection."
        ) : feedback ? (
          <span style={{ color: feedback.tone === "ok" ? "var(--ok)" : "var(--warn)" }}>
            {feedback.message}
          </span>
        ) : (
          "Goes straight to your collection — you can put it in a lesson any time."
        )}
      </p>
    </section>
  );
}
