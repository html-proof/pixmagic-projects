"use client";
import { AnimatePresence, motion, useInView, type Transition } from "motion/react";
import { CreditCard, Package, ShoppingBag, TrendingUp, Undo2, UserRoundCheck, Users, Webhook, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { EASE, ENTER, riseIn } from "@/lib/motion";
import { usePauseWhenHidden } from "@/hooks/usePauseWhenHidden";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { IllustrativeNote, SectionIntro, SrOnly } from "../shared/ui";

type Tone = "violet" | "blue" | "cyan" | "positive" | "warning";
type GroupId = "sales" | "customers";
type Phase = "wait" | "stream" | "group" | "done";

/** Static class strings per tone (Tailwind only sees literal class names). */
const TONE: Record<Tone, { text: string; tile: string; dot: string; stroke: string }> = {
  violet: { text: "text-lp-violet-bright", tile: "bg-lp-violet/12 border-lp-violet/20", dot: "bg-lp-violet", stroke: "var(--lp-primary-bright)" },
  blue: { text: "text-lp-blue", tile: "bg-lp-blue/12 border-lp-blue/20", dot: "bg-lp-blue", stroke: "var(--lp-blue)" },
  cyan: { text: "text-lp-cyan", tile: "bg-lp-cyan/12 border-lp-cyan/20", dot: "bg-lp-cyan", stroke: "var(--lp-cyan)" },
  positive: { text: "text-lp-positive", tile: "bg-lp-positive/12 border-lp-positive/20", dot: "bg-lp-positive", stroke: "var(--lp-positive)" },
  warning: { text: "text-lp-warning", tile: "bg-lp-warning/12 border-lp-warning/20", dot: "bg-lp-warning", stroke: "var(--lp-warning)" },
};

const SOURCES: { label: string; icon: LucideIcon; tone: Tone }[] = [
  { label: "Orders", icon: ShoppingBag, tone: "violet" },
  { label: "Checkout", icon: CreditCard, tone: "blue" },
  { label: "Refunds", icon: Undo2, tone: "warning" },
  { label: "Customers", icon: Users, tone: "cyan" },
  { label: "Products", icon: Package, tone: "positive" },
];

/** Arrival order. `source` indexes SOURCES; `slot` is the row's place inside its group once grouped. */
const EVENTS: { title: string; kind: string; icon: LucideIcon; tone: Tone; source: number; group: GroupId; slot: number }[] = [
  { title: "Order received", kind: "Order", icon: ShoppingBag, tone: "violet", source: 0, group: "sales", slot: 0 },
  { title: "Checkout completed", kind: "Checkout", icon: CreditCard, tone: "blue", source: 1, group: "customers", slot: 0 },
  { title: "Refund processed", kind: "Refund", icon: Undo2, tone: "warning", source: 2, group: "sales", slot: 1 },
  { title: "Returning customer", kind: "Customer", icon: UserRoundCheck, tone: "cyan", source: 3, group: "customers", slot: 1 },
  { title: "Product gaining momentum", kind: "Product", icon: TrendingUp, tone: "positive", source: 4, group: "sales", slot: 2 },
];

const GROUPS: Record<GroupId, { label: string; tone: Tone }> = {
  sales: { label: "Sales activity", tone: "violet" },
  customers: { label: "Customer activity", tone: "cyan" },
};

/** Conceptual status: abstract line shapes and a state word, never numbers. `feeds` = events that touch the card. */
const STATUS: { label: string; state: string; tone: Tone; path: string; end: number; feeds: number[] }[] = [
  { label: "Sales", state: "Rising", tone: "positive", path: "M2 22 C 12 21, 18 24, 26 19 S 40 17, 48 14 S 62 15, 70 10 S 84 6, 94 4", end: 4, feeds: [0, 4] },
  { label: "Checkout", state: "Steady", tone: "blue", path: "M2 15 C 12 13, 18 17, 28 15 S 42 12, 50 15 S 64 17, 72 14 S 86 13, 94 14", end: 14, feeds: [1] },
  { label: "Refunds", state: "Watch", tone: "warning", path: "M2 19 C 14 19, 20 18, 32 19 S 50 20, 58 18 S 70 17, 76 13 S 88 9, 94 10", end: 10, feeds: [2] },
  { label: "Customers", state: "Rising", tone: "cyan", path: "M2 21 C 12 20, 20 21, 30 17 S 46 16, 54 13 S 70 12, 78 9 S 88 8, 94 6", end: 6, feeds: [3] },
];

// Timeline geometry (px). Rows are absolutely placed so the regroup is a pure transform.
const ROW = 56;
const GAP = 8;
const HEAD = 30;
const SPLIT = 20;
const STREAM_TOP = 36;
const CUSTOMER_TOP = HEAD + 3 * ROW + 2 * GAP + SPLIT;
const TIMELINE_H = CUSTOMER_TOP + HEAD + 2 * ROW + GAP;
const SPINE_X = 10;

const streamY = (i: number) => STREAM_TOP + i * (ROW + GAP);
const groupedY = (group: GroupId, slot: number) => (group === "sales" ? 0 : CUSTOMER_TOP) + HEAD + slot * (ROW + GAP);

// Choreography (seconds after the panel enters view): five arrivals, regroup, conclusion.
const ARRIVE_AT = (i: number) => 0.35 + i * 0.42;
const GROUP_AT = 2.75;
const DONE_AT = 3.95;

const PHASE_LABEL: Record<Phase, string> = { wait: "Listening", stream: "Receiving", group: "Grouping", done: "Understood" };

/**
 * Business Pulse: the hinge between the conceptual opening and the product. Shopify signals arrive
 * one at a time, bizinsights gathers related ones into sales and customer activity, then concludes.
 * The sequence plays once when the timeline scrolls into view, then the view rests (only the live
 * dot breathes). Under reduced motion it renders the grouped, concluded state directly.
 */
export function BusinessPulse() {
  const reduced = useReducedMotion();
  const timelineRef = useRef<HTMLDivElement>(null);
  const inView = useInView(timelineRef, { once: true, amount: 0.45 });
  const [step, setStep] = useState<Exclude<Phase, "wait">>("stream");

  useEffect(() => {
    if (reduced || !inView) return;
    const toGroup = window.setTimeout(() => setStep("group"), GROUP_AT * 1000);
    const toDone = window.setTimeout(() => setStep("done"), DONE_AT * 1000);
    return () => {
      window.clearTimeout(toGroup);
      window.clearTimeout(toDone);
    };
  }, [inView, reduced]);

  const phase: Phase = reduced ? "done" : inView ? step : "wait";
  const arrived = phase !== "wait";
  const grouped = phase === "group" || phase === "done";
  const done = phase === "done";

  /** Delayed entrance while streaming; instant when the visitor asked for less motion. */
  const at = (delay: number, base: Transition = ENTER): Transition => (reduced ? { duration: 0 } : { ...base, delay });

  return (
    <section aria-labelledby="pulse-title" className="relative overflow-hidden bg-lp-bg py-28 md:py-36 xl:py-44">
      {/* Soft hand-off from the previous (lp-bg-2) scene, plus a low glow behind the panel. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-56 bg-gradient-to-b from-lp-bg-2 to-transparent" />
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-[38%] h-[640px] w-[min(1200px,120vw)] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgb(140_123_255/0.10),transparent)]"
      />

      <div className="relative mx-auto max-w-[1380px] px-4 md:px-8 xl:px-12">
        <SectionIntro
          id="pulse-title"
          eyebrow="Business pulse"
          title="Your business. One pulse."
          lead="bizinsights brings the most important signals from your Shopify business into one continuously updated view."
        />

        <motion.div
          {...riseIn(0.1, 40)}
          data-cursor="VIEW"
          className="lp-card relative mx-auto mt-14 max-w-[1280px] overflow-hidden md:mt-20"
        >
          <div aria-hidden className="pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-lp-violet/40 to-transparent" />

          <div className="grid lg:grid-cols-[220px_minmax(0,1fr)_250px] xl:grid-cols-[250px_minmax(0,1fr)_292px]">
            {/* LEFT: title and the Shopify signal sources. */}
            <div className="flex flex-col border-b border-lp-line p-5 md:p-6 lg:border-b-0 lg:border-r xl:p-7">
              <div className="flex items-center gap-2.5">
                <LiveDot reduced={reduced} />
                <h3 className="text-[17px] font-semibold tracking-[-0.01em] text-lp-text">Business Pulse</h3>
              </div>
              <p className="mt-1.5 text-[13.5px] leading-snug text-lp-muted">One view of what your store is doing.</p>

              <p className="lp-eyebrow mb-3 mt-6 lg:mt-9">Signal sources</p>
              <ul className="grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3 md:grid-cols-5 lg:grid-cols-1">
                {SOURCES.map((s, i) => {
                  const firstArrival = EVENTS.findIndex((e) => e.source === i);
                  return (
                    <li key={s.label} className="flex h-9 items-center gap-2.5 text-[14px] text-lp-text-2">
                      <s.icon aria-hidden className="size-4 shrink-0 text-lp-muted" strokeWidth={1.8} />
                      <span className="truncate">{s.label}</span>
                      <span aria-hidden className="relative ml-auto size-1.5 shrink-0">
                        <span className="absolute inset-0 rounded-full bg-lp-line-strong" />
                        <motion.span
                          className={`absolute inset-0 rounded-full ${TONE[s.tone].dot}`}
                          initial={false}
                          animate={arrived ? { opacity: 1, scale: reduced ? 1 : [1, 2.4, 1] } : { opacity: 0, scale: 1 }}
                          transition={at(ARRIVE_AT(firstArrival), { duration: 0.7, ease: EASE })}
                        />
                      </span>
                    </li>
                  );
                })}
              </ul>
              <div className="mt-6 hidden rounded-[14px] border border-lp-line bg-lp-surface/40 p-3.5 lg:mt-auto lg:block">
                <p className="flex items-center gap-2 font-lp-mono text-[10.5px] uppercase tracking-[0.14em] text-lp-text-2">
                  <Webhook aria-hidden className="size-3.5 text-lp-violet-bright" strokeWidth={1.8} />
                  Webhooks
                </p>
                <p className="mt-2 text-[12.5px] leading-relaxed text-lp-muted">
                  Shopify keeps this view current as orders, refunds and products change.
                </p>
              </div>
            </div>

            {/* CENTER: the timeline. Signals arrive, then regroup. */}
            <div className="min-w-0 p-5 md:p-6 xl:p-8">
              <div className="mb-4 flex items-center justify-between">
                <p className="lp-eyebrow">Signals</p>
                <div aria-hidden className="flex h-5 items-center gap-2 overflow-hidden font-lp-mono text-[11px] uppercase tracking-[0.14em] text-lp-text-2">
                  <span className={`size-1.5 rounded-full transition-colors duration-500 ${done ? "bg-lp-positive" : "bg-lp-violet"}`} />
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.span
                      key={phase}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      transition={{ duration: reduced ? 0 : 0.35, ease: EASE }}
                    >
                      {PHASE_LABEL[phase]}
                    </motion.span>
                  </AnimatePresence>
                </div>
              </div>

              <div ref={timelineRef} aria-hidden className="relative" style={{ height: TIMELINE_H }}>
                <TimelineGuides arrived={arrived} grouped={grouped} reduced={reduced} at={at} />

                {(Object.keys(GROUPS) as GroupId[]).map((g, gi) => (
                  <motion.div
                    key={g}
                    className="absolute left-7 right-0 flex items-center gap-2.5"
                    style={{ top: g === "sales" ? 0 : CUSTOMER_TOP, height: HEAD - 6 }}
                    initial={false}
                    animate={grouped ? { opacity: 1, x: 0 } : { opacity: 0, x: -10 }}
                    transition={at(0.35 + gi * 0.12)}
                  >
                    <span className={`size-1.5 rounded-full ${TONE[GROUPS[g].tone].dot}`} />
                    <span className="font-lp-mono text-[11px] uppercase tracking-[0.16em] text-lp-text-2">{GROUPS[g].label}</span>
                    <span className="h-px flex-1 bg-gradient-to-r from-lp-line-strong to-transparent" />
                  </motion.div>
                ))}

                {EVENTS.map((e, i) => (
                  <motion.div
                    key={e.title}
                    className="absolute left-7 right-0 top-0"
                    style={{ height: ROW }}
                    initial={false}
                    animate={{
                      opacity: arrived ? 1 : 0,
                      x: arrived ? 0 : -18,
                      y: grouped ? groupedY(e.group, e.slot) : streamY(i),
                    }}
                    transition={{
                      opacity: at(ARRIVE_AT(i), { duration: 0.6, ease: EASE }),
                      x: at(ARRIVE_AT(i), { duration: 0.8, ease: EASE }),
                      y: reduced ? { duration: 0 } : { type: "spring", stiffness: 70, damping: 17, mass: 0.9, delay: i * 0.05 },
                    }}
                  >
                    <EventRow event={e} arrival={ARRIVE_AT(i)} arrived={arrived} reduced={reduced} />
                  </motion.div>
                ))}
              </div>

              {/* Conclusion. The slot is reserved from the start so nothing shifts. */}
              <div className="relative mt-4 h-14">
                <div aria-hidden className="absolute inset-0 rounded-[16px] border border-dashed border-lp-line" />
                <motion.div
                  className="absolute inset-0 flex items-center gap-3 rounded-[16px] border border-lp-positive/25 bg-lp-positive/[0.07] px-4"
                  initial={false}
                  animate={done ? { opacity: 1, y: 0 } : { opacity: 0, y: 10 }}
                  transition={at(0, { duration: 0.7, ease: EASE })}
                >
                  <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full bg-lp-positive/15">
                    <svg viewBox="0 0 16 16" className="size-3.5" fill="none">
                      <motion.path
                        d="M3.5 8.5 6.6 11.4 12.5 4.8"
                        stroke="var(--lp-positive)"
                        strokeWidth={2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        initial={false}
                        animate={{ pathLength: done ? 1 : 0 }}
                        transition={at(0.25, { duration: 0.55, ease: EASE })}
                      />
                    </svg>
                  </span>
                  <p className="text-[15px] font-medium tracking-[-0.01em] text-lp-text">Business activity understood.</p>
                  <span aria-hidden className="ml-auto hidden font-lp-mono text-[11px] uppercase tracking-[0.14em] text-lp-muted sm:inline">
                    Sales · Customers
                  </span>
                </motion.div>
              </div>
              <SrOnly>
                Signals arrive one at a time: order received, checkout completed, refund processed, returning customer, product gaining
                momentum. bizinsights groups the order, refund and product signals as sales activity, and the checkout and returning
                customer signals as customer activity.
              </SrOnly>
            </div>

            {/* RIGHT: conceptual status. Shapes and words only, no figures. */}
            <div className="border-t border-lp-line p-5 md:p-6 lg:border-l lg:border-t-0 xl:p-7">
              <div className="mb-4 flex items-center justify-between gap-3">
                <p className="lp-eyebrow">Status</p>
                <IllustrativeNote />
              </div>
              <ul className="grid gap-2 md:grid-cols-2 md:gap-3 lg:grid-cols-1">
                {STATUS.map((s, i) => (
                  <StatusCard key={s.label} card={s} index={i} arrived={arrived} grouped={grouped} done={done} at={at} reduced={reduced} />
                ))}
              </ul>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}

type At = (delay: number, base?: Transition) => Transition;

/** The one thing that keeps moving once the sequence has settled (a CSS loop, held while off screen). */
function LiveDot({ reduced }: { reduced: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  usePauseWhenHidden(ref);
  return (
    <span ref={ref} data-lp-paused="" aria-hidden className="relative flex size-2.5">
      {!reduced && <span className="lp-loop lp-ping absolute inset-0 rounded-full bg-lp-positive" />}
      <span className="relative size-2.5 rounded-full bg-lp-positive" />
    </span>
  );
}

/**
 * The timeline's left gutter: while signals stream it is a single spine with a node per signal;
 * when bizinsights groups them the spine gives way to two brackets that gather each group under its label.
 */
function TimelineGuides({ arrived, grouped, reduced, at }: { arrived: boolean; grouped: boolean; reduced: boolean; at: At }) {
  const spineTop = streamY(0) + ROW / 2;
  const spineBottom = streamY(EVENTS.length - 1) + ROW / 2;
  const bracket = (group: GroupId, slots: number) => {
    const top = group === "sales" ? 0 : CUSTOMER_TOP;
    const labelY = top + (HEAD - 6) / 2;
    const lastY = groupedY(group, slots - 1) + ROW / 2;
    return `M 24 ${labelY} H ${SPINE_X + 6} Q ${SPINE_X} ${labelY} ${SPINE_X} ${labelY + 6} V ${lastY}`;
  };
  return (
    <svg className="absolute left-0 top-0 w-6 overflow-visible" style={{ height: TIMELINE_H }} viewBox={`0 0 24 ${TIMELINE_H}`} fill="none">
      <motion.line
        x1={SPINE_X}
        x2={SPINE_X}
        y1={spineTop}
        y2={spineBottom}
        stroke="var(--lp-line-strong)"
        strokeWidth={1}
        initial={false}
        animate={{ pathLength: arrived ? 1 : 0, opacity: grouped ? 0 : 1 }}
        transition={{
          pathLength: at(ARRIVE_AT(0), { duration: ARRIVE_AT(EVENTS.length - 1), ease: "linear" }),
          opacity: at(0, { duration: 0.4, ease: EASE }),
        }}
      />
      {(["sales", "customers"] as const).map((g, gi) => (
        <motion.path
          key={g}
          d={bracket(g, g === "sales" ? 3 : 2)}
          stroke={g === "sales" ? "var(--lp-primary)" : "var(--lp-cyan)"}
          strokeOpacity={0.7}
          strokeWidth={1.25}
          strokeLinecap="round"
          initial={false}
          animate={{ pathLength: grouped ? 1 : 0, opacity: grouped ? 1 : 0 }}
          transition={at(0.3 + gi * 0.12, { duration: 0.9, ease: EASE })}
        />
      ))}
      {EVENTS.map((e, i) => {
        const tone = TONE[e.tone];
        return (
          <motion.circle
            key={e.title}
            cx={SPINE_X}
            r={3}
            fill="var(--lp-bg-main)"
            stroke={tone.stroke}
            strokeWidth={1.5}
            initial={false}
            animate={{
              cy: (grouped ? groupedY(e.group, e.slot) : streamY(i)) + ROW / 2,
              opacity: arrived ? 1 : 0,
              scale: arrived ? 1 : 0.4,
            }}
            transition={{
              cy: reduced ? { duration: 0 } : { type: "spring", stiffness: 70, damping: 17, mass: 0.9, delay: i * 0.05 },
              opacity: at(ARRIVE_AT(i), { duration: 0.5, ease: EASE }),
              scale: at(ARRIVE_AT(i), { duration: 0.5, ease: EASE }),
            }}
          />
        );
      })}
    </svg>
  );
}

function EventRow({ event, arrival, arrived, reduced }: { event: (typeof EVENTS)[number]; arrival: number; arrived: boolean; reduced: boolean }) {
  const tone = TONE[event.tone];
  return (
    <div className="relative flex h-full items-center gap-2.5 overflow-hidden rounded-[14px] border border-lp-line bg-lp-surface/70 pl-2.5 pr-3 sm:gap-3 sm:pr-3.5">
      {/* One light sweep as the signal lands. */}
      {!reduced && (
        <motion.span
          className="pointer-events-none absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r from-transparent via-white/[0.06] to-transparent"
          initial={false}
          animate={arrived ? { x: ["-100%", "260%"] } : { x: "-100%" }}
          transition={{ duration: 1.1, ease: EASE, delay: arrival + 0.1 }}
        />
      )}
      <span className={`grid size-9 shrink-0 place-items-center rounded-[10px] border ${tone.tile} ${tone.text}`}>
        <event.icon className="size-4" strokeWidth={1.9} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-lp-mono text-[10px] uppercase leading-none tracking-[0.16em] text-lp-muted">{event.kind}</span>
        <span className="mt-1.5 block truncate text-[14px] leading-none tracking-[-0.01em] text-lp-text md:text-[15px]">{event.title}</span>
      </span>
      {/* Dropped on narrow phones so "Product gaining momentum" never truncates. */}
      <span className={`size-1.5 shrink-0 rounded-full ${tone.dot} opacity-60 max-sm:hidden`} />
    </div>
  );
}

function StatusCard({
  card,
  index,
  arrived,
  grouped,
  done,
  at,
  reduced,
}: {
  card: (typeof STATUS)[number];
  index: number;
  arrived: boolean;
  grouped: boolean;
  done: boolean;
  at: At;
  reduced: boolean;
}) {
  const tone = TONE[card.tone];
  const fedAt = ARRIVE_AT(card.feeds[0]) + 0.25;
  return (
    // Phones: one row (label · trace · state). Tablet and up: label and state on top, trace below.
    <li className="grid grid-cols-[88px_minmax(0,1fr)_auto] items-center gap-x-4 rounded-[16px] border border-lp-line bg-lp-surface/50 px-4 py-3 md:grid-cols-[minmax(0,1fr)_auto] md:gap-y-3 md:p-4">
      <div className="flex min-w-0 items-center gap-2">
        <motion.span
          aria-hidden
          className={`size-1.5 shrink-0 rounded-full ${tone.dot}`}
          initial={false}
          animate={arrived ? { opacity: 1, scale: reduced ? 1 : [1, 2.2, 1] } : { opacity: 0.25, scale: 1 }}
          transition={at(fedAt, { duration: 0.7, ease: EASE })}
        />
        <h3 className="truncate text-[14px] font-medium text-lp-text-2">{card.label}</h3>
      </div>
      {/* Revealed with a clip, not pathLength: dash maths breaks under non-scaling strokes. */}
      <motion.svg
        aria-hidden
        viewBox="0 0 96 28"
        className="h-7 w-full md:col-span-2 md:row-start-2 md:h-9"
        preserveAspectRatio="none"
        fill="none"
        initial={false}
        animate={{ clipPath: grouped ? "inset(0% 0% 0% 0%)" : "inset(0% 100% 0% 0%)" }}
        transition={at(0.2 + index * 0.1, { duration: 1.1, ease: EASE })}
      >
        <defs>
          <linearGradient id={`pulse-fill-${index}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={tone.stroke} stopOpacity="0.22" />
            <stop offset="1" stopColor={tone.stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
        <line x1="2" x2="94" y1="26.5" y2="26.5" stroke="var(--lp-line-strong)" strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />
        <path d={`${card.path} L 94 27 L 2 27 Z`} fill={`url(#pulse-fill-${index})`} />
        <path d={card.path} stroke={tone.stroke} strokeWidth={1.75} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </motion.svg>
      <div className="relative h-5 min-w-[64px] md:col-start-2 md:row-start-1">
        <motion.span
          aria-hidden
          className="absolute right-0 top-1/2 h-2 w-12 -translate-y-1/2 rounded-full bg-lp-line-strong"
          initial={false}
          animate={{ opacity: done ? 0 : 1 }}
          transition={at(index * 0.08, { duration: 0.4, ease: EASE })}
        />
        <motion.p
          className={`absolute inset-0 flex items-center justify-end text-[14px] font-medium tracking-[-0.01em] ${tone.text}`}
          initial={false}
          animate={done ? { opacity: 1, y: 0 } : { opacity: 0, y: 6 }}
          transition={at(0.15 + index * 0.08, { duration: 0.6, ease: EASE })}
        >
          {card.state}
        </motion.p>
      </div>
    </li>
  );
}
