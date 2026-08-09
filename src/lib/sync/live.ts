"use client";

/**
 * Reactive reads of the mirror — the one part of the offline layer that is NOT behind the
 * `MirrorStore` contract, on purpose.
 *
 * Dexie's `liveQuery` hooks IndexedDB's own mutation events, so a component re-renders the instant
 * a write lands anywhere in the app. There is no honest platform-neutral version of that: a SQLite
 * adapter would need its own change notification, and an abstraction pretending otherwise would be
 * a lie with a type signature. So the subscription model stays per-platform and is confined HERE,
 * behind three named hooks.
 *
 * That makes the port surface explicit and small: one `MirrorStore` implementation plus these three
 * hooks. Before this, three components built Dexie query expressions inline, which meant the UI
 * itself was welded to IndexedDB. See docs/2026-08-09-shareable-core-refactor.md (R5, stage 2).
 *
 * Each hook takes the server-rendered rows as `initial`, which Dexie uses as the value on the very
 * first render (before IndexedDB answers) — that is what keeps the list from flashing empty.
 */
import { useLiveQuery } from "dexie-react-hooks";
import { getDb } from "./db";
import type { MirrorItem, MirrorLesson } from "../../shared/mirror-store";

/** Every mirrored lesson, newest first. */
export function useMirrorLessons(initial?: MirrorLesson[]): MirrorLesson[] {
  return (
    useLiveQuery(() => getDb().lessons.orderBy("created_at").reverse().toArray(), [], initial) ??
    initial ??
    []
  );
}

/**
 * One mirrored lesson. The result is wrapped so "still loading" (`undefined`) stays distinct from
 * "not in the mirror" (`{ lesson: undefined }`) — the offline shell needs to tell those apart to
 * choose between a spinner and "not available offline".
 */
export function useMirrorLesson(id: string): { lesson: MirrorLesson | undefined } | undefined {
  return useLiveQuery(async () => ({ lesson: await getDb().lessons.get(id) }), [id]);
}

/** One lesson's active items, in position order. */
export function useMirrorItems(lessonId: string, initial?: MirrorItem[]): MirrorItem[] {
  return (
    useLiveQuery(
      () => getDb().items.where("lesson_id").equals(lessonId).sortBy("position"),
      [lessonId],
      initial,
    ) ??
    initial ??
    []
  );
}
