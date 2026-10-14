import { useEffect, useRef, useState } from "react";

// What the dashboard's hand-drawn charts share (the sales columns, the line chart), kept apart
// from the charts themselves so using one doesn't load the others.

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
