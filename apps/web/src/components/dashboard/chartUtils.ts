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

/** Gridline steps a person would pick: 1, 2, 2.5 or 5 × a power of ten. */
export function niceTicks(max: number, count: number): number[] {
  if (!(max > 0)) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const ticks: number[] = [];
  // From a whole-number index, not a running sum: no drift, and sub-cent steps stay distinct.
  for (let i = 0; i * step < max + step * 0.999; i++) ticks.push(Number((i * step).toPrecision(12)));
  return ticks;
}

export function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
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
