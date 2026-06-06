import { systemClock, createUuidGenerator } from "./ports";
import { GenerationRunner } from "./generation/runner";
import { buildGenerateLessonDeps } from "./generation/deps";
import { InMemoryAudioStorage, type AudioStorage } from "./generation/storage";
import { InMemoryLessonRepository } from "./lessons/in-memory-repository";
import type { LessonRepository } from "./lessons/repository";
import { LessonService } from "./lessons/service";
import { fireAndForgetScheduler } from "./lessons/scheduler";
import { AUDIO_BUCKET, getServiceSupabase, hasSupabaseEnv } from "./supabase/server";
import { SupabaseLessonRepository } from "./supabase/lesson-repository";
import { SupabaseAudioStorage } from "./supabase/audio-storage";

/**
 * Composition root. Uses Supabase + Storage when configured; otherwise an in-memory
 * stack so the app runs locally and CI runs without live services (research R11).
 * The service is a process singleton (the in-memory stack persists for the dev session).
 */
let service: LessonService | null = null;

export function getLessonService(): LessonService {
  if (service) return service;

  const ids = createUuidGenerator();
  const clock = systemClock;

  let repo: LessonRepository;
  let storage: AudioStorage;

  if (hasSupabaseEnv()) {
    const db = getServiceSupabase();
    repo = new SupabaseLessonRepository(db, ids, clock);
    storage = new SupabaseAudioStorage(db, AUDIO_BUCKET);
  } else {
    repo = new InMemoryLessonRepository(ids, clock);
    storage = new InMemoryAudioStorage();
  }

  const deps = buildGenerateLessonDeps();
  const runner = new GenerationRunner(repo, storage, deps);

  service = new LessonService(repo, runner, storage, fireAndForgetScheduler, {
    maxTeachableItems: deps.config.maxTeachableItems,
    targetMinSeconds: deps.config.targetMinSeconds,
    targetMaxSeconds: deps.config.targetMaxSeconds,
    signedUrlTtlSeconds: 600,
  });
  return service;
}
