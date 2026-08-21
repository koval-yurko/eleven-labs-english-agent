import { type Palette } from "@tutor/shared/theme";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth0 } from "react-native-auth0";

import type { TokenSource } from "@/api";
import { env } from "@/env";
import { useTheme } from "@/theme";
// The leaf modules rather than the `@/ui` barrel, deliberately: `AppHeader` reads `useSession` from
// this file, so the barrel would close a cycle (ui → AppHeader → lib/auth → ui). None of the three
// modules below imports anything from `lib/`, so the graph stays a tree.
import { Button } from "@/ui/Button";
import { Body, ErrorText, H1, Muted, WarnText } from "@/ui/Text";
import { layout, space } from "@/ui/tokens";

/**
 * The app's session — one sign-in flow, one token source, one way back from a dead session.
 *
 * ## What was broken
 *
 * There was no login flow at all. `app/auth.tsx` — a debug screen reached from a link at the bottom
 * of the lessons list — held the only `authorize()` call in the app, and every product screen
 * simply assumed a session existed:
 *
 * ```ts
 * const { getCredentials } = useAuth0();
 * const accessToken = useCallback(async () => (await getCredentials())?.accessToken ?? null, […]);
 * ```
 *
 * That closure was copied into five screens, and none of them could tell "the request failed" from
 * "there is no session". So a learner whose credentials could not be renewed saw *the credentials
 * manager's own sentence* — “The stored credentials instance does not contain a refresh token.” —
 * rendered as a load error under `0 items`, with a **Try again** button that could only ever
 * produce the same sentence again. There was no sign-in button on that screen, and no way to reach
 * one, because reaching one meant loading the lessons list, which failed the same way.
 *
 * ## What produces that sentence
 *
 * `getCredentials()` renews an expired access token using the refresh token. When the stored
 * credentials have no refresh token there is nothing to renew with, and iOS's credentials manager
 * throws `NO_REFRESH_TOKEN` — forever, because nothing in the app ever cleared the dead entry.
 * The Keychain copy outlives the process, so this survives an app kill and a device restart: once
 * a device was in this state it stayed there.
 *
 * Credentials arrive without a refresh token when the tenant does not issue one. Two switches
 * decide that, and BOTH have to be on (see docs/2026-08-21-login-and-auth-flow-repair.md §2):
 *
 *  - Auth0 → **APIs** → the API this app asks for → Settings → **Allow Offline Access**.
 *  - Auth0 → **Applications** → the Native app → Advanced Settings → Grant Types → **Refresh
 *    Token**.
 *
 * With either off, `offline_access` is dropped from the grant silently — the login SUCCEEDS and
 * the app works until the access token expires, which is why this reads as "login works, then the
 * app logs itself out later". `signIn` below therefore inspects what came back and raises
 * `refreshTokenMissing`, so the condition is visible at login rather than a day later.
 *
 * ## What this module guarantees
 *
 *  1. **A signed-out app shows a sign-in screen**, not a product screen full of red text.
 *  2. **A credentials failure that no retry can fix ends the session** instead of being reported
 *     as a load error. `accessToken()` classifies the error; a terminal one clears the Keychain
 *     entry and drops the app to the sign-in screen with a sentence saying why.
 *  3. **One token source**, `useAccessToken()`, shared by every screen — so a fix like the two
 *     above lands everywhere at once rather than in whichever copy was remembered.
 */

/**
 * The scope every login must request.
 *
 * `offline_access` is the difference between shippable and not: without a refresh token
 * `getCredentials()` cannot renew, and the learner re-authenticates when the access token expires —
 * mid-lesson, on a phone, during a spoken conversation (docs/2026-08-13-expo-s2-auth0-bearer.md §5).
 */
export const LOGIN_SCOPE = "openid profile email offline_access";

/**
 * Renew a token that is within this many seconds of expiring, rather than handing it out.
 *
 * A token with four seconds left passes every check here and is still rejected by the server by the
 * time the request lands. `minTtl` moves that decision to the one place that can act on it. Kept
 * well under any plausible API token lifetime; `LARGE_MIN_TTL` (the error for "your minimum exceeds
 * the token's whole lifetime") is handled anyway, because that lifetime is a dashboard value this
 * app does not control.
 */
const MIN_TTL_SECONDS = 30;

/**
 * Credential failures no retry can fix — the session is structurally over, so end it.
 *
 * Every code here describes the *stored entry*, not the moment: there is no refresh token, or it is
 * for a key pair this build cannot use, or the identity provider's own session ceiling has passed.
 * Trying again in a minute cannot change any of them.
 *
 * **`RENEW_FAILED` is deliberately NOT in this set.** iOS has no separate network code for a
 * renewal — Auth0.swift reports an unreachable token endpoint as `renewFailed`, exactly as it
 * reports a revoked refresh token. Treating it as terminal would mean a tunnel, a captive portal or
 * a dropped connection *deleting a working refresh token*, and the learner re-authenticating
 * because a train went into a hill. It is reported as an ordinary, retryable error instead
 * (`RENEW_FAILED_MESSAGE`); if the token really was revoked, every attempt keeps failing and the
 * account screen's **Log out** is one link away in the header.
 */
const TERMINAL_CREDENTIAL_ERRORS: ReadonlySet<string> = new Set([
  "NO_CREDENTIALS",
  "NO_REFRESH_TOKEN",
  "INVALID_CREDENTIALS",
  "SESSION_EXPIRED",
  // The DPoP family: credentials bound to a key pair this build cannot use. `useDPoP={false}` in
  // app/_layout.tsx means we never mint these, but a build that once had DPoP on leaves them
  // behind, and they are exactly as unrecoverable as a missing refresh token.
  "DPOP_KEY_MISSING",
  "DPOP_NOT_CONFIGURED",
  "DPOP_KEY_MISMATCH",
]);

/** What a failed renewal says instead of Auth0's "Failed to renew credentials". */
const RENEW_FAILED_MESSAGE = "Couldn’t refresh your session — check your connection and try again.";

/** Thrown by the shared token source once the session is gone. Callers need not render it. */
export class SignedOutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignedOutError";
  }
}

/** The one sentence a learner sees when their session could not be renewed. */
const SESSION_ENDED = "Your session ended. Sign in to continue.";

type SessionStatus = "checking" | "signed-in" | "signed-out";

type Session = {
  status: SessionStatus;
  /** The learner, once signed in — `email` when the profile has one, `sub` otherwise. */
  label: string | null;
  sub: string | null;
  /** A sign-in or sign-out that failed, ready to render. Cleared by the next attempt. */
  error: string | null;
  /** Why the app signed itself out, when it was not the learner's doing. */
  reason: string | null;
  /**
   * True when the last login produced no refresh token — the tenant misconfiguration described in
   * the module docblock. The session works until the access token expires and then ends.
   */
  refreshTokenMissing: boolean;
  /** A sign-in or sign-out is in flight; both open a browser sheet, so neither may be re-entered. */
  busy: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  /** The app's only access-token source. See `useAccessToken`. */
  accessToken: TokenSource;
};

const SessionContext = createContext<Session | null>(null);

/** Read `type` off an Auth0 error (`CredentialsManagerError`, `WebAuthError`, …) without casting. */
function errorType(e: unknown): string | null {
  if (typeof e !== "object" || e === null) return null;
  const { type, code } = e as { type?: unknown; code?: unknown };
  if (typeof type === "string") return type;
  if (typeof code === "string") return code;
  return null;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A learner who dismissed the browser sheet asked for nothing to happen — not for an error. */
function isCancellation(e: unknown): boolean {
  return errorType(e) === "USER_CANCELLED";
}

/**
 * The session, above the router.
 *
 * Holds no UI: `AuthGate` decides what to draw, so a consumer that only needs a token (the tutor
 * session provider) can sit above the gate and still share this state.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const {
    authorize,
    cancelWebAuth,
    clearCredentials,
    clearSession,
    getCredentials,
    hasValidCredentials,
    user,
    isLoading,
  } = useAuth0();

  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [refreshTokenMissing, setRefreshTokenMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  /**
   * What the Keychain holds when `Auth0Provider` has no user — `null` until the probe below
   * answers.
   *
   * The provider restores a user only when it can both find valid credentials AND read an id token
   * out of them; anything else leaves `user` null with the stored entry untouched. That single
   * "null" covers two opposite situations, and the whole bug lived in the gap between them:
   *
   *  - **nothing usable is stored** — the dead entry from a session that could not be renewed. It
   *    must be removed, because it is what the next `getCredentials()` finds, and the app must ask
   *    for a sign-in.
   *  - **something renewable is stored** — the launch simply could not reach Auth0 to renew. The
   *    refresh token is intact and must be kept; showing a sign-in screen here would ask a
   *    signed-in learner to authenticate over a connection that is not working.
   *
   * `hasValidCredentials()` separates them without a network round trip: it is `canRenew() ||
   * hasValid()`, both local reads.
   */
  const [storedCredentials, setStoredCredentials] = useState<boolean | null>(null);

  /** `busy` as a ref too: the guard has to hold between two `await`s, not between two renders. */
  const busyRef = useRef(false);
  /** The in-flight purge, so ten failing requests produce one `clearCredentials`, not ten. */
  const purgeRef = useRef<Promise<void> | null>(null);

  /**
   * Drop the stored credentials and record why.
   *
   * `clearCredentials` (not `clearSession`) on purpose: this runs from a failed request, and
   * `clearSession` opens a browser sheet. Ending the Auth0 web session behind the learner's back
   * would also make the next sign-in re-enter a password that the SSO session could have supplied.
   */
  const endSession = useCallback(
    async (why: string) => {
      setReason(why);
      setRefreshTokenMissing(false);
      setStoredCredentials(false);
      if (!purgeRef.current) {
        purgeRef.current = clearCredentials()
          .catch(() => {
            // Nothing to do: the entry is unusable either way, and the app is already showing the
            // sign-in screen. A failure here would only be reported as a second error.
          })
          .finally(() => {
            purgeRef.current = null;
          });
      }
      await purgeRef.current;
    },
    [clearCredentials],
  );

  /**
   * The app's access token, renewed when it is close to expiring and only asked for once.
   *
   * The `forceRefresh` argument is what `apiFetch` passes when the server rejected a token that
   * looked fine here — see `api.ts`.
   */
  const accessToken = useCallback<TokenSource>(
    async (options) => {
      const read = (minTtl: number) =>
        getCredentials(undefined, minTtl, undefined, options?.forceRefresh);
      try {
        let credentials;
        try {
          credentials = await read(MIN_TTL_SECONDS);
        } catch (e) {
          // "Your minimum exceeds the token's lifetime" — the API's lifetime is a dashboard value,
          // so take whatever it will give rather than failing over a safety margin.
          if (errorType(e) !== "LARGE_MIN_TTL") throw e;
          credentials = await read(0);
        }
        return credentials?.accessToken ?? null;
      } catch (e) {
        const type = errorType(e);
        if (type && TERMINAL_CREDENTIAL_ERRORS.has(type)) {
          await endSession(SESSION_ENDED);
          throw new SignedOutError(SESSION_ENDED);
        }
        // Retryable, and the SDK's own wording ("Failed to renew credentials") reads as final.
        if (type === "RENEW_FAILED") throw new Error(RENEW_FAILED_MESSAGE);
        throw e;
      }
    },
    [getCredentials, endSession],
  );

  const signIn = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const parameters = { audience: env.auth0Audience, scope: LOGIN_SCOPE };
      let credentials;
      try {
        credentials = await authorize(parameters);
      } catch (e) {
        // A login the learner backgrounded leaves the transaction open, and every later attempt
        // fails with this until the app is killed. Cancel it and try once more, which is the
        // difference between "tap Sign in again" and "reinstall the app".
        if (errorType(e) !== "TRANSACTION_ACTIVE_ALREADY") throw e;
        await cancelWebAuth().catch(() => {});
        credentials = await authorize(parameters);
      }
      setReason(null);
      setStoredCredentials(true);
      setRefreshTokenMissing(!credentials?.refreshToken);
    } catch (e) {
      if (!isCancellation(e)) setError(messageOf(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [authorize, cancelWebAuth]);

  const signOut = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      // Local first, remote second. `clearSession` opens a browser sheet and can be dismissed; if
      // it is, this device must still be signed out. The second call ends the Auth0 web session,
      // without which the next sign-in silently reuses it and never prompts.
      await clearCredentials();
      setReason(null);
      setRefreshTokenMissing(false);
      setStoredCredentials(false);
      await clearSession();
    } catch (e) {
      if (!isCancellation(e)) setError(messageOf(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [clearCredentials, clearSession]);

  /**
   * Ask what is stored whenever the provider ends up without a user, and sweep a dead entry.
   *
   * This is the repair for the reported bug. The device in the screenshots held credentials with no
   * refresh token: `Auth0Provider` could not restore them, so the app called itself "signed out",
   * while `getCredentials()` kept finding the same dead entry and answering “The stored credentials
   * instance does not contain a refresh token.” — at 16:23, and again three hours later. Nothing in
   * the app removed it, so nothing ever would have.
   *
   * Runs again after a sign-out (`user` goes null), which is correct and costs one local read: the
   * answer then is "nothing stored", which is what the sign-in screen wants to know. The state
   * setters in `endSession`/`signOut` mean the screen does not flash the spinner while it re-asks.
   */
  useEffect(() => {
    if (isLoading || user) return;
    let cancelled = false;
    void (async () => {
      let usable = false;
      try {
        usable = await hasValidCredentials();
      } catch {
        usable = false;
      }
      if (cancelled) return;
      // Neither valid nor renewable: unusable by definition, and only in the way.
      if (!usable) await clearCredentials().catch(() => {});
      if (!cancelled) setStoredCredentials(usable);
    })();
    return () => {
      cancelled = true;
    };
  }, [isLoading, user, hasValidCredentials, clearCredentials]);

  /**
   * Signed in means "this device holds credentials", not "a profile was parsed".
   *
   * `user` is derived from the id token, so a launch that could not renew has no user and perfectly
   * good credentials — see `storedCredentials`. Gating on the profile would sign that learner out
   * of an app they are signed in to.
   */
  const status: SessionStatus = isLoading
    ? "checking"
    : user || storedCredentials
      ? "signed-in"
      : storedCredentials === null
        ? "checking"
        : "signed-out";

  const value = useMemo<Session>(
    () => ({
      status,
      label: user ? (user.email ?? user.sub ?? null) : null,
      sub: user?.sub ?? null,
      error,
      reason,
      refreshTokenMissing,
      busy,
      signIn,
      signOut,
      accessToken,
    }),
    [status, user, error, reason, refreshTokenMissing, busy, signIn, signOut, accessToken],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** The session. Throws outside `AuthProvider`, which is a wiring bug rather than a runtime state. */
export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession must be used inside <AuthProvider>.");
  return session;
}

/**
 * The app's one access-token source, for `apiFetch` and everything built on it.
 *
 * Replaces the five hand-rolled copies of `(await getCredentials())?.accessToken`. Identity is
 * stable for the life of the provider, so it can be a dependency of a `useCallback` without
 * re-running the effect that owns it on every render.
 */
export function useAccessToken(): TokenSource {
  return useSession().accessToken;
}

/**
 * The gate: the app, or the way into it.
 *
 * Rendered around the navigator rather than as a route, so there is no window in which a product
 * screen mounts and fires a request before a redirect takes it away — the window this bug lived in.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { status } = useSession();
  if (status === "checking") return <CheckingScreen />;
  if (status === "signed-out") return <SignInScreen />;
  return <>{children}</>;
}

/** The Keychain read is local and fast; this is a frame or two, not a loading screen. */
function CheckingScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.centre}>
        <ActivityIndicator color={theme.accent} />
      </View>
    </SafeAreaView>
  );
}

/**
 * The screen this app never had.
 *
 * Deliberately not built on `Screen`: that renders `AppHeader`, whose links go to the two screens
 * this one exists because the learner cannot reach.
 */
function SignInScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { signIn, busy, error, reason } = useSession();

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom", "left", "right"]}>
      <View style={styles.centre}>
        <View style={styles.card}>
          <H1>🎧 English Tutor</H1>
          <Body style={styles.blurb}>
            Collect the words you want to learn and practise them out loud with your tutor.
          </Body>

          {/* The sentence explaining an unasked-for sign-out. Above the button, because it is the
              reason the button is on screen. */}
          {reason ? <Muted style={styles.reason}>{reason}</Muted> : null}
          {error ? <ErrorText style={styles.reason}>{error}</ErrorText> : null}

          <Button
            label={busy ? "Signing in…" : "Sign in"}
            onPress={() => void signIn()}
            disabled={busy}
            style={styles.action}
          />
        </View>
      </View>
    </SafeAreaView>
  );
}

/**
 * The banner for a session that cannot be renewed — shown on the account screen after a login that
 * returned no refresh token. It names the two dashboard switches, because the app cannot fix this
 * and the person reading it can.
 */
export function RefreshTokenWarning() {
  const { refreshTokenMissing } = useSession();
  if (!refreshTokenMissing) return null;
  return (
    <WarnText>
      Signed in, but Auth0 issued no refresh token — this session ends when the access token
      expires. Turn on “Allow Offline Access” on the API, and the “Refresh Token” grant on the
      Native application.
    </WarnText>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.bg },
    centre: { flex: 1, justifyContent: "center", paddingHorizontal: layout.pagePaddingHorizontal },
    card: { gap: space.row, maxWidth: layout.contentWidth, width: "100%", alignSelf: "center" },
    blurb: { color: t.muted },
    reason: { marginTop: space.row },
    action: { marginTop: space.row },
  });
