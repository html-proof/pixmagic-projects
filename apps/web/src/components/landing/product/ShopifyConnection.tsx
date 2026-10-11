"use client";
import {
  AnimatePresence,
  motion,
  useInView,
  useMotionValue,
  useMotionValueEvent,
  useSpring,
  useTransform,
  type MotionValue,
} from "motion/react";
import {
  ChartLine,
  KeyRound,
  LockKeyhole,
  RefreshCw,
  ScanEye,
  ShieldCheck,
  Store,
  Unplug,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { useScrollProgress } from "@/hooks/useScrollProgress";
import { EASE, clamp01, riseIn, segment } from "@/lib/motion";
import { InsightMark } from "../shared/InsightMark";
import { SectionIntro } from "../shared/ui";

const STEPS: { title: string; text: string; icon: LucideIcon }[] = [
  { title: "OAuth authorization", text: "You approve read-only access on Shopify.", icon: KeyRound },
  { title: "Secure connection", text: "Credentials are encrypted.", icon: LockKeyhole },
  { title: "Data synchronization", text: "Your order history is imported.", icon: RefreshCw },
  { title: "Webhook events", text: "Shopify tells Insights the moment something changes.", icon: Webhook },
  { title: "Analytics processing", text: "Your dashboard updates.", icon: ChartLine },
];

const SECURITY: { title: string; text: string; icon: LucideIcon }[] = [
  { title: "Secure Shopify OAuth", text: "You approve access on Shopify. Insights never sees your password.", icon: ShieldCheck },
  { title: "Encrypted credentials", text: "Store access tokens are encrypted at rest.", icon: LockKeyhole },
  { title: "Permission-aware access", text: "Read-only. Optional permissions can be skipped.", icon: ScanEye },
  { title: "Disconnect anytime", text: "Remove access from Insights or your Shopify admin at any time.", icon: Unplug },
];

/** What a webhook packet carries, in plain words (Insights listens for these changes). */
const PACKETS = ["Order", "Refund", "Product", "Inventory"] as const;

/*
 * Scroll choreography (progress of the diagram passing through the viewport, 0..1):
 *   step i lights at 0.10 + 0.16·i (over 0.06), the connection line fills in step with them
 *   (it reaches station i exactly as it lights), the Insights node wakes at 0.80–0.90, and the
 *   connection counts as live from 0.92, when webhook packets start to flow.
 */
const stepStart = (i: number) => 0.1 + 0.16 * i;
const lineFill = (p: number) => clamp01(1.25 * p - 0.025);
const LIVE_AT = 0.92;

/**
 * "Connect once. Insights keeps listening.": your store and Insights joined by the five things
 * that happen when you connect, lighting up as the diagram scrolls through, then small webhook
 * packets flowing from the store to Insights. Horizontal from 1400px, vertical below.
 */
export function ShopifyConnection() {
  const reduced = useReducedMotion();
  const diagramRef = useRef<HTMLDivElement>(null);
  const raw = useScrollProgress(diagramRef, ["start 0.85", "end 0.6"]);
  const smooth = useSpring(raw, { stiffness: 140, damping: 32, mass: 0.6 });
  const full = useMotionValue(1);
  const progress = reduced ? full : smooth;

  const [connected, setConnected] = useState(false);
  // One React update when the line completes (or un-completes), not one per scroll frame.
  // React bails out when the boolean is unchanged, so this is one render per crossing.
  useMotionValueEvent(smooth, "change", (v) => setConnected(v >= LIVE_AT));
  useEffect(() => {
    setConnected(smooth.get() >= LIVE_AT);
  }, [smooth]);

  const onScreen = useInView(diagramRef, { amount: 0.15 });
  const live = reduced || connected;
  const flowing = !reduced && connected && onScreen;

  return (
    <section aria-labelledby="shopify-connection-title" className="relative overflow-clip bg-lp-bg-2 py-28 md:py-36 xl:py-44">
      {/* Blend in from Ask Insights above. The bottom edge stays lp-bg-2: the product reveal below fades from it. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-56 bg-gradient-to-b from-lp-bg to-transparent" />
      <div
        aria-hidden
        className="lp-grid pointer-events-none absolute inset-0 opacity-60 [mask-image:radial-gradient(ellipse_60%_45%_at_50%_55%,black,transparent)]"
      />

      <div className="relative mx-auto max-w-[1380px] px-4 md:px-8 xl:px-12">
        <SectionIntro
          id="shopify-connection-title"
          eyebrow="Shopify connection"
          title="Connect once. Insights keeps listening."
          lead="Connect your Shopify store securely through Shopify. Insights organizes the information your store makes available and keeps your dashboard updated as the business changes."
        />

        {/*
         * Below 1400px the diagram runs top to bottom, with the security cards beside it from 993px (laptop)
         * (they stay in view while the taller diagram scrolls past). From 1400px the diagram runs left
         * to right: below that the five step columns are too narrow for their titles.
         */}
        <div className="mt-14 grid gap-12 md:mt-20 min-[62.0625rem]:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] min-[62.0625rem]:gap-14 min-[87.5rem]:grid-cols-1 min-[87.5rem]:gap-16">
          <motion.figure {...riseIn(0.1, 32)} className="m-0">
            <figcaption className="sr-only">
              How your Shopify store connects to Insights, in five steps. Once connected, Shopify sends Insights each change as it
              happens.
            </figcaption>
            <div ref={diagramRef} data-cursor="VIEW">
              <VerticalDiagram progress={progress} flowing={flowing} live={live} instant={reduced} />
              <HorizontalDiagram progress={progress} flowing={flowing} live={live} instant={reduced} />
            </div>
          </motion.figure>

          <ul className="grid content-start gap-3 sm:grid-cols-2 md:gap-4 min-[62.0625rem]:sticky min-[62.0625rem]:top-28 min-[62.0625rem]:grid-cols-1 min-[62.0625rem]:self-start min-[87.5rem]:static min-[87.5rem]:grid-cols-4">
            {SECURITY.map((item, i) => {
              const Icon = item.icon;
              return (
                <motion.li
                  key={item.title}
                  {...riseIn(0.08 * i, 20)}
                  className="flex gap-4 rounded-[22px] border border-lp-line bg-gradient-to-b from-lp-surface/80 to-lp-elevated/80 p-5 md:p-6 min-[87.5rem]:flex-col"
                >
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-lp-line-strong bg-lp-bg-2">
                    <Icon aria-hidden className="size-[18px] text-lp-violet-bright" strokeWidth={1.8} />
                  </span>
                  <div className="min-w-0">
                    <h3 className="text-[16.5px] font-medium tracking-[-0.01em] text-lp-text">{item.title}</h3>
                    <p className="mt-1.5 text-[15px] leading-relaxed text-lp-text-2">{item.text}</p>
                  </div>
                </motion.li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}

interface DiagramProps {
  progress: MotionValue<number>;
  flowing: boolean;
  /** Past the live point: both nodes show their connected status. */
  live: boolean;
  instant: boolean;
}

/** ≥1400px: store on the left, Insights on the right, the five stations along the line between. */
function HorizontalDiagram({ progress, flowing, live, instant }: DiagramProps) {
  const fill = useTransform(progress, lineFill);
  const headX = useTransform(fill, (f) => `${f * 100}%`);
  const headOpacity = useTransform(fill, [0, 0.03, 0.97, 1], [0, 1, 1, 0]);

  return (
    <div className="hidden min-[87.5rem]:block">
      <div className="flex items-stretch">
        <StoreNode live={live} instant={instant} className="w-[232px]" />
        <div className="relative h-24 flex-1 self-center">
          <div aria-hidden className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-lp-line-strong" />
          <motion.div
            aria-hidden
            style={{ scaleX: fill }}
            className="absolute inset-x-0 top-1/2 h-[2px] origin-left -translate-y-1/2 [background:var(--lp-gradient)]"
          />
          <motion.div aria-hidden style={{ x: headX, opacity: headOpacity }} className="pointer-events-none absolute inset-0">
            <span className="absolute left-0 top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-lp-cyan shadow-[0_0_14px_3px_rgb(101_216_208/0.45)]" />
          </motion.div>
          <Packets flowing={flowing} axis="x" />
          {STEPS.map((step, i) => (
            <span
              key={step.title}
              aria-hidden
              className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
              style={{ left: `${((i + 0.5) / STEPS.length) * 100}%` }}
            >
              <Station index={i} icon={step.icon} progress={progress} />
            </span>
          ))}
        </div>
        <InsightNode progress={progress} flowing={flowing} live={live} instant={instant} className="w-[232px]" />
      </div>

      {/* Columns are as wide as the station spacing (about 156px at 1400px), so the number sits on its own line. */}
      <ol className="mx-[232px] mt-6 grid grid-cols-5 gap-3">
        {STEPS.map((step, i) => (
          <StepText key={step.title} index={i} title={step.title} text={step.text} progress={progress} stacked className="text-center" />
        ))}
      </ol>
    </div>
  );
}

/** <1400px: store on top, the stations down a vertical line, Insights underneath. */
function VerticalDiagram({ progress, flowing, live, instant }: DiagramProps) {
  const fill = useTransform(progress, lineFill);
  const headY = useTransform(fill, (f) => `${f * 100}%`);
  const headOpacity = useTransform(fill, [0, 0.03, 0.97, 1], [0, 1, 1, 0]);

  return (
    <div className="max-w-[720px] min-[87.5rem]:hidden">
      <StoreNode live={live} instant={instant} />
      <div className="relative py-2">
        {/* The line runs through the centre of the 44px stations: 16px row padding + 22px. */}
        <div aria-hidden className="absolute inset-y-0 left-[37.5px] w-px bg-lp-line-strong" />
        <motion.div
          aria-hidden
          style={{ scaleY: fill }}
          className="absolute inset-y-0 left-[37px] w-[2px] origin-top [background:linear-gradient(180deg,var(--lp-primary),var(--lp-blue)_55%,var(--lp-cyan))]"
        />
        <motion.div aria-hidden style={{ y: headY, opacity: headOpacity }} className="pointer-events-none absolute inset-0">
          <span className="absolute left-[38px] top-0 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-lp-cyan shadow-[0_0_14px_3px_rgb(101_216_208/0.45)]" />
        </motion.div>
        <Packets flowing={flowing} axis="y" />
        <ol className="relative">
          {STEPS.map((step, i) => (
            <li key={step.title} className="flex h-[96px] items-center gap-4 pl-4 md:h-[88px]">
              <span aria-hidden className="shrink-0">
                <Station index={i} icon={step.icon} progress={progress} />
              </span>
              <StepText as="div" index={i} title={step.title} text={step.text} progress={progress} />
            </li>
          ))}
        </ol>
      </div>
      <InsightNode progress={progress} flowing={flowing} live={live} instant={instant} />
    </div>
  );
}

/** A point on the connection: lights up (violet ring, bright icon) as the line reaches it. */
function Station({ index, icon: Icon, progress }: { index: number; icon: LucideIcon; progress: MotionValue<number> }) {
  const a = useTransform(progress, (p) => segment(p, stepStart(index), stepStart(index) + 0.06));
  const scale = useTransform(a, [0, 1], [0.82, 1]);
  return (
    <span className="relative grid size-11 place-items-center rounded-full border border-lp-line-strong bg-lp-bg-2">
      <Icon className="size-[18px] text-lp-muted" strokeWidth={1.8} />
      <motion.span
        style={{ opacity: a, scale }}
        className="absolute inset-[-1px] grid place-items-center rounded-full border border-lp-violet-bright/60 bg-[radial-gradient(circle_at_50%_40%,rgb(140_123_255/0.35),rgb(18_22_28)_75%)] shadow-[0_0_24px_-4px_rgb(140_123_255/0.55)]"
      >
        <Icon className="size-[18px] text-lp-text" strokeWidth={1.8} />
      </motion.span>
    </span>
  );
}

/** Step name and its one-line explanation. Stays readable when not yet lit (never below 4.5:1). */
function StepText({
  index,
  title,
  text,
  progress,
  className = "",
  as = "li",
  stacked = false,
}: {
  index: number;
  title: string;
  text: string;
  progress: MotionValue<number>;
  className?: string;
  as?: "li" | "div";
  /** Number above the title instead of before it, for the narrow horizontal columns. */
  stacked?: boolean;
}) {
  const a = useTransform(progress, (p) => segment(p, stepStart(index), stepStart(index) + 0.06));
  const opacity = useTransform(a, [0, 1], [0.72, 1]);
  const y = useTransform(a, [0, 1], [4, 0]);
  const numberColor = useTransform(a, (v) => (v > 0.5 ? "rgb(167, 152, 255)" : "rgb(125, 134, 147)"));
  const Tag = as === "li" ? motion.li : motion.div;
  return (
    <Tag style={{ opacity, y }} className={`min-w-0 ${className}`}>
      <p className={`font-medium tracking-[-0.01em] text-lp-text ${stacked ? "text-[15px] leading-snug" : "text-[15.5px]"}`}>
        <motion.span
          style={{ color: numberColor }}
          className={`font-lp-mono text-[11px] tracking-[0.12em] ${stacked ? "mb-1.5 block" : "mr-2"}`}
        >
          0{index + 1}
        </motion.span>
        {title}
      </p>
      <p className={`mt-1 leading-snug text-lp-text-2 ${stacked ? "text-pretty text-[13.5px]" : "text-[14px]"}`}>{text}</p>
    </Tag>
  );
}

/**
 * Node status line. Switches once, at the live point, with a short sequential fade: a scroll-linked
 * cross-fade could rest half-way and print both labels on top of each other.
 */
function NodeStatus({ live, idle, liveText, pulse, instant }: { live: boolean; idle: string; liveText: string; pulse: boolean; instant: boolean }) {
  return (
    <span aria-hidden className="relative mt-3 grid font-lp-mono text-[11px] uppercase tracking-[0.12em]">
      <motion.span
        initial={false}
        animate={{ opacity: live ? 0 : 1, y: live ? -4 : 0 }}
        transition={instant ? { duration: 0 } : { duration: 0.25, ease: EASE }}
        className="col-start-1 row-start-1 flex items-center gap-2 whitespace-nowrap text-lp-muted"
      >
        <span className="size-1.5 rounded-full bg-lp-line-strong" />
        {idle}
      </motion.span>
      <motion.span
        initial={false}
        animate={{ opacity: live ? 1 : 0, y: live ? 0 : 4 }}
        transition={instant ? { duration: 0 } : { duration: 0.45, ease: EASE, delay: live ? 0.2 : 0 }}
        className="col-start-1 row-start-1 flex items-center gap-2 whitespace-nowrap text-lp-text-2"
      >
        <span className="relative grid size-1.5 place-items-center">
          {pulse && <span className="absolute size-1.5 animate-ping rounded-full bg-lp-positive/70" />}
          <span className="relative size-1.5 rounded-full bg-lp-positive" />
        </span>
        {liveText}
      </motion.span>
    </span>
  );
}

function StoreNode({ live, instant, className = "" }: { live: boolean; instant: boolean; className?: string }) {
  return (
    <div
      className={`relative flex shrink-0 flex-col justify-center rounded-[22px] border border-lp-line-strong bg-gradient-to-b from-lp-surface to-lp-elevated px-4 py-4 shadow-[0_24px_60px_-28px_rgb(0_0_0/0.8)] md:py-5 ${className}`}
    >
      <div className="flex items-center gap-4">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-lp-line-strong bg-white/[0.04]">
          <Store aria-hidden className="size-5 text-lp-text" strokeWidth={1.7} />
        </span>
        <span className="min-w-0">
          <span className="block text-[16px] font-medium tracking-[-0.01em] text-lp-text">Your Shopify store</span>
          <span className="block text-[13.5px] text-lp-muted">Orders, products, inventory</span>
        </span>
      </div>
      <NodeStatus live={live} instant={instant} idle="Not connected yet" liveText="Connected · read-only" pulse={false} />
    </div>
  );
}

function InsightNode({
  progress,
  flowing,
  live,
  instant,
  className = "",
}: {
  progress: MotionValue<number>;
  flowing: boolean;
  live: boolean;
  instant: boolean;
  className?: string;
}) {
  const wake = useTransform(progress, [0.8, 0.9], [0, 1]);
  return (
    <div
      className={`relative flex shrink-0 flex-col justify-center rounded-[22px] border border-lp-line-strong bg-gradient-to-b from-lp-surface to-lp-elevated px-4 py-4 shadow-[0_24px_60px_-28px_rgb(0_0_0/0.8)] md:py-5 ${className}`}
    >
      <motion.span
        aria-hidden
        style={{ opacity: wake }}
        className="pointer-events-none absolute inset-0 rounded-[22px] border border-lp-violet/40 [background:radial-gradient(120%_90%_at_15%_20%,rgb(140_123_255/0.14),transparent_60%)]"
      />
      <div className="relative flex items-center gap-4">
        <span className="relative grid size-11 shrink-0 place-items-center rounded-xl border border-lp-line-strong bg-lp-bg-2">
          <InsightMark size={30} className="text-lp-text" />
        </span>
        <span className="min-w-0">
          <span className="block text-[16px] font-semibold tracking-[0.14em] text-lp-text">INSIGHTS</span>
          <span className="block text-[13.5px] text-lp-muted">Your dashboard</span>
        </span>
      </div>
      <NodeStatus live={live} instant={instant} idle="Waiting for data" liveText="Listening for changes" pulse={flowing} />
    </div>
  );
}

const TRAVEL_EASE = [0.45, 0, 0.25, 1] as const;

/** The webhook stream. Fades out instead of vanishing mid-flight when scrolled back above "live". */
function Packets({ flowing, axis }: { flowing: boolean; axis: "x" | "y" }) {
  return (
    <AnimatePresence>
      {flowing && (
        <motion.div
          key="packets"
          aria-hidden
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.4, ease: EASE }}
          className="pointer-events-none absolute inset-0"
        >
          {PACKETS.map((label, i) => (
            <Packet key={label} label={label} index={i} axis={axis} />
          ))}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * One webhook notification travelling from the store to Insights. The wrapper spans the whole
 * line, so translating it by 100% of its own size carries the dot from one end to the other.
 */
function Packet({ label, index, axis }: { label: string; index: number; axis: "x" | "y" }) {
  const loop = { duration: 2.6, repeat: Infinity, repeatDelay: 2.2, delay: 0.4 + index * 1.2 };
  const travel = axis === "x" ? { x: ["0%", "100%"] } : { y: ["0%", "100%"] };
  return (
    <motion.div
      className="absolute inset-0"
      initial={{ opacity: 0 }}
      animate={{ ...travel, opacity: [0, 1, 1, 0] }}
      transition={{
        x: { ...loop, ease: TRAVEL_EASE },
        y: { ...loop, ease: TRAVEL_EASE },
        opacity: { ...loop, ease: "linear", times: [0, 0.16, 0.82, 1] },
      }}
    >
      {axis === "x" ? (
        <span className="absolute left-0 top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-lp-cyan">
          <span className="absolute right-full top-1/2 h-px w-8 -translate-y-1/2 bg-gradient-to-r from-transparent to-lp-cyan/70" />
          {/* The label shows only mid-line, so it never sits on top of either node. */}
          <motion.span
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 0, 1, 1, 0, 0] }}
            transition={{ ...loop, ease: "linear", times: [0, 0.18, 0.3, 0.66, 0.78, 1] }}
            className="absolute bottom-full left-1/2 mb-[26px] -translate-x-1/2 whitespace-nowrap font-lp-mono text-[10px] uppercase tracking-[0.14em] text-lp-muted"
          >
            {label}
          </motion.span>
        </span>
      ) : (
        <span className="absolute left-[38px] top-0 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-lp-cyan">
          <span className="absolute bottom-full left-1/2 h-8 w-px -translate-x-1/2 bg-gradient-to-b from-transparent to-lp-cyan/70" />
        </span>
      )}
    </motion.div>
  );
}
