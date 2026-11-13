"use client";
import { motion, useTransform, type MotionValue } from "motion/react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  clamp01,
  easeInOut,
  easeOut,
  lerp,
  segment,
  seeded,
} from "@/lib/motion";

/*
 * The four card visuals of "From signals to decisions". Each one takes its card's own 0..1
 * sub-progress of the runway. Geometry is laid out in real pixels of the measured box (so dots
 * stay round and strokes stay crisp at every aspect ratio) and re-laid out only on resize; the
 * scroll-driven attributes are written straight to the SVG nodes, so scrolling never re-renders
 * React. Shapes only: no values, no axes with numbers.
 */

type Size = { w: number; h: number };
type Pt = [number, number];

const useIsoLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Layout size of an element (ignores the stack's scale transforms), updated on resize. */
function useElementSize<T extends HTMLElement>(
  fallback: Size,
): [RefObject<T | null>, Size] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      if (w > 0 && h > 0)
        setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

/**
 * Applies `apply(value)` now, on every change of `value`, and again after a re-layout (`layoutKey`).
 * The writes go directly to DOM attributes: one subscription per visual, no React render per frame.
 */
function useProgressWrites(
  value: MotionValue<number>,
  apply: (v: number) => void,
  layoutKey: string,
) {
  const applyRef = useRef(apply);
  // Declared first, so the latest closure (new geometry) is in place before the writer runs.
  useIsoLayoutEffect(() => {
    applyRef.current = apply;
  });
  useIsoLayoutEffect(() => {
    const run = () => applyRef.current(value.get());
    run();
    return value.on("change", run);
  }, [value, layoutKey]);
}

/** Registry of SVG nodes that the progress writer updates. */
function useNodes() {
  const nodes = useRef<Record<string, SVGElement | null>>({});
  const bind = (key: string) => (el: SVGElement | null) => {
    nodes.current[key] = el;
  };
  return [nodes, bind] as const;
}

/** SVG-safe id prefix (React ids contain characters that break `url(#…)`). */
function useSvgId(prefix: string) {
  return `${prefix}${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

const fx = (v: number) => String(Math.round(v * 100) / 100);
const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

function set(
  el: SVGElement | null | undefined,
  name: string,
  value: number | string,
) {
  if (el) el.setAttribute(name, typeof value === "number" ? fx(value) : value);
}

const MONO = "font-lp-mono";

/**
 * Caption row above a visual (what the shape shows, plus an optional key), so every card's
 * panel opens the same way as the sales tabs and the customer caption. The key needs ~300px
 * beside the caption; narrower panels (tablet card column) drop it rather than wrap both.
 */
function VisualCaption({
  children,
  aside,
}: {
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="@container">
      <div className="flex items-center justify-between gap-3 whitespace-nowrap font-lp-mono text-[10.5px] uppercase tracking-[0.14em]">
        <span className="text-lp-text-2">{children}</span>
        {aside && (
          <span className="hidden items-center gap-2 text-lp-muted @min-[300px]:flex">
            {aside}
          </span>
        )}
      </div>
    </div>
  );
}
const TEXT = "#F7F9FC";
const MUTED = "#7D8693";

/* ---------------------------------------------------------------------------------------------
 * 01 Sales: a line that draws itself across the week.
 */

/** Smooth Catmull-Rom curve through `pts`, plus dense samples so the leading dot can ride it. */
function smoothCurve(pts: Pt[]) {
  const first = pts[0];
  let d = `M${fx(first[0])},${fx(first[1])}`;
  const xs: number[] = [first[0]];
  const ys: number[] = [first[1]];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${fx(c1[0])},${fx(c1[1])} ${fx(c2[0])},${fx(c2[1])} ${fx(p2[0])},${fx(p2[1])}`;
    for (let k = 1; k <= 10; k++) {
      const t = k / 10;
      const m = 1 - t;
      const a = m * m * m;
      const b = 3 * m * m * t;
      const c = 3 * m * t * t;
      const e = t * t * t;
      xs.push(a * p1[0] + b * c1[0] + c * c2[0] + e * p2[0]);
      ys.push(a * p1[1] + b * c1[1] + c * c2[1] + e * p2[1]);
    }
  }
  return { d, xs, ys };
}

function yAt(curve: { xs: number[]; ys: number[] }, x: number) {
  const { xs, ys } = curve;
  let lo = 0;
  let hi = xs.length - 1;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[hi]) return ys[hi];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  const span = xs[hi] - xs[lo] || 1;
  return lerp(ys[lo], ys[hi], (x - xs[lo]) / span);
}

/** A normalised (0..1) shape: a growing week. Not data. */
const SALES_SHAPE = (() => {
  const rnd = seeded(2417);
  const n = 22;
  const current: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    current.push(
      0.26 +
        0.44 * t +
        0.1 * Math.sin(t * Math.PI * 5.2 + 0.4) +
        (rnd() - 0.5) * 0.06,
    );
    // Every other draw is skipped: with them the line takes this shape.
    rnd();
  }
  return current;
})();

function salesGeometry({ w, h }: Size) {
  const top = 14;
  const bottom = 18;
  const left = 6;
  const right = 8;
  const plotH = Math.max(12, h - top - bottom);
  const toPts = (vals: number[]): Pt[] =>
    vals.map((v, i) => [
      left + (i / (vals.length - 1)) * (w - left - right),
      top + (1 - v) * plotH,
    ]);
  const cur = smoothCurve(toPts(SALES_SHAPE));
  const firstX = cur.xs[0];
  const lastX = cur.xs[cur.xs.length - 1];
  const area = `${cur.d}L${fx(lastX)},${fx(h)}L${fx(firstX)},${fx(h)}Z`;
  const grid = [0, 1, 2, 3].map((i) => top + (plotH * i) / 3);
  // Positions that reach markup unformatted are rounded: trig results may differ in the last bit
  // between the server's engine and the browser's, which would be a hydration mismatch.
  return { cur, area, grid, firstX, lastX };
}

const WEEK = ["M", "T", "W", "T", "F", "S", "S"];
const METRICS = ["Revenue", "Orders", "AOV"];

export function SalesVisual({ progress }: { progress: MotionValue<number> }) {
  const [box, size] = useElementSize<HTMLDivElement>({ w: 420, h: 260 });
  const geo = useMemo(() => salesGeometry(size), [size]);
  const uid = useSvgId("sales");
  const [nodes, bind] = useNodes();

  useProgressWrites(
    progress,
    (v) => {
      const n = nodes.current;
      const draw = easeInOut(segment(v, 0.08, 0.84));
      const x = lerp(geo.firstX, geo.lastX, draw);
      const y = yAt(geo.cur, x);
      const head = draw > 0 ? Math.min(1, draw * 8) : 0;
      set(n.clip, "width", draw > 0 ? x + 14 : 0);
      set(n.head, "transform", `translate(${fx(x)} ${fx(y)})`);
      set(n.head, "opacity", head);
      set(n.drop, "x1", x);
      set(n.drop, "x2", x);
      set(n.drop, "y1", y + 9);
      // The guide steps aside once the line has landed, clearing the direct labels at the end.
      set(n.drop, "opacity", head * 0.6 * (1 - segment(v, 0.84, 1)));
    },
    `${size.w}x${size.h}`,
  );

  return (
    <div className="flex h-full flex-col">
      {/* The lines are labelled directly at their ends, so the header never wraps into a second row. */}
      <div className="flex w-fit items-center gap-0.5 rounded-[10px] border border-lp-line bg-lp-bg/60 p-0.5 font-lp-mono text-[10px] uppercase tracking-[0.14em]">
        {METRICS.map((m, i) => (
          <span
            key={m}
            className={
              i === 0
                ? "rounded-[8px] bg-lp-surface-hover px-2.5 py-1 text-lp-text"
                : "px-2.5 py-1 text-lp-muted"
            }
          >
            {m}
          </span>
        ))}
      </div>

      <div ref={box} className="relative mt-3 min-h-0 flex-1">
        <svg
          width={size.w}
          height={size.h}
          viewBox={`0 0 ${size.w} ${size.h}`}
          className="absolute inset-0 overflow-visible"
        >
          <defs>
            <linearGradient
              id={`${uid}-stroke`}
              gradientUnits="userSpaceOnUse"
              x1="0"
              y1="0"
              x2={size.w}
              y2="0"
            >
              <stop offset="0" stopColor="#8C7BFF" />
              <stop offset="0.55" stopColor="#5EA6FF" />
              <stop offset="1" stopColor="#65D8D0" />
            </linearGradient>
            <linearGradient id={`${uid}-area`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#8C7BFF" stopOpacity="0.24" />
              <stop offset="1" stopColor="#8C7BFF" stopOpacity="0" />
            </linearGradient>
            <clipPath id={`${uid}-clip`}>
              <rect
                ref={bind("clip")}
                x="-14"
                y="-16"
                width="0"
                height={size.h + 32}
              />
            </clipPath>
          </defs>
          {geo.grid.map((y) => (
            <line
              key={y}
              x1="0"
              x2={size.w}
              y1={y}
              y2={y}
              stroke="rgb(255 255 255 / 0.07)"
              strokeDasharray="2 6"
            />
          ))}
          <g clipPath={`url(#${uid}-clip)`}>
            <path d={geo.area} fill={`url(#${uid}-area)`} />
            <path
              d={geo.cur.d}
              fill="none"
              stroke={`url(#${uid}-stroke)`}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
          <line
            ref={bind("drop")}
            x1="0"
            x2="0"
            y1="0"
            y2={size.h}
            stroke="#A798FF"
            strokeOpacity="0.5"
            strokeDasharray="2 4"
            opacity="0"
          />
          <g ref={bind("head")} opacity="0">
            <circle r="12" fill="#8C7BFF" fillOpacity="0.18" />
            <circle r="4" fill={TEXT} stroke="#A798FF" strokeWidth="2" />
          </g>
        </svg>
      </div>

      <div className="mt-2 grid grid-cols-7 text-center font-lp-mono text-[10px] tracking-[0.1em] text-lp-muted">
        {WEEK.map((d, i) => (
          <span key={i}>{d}</span>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------
 * 02 Conversion: five steps light up in turn; the visits that leave peel away from each bar.
 */

/** Share of visits still in the flow at each step: a shape, not a measurement. */
const FUNNEL = [
  { label: "VISIT", keep: 1 },
  { label: "PRODUCT", keep: 0.74 },
  { label: "CART", keep: 0.55 },
  { label: "CHECKOUT", keep: 0.25 },
  { label: "PURCHASE", keep: 0.18 },
] as const;
const FUNNEL_LAST = FUNNEL.length - 1;
const BIGGEST_DROP = FUNNEL.slice(0, -1).reduce(
  (best, s, i) => {
    const drop = s.keep - FUNNEL[i + 1].keep;
    return drop > best.drop ? { i, drop } : best;
  },
  { i: 0, drop: -1 },
).i;

const STEP = 0.15;
const stageLight = (v: number, k: number) =>
  segment(v, 0.04 + k * STEP, 0.16 + k * STEP);
const stageDrop = (v: number, k: number) =>
  segment(v, 0.12 + k * STEP, 0.3 + k * STEP);

function funnelGeometry({ w, h }: Size) {
  // Rows stop growing past 66px and the funnel centres, so a tall card column stays dense.
  const rowH = Math.min(66, (h - 8) / FUNNEL.length);
  const padY = Math.max(4, (h - rowH * FUNNEL.length) / 2);
  const nodeX = 7;
  const x0 = 26;
  const W = Math.max(40, w - x0 - 2);
  const bh = Math.round(clamp(rowH * 0.16, 5, 9));
  const rows = FUNNEL.map((s, i) => {
    const y = padY + rowH * (i + 0.5);
    const barY = y + 3;
    const full = s.keep * W;
    const kept = (i < FUNNEL_LAST ? FUNNEL[i + 1].keep : s.keep) * W;
    let drop: {
      d: string;
      sx: number;
      sy: number;
      ex: number;
      ey: number;
    } | null = null;
    if (i < FUNNEL_LAST) {
      const sx = x0 + (kept + full) / 2;
      const sy = barY + bh / 2;
      const ex = Math.min(w - 2, sx + rowH * 0.9 + 18);
      const ey = barY + rowH * 0.82;
      const c2x = Math.max(sx + 2, ex - rowH * 0.6);
      drop = {
        d: `M${fx(sx)},${fx(sy)}C${fx(sx + 2)},${fx(sy + rowH * 0.45)} ${fx(c2x)},${fx(ey)} ${fx(ex)},${fx(ey)}`,
        sx,
        sy,
        ex,
        ey,
      };
    }
    return { label: s.label, y, labelY: y - 5, barY, full, kept, drop };
  });
  return { rows, rowH, nodeX, x0, W, bh };
}

export function ConversionVisual({
  progress,
}: {
  progress: MotionValue<number>;
}) {
  const [box, size] = useElementSize<HTMLDivElement>({ w: 420, h: 320 });
  const geo = useMemo(() => funnelGeometry(size), [size]);
  const uid = useSvgId("funnel");
  const [nodes, bind] = useNodes();
  const firstY = geo.rows[0].y;
  const lastY = geo.rows[FUNNEL_LAST].y;
  const markerRow = geo.rows[BIGGEST_DROP];

  useProgressWrites(
    progress,
    (v) => {
      const n = nodes.current;
      const reach = clamp((v - 0.04) / STEP, 0, FUNNEL_LAST);
      set(n.spine, "y2", firstY + reach * geo.rowH);
      for (let i = 0; i < geo.rows.length; i++) {
        const r = geo.rows[i];
        const lit = stageLight(v, i);
        const grown = easeOut(lit) * r.full;
        const isLast = i === FUNNEL_LAST;
        set(n[`kept${i}`], "width", isLast ? grown : Math.min(grown, r.kept));
        set(n[`lit${i}`], "opacity", lit);
        set(n[`label${i}`], "opacity", lit);
        if (!isLast) {
          const drop = stageDrop(v, i);
          set(n[`lost${i}`], "width", Math.max(0, grown - r.kept - 2));
          set(n[`lost${i}`], "opacity", 1 - 0.78 * drop);
          set(n[`drop${i}`], "stroke-dashoffset", 1 - easeOut(drop));
          set(n[`drop${i}`], "opacity", drop > 0 ? 1 : 0);
        }
      }
      set(n.marker, "opacity", segment(v, 0.8, 0.94));
    },
    `${size.w}x${size.h}`,
  );

  return (
    <div className="flex h-full flex-col">
      <VisualCaption
        aside={
          <>
            <span aria-hidden className="h-px w-4 bg-lp-negative" />
            Left the store
          </>
        }
      >
        Shopping funnel
      </VisualCaption>
      <div ref={box} className="relative mt-3 min-h-0 flex-1">
        <svg
          width={size.w}
          height={size.h}
          viewBox={`0 0 ${size.w} ${size.h}`}
          className="absolute inset-0 overflow-visible"
        >
          <defs>
            <linearGradient
              id={`${uid}-bar`}
              gradientUnits="userSpaceOnUse"
              x1={geo.x0}
              y1="0"
              x2={geo.x0 + geo.W}
              y2="0"
            >
              <stop offset="0" stopColor="#8C7BFF" />
              <stop offset="1" stopColor="#5EA6FF" />
            </linearGradient>
            <linearGradient
              id={`${uid}-spine`}
              gradientUnits="userSpaceOnUse"
              x1="0"
              y1={firstY}
              x2="0"
              y2={lastY}
            >
              <stop offset="0" stopColor="#8C7BFF" />
              <stop offset="0.6" stopColor="#5EA6FF" />
              <stop offset="1" stopColor="#58D39B" />
            </linearGradient>
            {geo.rows.map(
              (r, i) =>
                r.drop && (
                  <linearGradient
                    key={i}
                    id={`${uid}-drop${i}`}
                    gradientUnits="userSpaceOnUse"
                    x1={r.drop.sx}
                    y1={r.drop.sy}
                    x2={r.drop.ex}
                    y2={r.drop.ey}
                  >
                    <stop offset="0" stopColor="#FF7272" stopOpacity="0.8" />
                    <stop offset="1" stopColor="#FF7272" stopOpacity="0" />
                  </linearGradient>
                ),
            )}
          </defs>

          <line
            x1={geo.nodeX}
            x2={geo.nodeX}
            y1={firstY}
            y2={lastY}
            stroke="rgb(255 255 255 / 0.1)"
            strokeWidth="1.5"
          />
          <line
            ref={bind("spine")}
            x1={geo.nodeX}
            x2={geo.nodeX}
            y1={firstY}
            y2={firstY}
            stroke={`url(#${uid}-spine)`}
            strokeWidth="1.5"
            strokeLinecap="round"
          />

          {geo.rows.map((r, i) => {
            const isLast = i === FUNNEL_LAST;
            const accent = isLast ? "#58D39B" : "#A798FF";
            return (
              <g key={r.label}>
                <rect
                  x={geo.x0}
                  y={r.barY}
                  width={geo.W}
                  height={geo.bh}
                  rx={geo.bh / 2}
                  fill="rgb(255 255 255 / 0.035)"
                />
                <rect
                  ref={bind(`kept${i}`)}
                  x={geo.x0}
                  y={r.barY}
                  width="0"
                  height={geo.bh}
                  rx={geo.bh / 2}
                  fill={isLast ? "#58D39B" : `url(#${uid}-bar)`}
                />
                {!isLast && (
                  <rect
                    ref={bind(`lost${i}`)}
                    x={geo.x0 + r.kept + 2}
                    y={r.barY}
                    width="0"
                    height={geo.bh}
                    rx={geo.bh / 2}
                    fill={`url(#${uid}-bar)`}
                  />
                )}
                {r.drop && (
                  <path
                    ref={bind(`drop${i}`)}
                    d={r.drop.d}
                    fill="none"
                    stroke={`url(#${uid}-drop${i})`}
                    strokeWidth={i === BIGGEST_DROP ? 1.75 : 1.25}
                    strokeLinecap="round"
                    pathLength={1}
                    strokeDasharray="1 1"
                    strokeDashoffset="1"
                    opacity="0"
                  />
                )}
                <circle
                  cx={geo.nodeX}
                  cy={r.y}
                  r="4"
                  fill="#0D1015"
                  stroke="rgb(255 255 255 / 0.2)"
                  strokeWidth="1.25"
                />
                <g ref={bind(`lit${i}`)} opacity="0">
                  <circle
                    cx={geo.nodeX}
                    cy={r.y}
                    r="9"
                    fill={accent}
                    fillOpacity="0.18"
                  />
                  <circle cx={geo.nodeX} cy={r.y} r="3.5" fill={accent} />
                </g>
                <text
                  x={geo.x0}
                  y={r.labelY}
                  className={MONO}
                  fontSize="10.5"
                  letterSpacing="0.14em"
                  fill={MUTED}
                >
                  {r.label}
                </text>
                <text
                  ref={bind(`label${i}`)}
                  x={geo.x0}
                  y={r.labelY}
                  className={MONO}
                  fontSize="10.5"
                  letterSpacing="0.14em"
                  fill={TEXT}
                  opacity="0"
                >
                  {r.label}
                </text>
              </g>
            );
          })}

          {/*
           * Right after the label of the step that loses the most (mono glyphs are ~7.8px wide at
           * this size), on its label line: left of every drop curve, so nothing crosses it.
           */}
          <text
            ref={bind("marker")}
            x={geo.x0 + FUNNEL[BIGGEST_DROP].label.length * 7.8 + 8}
            y={markerRow.labelY}
            className={MONO}
            fontSize="10"
            letterSpacing="0.14em"
            fill="#FF7272"
            opacity="0"
          >
            · BIGGEST DROP
          </text>
        </svg>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------
 * 03 Customers: one mixed cloud, then new | returning, then regrouped by sales channel.
 */

const CUSTOMER_COUNT = 56;

/** Each dot is a customer: first-time or returning, bought online or in person. Illustrative mix. */
const CUSTOMERS = (() => {
  const rnd = seeded(907);
  const list = Array.from({ length: CUSTOMER_COUNT }, () => ({
    returning: rnd() < 0.56,
    online: rnd() < 0.68,
    delay: rnd(),
    jitter: rnd(),
    order: rnd(),
  }));
  // Cloud slot = rank by `order`, so new and returning customers start fully interleaved.
  const cloudSlot = new Array<number>(list.length);
  list
    .map((c, i) => ({ i, o: c.order }))
    .sort((a, b) => a.o - b.o)
    .forEach((e, rank) => {
      cloudSlot[e.i] = rank;
    });
  let nNew = 0;
  let nRet = 0;
  let nOnline = 0;
  let nPos = 0;
  const groupSlot: number[] = [];
  const channelSlot: number[] = [];
  for (const c of list) {
    groupSlot.push(c.returning ? nRet++ : nNew++);
    channelSlot.push(c.online ? nOnline++ : nPos++);
  }
  return {
    list,
    cloudSlot,
    groupSlot,
    channelSlot,
    maxCluster: Math.max(nNew, nRet, nOnline, nPos),
  };
})();

const GOLDEN = 2.39996;

/**
 * Two cluster slots, side by side in a landscape box (labels underneath) or one above the other
 * in a portrait one (labels on top), so the groups stay large in the tall desktop card column.
 */
/** Below this width the caption and the colour legend no longer fit on one line. */
const NARROW_CUSTOMERS = 300;

function customerGeometry({ w, h }: Size) {
  const top = w < NARROW_CUSTOMERS ? 52 : 34;
  const portrait = h > w * 1.05;
  const plotH = Math.max(40, h - top - (portrait ? 6 : 30));
  const n = CUSTOMERS.list.length;

  let a: Pt;
  let b: Pt;
  let rg: number;
  if (portrait) {
    const half = plotH / 2;
    rg = Math.max(18, Math.min(w * 0.34, (half - 22) / 2 - 8));
    a = [w / 2, top + 22 + (half - 22) / 2];
    b = [w / 2, top + half + 22 + (half - 22) / 2];
  } else {
    rg = Math.max(18, Math.min(w * 0.19, plotH / 2 - 6));
    a = [w * 0.28, top + plotH / 2];
    b = [w * 0.72, top + plotH / 2];
  }
  const spacing = rg / Math.sqrt(CUSTOMERS.maxCluster);
  const r = clamp(spacing * 0.36, 2.4, 4.8);
  const ring = rg + r + 7;
  const labelOffset = portrait ? -(ring + 20) : ring + 8;

  // The mixed cloud: an ellipse that follows the box, never more than 1.5:1.
  let rx = w * 0.36;
  let ry = plotH * 0.4;
  if (rx > ry * 1.5) rx = ry * 1.5;
  if (ry > rx * 1.5) ry = rx * 1.5;
  const cloudCy = top + plotH / 2;

  const cloudX = new Float32Array(n);
  const cloudY = new Float32Array(n);
  const groupX = new Float32Array(n);
  const groupY = new Float32Array(n);
  const chanX = new Float32Array(n);
  const chanY = new Float32Array(n);
  CUSTOMERS.list.forEach((c, i) => {
    const k = CUSTOMERS.cloudSlot[i];
    const cr = Math.sqrt((k + 0.5) / n);
    const ca = k * GOLDEN + c.jitter * 0.7;
    cloudX[i] = w / 2 + Math.cos(ca) * cr * rx;
    cloudY[i] = cloudCy + Math.sin(ca) * cr * ry;
    const g = CUSTOMERS.groupSlot[i];
    const gr = spacing * Math.sqrt(g + 0.5);
    const gc = c.returning ? b : a;
    groupX[i] = gc[0] + Math.cos(g * GOLDEN) * gr;
    groupY[i] = gc[1] + Math.sin(g * GOLDEN) * gr;
    const s = CUSTOMERS.channelSlot[i];
    const sr = spacing * Math.sqrt(s + 0.5);
    const sc = c.online ? a : b;
    chanX[i] = sc[0] + Math.cos(s * GOLDEN) * sr;
    chanY[i] = sc[1] + Math.sin(s * GOLDEN) * sr;
  });
  return {
    a,
    b,
    ring,
    r,
    labelA: { left: a[0], top: a[1] + labelOffset },
    labelB: { left: b[0], top: b[1] + labelOffset },
    cloudX,
    cloudY,
    groupX,
    groupY,
    chanX,
    chanY,
  };
}

const NEW_COLOR = "#8C7BFF";
const RETURNING_COLOR = "#65D8D0";

function CrossfadeLabel({
  opacity,
  className,
  style,
  children,
}: {
  opacity: MotionValue<number>;
  className: string;
  style?: { left: number; top: number };
  children: ReactNode;
}) {
  return (
    <motion.span
      className={`absolute whitespace-nowrap ${className}`}
      style={{ ...style, opacity }}
    >
      {children}
    </motion.span>
  );
}

export function CustomerVisual({
  progress,
}: {
  progress: MotionValue<number>;
}) {
  const [box, size] = useElementSize<HTMLDivElement>({ w: 420, h: 320 });
  const geo = useMemo(() => customerGeometry(size), [size]);
  const [nodes, bind] = useNodes();
  const dots = useRef<(SVGCircleElement | null)[]>([]);

  // The three captions share one spot, so each fades out before the next fades in: overlapping
  // crossfades garbled the two lines into each other.
  const capAll = useTransform(progress, (v) => 1 - segment(v, 0.18, 0.26));
  const capType = useTransform(
    progress,
    (v) => segment(v, 0.28, 0.38) * (1 - segment(v, 0.58, 0.65)),
  );
  const capChannel = useTransform(progress, (v) => segment(v, 0.67, 0.77));
  const typeLabels = useTransform(
    progress,
    (v) => segment(v, 0.36, 0.5) * (1 - segment(v, 0.58, 0.68)),
  );
  const channelLabels = useTransform(progress, (v) => segment(v, 0.76, 0.9));
  const legend = useTransform(progress, (v) => segment(v, 0.3, 0.45));

  useProgressWrites(
    progress,
    (v) => {
      const toGroups = segment(v, 0.14, 0.5);
      const toChannels = segment(v, 0.56, 0.9);
      const list = CUSTOMERS.list;
      for (let i = 0; i < list.length; i++) {
        const el = dots.current[i];
        if (!el) continue;
        const stagger = list[i].delay * 0.35;
        const a = easeInOut(clamp01(toGroups * 1.35 - stagger));
        const b = easeInOut(clamp01(toChannels * 1.35 - stagger));
        const x = lerp(lerp(geo.cloudX[i], geo.groupX[i], a), geo.chanX[i], b);
        const y = lerp(lerp(geo.cloudY[i], geo.groupY[i], a), geo.chanY[i], b);
        el.setAttribute("cx", fx(x));
        el.setAttribute("cy", fx(y));
      }
      set(nodes.current.dots, "opacity", 0.35 + 0.65 * segment(v, 0, 0.14));
      set(nodes.current.rings, "opacity", easeInOut(segment(v, 0.32, 0.5)));
    },
    `${size.w}x${size.h}`,
  );

  return (
    <div ref={box} className="relative h-full">
      <svg
        width={size.w}
        height={size.h}
        viewBox={`0 0 ${size.w} ${size.h}`}
        className="absolute inset-0 overflow-visible"
      >
        <g
          ref={bind("rings")}
          opacity="0"
          fill="none"
          stroke="rgb(255 255 255 / 0.12)"
          strokeDasharray="2 5"
        >
          <circle cx={geo.a[0]} cy={geo.a[1]} r={geo.ring} />
          <circle cx={geo.b[0]} cy={geo.b[1]} r={geo.ring} />
        </g>
        <g ref={bind("dots")} opacity="0.35">
          {CUSTOMERS.list.map((c, i) => (
            <circle
              key={i}
              ref={(el) => {
                dots.current[i] = el;
              }}
              cx={fx(geo.cloudX[i])}
              cy={fx(geo.cloudY[i])}
              r={fx(geo.r)}
              fill={c.returning ? RETURNING_COLOR : NEW_COLOR}
              fillOpacity={c.returning ? 0.9 : 0.95}
            />
          ))}
        </g>
      </svg>

      <div className="absolute left-0 top-0 font-lp-mono text-[10.5px] uppercase tracking-[0.14em] text-lp-text-2">
        <CrossfadeLabel opacity={capAll} className="left-0 top-0">
          All customers
        </CrossfadeLabel>
        <CrossfadeLabel opacity={capType} className="left-0 top-0">
          New or returning
        </CrossfadeLabel>
        <CrossfadeLabel opacity={capChannel} className="left-0 top-0">
          By sales channel
        </CrossfadeLabel>
      </div>
      <motion.div
        className={`absolute flex items-center gap-3 text-[11px] text-lp-muted ${size.w < NARROW_CUSTOMERS ? "left-0 top-[19px]" : "right-0 top-0"}`}
        style={{ opacity: legend }}
      >
        <span className="flex items-center gap-1.5">
          <span
            className="size-2 rounded-full"
            style={{ background: NEW_COLOR }}
          />
          New
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="size-2 rounded-full"
            style={{ background: RETURNING_COLOR }}
          />
          Returning
        </span>
      </motion.div>

      <div className="text-[12.5px] font-medium text-lp-text">
        <CrossfadeLabel
          opacity={typeLabels}
          className="-translate-x-1/2"
          style={geo.labelA}
        >
          New
        </CrossfadeLabel>
        <CrossfadeLabel
          opacity={typeLabels}
          className="-translate-x-1/2"
          style={geo.labelB}
        >
          Returning
        </CrossfadeLabel>
        <CrossfadeLabel
          opacity={channelLabels}
          className="-translate-x-1/2"
          style={geo.labelA}
        >
          Online store
        </CrossfadeLabel>
        <CrossfadeLabel
          opacity={channelLabels}
          className="-translate-x-1/2"
          style={geo.labelB}
        >
          Point of sale
        </CrossfadeLabel>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------
 * 04 Revenue: gross sales, the discount and refund pieces falling out of it, net sales left over.
 */

/** Proportions of the abstract bars (gross = 1). Shapes only. */
const DISCOUNT = 0.13;
const REFUND = 0.08;
const KEPT = 1 - DISCOUNT - REFUND;
/** Hairline gap between the parts of the gross bar, so it reads as three pieces that can separate. */
const GAP = 2;

function revenueGeometry({ w, h }: Size) {
  // The footnote sits under the net bar; rows stop growing at 74px and the block centres, so a
  // tall card column keeps the breakdown together instead of spreading it thin.
  const footnote = 20;
  const unit = clamp((h - footnote - 4) / 4.5, 30, 74);
  const bh = Math.round(clamp(unit - 30, 10, 22));
  const inset = Math.max(0, (unit - (20 + bh)) / 2);
  const content = unit * 3.5 + inset + 20 + bh + footnote;
  const top0 = Math.max(0, (h - content) / 2);
  const row = (top: number) => ({
    labelY: top0 + top + inset + 11,
    barY: top0 + top + inset + 20,
  });
  const net = row(unit * 3.5);
  return {
    W: w,
    bh,
    gross: row(0),
    discounts: row(unit),
    refunds: row(unit * 2),
    dividerY: top0 + unit * 3.22,
    net,
    footY: net.barY + bh + 17,
  };
}

export function RevenueVisual({ progress }: { progress: MotionValue<number> }) {
  const [box, size] = useElementSize<HTMLDivElement>({ w: 420, h: 300 });
  const geo = useMemo(() => revenueGeometry(size), [size]);
  const uid = useSvgId("revenue");
  const [nodes, bind] = useNodes();
  const W = geo.W;

  useProgressWrites(
    progress,
    (v) => {
      const n = nodes.current;
      const gross = segment(v, 0, 0.16);
      const disc = segment(v, 0.2, 0.42);
      const refund = segment(v, 0.44, 0.64);
      const divider = segment(v, 0.66, 0.74);
      const net = segment(v, 0.72, 0.92);
      const grown = easeOut(gross) * W;

      // Gross bar in three parts so the discount and refund pieces can leave it.
      set(n.gKept, "width", Math.min(grown, KEPT * W));
      set(
        n.gRefund,
        "width",
        clamp(grown - KEPT * W - GAP, 0, REFUND * W - GAP),
      );
      set(
        n.gDisc,
        "width",
        clamp(grown - (KEPT + REFUND) * W - GAP, 0, DISCOUNT * W - GAP),
      );
      set(n.gRefund, "opacity", 1 - 0.85 * refund);
      set(n.gDisc, "opacity", 1 - 0.85 * disc);
      set(n.ghost, "opacity", Math.max(disc, refund) * 0.9);

      const dFall = easeInOut(disc);
      set(n.dPiece, "y", lerp(geo.gross.barY, geo.discounts.barY, dFall));
      set(n.dPiece, "opacity", disc > 0 ? lerp(0.5, 0.9, disc) : 0);
      const rFall = easeInOut(refund);
      set(n.rPiece, "y", lerp(geo.gross.barY, geo.refunds.barY, rFall));
      set(n.rPiece, "opacity", refund > 0 ? lerp(0.5, 0.9, refund) : 0);

      const edge = W * (1 - DISCOUNT * dFall - REFUND * rFall);
      set(n.guide, "x1", edge);
      set(n.guide, "x2", edge);
      set(n.guide, "opacity", Math.min(1, disc * 3) * 0.7 * (1 - net * 0.6));

      set(n.divider, "x2", easeOut(divider) * W);
      const netW = easeOut(net) * KEPT * W;
      set(n.net, "width", netW);
      set(n.netGlow, "width", netW);

      const rowIn = (el: SVGElement | null | undefined, t: number) => {
        const e = segment(t, 0, 0.45);
        set(el, "opacity", e);
        set(el, "transform", `translate(0 ${fx((1 - easeOut(e)) * 6)})`);
      };
      rowIn(n.lGross, gross);
      rowIn(n.lDisc, disc);
      rowIn(n.lRefund, refund);
      rowIn(n.lNet, net);
      set(n.foot, "opacity", segment(v, 0.86, 1));
    },
    `${size.w}x${size.h}`,
  );

  const label = (
    key: string,
    y: number,
    text: string,
    fill: string,
    right?: { text: string; fill: string },
  ) => (
    <g ref={bind(key)} opacity="0">
      <text
        x="0"
        y={y}
        className={MONO}
        fontSize="10.5"
        letterSpacing="0.14em"
        fill={fill}
      >
        {text}
      </text>
      {right && (
        <text
          x={W}
          y={y}
          textAnchor="end"
          className={MONO}
          fontSize="10"
          letterSpacing="0.14em"
          fill={right.fill}
        >
          {right.text}
        </text>
      )}
    </g>
  );

  return (
    <div className="flex h-full flex-col">
      <VisualCaption>Gross to net sales</VisualCaption>
      <div ref={box} className="relative mt-3 min-h-0 flex-1">
        <svg
          width={size.w}
          height={size.h}
          viewBox={`0 0 ${size.w} ${size.h}`}
          className="absolute inset-0 overflow-visible"
        >
          <defs>
            <linearGradient
              id={`${uid}-bar`}
              gradientUnits="userSpaceOnUse"
              x1="0"
              y1="0"
              x2={W}
              y2="0"
            >
              <stop offset="0" stopColor="#8C7BFF" />
              <stop offset="1" stopColor="#5EA6FF" />
            </linearGradient>
            <linearGradient
              id={`${uid}-net`}
              gradientUnits="userSpaceOnUse"
              x1="0"
              y1="0"
              x2={KEPT * W}
              y2="0"
            >
              <stop offset="0" stopColor="#8C7BFF" />
              <stop offset="0.6" stopColor="#5EA6FF" />
              <stop offset="1" stopColor="#65D8D0" />
            </linearGradient>
          </defs>

          {[geo.gross, geo.discounts, geo.refunds, geo.net].map((r) => (
            <rect
              key={r.barY}
              x="0"
              y={r.barY}
              width={W}
              height={geo.bh}
              rx="5"
              fill="rgb(255 255 255 / 0.03)"
            />
          ))}

          {label("lGross", geo.gross.labelY, "GROSS SALES", "#A8B0BC")}
          {label("lDisc", geo.discounts.labelY, "− DISCOUNTS", "#F4B85A")}
          {label("lRefund", geo.refunds.labelY, "− REFUNDS", "#FF7272")}
          {label("lNet", geo.net.labelY, "NET SALES", TEXT, {
            text: "WHAT YOU KEPT",
            fill: "#58D39B",
          })}

          <rect
            ref={bind("gKept")}
            x="0"
            y={geo.gross.barY}
            width="0"
            height={geo.bh}
            rx="4"
            fill={`url(#${uid}-bar)`}
          />
          <rect
            ref={bind("gRefund")}
            x={KEPT * W + GAP}
            y={geo.gross.barY}
            width="0"
            height={geo.bh}
            rx="4"
            fill={`url(#${uid}-bar)`}
          />
          <rect
            ref={bind("gDisc")}
            x={(KEPT + REFUND) * W + GAP}
            y={geo.gross.barY}
            width="0"
            height={geo.bh}
            rx="4"
            fill={`url(#${uid}-bar)`}
          />
          <rect
            ref={bind("ghost")}
            x={KEPT * W + GAP + 0.5}
            y={geo.gross.barY + 0.5}
            width={Math.max(0, (DISCOUNT + REFUND) * W - GAP - 1)}
            height={geo.bh - 1}
            rx="5"
            fill="none"
            stroke="rgb(255 255 255 / 0.22)"
            strokeDasharray="3 3"
            opacity="0"
          />

          <rect
            ref={bind("dPiece")}
            x={(KEPT + REFUND) * W + GAP}
            y={geo.gross.barY}
            width={DISCOUNT * W - GAP}
            height={geo.bh}
            rx="4"
            fill="#F4B85A"
            opacity="0"
          />
          <rect
            ref={bind("rPiece")}
            x={KEPT * W + GAP}
            y={geo.gross.barY}
            width={REFUND * W - GAP}
            height={geo.bh}
            rx="4"
            fill="#FF7272"
            opacity="0"
          />

          <line
            ref={bind("guide")}
            x1={W}
            x2={W}
            y1={geo.gross.barY - 4}
            y2={geo.net.barY + geo.bh + 4}
            stroke="#A798FF"
            strokeOpacity="0.55"
            strokeDasharray="2 4"
            opacity="0"
          />
          <line
            ref={bind("divider")}
            x1="0"
            x2="0"
            y1={geo.dividerY}
            y2={geo.dividerY}
            stroke="rgb(255 255 255 / 0.22)"
            strokeWidth="1"
          />

          <rect
            ref={bind("netGlow")}
            x="0"
            y={geo.net.barY - 5}
            width="0"
            height={geo.bh + 10}
            rx="9"
            fill="#8C7BFF"
            fillOpacity="0.14"
          />
          <rect
            ref={bind("net")}
            x="0"
            y={geo.net.barY}
            width="0"
            height={geo.bh}
            rx="5"
            fill={`url(#${uid}-net)`}
          />
          <text
            ref={bind("foot")}
            x="0"
            y={geo.footY}
            className={MONO}
            fontSize="10"
            letterSpacing="0.14em"
            fill={MUTED}
            opacity="0"
          >
            BEFORE TAX AND SHIPPING
          </text>
        </svg>
      </div>
    </div>
  );
}
