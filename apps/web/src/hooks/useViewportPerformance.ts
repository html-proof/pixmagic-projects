"use client";
import { useEffect, useState } from "react";

export type ViewportTier = "mobile" | "tablet" | "laptop" | "desktop";

export interface ViewportPerformance {
  /** ≤768 mobile, 769–992 tablet, 993–1279 laptop, ≥1280 desktop. */
  tier: ViewportTier;
  /** Touch-first device (no hover, coarse pointer): no custom cursor, lighter effects. */
  isTouch: boolean;
  /** Few cores, little memory or Save-Data on: skip costly effects (blur-heavy glows, dense particles). */
  lowPower: boolean;
  /**
   * Multiply a scene's desktop particle count by this: 1 on desktop, 0.7 laptop, 0.55 tablet,
   * 0.4 mobile (the brief's "reduce by 60%"), halved again on low-power devices.
   */
  particleScale: number;
  /**
   * Cap for a canvas's device pixel ratio: 1.5 on phones and low-power devices, 2 elsewhere.
   * Soft, glowing particles look the same at 1.5, and every pixel is fill work on every frame.
   */
  maxDpr: number;
}

const DEFAULT: ViewportPerformance = { tier: "desktop", isTouch: false, lowPower: false, particleScale: 1, maxDpr: 2 };

function tierFor(width: number): ViewportTier {
  if (width <= 768) return "mobile";
  if (width <= 992) return "tablet";
  if (width < 1280) return "laptop";
  return "desktop";
}

const SCALE: Record<ViewportTier, number> = { desktop: 1, laptop: 0.7, tablet: 0.55, mobile: 0.4 };

function measure(): ViewportPerformance {
  const tier = tierFor(window.innerWidth);
  const isTouch = window.matchMedia("(hover: none), (pointer: coarse)").matches;
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  const lowPower =
    (navigator.hardwareConcurrency !== undefined && navigator.hardwareConcurrency <= 4) ||
    (nav.deviceMemory !== undefined && nav.deviceMemory <= 4) ||
    nav.connection?.saveData === true;
  return { tier, isTouch, lowPower, particleScale: SCALE[tier] * (lowPower ? 0.5 : 1), maxDpr: tier === "mobile" || lowPower ? 1.5 : 2 };
}

/**
 * Viewport size class and a rough device budget, updated on resize (once per animation frame at
 * most). Returns the desktop defaults during the server render and the first client render, so
 * prefer CSS breakpoints for layout and use this for effect density only.
 */
export function useViewportPerformance(): ViewportPerformance {
  const [state, setState] = useState<ViewportPerformance>(DEFAULT);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const next = measure();
      setState((prev) =>
        prev.tier === next.tier && prev.isTouch === next.isTouch && prev.lowPower === next.lowPower ? prev : next,
      );
    };
    const onResize = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("resize", onResize, { passive: true });
    return () => {
      window.removeEventListener("resize", onResize);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  return state;
}
