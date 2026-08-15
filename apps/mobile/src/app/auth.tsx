import { API_V2_ROUTES, isApiError, isMeResponse } from "@tutor/shared/api";
import { Link } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth0 } from "react-native-auth0";

import { env } from "@/env";
import { useEventLog } from "@/hooks/use-event-log";
import { useTheme, type Palette } from "@/theme";

/**
 * S2 — Auth0 on the device, Bearer against the server.
 *
 * The gate runs in two halves (research doc §7), because there is no deployment yet:
 *   Half A needs only Auth0 and the phone — login, a JWT access token, silent renewal, logout.
 *   Half B needs `apiBaseUrl` filled in — GET /api/v2/me returning the right `sub`, and 401s.
 *
 * Everything is reported into the same scrollback S1 used, so a failure is readable rather than
 * inferred from a spinner that never stops.
 */
export default function AuthScreen() {
  const { authorize, clearSession, clearCredentials, getCredentials, user, isLoading, error } =
    useAuth0();
  const { entries, log } = useEventLog();
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const kindStyles = useMemo(() => makeKindStyles(theme), [theme]);

  const [tokenSummary, setTokenSummary] = useState<string>("—");

  /**
   * Reading `env.apiBaseUrl` throws while it is unset (it is, until the deploy — §3.2). That is the
   * intended design, so catch it here and show the message instead of white-screening the tool.
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
    (accessToken: string, tokenType: string, expiresAt: number) => {
      const segments = accessToken.split(".").length;
      const isJwt = segments === 3;
      const secondsLeft = Math.round(expiresAt - Date.now() / 1000);
      setTokenSummary(
        `${tokenType} · ${isJwt ? "JWT" : `OPAQUE (${segments} seg)`} · ${secondsLeft}s left`,
      );
      log(isJwt ? "you" : "error", `token: ${tokenType}, ${isJwt ? "JWT ✓" : "NOT a JWT ✗"}`);
      if (!isJwt) {
        log("error", "an opaque token means no audience was requested — check auth0Audience");
      }
      if (tokenType !== "Bearer") {
        log("error", `tokenType is "${tokenType}", not Bearer — is useDPoP still enabled?`);
      }
    },
    [log],
  );

  const onLogin = useCallback(async () => {
    try {
      log("note", `authorize → audience ${env.auth0Audience}`);
      const credentials = await authorize({
        audience: env.auth0Audience,
        // offline_access yields a refresh token, which is what makes getCredentials() renew
        // silently. Without it the learner re-authenticates mid-lesson, which is not shippable.
        scope: "openid profile email offline_access",
      });
      if (!credentials) return log("error", "authorize returned no credentials");
      describe(credentials.accessToken, credentials.tokenType, credentials.expiresAt);
    } catch (e) {
      log("error", `authorize failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [authorize, log, describe]);

  /** Renewal: with the API lifetime temporarily at 300s (D17), this must not prompt for login. */
  const onRefresh = useCallback(async () => {
    try {
      const credentials = await getCredentials();
      if (!credentials)
        return log("error", "getCredentials returned nothing — is the session gone?");
      describe(credentials.accessToken, credentials.tokenType, credentials.expiresAt);
      log("status", "getCredentials returned without prompting ✓");
    } catch (e) {
      log("error", `getCredentials failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [getCredentials, log, describe]);

  const onCallMe = useCallback(async () => {
    const base = readApiBase();
    if (!base) return;
    try {
      const credentials = await getCredentials();
      const url = `${base}${API_V2_ROUTES.me}`;
      log("note", `GET ${url}`);
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${credentials?.accessToken ?? ""}` },
      });
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
  }, [getCredentials, log, readApiBase]);

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
    try {
      // Both: clearCredentials drops the Keychain copy, clearSession ends the Auth0 web session.
      // Without the second, the next login silently reuses the browser session and never shows the
      // prompt — which makes the login gate untestable after the first run.
      await clearCredentials();
      await clearSession();
      setTokenSummary("—");
      log("status", "logged out (credentials + web session)");
    } catch (e) {
      log("error", `logout failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [clearCredentials, clearSession, log]);

  let apiBase: string;
  try {
    apiBase = env.apiBaseUrl || "(empty)";
  } catch {
    apiBase = "(not set — blocked on deploy)";
  }

  return (
    <SafeAreaView style={styles.screen}>
      <Link href="/" style={styles.link}>
        ← home
      </Link>

      <View style={styles.stats}>
        <Stat label="state" value={isLoading ? "loading" : user ? "signed in" : "signed out"} />
        <Stat label="token" value={tokenSummary} />
      </View>

      <Text style={styles.meta} numberOfLines={1}>
        sub: {user?.sub ?? "—"}
      </Text>
      <Text style={styles.meta} numberOfLines={1}>
        api: {apiBase}
      </Text>
      {error ? <Text style={styles.err}>{error.message}</Text> : null}

      <View style={styles.buttons}>
        <Button label="Log in" onPress={onLogin} />
        <Button label="Renew" onPress={onRefresh} />
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
