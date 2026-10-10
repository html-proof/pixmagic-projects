"use client";
import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void) {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
const getSnapshot = () => window.matchMedia(QUERY).matches;
const getServerSnapshot = () => false;

/**
 * True when the visitor asked their system for less motion. Scenes use it to swap scroll-driven
 * choreography for a static, fully readable final state (no particles, no parallax, no sticky
 * runways).
 *
 * Hydration renders with the server's answer (false) and only then switches, so the static HTML
 * hydrates cleanly. Motion's own useReducedMotion reads matchMedia on the first client render,
 * which made every scene that branches on it fail hydration for these visitors. Until JS runs,
 * the CSS in globals.css (prefers-reduced-motion) keeps that first paint readable.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
