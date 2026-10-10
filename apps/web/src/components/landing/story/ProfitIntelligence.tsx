"use client";
import { motion, useMotionValue, useSpring, useTransform, type MotionValue } from "motion/react";
import { useRef, type CSSProperties } from "react";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { useScrollProgress } from "@/hooks/useScrollProgress";
import { easeInOut, easeOut, riseIn, segment } from "@/lib/motion";
import { IllustrativeNote, SectionIntro } from "../shared/ui";

const TITLE_ID = "profit-intelligence-title";

type Source = "shopify" | "yours";

interface Cost {
  name: string;
  source: Source;
  /** Share of the revenue bar. Abstract: sized for legibility, not a real cost structure. */
  w: number;
}

/*
 * Honesty matters more than drama here. Discounts and refunds really are in Shopify's order data
 * (and in the dashboard's net sales). Fees, ad spend, shipping and product costs are not, so they
 * are drawn as dashed "your costs" and the scene never claims they are fetched or that profit is
 * calculated for you.
 */
const COSTS: readonly Cost[] = [
  { name: "Discounts", source: "shopify", w: 0.075 },
  { name: "Refunds", source: "shopify", w: 0.06 },
  { name: "Shopify fees", source: "yours", w: 0.045 },
  { name: "Payment fees", source: "yours", w: 0.05 },
  { name: "App costs", source: "yours", w: 0.04 },
  { name: "Advertising", source: "yours", w: 0.12 },
  { name: "Shipping", source: "yours", w: 0.075 },
  { name: "COGS", source: "yours", w: 0.215 },
];
const STARTS = COSTS.reduce<number[]>((acc, c, i) => [...acc, i === 0 ? 0 : acc[i - 1] + COSTS[i - 1].w], []);
const COSTS_TOTAL = COSTS.reduce((s, c) => s + c.w, 0);
/** Share of the bar one desktop label needs (about 110px at the lg breakpoint). */
const LABEL_SLOT = 0.115;
/**
 * Desktop label centres: each as close to its own slice as the label widths allow, so leaders
 * stay short and nearly vertical instead of fanning across the whole scene.
 */
const LABEL_AT = (() => {
  const at = COSTS.map((c, i) => STARTS[i] + c.w / 2);
  for (let i = 0; i < at.length; i++) at[i] = Math.max(at[i], i === 0 ? LABEL_SLOT / 2 : at[i - 1] + LABEL_SLOT);
  for (let i = at.length - 1; i >= 0; i--) at[i] = Math.min(at[i], i === at.length - 1 ? 1 - LABEL_SLOT / 2 : at[i + 1] - LABEL_SLOT);
  return at;
})();
const PROFIT_W = 1 - COSTS_TOTAL;

const SOURCE_LABEL: Record<Source, string> = { shopify: "From Shopify", yours: "Your costs" };
/** Solid chip for data Shopify provides; dashed outline for costs that live outside it. */
const SOURCE_CHIP: Record<Source, string> = {
  shopify: "border border-lp-violet-bright/45 bg-lp-violet-bright/[0.18]",
  yours: "border border-dashed border-lp-text-2/45 bg-white/[0.02]",
};

/* Choreography, in runway progress: revenue alone, then one cost per slot, then the remainder. */
const CARVE_FROM = 0.1;
const SLOT = 0.0875;
const PROFIT_IN: readonly [number, number] = [0.82, 0.94];

const REVENUE_H = "linear-gradient(90deg, rgba(140,123,255,0.62), rgba(94,166,255,0.5) 58%, rgba(101,216,208,0.46))";
const REVENUE_V = "linear-gradient(180deg, rgba(140,123,255,0.62), rgba(94,166,255,0.5) 58%, rgba(101,216,208,0.46))";
const SHEEN_H = "linear-gradient(180deg, rgba(255,255,255,0.14), rgba(255,255,255,0) 46%)";
const SHEEN_V = "linear-gradient(90deg, rgba(255,255,255,0.12), rgba(255,255,255,0) 46%)";
const PROFIT_H = "linear-gradient(90deg, rgba(88,211,155,0.7), rgba(101,216,208,0.78))";
const PROFIT_V = "linear-gradient(180deg, rgba(88,211,155,0.7), rgba(101,216,208,0.78))";
const GLOW = "radial-gradient(closest-side, rgba(88,211,155,0.2), rgba(101,216,208,0.06) 60%, transparent)";

type Orientation = "h" | "v";

/**
 * One continuous gradient across the whole bar even though it is cut into slices: every slice
 * paints the full-length gradient, offset to its own position.
 */
function sliceFill(start: number, w: number, o: Orientation): CSSProperties {
  const size = 100 / w;
  const pos = w >= 1 ? 0 : (start / (1 - w)) * 100;
  return o === "h"
    ? { backgroundImage: `${SHEEN_H}, ${REVENUE_H}`, backgroundSize: `100% 100%, ${size}% 100%`, backgroundPosition: `0 0, ${pos}% 0` }
    : { backgroundImage: `${SHEEN_V}, ${REVENUE_V}`, backgroundSize: `100% 100%, 100% ${size}%`, backgroundPosition: `0 0, 0 ${pos}%` };
}

/** Per-cost motion: a brief cut line, the slice dropping away, then its label and leader. */
function useCostMotion(progress: MotionValue<number>, k: number) {
  const s = CARVE_FROM + k * SLOT;
  const cut = useTransform(progress, (p) => segment(p, s, s + SLOT * 0.22) * (1 - segment(p, s + SLOT * 0.22, s + SLOT * 0.62)));
  const carve = useTransform(progress, (p) => easeInOut(segment(p, s + SLOT * 0.15, s + SLOT * 0.9)));
  const reveal = useTransform(progress, (p) => easeOut(segment(p, s + SLOT * 0.4, s + SLOT)));
  // Hidden until the slice starts to leave: until then the one-piece bar underneath paints it.
  const fillOpacity = useTransform(carve, (c) => (c > 0.001 ? 1 - c : 0));
  const fillScale = useTransform(carve, (c) => 1 - 0.42 * c);
  const chipOpacity = useTransform(carve, (c) => segment(c, 0.2, 1));
  const labelShift = useTransform(reveal, (r) => (1 - r) * 10);
  return { cut, carve, reveal, fillOpacity, fillScale, chipOpacity, labelShift };
}

/**
 * Where the uncut bar begins: the far edge of every slice that has started to leave. The bar is
 * one element clipped from that edge, so the uncut part never shows seams between slices.
 */
function useUncutClip(progress: MotionValue<number>, o: Orientation) {
  return useTransform(progress, (p) => {
    let edge = 0;
    for (let k = 0; k < COSTS.length; k++) {
      const s = CARVE_FROM + k * SLOT;
      if (easeInOut(segment(p, s + SLOT * 0.15, s + SLOT * 0.9)) > 0.001) edge = STARTS[k] + COSTS[k].w;
    }
    const cut = `${(edge * 100).toFixed(3)}%`;
    return o === "h" ? `inset(0 0 0 ${cut})` : `inset(${cut} 0 0 0)`;
  });
}

/** The revenue bar before any cut: one piece, clipped back as slices leave it. */
function UncutBar({ progress, orientation }: { progress: MotionValue<number>; orientation: Orientation }) {
  const clip = useUncutClip(progress, orientation);
  const h = orientation === "h";
  return (
    <motion.div
      className={`absolute ${h ? "rounded-[18px]" : "rounded-[16px]"}`}
      style={{
        ...(h ? { left: 0, right: 0, top: "var(--ann)", height: "var(--bar)" } : { left: 0, top: 0, height: "100%", width: "var(--bw)" }),
        ...sliceFill(0, 1, orientation),
        clipPath: clip,
      }}
    />
  );
}

/** Shared motion for the ending: the remainder turns into estimated profit. */
function useProfitMotion(progress: MotionValue<number>) {
  const profitIn = useTransform(progress, (p) => easeOut(segment(p, PROFIT_IN[0], PROFIT_IN[1])));
  const profitShift = useTransform(profitIn, (v) => (1 - v) * 10);
  const ghost = useTransform(progress, (p) => segment(p, CARVE_FROM, CARVE_FROM + SLOT));
  const revenueColor = useTransform(progress, [CARVE_FROM, PROFIT_IN[0]], ["#f7f9fc", "#a8b0bc"]);
  const revenueRule = useTransform(progress, [PROFIT_IN[0], PROFIT_IN[1]], [1, 0.35]);
  return { profitIn, profitShift, ghost, revenueColor, revenueRule };
}

/**
 * Section E2. A calmer, darker scene: revenue as one large bar, carved slice by slice by the
 * costs that come out of it, until what remains glows as estimated profit. Every slice says
 * where that number would come from.
 */
export function ProfitIntelligence() {
  const reduced = useReducedMotion();
  const runway = useRef<HTMLDivElement>(null);
  const scroll = useScrollProgress(runway);
  // A soft spring gives the slices a little inertia without lagging behind the scroll.
  const smooth = useSpring(scroll, { stiffness: 140, damping: 32, mass: 0.6, restDelta: 0.0005 });
  const finished = useMotionValue(1);
  const progress = reduced ? finished : smooth;

  return (
    <section aria-labelledby={TITLE_ID} className="relative isolate bg-[#06080A]">
      {/*
        Blend in from the customer scene (lp-bg-2). The way out is owned by the next scene, which
        fades in from this one's darker tone; a second fade here would leave a seam between them.
      */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-56 bg-gradient-to-b from-lp-bg-2 to-transparent" />

      <div className="mx-auto max-w-[1380px] px-4 md:px-8 xl:px-12">
        <div className="pb-6 pt-28 md:pb-10 md:pt-40">
          <SectionIntro
            id={TITLE_ID}
            eyebrow="Profit"
            title="Revenue is only half the story."
            lead="Insight combines the data available to your business to help you understand what remains after the costs."
          />
        </div>

        <ul className="sr-only">
          <li>Illustration, not real figures. Revenue, then the costs that come out of it:</li>
          {COSTS.map((c) => (
            <li key={c.name}>
              {c.name}: {c.source === "shopify" ? "from your Shopify orders" : "your costs, which live outside Shopify's order data"}.
            </li>
          ))}
          <li>What remains is the estimated profit.</li>
        </ul>

        <div ref={runway} className={reduced ? "relative pb-28 md:pb-36" : "relative h-[230vh] md:h-[240vh] lg:h-[250vh]"}>
          <div
            className={
              reduced
                ? "flex flex-col pt-4 md:pt-6"
                : "sticky top-0 flex h-svh flex-col pb-6 pt-[92px] md:pb-10 md:pt-28 lg:justify-center lg:pb-12 lg:pt-28"
            }
          >
            <SceneHeader />

            <div aria-hidden className="relative mt-[clamp(20px,4.5svh,48px)] hidden lg:block" data-cursor="VIEW">
              <GridWash />
              <HorizontalBar progress={progress} />
            </div>

            <div aria-hidden className={`relative mt-5 lg:hidden ${reduced ? "h-[540px]" : "min-h-0 flex-1"}`} data-cursor="VIEW">
              <VerticalBar progress={progress} />
            </div>

            {/* No bottom margin on the in-view check: pinned near the foot of the screen, the shared
                -12% margin would keep it hidden for the whole scene on tall tablets. */}
            <motion.div {...riseIn(0.1, 12)} viewport={{ once: true }} className="mt-6 flex flex-col items-start gap-3 md:mt-8 lg:mt-[clamp(20px,4.5svh,48px)] lg:flex-row lg:items-center lg:gap-5">
              <IllustrativeNote />
              <p className="max-w-2xl text-[13px] leading-relaxed text-lp-muted md:text-[14px]">
                Discounts and refunds come from your Shopify orders. Fees, ad spend, shipping and product costs live outside
                Shopify&rsquo;s order data.
              </p>
            </motion.div>
          </div>
        </div>
      </div>
    </section>
  );
}

function SceneHeader() {
  return (
    <motion.div {...riseIn(0, 12)} aria-hidden className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
      <p className="lp-eyebrow">From revenue to what remains</p>
      <div className="flex items-center gap-5 text-[12.5px] text-lp-text-2">
        <span className="flex items-center gap-2">
          <span className={`h-2.5 w-4 rounded-[3px] ${SOURCE_CHIP.shopify}`} />
          {SOURCE_LABEL.shopify}
        </span>
        <span className="flex items-center gap-2">
          <span className={`h-2.5 w-4 rounded-[3px] ${SOURCE_CHIP.yours}`} />
          {SOURCE_LABEL.yours}
        </span>
      </div>
    </motion.div>
  );
}

/** Technical grid behind the bar only, faded out towards the edges. */
function GridWash() {
  return (
    <div
      aria-hidden
      className="lp-grid pointer-events-none absolute -inset-x-6 -inset-y-8 opacity-60 [mask-image:radial-gradient(ellipse_at_center,black_25%,transparent_70%)]"
    />
  );
}

function SourceTag({ source, compact = false }: { source: Source; compact?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap font-lp-mono text-[10px] uppercase ${
        compact ? "tracking-[0.06em] xl:tracking-[0.12em]" : "tracking-[0.12em]"
      } ${
        source === "shopify" ? "text-lp-text-2" : "text-lp-muted"
      }`}
    >
      <span className={`size-2 rounded-[2px] ${SOURCE_CHIP[source]}`} />
      {SOURCE_LABEL[source]}
    </span>
  );
}

/* ---- Desktop: horizontal bar ------------------------------------------------------------------ */

/*
 * Vertical rhythm of the horizontal scene (CSS variables so breakpoints can retune it):
 * --ann annotation row, --bar the bar, --lead the leader lines; dropped slices keep 58% height.
 * They scale with the viewport height too, so the pinned scene still clears the nav on short
 * laptop screens (1366x768 with browser chrome is about 650px tall).
 */
const H_LANE_BOTTOM = "calc(var(--ann) + var(--bar) * 1.58 + 26px)";

function HorizontalBar({ progress }: { progress: MotionValue<number> }) {
  const { profitIn, profitShift, ghost, revenueColor, revenueRule } = useProfitMotion(progress);
  return (
    <div
      className="relative [--ann:clamp(56px,9svh,72px)] [--bar:clamp(78px,13svh,104px)] [--lead:clamp(28px,5svh,44px)] xl:[--ann:clamp(60px,9svh,84px)] xl:[--bar:clamp(84px,13.5svh,124px)] xl:[--lead:clamp(32px,5.5svh,56px)]"
      style={{ height: `calc(${H_LANE_BOTTOM} + var(--lead) + 64px)` }}
    >
      {/* Annotation row: Revenue spans the whole bar; estimated profit only what remains. */}
      <motion.p
        className="absolute left-0 top-0 flex items-end pb-5 text-[clamp(30px,min(3.4vw,6.2svh),54px)] font-[550] leading-none tracking-[-0.04em]"
        style={{ height: "var(--ann)", color: revenueColor }}
      >
        Revenue
      </motion.p>
      <motion.div className="absolute inset-x-0 h-px bg-white/20" style={{ top: "calc(var(--ann) - 10px)", opacity: revenueRule }}>
        <span className="absolute -top-1 left-0 h-2 w-px bg-white/40" />
        <span className="absolute -top-1 right-0 h-2 w-px bg-white/40" />
      </motion.div>
      <motion.p
        className="absolute right-0 top-0 flex items-end justify-end pb-5 text-[clamp(30px,min(3.4vw,6.2svh),54px)] font-[550] leading-none tracking-[-0.04em] text-lp-text"
        style={{ height: "var(--ann)", opacity: profitIn, y: profitShift }}
      >
        Estimated profit
      </motion.p>
      <motion.div
        className="absolute right-0 h-px origin-right bg-gradient-to-r from-lp-positive to-lp-cyan"
        style={{ left: `${COSTS_TOTAL * 100}%`, top: "calc(var(--ann) - 10px)", scaleX: profitIn }}
      />

      {/* The original extent stays as a dashed ghost, so what was taken away stays legible. */}
      <motion.div
        className="absolute inset-x-0 rounded-[18px] border border-dashed border-white/12"
        style={{ top: "var(--ann)", height: "var(--bar)", opacity: ghost }}
      />

      <UncutBar progress={progress} orientation="h" />
      <ProfitBlock orientation="h" progress={profitIn} />
      <motion.p
        className="lp-eyebrow absolute pl-1"
        style={{ left: `${COSTS_TOTAL * 100}%`, top: "calc(var(--ann) + var(--bar) + 18px)", opacity: profitIn }}
      >
        What remains after the costs
      </motion.p>

      {COSTS.map((cost, k) => (
        <SliceH key={cost.name} cost={cost} index={k} progress={progress} />
      ))}
    </div>
  );
}

function SliceH({ cost, index, progress }: { cost: Cost; index: number; progress: MotionValue<number> }) {
  const m = useCostMotion(progress, index);
  const y = useTransform(m.carve, (c) => `calc(${c * 100}% + ${c * 18}px)`);
  // Leaders draw in with a clip, not pathLength: pathLength is unreliable with non-scaling strokes
  // on a stretched viewBox (the dash is measured in user units, the stroke in screen pixels).
  const draw = useTransform(m.reveal, (r) => (r >= 0.999 ? "none" : `inset(0 0 ${(1 - r) * 100}% 0)`));
  const start = STARTS[index];
  const from = (start + cost.w / 2) * 1000;
  const to = LABEL_AT[index] * 1000;

  return (
    <>
      <motion.div
        className="absolute"
        style={{ left: `${start * 100}%`, width: `${cost.w * 100}%`, top: "var(--ann)", height: "var(--bar)", y }}
      >
        <motion.div
          className={`absolute inset-0 origin-top ${index === 0 ? "rounded-l-[18px]" : ""}`}
          style={{ ...sliceFill(start, cost.w, "h"), opacity: m.fillOpacity, scaleY: m.fillScale }}
        />
        <motion.div
          className={`absolute inset-x-[3px] top-0 h-[58%] rounded-[8px] ${SOURCE_CHIP[cost.source]}`}
          style={{ opacity: m.chipOpacity }}
        />
      </motion.div>

      {/* The cut: a thin bright line flashes where the slice is about to separate. */}
      <motion.div
        className="absolute w-[2px] -translate-x-1/2 rounded-full bg-lp-text"
        style={{ left: `${(start + cost.w) * 100}%`, top: "calc(var(--ann) - 10px)", height: "calc(var(--bar) + 20px)", opacity: m.cut }}
      />

      <motion.svg
        className="absolute inset-x-0 w-full overflow-visible"
        style={{ top: H_LANE_BOTTOM, height: "var(--lead)", clipPath: draw, opacity: m.reveal }}
        viewBox="0 0 1000 100"
        preserveAspectRatio="none"
      >
        <path
          d={`M ${from} 0 C ${from} 55, ${to} 45, ${to} 100`}
          fill="none"
          stroke="rgba(255,255,255,0.24)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      </motion.svg>

      <motion.div
        className="absolute flex flex-col items-center gap-1.5 whitespace-nowrap text-center"
        style={{
          left: `${(LABEL_AT[index] - LABEL_SLOT / 2) * 100}%`,
          width: `${LABEL_SLOT * 100}%`,
          top: `calc(${H_LANE_BOTTOM} + var(--lead) + 6px)`,
          opacity: m.reveal,
          y: m.labelShift,
        }}
      >
        <span className="text-[14px] font-medium leading-tight text-lp-text xl:text-[15px]">{cost.name}</span>
        <SourceTag source={cost.source} compact />
      </motion.div>
    </>
  );
}

/* ---- Mobile and tablet: vertical bar ---------------------------------------------------------- */

const V_LEADER_LEFT = "calc(var(--bw) * 1.58 + 18px)";
const V_LABEL_LEFT = "calc(var(--bw) * 1.58 + 50px)";

function VerticalBar({ progress }: { progress: MotionValue<number> }) {
  const { profitIn, profitShift, ghost, revenueColor, revenueRule } = useProfitMotion(progress);
  return (
    <div className="flex h-full flex-col [--bw:60px] sm:[--bw:72px] md:[--bw:128px]">
      <div className="relative pb-4">
        <motion.p className="text-[30px] font-[550] leading-none tracking-[-0.04em] md:text-[40px]" style={{ color: revenueColor }}>
          Revenue
        </motion.p>
        <motion.span className="absolute bottom-1.5 left-0 h-px bg-white/25" style={{ width: "var(--bw)", opacity: revenueRule }} />
      </div>

      <div className="relative min-h-0 flex-1">
        <motion.div
          className="absolute left-0 top-0 h-full rounded-[16px] border border-dashed border-white/12"
          style={{ width: "var(--bw)", opacity: ghost }}
        />

        <UncutBar progress={progress} orientation="v" />
        <ProfitBlock orientation="v" progress={profitIn} />
        <motion.div
          className="absolute -translate-y-1/2"
          style={{ left: "calc(var(--bw) + 18px)", top: `${(COSTS_TOTAL + PROFIT_W / 2) * 100}%`, opacity: profitIn, y: profitShift }}
        >
          <p className="text-[24px] font-[550] leading-none tracking-[-0.035em] text-lp-text md:text-[34px]">Estimated profit</p>
          <p className="lp-eyebrow mt-2 text-[10px] md:text-[11px]">What remains after the costs</p>
        </motion.div>

        {COSTS.map((cost, k) => (
          <SliceV key={cost.name} cost={cost} index={k} progress={progress} />
        ))}
      </div>
    </div>
  );
}

function SliceV({ cost, index, progress }: { cost: Cost; index: number; progress: MotionValue<number> }) {
  const m = useCostMotion(progress, index);
  const x = useTransform(m.carve, (c) => `calc(${c * 100}% + ${c * 12}px)`);
  const draw = useTransform(m.reveal, (r) => (r >= 0.999 ? "none" : `inset(0 ${(1 - r) * 100}% 0 0)`));
  const start = STARTS[index];
  // Labels are spaced evenly down the costs' share of the bar, so short slices stay readable.
  const labelAt = ((index + 0.5) / COSTS.length) * COSTS_TOTAL;
  const from = (start + cost.w / 2) * 1000;
  const to = labelAt * 1000;

  return (
    <>
      <motion.div
        className="absolute left-0"
        style={{ top: `${start * 100}%`, height: `${cost.w * 100}%`, width: "var(--bw)", x }}
      >
        <motion.div
          className={`absolute inset-0 origin-left ${index === 0 ? "rounded-t-[16px]" : ""}`}
          style={{ ...sliceFill(start, cost.w, "v"), opacity: m.fillOpacity, scaleX: m.fillScale }}
        />
        <motion.div
          className={`absolute inset-y-[2px] left-0 w-[58%] rounded-[6px] ${SOURCE_CHIP[cost.source]}`}
          style={{ opacity: m.chipOpacity }}
        />
      </motion.div>

      <motion.div
        className="absolute h-[2px] -translate-y-1/2 rounded-full bg-lp-text"
        style={{ top: `${(start + cost.w) * 100}%`, left: "-6px", width: "calc(var(--bw) + 12px)", opacity: m.cut }}
      />

      <motion.svg
        className="absolute top-0 h-full w-[26px] overflow-visible"
        style={{ left: V_LEADER_LEFT, clipPath: draw, opacity: m.reveal }}
        viewBox="0 0 100 1000"
        preserveAspectRatio="none"
      >
        <path
          d={`M 0 ${from} C 55 ${from}, 45 ${to}, 100 ${to}`}
          fill="none"
          stroke="rgba(255,255,255,0.24)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      </motion.svg>

      <motion.div
        className="absolute right-0 flex -translate-y-1/2 flex-wrap items-center gap-x-2.5 gap-y-0.5"
        style={{ left: V_LABEL_LEFT, top: `${labelAt * 100}%`, opacity: m.reveal, x: m.labelShift }}
      >
        <span className="text-[13.5px] font-medium leading-tight text-lp-text md:text-[17px]">{cost.name}</span>
        <SourceTag source={cost.source} />
      </motion.div>
    </>
  );
}

/* ---- The remainder ---------------------------------------------------------------------------- */

/** The part no cost touches: revenue-coloured until the end, then estimated profit with a glow. */
function ProfitBlock({ orientation, progress }: { orientation: Orientation; progress: MotionValue<number> }) {
  const h = orientation === "h";
  const place: CSSProperties = h
    ? { left: `${COSTS_TOTAL * 100}%`, width: `${PROFIT_W * 100}%`, top: "var(--ann)", height: "var(--bar)" }
    : { left: 0, top: `${COSTS_TOTAL * 100}%`, height: `${PROFIT_W * 100}%`, width: "var(--bw)" };
  const radius = h ? "rounded-r-[18px]" : "rounded-b-[16px]";
  return (
    <div className="absolute" style={place}>
      <motion.div
        className={`pointer-events-none absolute -z-10 ${h ? "-inset-x-10 -inset-y-14" : "-inset-x-8 -inset-y-10"}`}
        style={{ backgroundImage: GLOW, opacity: progress }}
      />
      <motion.div
        className={`absolute inset-0 border border-lp-positive/50 ${radius}`}
        style={{ backgroundImage: `${h ? SHEEN_H : SHEEN_V}, ${h ? PROFIT_H : PROFIT_V}`, opacity: progress }}
      />
    </div>
  );
}
