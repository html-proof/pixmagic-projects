/**
 * Shared motion vocabulary for the landing page, so every scene eases and springs the same way.
 * The page uses Framer Motion (`motion/react`); CSS can use the same curve as `var(--lp-ease)`.
 */
import type { Transition } from "motion/react";

/** Slow-out curve used for every entrance: quick start, long calm settle. */
export const EASE = [0.16, 1, 0.3, 1] as const;

/** Physical settle for things that move as one object (cards, the logo landing in the nav). */
export const SPRING: Transition = { type: "spring", stiffness: 90, damping: 22, mass: 0.8 };

/** Default entrance for elements that fade up into place once they scroll into view. */
export const ENTER: Transition = { duration: 0.9, ease: EASE };

/** `whileInView` viewport options: play once, a little after the element crosses the fold. */
export const VIEWPORT = { once: true, margin: "0px 0px -12% 0px" } as const;

/** Props for a block that rises into view once. Spread onto a `motion.*` element. */
export function riseIn(delay = 0, distance = 24) {
  return {
    initial: { opacity: 0, y: distance },
    whileInView: { opacity: 1, y: 0 },
    viewport: VIEWPORT,
    transition: { ...ENTER, delay },
  };
}

/** Clamp to [0, 1]. */
export const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Where `p` sits inside the window [a, b], as 0..1 (clamped). The building block for every
 * scroll-staged scene: `segment(progress, 0.18, 0.38)` is 0 before stage 2, 1 after it.
 */
export const segment = (p: number, a: number, b: number) => clamp01((p - a) / (b - a));

/** Linear interpolation. */
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** The same slow-out curve as a plain function, for canvas code (approximation of EASE). */
export const easeOut = (t: number) => 1 - Math.pow(1 - clamp01(t), 3.2);

/** Smooth in-out for values that both start and end at rest. */
export const easeInOut = (t: number) => {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};

/**
 * Deterministic pseudo-random numbers (mulberry32). Particle layouts use this instead of
 * Math.random so the server render and the first client render agree, and so a scene looks
 * the same on every visit.
 */
export function seeded(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Brand colours as RGB triples, for canvas drawing (`rgba(${VIOLET}, 0.6)`). */
export const RGB = {
  violet: "140, 123, 255",
  violetBright: "167, 152, 255",
  blue: "94, 166, 255",
  cyan: "101, 216, 208",
  positive: "88, 211, 155",
  warning: "244, 184, 90",
  negative: "255, 114, 114",
  text: "247, 249, 252",
  muted: "125, 134, 147",
} as const;
