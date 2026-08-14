import { Link } from "expo-router";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth0 } from "react-native-auth0";

/**
 * A launcher, and nothing more — S5 replaces it with the real lessons list.
 *
 * S4 needs a way into one lesson before the list screen exists. The distinction that keeps this from
 * rotting: the id below is a **navigation target**, never data. `app/lessons/[id].tsx` receives it as
 * a route parameter and fetches everything about the lesson from the server, so deleting this file at
 * S5 removes a link and nothing else. S3's three literal lesson items are gone entirely — fabricated
 * lesson data is what `GET /api/v2/lessons/:id` exists to end.
 *
 * See docs/2026-08-13-expo-s4-tutor-screen.md D42, D43.
 */

/** The lesson S4 is developed against. One line, deleted at S5. Must belong to the signed-in learner. */
const DEV_LESSON_ID = "eb47597e-cac3-446b-b5de-26b0ebd068c2";

export default function HomeScreen() {
  const { user } = useAuth0();

  return (
    <SafeAreaView style={styles.screen}>
      <Text style={styles.title}>English Tutor</Text>
      <Text style={styles.muted}>{user ? `signed in as ${user.email ?? user.sub}` : "signed out"}</Text>

      <View style={styles.links}>
        <Link href={`/lessons/${DEV_LESSON_ID}`} style={styles.link}>
          Practice this lesson →
        </Link>
        <Link href="/auth" style={styles.link}>
          Account →
        </Link>
        {/* The upgrade regression instrument, not a feature (D43). */}
        <Link href="/probe" style={styles.linkQuiet}>
          Session probe →
        </Link>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#101014", paddingHorizontal: 16 },
  title: { color: "#E6E6E6", fontSize: 28, fontWeight: "700", marginTop: 24 },
  muted: { color: "#8A8A8A", fontSize: 12, marginTop: 4 },
  links: { marginTop: 32, gap: 4 },
  link: { color: "#7FB2FF", fontSize: 17, paddingVertical: 12 },
  linkQuiet: { color: "#5A5A5A", fontSize: 15, paddingVertical: 12 },
});
