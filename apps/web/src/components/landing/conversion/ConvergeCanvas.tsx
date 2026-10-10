"use client";
import type { MotionValue } from "motion/react";
import { useMemo, useRef, type RefObject } from "react";
import { useCanvasLoop, type CanvasFrame } from "@/hooks/useCanvasLoop";
import { RGB, seeded, segment } from "@/lib/motion";
import { MARK, ORBIT_POINTS } from "../shared/InsightMark";

/**
 * The final scene's data field: a viewport full of faint points that, as `progress` runs, fly
 * into the exact geometry of the Insight mark (core disc first, then the orbit points and their
 * connection lines, then the open outer ring). The points land on the DOM mark slot (`slotRef`),
 * shifted by `lift` and scaled by `zoom` exactly as the DOM mark is, so the crisp SVG resolves on
 * top of them wherever it is; a small share never converges and stays behind as ambient depth.
 */

/** Scene timing, as windows of the section's progress. */
export const CONVERGE = {
  /** Points travel from the field into the mark. */
  travel: [0.04, 0.46],
  /** The vector mark resolves over the points, which fade to a faint dusting. */
  resolve: [0.42, 0.56],
  /** The resolved mark rises from the centre of the screen into its place above the copy. */
  rise: [0.54, 0.7],
} as const;

/** Fill colours, one per bucket; particles are stored sorted by bucket so each frame sets fillStyle 5 times. */
const BUCKETS = [`rgb(${RGB.text})`, `rgb(${RGB.muted})`, `rgb(${RGB.violetBright})`, `rgb(${RGB.blue})`, `rgb(${RGB.cyan})`] as const;
const B_TEXT = 0;
const B_MUTED = 1;
const B_VIOLET = 2;
const B_BLUE = 3;
const B_CYAN = 4;

/** Share of points that stay in the field as ambient depth. */
const AMBIENT = 0.14;
/** How long one point's own journey lasts, as a share of the travel window. */
const JOURNEY = 0.6;

interface Field {
  count: number;
  /** Start position as a fraction of the canvas (0..1). */
  sx: Float32Array;
  sy: Float32Array;
  /** Target offset from the mark centre, in mark units (the 32-unit grid). */
  tx: Float32Array;
  ty: Float32Array;
  /** Per-point start offset inside the travel window (0..1-JOURNEY). Negative = ambient, never travels. */
  delay: Float32Array;
  /** Sideways bow of the flight path, as a share of its length. */
  bend: Float32Array;
  size: Float32Array;
  alpha0: Float32Array;
  alpha1: Float32Array;
  phase: Float32Array;
  /** First index of each bucket (plus `count` at the end). */
  bucketStart: number[];
}

type Raw = { sx: number; sy: number; tx: number; ty: number; delay: number; bend: number; size: number; a0: number; a1: number; phase: number; bucket: number };

const rad = (deg: number) => (deg * Math.PI) / 180;

/** Core gradient runs diagonally like CORE_STOPS: violet top-left, blue, cyan bottom-right. */
function coreBucket(x: number, y: number) {
  const k = ((x + y) / (2 * MARK.coreR) + 1) / 2;
  return k < 0.42 ? B_VIOLET : k < 0.76 ? B_BLUE : B_CYAN;
}

function buildField(count: number): Field {
  const rnd = seeded(2026);
  const c = MARK.center;
  const raw: Raw[] = [];
  const sweep = (MARK.ringEnd - MARK.ringStart + 360) % 360; // 300° clockwise

  for (let i = 0; i < count; i++) {
    const base = {
      sx: rnd(),
      sy: rnd(),
      bend: (rnd() - 0.5) * 0.5,
      size: 1.1 + rnd() * 0.8,
      a0: 0.24 + rnd() * 0.46,
      phase: rnd() * Math.PI * 2,
    };
    const part = rnd();
    if (part < AMBIENT) {
      raw.push({ ...base, tx: 0, ty: 0, delay: -1, a1: 0, bucket: rnd() < 0.7 ? B_MUTED : B_TEXT });
      continue;
    }
    const k = (part - AMBIENT) / (1 - AMBIENT);
    let tx: number;
    let ty: number;
    let delay: number;
    let a1: number;
    let bucket: number;
    if (k < 0.22) {
      // Core disc: forms first, the intelligence at the centre.
      const r = MARK.coreR * Math.sqrt(rnd());
      const a = rnd() * Math.PI * 2;
      tx = r * Math.cos(a);
      ty = r * Math.sin(a);
      delay = rnd() * 0.12;
      a1 = 0.95;
      bucket = coreBucket(tx, ty);
    } else if (k < 0.43) {
      // Orbit points.
      const o = ORBIT_POINTS[Math.floor(rnd() * 3) % 3];
      const r = MARK.dotR * Math.sqrt(rnd());
      const a = rnd() * Math.PI * 2;
      tx = o.x - c + r * Math.cos(a);
      ty = o.y - c + r * Math.sin(a);
      delay = 0.08 + rnd() * 0.14;
      a1 = 0.95;
      bucket = B_TEXT;
    } else if (k < 0.58) {
      // Connection lines from the core out to each orbit point.
      const o = ORBIT_POINTS[Math.floor(rnd() * 3) % 3];
      const dx = o.x - c;
      const dy = o.y - c;
      const len = Math.hypot(dx, dy);
      const along = MARK.coreR + rnd() * (len - MARK.coreR - MARK.dotR);
      const jitter = (rnd() - 0.5) * 0.35;
      tx = (dx / len) * along - (dy / len) * jitter;
      ty = (dy / len) * along + (dx / len) * jitter;
      delay = 0.14 + rnd() * 0.14;
      a1 = 0.5;
      bucket = B_MUTED;
    } else {
      // The open outer ring, swept clockwise from ringStart, in a band barely wider than the
      // stroke so the resolved mark stays crisp.
      const a = rad(MARK.ringStart + rnd() * sweep);
      const r = MARK.ringR + (rnd() - 0.5) * 1.3;
      tx = r * Math.cos(a);
      ty = r * Math.sin(a);
      delay = 0.2 + rnd() * 0.2;
      a1 = 0.85;
      bucket = B_TEXT;
    }
    raw.push({ ...base, tx, ty, delay, a1, bucket });
  }

  raw.sort((a, b) => a.bucket - b.bucket);
  const f: Field = {
    count,
    sx: new Float32Array(count),
    sy: new Float32Array(count),
    tx: new Float32Array(count),
    ty: new Float32Array(count),
    delay: new Float32Array(count),
    bend: new Float32Array(count),
    size: new Float32Array(count),
    alpha0: new Float32Array(count),
    alpha1: new Float32Array(count),
    phase: new Float32Array(count),
    bucketStart: [],
  };
  let bucket = -1;
  raw.forEach((r, i) => {
    while (bucket < r.bucket) f.bucketStart[++bucket] = i;
    f.sx[i] = r.sx;
    f.sy[i] = r.sy;
    f.tx[i] = r.tx;
    f.ty[i] = r.ty;
    f.delay[i] = r.delay;
    f.bend[i] = r.bend;
    f.size[i] = r.size;
    f.alpha0[i] = r.a0;
    f.alpha1[i] = r.a1;
    f.phase[i] = r.phase;
  });
  while (bucket < BUCKETS.length - 1) f.bucketStart[++bucket] = count;
  f.bucketStart[BUCKETS.length] = count;
  return f;
}

export function ConvergeCanvas({
  progress,
  count,
  slotRef,
  lift,
  zoom,
  maxDpr = 2,
  className = "",
}: {
  progress: MotionValue<number>;
  count: number;
  /** The untransformed element the mark resolves in; the points land on its centre, scaled to its width. */
  slotRef: RefObject<HTMLElement | null>;
  /** Vertical offset (px) the DOM mark is currently translated by. */
  lift: MotionValue<number>;
  /** Scale the DOM mark is currently drawn at. */
  zoom: MotionValue<number>;
  /** Canvas pixel-ratio cap (useViewportPerformance). */
  maxDpr?: number;
  className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const field = useMemo(() => buildField(Math.max(240, Math.round(count))), [count]);
  const target = useRef({ cx: 0, cy: 0, scale: 6, frames: 0 });

  const draw = (ctx: CanvasRenderingContext2D, { width, height, time, resized }: CanvasFrame) => {
    const t = target.current;
    // The slot sits in the same sticky layer as the canvas, so their offset only changes on
    // resize or late layout (fonts); a cheap re-measure twice a second covers the latter.
    if (resized || t.frames++ % 30 === 0) {
      const slot = slotRef.current;
      const el = canvas.current;
      if (slot && el) {
        const s = slot.getBoundingClientRect();
        const c = el.getBoundingClientRect();
        t.cx = s.left + s.width / 2 - c.left;
        t.cy = s.top + s.height / 2 - c.top;
        t.scale = s.width / MARK.size;
      }
    }

    const p = progress.get();
    const travel = segment(p, CONVERGE.travel[0], CONVERGE.travel[1]);
    const resolve = segment(p, CONVERGE.resolve[0], CONVERGE.resolve[1]);
    const ambientFade = 1 - travel * 0.55;
    // Once the vector mark is in, the landed points step back to a faint dusting behind it.
    const settleDim = 1 - resolve * 0.86;
    const cx = t.cx;
    const cy = t.cy + lift.get();
    const scale = t.scale * zoom.get();
    const drift = time * 0.00022;

    ctx.clearRect(0, 0, width, height);
    const { sx, sy, tx, ty, delay, bend, size, alpha0, alpha1, phase, bucketStart } = field;
    for (let b = 0; b < BUCKETS.length; b++) {
      const end = bucketStart[b + 1];
      if (bucketStart[b] === end) continue;
      ctx.fillStyle = BUCKETS[b];
      for (let i = bucketStart[b]; i < end; i++) {
        const ph = phase[i];
        // Slow drift in the field, so the data is alive before it gathers.
        const ax = sx[i] * width + Math.sin(drift + ph) * 9;
        const ay = sy[i] * height + Math.cos(drift * 0.8 + ph * 1.3) * 7;
        const s = size[i];
        const d = delay[i];
        if (d < 0) {
          ctx.globalAlpha = alpha0[i] * ambientFade;
          ctx.fillRect(ax - s / 2, ay - s / 2, s, s);
          continue;
        }
        // Each point's own eased journey (in-out cubic, inlined: this loop runs ~1600× a frame).
        let k = (travel - d) / JOURNEY;
        k = k < 0 ? 0 : k > 1 ? 1 : k;
        const e = k < 0.5 ? 4 * k * k * k : 1 - ((-2 * k + 2) * (-2 * k + 2) * (-2 * k + 2)) / 2;
        const bx = cx + tx[i] * scale;
        const by = cy + ty[i] * scale;
        const dx = bx - ax;
        const dy = by - ay;
        const bow = Math.sin(Math.PI * e) * bend[i];
        const x = ax + dx * e - dy * bow;
        const y = ay + dy * e + dx * bow;
        // A calm shimmer once landed; none while travelling.
        const shimmer = 1 - e * 0.18 * (0.5 + 0.5 * Math.sin(time * 0.0016 + ph * 3));
        ctx.globalAlpha = (alpha0[i] + (alpha1[i] - alpha0[i]) * e) * (1 - e + e * settleDim) * shimmer;
        ctx.fillRect(x - s / 2, y - s / 2, s, s);
      }
    }
    ctx.globalAlpha = 1;
  };

  useCanvasLoop(canvas, draw, { maxDpr });

  return <canvas ref={canvas} aria-hidden className={`pointer-events-none ${className}`} />;
}
