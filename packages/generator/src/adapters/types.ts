import type { LessonScript } from "@idiomatic/contracts";
import type { ClassifiedItem } from "../teachability.js";

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

/** The generation brain (Claude via a Mastra workflow). Produces a LessonScript draft. */
export interface LlmAdapter {
  readonly modelId: string;
  readonly promptVersion: string;
  draftScript(request: ScriptDraftRequest): Promise<LessonScript>;
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
  renderDialogue(script: LessonScript, ttsCharLimit: number): Promise<RenderedAudio>;
}
