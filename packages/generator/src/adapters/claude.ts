import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { LessonScript } from "@idiomatic/contracts";
import { LESSON_SCRIPT_VERSION } from "@idiomatic/contracts";
import type { LlmAdapter, ProviderHealth, ScriptDraftRequest } from "./types";
import { PROMPT_VERSION, buildSystemPrompt, buildUserPrompt } from "../prompts/lesson-script";

/**
 * Claude-backed LessonScript generator (T022). Uses a single forced tool call so the
 * model returns a structured object validated against the shared contract; speakers and
 * voice IDs are injected from config afterward (the teacher voice is pinned —
 * Constitution I). Validated with Zod, so a malformed draft fails loudly.
 */

const ScriptDraft = z.object({
  segments: z
    .array(
      z.object({
        id: z.string().min(1),
        speaker: z.enum(["learner", "teacher"]),
        text: z.string().min(1),
        audioTags: z.array(z.string()),
      }),
    )
    .min(1),
  coverage: z
    .array(
      z.object({
        sourceItemId: z.string().min(1),
        normalizedText: z.string().min(1),
        segmentIds: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1),
  estimatedDurationSeconds: z.number().int().min(1),
});

const EMIT_TOOL: Anthropic.Tool = {
  name: "emit_lesson_script",
  description: "Emit the structured two-voice lesson script.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["segments", "coverage", "estimatedDurationSeconds"],
    properties: {
      segments: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "speaker", "text", "audioTags"],
          properties: {
            id: { type: "string" },
            speaker: { type: "string", enum: ["learner", "teacher"] },
            text: { type: "string" },
            audioTags: { type: "array", items: { type: "string" } },
          },
        },
      },
      coverage: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["sourceItemId", "normalizedText", "segmentIds"],
          properties: {
            sourceItemId: { type: "string" },
            normalizedText: { type: "string" },
            segmentIds: { type: "array", items: { type: "string" } },
          },
        },
      },
      estimatedDurationSeconds: { type: "integer" },
    },
  },
};

export class ClaudeLlmAdapter implements LlmAdapter {
  readonly promptVersion = PROMPT_VERSION;
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    readonly modelId: string,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async healthCheck(): Promise<ProviderHealth> {
    try {
      // Cheap, no-generation check: confirms the API key works and the model exists.
      const model = await this.client.models.retrieve(this.modelId);
      return { provider: "claude", ok: true, detail: `model ${model.id} reachable` };
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      return { provider: "claude", ok: false, detail: message };
    }
  }

  async draftScript(request: ScriptDraftRequest): Promise<LessonScript> {
    const system = buildSystemPrompt({
      acceptedItems: request.acceptedItems,
      targetMinSeconds: request.targetMinSeconds,
      targetMaxSeconds: request.targetMaxSeconds,
      wordsPerMinute: request.wordsPerMinute,
    });

    const response = await this.client.messages.create({
      model: this.modelId,
      max_tokens: 16000,
      system,
      tools: [EMIT_TOOL],
      tool_choice: { type: "tool", name: EMIT_TOOL.name },
      messages: [{ role: "user", content: buildUserPrompt(request.acceptedItems) }],
    });

    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error("Claude did not return a lesson_script tool call");
    }

    const draft = ScriptDraft.parse(toolUse.input);

    return {
      version: LESSON_SCRIPT_VERSION,
      speakers: {
        learner: { role: "learner", voiceId: request.learnerVoiceId, displayName: "Learner" },
        teacher: { role: "teacher", voiceId: request.teacherVoiceId, displayName: "Teacher" },
      },
      segments: draft.segments,
      coverage: draft.coverage,
      estimatedDurationSeconds: draft.estimatedDurationSeconds,
    };
  }
}
