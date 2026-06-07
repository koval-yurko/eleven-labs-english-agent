import { systemClock, createUuidGenerator, type Clock, type IdGenerator } from "./ports";
import { GenerationRunner } from "./generation/runner";
import { buildGenerateLessonDeps, createLogger } from "./generation/deps";
import { InMemoryLessonRepository } from "./lessons/in-memory-repository";
import type { LessonRepository } from "./lessons/repository";
import { LessonService } from "./lessons/service";
import { fireAndForgetScheduler } from "./lessons/scheduler";
import { getServiceSupabase, hasSupabaseEnv } from "./supabase/server";
import { SupabaseLessonRepository } from "./supabase/lesson-repository";
import type { LiveStoryRepository } from "./live-story/repository";
import { InMemoryLiveStoryRepository } from "./live-story/in-memory-repository";
import { SupabaseLiveStoryRepository } from "./supabase/live-story-repository";
import { StartStoryService } from "./live-story/service";
import { TranscriptService } from "./live-story/transcript-service";
import { liveStoryConfig } from "./config";
import type { Logger } from "@idiomatic/generator";

/**
 * Composition root. Uses Supabase when configured; otherwise an in-memory stack so the app
 * runs locally and CI runs without live services (research R11). Services are process
 * singletons sharing one repository instance (so the in-memory stack persists across the dev
 * session and all features see the same lessons).
 */
interface Infra {
  ids: IdGenerator;
  clock: Clock;
  repo: LessonRepository;
  liveStoryRepo: LiveStoryRepository;
  logger: Logger;
}

let infra: Infra | null = null;

function getInfra(): Infra {
  if (infra) return infra;
  const ids = createUuidGenerator();
  const clock = systemClock;
  const logger = createLogger();

  let repo: LessonRepository;
  let liveStoryRepo: LiveStoryRepository;

  if (hasSupabaseEnv()) {
    const db = getServiceSupabase();
    repo = new SupabaseLessonRepository(db, ids, clock);
    liveStoryRepo = new SupabaseLiveStoryRepository(db, ids, clock);
  } else {
    repo = new InMemoryLessonRepository(ids, clock);
    liveStoryRepo = new InMemoryLiveStoryRepository(ids, clock);
  }

  infra = { ids, clock, repo, liveStoryRepo, logger };
  return infra;
}

let lessonService: LessonService | null = null;

export function getLessonService(): LessonService {
  if (lessonService) return lessonService;
  const { repo, logger } = getInfra();

  const deps = buildGenerateLessonDeps();
  const runner = new GenerationRunner(repo, deps, logger);

  lessonService = new LessonService(
    repo,
    runner,
    fireAndForgetScheduler,
    {
      maxTeachableItems: deps.config.maxTeachableItems,
      targetMinSeconds: deps.config.targetMinSeconds,
      targetMaxSeconds: deps.config.targetMaxSeconds,
    },
    logger,
  );
  return lessonService;
}

let startStoryService: StartStoryService | null = null;

export function getStartStoryService(): StartStoryService {
  if (startStoryService) return startStoryService;
  const { repo, liveStoryRepo, logger } = getInfra();
  startStoryService = new StartStoryService(repo, liveStoryRepo, liveStoryConfig(), logger);
  return startStoryService;
}

let transcriptService: TranscriptService | null = null;

export function getTranscriptService(): TranscriptService {
  if (transcriptService) return transcriptService;
  const { repo, liveStoryRepo, logger } = getInfra();
  transcriptService = new TranscriptService(repo, liveStoryRepo, logger);
  return transcriptService;
}
