"use client";
import { useSyncExternalStore } from "react";
import type { AccountInfo } from "./auth";

/**
 * How well the signed-in account is protected, in the words Settings → Security leads with (the
 * card beside its title) and the settings menu repeats (its "Account security" card): what to do
 * first, if anything, and the share of the checks that pass.
 */
export interface SecurityStatus {
  /** All is well ("good"), or something to look at ("warn"). */
  tone: "good" | "warn";
  title: string;
  detail: string;
  /** What looking at it means: the sign-in activity, verifying the address, or two-step verification. */
  fix: "activity" | "email" | "twoStep";
  /** 0-1: the share of the checks that pass. */
  score: number;
  /** One line for the settings menu's card. */
  summary: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function securityStatus(a: AccountInfo): SecurityStatus {
  // Google-only accounts have Google's own 2-Step Verification, which this app can't see; and a
  // check that couldn't be made (null) isn't a failure.
  const twoStep = !a.hasPassword || a.mfaEnabled !== false;
  const checks = [a.user.emailVerified, twoStep, a.failedSignIns === 0];
  const score = checks.filter(Boolean).length / checks.length;
  if (a.failedSignIns > 0) {
    const detail = `${plural(a.failedSignIns, "failed sign-in attempt", "failed sign-in attempts")} in the last 7 days`;
    return { tone: "warn", title: "Review recent sign-ins", detail, fix: "activity", score, summary: `${detail}. Check they were you.` };
  }
  if (!a.user.emailVerified) {
    return { tone: "warn", title: "Verify your email address", detail: "It's how you get back in if you're locked out", fix: "email", score, summary: "Verify your email address to protect your account." };
  }
  if (!twoStep) {
    return { tone: "warn", title: "Turn on two-step verification", detail: "Ask for a code from your phone at every sign-in", fix: "twoStep", score, summary: "Turn on two-step verification to protect your account." };
  }
  return {
    tone: "good",
    title: "Your account is secure",
    detail: "No suspicious activity detected",
    fix: "activity",
    score,
    summary: a.mfaEnabled ? "Your account is protected with two-step verification." : a.hasPassword ? "Your account is protected." : "Your account is protected by your Google sign-in.",
  };
}

// The settings menu shows the status the Security page last loaded (no request of its own: the
// account's details come from Cognito, so every settings page would otherwise ask it again).
let latest: SecurityStatus | null = null;
const listeners = new Set<() => void>();

export function publishSecurityStatus(status: SecurityStatus | null) {
  latest = status;
  for (const l of listeners) l();
}

export function useSecurityStatus(): SecurityStatus | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => latest,
    () => null,
  );
}
