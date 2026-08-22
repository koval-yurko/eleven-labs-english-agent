/**
 * A transport that does nothing and remembers everything.
 *
 * ## Two jobs, and the first one is a design check
 *
 * `TutorTransport` is defined in this package precisely so it is not shaped by whichever SDK
 * happened to be first. That claim was untested until now: both real implementations are React
 * hooks living in `apps/mobile`, so "the contract is React-free" was an assertion about a file
 * nobody had tried to write. This is that file. It is a plain factory — no hooks, no components, no
 * platform — and the fact that it compiles against the same interface the ElevenLabs adapter does is
 * the evidence.
 *
 * The second job is testing. Every call is appended to `calls` in order, so a decision made by
 * `tutor-pause.ts` can be checked by what it actually asked the transport to do, rather than by
 * reading the code back. See `check.ts`.
 *
 * ## Not a mock of a provider
 *
 * It does not simulate OpenAI or ElevenLabs and should never grow toward either. It is the identity
 * transport: whatever you ask it, it records and returns the boring answer. A fake that started
 * modelling one provider's timing would become a second place where that provider's behaviour is
 * written down, and the first place would stop being the truth.
 */
import type {
  TutorCapabilities,
  TutorSessionDescriptor,
  TutorStartRequest,
  TutorTransportControls,
  TutorUsage,
} from "./tutor-transport";

/** One recorded call. `arg` is present only where the method takes one worth remembering. */
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
  /** Every call, in order. */
  calls: FakeCall[];
  /** Just the method names, for asserting a sequence without the arguments. */
  sequence(): FakeCall["method"][];
  /** The argument of the Nth call to `method`, or undefined. */
  argOf(method: FakeCall["method"], nth?: number): unknown;
  reset(): void;
}

export interface FakeOptions {
  capabilities?: Partial<TutorCapabilities>;
  /** What `start` resolves its descriptor to. */
  descriptor?: TutorSessionDescriptor;
  /**
   * What `setOutputSilenced` reports.
   *
   * `false` is the case worth testing and the reason the method returns a boolean at all: a provider
   * that CANNOT silence its output must not let a paused screen claim it did.
   */
  canSilence?: boolean;
  /** Raised by `start` instead of connecting — the refused-credential path. */
  startError?: Error;
}

/** Capabilities of a provider that can do everything. Override per test. */
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
      // Awaited before "connecting", exactly as the contract requires — a fake that called this
      // afterwards would let a session pass tests it would fail against a real provider.
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

/** A usage block, for exercising the accumulation a session does over `onUsage`. */
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
