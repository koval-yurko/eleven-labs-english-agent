/**
 * Checks for the pure half of the lock-screen surfaces (`src/lib/lesson-activity-state.ts`).
 *
 * These exist because the intent resolver is the one piece of this feature whose bugs are invisible
 * on a device: a press stream that resolves wrongly looks exactly like a press that did not land.
 * The cases below are the ones the design argues about — a batch replayed after a background
 * relaunch, and the state diff that decides whether a push reaches iOS at all.
 *
 * Run: `pnpm --filter mobile check:logic`
 *
 * NOTE: a stopgap in the style of packages/shared/check.ts — the repo has no test runner yet.
 */
import {
  buildActivityState,
  nowPlayingSubtitle,
  phaseOf,
  resolveIntents,
  sameActivityState,
  windowWords,
  ACTIVITY_WORD_WINDOW,
} from "./src/lib/lesson-activity-state";

let failures = 0;
function check(name: string, ok: boolean) {
  if (!ok) {
    failures += 1;
    console.error(`  ✗ ${name}`);
  }
}

// ── the word window ─────────────────────────────────────────────────────────────────────────
const many = Array.from({ length: 15 }, (_, i) => `w${i}`);
const win = windowWords(many);
check("window is capped", win.words.length === ACTIVITY_WORD_WINDOW);
check("window keeps lesson order", win.words[0] === "w0" && win.words[5] === "w5");
check("overflow counts the rest", win.overflow === 9);
check("a short list overflows by zero", windowWords(["a"]).overflow === 0);
check("an empty lesson is not an error", windowWords([]).words.length === 0);

// ── the phase ───────────────────────────────────────────────────────────────────────────────
check("held outranks muted", phaseOf({ connected: true, held: true, muted: true }) === "held");
check("muted alone is muted", phaseOf({ connected: true, held: false, muted: true }) === "muted");
check("plain connected is live", phaseOf({ connected: true, held: false, muted: false }) === "live");
check(
  "disconnected is over whatever else is set",
  phaseOf({ connected: false, held: true, muted: true }) === "over",
);

// ── the diff that stops update storms ───────────────────────────────────────────────────────
type StateInput = Parameters<typeof buildActivityState>[0];
const baseInput: StateInput = {
  title: "Phrasal verbs",
  deepLink: "englishtutordev://lessons/abc",
  words: ["a", "b"],
  connected: true,
  held: false,
  muted: false,
  silenced: true,
};
const state = (overrides: Partial<StateInput> = {}) =>
  buildActivityState({ ...baseInput, ...overrides });

const base = state();
check("null never matches", !sameActivityState(null, base));
check("an identical rebuild matches", sameActivityState(base, state()));
check("a changed word is a change", !sameActivityState(base, state({ words: ["a", "c"] })));
check(
  "losing the silence is a change — it rewrites the card's copy",
  !sameActivityState(base, state({ silenced: false })),
);

// The two fields that used to be immutable attributes. They are the whole of why one activity can
// serve every lesson (§2.3), which only works if a change to them is actually pushed.
check(
  "a different lesson title is a change",
  !sameActivityState(base, state({ title: "Conditionals" })),
);
check(
  "a different deep link is a change",
  !sameActivityState(base, state({ deepLink: "englishtutordev://lessons/xyz" })),
);
check("the title reaches the pushed state", base.title === "Phrasal verbs");
check("the deep link reaches the pushed state", base.deepLink === "englishtutordev://lessons/abc");

// ── the Now Playing subtitle ────────────────────────────────────────────────────────────────
// The one thing worth pinning: a pause that could NOT silence the tutor must say so here too. That
// disclosure is the whole of §7.6, and a surface that quietly drops it is a surface claiming a
// silence the app did not deliver.
check(
  "a silenced pause says the tutor is waiting",
  nowPlayingSubtitle(state({ held: true, silenced: true })).includes("waiting"),
);
check(
  "an unsilenced pause admits the tutor may still be audible",
  nowPlayingSubtitle(state({ held: true, silenced: false })).includes("audible"),
);
check("a live session is not called paused", nowPlayingSubtitle(state()) === "Listening");
check(
  "an ended session never claims to be playing",
  nowPlayingSubtitle(state({ connected: false })) === "Lesson ended",
);

// ── the intent resolver ─────────────────────────────────────────────────────────────────────
const t = 1_000_000;

const single = resolveIntents([{ action: "pause", at: t }]);
check("one pause press toggles", single.togglePause);

const twice = resolveIntents([
  { action: "pause", at: t },
  { action: "pause", at: t + 100 },
]);
check("two pause presses cancel out", !twice.togglePause);

const thrice = resolveIntents([
  { action: "pause", at: t },
  { action: "pause", at: t + 100 },
  { action: "pause", at: t + 200 },
]);
check("three pause presses are one flip", thrice.togglePause);

const nothing = resolveIntents([]);
check("an empty batch changes nothing", !nothing.togglePause && !nothing.toggleMute);

// The batch that arrives together after a background relaunch — the case the design is built for.
const mixed = resolveIntents([
  { action: "pause", at: t },
  { action: "mute", at: t + 100 },
  { action: "pause", at: t + 200 },
]);
check("a mixed batch folds each control independently", !mixed.togglePause && mixed.toggleMute);

const orderA = resolveIntents([
  { action: "mute", at: t + 500 },
  { action: "pause", at: t },
]);
const orderB = resolveIntents([
  { action: "pause", at: t },
  { action: "mute", at: t + 500 },
]);
check(
  "arrival order cannot matter — counting presses is order-independent by construction",
  orderA.togglePause === orderB.togglePause && orderA.toggleMute === orderB.toggleMute,
);

// `throw` rather than `process.exit`: this file is typechecked by the app's tsconfig, which has no
// Node types by design (it is a React Native project). A non-zero exit is all the gate needs.
if (failures > 0) {
  throw new Error(`${failures} check(s) failed`);
}
console.log("lesson-activity-state: all checks passed");
