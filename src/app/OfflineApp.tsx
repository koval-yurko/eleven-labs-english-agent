"use client";

import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { getDb } from "../lib/sync/db";
import { LessonsList } from "./LessonsList";
import { LessonItemsView } from "./lessons/[id]/LessonItemsView";

/**
 * The offline app-shell. The service worker serves this page's cached HTML for ANY navigation
 * that can't reach the network (see public/sw.js), so `location.pathname` here is the route the
 * user actually asked for. We read it and render that view from the IndexedDB mirror — the
 * lessons list (`/`) or one lesson's words (`/lessons/[id]`), still editable via the outbox.
 *
 * Progressive enhancement: the server-rendered / first-paint output is a plain offline notice
 * (works even if the mirror or this route's JS never loaded); once mounted, it upgrades to the
 * mirror-backed view. On reconnect it reloads so the full server-rendered page takes over.
 */
export function OfflineApp() {
  const [path, setPath] = useState<string | null>(null);

  useEffect(() => {
    setPath(window.location.pathname);
    const reload = () => window.location.reload(); // reconnected — get the real page back
    window.addEventListener("online", reload);
    return () => window.removeEventListener("online", reload);
  }, []);

  if (path === null) return <OfflineNotice />; // SSR + first paint (pre-hydration)
  if (path === "/" || path === "/lessons") return <OfflineHome />;
  const lessonId = path.match(/^\/lessons\/([^/]+)\/?$/)?.[1];
  if (lessonId) return <OfflineLesson id={decodeURIComponent(lessonId)} />;
  return <OfflineNotice />;
}

function OfflineBanner() {
  return (
    <p className="muted" style={{ color: "var(--error)" }}>
      Offline — showing your saved copy. Voice practice and history need a connection.
    </p>
  );
}

/* The links out of the offline shell stay plain anchors on purpose: this page exists precisely
   when the network is down, and a hard navigation is what lets the service worker answer (a
   client-side one would fetch an RSC payload the SW doesn't intercept). Once connectivity is back,
   the anchor navigates for real. See docs/2026-07-26-navigation-progress-bar.md. */
function OfflineNotice() {
  return (
    <section className="panel">
      <h1>You&rsquo;re offline</h1>
      <p className="muted">
        English Tutor can&rsquo;t reach the network right now. Your saved lessons are available from
        here; reconnect for voice practice and history.
      </p>
      <p>
        <a href="/lessons">← your lessons</a>
      </p>
    </section>
  );
}

function OfflineHome() {
  return (
    <>
      <h1>Lessons</h1>
      <OfflineBanner />
      <section className="panel">
        <h2>Your lessons</h2>
        <LessonsList />
      </section>
    </>
  );
}

function OfflineLesson({ id }: { id: string }) {
  // Wrap the result so "still loading" (undefined) is distinct from "not in the mirror" ({lesson: undefined}).
  const result = useLiveQuery(async () => ({ lesson: await getDb().lessons.get(id) }), [id]);

  if (result === undefined) {
    return (
      <section className="panel">
        <p className="muted">Loading your saved copy…</p>
      </section>
    );
  }
  if (!result.lesson) {
    return (
      <section className="panel">
        <h1>Not available offline</h1>
        <p className="muted">
          You haven&rsquo;t opened this lesson on this device yet, so there&rsquo;s no saved copy.
          Reconnect to load it.
        </p>
        <p>
          <a href="/lessons">← your lessons</a>
        </p>
      </section>
    );
  }

  return (
    <>
      <h1>{result.lesson.title}</h1>
      <OfflineBanner />
      <section className="panel">
        <h2>Words in this lesson</h2>
        <LessonItemsView lessonId={id} />
      </section>
    </>
  );
}
