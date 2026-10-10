"use client";
import { useScroll, useTransform, type MotionValue } from "motion/react";
import type { RefObject } from "react";
import { segment } from "@/lib/motion";

type Offset = NonNullable<Parameters<typeof useScroll>[0]>["offset"];

/**
 * Scroll progress (0..1) through a tall "runway" section whose content is `position: sticky`.
 * The default offset runs from the runway's top meeting the viewport top to its bottom meeting
 * the viewport bottom, i.e. exactly the time its sticky child is pinned.
 *
 *   const ref = useRef<HTMLElement>(null);
 *   const progress = useScrollProgress(ref);
 *   <section ref={ref} className="relative h-[320vh]"><div className="sticky top-0 h-svh">…
 */
export function useScrollProgress(target: RefObject<HTMLElement | null>, offset: Offset = ["start start", "end end"]) {
  const { scrollYProgress } = useScroll({ target, offset });
  return scrollYProgress;
}

/** A 0..1 MotionValue for the window [a, b] of `progress` (clamped). Never re-renders React. */
export function useSegment(progress: MotionValue<number>, a: number, b: number): MotionValue<number> {
  return useTransform(progress, (p) => segment(p, a, b));
}
