import type { LessonScript } from "@idiomatic/contracts";
import type { ClassifiedItem } from "../teachability";
import type { Logger } from "../observability";

/**
 * Provider adapter boundaries (research R11). Business logic depends on these
 * interfaces, never on vendor SDK types — so the coverage/length/privacy invariants
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

export interface RenderedAudio {
  /** Stitched audio bytes for the whole lesson (research R5). */
  bytes: Uint8Array;
  mimeType: string;
  /** Measured total duration of the stitched asset (SC-003). */
  durationSeconds: number;
}

/** ElevenLabs Text to Dialogue: render per-segment under the char limit, then stitch. */
export interface TtsAdapter {
  /**
   * Render + stitch the dialogue. The optional `logger` (003-internal-logging) receives a
   * `render.batch` timing per batch; omitting it leaves rendering behavior unchanged.
   */
  renderDialogue(
    script: LessonScript,
    ttsCharLimit: number,
    logger?: Logger,
  ): Promise<RenderedAudio>;
  /** Cheap liveness/config check (e.g. validate the API key + configured voices). */
  healthCheck?(): Promise<ProviderHealth>;
}
