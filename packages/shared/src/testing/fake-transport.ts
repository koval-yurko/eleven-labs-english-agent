/** A transport that does nothing and remembers everything. Nothing shipped may import this.
 *  See ../../README.md#testing. */
import type {
  TutorCapabilities,
  TutorSessionDescriptor,
  TutorStartRequest,
  TutorTransportControls,
  TutorUsage,
} from "../tutor/transport";

export type FakeCall =
  | { method: "start"; arg: TutorStartRequest }
  | { method: "end" }
  | { method: "say"; arg: string }
  | { method: "context"; arg: string }
  | { method: "cancelTurn" }
  | { method: "keepAlive" }
  | { method: "setMicMuted"; arg: boolean }
  | { method: "setOutputSilenced"; arg: boolean };

export interface FakeTransport {
  controls: TutorTransportControls;
  calls: FakeCall[];
  sequence(): FakeCall["method"][];
  argOf(method: FakeCall["method"], nth?: number): unknown;
  reset(): void;
}

export interface FakeOptions {
  capabilities?: Partial<TutorCapabilities>;
  descriptor?: TutorSessionDescriptor;
  canSilence?: boolean;
  startError?: Error;
}

const FULL: TutorCapabilities = {
  silenceOutput: true,
  userActivity: true,
  cancelTurn: true,
  responseCorrection: true,
};

export function createFakeTransport(options: FakeOptions = {}): FakeTransport {
  const calls: FakeCall[] = [];
  const capabilities: TutorCapabilities = { ...FULL, ...options.capabilities };
  const canSilence = options.canSilence ?? true;
  const descriptor = options.descriptor ?? {
    conversationId: "00000000-0000-4000-8000-000000000000",
    version: "fake-1.0",
  };

  const controls: TutorTransportControls = {
    capabilities,
    start: async (request, onIdentified) => {
      calls.push({ method: "start", arg: request });
      if (options.startError) throw options.startError;
      await onIdentified(descriptor);
    },
    end: () => void calls.push({ method: "end" }),
    say: (text) => void calls.push({ method: "say", arg: text }),
    context: (text) => void calls.push({ method: "context", arg: text }),
    cancelTurn: () => void calls.push({ method: "cancelTurn" }),
    keepAlive: () => void calls.push({ method: "keepAlive" }),
    setMicMuted: (muted) => void calls.push({ method: "setMicMuted", arg: muted }),
    setOutputSilenced: (silenced) => {
      calls.push({ method: "setOutputSilenced", arg: silenced });
      return canSilence;
    },
  };

  return {
    controls,
    calls,
    sequence: () => calls.map((c) => c.method),
    argOf: (method, nth = 0) => {
      const hits = calls.filter((c) => c.method === method);
      const hit = hits[nth];
      return hit && "arg" in hit ? hit.arg : undefined;
    },
    reset: () => void calls.splice(0, calls.length),
  };
}

export function fakeUsage(overrides: Partial<TutorUsage> = {}): TutorUsage {
  return {
    inputTokens: 100,
    outputTokens: 50,
    inputAudioTokens: 80,
    outputAudioTokens: 40,
    cachedInputTokens: 60,
    ...overrides,
  };
}
