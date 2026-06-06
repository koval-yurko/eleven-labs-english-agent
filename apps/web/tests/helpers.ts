import type { GenerateLessonDeps } from "@idiomatic/generator";
import type { Clock, IdGenerator } from "../lib/ports";
import { GenerationRunner } from "../lib/generation/runner";
import { buildGenerateLessonDeps } from "../lib/generation/deps";
import { InMemoryAudioStorage } from "../lib/generation/storage";
import { InMemoryLessonRepository } from "../lib/lessons/in-memory-repository";
import { LessonService } from "../lib/lessons/service";
import { CollectingScheduler } from "../lib/lessons/scheduler";

/** Deterministic test harness wiring the service over in-memory infra + mock generator. */

export function counterIdGenerator(prefix = "id"): IdGenerator {
  let n = 0;
  return { next: () => `${prefix}-${n++}` };
}

export function fixedClock(startIso = "2026-06-06T10:00:00.000Z"): Clock {
  let ms = Date.parse(startIso);
  return {
    now: () => {
      const d = new Date(ms);
      ms += 1000; // advance 1s per call so createdAt ordering is stable
      return d;
    },
  };
}

/**
 * A single "session": a fresh LessonService + scheduler over the given shared infra
 * and generator deps. Two sessions over the same repo/storage simulate the same learner
 * signing out and back in (T035 — cross-session replay, FR-018/SC-006).
 */
export function makeSession(
  repo: InMemoryLessonRepository,
  storage: InMemoryAudioStorage,
  deps: GenerateLessonDeps,
) {
  const runner = new GenerationRunner(repo, storage, deps);
  const scheduler = new CollectingScheduler();
  const service = new LessonService(repo, runner, storage, scheduler, {
    maxTeachableItems: deps.config.maxTeachableItems,
    targetMinSeconds: deps.config.targetMinSeconds,
    targetMaxSeconds: deps.config.targetMaxSeconds,
    signedUrlTtlSeconds: 600,
  });
  return { service, scheduler };
}

export function makeHarness(
  options: { env?: Record<string, string | undefined>; deps?: GenerateLessonDeps } = {},
) {
  const ids = counterIdGenerator();
  const clock = fixedClock();
  const repo = new InMemoryLessonRepository(ids, clock);
  const storage = new InMemoryAudioStorage();
  const deps = options.deps ?? buildGenerateLessonDeps(options.env ?? {});
  const { service, scheduler } = makeSession(repo, storage, deps);
  return { service, scheduler, repo, storage, deps };
}
