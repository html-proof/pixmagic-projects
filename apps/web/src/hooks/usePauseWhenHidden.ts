"use client";
import type { MotionValue } from "motion/react";
import { useEffect, type RefObject } from "react";

/** Below this a fading layer counts as invisible. */
const VISIBLE = 0.01;

/**
 * Holds the looping CSS animations (`lp-loop`, see globals.css) inside `ref` while they cannot be
 * seen: the element is off screen, or any of `visibility` (opacities driven by the scroll) is ~0.
 * It does so by toggling `data-lp-paused` on the element, never by re-rendering React.
 *
 * This matters more than it looks. Chrome won't run an animation on the compositor when it has
 * no visible effect (a parent at opacity 0), so an invisible loop falls back to the main thread
 * and costs a style recalc every frame, which on a phone is the difference between a smooth
 * scroll and a stuttering one. Render the element with `data-lp-paused=""` so nothing runs
 * before hydration either.
 */
export function usePauseWhenHidden(ref: RefObject<Element | null>, visibility: readonly MotionValue<number>[] = []) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let onScreen = false;
    let paused: boolean | null = null;
    const update = () => {
      const next = !onScreen || visibility.some((v) => v.get() < VISIBLE);
      if (next === paused) return;
      paused = next;
      if (next) el.setAttribute("data-lp-paused", "");
      else el.removeAttribute("data-lp-paused");
    };
    const io = new IntersectionObserver(
      ([entry]) => {
        onScreen = entry.isIntersecting;
        update();
      },
      { rootMargin: "64px" },
    );
    io.observe(el);
    const unsubscribe = visibility.map((v) => v.on("change", update));
    update();
    return () => {
      io.disconnect();
      unsubscribe.forEach((off) => off());
    };
    // The MotionValues are stable for the component's lifetime; their identities are the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, ...visibility]);
}
