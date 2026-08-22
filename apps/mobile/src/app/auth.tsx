import { API_V2_ROUTES, isApiError, isMeResponse } from "@tutor/shared/api";
import { Link } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { env } from "@/env";
import { useEventLog } from "@/hooks/use-event-log";
import { RefreshTokenWarning, useSession } from "@/lib/auth";
import { useTheme, type Palette } from "@/theme";

/**
 * `/account` — the session, and the instrument that proves it works.
 *
 * This started life as S2's gate screen: the only `authorize()` call in the app, reached from a
 * link at the bottom of the lessons list. That made it *the* login screen by accident, which is how
 * the app shipped with no login screen on purpose — see the docblock in `lib/auth.tsx`.
 *
 * It no longer owns any auth mechanism. Sign in, sign out and the token both live in
 * `AuthProvider`, and this screen drives them, so what the learner presses here is the same code
 * path the gate uses. What stays is the diagnostic half, because it is still the fastest way to
 * answer "is this a token problem or a server problem" from a device:
 *
 *  - the token is a JWT, not an opaque Auth0 string (i.e. an audience was requested);
 *  - `getCredentials()` renews without prompting;
 *  - `/api/v2/me` returns the right `sub`, and an absent or bad token gets a 401 envelope.
 *
 * Everything is reported into the same scrollback S1 used, so a failure is readable rather than
 * inferred from a spinner that never stops.
 */
export default function AccountScreen() {
  const { status, label, sub, error, reason, busy, signIn, signOut, accessToken } = useSession();
  const { entries, log } = useEventLog();
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const kindStyles = useMemo(() => makeKindStyles(theme), [theme]);

  const [tokenSummary, setTokenSummary] = useState<string>("—");

  /**
   * Reading `env.apiBaseUrl` throws while it is unset (src/env.ts), which is the intended design.
   * Catch it here and show the message rather than white-screening the tool.
   */
  const readApiBase = useCallback((): string | null => {
    try {
      return env.apiBaseUrl;
    } catch (e) {
      log("error", e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [log]);

  /** Gate criterion: the access token must be a JWT (three segments), not an opaque Auth0 string. */
  const describe = useCallback(
    (token: string) => {
      const segments = token.split(".").length;
      const isJwt = segments === 3;
      setTokenSummary(isJwt ? "Bearer · JWT" : `OPAQUE (${segments} seg)`);
      log(isJwt ? "you" : "error", `token: ${isJwt ? "JWT ✓" : "NOT a JWT ✗"}`);
      if (!isJwt) {
        log("error", "an opaque token means no audience was requested — check auth0Audience");
      }
    },
    [log],
  );

  const onLogin = useCallback(async () => {
    log("note", `authorize → audience ${env.auth0Audience}`);
    await signIn();
  }, [signIn, log]);

  /** Renewal: with the API lifetime temporarily at 300s (S2 D17), this must not prompt for login. */
  const onRenew = useCallback(async () => {
    try {
      const token = await accessToken({ forceRefresh: true });
      if (!token) return log("error", "no token — is the session gone?");
      describe(token);
      log("status", "renewed without prompting ✓");
    } catch (e) {
      log("error", `renew failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [accessToken, log, describe]);

  const onCallMe = useCallback(async () => {
    const base = readApiBase();
    if (!base) return;
    try {
      const token = await accessToken();
      const url = `${base}${API_V2_ROUTES.me}`;
      log("note", `GET ${url}`);
      const res = await fetch(url, { headers: { authorization: `Bearer ${token ?? ""}` } });
      const body: unknown = await res.json();
      if (isMeResponse(body)) {
        log("you", `sub = ${body.sub}`);
      } else if (isApiError(body)) {
        log("error", `${res.status} ${body.error.code}: ${body.error.message}`);
      } else {
        log("error", `${res.status} unrecognised body: ${JSON.stringify(body).slice(0, 200)}`);
      }
    } catch (e) {
      log("error", `fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [accessToken, log, readApiBase]);

  /** The negative half of the gate: no token and a garbage token must both 401. */
  const onCallMeUnauthed = useCallback(async () => {
    const base = readApiBase();
    if (!base) return;
    for (const [label, headers] of [
      ["no token", {} as Record<string, string>],
      ["garbage token", { authorization: "Bearer not.a.jwt" }],
    ] as const) {
      try {
        const res = await fetch(`${base}${API_V2_ROUTES.me}`, { headers });
        const body: unknown = await res.json().catch(() => null);
        const ok = res.status === 401 && isApiError(body);
        log(
          ok ? "you" : "error",
          `${label} → ${res.status}${ok ? " (401 envelope ✓)" : " — expected 401"}`,
        );
      } catch (e) {
        log("error", `${label}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }, [log, readApiBase]);

  const onLogout = useCallback(async () => {
    await signOut();
    setTokenSummary("—");
    log("status", "signed out (credentials + web session)");
  }, [signOut, log]);

  let apiBase: string;
  try {
    apiBase = env.apiBaseUrl || "(empty)";
  } catch {
    apiBase = "(not set)";
  }

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.buttons}>
        <Link href="/" style={styles.link}>
          ← home
        </Link>
        {/* STAGE 0 SPIKE. Reached from here rather than from anywhere a learner goes, because it is
            an instrument: see docs/2026-08-22-openai-realtime-second-provider.md §12. */}
        <Link href="/realtime" style={styles.link}>
          openai realtime spike →
        </Link>
      </View>

      <View style={styles.stats}>
        <Stat label="state" value={busy ? "working" : status} />
        <Stat label="token" value={tokenSummary} />
      </View>

      <Text style={styles.meta} numberOfLines={1}>
        {label ?? "—"}
      </Text>
      <Text style={styles.meta} numberOfLines={1}>
        sub: {sub ?? "—"}
      </Text>
      <Text style={styles.meta} numberOfLines={1}>
        api: {apiBase}
      </Text>
      {/* The tenant misconfiguration this whole repair exists for — see `lib/auth.tsx`. */}
      <RefreshTokenWarning />
      {reason ? <Text style={styles.meta}>{reason}</Text> : null}
      {error ? <Text style={styles.err}>{error}</Text> : null}

      <View style={styles.buttons}>
        <Button label="Log in" onPress={onLogin} />
        <Button label="Renew" onPress={onRenew} />
        <Button label="Log out" onPress={onLogout} />
      </View>
      <View style={styles.buttons}>
        <Button label="GET /me" onPress={onCallMe} />
        <Button label="401 checks" onPress={onCallMeUnauthed} />
      </View>

      <ScrollView style={styles.log} contentContainerStyle={styles.logContent}>
        {entries.map((e) => (
          <Text key={e.id} style={[styles.line, kindStyles[e.kind]]}>
            {e.at} {e.text}
          </Text>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

function Button({ label, onPress }: { label: string; onPress: () => void }) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <Pressable style={styles.button} onPress={onPress}>
      <Text style={styles.buttonLabel}>{label}</Text>
    </Pressable>
  );
}

/**
 * Per-scheme styles (D71) — see the note in app/(tabs)/(lessons)/index.tsx.
 *
 * `KIND_STYLE` is indexed by the log entry's kind, so it becomes a factory alongside `makeStyles`
 * rather than staying a module constant.
 */
const makeKindStyles = (t: Palette) =>
  StyleSheet.create({
    you: { color: t.ok, fontWeight: "700" },
    agent: { color: t.text },
    status: { color: t.accent },
    appstate: { color: t.warn },
    error: { color: t.error },
    note: { color: t.muted },
  });

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.bg, paddingHorizontal: 16 },
    link: { color: t.accent, fontSize: 12, paddingVertical: 8 },
    stats: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    stat: { minWidth: "45%", flexGrow: 1, backgroundColor: t.panel, borderRadius: 8, padding: 8 },
    statLabel: { color: t.muted, fontSize: 10 },
    statValue: { color: t.text, fontSize: 14, fontVariant: ["tabular-nums"] },
    meta: { color: t.faint, fontSize: 10, marginTop: 6 },
    err: { color: t.error, fontSize: 11, marginTop: 6 },
    buttons: { flexDirection: "row", gap: 8, marginTop: 10 },
    button: { flex: 1, backgroundColor: t.panel, borderRadius: 8, paddingVertical: 12 },
    buttonLabel: { color: t.text, textAlign: "center", fontSize: 14, fontWeight: "600" },
    log: { flex: 1, backgroundColor: t.sunken, borderRadius: 8, marginTop: 12 },
    logContent: { padding: 8, gap: 2 },
    line: { fontSize: 11, fontVariant: ["tabular-nums"] },
  });
