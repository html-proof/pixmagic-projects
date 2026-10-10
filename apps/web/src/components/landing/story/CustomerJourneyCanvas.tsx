"use client";
import { motion, useTransform, type MotionValue } from "motion/react";
import { useEffect, useRef } from "react";
import { RGB, clamp01, easeInOut, easeOut, lerp, seeded, segment } from "@/lib/motion";
import { useCanvasLoop, type CanvasFrame } from "@/hooks/useCanvasLoop";
import { useViewportPerformance } from "@/hooks/useViewportPerformance";
import { SrOnly } from "../shared/ui";

/* ---- Journey geometry -------------------------------------------------------------------------
 * The journey lives in a normalised space: `u` runs along the flow (0 = arrival, 1 = far end) and
 * `v` runs across it, as a fraction of the cross dimension (height when horizontal, width when
 * vertical). The canvas and the DOM labels both project from this space with the same camera, so
 * the drawn gates and the HTML labels never drift apart.
 */

/** The five steps of the product's real shopping funnel, in order. */
export const STAGES = [
  { name: "Discovery", step: "Visited" },
  { name: "Product", step: "Viewed a product" },
  { name: "Cart", step: "Added to cart" },
  { name: "Checkout", step: "Started checkout" },
  { name: "Purchase", step: "Purchased" },
] as const;

/** Where each stage's gate sits along the flow. */
export const GATES = [0.12, 0.31, 0.5, 0.69, 0.88] as const;
/** Where buyers converge and the stream ends. */
const CORE = 0.945;
/** Half-width of the stream at each gate: it narrows sharply as fewer people continue. */
const HALF_BAND = [0.1, 0.076, 0.056, 0.04, 0.028] as const;
/** Arrivals come in wide and converge on the first gate. */
const INFLOW_SPREAD = 0.24;
/** Chance of leaving at gate k for someone who reached it (Discovery, Product, Cart, Checkout). */
const LEAVE_P = [0.3, 0.38, 0.4, 0.34] as const;
/** Share of all arrivals that leave at each gate: sets each exit branch's weight. */
const LEAVE_SHARE = LEAVE_P.map((p, k) => p * LEAVE_P.slice(0, k).reduce((acc, q) => acc * (1 - q), 1));

/** Exit points, named with the site sections the product actually reports where visits leave. */
export const EXITS = [
  { gate: 1, label: "Product page", tone: "warning" },
  { gate: 2, label: "Cart", tone: "warning" },
  { gate: 3, label: "Checkout", tone: "negative" },
] as const;

/** Stage labels sit this far above the stream centre (fraction of height, before camera zoom). */
const LABEL_V = -0.19;
/** Exit branches end, and their markers start, this far to the stream's exit side. */
const EXIT_V = 0.2;
const EXIT_V_VERTICAL = 0.25;
/** Exit branches end this far past their gate, along the flow (further on the short vertical flow). */
const EXIT_DU = 0.032;
const EXIT_DU_VERTICAL = 0.07;

/** How a scene frames the journey. */
export interface JourneyFrame {
  /** World width ÷ viewport width when horizontal. 1 = the whole journey fits (no camera). */
  world: number;
  /** Stream centre line, as a fraction of height (horizontal). */
  yc: number;
  /** Where the centre line settles once the camera pulls back. */
  ycPulled: number;
  /** Vertical (mobile) layout: the flow runs from `top` to `bottom` (fractions of height). */
  top: number;
  bottom: number;
  /** Vertical layout: stream centre, as a fraction of width. */
  cx: number;
}

/**
 * When the journey runs horizontally: wide screens in landscape. Phones and portrait tablets get the
 * vertical funnel, which fills a tall screen instead of leaving it mostly empty. Keep in step with
 * the `md:landscape:` classes.
 */
export const WIDE_QUERY = "(min-width: 48rem) and (orientation: landscape)";

/** Sticky scroll scene: a wide world the camera travels through, then pulls back from. */
export const RUNWAY_FRAME: JourneyFrame = { world: 2.2, yc: 0.65, ycPulled: 0.63, top: 0.33, bottom: 0.95, cx: 0.62 };
/** Reduced motion: the whole journey at once. */
export const STATIC_FRAME: JourneyFrame = { world: 1, yc: 0.46, ycPulled: 0.46, top: 0.04, bottom: 0.96, cx: 0.6 };

// Camera keyframes: [progress, centre of view along the flow]. It eases into each gate and dwells
// there while that gate's question is on screen. "start" / "end" frame the first and last stretch of the world.
const CAM_KEYS: [number, number | "start" | "end"][] = [
  [0, "start"],
  [0.08, "start"],
  [0.18, GATES[1]],
  [0.25, GATES[1]],
  [0.35, GATES[2]],
  [0.42, GATES[2]],
  [0.52, GATES[3]],
  [0.59, GATES[3]],
  [0.67, "end"],
  [0.7, "end"],
];
/** The camera pulls back to the whole journey over this window. */
const PULL = [0.7, 0.84] as const;
/**
 * Pulled back, the flow shrinks to fit the width but the cross axis shrinks less, so the stream
 * stays a confident band instead of collapsing into a hairline.
 */
const ZY_PULLED = 0.74;
/** On-screen windows for the four questions, each tied to a gate the camera is looking at. */
// Each message has fully left before the next arrives: two display-size lines crossfading in the
// same grid cell read as a smudge.
export const QUESTION_WINDOWS: readonly [number, number, number, number][] = [
  [0.08, 0.11, 0.165, 0.195],
  [0.195, 0.225, 0.3, 0.33],
  [0.33, 0.36, 0.46, 0.49],
  [0.49, 0.52, 0.66, 0.69],
];
export const FINAL_WINDOW = [0.695, 0.75] as const;

export interface Camera {
  /** Point of the flow (0..1) at the centre of the view. */
  cf: number;
  /** Zoom along the flow: 1 while following, world-fit once pulled back. */
  z: number;
  /** Zoom across the flow. */
  zy: number;
  /** 0..1 how far the pull-back has gone. */
  pull: number;
}

/** Camera for a scroll position. Shared by the canvas, the label layer and the minimap. */
export function cameraAt(p: number, world: number): Camera {
  if (world <= 1) return { cf: 0.5, z: 1, zy: 1, pull: 1 };
  const start = 0.5 / world;
  const end = 1 - start;
  const at = (k: number | "start" | "end") => (k === "start" ? start : k === "end" ? end : k);
  let cf = end;
  for (let k = 0; k < CAM_KEYS.length - 1; k++) {
    const [p0, c0] = CAM_KEYS[k];
    const [p1, c1] = CAM_KEYS[k + 1];
    if (p <= p1) {
      cf = lerp(at(c0), at(c1), easeInOut(segment(p, p0, p1)));
      break;
    }
  }
  const pull = easeInOut(segment(p, PULL[0], PULL[1]));
  return { cf: lerp(cf, 0.5, pull), z: lerp(1, 0.9 / world, pull), zy: lerp(1, ZY_PULLED, pull), pull };
}

/** 0..1 how much stage `i` is "in focus": near the centre of the view, or everything once pulled back. */
function focusAt(p: number, i: number, world: number) {
  if (world <= 1) return 1;
  const { cf, pull } = cameraAt(p, world);
  return Math.max(clamp01(1 - Math.abs(GATES[i] - cf) * world * 1.5), pull);
}

/** 0..1 emphasis of exit `k`: while its question is asked, then all of them at the end. */
function exitEmphasis(p: number, k: number, world: number) {
  if (world <= 1) return 1;
  const [a, , , d] = QUESTION_WINDOWS[k + 1];
  const bump = Math.min(segment(p, a, a + 0.04), 1 - segment(p, d - 0.05, d));
  return Math.max(bump, segment(p, FINAL_WINDOW[0] + 0.02, FINAL_WINDOW[1] + 0.04));
}

/** Stream half-width at `u`: wide inflow, a gentle pinch at every gate, a point at the end. */
function halfBandAt(u: number) {
  if (u <= GATES[0]) return lerp(INFLOW_SPREAD, HALF_BAND[0], easeOut(clamp01((u + 0.06) / (GATES[0] + 0.06))));
  if (u >= GATES[4]) return lerp(HALF_BAND[4], 0.004, easeInOut(segment(u, GATES[4], CORE)));
  let k = 0;
  while (u > GATES[k + 1]) k++;
  const t = (u - GATES[k]) / (GATES[k + 1] - GATES[k]);
  const pinch = 1 - 0.18 * (1 - easeOut(clamp01(Math.min(t, 1 - t) * 5)));
  return lerp(HALF_BAND[k], HALF_BAND[k + 1], easeInOut(clamp01(t * 1.6))) * pinch;
}

/* ---- Particle simulation ---------------------------------------------------------------------- */

const FLOW = 0;
const LEAVE = 1;
const BUY = 2;
/** Seconds a leaver takes to peel off down its exit branch. */
const LEAVE_DUR = 2.3;

/** Struct-of-arrays pool: no allocation after creation. */
interface Sim {
  n: number;
  u: Float32Array;
  v: Float32Array;
  lane: Float32Array;
  speed: Float32Array;
  phase: Float32Array;
  life: Float32Array;
  /** Where a leaver left the stream; its branch curve starts here. */
  u0: Float32Array;
  v0: Float32Array;
  fate: Uint8Array;
  state: Uint8Array;
  rand: () => number;
}

function sampleFate(r: () => number) {
  for (let k = 0; k < LEAVE_P.length; k++) if (r() < LEAVE_P[k]) return k;
  return 4;
}

function spawn(s: Sim, i: number, u: number) {
  const r = s.rand;
  const lane = (r() + r() + r() - 1.5) / 1.5;
  s.u[i] = u;
  s.lane[i] = lane;
  s.v[i] = lane * halfBandAt(u);
  s.speed[i] = 0.82 + r() * 0.36;
  s.phase[i] = r() * Math.PI * 2;
  s.life[i] = 1;
  s.fate[i] = sampleFate(r);
  s.state[i] = FLOW;
}

function createSim(n: number): Sim {
  const s: Sim = {
    n,
    u: new Float32Array(n),
    v: new Float32Array(n),
    lane: new Float32Array(n),
    speed: new Float32Array(n),
    phase: new Float32Array(n),
    life: new Float32Array(n),
    u0: new Float32Array(n),
    v0: new Float32Array(n),
    fate: new Uint8Array(n),
    state: new Uint8Array(n),
    rand: seeded(0x51c4),
  };
  // Queue everyone up before the entrance; `prewarm` lets them flow in to a steady state.
  for (let i = 0; i < n; i++) spawn(s, i, -s.rand() * 1.1);
  return s;
}

/** Advance the flow by `dt` seconds; `rate` is flow length per second, `exitV` the branch reach. */
function step(s: Sim, dt: number, rate: number, exitV: number) {
  const ease = Math.min(1, dt * 4);
  for (let i = 0; i < s.n; i++) {
    const st = s.state[i];
    if (st === FLOW) {
      const u = s.u[i] + rate * s.speed[i] * dt;
      s.u[i] = u;
      const fate = s.fate[i];
      // People about to leave drift to the exit side of the stream first, so they peel off its edge.
      const drift = fate < 4 ? easeInOut(segment(u, GATES[fate] - 0.09, GATES[fate])) : 0;
      const lane = lerp(s.lane[i], 0.82, drift);
      s.v[i] += (lane * halfBandAt(u) - s.v[i]) * ease;
      if (fate < 4) {
        if (u >= GATES[fate] + 0.004) {
          s.state[i] = LEAVE;
          s.u0[i] = u;
          s.v0[i] = s.v[i];
          s.life[i] = 1;
        }
      } else if (u >= GATES[4]) {
        s.state[i] = BUY;
      }
    } else if (st === LEAVE) {
      const life = s.life[i] - dt / LEAVE_DUR;
      s.life[i] = life;
      if (life <= 0) {
        spawn(s, i, -0.02 - s.rand() * 0.05);
        continue;
      }
      // Quadratic curve from where they left, bending away from the stream towards the exit;
      // eased out so they slow as they peel away.
      const k = 1 - life;
      const te = 1 - (1 - k) * (1 - k);
      const g = GATES[s.fate[i]];
      const jit = Math.sin(s.phase[i]);
      const p0u = s.u0[i];
      const p0v = s.v0[i];
      const p1u = g + view.exitDu * 0.4;
      const p1v = exitV * 0.45;
      const p2u = g + view.exitDu + jit * 0.012;
      const p2v = exitV * (0.9 + Math.cos(s.phase[i]) * 0.07);
      const a = (1 - te) * (1 - te);
      const b = 2 * (1 - te) * te;
      const c = te * te;
      s.u[i] = a * p0u + b * p1u + c * p2u;
      s.v[i] = a * p0v + b * p1v + c * p2v;
    } else {
      s.u[i] += rate * s.speed[i] * dt * 0.85;
      s.v[i] += (0 - s.v[i]) * Math.min(1, dt * 3);
      if (s.u[i] >= CORE) spawn(s, i, -0.02 - s.rand() * 0.05);
    }
  }
}

function prewarm(s: Sim, rate: number, exitV: number) {
  const dt = 1 / 20;
  const steps = Math.min(1400, Math.ceil(1.25 / rate / dt));
  for (let k = 0; k < steps; k++) step(s, dt, rate, exitV);
}

/* ---- Rendering -------------------------------------------------------------------------------- */

// Sprite indices.
const C_VIOLET = 0;
const C_VIOLET_BRIGHT = 1;
const C_BLUE = 2;
const C_CYAN = 3;
const C_POSITIVE = 4;
const C_WARNING = 5;
const C_NEGATIVE = 6;
const C_MUTED = 7;
const SPRITE_RGB = [RGB.violet, RGB.violetBright, RGB.blue, RGB.cyan, RGB.positive, RGB.warning, RGB.negative, RGB.muted];
/** Colour while flowing, by number of gates passed: the stream warms to green as people buy. */
const FLOW_COLOR = [C_VIOLET, C_VIOLET, C_VIOLET_BRIGHT, C_BLUE, C_CYAN, C_POSITIVE];
/** Colour while leaving, by gate: early browsers fade quietly, checkout exits read as the costly ones. */
const LEAVE_COLOR = [C_MUTED, C_WARNING, C_WARNING, C_NEGATIVE];
/** Exit branch colour, by gate. */
const BRANCH_RGB = [RGB.muted, RGB.warning, RGB.warning, RGB.negative];

interface Sprites {
  dot: HTMLCanvasElement[];
  halo: HTMLCanvasElement[];
}

function makeSprite(rgb: string, stops: [number, number][]) {
  const size = 48;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  if (g) {
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    for (const [at, a] of stops) grad.addColorStop(at, `rgba(${rgb}, ${a})`);
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
  }
  return c;
}

function makeSprites(): Sprites {
  return {
    dot: SPRITE_RGB.map((rgb) => makeSprite(rgb, [[0, 1], [0.18, 0.92], [0.4, 0.28], [1, 0]])),
    halo: SPRITE_RGB.map((rgb) => makeSprite(rgb, [[0, 0.55], [0.4, 0.16], [1, 0]])),
  };
}

/** Per-frame projection state, reused (no allocation per particle). */
const view = { horizontal: true, w: 0, h: 0, L: 0, cf: 0.5, z: 1, zy: 1, ya: 0.5, cx: 0.5, top: 0, span: 1, unit: 1, exitV: EXIT_V, exitDu: EXIT_DU };
const pt = { x: 0, y: 0 };

function project(u: number, v: number) {
  if (view.horizontal) {
    pt.x = view.w * 0.5 + (u - view.cf) * view.L * view.z;
    pt.y = view.ya * view.h + v * view.unit;
  } else {
    pt.x = view.cx * view.w + v * view.unit;
    pt.y = view.h * (view.top + u * view.span);
  }
}

// The ribbon's outline, sampled once: only the projection changes per frame.
const RIBBON_N = 96;
const RIBBON_U0 = -0.06;
const RIBBON_U = new Float32Array(RIBBON_N + 1);
const RIBBON_HALF = new Float32Array(RIBBON_N + 1);
for (let k = 0; k <= RIBBON_N; k++) {
  const u = RIBBON_U0 + ((CORE - RIBBON_U0) * k) / RIBBON_N;
  RIBBON_U[k] = u;
  RIBBON_HALF[k] = halfBandAt(u);
}
/** Ribbon colour along the flow, as gradient stops between RIBBON_U0 and CORE. */
const RIBBON_STOPS: [number, string][] = (
  [
    [RIBBON_U0, RGB.violet, 0],
    [0.04, RGB.violet, 1],
    [GATES[1], RGB.violet, 1],
    [GATES[2], RGB.violetBright, 1],
    [GATES[3], RGB.blue, 1],
    [GATES[4], RGB.cyan, 1],
    [CORE, RGB.positive, 1],
  ] as const
).map(([u, rgb, a]) => [(u - RIBBON_U0) / (CORE - RIBBON_U0), `rgba(${rgb}, ${a})`]);

/** Additive passes that build the luminous band: [width multiplier, alpha]. */
// Many faint steps rather than a few strong ones, so the glow falls off without visible bands.
const RIBBON_PASSES: [number, number][] = [
  [2.3, 0.012],
  [2.05, 0.014],
  [1.82, 0.016],
  [1.62, 0.018],
  [1.44, 0.02],
  [1.28, 0.024],
  [1.12, 0.03],
  [0.94, 0.045],
  [0.7, 0.04],
  [0.46, 0.04],
  [0.24, 0.035],
];

function traceRibbon(ctx: CanvasRenderingContext2D, scale: number) {
  ctx.beginPath();
  for (let k = 0; k <= RIBBON_N; k++) {
    project(RIBBON_U[k], -RIBBON_HALF[k] * scale);
    if (k === 0) ctx.moveTo(pt.x, pt.y);
    else ctx.lineTo(pt.x, pt.y);
  }
  for (let k = RIBBON_N; k >= 0; k--) {
    project(RIBBON_U[k], RIBBON_HALF[k] * scale);
    ctx.lineTo(pt.x, pt.y);
  }
  ctx.closePath();
}

function traceEdge(ctx: CanvasRenderingContext2D, side: number, scale: number) {
  ctx.beginPath();
  for (let k = 0; k <= RIBBON_N; k++) {
    project(RIBBON_U[k], side * RIBBON_HALF[k] * scale);
    if (k === 0) ctx.moveTo(pt.x, pt.y);
    else ctx.lineTo(pt.x, pt.y);
  }
}

const SIDES = [-1, 1] as const;
/** Unfocused labels dim only this far, so their small secondary text stays at lp-muted contrast or better. */
const LABEL_DIM = 0.78;
/** The band's visible edge, as a multiple of the particle half-width. */
const EDGE = 1.18;

/** The luminous stream: a band that narrows gate by gate, coloured violet → green along the way. */
function drawRibbon(ctx: CanvasRenderingContext2D) {
  project(RIBBON_U0, 0);
  const x0 = pt.x;
  const y0 = pt.y;
  project(CORE, 0);
  const grad = ctx.createLinearGradient(x0, y0, pt.x, pt.y);
  for (const [t, c] of RIBBON_STOPS) grad.addColorStop(t, c);
  ctx.fillStyle = grad;
  ctx.strokeStyle = grad;
  for (const [scale, alpha] of RIBBON_PASSES) {
    ctx.globalAlpha = alpha;
    traceRibbon(ctx, scale);
    ctx.fill();
  }
  // Crisp luminous edges give the band a defined shape.
  ctx.globalAlpha = 0.32;
  ctx.lineWidth = 1;
  for (const side of SIDES) {
    traceEdge(ctx, side, EDGE);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/**
 * Exit branches: from each gate, a curve peels off the stream towards its exit marker, weighted by
 * how many people leave there. Discovery's is a quiet grey (people who only browsed).
 */
function drawBranches(ctx: CanvasRenderingContext2D, p: number, frame: JourneyFrame) {
  const { unit, exitV } = view;
  for (let k = 0; k < LEAVE_P.length; k++) {
    const g = GATES[k];
    const e = k === 0 ? 0.55 : 0.5 + 0.5 * exitEmphasis(p, k - 1, frame.world);
    project(g + 0.002, halfBandAt(g) * 0.95);
    const sx = pt.x;
    const sy = pt.y;
    project(g + view.exitDu * 0.4, exitV * 0.45);
    const cx = pt.x;
    const cy = pt.y;
    project(g + view.exitDu, exitV * 0.92);
    const ex = pt.x;
    const ey = pt.y;
    const grad = ctx.createLinearGradient(sx, sy, ex, ey);
    grad.addColorStop(0, `rgba(${BRANCH_RGB[k]}, 1)`);
    grad.addColorStop(1, `rgba(${BRANCH_RGB[k]}, 0)`);
    ctx.strokeStyle = grad;
    ctx.lineCap = "round";
    const weight = Math.max(3, LEAVE_SHARE[k] * unit * 0.16);
    // Wide soft body, then a bright thread down the middle.
    for (const [width, alpha] of [
      [weight, 0.16],
      [Math.max(1.2, weight * 0.18), 0.6],
    ] as const) {
      ctx.globalAlpha = alpha * e;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(cx, cy, ex, ey);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  ctx.lineCap = "butt";
}

function drawGates(ctx: CanvasRenderingContext2D, sprites: Sprites, p: number, frame: JourneyFrame, still: boolean) {
  const { w, h, unit } = view;
  for (let i = 0; i < GATES.length; i++) {
    const focus = still ? 1 : focusAt(p, i, frame.world);
    const exit = EXITS.findIndex((e) => e.gate === i);
    const ex = exit >= 0 ? exitEmphasis(p, exit, frame.world) : 0;
    const edge = halfBandAt(GATES[i]) * EDGE * unit;
    const reach = edge + 0.05 * unit;
    project(GATES[i], 0);
    const { x, y } = pt;
    if (x < -80 || x > w + 80 || y < -80 || y > h + 80) continue;

    // A soft light where the camera is looking.
    if (focus > 0.05 && !still) {
      const r = (view.horizontal ? 260 : 150) * (0.6 + 0.4 * view.zy);
      ctx.globalAlpha = 0.22 * focus * (1 - 0.6 * (frame.world > 1 ? cameraAt(p, frame.world).pull : 1));
      ctx.drawImage(sprites.halo[C_VIOLET], x - r / 2, y - r / 2, r, r);
    }

    // The gate post, tinted by its exit while that exit is in question.
    const tone = exit >= 0 ? (EXITS[exit].tone === "negative" ? RGB.negative : RGB.warning) : RGB.violetBright;
    ctx.globalAlpha = 1;
    ctx.strokeStyle = ex > 0.05 ? `rgba(${tone}, ${0.25 + 0.5 * ex})` : `rgba(255, 255, 255, ${0.1 + 0.18 * focus})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (view.horizontal) {
      ctx.moveTo(x, y - reach);
      ctx.lineTo(x, y + reach);
    } else {
      ctx.moveTo(x - reach, y);
      ctx.lineTo(x + reach, y);
    }
    ctx.stroke();
    // Aperture brackets where the stream squeezes through.
    ctx.fillStyle = `rgba(${RGB.violetBright}, ${0.45 + 0.55 * focus})`;
    for (const side of SIDES) {
      if (view.horizontal) ctx.fillRect(x - 5, y + side * edge - 1, 10, 2);
      else ctx.fillRect(x + side * edge - 1, y - 5, 2, 10);
    }
    // Node on the stream's centre line.
    ctx.fillStyle = `rgba(255, 255, 255, ${0.5 + 0.5 * focus})`;
    ctx.beginPath();
    ctx.arc(x, y, 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawCore(ctx: CanvasRenderingContext2D, sprites: Sprites, time: number) {
  project(CORE, 0);
  const s = view.horizontal ? 0.6 + 0.4 * view.zy : 0.75;
  const breathe = 1 + 0.06 * Math.sin(time * 0.0016);
  const r = 230 * s * breathe;
  ctx.globalAlpha = 0.55;
  ctx.drawImage(sprites.halo[C_POSITIVE], pt.x - r / 2, pt.y - r / 2, r, r);
  ctx.globalAlpha = 1;
  ctx.drawImage(sprites.dot[C_POSITIVE], pt.x - 14 * s, pt.y - 14 * s, 28 * s, 28 * s);
  ctx.strokeStyle = `rgba(${RGB.positive}, 0.6)`;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.arc(pt.x, pt.y, 13 * s, 0, Math.PI * 2);
  ctx.stroke();
}

function drawParticles(ctx: CanvasRenderingContext2D, s: Sim, sprites: Sprites, time: number) {
  const { w, h, horizontal } = view;
  const grow = horizontal ? 0.6 + 0.4 * view.zy : 0.85;
  const along = 16 * grow;
  const across = 7 * grow;
  const wobbleT = time * 0.0018;
  for (let i = 0; i < s.n; i++) {
    const u = s.u[i];
    if (u < -0.05) continue;
    const st = s.state[i];
    const v = s.v[i] + (st === FLOW ? Math.sin(wobbleT + s.phase[i]) * 0.003 : 0);
    project(u, v);
    const x = pt.x;
    const y = pt.y;
    if (x < -20 || x > w + 20 || y < -20 || y > h + 20) continue;

    let alpha: number;
    let color: number;
    let scale = 1;
    if (st === FLOW) {
      alpha = clamp01((u + 0.05) / 0.08);
      let passed = 0;
      while (passed < GATES.length && u >= GATES[passed]) passed++;
      color = FLOW_COLOR[passed];
    } else if (st === LEAVE) {
      const life = s.life[i];
      alpha = Math.min(1, life * 1.7);
      color = LEAVE_COLOR[s.fate[i]];
      scale = 0.7 + 0.3 * life;
    } else {
      alpha = 1 - segment(u, CORE - 0.035, CORE);
      color = C_POSITIVE;
    }
    if (alpha < 0.02) continue;
    const sw = (horizontal ? along : across) * scale;
    const sh = (horizontal ? across : along) * scale;
    ctx.globalAlpha = alpha;
    ctx.drawImage(sprites.dot[color], x - sw / 2, y - sh / 2, sw, sh);
  }
  ctx.globalAlpha = 1;
}

/* ---- Component -------------------------------------------------------------------------------- */

const BASE_PARTICLES = 820;

/**
 * The customer journey: a luminous canvas stream of shoppers flowing through the five funnel
 * gates, narrowing as some leave down an exit branch at each one, with crisp HTML labels projected
 * by the same camera. Horizontal on wide landscape screens (the camera travels a wide world),
 * vertical on phones and portrait tablets (the whole funnel fits). `still` draws a single settled frame for reduced motion.
 */
export function JourneyVisual({
  progress,
  frame,
  still = false,
  // Must establish a containing block (relative/absolute): canvas and labels are absolutely placed.
  className = "relative",
}: {
  progress: MotionValue<number>;
  frame: JourneyFrame;
  still?: boolean;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { particleScale, maxDpr } = useViewportPerformance();
  const count = Math.max(200, Math.round(BASE_PARTICLES * particleScale));
  const simRef = useRef<Sim | null>(null);
  const spritesRef = useRef<Sprites | null>(null);
  // Must agree with which label layer CSS shows (`md:landscape:`).
  const horizontalRef = useRef(true);

  useEffect(() => {
    const mq = window.matchMedia(WIDE_QUERY);
    const sync = () => {
      horizontalRef.current = mq.matches;
      simRef.current = null;
    };
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useCanvasLoop(
    canvasRef,
    (ctx, f: CanvasFrame) => {
      const { width: w, height: h } = f;
      const p = still ? 1 : progress.get();
      const horizontal = horizontalRef.current;
      const cam = horizontal ? cameraAt(p, frame.world) : { cf: 0.5, z: 1, zy: 1, pull: 0 };
      view.horizontal = horizontal;
      view.w = w;
      view.h = h;
      view.L = (horizontal ? frame.world : 1) * w;
      view.cf = cam.cf;
      view.z = cam.z;
      view.zy = cam.zy;
      view.ya = lerp(frame.yc, frame.ycPulled, cam.pull);
      view.cx = frame.cx;
      view.top = frame.top;
      view.span = frame.bottom - frame.top;
      // Vertical: the stream's width follows the screen width, capped so tall tablets keep it slender.
      view.unit = horizontal ? h * cam.zy : Math.min(w, h * 0.5);
      view.exitV = horizontal ? EXIT_V : EXIT_V_VERTICAL;
      view.exitDu = horizontal ? EXIT_DU : EXIT_DU_VERTICAL;

      // Flow speed in journey lengths per second, from a comfortable on-screen pace.
      const length = horizontal ? view.L : view.span * h;
      const rate = (horizontal ? 150 : 64) / Math.max(1, length);

      if (!spritesRef.current) spritesRef.current = makeSprites();
      if (!simRef.current || simRef.current.n !== count) {
        simRef.current = createSim(count);
        prewarm(simRef.current, rate, view.exitV);
      }
      const sim = simRef.current;
      const sprites = spritesRef.current;
      if (!still) step(sim, Math.min(0.05, f.dt / 1000), rate, view.exitV);

      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";
      drawRibbon(ctx);
      drawBranches(ctx, p, frame);
      ctx.globalCompositeOperation = "source-over";
      drawGates(ctx, sprites, p, frame, still);
      ctx.globalCompositeOperation = "lighter";
      drawParticles(ctx, sim, sprites, still ? 0 : f.time);
      drawCore(ctx, sprites, still ? 0 : f.time);
      ctx.globalCompositeOperation = "source-over";
    },
    { still, maxDpr },
  );

  // Labels shrink a little as the camera pulls back, so the whole journey stays uncluttered.
  const labelScale = useTransform(progress, (p) => (frame.world > 1 ? lerp(1, 0.86, cameraAt(p, frame.world).pull) : 1));

  return (
    <div className={className} data-cursor="VIEW">
      <canvas ref={canvasRef} aria-hidden className="absolute inset-0 h-full w-full" />

      {/* Horizontal labels, projected with the camera. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 hidden overflow-hidden md:landscape:block">
        {STAGES.map((s, i) => (
          <StageLabel key={s.name} index={i} progress={progress} frame={frame} scale={labelScale} />
        ))}
        {EXITS.map((e, k) => (
          <ExitMarker key={e.label} index={k} progress={progress} frame={frame} scale={labelScale} />
        ))}
      </div>

      {/* Vertical labels (mobile): the whole funnel is on screen, labels on the left. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 md:landscape:hidden">
        {STAGES.map((s, i) => (
          <MobileStageLabel key={s.name} index={i} progress={progress} frame={frame} />
        ))}
      </div>

      <SrOnly>
        Illustration of a shopping funnel. A stream of shoppers flows through five stages: Discovery (visited the store), Product
        (viewed a product), Cart (added to cart), Checkout (started checkout) and Purchase. At every stage some shoppers leave, so
        the stream gets thinner. The points where they leave are marked: the product page, the cart and checkout.
      </SrOnly>
    </div>
  );
}

/**
 * Screen position of a journey point, as a translate of a full-size layer: percentages of a
 * layer's own size are percentages of the scene, so labels move with transforms only.
 */
function useAnchor(progress: MotionValue<number>, frame: JourneyFrame, u: number, v: number) {
  const x = useTransform(progress, (p) => {
    const { cf, z } = cameraAt(p, frame.world);
    return `${(0.5 + (u - cf) * frame.world * z) * 100}%`;
  });
  const y = useTransform(progress, (p) => {
    const { zy, pull } = cameraAt(p, frame.world);
    return `${(lerp(frame.yc, frame.ycPulled, pull) + v * zy) * 100}%`;
  });
  return { x, y };
}

type LabelProps = { index: number; progress: MotionValue<number>; frame: JourneyFrame; scale: MotionValue<number> };

function StageLabel({ index, progress, frame, scale }: LabelProps) {
  const anchor = useAnchor(progress, frame, GATES[index], LABEL_V);
  const opacity = useTransform(progress, (p) => LABEL_DIM + (1 - LABEL_DIM) * focusAt(p, index, frame.world));
  const stage = STAGES[index];
  const last = index === STAGES.length - 1;
  return (
    <motion.div className="absolute inset-0" style={anchor}>
      <motion.div
        className="absolute left-0 top-0 origin-bottom whitespace-nowrap text-center"
        style={{ x: "-50%", y: "-100%", scale, opacity }}
      >
        <span className={`font-lp-mono text-[11px] tracking-[0.16em] ${last ? "text-lp-positive" : "text-lp-violet-bright"}`}>0{index + 1}</span>
        <span className="mt-1.5 block text-[22px] font-[550] leading-none tracking-[-0.03em] text-lp-text">{stage.name}</span>
        <span className="mt-2 block font-lp-mono text-[10.5px] uppercase tracking-[0.12em] text-lp-text-2">{stage.step}</span>
      </motion.div>
    </motion.div>
  );
}

function ExitMarker({ index, progress, frame, scale }: LabelProps) {
  const exit = EXITS[index];
  const anchor = useAnchor(progress, frame, GATES[exit.gate] + EXIT_DU, EXIT_V);
  const opacity = useTransform(progress, (p) => 0.35 + 0.65 * exitEmphasis(p, index, frame.world));
  const negative = exit.tone === "negative";
  return (
    <motion.div className="absolute inset-0" style={anchor}>
      <motion.div className="absolute left-0 top-0 flex origin-top flex-col items-center whitespace-nowrap" style={{ x: "-50%", scale, opacity }}>
        <span className={`h-5 w-px bg-gradient-to-b ${negative ? "from-lp-negative/60" : "from-lp-warning/60"} to-transparent`} />
        <span
          className={`flex items-center gap-2 rounded-full border px-3 py-1.5 backdrop-blur-[2px] ${negative ? "border-lp-negative/40 bg-lp-negative/[0.12]" : "border-lp-warning/40 bg-lp-warning/[0.12]"}`}
        >
          <span className={`size-1.5 rounded-full ${negative ? "bg-lp-negative" : "bg-lp-warning"}`} />
          <span className="text-[13px] font-medium text-lp-text">{exit.label}</span>
          <span className={`font-lp-mono text-[10px] tracking-[0.14em] ${negative ? "text-lp-negative" : "text-lp-warning"}`}>EXIT</span>
        </span>
      </motion.div>
    </motion.div>
  );
}

function MobileStageLabel({ index, progress, frame }: { index: number; progress: MotionValue<number>; frame: JourneyFrame }) {
  // Without a camera on mobile, focus still follows the questions so the funnel reads in order.
  const focusWorld = frame.world > 1 ? frame.world : 1;
  const opacity = useTransform(progress, (p) => LABEL_DIM + (1 - LABEL_DIM) * focusAt(p, index, focusWorld));
  const exitIndex = EXITS.findIndex((e) => e.gate === index);
  const exit = exitIndex >= 0 ? EXITS[exitIndex] : null;
  const exitOpacity = useTransform(progress, (p) => (exitIndex >= 0 ? 0.4 + 0.6 * exitEmphasis(p, exitIndex, focusWorld) : 0));
  const stage = STAGES[index];
  const top = frame.top + GATES[index] * (frame.bottom - frame.top);
  return (
    <div className="absolute left-4 max-w-[46%] -translate-y-1/2 md:left-8" style={{ top: `${top * 100}%` }}>
      <motion.div style={{ opacity }}>
        <div className="flex items-baseline gap-2">
          <span className={`font-lp-mono text-[10px] tracking-[0.14em] ${index === 4 ? "text-lp-positive" : "text-lp-violet-bright"}`}>0{index + 1}</span>
          <span className="text-[17px] font-[550] leading-none tracking-[-0.02em] text-lp-text md:text-[22px]">{stage.name}</span>
        </div>
        <span className="mt-1.5 block pl-[22px] font-lp-mono text-[9.5px] uppercase tracking-[0.1em] text-lp-text-2 md:text-[10.5px]">{stage.step}</span>
      </motion.div>
      {exit && (
        <motion.span
          style={{ opacity: exitOpacity }}
          className={`ml-[22px] mt-2 inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-[3px] text-[11.5px] text-lp-text ${exit.tone === "negative" ? "border-lp-negative/35 bg-lp-negative/10" : "border-lp-warning/35 bg-lp-warning/10"}`}
        >
          <span className={`size-1.5 rounded-full ${exit.tone === "negative" ? "bg-lp-negative" : "bg-lp-warning"}`} />
          {exit.label}
          <span className={`font-lp-mono text-[9px] tracking-[0.12em] ${exit.tone === "negative" ? "text-lp-negative" : "text-lp-warning"}`}>EXIT</span>
        </motion.span>
      )}
    </div>
  );
}
