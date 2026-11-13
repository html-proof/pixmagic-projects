import { useEffect, useRef, useState } from "react";

// What the dashboard's hand-drawn charts share (the sales columns, the line chart), kept apart
// from the charts themselves so using one doesn't load the others.

/** A column's width in a slot of `slot` px: a hairline gap between neighbours, never wider than 24px. */
export const columnWidth = (slot: number) => (slot >= 6 ? Math.min(24, slot - 2) : Math.max(1, slot - 1));

/** A column with a 4px rounded data end and a square foot on the baseline. */
export function columnPath(x: number, w: number, y0: number, y1: number): string {
  const up = y1 <= y0;
  const h = Math.abs(y0 - y1);
  const r = Math.min(4, w / 2, h);
  if (up) {
    return `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + r}V${y0}Z`;
  }
  return `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 - r}V${y0}Z`;
}

/** The smallest step a person would pick (1, 2, 2.5 or 5 × a power of ten) of at least `raw`. */
export function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
}

/** Gridline steps a person would pick: 1, 2, 2.5 or 5 × a power of ten. */
export function niceTicks(max: number, count: number): number[] {
  if (!(max > 0)) return [0];
  const step = niceStep(max / count);
  const ticks: number[] = [];
  // From a whole-number index, not a running sum: no drift, and sub-cent steps stay distinct.
  for (let i = 0; i * step < max + step * 0.999; i++) ticks.push(Number((i * step).toPrecision(12)));
  return ticks;
}

/**
 * Gridlines for figures that can go below zero (a day with more refunds than sales): the same
 * steps on both sides of zero, from the lowest figure up to the highest. Never below zero, it is
 * `niceTicks`. The longer side gets about `count` steps, the whole axis at most about six.
 */
export function niceTicksAround(min: number, max: number, count: number): number[] {
  if (!(min < 0)) return niceTicks(max, count);
  const step = niceStep(Math.max(Math.max(max, -min) / count, (max - min) / 6));
  // Whole step indexes from just below the lowest figure to just above the highest (the 1e-9 keeps
  // a figure on a gridline, like −0.3 in steps of 0.1, from adding a step past it).
  const ticks: number[] = [];
  for (let i = Math.floor(min / step + 1e-9), hi = Math.ceil(max / step - 1e-9); i <= hi; i++) ticks.push(Number((i * step).toPrecision(12)) || 0);
  return ticks;
}

/** The width of the element given `ref`, kept up as it resizes (0 until it is measured). */
export function useWidth<E extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<E>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}
