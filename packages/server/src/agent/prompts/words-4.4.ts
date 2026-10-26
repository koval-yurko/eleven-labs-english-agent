/**
 * words-4.4 — `words-4.3` served by the worker on the Mac that runs Voicebox, not by LiveKit Cloud.
 *
 * Same lesson, same STT, same LLM, same voice ("Men 1"): the token route dispatches it to
 * `tutor-local` (`worker: "local"`), and that worker reaches Voicebox on `127.0.0.1` with the
 * `voicebox-local` profile — no tunnel, no key. A difference between 4.3 and 4.4 is the path the
 * audio takes (Cloud worker → tunnel → Mac against Mac → Mac) and nothing else. When the Mac worker
 * is not running, a session on this version gets no tutor. Research: Voice-Agent project,
 * docs/2026-10-27-local-voice-worker-on-mac-research.md.
 *
 * The name was used before: until 2026-10-26 `words-4.4` was the 4.3 voice over `/tts/stream`
 * (retired, see ./index.ts). A `words-4.4` session stored before 2026-10-27 is that one.
 */
import words43 from "./words-4.3";
import type { PromptVersion } from "./types";

const version: PromptVersion = {
  ...words43,
  version: "words-4.4",
  label: "4.4 · LiveKit — podcast lesson, Voicebox TTS (Mac worker)",
  tts: "voicebox-local",
  worker: "local",
};

export default version;
