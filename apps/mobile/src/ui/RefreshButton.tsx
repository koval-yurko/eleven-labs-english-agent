import { useEffect, useState } from "react";
import { Animated, Easing, View } from "react-native";

import { useTheme } from "@/theme";
import { Button } from "./Button";
import { RefreshIcon } from "./icons";
import { Faint } from "./Text";
import { space } from "./tokens";

/**
 * Re-read what's on screen — the web's `RefreshButton`.
 *
 * The list screens keep `RefreshControl` (pull-to-refresh) as well; this is not a replacement for
 * it. It exists because the web has it, because a *detail* screen has nothing to pull, and because
 * of the one idea in the web version worth carrying over verbatim:
 *
 * > A refresh that finds nothing new is indistinguishable from a dead button, so say when we last
 * > asked. Not "updated" — this reports the question, not an answer we haven't compared.
 *
 * The spinner is the web's `.spin` — `animation: spin 800ms linear infinite` — on the native driver.
 */
export function RefreshButton({
  onRefresh,
  label = "Refresh",
}: {
  onRefresh: () => Promise<void>;
  label?: string;
}) {
  const theme = useTheme();
  const [pending, setPending] = useState(false);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  // See the note in NavProgressBar: an initialiser, not a ref read during render.
  const [spin] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (!pending) return;
    spin.setValue(0);
    const loop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 800,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [pending, spin]);

  async function refresh() {
    if (pending) return;
    setCheckedAt(null);
    setPending(true);
    try {
      await onRefresh();
    } finally {
      setPending(false);
      setCheckedAt(
        new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      );
    }
  }

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 0.4 * 16 }}>
      {/* When we last asked, beside the control rather than inside it — a disabled button can't
          carry a tooltip, and the line stays the report of the *previous* refresh. */}
      <Faint accessibilityRole="text">{checkedAt ? `checked ${checkedAt}` : ""}</Faint>
      <Button
        variant="icon"
        onPress={() => void refresh()}
        disabled={pending}
        accessibilityLabel={label}
      >
        <Animated.View
          style={{
            transform: [
              {
                rotate: spin.interpolate({
                  inputRange: [0, 1],
                  outputRange: ["0deg", "360deg"],
                }),
              },
            ],
          }}
        >
          <RefreshIcon size={18} color={theme.text} />
        </Animated.View>
      </Button>
    </View>
  );
}

/** The header row the web puts a back link and a RefreshButton in, on the detail screens. */
export function ActionRow({ children }: { children: React.ReactNode }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.row }}>{children}</View>
  );
}
