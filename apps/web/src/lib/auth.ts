"use client";
import { useEffect } from "react";
import type { DeviceDescription } from "@app/shared/device";
import { api, ApiError, isTransient, keepRetrying } from "./api";
import { isSafeDestination, takeReturnTo } from "./returnTo";

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

/** Which "Continue with ..." options this deployment offers, and which code steps it asks for. */
export interface AuthConfig {
  providers: { google: boolean };
  /** Passwordless sign-in with a code Cognito emails (off unless the deployment has SES). */
  emailOtp: boolean;
  /** A password sign-in also asks for a code the app emails (accounts without an authenticator app). */
  loginCode: boolean;
}

/**
 * The countdowns of an emailed code, on the server's clock (apps/api/src/emailCode.ts): when it
 * stops being accepted and when another may be asked for. `now` is the server's clock as it
 * answered, so the page places both moments on its own clock whatever the device's time is.
 */
export interface CodeChallenge {
  issuedAt: number;
  expiresAt: number;
  resendAt: number;
  now: number;
}

/** The countdowns a refused resend still names (429 `resend_cooldown`: the standing code's), or null. */
export function challengeFromError(e: unknown): CodeChallenge | null {
  if (!(e instanceof ApiError)) return null;
  const detail = e.data.detail as { challenge?: CodeChallenge } | undefined;
  const ch = detail?.challenge;
  return ch && typeof ch.expiresAt === "number" && typeof ch.resendAt === "number" && typeof ch.now === "number" ? ch : null;
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
 * the authenticator app finishes signing in (finishMfaSignIn). `next: "code"`: the password was
 * right and a 6-digit code was emailed to `email`: it finishes signing in (finishEmailedSignIn).
 */
export type SignInStart = { user: SignedInUser } | { next: "mfa" } | { next: "code"; email: string; challenge: CodeChallenge };
export const signIn = (email: string, password: string, keep = true) => api<SignInStart>("/auth/login", { method: "POST", body: { email, password, keep } });

/** The authenticator app's code after the password (the API kept the rest of the sign-in, for this browser only). */
export const finishMfaSignIn = (code: string) => api<{ user: SignedInUser }>("/auth/login/mfa", { method: "POST", body: { code } });

/** The emailed code after the password (the API holds the rest of the sign-in, for this browser only). */
export const finishEmailedSignIn = (code: string) => api<{ user: SignedInUser }>("/auth/login/code", { method: "POST", body: { code } });

/** Another code for the sign-in waiting in this browser; refused (429 `resend_cooldown`) while the last one's minute lasts. */
export const resendSignInCode = () => api<{ ok: true; message: string; challenge: CodeChallenge }>("/auth/login/code/resend", { method: "POST" });

/** A sign-in waiting for its emailed code in this browser (it survives a reload), with its countdowns; or nothing. */
export const pendingSignInCode = () => api<{ pending: false } | { pending: true; email: string; challenge: CodeChallenge }>("/auth/login/code");

/** Give up the sign-in waiting for its code ("Use a different email"): nothing of it is kept. */
export const cancelSignInCode = () => api<{ ok: true }>("/auth/login/code", { method: "DELETE" });

/** `challenge`: the countdowns of the code emailed to `email` (or of the one already sent, when the form was sent twice). */
export const signUp = (input: { name: string; email: string; password: string; confirmPassword: string; acceptTerms: boolean }) =>
  api<{ ok: true; next: "confirm"; email: string; challenge: CodeChallenge }>("/auth/signup", { method: "POST", body: input });

/**
 * The sign-up code. With `signIn` (the password chosen on this page) it signs in too, and that
 * password is the one the account keeps, whoever else signed up with the address meanwhile: the
 * code proves the inbox. No `user` in the answer: the address was confirmed already (another tab),
 * so sign in as usual.
 */
export const confirmSignUp = (email: string, code: string, signIn?: { password: string; keep?: boolean }) =>
  api<{ ok: true; user?: SignedInUser }>("/auth/signup/confirm", { method: "POST", body: { email, code, ...signIn } });

/** A new sign-up code; refused (429 `resend_cooldown`, with the standing code's countdowns) while the last one's minute lasts. */
export const resendSignUpCode = (email: string) => api<{ ok: true; message: string; challenge: CodeChallenge }>("/auth/signup/resend", { method: "POST", body: { email } });

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

/** A path of this site as the browser will read it, dot segments resolved (returnTo.ts, where return paths are checked too). */
export { isSafeDestination };

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
 * Link a Google account to the signed-in account (Settings): a full-page trip to Google (its
 * account chooser, always) and back. The person comes back to `returnTo` (a path of this site) with
 * `?linked=google`, or with `?link_error=<code>` (linkErrorMessage words it), which is also where a
 * refusal before leaving goes. The session stays the one they have. A session older than 15
 * minutes needs prepareGoogleLink first (linkNeedsPassword), or comes back with
 * `?link_error=reauth_required`. Started with a POST from this page (the API refuses a link to it
 * that another site could open), so call it from a click; it resolves once the page is leaving.
 */
export async function linkGoogle(returnTo: string): Promise<void> {
  const back = isSafeDestination(returnTo) ? returnTo : "/settings/security";
  try {
    sessionStorage.setItem(LINK_KEY, JSON.stringify({ path: back, at: Date.now() }));
  } catch {
    /* storage blocked: the API still names where to go back to */
  }
  let next: string;
  try {
    const { redirect } = await api<{ redirect: string }>("/auth/oauth/google/link", { method: "POST", body: { returnTo: back } });
    next = /^https?:\/\//.test(redirect) ? redirect : withQuery(back, "link_error", "provider_error");
  } catch (e) {
    next = withQuery(back, "link_error", e instanceof ApiError && e.status !== 0 ? e.code : "unavailable");
  }
  window.location.assign(next);
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
    case "start_again":
      return "Please start linking Google again from this page.";
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
  /** No password yet, and this session (Google with the account's own address) may add one. */
  canAddPassword: boolean;
  /** Password session with a verified address: an address nobody has proved stays until it is. */
  canChangeEmail: boolean;
  /**
   * What removing a sign-in method or deleting the account asks for: the account's password; a
   * sign-in in the last 15 minutes (Google with the account's own address); or neither will do
   * from this session (a Google account under another address, and no password): sign in with the
   * account's address.
   */
  confirmWith: "password" | "recent_sign_in" | "own_address_sign_in";
  /** Two-step verification (an authenticator app) on the password. null: couldn't be checked just now. */
  mfaEnabled: boolean | null;
  /** When the password was last set (changed, reset or added); null without a password. */
  passwordChangedAt: string | null;
  /** Sign-ins to this account stopped at the password or the code in the last 7 days. */
  failedSignIns: number;
}

/** Where a device was (last) seen from: approximate, from its address. */
export interface SignInPlace {
  /** ISO 3166 code ("IN"). */
  country: string | null;
  region: string | null;
  city: string | null;
}

/** A device signed in to the account (GET /auth/account/sessions). */
export interface SignedInDevice {
  id: string;
  /** The device asking. */
  current: boolean;
  method: SignInMethodName;
  device: DeviceDescription;
  ip: string | null;
  location: SignInPlace | null;
  signedInAt: string;
  lastActiveAt: string;
  expiresAt: string;
}

/** A sign-in to the account (GET /auth/account/activity): one that got in, or one stopped at the password or the code. */
export interface SignInEvent {
  id: string;
  at: string;
  status: "success" | "failed";
  method: SignInMethodName | null;
  step: "password" | "code" | null;
  device: DeviceDescription;
  ip: string | null;
  location: SignInPlace | null;
}

/** Sign another device out (not this one: that is signOut). */
export const removeDevice = (id: string) => api<{ ok: true }>(`/auth/account/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });

/** A page of the account's sign-ins, newest first. */
export const signInActivity = (cursor?: string | null, limit = 20) =>
  api<{ events: SignInEvent[]; nextCursor: string | null }>(`/auth/account/activity?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);

/** `signedIn` false: the account asks for an app code at sign-in, so this browser signs in again too. */
export const changePassword = (input: { currentPassword: string; password: string; confirmPassword: string }) =>
  api<{ ok: true; signedIn: boolean }>("/auth/account/password", { method: "POST", body: input });

/** A password for an account that signs in with Google only (needs a Google sign-in with its address in the last 15 minutes). */
export const addPassword = (input: { password: string; confirmPassword: string }) => api<{ ok: true }>("/auth/account/password/add", { method: "POST", body: input });

/** Remove a sign-in method (not the last, nor the one signed in with). `password`: when the account asks for it (confirmWith). */
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
