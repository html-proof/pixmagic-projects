"use client";
import { motion, useMotionTemplate, useTransform, type MotionValue } from "motion/react";
import {
  Activity,
  Bell,
  Boxes,
  CalendarDays,
  ChartLine,
  ChevronDown,
  CircleDollarSign,
  Funnel,
  LayoutDashboard,
  Package,
  Percent,
  Search,
  Settings,
  ShoppingBag,
  Store,
  Truck,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useId, type ReactNode } from "react";
import { easeInOut, easeOut, seeded, segment } from "@/lib/motion";
import { BrandMark } from "@/components/Brand";

/**
 * The illustrative bizinsights application window used by the product reveal. It only shows
 * structure (areas, panels, empty values, skeleton bars, abstract shapes), never figures, so
 * nobody mistakes it for their own store. Every part is driven by one 0..1 `progress` value so
 * the scene can play it from scroll, from a timer (mobile) or show it finished (reduced motion).
 */

type Range = readonly [number, number];

/** When each part of the window assembles, as windows of the scene's progress (0..1). */
export const REVEAL_STAGES = {
  sidebar: [0.02, 0.14],
  topbar: [0.1, 0.22],
  greeting: [0.16, 0.26],
  kpis: [0.22, 0.36],
  chart: [0.32, 0.5],
  customers: [0.46, 0.58],
  funnel: [0.54, 0.68],
  activity: [0.6, 0.72],
  health: [0.66, 0.78],
  settle: [0.74, 0.97],
} as const satisfies Record<string, Range>;

const S = REVEAL_STAGES;

/** Eased 0..1 for one stage. Never re-renders React. */
function useStage(p: MotionValue<number>, [a, b]: Range, ease: (t: number) => number = easeOut) {
  return useTransform(p, (v) => ease(segment(v, a, b)));
}

/**
 * A block that fades in (and slides from x/y) while its stage plays. Each is its own layer: some
 * stage is always playing while the window builds, and the fades would otherwise repaint the
 * whole window on every scroll frame.
 */
function Reveal({
  p,
  range,
  x = 0,
  y = 10,
  className,
  children,
}: {
  p: MotionValue<number>;
  range: Range;
  x?: number;
  y?: number;
  className?: string;
  children?: ReactNode;
}) {
  const s = useStage(p, range);
  const tx = useTransform(s, (k) => (1 - k) * x);
  const ty = useTransform(s, (k) => (1 - k) * y);
  return (
    <motion.div className={`lp-layer ${className ?? ""}`} style={{ opacity: s, x: tx, y: ty }}>
      {children}
    </motion.div>
  );
}

/** Offset a stage window by `i` steps, for staggered rows inside one stage. */
const stagger = ([a, b]: Range, i: number, step: number): Range => [a + i * step, b + i * step];

/** Grey placeholder text line. */
function Skeleton({ className = "" }: { className?: string }) {
  const fill = className.includes("bg-") ? "" : "bg-white/[0.07]";
  return <span aria-hidden className={`block h-1.5 rounded-full ${fill} ${className}`} />;
}

/** Shared panel surface inside the window. */
function Panel({ title, icon: Icon, aside, className = "", children }: { title: string; icon: LucideIcon; aside?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <div className={`flex min-h-0 flex-col overflow-hidden rounded-[14px] border border-lp-line bg-lp-elevated/80 p-3 xl:p-3.5 md:[@media(max-height:700px)]:p-2.5! ${className}`}>
      <div className="mb-2 flex shrink-0 items-center justify-between gap-2 md:[@media(max-height:700px)]:mb-1.5!">
        <span className="flex items-center gap-2 text-[12px] font-medium text-lp-text-2 xl:text-[12.5px]">
          <Icon aria-hidden className="size-3.5 text-lp-muted" strokeWidth={1.8} />
          {title}
        </span>
        {aside}
      </div>
      <div className="relative min-h-0 flex-1">{children}</div>
    </div>
  );
}

// ---- Sidebar & navigation ---------------------------------------------------------------

const NAV: { label: string; icon: LucideIcon }[] = [
  { label: "Overview", icon: LayoutDashboard },
  { label: "Sales", icon: CircleDollarSign },
  { label: "Orders", icon: ShoppingBag },
  { label: "Customers", icon: Users },
  { label: "Funnel", icon: Funnel },
  { label: "Products", icon: Package },
  { label: "Inventory", icon: Boxes },
  { label: "Fulfillment", icon: Truck },
];

function Sidebar({ p }: { p: MotionValue<number> }) {
  return (
    <Reveal
      p={p}
      range={S.sidebar}
      x={-28}
      y={0}
      className="hidden w-[60px] shrink-0 flex-col border-r border-lp-line bg-[#0A0D11] px-2 py-3 md:flex lg:w-[184px] lg:px-3 xl:w-[204px]"
    >
      <p className="mb-2 hidden px-2.5 font-lp-mono text-[9.5px] uppercase tracking-[0.18em] text-lp-muted lg:block">Workspace</p>
      <ul className="flex flex-col gap-0.5">
        {NAV.map(({ label, icon: Icon }, i) => (
          <li key={label}>
            <Reveal
              p={p}
              range={stagger([S.sidebar[0] + 0.02, S.sidebar[0] + 0.09], i, 0.007)}
              x={-10}
              y={0}
              className={`relative flex h-8 items-center justify-center gap-2.5 rounded-[9px] px-2.5 text-[12.5px] lg:justify-start ${
                i === 0 ? "bg-lp-violet/[0.12] text-lp-text" : "text-lp-muted"
              }`}
            >
              {i === 0 && <span aria-hidden className="absolute -left-2 top-1.5 bottom-1.5 w-[2px] rounded-full bg-lp-violet-bright lg:-left-3" />}
              <Icon aria-hidden className={`size-[15px] shrink-0 ${i === 0 ? "text-lp-violet-bright" : ""}`} strokeWidth={1.8} />
              <span className="hidden lg:inline">{label}</span>
            </Reveal>
          </li>
        ))}
      </ul>
      <div className="mt-auto border-t border-lp-line pt-2">
        {/* Connection state: webhooks keep the store in sync, so this is a true thing to show. */}
        <Reveal
          p={p}
          range={stagger(S.sidebar, 1, 0.03)}
          x={-10}
          y={0}
          className="mb-2 hidden rounded-[10px] border border-lp-line bg-white/[0.02] px-2.5 py-2 lg:block [@media(max-height:760px)]:hidden"
        >
          <span className="flex items-center gap-2 text-[11.5px] text-lp-text-2">
            <span aria-hidden className="size-1.5 rounded-full bg-lp-positive shadow-[0_0_8px_rgb(88_211_155/0.7)]" />
            Shopify connected
          </span>
          <span className="mt-1.5 flex gap-1.5 pl-3.5">
            <Skeleton className="w-14 bg-white/[0.05]" />
            <Skeleton className="w-8 bg-white/[0.05]" />
          </span>
        </Reveal>
        <Reveal p={p} range={stagger(S.sidebar, 1, 0.04)} x={-10} y={0} className="flex h-8 items-center justify-center gap-2.5 rounded-[9px] px-2.5 text-[12.5px] text-lp-muted lg:justify-start">
          <Settings aria-hidden className="size-[15px] shrink-0" strokeWidth={1.8} />
          <span className="hidden lg:inline">Settings</span>
        </Reveal>
      </div>
    </Reveal>
  );
}

/** Phones: the sidebar folds into a tab strip under the top bar. */
function TabStrip({ p }: { p: MotionValue<number> }) {
  return (
    <Reveal
      p={p}
      range={S.sidebar}
      x={0}
      y={-6}
      className="flex shrink-0 gap-1 overflow-hidden border-b border-lp-line px-3 py-2 [mask-image:linear-gradient(90deg,#000_80%,transparent)] md:hidden"
    >
      {NAV.map(({ label, icon: Icon }, i) => (
        <span
          key={label}
          className={`flex h-7 shrink-0 items-center gap-1.5 rounded-[8px] px-2.5 text-[11.5px] ${i === 0 ? "bg-lp-violet/[0.14] text-lp-text" : "text-lp-muted"}`}
        >
          <Icon aria-hidden className={`size-3.5 ${i === 0 ? "text-lp-violet-bright" : ""}`} strokeWidth={1.8} />
          {label}
        </span>
      ))}
    </Reveal>
  );
}

function TopBar({ p }: { p: MotionValue<number> }) {
  return (
    <Reveal p={p} range={S.topbar} x={0} y={-12} className="flex h-12 shrink-0 items-center gap-3 border-b border-lp-line bg-[#0A0D11]/80 px-3 md:h-[52px] md:px-4 md:[@media(max-height:700px)]:h-11!">
      <span className="flex items-center gap-2 text-lp-text">
        <BrandMark size={20} />
        <span className="hidden text-[12.5px] font-semibold tracking-[-0.01em] sm:inline">bizinsights</span>
      </span>
      <span aria-hidden className="h-5 w-px bg-lp-line-strong" />
      <span className="flex h-8 items-center gap-2 rounded-[9px] border border-lp-line bg-white/[0.02] pl-2.5 pr-2 text-[12px] text-lp-text-2">
        <Store aria-hidden className="size-3.5 text-lp-muted" strokeWidth={1.8} />
        Store
        <ChevronDown aria-hidden className="size-3.5 text-lp-muted" strokeWidth={1.8} />
      </span>
      <span className="mx-auto hidden h-8 w-full max-w-[340px] items-center gap-2 rounded-[9px] border border-lp-line bg-white/[0.02] px-3 text-[12px] text-lp-muted md:flex">
        <Search aria-hidden className="size-3.5" strokeWidth={1.8} />
        Search
        <span className="ml-auto rounded-[5px] border border-lp-line px-1.5 font-lp-mono text-[10px]">/</span>
      </span>
      <span className="ml-auto flex items-center gap-2.5 md:ml-0">
        <Bell aria-hidden className="size-4 text-lp-muted" strokeWidth={1.8} />
        <span aria-hidden className="relative size-7 rounded-full p-[1.5px]" style={{ background: "var(--lp-gradient)" }}>
          <span className="block size-full rounded-full bg-lp-surface" />
        </span>
      </span>
    </Reveal>
  );
}

// ---- KPIs ----------------------------------------------------------------------------------

const KPIS: { label: string; icon: LucideIcon; seed: number }[] = [
  { label: "Sales", icon: CircleDollarSign, seed: 3 },
  { label: "Orders", icon: ShoppingBag, seed: 8 },
  { label: "Conversion", icon: Percent, seed: 21 },
  { label: "Net sales", icon: ChartLine, seed: 34 },
];

const SPARK_W = 64;
const SPARK_H = 22;

/** Abstract trend shapes for the KPI tiles: shape only, no scale, so they claim nothing. */
const SPARKS: Record<number, string> = Object.fromEntries(
  KPIS.map(({ seed }) => {
    const rnd = seeded(seed);
    const n = 9;
    const pts = Array.from({ length: n }, (_, i) => {
      const t = i / (n - 1);
      const y = 0.72 - t * 0.38 + (rnd() - 0.5) * 0.34;
      return `${(t * SPARK_W).toFixed(1)} ${(Math.min(0.92, Math.max(0.08, y)) * SPARK_H).toFixed(1)}`;
    });
    return [seed, `M ${pts.join(" L ")}`];
  }),
);

function Sparkline({ p, i, seed }: { p: MotionValue<number>; i: number; seed: number }) {
  const draw = useStage(p, stagger([S.kpis[0] + 0.04, S.kpis[0] + 0.12], i, 0.02), easeInOut);
  return (
    <svg aria-hidden viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} className="h-[22px] w-[64px] shrink-0 overflow-visible">
      <motion.path
        d={SPARKS[seed]}
        fill="none"
        stroke="#5EA6FF"
        strokeOpacity="0.7"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ pathLength: draw }}
      />
    </svg>
  );
}

function Kpis({ p }: { p: MotionValue<number> }) {
  return (
    <div className="grid shrink-0 grid-cols-2 gap-2 md:grid-cols-4 md:gap-3 md:[@media(max-height:700px)]:gap-2!">
      {KPIS.map(({ label, icon: Icon, seed }, i) => (
        <Reveal
          key={label}
          p={p}
          range={stagger([S.kpis[0], S.kpis[0] + 0.08], i, 0.02)}
          y={14}
          className="rounded-[14px] border border-lp-line bg-lp-elevated/80 px-3 py-2.5 xl:px-3.5 xl:py-3 md:[@media(max-height:700px)]:py-2!"
        >
          <span className="flex items-center justify-between text-[11.5px] text-lp-muted">
            {label}
            <Icon aria-hidden className="size-3.5" strokeWidth={1.8} />
          </span>
          <span className="mt-1 flex items-end justify-between gap-2">
            <span className="font-lp-mono text-[20px] leading-tight text-lp-text-2 xl:text-[22px]">—</span>
            <Sparkline p={p} i={i} seed={seed} />
          </span>
          <span className="mt-1.5 flex items-center gap-2 md:[@media(max-height:820px)]:hidden">
            <Skeleton className="w-10" />
            <Skeleton className="w-6 bg-white/[0.045]" />
          </span>
        </Reveal>
      ))}
    </div>
  );
}

// ---- Sales chart ---------------------------------------------------------------------------

const CHART_W = 600;
const CHART_H = 200;
const CHART_POINTS = 22;

/** Abstract rising line, as fractions of the chart height. */
const CURRENT_Y: number[] = (() => {
  const rnd = seeded(41);
  return Array.from({ length: CHART_POINTS }, (_, i) => {
    const t = i / (CHART_POINTS - 1);
    const trend = 0.74 - t * 0.44;
    const wave = Math.sin(t * Math.PI * 5.2) * 0.06;
    return Math.min(0.9, Math.max(0.1, trend + wave + (rnd() - 0.5) * 0.08));
  });
})();

/** Catmull-Rom control points for segment i (uniform spacing, so x is linear in t). */
function controls(ys: number[], i: number) {
  const n = ys.length;
  const y0 = ys[Math.max(0, i - 1)];
  const y1 = ys[i];
  const y2 = ys[Math.min(n - 1, i + 1)];
  const y3 = ys[Math.min(n - 1, i + 2)];
  return [y1, y1 + (y2 - y0) / 6, y2 - (y3 - y1) / 6, y2] as const;
}

function smoothPath(ys: number[]) {
  const dx = CHART_W / (ys.length - 1);
  let d = `M 0 ${(ys[0] * CHART_H).toFixed(2)}`;
  for (let i = 0; i < ys.length - 1; i++) {
    const [, c1, c2, e] = controls(ys, i);
    const x = i * dx;
    d += ` C ${(x + dx / 3).toFixed(2)} ${(c1 * CHART_H).toFixed(2)} ${(x + (2 * dx) / 3).toFixed(2)} ${(c2 * CHART_H).toFixed(2)} ${(x + dx).toFixed(2)} ${(e * CHART_H).toFixed(2)}`;
  }
  return d;
}

/** Height fraction of the current line at horizontal fraction `t`, for the drawing tip. */
function currentYAt(t: number) {
  const f = Math.min(0.99999, Math.max(0, t)) * (CHART_POINTS - 1);
  const i = Math.floor(f);
  const u = f - i;
  const [a, b, c, d] = controls(CURRENT_Y, i);
  const m = 1 - u;
  return m * m * m * a + 3 * m * m * u * b + 3 * m * u * u * c + u * u * u * d;
}

const CURRENT_PATH = smoothPath(CURRENT_Y);
const AREA_PATH = `${CURRENT_PATH} L ${CHART_W} ${CHART_H} L 0 ${CHART_H} Z`;

function SalesChart({ p }: { p: MotionValue<number> }) {
  const uid = useId().replace(/:/g, "");
  const draw = useStage(p, [S.chart[0] + 0.03, S.chart[1]], easeInOut);
  const hidden = useTransform(draw, (d) => (1 - d) * 100);
  const clip = useMotionTemplate`inset(-10px ${hidden}% -10px 0)`;
  const tipX = useTransform(draw, (d) => `${d * 100}%`);
  const tipY = useTransform(draw, (d) => `${currentYAt(d) * 100}%`);
  const tipOpacity = useTransform(draw, [0, 0.03], [0, 1]);

  return (
    <Panel
      title="Sales over time"
      icon={ChartLine}
      aside={
        <span className="flex items-center gap-3 text-[10.5px] text-lp-muted">
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="h-[2px] w-3 rounded-full" style={{ background: "var(--lp-gradient)" }} />
            This period
          </span>
        </span>
      }
      className="h-[170px] flex-1 md:h-auto"
    >
      <div aria-hidden className="absolute inset-0 flex flex-col justify-between py-1">
        {[0, 1, 2, 3].map((k) => (
          <span key={k} className="border-t border-dashed border-white/[0.05]" />
        ))}
      </div>
      <motion.div className="lp-layer absolute inset-0" style={{ clipPath: clip }}>
        <svg aria-hidden viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible">
          <defs>
            <linearGradient id={`pr-line-${uid}`} x1="0" x2="1" y1="0" y2="0">
              <stop offset="0%" stopColor="#8C7BFF" />
              <stop offset="60%" stopColor="#5EA6FF" />
              <stop offset="100%" stopColor="#65D8D0" />
            </linearGradient>
            <linearGradient id={`pr-area-${uid}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#8C7BFF" stopOpacity="0.22" />
              <stop offset="100%" stopColor="#8C7BFF" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={AREA_PATH} fill={`url(#pr-area-${uid})`} />
          <path d={CURRENT_PATH} fill="none" stroke={`url(#pr-line-${uid})`} strokeWidth="2" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </svg>
      </motion.div>
      {/* The drawing tip: a full-size layer translated by fractions of its own size. */}
      <motion.div aria-hidden className="lp-layer pointer-events-none absolute inset-0" style={{ x: tipX, y: tipY, opacity: tipOpacity }}>
        <span className="absolute -left-[9px] -top-[9px] size-[18px] rounded-full bg-lp-cyan/20" />
        <span className="absolute -left-[3.5px] -top-[3.5px] size-[7px] rounded-full bg-lp-text shadow-[0_0_12px_rgb(101_216_208/0.8)]" />
      </motion.div>
    </Panel>
  );
}

// ---- Business health -----------------------------------------------------------------------

const HEALTH: { label: string; tone: string; width: string }[] = [
  { label: "Sales", tone: "bg-lp-positive", width: "w-[62%]" },
  { label: "Refunds", tone: "bg-lp-text-2/60", width: "w-[48%]" },
  { label: "Inventory", tone: "bg-lp-warning", width: "w-[70%]" },
  { label: "Fulfillment", tone: "bg-lp-positive", width: "w-[54%]" },
];

function BusinessHealth({ p }: { p: MotionValue<number> }) {
  const bar = useStage(p, [S.health[0] + 0.03, S.health[1] + 0.02], easeInOut);
  return (
    <Reveal p={p} range={S.health} y={14} className="flex min-h-0 w-full min-w-0 flex-1">
      <Panel
        title="Business health"
        icon={Activity}
        className="flex-1"
      >
        <div className="flex h-full flex-col gap-2">
          <div aria-hidden className="flex h-1.5 shrink-0 gap-1 overflow-hidden rounded-full">
            <motion.span className="lp-layer h-full flex-[5] origin-left rounded-full bg-lp-positive/80" style={{ scaleX: bar }} />
            <motion.span className="lp-layer h-full flex-[2] origin-left rounded-full bg-lp-warning/80" style={{ scaleX: bar }} />
            <motion.span className="lp-layer h-full flex-[3] origin-left rounded-full bg-white/10" style={{ scaleX: bar }} />
          </div>
          <ul className="flex min-h-0 flex-1 flex-col justify-around">
            {HEALTH.map((row, i) => (
              <li key={row.label}>
                <Reveal p={p} range={stagger([S.health[0] + 0.03, S.health[0] + 0.09], i, 0.012)} x={8} y={0} className="flex items-center gap-2.5">
                  <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${row.tone}`} />
                  <span className="w-[68px] shrink-0 text-[11.5px] text-lp-muted xl:w-[76px]">{row.label}</span>
                  <Skeleton className={row.width} />
                </Reveal>
              </li>
            ))}
          </ul>
        </div>
      </Panel>
    </Reveal>
  );
}

// ---- Funnel --------------------------------------------------------------------------------

const FUNNEL: { label: string; width: number }[] = [
  { label: "Visited", width: 1 },
  { label: "Viewed a product", width: 0.66 },
  { label: "Added to cart", width: 0.42 },
  { label: "Started checkout", width: 0.27 },
  { label: "Purchased", width: 0.16 },
];

function FunnelBar({ p, i, width }: { p: MotionValue<number>; i: number; width: number }) {
  const grow = useStage(p, stagger([S.funnel[0] + 0.02, S.funnel[0] + 0.1], i, 0.012), easeInOut);
  return (
    <span className="relative block h-[7px] flex-1 overflow-hidden rounded-full bg-white/[0.04]">
      <motion.span
        className="lp-layer absolute inset-y-0 left-0 origin-left rounded-full"
        style={{
          width: `${width * 100}%`,
          scaleX: grow,
          background: "linear-gradient(90deg, #8C7BFF, #5EA6FF)",
          opacity: 1 - i * 0.13,
        }}
      />
    </span>
  );
}

function FunnelPanel({ p }: { p: MotionValue<number> }) {
  return (
    <Reveal p={p} range={S.funnel} y={14} className="col-span-2 flex min-h-0 md:col-span-6 lg:col-span-5">
      <Panel title="Shopping funnel" icon={Funnel} className="flex-1">
        <ol className="flex h-full flex-col justify-between gap-2.5 md:gap-1">
          {FUNNEL.map((step, i) => (
            <li key={step.label} className="flex items-center gap-3">
              <span className="w-[104px] shrink-0 truncate text-[11px] leading-[13px] text-lp-muted xl:w-[118px] xl:text-[11.5px]">{step.label}</span>
              <FunnelBar p={p} i={i} width={step.width} />
            </li>
          ))}
        </ol>
      </Panel>
    </Reveal>
  );
}

// ---- Customers -----------------------------------------------------------------------------

const RING_R = 30;
const NEW_SHARE = 0.36;
const GAP = 0.025;

function CustomersPanel({ p }: { p: MotionValue<number> }) {
  const draw = useStage(p, [S.customers[0] + 0.02, S.customers[1] + 0.02], easeInOut);
  const newArc = useTransform(draw, (d) => d * (NEW_SHARE - GAP));
  const returningArc = useTransform(draw, (d) => d * (1 - NEW_SHARE - GAP));
  return (
    <Reveal p={p} range={S.customers} y={14} className="col-span-1 flex min-h-0 md:col-span-6 lg:col-span-3">
      <Panel title="Customers" icon={Users} className="flex-1">
        <div className="flex h-full flex-col items-center justify-center gap-2.5 md:flex-row md:gap-3">
          <svg aria-hidden viewBox="0 0 80 80" className="size-[64px] shrink-0 -rotate-90 md:size-[76px] lg:size-[52px] xl:size-[84px]">
            <circle cx="40" cy="40" r={RING_R} fill="none" stroke="rgb(255 255 255 / 0.05)" strokeWidth="7" />
            <motion.circle cx="40" cy="40" r={RING_R} fill="none" stroke="#8C7BFF" strokeWidth="7" style={{ pathLength: newArc }} />
            <g transform={`rotate(${NEW_SHARE * 360} 40 40)`}>
              <motion.circle cx="40" cy="40" r={RING_R} fill="none" stroke="#65D8D0" strokeWidth="7" style={{ pathLength: returningArc }} />
            </g>
          </svg>
          <ul className="flex flex-col gap-2 text-[11.5px] text-lp-muted">
            <li className="flex items-center gap-2">
              <span aria-hidden className="size-2 rounded-full bg-lp-violet" />
              <span className="w-[60px]">New</span>
              <Skeleton className="w-7 lg:max-xl:hidden" />
            </li>
            <li className="flex items-center gap-2">
              <span aria-hidden className="size-2 rounded-full bg-lp-cyan" />
              <span className="w-[60px]">Returning</span>
              <Skeleton className="w-7 lg:max-xl:hidden" />
            </li>
          </ul>
        </div>
      </Panel>
    </Reveal>
  );
}

// ---- Product activity ----------------------------------------------------------------------

/** Mini bar heights per row (fractions), deterministic so server and client agree. */
const ACTIVITY: { name: string; bars: number[] }[] = (() => {
  const rnd = seeded(9);
  const names = ["w-[58%]", "w-[44%]", "w-[66%]", "w-[38%]"];
  return names.map((name) => ({ name, bars: Array.from({ length: 6 }, () => 0.25 + rnd() * 0.75) }));
})();

function ActivityPanel({ p }: { p: MotionValue<number> }) {
  return (
    <Reveal p={p} range={S.activity} y={14} className="hidden min-h-0 lg:col-span-4 lg:flex">
      <Panel title="Product activity" icon={Package} className="flex-1">
        <ul className="flex h-full flex-col justify-between gap-1">
          {ACTIVITY.map((row, i) => (
            <li key={i} className={i === ACTIVITY.length - 1 ? "md:[@media(max-height:820px)]:hidden" : undefined}>
              <Reveal p={p} range={stagger([S.activity[0] + 0.02, S.activity[0] + 0.08], i, 0.012)} x={0} y={6} className="flex items-center gap-2.5">
                <span aria-hidden className="grid size-5 shrink-0 place-items-center rounded-[6px] border border-lp-line bg-lp-surface">
                  <Package className="size-3 text-lp-muted/70" strokeWidth={1.8} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <Skeleton className={row.name} />
                  <Skeleton className="w-[28%] bg-white/[0.045]" />
                </span>
                <span aria-hidden className="flex h-5 items-end gap-[3px]">
                  {row.bars.map((h, k) => (
                    <span key={k} className="w-[3px] rounded-[1px] bg-lp-blue/45" style={{ height: `${h * 100}%` }} />
                  ))}
                </span>
              </Reveal>
            </li>
          ))}
        </ul>
      </Panel>
    </Reveal>
  );
}

// ---- Window --------------------------------------------------------------------------------

/**
 * The full application window. Height comes from the parent on tablet and up (the panels
 * share it with `flex-1`); on phones it grows with its content.
 */
export function ProductRevealWindow({ progress: p }: { progress: MotionValue<number> }) {
  const boot = useTransform(p, [0, S.sidebar[1]], [1, 0]);
  return (
    <div className="relative flex h-full flex-col overflow-hidden rounded-[18px] border border-lp-line-strong bg-lp-bg-2 shadow-[0_50px_140px_-40px_rgb(0_0_0/0.9),0_0_0_1px_rgb(0_0_0/0.4)] md:rounded-[22px]">
      <span aria-hidden className="pointer-events-none absolute inset-x-12 top-0 z-10 h-px bg-gradient-to-r from-transparent via-white/25 to-transparent" />
      {/* Empty-window state before anything has assembled: the mark, waiting. */}
      <motion.div aria-hidden className="lp-layer pointer-events-none absolute inset-0 grid place-items-center text-lp-text" style={{ opacity: boot }}>
        <BrandMark size={44} className="opacity-40" />
      </motion.div>
      <TopBar p={p} />
      <TabStrip p={p} />
      <div className="flex min-h-0 flex-1">
        <Sidebar p={p} />
        <div className="flex min-w-0 flex-1 flex-col gap-2.5 p-3 md:gap-3 md:p-4 xl:p-5 md:[@media(max-height:700px)]:gap-2! md:[@media(max-height:700px)]:p-3!">
          <Reveal p={p} range={S.greeting} y={8} className="flex shrink-0 items-center justify-between gap-3">
            <span>
              <span className="block text-[16px] font-medium tracking-[-0.02em] text-lp-text md:text-[18px] md:[@media(max-height:700px)]:text-[16px]!">Good morning</span>
              <span className="mt-1.5 flex gap-1.5 md:[@media(max-height:820px)]:hidden">
                <Skeleton className="w-24 bg-white/[0.05]" />
                <Skeleton className="w-12 bg-white/[0.05]" />
              </span>
            </span>
            <span className="flex h-8 items-center gap-2 rounded-[9px] border border-lp-line bg-white/[0.02] px-2.5 text-[11.5px] text-lp-muted md:[@media(max-height:700px)]:h-7!">
              <CalendarDays aria-hidden className="size-3.5" strokeWidth={1.8} />
              <Skeleton className="w-12 md:w-16" />
            </span>
          </Reveal>
          <Kpis p={p} />
          <div className="grid min-h-0 grid-cols-1 gap-2.5 md:flex-1 md:grid-cols-12 md:gap-3 md:[@media(max-height:700px)]:gap-2!">
            <Reveal p={p} range={[S.chart[0], S.chart[0] + 0.08]} y={14} className="flex min-h-0 md:col-span-8">
              <SalesChart p={p} />
            </Reveal>
            <div className="hidden min-h-0 md:col-span-4 md:flex">
              <BusinessHealth p={p} />
            </div>
          </div>
          <div className="grid min-h-0 grid-cols-2 gap-2.5 md:flex-1 md:grid-cols-12 md:gap-3 md:[@media(max-height:700px)]:gap-2!">
            <FunnelPanel p={p} />
            <CustomersPanel p={p} />
            {/* Phones: the health panel moves down here, beside customers. */}
            <div className="col-span-1 flex min-h-0 md:hidden">
              <BusinessHealth p={p} />
            </div>
            <ActivityPanel p={p} />
          </div>
        </div>
      </div>
    </div>
  );
}
