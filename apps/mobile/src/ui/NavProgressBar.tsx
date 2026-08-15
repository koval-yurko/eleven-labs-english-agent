import { useEffect, useState } from "react";
import { Animated, Easing, StyleSheet, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useTheme } from "@/theme";
import { useNavigationPending } from "./nav-progress";
import { progress } from "./tokens";

/**
 * Don't flash the bar for work that resolves almost immediately. This is the one timer in the
 * feature and it only ever *hides* the bar — it never advances it.
 */
const SHOW_AFTER_MS = 120;

/**
 * The bar across the top of the screen — `.nav-progress` from the web's `globals.css`.
 *
 * Deliberately **indeterminate** while loading, for the same reason it is on the web: a request is
 * a single opaque round trip with no checkpoints, so there is no honest percentage to show and a
 * trickling fake would be worse than an animation that just says "working".
 *
 * The web pins it with `position: fixed; top: env(safe-area-inset-top)`. Here it is rendered by the
 * root layout, above the navigator, with `position: absolute` and the real inset — so it sits under
 * the clock rather than behind it, and it does not travel with a screen's scroll.
 *
 * `Animated` rather than Reanimated: the sweep is one looped `translateX` on the native driver,
 * which is exactly what the built-in API is for, and the app has never configured a worklet
 * runtime. See the note in `Disclosure.tsx`.
 *
 * **One piece of state, and the three visual states are derived from it.** The web keeps an
 * explicit `"idle" | "loading" | "done"` and moves between them inside effects; here that would
 * mean calling `setState` synchronously in an effect body, which the React Compiler (on, per
 * `app.config.ts`) rejects as a cascading render. `shown` — "has the bar passed the reveal delay" —
 * is the only thing stored, and every write to it happens in a callback: a timer when the bar
 * appears, the fade's completion when it leaves. Loading is `shown && pending`, done is
 * `shown && !pending`.
 */
export function NavProgressBar() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const pending = useNavigationPending();

  const [shown, setShown] = useState(false);
  // `useState` with an initialiser, not `useRef(new Animated.Value(0)).current`: the initialiser is
  // guaranteed to run exactly once, and reading `.current` during render is what the compiler
  // rejects — a ref is not a render input.
  const [sweep] = useState(() => new Animated.Value(0));
  const [fade] = useState(() => new Animated.Value(1));

  /** Reveal, once work has been outstanding long enough to be worth mentioning. */
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setShown(true), SHOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  /** The sweep, for as long as the bar is up and work is still outstanding. */
  useEffect(() => {
    if (!shown || !pending) return;
    fade.setValue(1);
    sweep.setValue(0);
    const loop = Animated.loop(
      Animated.timing(sweep, {
        toValue: 1,
        duration: progress.sweepMs,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [shown, pending, sweep, fade]);

  /**
   * Settled: fill the track, then fade — never snap away. `setShown(false)` rides the animation's
   * completion callback, so work that starts again mid-fade simply cancels it and the bar stays up
   * rather than blinking through hidden.
   */
  useEffect(() => {
    if (!shown || pending) return;
    const animation = Animated.timing(fade, {
      toValue: 0,
      duration: progress.finishMs,
      easing: Easing.out(Easing.ease),
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished) setShown(false);
    });
    return () => animation.stop();
  }, [shown, pending, fade]);

  if (!shown) return null;

  // Loading: a 40%-wide segment sweeping the track. Done: the full track, fading.
  const segmentWidth = pending ? width * 0.4 : width;

  return (
    <View
      pointerEvents="none"
      style={[styles.track, { top: insets.top }]}
      accessibilityRole="progressbar"
      accessibilityLabel="Loading"
      // Indeterminate: no value is exactly right, and claiming a percentage we don't have would be
      // the same lie to a screen reader as it is visually.
      accessibilityState={{ busy: pending }}
    >
      <Animated.View
        style={[
          styles.bar,
          {
            width: segmentWidth,
            backgroundColor: theme.accent,
            opacity: fade,
            transform: pending
              ? [
                  {
                    // The CSS keyframes' -100% → 250%, in points rather than as a share of the
                    // segment's own width.
                    translateX: sweep.interpolate({
                      inputRange: [0, 1],
                      outputRange: [-segmentWidth, width + segmentWidth * 1.5],
                    }),
                  },
                ]
              : [],
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    position: "absolute",
    left: 0,
    right: 0,
    height: progress.height,
    overflow: "hidden",
    // `.nav-progress { z-index: 100 }` — above the page, below a Select popup (which is a Modal
    // here and therefore in its own window anyway).
    zIndex: 100,
    elevation: 100,
  },
  bar: { position: "absolute", top: 0, bottom: 0, left: 0 },
});
