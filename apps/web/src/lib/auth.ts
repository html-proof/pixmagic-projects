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
  providers: { google: boolean; apple: boolean };
  emailOtp: boolean;
}

export type SocialProvider = "google" | "apple";

export const authConfig = () => api<AuthConfig>("/auth/config");

export const signIn = (email: string, password: string) =>
  api<{ user: SignedInUser }>("/auth/login", { method: "POST", body: { email, password } });

export const signUp = (input: { name: string; email: string; password: string; confirmPassword: string; acceptTerms: boolean }) =>
  api<{ ok: true; next: "confirm"; email: string }>("/auth/signup", { method: "POST", body: input });

export const confirmSignUp = (email: string, code: string) => api<{ ok: true }>("/auth/signup/confirm", { method: "POST", body: { email, code } });

export const resendSignUpCode = (email: string) => api<{ ok: true; message: string }>("/auth/signup/resend", { method: "POST", body: { email } });

export const forgotPassword = (email: string) => api<{ ok: true; message: string }>("/auth/password/forgot", { method: "POST", body: { email } });

export const resetPassword = (input: { email: string; code: string; password: string; confirmPassword: string }) =>
  api<{ ok: true }>("/auth/password/reset", { method: "POST", body: input });

export const startEmailCodeSignIn = (email: string) => api<{ ok: true; message: string }>("/auth/otp/start", { method: "POST", body: { email } });

export const finishEmailCodeSignIn = (email: string, code: string) =>
  api<{ user: SignedInUser }>("/auth/otp/verify", { method: "POST", body: { email, code } });

/**
 * "Continue with Google / Apple": a full-page trip through the user pool to the provider and back
 * to /auth/callback. No popup, so no Cross-Origin-Opener-Policy warnings and nothing for a popup
 * blocker to stop.
 */
export function continueWith(provider: SocialProvider, returnTo?: string | null) {
  const q = returnTo && isSafePath(returnTo) ? `?${new URLSearchParams({ returnTo })}` : "";
  window.location.assign(`/api/auth/oauth/${provider}/start${q}`);
}

/** /auth/callback hands back what the provider (via Cognito) put in its address. */
export const finishOAuth = (params: { state: string; code?: string; error?: string; error_description?: string }) =>
  api<{ user: SignedInUser; redirect: string | null }>("/auth/oauth/callback", { method: "POST", body: params });

/**
 * Sign this browser out. After Google or Apple the user pool's own session in this browser is
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

export interface AccountInfo {
  user: SignedInUser & { timezone: string };
  signedInWith: "password" | "google" | "apple";
  signedInAt: number;
  sessionExpiresAt: number;
  methods: Array<{ method: "password" | "google" | "apple"; email: string | null; linkedAt: string; lastUsedAt: string | null }>;
  canChangePassword: boolean;
  canChangeEmail: boolean;
}

export const changePassword = (input: { currentPassword: string; password: string; confirmPassword: string }) =>
  api<{ ok: true }>("/auth/account/password", { method: "POST", body: input });

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
        const me = await api<{ user: { emailVerified: boolean } | null }>("/auth/whoami");
        // Verified only: /verify-email sends an unverified session here, and sending it back into
        // the app would bounce it straight back.
        if (me.user?.emailVerified && !stopped) router.replace(afterSignIn());
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
