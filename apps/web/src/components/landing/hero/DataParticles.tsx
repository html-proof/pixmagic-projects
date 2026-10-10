"use client";
import type { MotionValue } from "motion/react";
import { useRef, type RefObject } from "react";
import { useCanvasLoop, type CanvasFrame } from "@/hooks/useCanvasLoop";
import { useViewportPerformance } from "@/hooks/useViewportPerformance";
import { RGB, clamp01, easeInOut, lerp, seeded, segment } from "@/lib/motion";
import { CORE_R, RINGS } from "./HeroLayout";

/* ---- The field: precomputed once, deterministic ---------------------------------------------- */

const N_MAX = 700;

const SQUARE = 0;
const CIRCLE = 1;
const DIAMOND = 2;
const DASH = 3;

const COLORS = [`rgb(${RGB.violet})`, `rgb(${RGB.violetBright})`, `rgb(${RGB.blue})`, `rgb(${RGB.cyan})`, `rgb(${RGB.text})`];
const SPRITE_RGB = [RGB.violet, RGB.violetBright, RGB.blue, RGB.cyan, RGB.text];
const LABEL_FILL = "rgb(168, 176, 188)";

/**
 * The kinds of Shopify activity the points stand for. Each has its own shape and colour, so the
 * field reads as structured data rather than dust. Store visits carry no label (they are the
 * quiet majority), everything else occasionally names itself.
 */
const TYPES = [
  { label: "ORDER", shape: SQUARE, color: 0 },
  { label: "CUSTOMER", shape: CIRCLE, color: 2 },
  { label: "PRODUCT", shape: DIAMOND, color: 3 },
  { label: "CHECKOUT", shape: DASH, color: 1 },
  { label: "PAYMENT", shape: SQUARE, color: 4 },
  { label: "", shape: CIRCLE, color: 4 },
  { label: "REFUND", shape: DASH, color: 4 },
  { label: "INVENTORY", shape: DIAMOND, color: 2 },
] as const;
const LABELLED = TYPES.map((t, i) => (t.label ? i : -1)).filter((i) => i >= 0);

/** Domains named as they flow into the core during stage 2. */
const INFLOW = ["Orders", "Customers", "Products", "Checkout", "Payments", "Channels"];
const INFLOW_ANGLES = [-150, -96, -34, 28, 92, 156].map((d) => (d * Math.PI) / 180);

/**
 * Stage 1 is not a starfield: most points travel in event streams ("lanes") that run across the
 * screen in bursts, the way store activity arrives, and pinch together where the core will form.
 * Lane centres as fractions of the height, plus a slow wave per lane.
 */
const LANE_Y = [0.15, 0.26, 0.37, 0.48, 0.59, 0.7, 0.81, 0.91];
const LANES = LANE_Y.length;
const LANE_SPEED = [1, 0.82, 1.14, 0.92, 1.06, 0.86, 1.1, 0.95];
const LANE_FREQ = [0.9, 1.3, 0.7, 1.1, 0.8, 1.2, 1, 0.75];
const LANE_PHASE = [0.2, 2.1, 4, 1.3, 5.2, 3.1, 0.8, 2.7];
const LANE_AMP = 0.014;
const NO_LANE = 255;
const PACKETS = 4;

/** Orbit kinds after convergence. */
const RING = 0;
const HALO = 1;
const ABSORB = 2;

const RING_COS = RINGS.map((r) => Math.cos((r.tilt * Math.PI) / 180));
const RING_SIN = RINGS.map((r) => Math.sin((r.tilt * Math.PI) / 180));

interface Field {
  hx: Float32Array;
  hy: Float32Array;
  vx: Float32Array;
  wobA: Float32Array;
  wobF: Float32Array;
  phase: Float32Array;
  size: Float32Array;
  alpha: Float32Array;
  layer: Uint8Array;
  type: Uint8Array;
  delay: Float32Array;
  outDelay: Float32Array;
  kind: Uint8Array;
  radius: Float32Array;
  squash: Float32Array;
  tcos: Float32Array;
  tsin: Float32Array;
  angle: Float32Array;
  angVel: Float32Array;
  swirl: Float32Array;
  /** Event stream the point travels in (NO_LANE for the faint background dust). */
  lane: Uint8Array;
  /** Offset from the lane's centre line, as a fraction of the height. */
  laneOff: Float32Array;
  /** Indices per labelled type, for the stage-1 event labels (mid and near layers only). */
  byType: number[][];
}

let FIELD: Field | null = null;

function buildField(): Field {
  const rand = seeded(0x1a51);
  const f: Field = {
    hx: new Float32Array(N_MAX),
    hy: new Float32Array(N_MAX),
    vx: new Float32Array(N_MAX),
    wobA: new Float32Array(N_MAX),
    wobF: new Float32Array(N_MAX),
    phase: new Float32Array(N_MAX),
    size: new Float32Array(N_MAX),
    alpha: new Float32Array(N_MAX),
    layer: new Uint8Array(N_MAX),
    type: new Uint8Array(N_MAX),
    delay: new Float32Array(N_MAX),
    outDelay: new Float32Array(N_MAX),
    kind: new Uint8Array(N_MAX),
    radius: new Float32Array(N_MAX),
    squash: new Float32Array(N_MAX),
    tcos: new Float32Array(N_MAX),
    tsin: new Float32Array(N_MAX),
    angle: new Float32Array(N_MAX),
    angVel: new Float32Array(N_MAX),
    swirl: new Float32Array(N_MAX),
    lane: new Uint8Array(N_MAX),
    laneOff: new Float32Array(N_MAX),
    byType: TYPES.map(() => []),
  };
  const SPEED = [0.0000042, 0.000021, 0.000029];
  // Burst positions per lane: a stream arrives in packets, with quieter stretches between.
  const packets = Array.from({ length: LANES }, () => Array.from({ length: PACKETS }, () => rand()));
  for (let i = 0; i < N_MAX; i++) {
    const l = rand();
    const layer = l < 0.42 ? 0 : l < 0.8 ? 1 : 2;
    const type = Math.floor(rand() * TYPES.length);
    f.layer[i] = layer;
    f.type[i] = type;
    f.hx[i] = rand();
    f.hy[i] = 0.04 + rand() * 0.92;
    f.lane[i] = NO_LANE;
    f.vx[i] = 0.0000042 * (0.7 + rand() * 0.6);
    if (layer > 0 && rand() < 0.88) {
      const lane = Math.floor(rand() * LANES);
      f.lane[i] = lane;
      f.laneOff[i] = (rand() - 0.5) * (layer === 2 ? 0.014 : 0.024);
      // Points in a lane share its speed (per depth layer), so bursts hold together as they travel.
      f.vx[i] = SPEED[layer] * LANE_SPEED[lane];
      if (rand() < 0.62) f.hx[i] = (packets[lane][Math.floor(rand() * PACKETS)] + (rand() - 0.5) * 0.07 + 1) % 1;
    }
    f.wobA[i] = 0.003 + rand() * 0.009;
    f.wobF[i] = 0.00018 + rand() * 0.0003;
    f.phase[i] = rand() * Math.PI * 2;
    f.size[i] = layer === 0 ? 0.8 + rand() * 0.5 : layer === 1 ? 1.25 + rand() * 0.6 : 1.9 + rand() * 0.8;
    f.alpha[i] = layer === 0 ? 0.14 + rand() * 0.14 : layer === 1 ? 0.42 + rand() * 0.2 : 0.66 + rand() * 0.24;
    f.delay[i] = rand() * 0.45;
    f.outDelay[i] = rand() * 0.4;
    f.angle[i] = rand() * Math.PI * 2;
    f.swirl[i] = (0.12 + rand() * 0.2) * (rand() < 0.5 ? -1 : 1);
    const k = rand();
    if (k < 0.56) {
      const ring = Math.floor(rand() * RINGS.length);
      f.kind[i] = RING;
      f.radius[i] = RINGS[ring].r * (0.96 + rand() * 0.08);
      f.squash[i] = RINGS[ring].squash;
      f.tcos[i] = RING_COS[ring];
      f.tsin[i] = RING_SIN[ring];
      f.angVel[i] = ((Math.PI * 2) / (RINGS[ring].period * 1000)) * (0.85 + rand() * 0.3);
    } else {
      const tilt = (-30 + rand() * 50) * (Math.PI / 180);
      f.kind[i] = k < 0.8 ? HALO : ABSORB;
      f.radius[i] = f.kind[i] === HALO ? 1.25 + rand() * 1.9 : rand() * 0.4;
      f.squash[i] = 0.45 + rand() * 0.5;
      f.tcos[i] = Math.cos(tilt);
      f.tsin[i] = Math.sin(tilt);
      f.angVel[i] = ((Math.PI * 2) / ((50 + rand() * 60) * 1000)) * (rand() < 0.85 ? 1 : -1);
    }
    if (layer > 0 && TYPES[type].label) f.byType[type].push(i);
  }
  return f;
}

/** Soft round glow, rendered once per colour and stamped with drawImage (no shadowBlur). */
function makeSprite(rgb: string) {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d");
  if (g) {
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, `rgba(${rgb}, 0.9)`);
    grad.addColorStop(0.35, `rgba(${rgb}, 0.28)`);
    grad.addColorStop(1, `rgba(${rgb}, 0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
  }
  return c;
}

interface LoopState {
  n: number;
  order: Uint16Array;
  avail: Int32Array;
  boxL: number;
  boxT: number;
  boxW: number;
  boxH: number;
  measuredAt: number;
  font: string;
  labelFont: string;
  sprites: HTMLCanvasElement[] | null;
  /** Lane guide stroke, rebuilt when the focus point or the size changes. */
  guide: CanvasGradient | null;
  guideKey: number;
}

function newLoopState(): LoopState {
  return {
    n: -1,
    order: new Uint16Array(N_MAX),
    avail: new Int32Array(TYPES.length),
    boxL: 0,
    boxT: 0,
    boxW: 0,
    boxH: 0,
    measuredAt: -1e9,
    font: "",
    labelFont: "",
    sprites: null,
    guide: null,
    guideKey: -1,
  };
}

/** Draw order: far layer first, and grouped by colour inside a layer so fillStyle rarely changes. */
function buildOrder(f: Field, n: number, out: Uint16Array) {
  const buckets = 3 * COLORS.length;
  const counts = new Int32Array(buckets + 1);
  for (let i = 0; i < n; i++) counts[f.layer[i] * COLORS.length + TYPES[f.type[i]].color + 1]++;
  for (let b = 1; b <= buckets; b++) counts[b] += counts[b - 1];
  for (let i = 0; i < n; i++) out[counts[f.layer[i] * COLORS.length + TYPES[f.type[i]].color]++] = i;
}

/** Box position in the canvas's own coordinates, from layout offsets (immune to the stage scale). */
function measureBox(canvas: HTMLCanvasElement, box: HTMLElement | null, width: number, height: number, s: LoopState) {
  const k = canvas.clientWidth > 0 ? width / canvas.clientWidth : 1;
  const parent = canvas.offsetParent;
  let x = 0;
  let y = 0;
  let el: HTMLElement | null = box;
  while (el && el !== parent) {
    x += el.offsetLeft;
    y += el.offsetTop;
    el = el.offsetParent as HTMLElement | null;
  }
  if (!box || el !== parent || box.offsetWidth === 0) {
    s.boxL = 0;
    s.boxT = 0;
    s.boxW = width;
    s.boxH = height;
    return;
  }
  s.boxL = (x - canvas.offsetLeft) * k;
  s.boxT = (y - canvas.offsetTop) * k;
  s.boxW = box.offsetWidth * k;
  s.boxH = box.offsetHeight * k;
}

/**
 * Centre line of lane `l` at screen x: a slow wave, pinched towards the focus (where the core
 * will form) so the streams visibly head for one place before they converge into it.
 */
function laneY(l: number, x: number, w: number, h: number, t: number, fx: number, fy: number, sig: number, pinch: number) {
  const base = (LANE_Y[l] + Math.sin((x / w) * Math.PI * 2 * LANE_FREQ[l] + LANE_PHASE[l] + t * 0.00007) * LANE_AMP) * h;
  const d = (x - fx) / sig;
  return fy + (base - fy) * (1 - pinch * Math.exp(-d * d));
}

export interface DataParticlesProps {
  progress: MotionValue<number>;
  /** 0..1 entrance fade, played when the intro hands over. */
  enter: MotionValue<number>;
  /** Core centre in box % and its scale (shared with IntelligenceCore). */
  coreX: MotionValue<number>;
  coreY: MotionValue<number>;
  coreScale: MotionValue<number>;
  /** 1 in the side-by-side layout, 0 when stacked. */
  wide: MotionValue<number>;
  /** The visual box the core lives in. */
  boxRef: RefObject<HTMLElement | null>;
  /** Reduced motion: draw one still frame. */
  still?: boolean;
  className?: string;
}

/**
 * The hero's data field on a 2D canvas: hundreds of tiny shapes in three depth layers standing for
 * orders, customers, products, checkouts, payments, visits, refunds and inventory. They drift
 * calmly (stage 1), converge into the core with staggered delays and settle into its orbits
 * (stage 2–3), then disperse into a faint field as the dashboard forms (stage 4–5). Everything is
 * read from MotionValues inside the frame loop; nothing re-renders React.
 */
export function DataParticles({ progress, enter, coreX, coreY, coreScale, wide, boxRef, still = false, className = "" }: DataParticlesProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const perf = useViewportPerformance();
  const count = Math.round(N_MAX * perf.particleScale);
  const glow = !perf.lowPower && perf.tier !== "mobile";
  // Created lazily in the first frame, so re-renders don't allocate throwaway typed arrays.
  const state = useRef<LoopState | null>(null);

  const draw = (ctx: CanvasRenderingContext2D, { width: w, height: h, time: t, resized }: CanvasFrame) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const f = (FIELD ??= buildField());
    const s = (state.current ??= newLoopState());

    if (resized || t - s.measuredAt > 1000 || t < s.measuredAt) {
      measureBox(canvas, boxRef.current, w, h, s);
      s.measuredAt = t;
      if (resized || !s.font) {
        const family = getComputedStyle(canvas).fontFamily || "ui-monospace, monospace";
        s.font = `500 9.5px ${family}`;
        s.labelFont = `500 10.5px ${family}`;
      }
    }
    if (!s.sprites) s.sprites = SPRITE_RGB.map(makeSprite);
    if (s.n !== count) {
      s.n = count;
      buildOrder(f, count, s.order);
      for (let ty = 0; ty < TYPES.length; ty++) {
        const list = f.byType[ty];
        let a = 0;
        while (a < list.length && list[a] < count) a++;
        s.avail[ty] = a;
      }
    }

    ctx.clearRect(0, 0, w, h);
    const fade = enter.get();
    if (fade <= 0.001) return;

    const p = progress.get();
    const isWide = wide.get() > 0.5;
    const cx = s.boxL + (coreX.get() / 100) * s.boxW;
    const cy = s.boxT + (coreY.get() / 100) * s.boxH;
    const R = CORE_R * s.boxW * coreScale.get();

    const s1 = segment(p, 0, 0.18);
    const s2 = segment(p, 0.18, 0.38);
    const calm = segment(p, 0.38, 0.46);
    const out = segment(p, 0.6, 0.76);
    const faint = lerp(1, 0.3, out);

    // Focus of the streams: the centre of the visual box, where the core is born.
    const fx = s.boxL + s.boxW / 2;
    const fy = s.boxT + s.boxH / 2;
    const sig = w * (isWide ? 0.24 : 0.4);
    // Gentler when stacked: the focus sits low and central, and a strong pinch would empty the top.
    const pinch = isWide ? 0.58 : 0.3;
    const sprites = s.sprites;

    // Lane guides and the focus glow: the structure the events travel along (stage 1 only).
    const structure = fade * (1 - segment(p, 0.12, 0.26));
    if (structure > 0.01) {
      const key = Math.round(fx) * 10000 + Math.round(w);
      if (!s.guide || s.guideKey !== key) {
        const g = ctx.createLinearGradient(0, 0, w, 0);
        const fp = clamp01(fx / w);
        g.addColorStop(0, "rgba(167, 152, 255, 0)");
        g.addColorStop(fp * 0.45, "rgba(167, 152, 255, 0.05)");
        g.addColorStop(fp, "rgba(167, 152, 255, 0.12)");
        g.addColorStop(Math.min(1, fp + (1 - fp) * 0.6), "rgba(94, 166, 255, 0.05)");
        g.addColorStop(1, "rgba(94, 166, 255, 0)");
        s.guide = g;
        s.guideKey = key;
      }
      ctx.globalAlpha = structure;
      ctx.strokeStyle = s.guide;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const STEPS = 48;
      for (let l = 0; l < LANES; l++) {
        for (let k = 0; k <= STEPS; k++) {
          const x = (k / STEPS) * w;
          const y = laneY(l, x, w, h, t, fx, fy, sig, pinch);
          if (k === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
      if (sprites) {
        const g = Math.max(s.boxW, s.boxH) * 0.42;
        ctx.globalAlpha = structure * 0.16;
        ctx.drawImage(sprites[0], fx - g, fy - g, g * 2, g * 2);
      }
    }

    let color = -1;
    for (let o = 0; o < count; o++) {
      const i = s.order[o];
      const L = f.layer[i];
      const u = (f.hx[i] + t * f.vx[i]) % 1.1;
      let x = (u - 0.05) * w;
      const lane = f.lane[i];
      let y =
        lane === NO_LANE
          ? (f.hy[i] + Math.sin(t * f.wobF[i] + f.phase[i]) * f.wobA[i] - s1 * 0.03) * h
          : laneY(lane, x, w, h, t, fx, fy, sig, pinch) + (f.laneOff[i] + Math.sin(t * f.wobF[i] + f.phase[i]) * 0.002) * h;

      const d = f.delay[i];
      const c = s2 <= d ? 0 : easeInOut((s2 - d) / 0.55);
      const od = f.outDelay[i];
      const dis = out <= od ? 0 : easeInOut((out - od) / 0.6);
      const m = c * (1 - dis);
      // Fade out across the off-screen wrap point: a point that is part-way to the core is drawn
      // on screen, so its home jumping from the right edge to the left would otherwise show.
      const edge = u < 0.05 ? u / 0.05 : u > 1.05 ? (1.1 - u) / 0.05 : 1;
      let a = f.alpha[i] * fade * faint * edge;
      let sz = f.size[i];

      if (m > 0) {
        const kind = f.kind[i];
        const ang = f.angle[i] + t * f.angVel[i];
        const rr = f.radius[i] * R;
        const ox = Math.cos(ang) * rr;
        const oy = Math.sin(ang) * rr * f.squash[i];
        const tx = cx + ox * f.tcos[i] - oy * f.tsin[i];
        const ty = cy + ox * f.tsin[i] + oy * f.tcos[i];
        const ex = tx - x;
        const ey = ty - y;
        const bend = Math.sin(m * Math.PI) * f.swirl[i];
        x += ex * m - ey * bend;
        y += ey * m + ex * bend;
        sz *= 1 - 0.25 * m;
        a *= lerp(1, 1 - 0.4 * calm, m);
        if (kind === ABSORB) a *= 1 - segment(m, 0.6, 1);
      }

      if (a < 0.01 || x < -40 || x > w + 12 || y < -12 || y > h + 12) continue;

      const ty = TYPES[f.type[i]];
      if (glow && L === 2 && sprites) {
        const g = sz * 5;
        ctx.globalAlpha = a * 0.45;
        ctx.drawImage(sprites[ty.color], x - g, y - g, g * 2, g * 2);
      }
      if (ty.color !== color) {
        color = ty.color;
        ctx.fillStyle = COLORS[color];
      }
      // A short wake behind points travelling in a stream, so direction reads even when still.
      if (lane !== NO_LANE && m < 0.5) {
        const trail = (L === 2 ? 26 : 14) * (1 - m * 2);
        ctx.globalAlpha = a * 0.22;
        ctx.fillRect(x - trail, y - 0.5, trail, 1);
      }
      ctx.globalAlpha = a;
      switch (ty.shape) {
        case SQUARE:
          ctx.fillRect(x - sz * 0.8, y - sz * 0.8, sz * 1.6, sz * 1.6);
          break;
        case CIRCLE:
          ctx.beginPath();
          ctx.arc(x, y, sz, 0, Math.PI * 2);
          ctx.fill();
          break;
        case DIAMOND:
          ctx.beginPath();
          ctx.moveTo(x, y - sz * 1.15);
          ctx.lineTo(x + sz * 1.15, y);
          ctx.lineTo(x, y + sz * 1.15);
          ctx.lineTo(x - sz * 1.15, y);
          ctx.closePath();
          ctx.fill();
          break;
        default:
          ctx.fillRect(x - sz * 2.2, y - 0.5, sz * 4.4, Math.max(0.9, sz * 0.5));
      }
    }

    // Stage 1: now and then an event names itself next to its point, like a log line in passing.
    const eventLabels = fade * (1 - segment(p, 0.1, 0.17));
    if (eventLabels > 0.01) {
      ctx.font = s.font;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = LABEL_FILL;
      const PERIOD = 5600;
      const SLOTS = w < 768 ? 3 : 6;
      for (let slot = 0; slot < SLOTS; slot++) {
        const phase = t + (slot * PERIOD) / SLOTS + slot * 311;
        const cycle = Math.floor(phase / PERIOD);
        const u = (phase - cycle * PERIOD) / PERIOD;
        const env = segment(u, 0, 0.16) * (1 - segment(u, 0.72, 1));
        if (env <= 0) continue;
        const type = LABELLED[(cycle * 3 + slot * 5) % LABELLED.length];
        const avail = s.avail[type];
        if (!avail) continue;
        const i = f.byType[type][(cycle * 7 + slot * 13) % avail];
        const lane = f.lane[i];
        if (lane === NO_LANE) continue;
        const x = (((f.hx[i] + t * f.vx[i]) % 1.1) - 0.05) * w;
        const y = laneY(lane, x, w, h, t, fx, fy, sig, pinch) + (f.laneOff[i] + Math.sin(t * f.wobF[i] + f.phase[i]) * 0.002) * h - 11;
        if (x < 24 || x > w - 110 || y < 110 || y > h - 70) continue;
        // Never write across the headline: left on wide screens, mid-screen when stacked, and at
        // the top of the static (reduced-motion) composition on narrow screens.
        if (still ? (w < 1024 ? y < h * 0.6 : x < w * 0.56) : isWide ? x < w * 0.56 : y > h * 0.3 && y < h * 0.8) continue;
        ctx.globalAlpha = env * eventLabels * 0.85;
        ctx.fillRect(x, y + 4, 1, 7);
        ctx.fillText(TYPES[type].label, x + 6, y);
      }
    }

    // Stage 2: the domains of a store drift inward and dissolve as they reach the core.
    if (s2 > 0 && s2 < 1 && R > 0) {
      ctx.font = s.labelFont;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = LABEL_FILL;
      const r0 = s.boxW * (isWide ? 0.5 : 0.48);
      for (let k = 0; k < INFLOW.length; k++) {
        const u = segment(s2, 0.03 + k * 0.075, 0.51 + k * 0.075);
        if (u <= 0 || u >= 1) continue;
        const env = segment(u, 0, 0.18) * (1 - segment(u, 0.66, 1));
        const ang = INFLOW_ANGLES[k] + u * 0.5;
        const r = lerp(r0, R * 1.25, easeInOut(u));
        const x = cx + Math.cos(ang) * r;
        const y = cy + Math.sin(ang) * r * 0.82;
        ctx.globalAlpha = clamp01(env * fade * 0.9);
        ctx.beginPath();
        ctx.arc(x, y + 9, 1.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillText(INFLOW[k], x, y - 3);
      }
    }
    ctx.globalAlpha = 1;
  };

  useCanvasLoop(canvasRef, draw, { still, maxDpr: perf.tier === "mobile" ? 1.5 : 2 });

  return <canvas ref={canvasRef} aria-hidden className={`pointer-events-none absolute inset-0 size-full font-lp-mono ${className}`} />;
}
