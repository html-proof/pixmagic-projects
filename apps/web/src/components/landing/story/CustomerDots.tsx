"use client";
import { motion, useTransform, type MotionValue } from "motion/react";
import { useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { useCanvasLoop, type CanvasFrame } from "@/hooks/useCanvasLoop";
import { useViewportPerformance } from "@/hooks/useViewportPerformance";
import { RGB, easeInOut, easeOut, lerp, seeded, segment } from "@/lib/motion";
import { SHAPE, createParticles, rgbOf, type Particles } from "../shared/particles";

/*
 * Customer intelligence: customers as dots that regroup by the dimensions the dashboard really
 * has (new vs returning, sales channel, time of purchase). Group sizes are abstract proportions,
 * chosen only so the clusters read as different sizes; nothing here is a count.
 */

type Tone = "neutral" | "violet" | "cyan" | "blue" | "slate" | "amber";

/** Sprite order. Index 0 is the uncategorised (scattered) state. */
const PALETTE: readonly Tone[] = ["neutral", "violet", "cyan", "blue", "slate", "amber"];
const TONE_RGB: Record<Tone, string> = {
  neutral: "196, 204, 216",
  violet: RGB.violetBright,
  cyan: RGB.cyan,
  blue: RGB.blue,
  slate: "150, 160, 178",
  amber: RGB.warning,
};
/** Matching swatch classes for DOM labels. */
const TONE_SWATCH: Record<Tone, string> = {
  neutral: "bg-lp-text-2",
  violet: "bg-lp-violet-bright",
  cyan: "bg-lp-cyan",
  blue: "bg-lp-blue",
  slate: "bg-[#96A0B2]",
  amber: "bg-lp-warning",
};

export interface CustomerGroup {
  label: string;
  /** Relative size of the cluster. Abstract, never displayed. */
  weight: number;
  tone: Exclude<Tone, "neutral">;
}
export interface CustomerLens {
  name: string;
  groups: CustomerGroup[];
}

export const LENSES: readonly CustomerLens[] = [
  {
    name: "New vs returning",
    groups: [
      { label: "New", weight: 0.56, tone: "cyan" },
      { label: "Returning", weight: 0.44, tone: "violet" },
    ],
  },
  {
    name: "By channel",
    groups: [
      { label: "Online store", weight: 0.5, tone: "violet" },
      { label: "Point of sale", weight: 0.2, tone: "blue" },
      { label: "Draft orders", weight: 0.12, tone: "slate" },
      { label: "Other apps", weight: 0.18, tone: "cyan" },
    ],
  },
  {
    name: "By when they buy",
    groups: [
      { label: "Morning", weight: 0.2, tone: "amber" },
      { label: "Afternoon", weight: 0.3, tone: "cyan" },
      { label: "Evening", weight: 0.34, tone: "violet" },
      { label: "Night", weight: 0.16, tone: "blue" },
    ],
  },
];

/**
 * Scroll windows (in runway progress) during which the dots travel into each lens. Between them
 * the clusters hold still so each grouping can be read.
 */
export const LENS_STAGES: readonly (readonly [number, number])[] = [
  [0.06, 0.2],
  [0.36, 0.5],
  [0.66, 0.8],
];

/** Longest per-dot start delay, as a share of a transition; staggers the swarm. */
const MAX_DELAY = 0.36;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const RING_DASH = [2, 5];
const NO_DASH: number[] = [];

/* ---- Model: who goes where (depends only on the dot count) ---------------------------------- */

interface DotModel {
  n: number;
  /** Per lens: group index of each dot, its slot inside the group, and the group sizes. */
  group: Uint8Array[];
  slot: Uint16Array[];
  counts: number[][];
  /** Per lens: palette index of each dot. */
  tone: Uint8Array[];
  delay: Float32Array;
  curve: Float32Array;
  size: Float32Array;
  alpha: Float32Array;
  phase: Float32Array;
  speed: Float32Array;
  jx: Float32Array;
  jy: Float32Array;
  su: Float32Array;
  sv: Float32Array;
}

/** Split `n` into integer shares of `weights`, every share at least 1, summing exactly to `n`. */
function distribute(n: number, weights: readonly number[]) {
  const total = weights.reduce((s, w) => s + w, 0);
  const counts = weights.map((w) => Math.max(1, Math.floor((w / total) * n)));
  let rest = n - counts.reduce((s, c) => s + c, 0);
  let i = 0;
  while (rest > 0) {
    counts[i % counts.length] += 1;
    rest -= 1;
    i += 1;
  }
  return counts;
}

function shuffled(n: number, seed: number) {
  const rnd = seeded(seed);
  const out = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = out[i];
    out[i] = out[j];
    out[j] = t;
  }
  return out;
}

export function buildModel(n: number): DotModel {
  const rnd = seeded(7_319 + n);
  const f = () => new Float32Array(n);
  const m: DotModel = {
    n,
    group: [],
    slot: [],
    counts: [],
    tone: [],
    delay: f(),
    curve: f(),
    size: f(),
    alpha: f(),
    phase: f(),
    speed: f(),
    jx: f(),
    jy: f(),
    su: f(),
    sv: f(),
  };

  LENSES.forEach((lens, L) => {
    const counts = distribute(
      n,
      lens.groups.map((g) => g.weight),
    );
    const order = shuffled(n, 101 + L * 37);
    const group = new Uint8Array(n);
    const slot = new Uint16Array(n);
    const tone = new Uint8Array(n);
    let g = 0;
    let start = 0;
    order.forEach((dot, j) => {
      while (j >= start + counts[g]) {
        start += counts[g];
        g += 1;
      }
      group[dot] = g;
      slot[dot] = j - start;
      tone[dot] = PALETTE.indexOf(lens.groups[g].tone);
    });
    m.group.push(group);
    m.slot.push(slot);
    m.counts.push(counts);
    m.tone.push(tone);
  });

  // Scattered start: stratified jitter, so the field looks random but has no clumps or holes.
  const cols = Math.ceil(Math.sqrt(n * 1.6));
  const rows = Math.ceil(n / cols);
  const cells = shuffled(cols * rows, 911);
  for (let i = 0; i < n; i++) {
    const c = cells[i];
    m.su[i] = ((c % cols) + 0.15 + rnd() * 0.7) / cols;
    m.sv[i] = (Math.floor(c / cols) + 0.15 + rnd() * 0.7) / rows;
    m.delay[i] = rnd() * MAX_DELAY;
    m.curve[i] = (rnd() - 0.5) * 0.34;
    m.size[i] = 0.72 + rnd() * 0.5;
    m.alpha[i] = 0.55 + rnd() * 0.45;
    m.phase[i] = rnd() * Math.PI * 2;
    m.speed[i] = 0.6 + rnd() * 0.8;
    m.jx[i] = rnd() - 0.5;
    m.jy[i] = rnd() - 0.5;
  }
  return m;
}

/* ---- Geometry: where clusters sit for a given box ------------------------------------------- */

export interface ClusterLayout {
  cx: number[];
  cy: number[];
  r: number[];
}

/**
 * Places one cluster per group: tries every column count and keeps the grid that gives the
 * largest cluster, so wide boxes get a row and tall phone boxes get a 2-column grid. Cluster
 * area is proportional to its size; `band` keeps room above each one for its label.
 */
export function layoutLens(counts: readonly number[], width: number, height: number, pad: number, band: number): ClusterLayout {
  const n = counts.length;
  const w = Math.max(1, width - pad * 2);
  const h = Math.max(1, height - pad * 2);
  let cols = 1;
  let best = -1;
  for (let c = 1; c <= n; c++) {
    const rows = Math.ceil(n / c);
    const R = Math.min(w / c / 2, (h / rows - band) / 2) * 0.86;
    if (R > best) {
      best = R;
      cols = c;
    }
  }
  const rows = Math.ceil(n / cols);
  const cw = w / cols;
  // Rows only as tall as their clusters need, the block centred: on tall phone boxes an even
  // split left a hole between the rows that read as two unrelated pictures.
  const ch = Math.min(h / rows, band + (best / 0.86) * 2 + Math.max(16, best * 0.35));
  const top = pad + (h - ch * rows) / 2;
  const max = Math.max(...counts);
  const out: ClusterLayout = { cx: [], cy: [], r: [] };
  for (let g = 0; g < n; g++) {
    const row = Math.floor(g / cols);
    const col = g % cols;
    const inRow = Math.min(cols, n - row * cols);
    const offset = ((cols - inRow) * cw) / 2;
    out.cx.push(pad + offset + col * cw + cw / 2);
    out.cy.push(top + row * ch + band + (ch - band) / 2);
    out.r.push(Math.max(4, best) * Math.sqrt(counts[g] / max));
  }
  return out;
}

/** Writes every dot's resting position inside its cluster for lens `L` (sunflower packing). */
export function placeDots(model: DotModel, L: number, layout: ClusterLayout, out: Float32Array) {
  const { group, slot, counts } = model;
  for (let i = 0; i < model.n; i++) {
    const g = group[L][i];
    const k = slot[L][i];
    const m = counts[L][g];
    const R = layout.r[g];
    const spacing = R * Math.sqrt(Math.PI / m);
    const rr = R * Math.sqrt((k + 0.5) / m);
    const th = k * GOLDEN + g * 1.7 + L;
    out[i * 2] = layout.cx[g] + Math.cos(th) * rr + model.jx[i] * spacing * 0.45;
    out[i * 2 + 1] = layout.cy[g] + Math.sin(th) * rr + model.jy[i] * spacing * 0.45;
  }
}

/* ---- Canvas scene ----------------------------------------------------------------------------- */

interface Geometry {
  model: DotModel;
  width: number;
  height: number;
  /** Index 0 = scattered, 1..3 = lenses. */
  pos: Float32Array[];
  layouts: ClusterLayout[];
  dotScale: number;
  x: Float32Array;
  y: Float32Array;
  aFrom: Float32Array;
  aTo: Float32Array;
  cFrom: Uint8Array;
  cTo: Uint8Array;
}

interface Pointer {
  x: number;
  y: number;
  inside: boolean;
  influence: number;
  focus: Float32Array;
  anyFocus: number;
}

/**
 * Each dot is a soft round core with a faint halo: the particle renderer's "bead" profile, whose
 * solid core is this share of the dot's radius (keep the two in step).
 */
const CORE = 0.26;
/** Palette as numbers, for the particle renderer. */
const PALETTE_RGB = PALETTE.map((tone) => rgbOf(TONE_RGB[tone]));

function rebuild(model: DotModel, width: number, height: number): Geometry {
  const small = width < 560;
  const pad = small ? 8 : 20;
  const band = small ? 28 : 40;
  const n = model.n;
  const scatter = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    scatter[i * 2] = pad + model.su[i] * (width - pad * 2);
    scatter[i * 2 + 1] = pad + model.sv[i] * (height - pad * 2);
  }
  const pos = [scatter];
  const layouts: ClusterLayout[] = [];
  LENSES.forEach((_, L) => {
    const layout = layoutLens(model.counts[L], width, height, pad, band);
    const out = new Float32Array(n * 2);
    placeDots(model, L, layout, out);
    layouts.push(layout);
    pos.push(out);
  });
  return {
    model,
    width,
    height,
    pos,
    layouts,
    dotScale: small ? 0.8 : 1,
    x: new Float32Array(n),
    y: new Float32Array(n),
    aFrom: new Float32Array(n),
    aTo: new Float32Array(n),
    cFrom: new Uint8Array(n),
    cTo: new Uint8Array(n),
  };
}

function strokeRing(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
}

/** Which transition the scroll is in: from layout `from` towards `from + 1`, `t` of the way. */
function stageAt(p: number) {
  let from = 0;
  let t = 0;
  for (let k = 0; k < LENS_STAGES.length; k++) {
    const [a, b] = LENS_STAGES[k];
    if (p >= a) {
      from = k;
      t = segment(p, a, b);
    }
  }
  return { from, t };
}

/**
 * The interactive dot field. Dots drift while scattered, then travel (staggered, on gentle arcs)
 * into each lens's clusters as `progress` passes the stages. Hovering a settled cluster brings
 * it forward and dims the rest; the pointer also parts the dots slightly.
 */
export function CustomerDots({ progress }: { progress: MotionValue<number> }) {
  const { particleScale, maxDpr } = useViewportPerformance();
  const count = Math.max(140, Math.round(600 * particleScale));
  const model = useMemo(() => buildModel(count), [count]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<HTMLCanvasElement>(null);
  const particles = useRef<Particles | null>(null);
  // Created on mount so its WebGL setup can wait for an idle moment (see particles.ts).
  useEffect(() => {
    particles.current ??= createParticles(glRef.current);
  }, []);
  const geo = useRef<Geometry | null>(null);
  const labelEls = useRef<(HTMLDivElement | null)[][]>(LENSES.map((l) => l.groups.map(() => null)));
  const pointer = useRef<Pointer>({ x: 0, y: 0, inside: false, influence: 0, focus: new Float32Array(4), anyFocus: 0 });

  const draw = (ctx: CanvasRenderingContext2D, { width, height, time, dt, resized }: CanvasFrame) => {
    const pts = (particles.current ??= createParticles(glRef.current));
    pts.begin(width, height, (canvasRef.current?.width ?? width) / width);
    let G = geo.current;
    if (!G || resized || G.model !== model || G.width !== width || G.height !== height) {
      G = rebuild(model, width, height);
      geo.current = G;
      // Labels sit just above their cluster; positioned here so they always match the canvas.
      const small = width < 560;
      G.layouts.forEach((layout, L) => {
        labelEls.current[L].forEach((el, g) => {
          if (!el) return;
          // Clear of the dashed ring (r + 6 / r + 10) and of dots jittered past the radius.
          el.style.transform = `translate3d(${layout.cx[g]}px, ${layout.cy[g] - layout.r[g] - (small ? 11 : 18)}px, 0) translate(-50%, -100%)`;
        });
      });
    }

    const { n, delay, curve, phase, speed, size, alpha, tone, group } = model;
    const { from, t } = stageAt(progress.get());
    const to = from + 1;
    const A = G.pos[from];
    const B = G.pos[to];
    const toneFrom = from === 0 ? null : tone[from - 1];
    const toneTo = tone[to - 1];
    const groupTo = group[to - 1];
    const layoutTo = G.layouts[to - 1];
    const settled = t >= 1;

    // Pointer: ease its influence in and out; focus a cluster only once the dots have settled.
    const P = pointer.current;
    const k = Math.min(1, dt / 200);
    P.influence += ((P.inside ? 1 : 0) - P.influence) * k;
    let focused = -1;
    if (settled && P.inside) {
      for (let g = 0; g < layoutTo.r.length; g++) {
        const dx = P.x - layoutTo.cx[g];
        const dy = P.y - layoutTo.cy[g];
        if (dx * dx + dy * dy < (layoutTo.r[g] + 18) ** 2) focused = g;
      }
    }
    for (let g = 0; g < P.focus.length; g++) P.focus[g] += ((g === focused ? 1 : 0) - P.focus[g]) * k;
    P.anyFocus += ((focused >= 0 ? 1 : 0) - P.anyFocus) * k;

    const repelR = width < 560 ? 54 : 84;
    const repelR2 = repelR * repelR;
    const t1 = time * 0.00055;
    const t2 = time * 0.00047;

    for (let i = 0; i < n; i++) {
      const d = delay[i];
      const lt = easeInOut(segment(t, d, d + 1 - MAX_DELAY));
      const ax = A[i * 2];
      const ay = A[i * 2 + 1];
      const dx = B[i * 2] - ax;
      const dy = B[i * 2 + 1] - ay;
      const arc = Math.sin(lt * Math.PI) * curve[i];
      const amp = from === 0 ? lerp(5, 1.1, lt) : 1.1;
      let x = ax + dx * lt - dy * arc + Math.sin(t1 * speed[i] + phase[i]) * amp;
      let y = ay + dy * lt + dx * arc + Math.cos(t2 * speed[i] + phase[i] * 1.7) * amp;

      if (P.influence > 0.01) {
        const px = x - P.x;
        const py = y - P.y;
        const d2 = px * px + py * py;
        if (d2 < repelR2) {
          const dist = Math.sqrt(d2) || 1;
          const f = (1 - dist / repelR) ** 2 * 14 * P.influence;
          x += (px / dist) * f;
          y += (py / dist) * f;
        }
      }
      G.x[i] = x;
      G.y[i] = y;

      const dim = 1 - 0.68 * P.anyFocus * (1 - P.focus[groupTo[i]]);
      const base = alpha[i] * (from === 0 ? lerp(0.62, 1, lt) : 1) * dim;
      const cf = toneFrom ? toneFrom[i] : 0;
      const ct = toneTo[i];
      G.cFrom[i] = cf;
      G.cTo[i] = ct;
      if (cf === ct) {
        G.aFrom[i] = 0;
        G.aTo[i] = base;
      } else {
        G.aFrom[i] = base * (1 - lt);
        G.aTo[i] = base * lt;
      }
    }

    ctx.clearRect(0, 0, width, height);

    // Faint dashed rings mark each settled cluster's territory.
    const ringGap = width < 560 ? 6 : 10;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1;
    ctx.setLineDash(RING_DASH);
    const ringIn = easeOut(segment(t, 0.72, 1)) * 0.08;
    if (ringIn > 0.002) {
      for (let g = 0; g < layoutTo.r.length; g++) {
        ctx.globalAlpha = ringIn * (1 - 0.6 * P.anyFocus * (1 - P.focus[g]));
        strokeRing(ctx, layoutTo.cx[g], layoutTo.cy[g], layoutTo.r[g] + ringGap);
      }
    }
    const ringOut = from > 0 ? (1 - segment(t, 0, 0.18)) * 0.08 : 0;
    if (ringOut > 0.002) {
      const prev = G.layouts[from - 1];
      ctx.globalAlpha = ringOut;
      for (let g = 0; g < prev.r.length; g++) strokeRing(ctx, prev.cx[g], prev.cy[g], prev.r[g] + ringGap);
    }
    ctx.setLineDash(NO_DASH);

    // Dots; a dot changing group cross-fades between its two colours. Drawn so the solid core is
    // about 2.3px across the radius on desktop.
    const half = (2.3 / CORE) * G.dotScale;
    for (let i = 0; i < n; i++) {
      const s = half * size[i] * 2;
      if (G.aFrom[i] > 0.01) {
        const [r, g, b] = PALETTE_RGB[G.cFrom[i]];
        pts.add(G.x[i], G.y[i], s, s, SHAPE.bead, r, g, b, G.aFrom[i]);
      }
      if (G.aTo[i] > 0.01) {
        const [r, g, b] = PALETTE_RGB[G.cTo[i]];
        pts.add(G.x[i], G.y[i], s, s, SHAPE.bead, r, g, b, G.aTo[i]);
      }
    }
    pts.flush(ctx, "normal");
  };

  useCanvasLoop(canvasRef, draw, { maxDpr });

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType !== "mouse") return;
    const P = pointer.current;
    P.x = e.nativeEvent.offsetX;
    P.y = e.nativeEvent.offsetY;
    P.inside = true;
  };
  const onPointerLeave = () => {
    pointer.current.inside = false;
  };

  return (
    <div className="absolute inset-0" data-cursor="EXPLORE">
      <canvas
        ref={canvasRef}
        aria-hidden
        className="absolute inset-0 h-full w-full"
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
      />
      {/* The dots (WebGL), over the rings drawn on the canvas above; lets the pointer through to it. */}
      <canvas ref={glRef} aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" />
      {LENSES.map((lens, L) => (
        <LensLabels
          key={lens.name}
          lens={lens}
          index={L}
          progress={progress}
          register={(g, el) => {
            labelEls.current[L][g] = el;
          }}
        />
      ))}
    </div>
  );
}

/** Group names for one lens, faded in as its clusters settle and out as the next lens begins. */
function LensLabels({
  lens,
  index,
  progress,
  register,
}: {
  lens: CustomerLens;
  index: number;
  progress: MotionValue<number>;
  register: (group: number, el: HTMLDivElement | null) => void;
}) {
  const [start, end] = LENS_STAGES[index];
  const next = LENS_STAGES[index + 1];
  const opacity = useTransform(progress, (p) => {
    // Only once the late dots have nearly landed, so no label sits on a stream of moving dots.
    const fadeIn = easeOut(segment(p, end - (end - start) * 0.18, end + 0.02));
    const fadeOut = next ? segment(p, next[0], next[0] + 0.05) : 0;
    return fadeIn * (1 - fadeOut);
  });
  const y = useTransform(opacity, (o) => (1 - o) * 8);
  return (
    <motion.div aria-hidden className="lp-layer pointer-events-none absolute inset-0" style={{ opacity, y }}>
      {lens.groups.map((group, g) => (
        <div
          key={group.label}
          ref={(el) => register(g, el)}
          className="absolute left-0 top-0 flex items-center gap-2 whitespace-nowrap text-[12.5px] font-medium tracking-[-0.005em] text-lp-text [text-shadow:0_0_10px_#0D1015,0_0_4px_#0D1015] md:text-[14px]"
        >
          <span className={`size-2 rounded-full ${TONE_SWATCH[group.tone]}`} />
          {group.label}
        </div>
      ))}
    </motion.div>
  );
}

/* ---- Reduced motion: three static small multiples -------------------------------------------- */

const MULTI_W = 320;
const MULTI_H = 268;
const MULTI_DOTS = 150;

/**
 * The three lenses side by side as still pictures, for visitors who asked for less motion.
 * Same model and layout code as the canvas, rendered once as SVG.
 */
export function CustomerLensMultiples() {
  const scenes = useMemo(() => {
    const model = buildModel(MULTI_DOTS);
    return LENSES.map((lens, L) => {
      const layout = layoutLens(model.counts[L], MULTI_W, MULTI_H, 6, 30);
      const out = new Float32Array(MULTI_DOTS * 2);
      placeDots(model, L, layout, out);
      const dots = Array.from({ length: MULTI_DOTS }, (_, i) => ({
        x: Math.round(out[i * 2] * 10) / 10,
        y: Math.round(out[i * 2 + 1] * 10) / 10,
        rgb: TONE_RGB[PALETTE[model.tone[L][i]]],
        o: Math.round(model.alpha[i] * 100) / 100,
      }));
      return { lens, layout, dots };
    });
  }, []);

  return (
    // One per row until lg: three columns on a tablet would shrink the labels below legibility.
    <ul className="grid gap-4 md:gap-5 lg:grid-cols-3">
      {scenes.map(({ lens, layout, dots }, L) => (
        <li key={lens.name} className="rounded-[22px] border border-lp-line bg-lp-elevated/60 p-5 lg:p-4 xl:p-5">
          <h3 className="flex items-baseline gap-3 text-[15px] font-medium text-lp-text">
            <span className="font-lp-mono text-[11px] tracking-[0.16em] text-lp-muted">0{L + 1}</span>
            {lens.name}
          </h3>
          <svg
            viewBox={`0 0 ${MULTI_W} ${MULTI_H}`}
            className="mx-auto mt-4 h-auto w-full max-w-[440px]"
            role="img"
            aria-label={`Customers grouped ${lens.name.toLowerCase()}: ${lens.groups.map((g) => g.label).join(", ")}.`}
          >
            {dots.map((d, i) => (
              <circle key={i} cx={d.x} cy={d.y} r={2} fill={`rgb(${d.rgb})`} fillOpacity={d.o} />
            ))}
            {lens.groups.map((g, i) => (
              <text
                key={g.label}
                x={layout.cx[i]}
                y={layout.cy[i] - layout.r[i] - 8}
                textAnchor="middle"
                fontSize={13}
                fontWeight={500}
                className="fill-lp-text-2"
              >
                {g.label}
              </text>
            ))}
          </svg>
        </li>
      ))}
    </ul>
  );
}
