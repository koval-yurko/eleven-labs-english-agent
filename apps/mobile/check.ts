/**
 * Checks for the pure half of the lock-screen controls (`src/lib/lesson-activity-state.ts`).
 *
 * These exist because the intent resolver is the one piece of this feature whose bugs are invisible
 * on a device: a tap stream that resolves wrongly looks exactly like a tap that did not land. The
 * cases below are the ones the design argues about — a batch replayed after a background relaunch,
 * a confirm that must lapse, a reach for a different control mid-confirm.
 *
 * Run: `pnpm --filter mobile check:logic`
 *
 * NOTE: a stopgap in the style of packages/shared/check.ts — the repo has no test runner yet.
 */
import {
  buildActivityState,
  END_CONFIRM_MS,
  nextArmedAt,
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
const base = buildActivityState({
  words: ["a", "b"],
  connected: true,
  held: false,
  muted: false,
  silenced: true,
  confirmingEnd: false,
});
check("null never matches", !sameActivityState(null, base));
check(
  "an identical rebuild matches",
  sameActivityState(
    base,
    buildActivityState({
      words: ["a", "b"],
      connected: true,
      held: false,
      muted: false,
      silenced: true,
      confirmingEnd: false,
    }),
  ),
);
check(
  "a changed word is a change",
  !sameActivityState(
    base,
    buildActivityState({
      words: ["a", "c"],
      connected: true,
      held: false,
      muted: false,
      silenced: true,
      confirmingEnd: false,
    }),
  ),
);
check(
  "losing the silence is a change — it rewrites the card's copy",
  !sameActivityState(
    base,
    buildActivityState({
      words: ["a", "b"],
      connected: true,
      held: false,
      muted: false,
      silenced: false,
      confirmingEnd: false,
    }),
  ),
);

// ── the intent resolver ─────────────────────────────────────────────────────────────────────
const t = 1_000_000;

const single = resolveIntents([{ action: "pause", at: t }], null, t);
check("one pause tap toggles", single.togglePause && !single.end);

const twice = resolveIntents(
  [
    { action: "pause", at: t },
    { action: "pause", at: t + 100 },
  ],
  null,
  t + 200,
);
check("two pause taps cancel out", !twice.togglePause);

const thrice = resolveIntents(
  [
    { action: "pause", at: t },
    { action: "pause", at: t + 100 },
    { action: "pause", at: t + 200 },
  ],
  null,
  t + 300,
);
check("three pause taps are one flip", thrice.togglePause);

const armed = resolveIntents([{ action: "end", at: t }], null, t);
check("a lone End arms, never ends", !armed.end && armed.armEndConfirm);
check("the armed timestamp is remembered", nextArmedAt([{ action: "end", at: t }], armed) === t);

const confirmed = resolveIntents([{ action: "end", at: t + 1000 }], t, t + 1000);
check("a second End inside the window ends", confirmed.end);
check("...and disarms", !confirmed.armEndConfirm);
check("...and is not remembered", nextArmedAt([{ action: "end", at: t + 1000 }], confirmed) === null);

const lapsed = resolveIntents(
  [{ action: "end", at: t + END_CONFIRM_MS + 1 }],
  t,
  t + END_CONFIRM_MS + 1,
);
check("a second End after the window re-arms rather than ending", !lapsed.end && lapsed.armEndConfirm);

// The batch that arrives together after a background relaunch — the case the design is built for.
const batch = resolveIntents(
  [
    { action: "end", at: t },
    { action: "end", at: t + 500 },
  ],
  null,
  t + 600,
);
check("two End taps replayed together collapse to ONE end", batch.end);

const batchWide = resolveIntents(
  [
    { action: "end", at: t },
    { action: "end", at: t + END_CONFIRM_MS + 1 },
  ],
  null,
  t + END_CONFIRM_MS + 2,
);
check("two End taps too far apart do not end", !batchWide.end && batchWide.armEndConfirm);

const interrupted = resolveIntents(
  [
    { action: "end", at: t },
    { action: "mute", at: t + 100 },
    { action: "end", at: t + 200 },
  ],
  null,
  t + 300,
);
check("reaching for Mute mid-confirm cancels it", !interrupted.end);
check("...and the trailing End re-arms", interrupted.armEndConfirm);
check("...and the mute still happened", interrupted.toggleMute);

const supersede = resolveIntents(
  [
    { action: "pause", at: t },
    { action: "end", at: t + 100 },
    { action: "end", at: t + 200 },
  ],
  null,
  t + 300,
);
check("an end supersedes everything queued with it", supersede.end && !supersede.togglePause);

const outOfOrder = resolveIntents(
  [
    { action: "end", at: t + 500 },
    { action: "end", at: t },
  ],
  null,
  t + 600,
);
check("the inbox is sorted before folding, so arrival order cannot matter", outOfOrder.end);

const staleArm = resolveIntents([{ action: "pause", at: t }], t - 60_000, t);
check("an arm from a minute ago is already dead", !staleArm.armEndConfirm);

// `throw` rather than `process.exit`: this file is typechecked by the app's tsconfig, which has no
// Node types by design (it is a React Native project). A non-zero exit is all the gate needs.
if (failures > 0) {
  throw new Error(`${failures} check(s) failed`);
}
console.log("lesson-activity-state: all checks passed");
