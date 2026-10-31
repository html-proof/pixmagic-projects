"use client";
import Lenis from "lenis";
import { useEffect } from "react";

/** Frames timed to tell the screen's refresh rate (half a second at 60 Hz). */
const PROBE_FRAMES = 30;
/**
 * Lenis only where the shortest gap between frames is at least this long: 60 Hz-class screens
 * (16.7 ms). Set well above a 144 Hz screen's double gap (13.9 ms), so a fast screen whose page
 * was too busy to draw two frames in a row is never taken for a slow one.
 */
const SLOW_SCREEN_MS = 15;

/**
 * The screen's time between refreshes, from the gaps between animation frames: a frame the page
 * was too busy for shows up as a gap of two or more refreshes, never a shorter one, so the
 * shortest gap is the screen's own. Timed in an idle moment, when the page draws every frame.
 */
function measureRefresh(done: (interval: number) => void) {
  let raf = 0;
  let last = 0;
  let shortest = Infinity;
  let frames = 0;
  const tick = (now: number) => {
    // Timestamps are refresh-aligned; anything under 3 ms would be noise, not a screen.
    if (last && now - last > 3) shortest = Math.min(shortest, now - last);
    last = now;
    if (++frames <= PROBE_FRAMES) raf = requestAnimationFrame(tick);
    else done(shortest);
  };
  const start = () => (raf = requestAnimationFrame(tick));
  // Safari has no requestIdleCallback: a short timeout there.
  const hasIdle = typeof window.requestIdleCallback === "function";
  const wait = hasIdle ? window.requestIdleCallback(start, { timeout: 2000 }) : window.setTimeout(start, 300);
  return () => {
    if (hasIdle) window.cancelIdleCallback(wait);
    else window.clearTimeout(wait);
    cancelAnimationFrame(raf);
  };
}

/**
 * Eased wheel scrolling for the landing page (Lenis), the glide most product sites have: a mouse
 * wheel moves the page in steps of ~100px, and every scroll-driven scene on the page stepped with
 * it. Each notch now eases into place, so the scenes glide too.
 *
 * Only on 60 Hz-class screens. Lenis moves the page from JavaScript, so the page only moves on
 * frames the main thread finishes in time. A 120–144 Hz screen gives it 7–8 ms per frame, which
 * this page's scenes don't fit in: measured on a 144 Hz laptop, the page stood still on about four
 * frames in ten with Lenis, and on one in ten with the browser's own smooth scrolling, which runs
 * off the main thread and never waits for the page. Those screens keep that.
 *
 * Only on fine pointers (mouse, trackpad); touch keeps the platform's own momentum, and keyboard,
 * scrollbar and find-in-page scrolling stay native (Lenis follows them). Off for people who asked
 * for less motion. Lenis runs only while a scroll is easing, not on every frame of an idle page.
 */
export function useSmoothScroll(enabled: boolean) {
  useEffect(() => {
    if (!enabled || !window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    let lenis: Lenis | null = null;
    let raf = 0;
    let wake: (() => void) | null = null;
    const stopProbe = measureRefresh((interval) => {
      if (interval < SLOW_SCREEN_MS) return;
      const l = (lenis = new Lenis({
        autoRaf: false,
        lerp: 0.1,
        smoothWheel: true,
        // Anything scrollable inside the page (code blocks, menus) scrolls on its own.
        allowNestedScroll: true,
      }));
      const tick = (time: number) => {
        l.raf(time);
        raf = l.isScrolling === "smooth" ? requestAnimationFrame(tick) : 0;
      };
      // Registered after Lenis's own wheel listener, so the scroll it just started is already known.
      wake = () => {
        if (raf || l.isScrolling !== "smooth") return;
        // The first frame of a new glide measures no elapsed time (not the whole idle gap since the last one).
        l.time = 0;
        raf = requestAnimationFrame(tick);
      };
      window.addEventListener("wheel", wake, { passive: true });
    });
    return () => {
      stopProbe();
      if (wake) window.removeEventListener("wheel", wake);
      cancelAnimationFrame(raf);
      lenis?.destroy();
    };
  }, [enabled]);
}
