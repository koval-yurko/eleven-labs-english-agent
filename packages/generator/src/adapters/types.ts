import type { LessonScript } from "@idiomatic/contracts";
import type { ClassifiedItem } from "../teachability";

/**
 * Provider adapter boundaries (research R11). Business logic depends on these
 * interfaces, never on vendor SDK types — so the coverage/privacy invariants
 * are testable against mocks with no live keys (Constitution Dev Workflow).
 */

export interface ScriptDraftRequest {
  acceptedItems: ClassifiedItem[];
  teacherVoiceId: string;
  learnerVoiceId: string;
  targetMinSeconds: number;
  targetMaxSeconds: number;
  wordsPerMinute: number;
}

/** Result of a provider preflight check (no generation, just reachability/config). */
export interface ProviderHealth {
  provider: string;
  ok: boolean;
  detail: string;
}

/** The generation brain (Claude via a Mastra workflow). Produces a LessonScript draft. */
export interface LlmAdapter {
  readonly modelId: string;
  readonly promptVersion: string;
  draftScript(request: ScriptDraftRequest): Promise<LessonScript>;
  /** Cheap liveness/config check (e.g. validate the API key + model). */
  healthCheck?(): Promise<ProviderHealth>;
}
