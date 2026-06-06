"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Submit form (T031). Posts a list to /api/lessons and routes to the new lesson. */
export default function NewLessonPage() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<{ rawText: string; reason: string }[]>([]);

  async function submit() {
    setSubmitting(true);
    setError(null);
    setSkipped([]);
    try {
      const res = await fetch("/api/lessons", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: text }),
      });
      const data = await res.json();
      if (res.status === 202) {
        router.push(`/lessons/${data.id}`);
        return;
      }
      // Guardrail responses (FR-004/005/006/007).
      setError(data?.error?.message ?? "Something went wrong.");
      if (Array.isArray(data?.skipped)) setSkipped(data.skipped);
    } catch {
      setError("Network error — please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section>
      <h1>New lesson</h1>
      <p className="muted">
        Paste the words, sentences, or idioms you want to learn — one per line. We&apos;ll turn
        them into a short two-voice podcast that teaches each one through a little story.
      </p>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"break the ice\nspill the beans\nunder the weather"}
        disabled={submitting}
      />

      {error && (
        <div className="panel">
          <p className="error" style={{ margin: 0 }}>
            {error}
          </p>
          {skipped.length > 0 && (
            <ul className="muted" style={{ marginBottom: 0 }}>
              {skipped.map((s, i) => (
                <li key={i}>
                  &ldquo;{s.rawText}&rdquo; — {s.reason.replace(/_/g, " ")}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div style={{ marginTop: "1rem" }}>
        <button onClick={submit} disabled={submitting || text.trim().length === 0}>
          {submitting ? "Generating…" : "Generate lesson"}
        </button>{" "}
        <a href="/lessons" className="muted">
          Cancel
        </a>
      </div>
    </section>
  );
}
