import { useEffect, useRef } from "react";
import type { AdProvider } from "./adConnections";

/**
 * Leaving for an ad platform's sign-in, and noticing when the browser comes back without finishing
 * it: the Back button, or the page restored from the back/forward cache. Facebook's own error pages
 * ("Feature Unavailable") never send anyone back to Insights, so this is the one moment to explain
 * them; and a restored page would otherwise keep its button stuck on "Opening…".
 */

const KEY = "ads-sign-in";
/** Older than this is a tab left open, not a trip to the platform and back. */
const FRESH_MS = 30 * 60_000;
const PROVIDERS: readonly string[] = ["meta", "google", "adsense"];

/** Just before the browser goes to the platform. */
export function leavingForSignIn(provider: AdProvider): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ provider, at: Date.now() }));
  } catch {
    /* storage blocked: no explanation when they come back, nothing else changes */
  }
}

/** The platform sent the browser back to Insights (the callback): nothing to explain. */
export function signInFinished(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* storage blocked */
  }
}

function takeUnfinished(): AdProvider | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    if (!raw) return null;
    const { provider, at } = JSON.parse(raw) as { provider?: unknown; at?: unknown };
    return typeof provider === "string" && PROVIDERS.includes(provider) && typeof at === "number" && Date.now() - at < FRESH_MS ? (provider as AdProvider) : null;
  } catch {
    return null;
  }
}

/**
 * Calls `onBack` when this page is shown again by Back from a platform's sign-in: with the platform
 * when it can tell, or with null when the page was only restored from the back/forward cache (its
 * buttons still need resetting).
 */
export function useBackFromSignIn(onBack: (provider: AdProvider | null) => void): void {
  const latest = useRef(onBack);
  useEffect(() => {
    latest.current = onBack;
  });
  useEffect(() => {
    // Loaded afresh by Back. Only when this very page is what Back loaded: the navigation entry
    // still says "back_forward" after moving to another page inside the app.
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    if (nav?.type === "back_forward" && new URL(nav.name).pathname === window.location.pathname) {
      const provider = takeUnfinished();
      if (provider) latest.current(provider);
    }
    const shown = (e: PageTransitionEvent) => {
      if (e.persisted) latest.current(takeUnfinished());
    };
    window.addEventListener("pageshow", shown);
    return () => window.removeEventListener("pageshow", shown);
  }, []);
}
