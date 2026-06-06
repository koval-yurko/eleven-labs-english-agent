import type { GenerateLessonDeps } from "@idiomatic/generator";
import type { Clock, IdGenerator } from "../lib/ports.js";
import { GenerationRunner } from "../lib/generation/runner.js";
import { buildGenerateLessonDeps } from "../lib/generation/deps.js";
import { InMemoryAudioStorage } from "../lib/generation/storage.js";
import { InMemoryLessonRepository } from "../lib/lessons/in-memory-repository.js";
import { LessonService } from "../lib/lessons/service.js";
import { CollectingScheduler } from "../lib/lessons/scheduler.js";

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

export function makeHarness(options: { env?: NodeJS.ProcessEnv; deps?: GenerateLessonDeps } = {}) {
  const ids = counterIdGenerator();
  const clock = fixedClock();
  const repo = new InMemoryLessonRepository(ids, clock);
  const storage = new InMemoryAudioStorage();
  const deps = options.deps ?? buildGenerateLessonDeps(options.env ?? {});
  const runner = new GenerationRunner(repo, storage, deps);
  const scheduler = new CollectingScheduler();
  const service = new LessonService(repo, runner, storage, scheduler, {
    maxTeachableItems: deps.config.maxTeachableItems,
    targetMinSeconds: deps.config.targetMinSeconds,
    targetMaxSeconds: deps.config.targetMaxSeconds,
    signedUrlTtlSeconds: 600,
  });
  return { service, scheduler, repo, storage };
}
