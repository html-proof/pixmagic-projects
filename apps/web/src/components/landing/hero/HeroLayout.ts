/**
 * Shared geometry and timing for the hero. The canvas (DataParticles), the DOM core
 * (IntelligenceCore), the flow diagrams (HeroFlows) and the dashboard cards (HeroDashboardReveal)
 * all read these numbers, so particles orbit exactly where the rings are drawn, flows branch from
 * the sphere's edge and cards grow out of the point where the core shrinks to.
 *
 * Positions inside the visual "box" are percentages of the box (0–100), so they hold at every
 * size; the box keeps a fixed aspect ratio per layout (wide ≥1024px: text left, visual right;
 * stacked below that: text on top, visual underneath).
 */
import { clamp01, easeInOut, easeOut, lerp, segment } from "@/lib/motion";

/** Matches Tailwind's `lg` breakpoint, where the hero switches to the side-by-side layout. */
export const WIDE_QUERY = "(min-width: 64rem)";

/** Design units of the visual box per layout; the DOM box uses the same aspect ratio. */
export const BOX = {
  wide: { w: 1000, h: 760 },
  stacked: { w: 360, h: 440 },
} as const;

/** Sphere radius as a fraction of the box width, at scale 1 (the wide stage-2 size). */
export const CORE_R = 0.085;
/** The core element spans ±CORE_EXTENT sphere radii (outer ring, glow) around its centre. */
export const CORE_EXTENT = 3.2;
/** The open outer ring, echoing the Insight mark, in sphere radii. */
export const OUTER_RING_R = 2.95;

/**
 * Orbital rings, in sphere radii: `squash` is the ellipse's minor/major ratio, `tilt` its angle in
 * degrees, `period` seconds per revolution of the point riding it. Particles in the canvas that
 * settle on ring `i` use exactly this ellipse.
 */
export const RINGS = [
  { r: 1.55, squash: 0.32, tilt: -10, period: 38 },
  { r: 1.98, squash: 0.38, tilt: 14, period: 52 },
  { r: 2.45, squash: 0.26, tilt: -24, period: 70 },
] as const;

/** Dashboard card slots in box percentages. Identical in both layouts (health on top, 2×2 below). */
export const SLOTS = {
  health: { x: 3, y: 12, w: 94, h: 21 },
  sales: { x: 3, y: 35.5, w: 46, h: 28.5 },
  conversion: { x: 51, y: 35.5, w: 46, h: 28.5 },
  customers: { x: 3, y: 66, w: 46, h: 28.5 },
  products: { x: 51, y: 66, w: 46, h: 28.5 },
} as const;
export type SlotId = keyof typeof SLOTS;

/** The Business health card's emblem: horizontal centre and diameter as % of the card's width. */
export const ORB = { x: 7, size: 5.4 } as const;
/** Where the core lands (box %) when it becomes that emblem. */
export const ORB_POINT = {
  x: SLOTS.health.x + (SLOTS.health.w * ORB.x) / 100,
  y: SLOTS.health.y + SLOTS.health.h / 2,
} as const;

/** Absolute core scale per moment (1 = sphere of 2·CORE_R box widths). */
const SCALE_CONVERGE = { wide: 1, stacked: 1.76 } as const;
const SCALE_CONNECT = { wide: 0.62, stacked: 0.62 } as const;
/** Chosen so the shrunken sphere is exactly the size of the emblem drawn inside the health card. */
const SCALE_ORB = ((ORB.size / 100) * (SLOTS.health.w / 100)) / (2 * CORE_R);

const POS_CONVERGE = { x: 50, y: 50 } as const;
const POS_CONNECT = { wide: { x: 11, y: 50 }, stacked: { x: 50, y: 10 } } as const;

/** Core travel into the flow hub (stage 3) and into the health card (stage 4). */
const toConnect = (p: number) => easeInOut(segment(p, 0.38, 0.44));
const toOrb = (p: number) => easeInOut(segment(p, 0.6, 0.68));

/** Core centre, x as box %. */
export function coreX(p: number, wide: boolean) {
  const c = POS_CONNECT[wide ? "wide" : "stacked"];
  return lerp(lerp(POS_CONVERGE.x, c.x, toConnect(p)), ORB_POINT.x, toOrb(p));
}
/** Core centre, y as box %. */
export function coreY(p: number, wide: boolean) {
  const c = POS_CONNECT[wide ? "wide" : "stacked"];
  return lerp(lerp(POS_CONVERGE.y, c.y, toConnect(p)), ORB_POINT.y, toOrb(p));
}
/** Core scale (relative to the wide stage-2 sphere). */
export function coreScale(p: number, wide: boolean) {
  const k = wide ? "wide" : "stacked";
  const appear = lerp(0.35, 1, easeOut(segment(p, 0.17, 0.3)));
  return lerp(lerp(SCALE_CONVERGE[k] * appear, SCALE_CONNECT[k], toConnect(p)), SCALE_ORB, toOrb(p));
}
/** Sphere opacity: appears with stage 2, hands over to the health card's emblem in stage 4. */
export const coreOpacity = (p: number) => segment(p, 0.17, 0.27) * (1 - segment(p, EMBLEM_IN[0] + 0.004, EMBLEM_IN[1] + 0.006));
/**
 * The health card's own emblem fades in over the core's last stretch, once both are the same
 * size and in the same place (the core arrives at p 0.68), so there is never a second sphere.
 */
export const EMBLEM_IN = [0.668, 0.69] as const;
/** Ring opacity: rings arrive after the sphere and collapse first when the dashboard forms. */
export const ringOpacity = (p: number) => segment(p, 0.2, 0.32) * (1 - segment(p, 0.6, 0.645));
/** Energy level of the core, rising as the points arrive. */
export const coreGlow = (p: number) => segment(p, 0.2, 0.37);

/* ---- Flows (stage 3) --------------------------------------------------------------------- */

export interface FlowDef {
  id: string;
  title: string;
  steps: readonly string[];
  /** Operators drawn between steps (net sales arithmetic). */
  ops?: readonly string[];
}

/**
 * The three relationships Insight actually builds: the shopping funnel it reports, how a channel
 * turns into new and returning customers, and the net sales arithmetic on the dashboard.
 */
export const FLOWS: readonly FlowDef[] = [
  { id: "journey", title: "Shopping journey", steps: ["Product viewed", "Added to cart", "Checkout started", "Purchase", "Order"] },
  { id: "customers", title: "Customer path", steps: ["Channel", "Visitor", "Customer", "Repeat purchase"] },
  { id: "net", title: "Net sales", steps: ["Gross sales", "Discounts", "Refunds", "Net sales"], ops: ["−", "−", "="] },
];

export interface FlowGeometry {
  /** SVG path in box units. */
  d: string;
  /** Node centres in box units. */
  nodes: { x: number; y: number }[];
  /** Where along the path (0..1 of its length) each node sits, for activation timing. */
  at: number[];
}

/** Wide layout: three rows radiating from the core at its stage-3 position. */
const WIDE_FLOW = { rows: [170, 380, 590], x0: 340, x1: 925, angles: [-38, 0, 38] } as const;

function bezierLength(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) {
  let len = 0;
  let px = x0;
  let py = y0;
  for (let i = 1; i <= 40; i++) {
    const t = i / 40;
    const u = 1 - t;
    const x = u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3;
    const y = u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3;
    len += Math.hypot(x - px, y - py);
    px = x;
    py = y;
  }
  return len;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export const WIDE_FLOWS: FlowGeometry[] = FLOWS.map((flow, k) => {
  const { w, h } = BOX.wide;
  const cx = (POS_CONNECT.wide.x / 100) * w;
  const cy = (POS_CONNECT.wide.y / 100) * h;
  const radius = CORE_R * w * SCALE_CONNECT.wide * 1.04;
  const a = (WIDE_FLOW.angles[k] * Math.PI) / 180;
  const sx = cx + Math.cos(a) * radius;
  const sy = cy + Math.sin(a) * radius;
  const row = WIDE_FLOW.rows[k];
  const { x0, x1 } = WIDE_FLOW;
  const c1x = sx + 80;
  const c1y = sy + (row - sy) * 0.15;
  const c2x = x0 - 120;
  const bez = bezierLength(sx, sy, c1x, c1y, c2x, row, x0, row);
  const total = bez + (x1 - x0);
  const n = flow.steps.length;
  const nodes = flow.steps.map((_, j) => ({ x: lerp(x0, x1, j / (n - 1)), y: row }));
  return {
    d: `M ${r2(sx)} ${r2(sy)} C ${r2(c1x)} ${r2(c1y)} ${c2x} ${row} ${x0} ${row} L ${x1} ${row}`,
    nodes,
    at: nodes.map((p) => (bez + (p.x - x0)) / total),
  };
});

/** Stacked layout: one vertical spine under the core, one flow at a time. */
const STACKED_FLOW = { x: 180, top: 112, bottom: 404 } as const;

export const STACKED_FLOWS: FlowGeometry[] = FLOWS.map((flow) => {
  const { w, h } = BOX.stacked;
  const cy = (POS_CONNECT.stacked.y / 100) * h;
  const start = cy + CORE_R * w * SCALE_CONNECT.stacked * 1.15;
  const n = flow.steps.length;
  const nodes = flow.steps.map((_, j) => ({ x: STACKED_FLOW.x, y: lerp(STACKED_FLOW.top, STACKED_FLOW.bottom, j / (n - 1)) }));
  const total = STACKED_FLOW.bottom - start;
  return {
    d: `M ${STACKED_FLOW.x} ${r2(start)} L ${STACKED_FLOW.x} ${STACKED_FLOW.bottom}`,
    nodes,
    at: nodes.map((p) => (p.y - start) / total),
  };
});

/** How far flow `k` has drawn (0..1) in the wide constellation, where all three build in turn. */
export const wideFlowDraw = (p: number, k: number) => segment(segment(p, 0.38, 0.6), 0.2 + k * 0.15, 0.56 + k * 0.15);

/** Stacked: each flow owns a third of stage 3 (after the core has moved): fade in, draw, hand over. */
export function stackedFlowWindow(p: number, k: number) {
  const s = segment(p, 0.38, 0.6);
  return segment(s, 0.2 + k * 0.265, 0.2 + (k + 1) * 0.265);
}
export const stackedFlowDraw = (p: number, k: number) => segment(stackedFlowWindow(p, k), 0.08, 0.7);
export function stackedFlowOpacity(p: number, k: number) {
  const u = stackedFlowWindow(p, k);
  const out = k < FLOWS.length - 1 ? 1 - segment(u, 0.86, 1) : 1;
  return segment(u, 0, 0.12) * out * flowsExit(p);
}

/** Whole-diagram fade: in after the core reaches the hub, out as the dashboard starts forming. */
export const flowsEnter = (p: number) => segment(p, 0.42, 0.445);
export const flowsExit = (p: number) => 1 - segment(p, 0.595, 0.628);

/**
 * A node lights up as the drawn line reaches it, fully lit at the moment of arrival. (Lighting
 * after arrival would leave the last node, which sits at `at = 1`, permanently half-lit.)
 */
export const nodeActive = (draw: number, at: number) => clamp01((draw - at) / 0.06 + 1);
