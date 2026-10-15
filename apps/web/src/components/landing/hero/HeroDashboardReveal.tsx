"use client";
import { motion, useTransform, type MotionValue } from "motion/react";
import { useId, type ReactNode } from "react";
import { easeOut, lerp, segment } from "@/lib/motion";
import { InsightMark } from "../shared/InsightMark";
import { EMBLEM_IN, ORB, ORB_POINT, SLOTS, type SlotId } from "./heroLayout";

/**
 * When each card forms, as windows of stage 4 (p 0.60–0.80). Business health grows out of the
 * core; the four modules then unfold from beneath it, row by row, and are all in place by p≈0.73
 * so the finished dashboard holds beside "See what matters." before the final statement.
 */
const WINDOWS: Record<SlotId, [number, number]> = {
  health: [0.13, 0.42],
  sales: [0.28, 0.52],
  conversion: [0.33, 0.57],
  customers: [0.4, 0.62],
  products: [0.45, 0.67],
};
/** Where a module starts its unfold, as box % above its slot: tucked under the card above it. */
const TUCK: Record<Exclude<SlotId, "health">, number> = {
  sales: SLOTS.sales.y - (SLOTS.health.y + SLOTS.health.h * 0.25),
  conversion: SLOTS.conversion.y - (SLOTS.health.y + SLOTS.health.h * 0.25),
  customers: SLOTS.customers.y - SLOTS.sales.y,
  products: SLOTS.products.y - SLOTS.conversion.y,
};
/** Paint order: lower rows first, so each row slides out from beneath the one above it. */
const ORDER: SlotId[] = ["products", "customers", "conversion", "sales", "health"];
const stage4 = (p: number) => segment(p, 0.6, 0.8);

/** Skeleton bar standing in for text or values the product fills in with the merchant's own data. */
function Skeleton({ className = "" }: { className?: string }) {
  return <span className={`block h-[7px] rounded-full bg-white/[0.08] ${className}`} />;
}

function CardHeader({ title, value = true }: { title: string; value?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <p className="truncate text-[11px] font-medium text-lp-text-2 @3xs:text-[12.5px]">{title}</p>
      {value && <p className="font-lp-mono text-[15px] leading-none text-lp-text @3xs:text-[18px]">—</p>}
    </div>
  );
}

/* ---- Module contents: abstract shapes only, never numbers ------------------------------------ */

function HealthContent({ reveal, emblem }: { reveal: MotionValue<number>; emblem: MotionValue<number> }) {
  const lines = useTransform(reveal, (r) => segment(r, 0.2, 1));
  return (
    <>
      <motion.span
        className="lp-layer absolute top-1/2 aspect-square -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{
          opacity: emblem,
          left: `${ORB.x}%`,
          width: `${ORB.size}%`,
          background:
            "radial-gradient(circle at 33% 27%, rgb(255 255 255 / 0.6) 0%, rgb(255 255 255 / 0) 22%), radial-gradient(circle at 40% 34%, #b4a8ff 0%, #8c7bff 30%, #5a6fe0 62%, #26305f 100%)",
          boxShadow: "0 0 24px rgb(140 123 255 / 0.45)",
        }}
      />
      <div className="flex h-full items-center gap-4 py-3 pl-[13%] pr-4 @lg:gap-8 @lg:pr-6">
        <div className="min-w-0 shrink-0">
          <p className="text-[11px] font-medium text-lp-text-2 @md:text-[12.5px]">Business health</p>
          <p className="mt-1 font-lp-mono text-[18px] leading-none text-lp-text @md:text-[24px]">—</p>
          <p className="mt-2 hidden text-[11.5px] text-lp-muted @lg:block">vs previous period</p>
        </div>
        <motion.ul className="lp-layer min-w-0 flex-1 space-y-2.5 border-l border-lp-line pl-4 @lg:pl-6" style={{ opacity: lines }}>
          {[
            { dot: "bg-lp-positive", w: "w-[82%]" },
            { dot: "bg-lp-warning", w: "w-[64%]" },
            { dot: "bg-lp-blue", w: "w-[72%]", wide: true },
          ].map((line, i) => (
            <li key={i} className={`items-center gap-2.5 ${line.wide ? "hidden @lg:flex" : "flex"}`}>
              <span className={`size-1.5 shrink-0 rounded-full ${line.dot}`} />
              <Skeleton className={line.w} />
            </li>
          ))}
        </motion.ul>
      </div>
    </>
  );
}

/** An abstract rising line: shape only, no axis values. */
const SPARK = "M0 46 C 18 44, 26 34, 42 36 S 66 44, 82 30 S 108 18, 124 24 S 152 30, 168 14 S 188 8, 200 6";

function SalesContent({ reveal }: { reveal: MotionValue<number> }) {
  const id = `hero-spark-${useId().replace(/:/g, "")}`;
  const clip = useTransform(reveal, (r) => `inset(-10% ${(1 - r) * 100}% -10% 0)`);
  return (
    <div className="flex h-full flex-col">
      <CardHeader title="Sales" />
      <motion.div className="lp-layer relative mt-auto h-[58%]" style={{ clipPath: clip }}>
        <svg viewBox="0 0 200 60" preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible" fill="none">
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#8c7bff" stopOpacity="0.32" />
              <stop offset="100%" stopColor="#8c7bff" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[15, 30, 45].map((y) => (
            <line key={y} x1="0" x2="200" y1={y} y2={y} stroke="rgb(255 255 255 / 0.05)" strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />
          ))}
          <path d={`${SPARK} L 200 60 L 0 60 Z`} fill={`url(#${id})`} />
          <path d={SPARK} stroke="#a798ff" strokeWidth={1.6} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </svg>
      </motion.div>
    </div>
  );
}

/** Visited → viewed a product → added to cart → started checkout → purchased, as tapering steps. */
const FUNNEL = [100, 70, 48, 33, 22];

function ConversionContent({ reveal }: { reveal: MotionValue<number> }) {
  return (
    <div className="flex h-full flex-col">
      <CardHeader title="Conversion" />
      <div className="mt-auto flex h-[58%] items-end gap-[6%]">
        {FUNNEL.map((h, i) => (
          <FunnelBar key={i} height={h} index={i} reveal={reveal} />
        ))}
      </div>
    </div>
  );
}

function FunnelBar({ height, index, reveal }: { height: number; index: number; reveal: MotionValue<number> }) {
  const scaleY = useTransform(reveal, (r) => easeOut(segment(r, index * 0.1, 0.5 + index * 0.1)));
  return (
    <motion.span
      className="lp-layer block flex-1 origin-bottom rounded-[4px] bg-gradient-to-t from-lp-violet/25 to-lp-blue/70"
      style={{ height: `${height}%`, scaleY, opacity: 0.45 + (1 - index / FUNNEL.length) * 0.55 }}
    />
  );
}

function CustomersContent({ reveal }: { reveal: MotionValue<number> }) {
  const scaleX = useTransform(reveal, (r) => easeOut(r));
  return (
    <div className="flex h-full flex-col">
      <CardHeader title="Customers" value={false} />
      <div className="mt-auto space-y-3">
        <motion.div className="lp-layer flex h-2.5 origin-left gap-1 overflow-hidden rounded-full" style={{ scaleX }}>
          <span className="h-full w-[38%] rounded-full bg-lp-violet" />
          <span className="h-full flex-1 rounded-full bg-lp-cyan/80" />
        </motion.div>
        <div className="grid grid-cols-2 gap-2 text-[10.5px] text-lp-muted @3xs:text-[11.5px]">
          {[
            { label: "New", dot: "bg-lp-violet" },
            { label: "Returning", dot: "bg-lp-cyan" },
          ].map((k) => (
            <div key={k.label}>
              <p className="flex items-center gap-1.5">
                <span className={`size-1.5 rounded-full ${k.dot}`} />
                {k.label}
              </p>
              <p className="mt-1 font-lp-mono text-[14px] leading-none text-lp-text @3xs:text-[16px]">—</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const PRODUCT_ROWS = [
  { name: "w-[62%]", bar: "w-[88%]" },
  { name: "w-[48%]", bar: "w-[66%]" },
  { name: "w-[56%]", bar: "w-[47%]" },
  { name: "w-[40%]", bar: "w-[30%]" },
];

function ProductsContent({ reveal }: { reveal: MotionValue<number> }) {
  return (
    <div className="flex h-full flex-col">
      <CardHeader title="Top products" value={false} />
      <ol className="mt-auto space-y-[7px] @3xs:space-y-2.5">
        {PRODUCT_ROWS.map((row, i) => (
          <ProductRow key={i} index={i} row={row} reveal={reveal} />
        ))}
      </ol>
    </div>
  );
}

function ProductRow({ index, row, reveal }: { index: number; row: (typeof PRODUCT_ROWS)[number]; reveal: MotionValue<number> }) {
  const opacity = useTransform(reveal, (r) => segment(r, index * 0.12, 0.4 + index * 0.12));
  const x = useTransform(opacity, (o) => (1 - o) * -8);
  return (
    <motion.li className={`lp-layer ${index === 3 ? "hidden @3xs:grid" : "grid"} grid-cols-[1.1em_1fr_1fr] items-center gap-2`} style={{ opacity, x }}>
      <span className="font-lp-mono text-[10.5px] text-lp-muted">{index + 1}</span>
      <Skeleton className={row.name} />
      <span className="flex justify-end">
        <span className={`block h-[5px] rounded-full bg-gradient-to-r from-lp-blue/40 to-lp-cyan ${row.bar}`} />
      </span>
    </motion.li>
  );
}

const CONTENT: Record<SlotId, (props: { reveal: MotionValue<number>; emblem: MotionValue<number> }) => ReactNode> = {
  health: HealthContent,
  sales: SalesContent,
  conversion: ConversionContent,
  customers: CustomersContent,
  products: ProductsContent,
};

/* ---- Cards growing out of the core --------------------------------------------------------- */

function EmergingCard({
  id,
  progress,
  coreX,
  coreY,
}: {
  id: SlotId;
  progress: MotionValue<number>;
  coreX: MotionValue<number>;
  coreY: MotionValue<number>;
}) {
  const slot = SLOTS[id];
  const [a, b] = WINDOWS[id];
  const health = id === "health";
  const e = useTransform(progress, (p) => easeOut(segment(stage4(p), a, b)));
  // Health: its emblem point rides the core, and the card scales out around that point.
  // Modules: slide down from beneath the card above, settling with a slight scale.
  // (The core itself reaches ORB_POINT at p 0.68, so the health card's offset settles to zero.)
  const x = useTransform(coreX, (c) => (health ? `${c - ORB_POINT.x}%` : "0%"));
  const y = useTransform([coreY, e], ([c, t]: number[]) =>
    health ? `${c - ORB_POINT.y}%` : `${-TUCK[id as Exclude<SlotId, "health">] * (1 - t)}%`,
  );
  const scale = useTransform(e, (t) => (health ? lerp(0.06, 1, t) : lerp(0.94, 1, t)));
  const opacity = useTransform(e, (t) => (health ? segment(t, 0, 0.3) : segment(t, 0.05, 0.45)));
  const radius = useTransform(e, (t) => (health ? lerp(140, 18, t) : 18));
  const reveal = useTransform(e, (t) => segment(t, health ? 0.55 : 0.4, 1));
  const emblem = useTransform(progress, (p) => (health ? segment(p, EMBLEM_IN[0], EMBLEM_IN[1]) : 1));
  const Content = CONTENT[id];
  return (
    <motion.div className="absolute inset-0" style={{ x, y }}>
      <motion.div
        className="lp-layer @container absolute overflow-hidden border border-lp-line bg-[linear-gradient(180deg,#171c24,#12161c)] p-3 shadow-[0_24px_60px_-24px_rgb(0_0_0/0.7)] @3xs:p-4"
        style={{
          left: `${slot.x}%`,
          top: `${slot.y}%`,
          width: `${slot.w}%`,
          height: `${slot.h}%`,
          scale,
          opacity,
          borderRadius: radius,
          padding: health ? 0 : undefined,
          transformOrigin: health ? `${ORB.x}% 50%` : "50% 0%",
        }}
      >
        <Content reveal={reveal} emblem={emblem} />
      </motion.div>
    </motion.div>
  );
}

/**
 * Stage 4–5: the core turns into the Insights dashboard. Business health grows out of the core
 * first (the sphere shrinks into its emblem), then Sales, Conversion, Customers and Products
 * scale out to their grid slots and the window frame forms around them. Values are "—" and
 * skeleton bars: this shows the shape of the product, never invented numbers.
 *
 * `coreX` / `coreY` are the core's centre in box percentages, so cards emerge from wherever it is.
 */
export function HeroDashboardReveal({
  progress,
  coreX,
  coreY,
}: {
  progress: MotionValue<number>;
  coreX: MotionValue<number>;
  coreY: MotionValue<number>;
}) {
  const frame = useTransform(progress, (p) => easeOut(segment(stage4(p), 0.35, 0.72)));
  const frameScale = useTransform(frame, (f) => lerp(0.965, 1, f));
  return (
    <div aria-hidden className="absolute inset-0">
      <motion.div
        className="lp-layer absolute inset-x-0 bottom-[2%] top-[1%] rounded-[20px] border border-lp-line bg-[linear-gradient(180deg,rgb(21_26_33/0.7),rgb(13_16_21/0.55))] shadow-[0_40px_120px_-40px_rgb(0_0_0/0.8)] md:rounded-[26px]"
        style={{ opacity: frame, scale: frameScale }}
      >
        <div className="flex h-[9%] items-center justify-between px-[3%]">
          <span className="flex items-center gap-2 text-[11.5px] font-medium text-lp-text-2 md:text-[12.5px]">
            <InsightMark size={16} className="text-lp-text" />
            Overview
          </span>
          <span className="lp-eyebrow rounded-full border border-lp-line px-2.5 py-1 text-[9.5px] md:text-[10.5px]">vs previous period</span>
        </div>
      </motion.div>
      {ORDER.map((id) => (
        <EmergingCard key={id} id={id} progress={progress} coreX={coreX} coreY={coreY} />
      ))}
    </div>
  );
}
