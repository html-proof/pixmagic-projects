"use client";
import { useEffect } from "react";
import { api, ApiError, isTransient, keepRetrying } from "./api";
import { isSafePath, takeReturnTo } from "./returnTo";

/**
 * Every sign-in, sign-up and account-security call the UI makes, in one place. They all go to our
 * API, which talks to Amazon Cognito: the page never holds a Cognito token or secret, and the
 * session is an httpOnly cookie the API sets (apps/api/src/session.ts).
 */

export interface SignedInUser {
  id: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
}

/** Which "Continue with ..." options this deployment offers. */
export interface AuthConfig {
  providers: { google: boolean };
  emailOtp: boolean;
}

export type SocialProvider = "google";

let configRequest: Promise<AuthConfig> | null = null;

/** The sign-in page and its "Continue with" buttons both ask: one request, shared (a failure isn't kept). */
export const authConfig = () =>
  (configRequest ??= api<AuthConfig>("/auth/config").catch((e: unknown) => {
    configRequest = null;
    throw e;
  }));

/**
 * `keep` false: "Keep me signed in" unticked, so the session ends when the browser closes.
 * `next: "mfa"`: the password was right and the account has two-step verification: the code from
 * the authenticator app finishes signing in (finishMfaSignIn).
 */
export const signIn = (email: string, password: string, keep = true) =>
  api<{ user: SignedInUser } | { next: "mfa" }>("/auth/login", { method: "POST", body: { email, password, keep } });

/** The authenticator app's code after the password (the API kept the rest of the sign-in, for this browser only). */
export const finishMfaSignIn = (code: string) => api<{ user: SignedInUser }>("/auth/login/mfa", { method: "POST", body: { code } });

export const signUp = (input: { name: string; email: string; password: string; confirmPassword: string; acceptTerms: boolean }) =>
  api<{ ok: true; next: "confirm"; email: string }>("/auth/signup", { method: "POST", body: input });

/**
 * The sign-up code. With `signIn` (the password chosen on this page) it signs in too, and that
 * password is the one the account keeps, whoever else signed up with the address meanwhile: the
 * code proves the inbox. No `user` in the answer: the address was confirmed already (another tab),
 * so sign in as usual.
 */
export const confirmSignUp = (email: string, code: string, signIn?: { password: string; keep?: boolean }) =>
  api<{ ok: true; user?: SignedInUser }>("/auth/signup/confirm", { method: "POST", body: { email, code, ...signIn } });

export const resendSignUpCode = (email: string) => api<{ ok: true; message: string }>("/auth/signup/resend", { method: "POST", body: { email } });

export const forgotPassword = (email: string) => api<{ ok: true; message: string }>("/auth/password/forgot", { method: "POST", body: { email } });

/** `otherMethods`: the account's other ways to sign in ("google"), which a new password doesn't end. */
export const resetPassword = (input: { email: string; code: string; password: string; confirmPassword: string }) =>
  api<{ ok: true; otherMethods?: SignInMethodName[] }>("/auth/password/reset", { method: "POST", body: input });

export const startEmailCodeSignIn = (email: string) => api<{ ok: true; message: string }>("/auth/otp/start", { method: "POST", body: { email } });

export const finishEmailCodeSignIn = (email: string, code: string, keep = true) =>
  api<{ user: SignedInUser } | { next: "mfa" }>("/auth/otp/verify", { method: "POST", body: { email, code, keep } });

/**
 * "Continue with Google": a full-page trip through the user pool to the provider and back
 * to /auth/callback. No popup, so no Cross-Origin-Opener-Policy warnings and nothing for a popup
 * blocker to stop. `keep` false: "Keep me signed in" was unticked.
 */
export function continueWith(provider: SocialProvider, returnTo?: string | null, keep = true) {
  const q = new URLSearchParams();
  if (returnTo && isSafeDestination(returnTo)) q.set("returnTo", returnTo);
  if (!keep) q.set("keep", "0");
  const query = q.toString();
  window.location.assign(`/api/auth/oauth/${provider}/start${query ? `?${query}` : ""}`);
}

/**
 * A path of this site as the browser will read it. isSafePath checks the text; this also checks
 * where it leads once dot segments are resolved ("/..//evil.example" is "//evil.example").
 */
export function isSafeDestination(path: unknown): path is string {
  if (!isSafePath(path)) return false;
  try {
    const u = new URL(path, window.location.origin);
    return u.origin === window.location.origin && isSafePath(`${u.pathname}${u.search}${u.hash}`);
  } catch {
    return false;
  }
}

/** Linking from Settings in this tab: where to come back to, for a callback the API can't place any more. */
const LINK_KEY = "insights:linking";
const LINK_TTL_MS = 10 * 60_000;
/** The API's limit for linking without the password again (RECENT_SIGN_IN_S), less a minute for the trip. */
const LINK_RECENT_MS = 14 * 60_000;

/**
 * Linking adds a way into the account, so it needs a sign-in in the last 15 minutes or the
 * password: true when this session is older, and the page should ask for the password
 * (prepareGoogleLink) before linkGoogle.
 */
export const linkNeedsPassword = (account: Pick<AccountInfo, "signedInAt">, now = Date.now()) => now - account.signedInAt > LINK_RECENT_MS;

/** The password again, so this session may start one link to Google in the next five minutes. Password sessions only. */
export const prepareGoogleLink = (password: string) => api<{ ok: true; expiresInSeconds: number }>("/auth/account/methods/google/prepare", { method: "POST", body: { password } });

/**
 * Link a Google account to the signed-in account (Settings): a full-page trip to Google and back.
 * The person comes back to `returnTo` (a path of this site) with `?linked=google`, or with
 * `?link_error=<code>` (linkErrorMessage words it). The session stays the one they have. A session
 * older than 15 minutes needs prepareGoogleLink first (linkNeedsPassword), or comes back with
 * `?link_error=reauth_required`.
 */
export function linkGoogle(returnTo: string) {
  const back = isSafeDestination(returnTo) ? returnTo : "/settings/security";
  try {
    sessionStorage.setItem(LINK_KEY, JSON.stringify({ path: back, at: Date.now() }));
  } catch {
    /* storage blocked: the API still names where to go back to */
  }
  window.location.assign(`/api/auth/oauth/google/start?${new URLSearchParams({ link: "1", returnTo: back })}`);
}

/** The page a link from Settings started on, consumed; null when none is under way in this tab. */
export function takeLinkReturn(): string | null {
  try {
    const raw = sessionStorage.getItem(LINK_KEY);
    sessionStorage.removeItem(LINK_KEY);
    if (!raw) return null;
    const { path, at } = JSON.parse(raw) as { path?: unknown; at?: number };
    return isSafeDestination(path) && typeof at === "number" && Date.now() - at < LINK_TTL_MS ? path : null;
  } catch {
    return null;
  }
}

/** `path` (a page of this site; Settings → Security if it isn't one) with `?<key>=<value>` added (or replaced). */
export function withQuery(path: string, key: string, value: string) {
  const u = new URL(isSafeDestination(path) ? path : "/settings/security", window.location.origin);
  u.searchParams.set(key, value);
  return `${u.pathname}${u.search}${u.hash}`;
}

/** What to tell the person when linking Google came back with `?link_error=<code>`. */
export function linkErrorMessage(code: string): string {
  switch (code) {
    case "cancelled":
      return "Linking Google was cancelled. Nothing was changed.";
    case "google_in_use":
      return "That Google account already signs in to another bizinsights account. Remove it there first, or use a different Google account.";
    case "already_linked":
      return "Your account already has a Google sign-in. Remove it first to link a different one.";
    case "signin_required":
    case "signin_changed":
      return "Sign in to your account again, then link Google.";
    case "reauth_required":
      return "For your safety, enter your password again, then link Google.";
    case "email_unverified":
      return "Verify your email address first, then link Google.";
    case "provider_unavailable":
      return "Signing in with Google isn't available right now.";
    case "rate_limited":
      return "Too many attempts from your network. Wait a few minutes, then try again.";
    case "unavailable":
      return "We can't reach the sign-in service right now. Please try again in a moment.";
    case "code_invalid":
    case "state_expired":
    case "state_mismatch":
      return "That took too long. Please try again.";
    default:
      return "We couldn't link that Google account. Please try again.";
  }
}

/**
 * /auth/callback hands back what the provider (via Cognito) put in its address. A sign-in answers
 * with the user; a link from Settings with `linked` and where to go back to.
 */
export const finishOAuth = (params: { state: string; code?: string; error?: string; error_description?: string }) =>
  api<{ user: SignedInUser; redirect: string | null } | { linked: "google"; redirect: string }>("/auth/oauth/callback", { method: "POST", body: params });

/**
 * Sign this browser out. After Google the user pool's own session in this browser is
 * ended too (a trip to its logout page, which comes back to /login).
 */
export async function signOut(): Promise<string> {
  const r = await api<{ redirect: string | null }>("/auth/logout", { method: "POST" }).catch(() => ({ redirect: null }));
  // ?signedOut=1 keeps /login from sending a cookie that survived (logout unreachable) straight back in.
  return r.redirect ?? "/login?signedOut=1";
}

/** Sign out of every device: every session of the account, and its Cognito refresh tokens. */
export async function signOutEverywhere(): Promise<string> {
  const r = await api<{ redirect: string | null }>("/auth/logout-all", { method: "POST" });
  return r.redirect ?? "/login?signedOut=1";
}

/** Go somewhere outside the app's router (the user pool's logout page) or inside it. */
export function leaveTo(href: string, router: { replace(href: string): void }) {
  if (/^https?:\/\//.test(href)) window.location.assign(href);
  else router.replace(href);
}

export type SignInMethodName = "password" | "google";

export interface AccountInfo {
  user: SignedInUser & { timezone: string };
  signedInWith: SignInMethodName;
  signedInAt: number;
  sessionExpiresAt: number;
  methods: Array<{ id: string; method: SignInMethodName; email: string | null; linkedAt: string; lastUsedAt: string | null }>;
  /** The account has an email-and-password sign-in (whatever this session used). */
  hasPassword: boolean;
  /** Google sign-in is offered and this account has none yet: "Link Google account". */
  canLinkGoogle: boolean;
  canChangePassword: boolean;
  canChangeEmail: boolean;
  /** Two-step verification (an authenticator app) on the password. null: couldn't be checked just now. */
  mfaEnabled: boolean | null;
}

/** `signedIn` false: the account asks for an app code at sign-in, so this browser signs in again too. */
export const changePassword = (input: { currentPassword: string; password: string; confirmPassword: string }) =>
  api<{ ok: true; signedIn: boolean }>("/auth/account/password", { method: "POST", body: input });

/** A password for an account that signs in with Google only (needs a Google sign-in in the last 15 minutes). */
export const addPassword = (input: { password: string; confirmPassword: string }) => api<{ ok: true }>("/auth/account/password/add", { method: "POST", body: input });

/** Remove a sign-in method (not the last, nor the one signed in with). `password`: when signed in with one. */
export const removeSignInMethod = (id: string, password?: string) => api<{ ok: true }>(`/auth/account/methods/${encodeURIComponent(id)}`, { method: "DELETE", body: { password } });

/** Two-step verification, step 1: the authenticator app's secret (shown once). */
export const startMfaSetup = (password?: string) => api<{ secret: string; otpauthUri: string }>("/auth/account/mfa/setup", { method: "POST", body: { password } });

/** Step 2: a code from the app turns it on. */
export const confirmMfaSetup = (code: string) => api<{ ok: true; mfaEnabled: true }>("/auth/account/mfa/verify", { method: "POST", body: { code } });

export const turnOffMfa = (password: string, code: string) => api<{ ok: true; mfaEnabled: false }>("/auth/account/mfa/disable", { method: "POST", body: { password, code } });

export const startEmailChange = (email: string, password?: string) =>
  api<{ ok: true; pendingEmail: string }>("/auth/account/email", { method: "POST", body: { email, password } });

export const confirmEmailChange = (code: string) => api<{ user: SignedInUser }>("/auth/account/email/confirm", { method: "POST", body: { code } });

export const sendVerificationCode = () => api<{ ok: true; alreadyVerified?: boolean }>("/auth/account/verify-email/send", { method: "POST" });

export const verifyEmailCode = (code: string) => api<{ user: SignedInUser }>("/auth/account/verify-email", { method: "POST", body: { code } });

export const deleteAccount = (password?: string) => api<{ ok: true }>("/auth/account/delete", { method: "POST", body: { confirm: "DELETE", password } });

/**
 * Where a finished sign-in or sign-up goes: back to the page that asked for it (a deep link opened
 * while signed out, an invitation), else into the app, whose shell sends unverified accounts to
 * /verify-email and new ones to /onboarding. Never via `/`: the landing page there shows the public
 * site whenever its own sign-in check fails, so a database blip right after signing in looked
 * exactly like being signed out.
 */
export const afterSignIn = () => takeReturnTo() ?? "/dashboard";

/**
 * What to tell the person when a sign-in or account call fails. The API's messages are written
 * for them already (and never say whether an account exists); only "no answer at all" needs words.
 */
export function authErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 0) return "We couldn't reach the sign-in service. Check your connection and try again.";
    if (e.status >= 500 && !e.message) return "We couldn't reach the sign-in service. Please try again in a moment.";
    return e.message;
  }
  return "Something went wrong. Please try again.";
}

/** The API error code of a failed call ("unconfirmed", "reset_required", ...), if any. */
export const errorCode = (e: unknown) => (e instanceof ApiError ? e.code : null);

/**
 * Already signed in (and verified)? Then a sign-in or sign-up page has nothing to do: go into the
 * app instead of asking for credentials again (no login-page flash for signed-in people). While the
 * API is unreachable we can't tell, so keep asking until it answers. Not right after signing out.
 */
export function useRedirectIfSignedIn(router: { replace(href: string): void }, enabled = true) {
  useEffect(() => {
    if (!enabled || new URLSearchParams(window.location.search).has("signedOut")) return;
    let stopped = false;
    let stopRetrying: (() => void) | undefined;
    const check = async () => {
      try {
        // /auth/whoami: a visitor is `user: null`, not a 401 the browser would log as an error.
        const me = await api<{ user: { emailVerified: boolean } | null; shared?: unknown }>("/auth/whoami");
        // Verified only: /verify-email sends an unverified session here, and sending it back into
        // the app would bounce it straight back. Nor a dashboard opened from a shared link: signing
        // in to the account is what they came here to do.
        if (me.user?.emailVerified && !me.shared && !stopped) router.replace(afterSignIn());
        return true;
      } catch (e) {
        return !isTransient(e);
      }
    };
    void check().then((done) => {
      if (!done && !stopped) stopRetrying = keepRetrying(check);
    });
    return () => {
      stopped = true;
      stopRetrying?.();
    };
  }, [router, enabled]);
}

/** The address typed on one auth page, for the next (kept in this tab only, never in a URL). */
const EMAIL_KEY = "insights:auth-email";
export function rememberEmail(email: string) {
  try {
    sessionStorage.setItem(EMAIL_KEY, email.trim().toLowerCase());
  } catch {
    /* storage blocked: the next page asks again */
  }
}
export function recallEmail(): string {
  try {
    return sessionStorage.getItem(EMAIL_KEY) ?? "";
  } catch {
    return "";
  }
}
