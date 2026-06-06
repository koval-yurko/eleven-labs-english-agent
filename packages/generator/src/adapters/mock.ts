import type { CoverageEntry, LessonScript, LessonSegment } from "@idiomatic/contracts";
import { LESSON_SCRIPT_VERSION } from "@idiomatic/contracts";
import type {
  LlmAdapter,
  ProviderHealth,
  RenderedAudio,
  ScriptDraftRequest,
  TtsAdapter,
} from "./types";

/**
 * Deterministic mock adapters for CI/tests (research R11). They produce a valid,
 * coverage-complete LessonScript and a duration derived from word count — enough to
 * exercise the orchestrator and the coverage guarantee without live keys.
 */

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export class MockLlmAdapter implements LlmAdapter {
  readonly modelId = "mock-llm-1";
  readonly promptVersion = "mock-prompt-1";

  async healthCheck(): Promise<ProviderHealth> {
    return { provider: "claude", ok: true, detail: "mock adapter (no API key configured)" };
  }

  async draftScript(request: ScriptDraftRequest): Promise<LessonScript> {
    const segments: LessonSegment[] = [];
    const coverage: CoverageEntry[] = [];

    segments.push({
      id: "seg-intro-learner",
      speaker: "learner",
      text: "I brought a few expressions I keep tripping over. Can you walk me through them?",
      audioTags: ["curious"],
    });
    segments.push({
      id: "seg-intro-teacher",
      speaker: "teacher",
      text: "Of course — let's turn each one into a little story you'll remember.",
      audioTags: ["warm"],
    });

    request.acceptedItems.forEach((item, idx) => {
      const teacherSegId = `seg-${idx}-teacher`;
      const learnerSegId = `seg-${idx}-learner`;
      segments.push({
        id: teacherSegId,
        speaker: "teacher",
        text: `Picture this: someone uses "${item.normalizedText}" in the middle of an ordinary afternoon, and suddenly the whole scene makes sense.`,
        audioTags: ["warm", "storytelling"],
      });
      segments.push({
        id: learnerSegId,
        speaker: "learner",
        text: `Oh, so that's how "${item.normalizedText}" works. I can picture it now.`,
        audioTags: ["delighted"],
      });
      coverage.push({
        sourceItemId: item.id,
        normalizedText: item.normalizedText,
        segmentIds: [teacherSegId],
      });
    });

    const totalWords = segments.reduce((sum, s) => sum + countWords(s.text), 0);
    const estimated = Math.round((totalWords / request.wordsPerMinute) * 60);
    const estimatedDurationSeconds = Math.max(
      1,
      Math.min(estimated, request.targetMaxSeconds),
    );

    return {
      version: LESSON_SCRIPT_VERSION,
      speakers: {
        learner: { role: "learner", voiceId: request.learnerVoiceId, displayName: "Learner" },
        teacher: { role: "teacher", voiceId: request.teacherVoiceId, displayName: "Teacher" },
      },
      segments,
      coverage,
      estimatedDurationSeconds,
    };
  }
}

export class MockTtsAdapter implements TtsAdapter {
  constructor(private readonly wordsPerMinute = 150) {}

  async healthCheck(): Promise<ProviderHealth> {
    return { provider: "elevenlabs", ok: true, detail: "mock adapter (no API key configured)" };
  }

  async renderDialogue(script: LessonScript, ttsCharLimit: number): Promise<RenderedAudio> {
    // Simulate per-segment rendering under the char limit, then stitching (research R5).
    let totalWords = 0;
    let buffer = "";
    const chunks: string[] = [];
    for (const seg of script.segments) {
      totalWords += countWords(seg.text);
      if ((buffer + seg.text).length > ttsCharLimit) {
        if (buffer) chunks.push(buffer);
        buffer = seg.text;
      } else {
        buffer = buffer ? `${buffer} ${seg.text}` : seg.text;
      }
    }
    if (buffer) chunks.push(buffer);

    const durationSeconds = Math.max(1, Math.round((totalWords / this.wordsPerMinute) * 60));
    // Placeholder bytes; real adapter returns stitched MP3 audio.
    const bytes = new TextEncoder().encode(`MOCK_AUDIO:${chunks.length}:${durationSeconds}`);
    return { bytes, mimeType: "audio/mpeg", durationSeconds };
  }
}
