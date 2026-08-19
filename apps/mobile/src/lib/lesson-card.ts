import {
  activeActivityCount,
  clearNowPlaying,
  endActivity,
  isActivityAvailable,
  publishNowPlaying,
  publishPhase,
  startActivity,
  updateActivity,
  type ActivityState,
} from "@/modules/lesson-activity";
import {
  nowPlayingSubtitle,
  OVER_CARD_LINGER_MS,
  sameActivityState,
} from "@/lib/lesson-activity-state";

/**
 * The one owner of the lock-screen card, for the life of the process.
 *
 * **Module scope, not a hook, not a ref, and deliberately not inside the lesson screen.** That is
 * the whole fix for "a new card appears for every lesson". A Live Activity is owned by the *system*:
 * it outlives the screen that started it, it outlives the JS runtime, and it survives a crash and a
 * force-quit. The screen that used to own it mounts, unmounts and remounts, and its `useRef` started
 * at `"none"` every single time — so on the second lesson the app sincerely believed there was no
 * card while the system was still showing the first one. A per-screen ref cannot reconcile with a
 * thing that outlives the screen. See
 * docs/2026-08-18-lock-screen-controls-unlock-and-single-card.md §2.1, §2.7.
 *
 * Three rules hold everything else together:
 *
 * 1. **One activity, re-pointed.** `title` and `deepLink` are pushed state now, not frozen
 *    attributes, so a card started for yesterday's lesson is a perfectly good home for today's.
 *    Nothing here ever ends a card in order to start a different one.
 * 2. **A swipe is a decision.** If a push cannot reach the card, the learner dismissed it (or the
 *    system hit its 12 h cap). We stop, and we do not quietly put it back. Only `ensureCard` —
 *    which is called when a learner deliberately starts a session — clears that latch.
 * 3. **Every native call is serialised.** `start` is asynchronous, and two state changes racing
 *    through it is exactly how the app ends up requesting two activities.
 */

/** The state we want the card to show. Collapsing bursts: the queue always pushes the latest. */
let desired: ActivityState | null = null;
/** The last state the system actually accepted, so an unchanged render never reaches iOS (§7.5). */
let pushed: ActivityState | null = null;
let card: "none" | "live" = "none";
/**
 * Set when a push finds no card to reach. Means "there is no card and we must not make one",
 * which is not the same as "there is no card" — the difference is whether the learner chose it.
 */
let gone = false;
let lingerTimer: ReturnType<typeof setTimeout> | null = null;
/** How many orphans the launch reconcile found. Read by `cardDebugState` and by probe P-5. */
let lastReconcileCount = 0;

/**
 * A one-lane queue. Every native call goes through it, in order, with no overlap.
 *
 * `chain.then(fn, fn)` rather than `chain.then(fn)` on purpose: a rejected predecessor must not
 * skip its successor. Nothing in here throws — the module wrappers all swallow — but a queue whose
 * correctness depends on that is a queue that breaks the first time it stops being true.
 */
let chain: Promise<unknown> = Promise.resolve();
function serial(fn: () => Promise<void>): Promise<void> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

/**
 * The two surfaces that are not the card, published synchronously and unconditionally.
 *
 * Before the card and independent of it, deliberately. The Controls are the surface that actually
 * works locked and Now Playing is the one that needs no setup; neither may wait on — or depend on
 * the success of — a Live Activity the learner can switch off in Settings. All three are renderings
 * of one fact, and only one of them is allowed to fail quietly.
 *
 * Now Playing is cleared rather than re-published once the session is over: it has a real ▶ button
 * and no way to say "this lesson ended", so a lingering one is a button that lies. The Live Activity
 * can linger because `phase: "over"` turns it into a link. §1.7, §7.1.
 */
function publishSurfaces(state: ActivityState): void {
  publishPhase(state.phase);
  if (state.phase === "over") {
    clearNowPlaying();
    return;
  }
  publishNowPlaying(state.title, nowPlayingSubtitle(state), state.phase === "held");
}

function cancelLinger(): void {
  if (lingerTimer !== null) {
    clearTimeout(lingerTimer);
    lingerTimer = null;
  }
}

/**
 * Push everything queued, in order, until the card shows what we want or we learn we cannot.
 *
 * Loops rather than handling one step, because `desired` may have moved on while an `await` was in
 * flight — which is the common case, not the corner one: a session start changes phase two or three
 * times in the time `Activity.request` takes to return.
 */
async function drain(): Promise<void> {
  if (!isActivityAvailable()) return;

  while (desired !== null && !sameActivityState(pushed, desired)) {
    const next = desired;

    if (card === "none") {
      // Respect a dismissal, and never open a card for a session that is already over: `phase:
      // "over"` with no card is not a lesson that ended, it is a lesson that never began.
      if (gone || next.phase === "over") {
        pushed = next;
        return;
      }
      const id = await startActivity(next);
      if (id === null) {
        // iOS refused — activities are switchable off per app, and the system caps how many are
        // live. Forget the attempt rather than recording it as success, so the next state change
        // tries again instead of pushing at nothing for the rest of the lesson.
        pushed = null;
        return;
      }
      card = "live";
      pushed = next;
      continue;
    }

    const reached = await updateActivity(next);
    if (!reached) {
      card = "none";
      pushed = null;
      gone = true;
      return;
    }
    pushed = next;
  }
}

/**
 * Start the card for a session, or adopt and re-point the one that is already there.
 *
 * Call this from the foreground, on a deliberate session start — iOS refuses to *begin* an activity
 * from the background, and this is also the only call that clears the "the learner swiped it away"
 * latch. Everything after it is `pushCard`.
 */
export function ensureCard(state: ActivityState): void {
  cancelLinger();
  gone = false;
  desired = state;
  publishSurfaces(state);
  void serial(drain);
}

/**
 * Push new state at the card, if there is one.
 *
 * Never starts one. A card that does not exist during a lesson either could not be created or was
 * dismissed, and both of those are answered by leaving it alone until the next `ensureCard`.
 */
export function pushCard(state: ActivityState): void {
  desired = state;
  publishSurfaces(state);
  void serial(drain);

  // The card outlives its session because that is where `Start` lives (§3.6), so the safety comes
  // from the state rather than from the teardown: `phase: "over"` renders no action at all, just a
  // link that opens the app. It is then dismissed when the learner comes back, or after a window if
  // they never do.
  if (state.phase === "over" && card === "live" && lingerTimer === null) {
    lingerTimer = setTimeout(() => {
      lingerTimer = null;
      void dismissCard();
    }, OVER_CARD_LINGER_MS);
  } else if (state.phase !== "over") {
    cancelLinger();
  }
}

/**
 * Tear the card down and forget it.
 *
 * Ends *every* activity of ours, not the one we think we own — this is also the cleanup path for
 * duplicates left by an older build, a crash, or a force-quit, which are exactly the cases where
 * our own bookkeeping is what cannot be trusted.
 */
export function dismissCard(): Promise<void> {
  cancelLinger();
  return serial(async () => {
    desired = null;
    pushed = null;
    card = "none";
    gone = false;
    await endActivity();
  });
}

/**
 * What Apple tells every Live Activity app to do and what this one never did.
 *
 * > …the system may stop your app, or your app may crash while a Live Activity is active. When the
 * > app launches the next time, check if any activities are still active, update your app's stored
 * > Live Activity data, and end any Live Activity that's no longer relevant.
 *
 * At launch, *every* card of ours is by definition no longer relevant: a tutor session lives in
 * this process — the WebRTC connection, the SDK, the state machine — so if the process is new, the
 * session behind any surviving card is gone. Ending them is not a heuristic, it is the definition.
 *
 * Call once, from `_layout.tsx`, before anything can ask for a card. It shares the queue with
 * `ensureCard`, so a lesson screen mounting immediately afterwards is ordered behind it rather than
 * racing it.
 */
export function reconcileAtLaunch(): Promise<void> {
  return serial(async () => {
    desired = null;
    pushed = null;
    card = "none";
    gone = false;
    // Unconditional, and the count is read only so the number can be logged and asserted by the
    // §5 probes: `endActivity` is also what clears the phase snapshot the controls read and any
    // presses left in the inbox by a session that no longer exists, both of which need clearing
    // even when no card survived.
    lastReconcileCount = await activeActivityCount();
    await endActivity();
  });
}

/** Test seam and diagnostics. Not used by the app. */
export function cardDebugState(): {
  card: string;
  gone: boolean;
  hasDesired: boolean;
  orphansAtLaunch: number;
} {
  return { card, gone, hasDesired: desired !== null, orphansAtLaunch: lastReconcileCount };
}
