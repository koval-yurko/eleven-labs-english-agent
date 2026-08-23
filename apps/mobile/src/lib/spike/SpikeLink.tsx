/**
 * SPIKE ONLY — path A of docs/2026-08-27-vapi-third-voice-provider.md. NEVER MERGE.
 *
 * A way into `/spike-vapi` from inside the running app.
 *
 * ## Why this exists rather than a deep link
 *
 * The route is reachable at `englishtutordev://spike-vapi` (or `englishtutorpreview://` /
 * `englishtutor://`, per `app.config.ts` VARIANTS). That is fine for opening the screen once, and
 * useless for the test that matters.
 *
 * The A/B silence test needs to go **ElevenLabs lesson → end it → Vapi call, without relaunching**.
 * Deep-linking there means leaving for Safari and coming back, which backgrounds and foregrounds the
 * app — and backgrounding is exactly the event that moves AVAudioSession around. The confound would
 * land on the one measurement the spike exists to take.
 *
 * So: an in-app control. Deliberately ugly, deliberately labelled, deliberately one file plus one
 * line in `_layout.tsx`, so removing it is a two-line revert.
 *
 * Placed bottom-left because `SessionBar` owns the bottom-centre/right and a live session is exactly
 * when this must not cover anything.
 */
import { type Href, usePathname, useRouter } from "expo-router";
import { Pressable, Text } from "react-native";

/**
 * Cast because `typedRoutes` is on and the route union is GENERATED into `.expo/types/router.d.ts`,
 * which is gitignored. It only learns about `/spike-vapi` once a dev server has run, so a clean
 * checkout typechecking before that would fail on the literal. A cast in a throwaway file beats
 * making `pnpm check` depend on generated state that is not in the repo.
 */
const SPIKE_ROUTE = "/spike-vapi" as Href;

export function SpikeLink() {
  const router = useRouter();
  const pathname = usePathname();

  // Already there — a button that navigates to the screen you are on is just clutter.
  if (pathname === "/spike-vapi") return null;

  return (
    <Pressable
      onPress={() => router.push(SPIKE_ROUTE)}
      hitSlop={8}
      style={{
        position: "absolute",
        left: 12,
        bottom: 92,
        backgroundColor: "#8A2020",
        opacity: 0.85,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 6,
      }}
    >
      <Text style={{ color: "#fff", fontSize: 11, fontWeight: "700" }}>SPIKE</Text>
    </Pressable>
  );
}
