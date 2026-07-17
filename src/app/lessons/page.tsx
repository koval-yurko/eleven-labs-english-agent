import { getOwnerId } from "../../lib/auth/session";
import { listLessons } from "../../lib/lessons";
import { LessonsList } from "../LessonsList";
import { NewLessonForm } from "../NewLessonForm";

// Per-request rendering: the list is owner-scoped (cookies) and changes between visits.
export const dynamic = "force-dynamic";

/** The learner's word sets — create a new lesson or open one to practice. */
export default async function LessonsPage() {
  const ownerId = await getOwnerId();
  const lessons = ownerId ? await listLessons(ownerId) : [];

  return (
    <>
      <h1>Lessons</h1>
      <p className="muted">
        A lesson is a set of words, phrases, or sentences you&apos;re learning. Open one to talk
        it through with the tutor and revisit past conversations.
      </p>

      <section className="panel">
        <h2>New lesson</h2>
        <NewLessonForm />
      </section>

      <section className="panel">
        <h2>Your lessons</h2>
        {ownerId ? (
          <LessonsList ownerSub={ownerId} initial={lessons} />
        ) : (
          <p className="muted">No lessons yet — create your first one above.</p>
        )}
      </section>
    </>
  );
}
