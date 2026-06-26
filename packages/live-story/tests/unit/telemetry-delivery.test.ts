import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TelemetryDelivery } from "@idiomatic/contracts";

/**
 * Contract test for the ElevenLabs post-call webhook envelope (008-langsmith-tracing, T008).
 * The captured OTel fixture must parse; a JSON-variant delivery must parse; a garbage body fails.
 */

const fixturePath = fileURLToPath(new URL("../fixtures/otel-delivery.json", import.meta.url));
const otelFixture = JSON.parse(readFileSync(fixturePath, "utf8"));

describe("TelemetryDelivery schema", () => {
  it("parses a captured post_call_transcription_otel delivery", () => {
    const parsed = TelemetryDelivery.safeParse(otelFixture);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe("post_call_transcription_otel");
      expect(parsed.data.data.conversation_id).toBe("conv_fixture_abc123");
      expect(parsed.data.data.otlp_traces?.resourceSpans.length).toBeGreaterThan(0);
    }
  });

  it("parses a JSON-variant (post_call_transcription) delivery without otlp_traces", () => {
    const parsed = TelemetryDelivery.safeParse({
      type: "post_call_transcription",
      data: {
        conversation_id: "conv_json_1",
        agent_id: "agent_story_fixture",
        metadata: { cost: 0.01, termination_reason: "completed" },
        conversation_turn_metrics: { convai_llm_service_ttfb: { p50: 380 } },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("parses an otlp_traces:null body (the real JSON variant carries it as null, not absent)", () => {
    const parsed = TelemetryDelivery.safeParse({
      type: "post_call_transcription",
      data: { conversation_id: "conv_json_2", otlp_traces: null, transcript: [] },
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts an unknown event type (audio/failure are fanned to the same endpoint, ignored downstream)", () => {
    // The service switches on `type` and ignores non-transcription events with a 200 — so the
    // envelope schema must not reject them (a 400 would make ElevenLabs retry pointlessly).
    expect(
      TelemetryDelivery.safeParse({
        type: "post_call_audio",
        data: { conversation_id: "conv_audio_1", full_audio: "<base64>" },
      }).success,
    ).toBe(true);
  });

  it("rejects a truncated/garbage body (missing data / conversation_id)", () => {
    expect(TelemetryDelivery.safeParse({ type: "post_call_transcription_otel" }).success).toBe(
      false,
    );
    expect(TelemetryDelivery.safeParse({ type: "post_call_transcription", data: {} }).success).toBe(
      false,
    );
    expect(TelemetryDelivery.safeParse("not even an object").success).toBe(false);
  });
});
