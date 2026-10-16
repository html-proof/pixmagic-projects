"use client";
import { useEffect, useId, useRef, useState } from "react";

const prefersLessMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const easeOut = (t: number) => 1 - (1 - t) ** 3;

/**
 * A number that counts up to its value when it first appears, and glides to the new value when
 * fresh data changes it. Screen readers and tests get the final value straight away (the moving
 * one is aria-hidden), so nothing ever reads a half-way figure.
 */
export function AnimatedNumber({ value, format, duration = 900 }: { value: number | null | undefined; format: (n: number) => string; duration?: number }) {
  const target = value ?? 0;
  // Always start from 0 (the effect jumps straight to the value when motion is reduced).
  const [shown, setShown] = useState(0);
  const from = useRef(shown);
  useEffect(() => {
    if (value === null || value === undefined) return;
    if (prefersLessMotion()) {
      setShown(target);
      from.current = target;
      return;
    }
    const start = performance.now();
    const begin = from.current;
    const whole = Number.isInteger(target) && Number.isInteger(begin);
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const v = begin + (target - begin) * easeOut(t);
      const next = t >= 1 ? target : whole ? Math.round(v) : v;
      setShown(next);
      from.current = next;
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, value, duration]);

  if (value === null || value === undefined) return <>—</>;
  return (
    <>
      <span aria-hidden="true" className="tabular-nums">{format(shown)}</span>
      <span className="sr-only">{format(target)}</span>
    </>
  );
}

/** A tiny trend line with a soft fill under it, drawn in when it appears. `color` (any CSS colour) overrides `tone`. */
export function Sparkline({ values, className = "", tone = "accent", color: stroke }: { values: number[]; className?: string; tone?: "accent" | "accent-2"; color?: string }) {
  const gid = useId().replace(/:/g, "");
  if (values.length < 2) return null;
  const W = 120;
  const H = 36;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const x = (i: number) => (i / (values.length - 1)) * W;
  const y = (v: number) => 3 + (1 - (v - min) / (max - min || 1)) * (H - 6);
  const line = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const color = stroke ?? (tone === "accent" ? "var(--accent)" : "var(--accent-2)");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={className} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={`spark-${gid}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line}L${W},${H}L0,${H}Z`} fill={`url(#spark-${gid})`} className="animate-fade" />
      <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" pathLength={1} className="animate-draw" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
