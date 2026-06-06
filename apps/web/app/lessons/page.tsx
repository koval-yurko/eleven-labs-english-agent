import { getOwnerId } from "../../lib/auth/session";
import { getLessonService } from "../../lib/container";

/** Lesson library (T040, FR-020). Server component — owner-scoped list, newest first. */
export default async function LessonsPage() {
  const ownerId = await getOwnerId();
  if (!ownerId) {
    return (
      <p>
        Please <a href="/auth/login">sign in</a> to view your lessons.
      </p>
    );
  }

  const lessons = await getLessonService().listLessons(ownerId);

  return (
    <section>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Your lessons</h1>
        <a href="/lessons/new">
          <button>+ New lesson</button>
        </a>
      </div>

      {lessons.length === 0 ? (
        <p className="muted">
          No lessons yet. <a href="/lessons/new">Create your first lesson</a> from a list of
          words, sentences, or idioms.
        </p>
      ) : (
        lessons.map((l) => (
          <a key={l.id} href={`/lessons/${l.id}`} style={{ textDecoration: "none", color: "inherit" }}>
            <div className="panel">
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <strong>{l.itemPreview.slice(0, 3).join(", ") || "Lesson"}</strong>
                <span className="muted">{statusLabel(l.status)}</span>
              </div>
              <div className="muted" style={{ fontSize: "0.875rem", marginTop: "0.35rem" }}>
                {l.acceptedItemCount} item{l.acceptedItemCount === 1 ? "" : "s"}
                {l.audioDurationSeconds ? ` · ${formatDuration(l.audioDurationSeconds)}` : ""} ·{" "}
                {new Date(l.createdAt).toLocaleString()}
              </div>
            </div>
          </a>
        ))
      )}
    </section>
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case "ready":
      return "▶ Ready";
    case "failed":
      return "⚠ Failed";
    default:
      return "… Generating";
  }
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
