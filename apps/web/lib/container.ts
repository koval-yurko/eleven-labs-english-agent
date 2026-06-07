import { systemClock, createUuidGenerator, type Clock, type IdGenerator } from "./ports";
import { GenerationRunner } from "./generation/runner";
import { buildGenerateLessonDeps, createLogger } from "./generation/deps";
import { InMemoryAudioStorage, type AudioStorage } from "./generation/storage";
import { InMemoryLessonRepository } from "./lessons/in-memory-repository";
import type { LessonRepository } from "./lessons/repository";
import { LessonService } from "./lessons/service";
import { fireAndForgetScheduler } from "./lessons/scheduler";
import { AUDIO_BUCKET, getServiceSupabase, hasSupabaseEnv } from "./supabase/server";
import { SupabaseLessonRepository } from "./supabase/lesson-repository";
import { SupabaseAudioStorage } from "./supabase/audio-storage";
import { InMemoryQaRepository } from "./qa/in-memory-repository";
import type { QaRepository } from "./qa/repository";
import { SupabaseQaRepository } from "./supabase/qa-repository";
import { QaService } from "./qa/service";
import { LiveTutorService } from "./live-tutor/service";
import { liveTutorConfig } from "./live-tutor/availability";
import type { Logger } from "@idiomatic/generator";

/**
 * Composition root. Uses Supabase + Storage when configured; otherwise an in-memory
 * stack so the app runs locally and CI runs without live services (research R11).
 * Services are process singletons sharing one repository instance (so the in-memory
 * stack persists across the dev session and all features see the same lessons).
 */
interface Infra {
  ids: IdGenerator;
  clock: Clock;
  repo: LessonRepository;
  qaRepo: QaRepository;
  storage: AudioStorage;
  logger: Logger;
}

let infra: Infra | null = null;

function getInfra(): Infra {
  if (infra) return infra;
  const ids = createUuidGenerator();
  const clock = systemClock;
  const logger = createLogger();

  let repo: LessonRepository;
  let qaRepo: QaRepository;
  let storage: AudioStorage;

  if (hasSupabaseEnv()) {
    const db = getServiceSupabase();
    repo = new SupabaseLessonRepository(db, ids, clock);
    qaRepo = new SupabaseQaRepository(db, ids, clock);
    storage = new SupabaseAudioStorage(db, AUDIO_BUCKET);
  } else {
    repo = new InMemoryLessonRepository(ids, clock);
    qaRepo = new InMemoryQaRepository(ids, clock);
    storage = new InMemoryAudioStorage();
  }

  infra = { ids, clock, repo, qaRepo, storage, logger };
  return infra;
}

let lessonService: LessonService | null = null;

export function getLessonService(): LessonService {
  if (lessonService) return lessonService;
  const { repo, storage, logger } = getInfra();

  const deps = buildGenerateLessonDeps();
  const runner = new GenerationRunner(repo, storage, deps, logger);

  const signedUrlTtl = Number.parseInt(process.env.SIGNED_URL_TTL_SECONDS ?? "", 10);
  lessonService = new LessonService(
    repo,
    runner,
    storage,
    fireAndForgetScheduler,
    {
      maxTeachableItems: deps.config.maxTeachableItems,
      targetMinSeconds: deps.config.targetMinSeconds,
      targetMaxSeconds: deps.config.targetMaxSeconds,
      // Short-lived playback URLs; tighten/loosen via env (default 5 min).
      signedUrlTtlSeconds: Number.isNaN(signedUrlTtl) ? 300 : signedUrlTtl,
    },
    logger,
  );
  return lessonService;
}

let liveTutorService: LiveTutorService | null = null;

export function getLiveTutorService(): LiveTutorService {
  if (liveTutorService) return liveTutorService;
  const { repo, logger } = getInfra();
  liveTutorService = new LiveTutorService(repo, liveTutorConfig(), logger);
  return liveTutorService;
}

let qaService: QaService | null = null;

export function getQaService(): QaService {
  if (qaService) return qaService;
  const { repo, qaRepo, logger } = getInfra();
  qaService = new QaService(repo, qaRepo, logger);
  return qaService;
}
