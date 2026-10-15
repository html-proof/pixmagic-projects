"use client";
import Lenis from "lenis";
import { useEffect } from "react";

/**
 * Eased wheel scrolling for the landing page (Lenis), the glide most product sites have: a mouse
 * wheel moves the page in steps of ~100px, and every scroll-driven scene on the page stepped with
 * it. Each notch now eases into place, so the scenes glide too.
 *
 * Only on fine pointers (mouse, trackpad); touch keeps the platform's own momentum, and keyboard,
 * scrollbar and find-in-page scrolling stay native (Lenis follows them). Off for people who asked
 * for less motion. Lenis runs only while a scroll is easing, not on every frame of an idle page.
 */
export function useSmoothScroll(enabled: boolean) {
  useEffect(() => {
    if (!enabled || !window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    const lenis = new Lenis({
      autoRaf: false,
      lerp: 0.1,
      smoothWheel: true,
      // Anything scrollable inside the page (code blocks, menus) scrolls on its own.
      allowNestedScroll: true,
    });
    let raf = 0;
    const tick = (time: number) => {
      lenis.raf(time);
      raf = lenis.isScrolling === "smooth" ? requestAnimationFrame(tick) : 0;
    };
    // Registered after Lenis's own wheel listener, so the scroll it just started is already known.
    const wake = () => {
      if (raf || lenis.isScrolling !== "smooth") return;
      // The first frame of a new glide measures no elapsed time (not the whole idle gap since the last one).
      lenis.time = 0;
      raf = requestAnimationFrame(tick);
    };
    window.addEventListener("wheel", wake, { passive: true });
    return () => {
      window.removeEventListener("wheel", wake);
      cancelAnimationFrame(raf);
      lenis.destroy();
    };
  }, [enabled]);
}
