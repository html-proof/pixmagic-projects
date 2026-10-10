"use client";
import type { User } from "firebase/auth";
import { api } from "./api";
import { takeReturnTo } from "./returnTo";

/**
 * Where a finished sign-in or sign-up goes: back to the page that asked for it (a deep link opened
 * while signed out, an invitation), else into the app, whose shell sends unverified accounts to
 * /verify-email and new ones to /onboarding. Never via `/`: the landing page there shows the public
 * site whenever its own sign-in check fails, so a database blip right after signing in looked
 * exactly like being signed out.
 */
export const afterSignIn = () => takeReturnTo() ?? "/dashboard";

/** Hand a fresh Firebase ID token to the API, which sets an httpOnly session cookie. */
export async function establishSession(user: User) {
  const idToken = await user.getIdToken(true);
  return api<{ user: { emailVerified: boolean } }>("/auth/session", { method: "POST", body: { idToken } });
}

export const authErrorMessage = (e: unknown): string => {
  const code = (e as { code?: string }).code ?? "";
  const map: Record<string, string> = {
    "auth/invalid-credential": "That email and password don't match.",
    "auth/wrong-password": "That email and password don't match.",
    "auth/user-not-found": "That email and password don't match.",
    "auth/email-already-in-use": "An account with that email already exists. Log in instead, or reset your password if you've forgotten it.",
    "auth/missing-password": "Enter your password.",
    "auth/missing-email": "Enter your email address.",
    "auth/user-disabled": "This account has been disabled. Contact support if you think that's a mistake.",
    "auth/user-token-expired": "Your sign-in has expired. Please log in again.",
    "auth/popup-blocked": "Your browser blocked the sign-in window. Allow pop-ups for this site and try again.",
    "auth/cancelled-popup-request": "Sign-in was cancelled.",
    "auth/account-exists-with-different-credential":
      "You already have an account with this email. Log in the way you did before (with your password, or the other provider), then try again.",
    "auth/weak-password": "Use at least 8 characters.",
    "auth/too-many-requests": "Too many attempts. Wait a minute and try again.",
    "auth/popup-closed-by-user": "Sign-in was cancelled.",
    "auth/invalid-email": "Enter a valid email address.",
    // Nothing the person can fix, and nothing they did wrong: the sign-in backend was
    // unreachable or answered unusably. In practice it means a build wired to the wrong
    // Firebase project or to an Auth emulator that isn't running - see the console line below,
    // which is the only place the real cause is visible.
    "auth/internal-error": "We couldn't reach the sign-in service. Please try again in a moment.",
    "auth/network-request-failed": "We couldn't reach the sign-in service. Check your connection and try again.",
  };
  if (map[code]) return map[code]!;

  // These callers (login/signup/start `run()`) funnel *every* failure through here, including
  // ApiError from our own API — whose `message` is already written for the merchant ("That code
  // is invalid or has expired"). Only Firebase's own strings need replacing, so narrow the
  // generic fallback to `auth/*` codes; replacing it unconditionally silently swallowed every
  // API message, which the one-time-code e2e caught.
  if (code.startsWith("auth/")) {
    // Never show a raw Firebase string to a merchant, but don't swallow it either: whoever is
    // debugging needs the code, and this is a static client-side app with no other channel.
    console.error("[auth]", code, e);
    return "Something went wrong signing you in. Please try again.";
  }
  return (e as Error)?.message || "Something went wrong.";
};
