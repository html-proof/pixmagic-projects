"use client";
import type { User } from "firebase/auth";
import { api } from "./api";

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
    "auth/email-already-in-use": "An account with that email already exists. Try signing in.",
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
