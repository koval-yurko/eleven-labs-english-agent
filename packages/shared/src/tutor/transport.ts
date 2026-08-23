/** The contract between a tutor session and whatever is carrying the voice. The only thing a second provider must satisfy.
 *  See ../../docs/tutor.md. */
import type { TranscriptLine, TutorItem } from "./session";

export type TutorProviderId = "elevenlabs" | "openai";

export type TutorStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "disconnecting"
  | "error";

export type TutorEndReason = "user" | "agent" | "error";

export interface TutorCapabilities {
  silenceOutput: boolean;
  userActivity: boolean;
  cancelTurn: boolean;
  responseCorrection: boolean;
}

export interface TutorUsage {
  inputTokens: number;
  outputTokens: number;
  inputAudioTokens: number;
  outputAudioTokens: number;
  cachedInputTokens: number;
}

export interface TutorStartRequest {
  lessonId: string;
  items: TutorItem[];
  version: string | null;
}

export interface TutorSessionDescriptor {
  conversationId: string;
  version: string;
}

export interface TutorTransportEvents {
  onStatus(status: TutorStatus): void;
  onTurn(line: TranscriptLine): void;
  onTurnCorrected(previous: string, corrected: string): void;
  onEnd(reason: TutorEndReason): void;
  onError(message: string): void;
  onTransportId(id: string): void;
  onUsage(usage: TutorUsage): void;
}

export interface TutorTransportState {
  status: TutorStatus;
  isSpeaking: boolean;
  isMuted: boolean;
}

export interface TutorTransportControls {
  readonly capabilities: TutorCapabilities;

  start(
    request: TutorStartRequest,
    onIdentified: (descriptor: TutorSessionDescriptor) => Promise<void> | void,
  ): Promise<void>;
  end(): void;

  say(text: string): void;
  context(text: string): void;
  cancelTurn(): void;
  keepAlive(): void;

  setMicMuted(muted: boolean): void;
  setOutputSilenced(silenced: boolean): boolean;
}

export interface TutorTransport {
  state: TutorTransportState;
  controls: TutorTransportControls;
}
