"use client";

import { use, useCallback, useEffect, useState } from "react";
import { LiveStoryProvider } from "./live-story/LiveStoryProvider";
import { TranscriptReview } from "./live-story/TranscriptReview";

/** Lesson detail: status polling (FR-015) + live-story experience + retry (FR-016). */

interface LessonDetail {
  id: string;
  status: "pending" | "generating" | "ready" | "failed";
  acceptedItemCount: number;
  errorReason: string | null;
  skipped: { rawText: string; reason: string }[];
  items: { normalizedText: string; itemType: string; covered: boolean }[];
}

export default function LessonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [lesson, setLesson] = useState<LessonDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [retrying, setRetrying] = useState(false);
  // Bumped when a live-story session ends so the transcript re-fetches without a reload.
  const [transcriptRefresh, setTranscriptRefresh] = useState(0);

  const load = useCallback(async () => {
    const res = await fetch(`/api/lessons/${id}`, { cache: "no-store" });
    if (res.status === 404) {
      setNotFound(true);
      return null;
    }
    if (res.ok) {
      const data = (await res.json()) as LessonDetail;
      setLesson(data);
      return data;
    }
    return null;
  }, [id]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      const data = await load();
      if (!active) return;
      // Poll until terminal (FR-015 / SC-008 — no indefinite silent wait).
      if (data && (data.status === "pending" || data.status === "generating")) {
        timer = setTimeout(tick, 2500);
      }
    };
    void tick();

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [load]);

  async function retry() {
    setRetrying(true);
    try {
      await fetch(`/api/lessons/${id}/retry`, { method: "POST" });
      await load();
    } finally {
      setRetrying(false);
    }
  }

  if (notFound) {
    return (
      <p>
        Lesson not found. <a href="/lessons">Back to your lessons</a>.
      </p>
    );
  }

  if (!lesson) return <p className="muted">Loading…</p>;

  return (
    <section>
      <a href="/lessons" className="muted">
        ← All lessons
      </a>
      <h1>Lesson</h1>

      {(lesson.status === "pending" || lesson.status === "generating") && (
        <div className="panel">
          <p className="warn" style={{ margin: 0 }}>
            ⏳ Creating your lesson… this page will update automatically.
          </p>
          <p className="muted" style={{ marginBottom: 0 }}>
            Generation can take a few minutes — feel free to leave this page and come back.
          </p>
        </div>
      )}

      {lesson.status === "failed" && (
        <div className="panel">
          <p className="error" style={{ marginTop: 0 }}>
            ⚠ Generation didn&apos;t complete{lesson.errorReason ? `: ${lesson.errorReason}` : "."}
          </p>
          <button onClick={retry} disabled={retrying}>
            {retrying ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}

      {/* Adaptive, interruptible live-narrated lesson — the sole experience (006/007). */}
      {lesson.status === "ready" && (
        <LiveStoryProvider
          lessonId={lesson.id}
          onSessionEnd={() => setTranscriptRefresh((n) => n + 1)}
        />
      )}

      {/* Durable transcript of past live-story sessions (006, FR-024) — no audio player. */}
      {lesson.status === "ready" && (
        <TranscriptReview lessonId={lesson.id} refreshKey={transcriptRefresh} />
      )}

      {lesson.items.length > 0 && (
        <div className="panel">
          <strong>Taught in this lesson</strong>
          <ul style={{ marginBottom: 0 }}>
            {lesson.items.map((it, i) => (
              <li key={i}>
                {it.normalizedText} <span className="muted">({it.itemType})</span>{" "}
                {it.covered ? <span className="ok">✓</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      {lesson.skipped.length > 0 && (
        <div className="panel">
          <strong className="muted">Skipped entries</strong>
          <ul className="muted" style={{ marginBottom: 0 }}>
            {lesson.skipped.map((s, i) => (
              <li key={i}>
                &ldquo;{s.rawText}&rdquo; — {s.reason.replace(/_/g, " ")}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
