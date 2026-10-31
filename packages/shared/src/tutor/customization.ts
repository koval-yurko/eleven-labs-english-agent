/**
 * Per-version tutor customization: the options a prompt version declares, and the values a learner
 * picks for them. Declarative on purpose — a version describes its options as plain data, and one
 * generic modal on the phone renders any of them. Research: docs/2026-10-30-prompt-version-customization.md.
 *
 * The flow, end to end:
 *   1. a `PromptVersion` (`@tutor/server/agent/prompts`) carries `customization: CustomizationSchema`;
 *   2. the agent-versions route copies it into `AgentVersionSummary.customization`;
 *   3. the phone saves the learner's values per version, and sends them as `RealtimeTokenRequest.options`;
 *   4. the token route runs `customizationOverrides(schema, options)` (every field, defaults included) and puts the result in
 *      `LiveKitDispatchMetadata.overrides`;
 *   5. the worker gives each stage's overrides to that stage's profile.
 *
 * Both the phone and the API run `resolveCustomization`, so a value the schema no longer accepts
 * (an option removed, a range changed) falls back to the default on both sides and nothing fails.
 */

export type OptionValue = string | number | boolean;

/**
 * The pipeline stages a field can tune. Closed, because the stages are the worker's shape and rarely
 * change. What a stage accepts is NOT listed here: the worker owns its profiles, as it owns the
 * profile ids in `LiveKitDispatchMetadata.tts` / `.stt`.
 */
export const CUSTOMIZATION_STAGES = ["stt", "tts"] as const;
export type CustomizationStage = (typeof CUSTOMIZATION_STAGES)[number];

/**
 * The reserved key that selects the stage's profile — `stt.profile` replaces the version's `stt`,
 * `tts.profile` its `tts` (a key of `STT_PROFILES` / `TTS_PROFILES` in `services/voice-worker`).
 */
export const PROFILE_KEY = "profile";

/**
 * What a field drives: `<stage>.<key>`. The stage is checked here; the key is open. Every key but
 * `profile` belongs to the selected profile, which lists the keys it reads (`accepts` in the worker's
 * `tts-profiles.ts` / `stt-profiles.ts`), e.g. `tts.voice` and `tts.model` on a Voicebox profile.
 * A new provider adds its own keys there, with no change here. A key the profile does not read is
 * dropped by the worker and named in its session-start log line.
 */
export type CustomizationTarget = `${CustomizationStage}.${string}`;

/** `<stage>.<key>` with a known stage and a non-empty key; anything else is not a target. */
export function parseCustomizationTarget(target: unknown): { stage: CustomizationStage; key: string } | null {
  if (typeof target !== "string") return null;
  const dot = target.indexOf(".");
  if (dot <= 0 || dot === target.length - 1) return null;
  const stage = target.slice(0, dot);
  if (!(CUSTOMIZATION_STAGES as readonly string[]).includes(stage)) return null;
  return { stage: stage as CustomizationStage, key: target.slice(dot + 1) };
}

interface FieldBase {
  /** Stable key: the saved values and the wire use it. Renaming it forgets what learners saved. */
  key: string;
  label: string;
  help?: string;
  /** Which worker setting the value drives. The UI never reads it. */
  target: CustomizationTarget;
}

export interface SelectOption {
  value: string;
  label: string;
  help?: string;
}

export interface SelectField extends FieldBase {
  kind: "select";
  default: string;
  options: SelectOption[];
}

/** Rendered as a slider. */
export interface NumberField extends FieldBase {
  kind: "number";
  default: number;
  min: number;
  max: number;
  step: number;
  /** Shown after the value, e.g. "×". */
  unit?: string;
}

export interface BooleanField extends FieldBase {
  kind: "boolean";
  default: boolean;
}

export type CustomizationField = SelectField | NumberField | BooleanField;

export interface CustomizationSchema {
  fields: CustomizationField[];
}

/** A learner's values, by field `key`. */
export type CustomizationValues = Record<string, OptionValue>;

/**
 * What the worker receives: the changed values grouped by stage, then by key — e.g.
 * `{ tts: { voice: "…" }, stt: { profile: "deepgram" } }`. Already validated against the version's
 * schema; the worker still decides which keys its profile reads.
 */
export type CustomizationOverrides = Partial<Record<CustomizationStage, Record<string, OptionValue>>>;

const has = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

/** The schema's defaults, by field `key`. */
export function customizationDefaults(schema: CustomizationSchema): CustomizationValues {
  const out: CustomizationValues = {};
  for (const field of schema.fields) out[field.key] = field.default;
  return out;
}

/** Snaps to the nearest step from `min`, clamped to the range, without float noise. */
function snap(field: NumberField, value: number): number {
  const clamped = Math.min(field.max, Math.max(field.min, value));
  if (!(field.step > 0)) return clamped;
  const steps = Math.round((clamped - field.min) / field.step);
  const decimals = (String(field.step).split(".")[1] ?? "").length;
  return Math.min(field.max, Number((field.min + steps * field.step).toFixed(decimals)));
}

function resolveField(field: CustomizationField, raw: unknown): OptionValue {
  switch (field.kind) {
    case "select":
      return typeof raw === "string" && field.options.some((o) => o.value === raw) ? raw : field.default;
    case "number":
      return typeof raw === "number" && Number.isFinite(raw) ? snap(field, raw) : field.default;
    case "boolean":
      return typeof raw === "boolean" ? raw : field.default;
  }
}

/**
 * Every field of the schema with a valid value: unknown keys are dropped; a wrong type or a value
 * the schema does not offer falls back to the default; a number is clamped and snapped to its step.
 * `values` is `unknown` because it comes from a request body or from storage.
 */
export function resolveCustomization(schema: CustomizationSchema, values: unknown): CustomizationValues {
  const bag = typeof values === "object" && values !== null && !Array.isArray(values) ? (values as Record<string, unknown>) : {};
  const out: CustomizationValues = {};
  for (const field of schema.fields) {
    out[field.key] = resolveField(field, has(bag, field.key) ? bag[field.key] : undefined);
  }
  return out;
}

/** The values that differ from the defaults, by field `key` — what the phone needs to store. */
export function changedCustomization(schema: CustomizationSchema, values: unknown): CustomizationValues {
  const resolved = resolveCustomization(schema, values);
  const out: CustomizationValues = {};
  for (const field of schema.fields) {
    if (resolved[field.key] !== field.default) out[field.key] = resolved[field.key]!;
  }
  return out;
}

/**
 * The validated values, grouped by stage and key, for the dispatch metadata. EVERY field is sent,
 * defaults included, so the worker runs what the modal shows: a default left out would let a worker
 * setting (an env var such as VOICEBOX_MODEL_SIZE) win over the value the learner sees selected.
 * A field whose target is malformed sends nothing.
 */
export function customizationOverrides(schema: CustomizationSchema, values: unknown): CustomizationOverrides {
  const resolved = resolveCustomization(schema, values);
  const out: CustomizationOverrides = {};
  for (const field of schema.fields) {
    const target = parseCustomizationTarget(field.target);
    if (target) (out[target.stage] ??= {})[target.key] = resolved[field.key]!;
  }
  return out;
}

/** A structural check for a schema that came over the wire. */
export function isCustomizationSchema(body: unknown): body is CustomizationSchema {
  if (typeof body !== "object" || body === null) return false;
  const fields = (body as Partial<CustomizationSchema>).fields;
  if (!Array.isArray(fields)) return false;
  return fields.every((f: unknown) => {
    if (typeof f !== "object" || f === null) return false;
    const field = f as Partial<CustomizationField>;
    if (typeof field.key !== "string" || typeof field.label !== "string") return false;
    if (!parseCustomizationTarget(field.target)) return false;
    switch (field.kind) {
      case "select":
        return typeof field.default === "string" && Array.isArray(field.options);
      case "number":
        return (
          typeof field.default === "number" &&
          typeof field.min === "number" &&
          typeof field.max === "number" &&
          typeof field.step === "number"
        );
      case "boolean":
        return typeof field.default === "boolean";
      default:
        return false;
    }
  });
}
