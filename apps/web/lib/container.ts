import { systemClock, createUuidGenerator, type Clock, type IdGenerator } from "./ports";
import { GenerationRunner } from "./generation/runner";
import { buildGenerateLessonDeps, createLogger } from "./generation/deps";
import { InMemoryLessonRepository } from "./lessons/in-memory-repository";
import type { LessonRepository } from "./lessons/repository";
import { LessonService } from "./lessons/service";
import { fireAndForgetScheduler } from "./lessons/scheduler";
import { getServiceSupabase, hasSupabaseEnv } from "./supabase/server";
import { SupabaseLessonRepository } from "./supabase/lesson-repository";
import {
  InMemoryLiveStoryRepository,
  OtelWebhookService,
  StartStoryService,
  SweepService,
  TranscriptService,
  type LiveStoryRepository,
} from "@idiomatic/live-story";
import { SupabaseLiveStoryRepository } from "./supabase/live-story-repository";
import { liveStoryConfig, liveStoryTracingConfig } from "./config";
import { createLangSmithSessionTracer, type Logger } from "@idiomatic/generator";

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
  // Soft LangSmith dep: a no-op unless LANGSMITH_API_KEY is set (mirrors generation tracing).
  transcriptService = new TranscriptService(
    repo,
    liveStoryRepo,
    logger,
    createLangSmithSessionTracer(),
  );
  return transcriptService;
}

let otelWebhookService: OtelWebhookService | null = null;

export function getOtelWebhookService(): OtelWebhookService {
  if (otelWebhookService) return otelWebhookService;
  const { liveStoryRepo, logger } = getInfra();
  // The live-story repo here is the service-role Supabase client (or in-memory in dev/CI), so
  // the correlation lookup can resolve a conversation id to its owner without a learner session.
  const tracing = liveStoryTracingConfig();
  otelWebhookService = new OtelWebhookService(liveStoryRepo, {
    webhookSecret: tracing.webhookSecret,
    langsmithProject: tracing.langsmithProject,
    langsmithEndpoint: tracing.langsmithEndpoint,
    logger,
  });
  return otelWebhookService;
}

let sweepService: SweepService | null = null;

export function getSweepService(): SweepService {
  if (sweepService) return sweepService;
  const { liveStoryRepo, logger } = getInfra();
  // Soft LangSmith dep: the finalized abandoned-session trace no-ops without LANGSMITH_API_KEY.
  sweepService = new SweepService(liveStoryRepo, createLangSmithSessionTracer(), logger);
  return sweepService;
}
