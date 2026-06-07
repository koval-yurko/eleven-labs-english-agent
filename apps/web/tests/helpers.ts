import { JsonLogger, type GenerateLessonDeps, type Level, type LogEntry, type Logger } from "@idiomatic/generator";
import type { Clock, IdGenerator } from "../lib/ports";
import { GenerationRunner } from "../lib/generation/runner";
import { buildGenerateLessonDeps } from "../lib/generation/deps";
import { InMemoryAudioStorage } from "../lib/generation/storage";
import { InMemoryLessonRepository } from "../lib/lessons/in-memory-repository";
import { LessonService } from "../lib/lessons/service";
import { CollectingScheduler } from "../lib/lessons/scheduler";

/** Deterministic test harness wiring the service over in-memory infra + mock generator. */

/**
 * A real `JsonLogger` writing to an in-memory sink, with parsed entries for assertions.
 * Exercises the true serialization + redaction path (better for lifecycle / secret-scan
 * tests than a pure double). `entries` are the parsed NDJSON lines; `raw` are the lines.
 */
export function captureLogger(level: Level = "debug") {
  const raw: string[] = [];
  const logger: Logger = new JsonLogger({
    level,
    sink: (line) => raw.push(line),
    now: () => "2026-06-06T10:00:00.000Z",
  });
  return {
    logger,
    raw,
    get entries(): LogEntry[] {
      return raw.map((l) => JSON.parse(l) as LogEntry);
    },
    forLesson(lessonId: string): LogEntry[] {
      return raw.map((l) => JSON.parse(l) as LogEntry).filter((e) => e.lessonId === lessonId);
    },
  };
}

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
  logger?: Logger,
) {
  const runner = new GenerationRunner(repo, storage, deps, logger);
  const scheduler = new CollectingScheduler();
  const service = new LessonService(
    repo,
    runner,
    storage,
    scheduler,
    {
      maxTeachableItems: deps.config.maxTeachableItems,
      targetMinSeconds: deps.config.targetMinSeconds,
      targetMaxSeconds: deps.config.targetMaxSeconds,
      signedUrlTtlSeconds: 600,
    },
    logger,
  );
  return { service, scheduler };
}

export function makeHarness(
  options: {
    env?: Record<string, string | undefined>;
    deps?: GenerateLessonDeps;
    logger?: Logger;
  } = {},
) {
  const ids = counterIdGenerator();
  const clock = fixedClock();
  const repo = new InMemoryLessonRepository(ids, clock);
  const storage = new InMemoryAudioStorage();
  const deps = options.deps ?? buildGenerateLessonDeps(options.env ?? {});
  const { service, scheduler } = makeSession(repo, storage, deps, options.logger);
  return { service, scheduler, repo, storage, deps };
}
