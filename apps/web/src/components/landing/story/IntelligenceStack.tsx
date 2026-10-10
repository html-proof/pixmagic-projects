"use client";
import {
  motion,
  useMotionValue,
  useTransform,
  type MotionValue,
} from "motion/react";
import { easeInOut, easeOut, segment } from "@/lib/motion";
import {
  ConversionVisual,
  CustomerVisual,
  RevenueVisual,
  SalesVisual,
} from "./SignalsToDecisionsVisuals";

type CardId = "sales" | "conversion" | "customers" | "revenue";

interface IntelligenceCardData {
  id: CardId;
  number: string;
  title: string;
  copy: string;
  /** Real dashboard dimensions behind the card, listed under the copy on larger screens. */
  facets: readonly string[];
  /** Screen-reader description of the conceptual visual. */
  description: string;
  accent: string;
}

export const INTELLIGENCE_CARDS: readonly IntelligenceCardData[] = [
  {
    id: "sales",
    number: "01",
    title: "Sales Intelligence",
    copy: "See how revenue, orders and average order value move across any time period.",
    facets: [
      "Gross and net sales",
      "Orders and average order value",
      "Against the previous period",
    ],
    description:
      "Illustrative line chart: this period's sales line draws itself across the week and finishes above a dashed line for the previous period.",
    accent: "#A798FF",
  },
  {
    id: "conversion",
    number: "02",
    title: "Conversion Intelligence",
    copy: "Follow visits from first view to purchase and see the step where they stop.",
    facets: [
      "Five-step shopping funnel",
      "Where visits left the store",
      "Storefront visits from the web pixel",
    ],
    description:
      "Illustrative shopping funnel: visit, product, cart, checkout, purchase. Each step lights up in turn while the visits that leave peel away; the biggest drop is between cart and checkout.",
    accent: "#5EA6FF",
  },
  {
    id: "customers",
    number: "03",
    title: "Customer Intelligence",
    copy: "See who buys for the first time, who comes back, and where they come from.",
    facets: [
      "New and returning customers",
      "Sales by channel",
      "No names or emails stored",
    ],
    description:
      "Illustrative customer dots: one mixed group splits into new and returning customers, then regroups by sales channel, online store and point of sale.",
    accent: "#65D8D0",
  },
  {
    id: "revenue",
    number: "04",
    title: "Revenue Intelligence",
    copy: "Gross sales, less discounts and refunds: what you actually kept, before tax and shipping.",
    facets: ["Gross sales", "Discounts and refunds", "Net sales"],
    description:
      "Illustrative breakdown: a gross sales bar loses a discounts piece and a refunds piece, leaving a shorter net sales bar, before tax and shipping.",
    accent: "#58D39B",
  },
];

const LAST = INTELLIGENCE_CARDS.length - 1;

/*
 * Choreography, as fractions of the pinned runway (0 = pinned, 1 = released):
 *   card 01 is already in place (its chart draws while the sheet rises over the hero),
 *   card 02 enters .12–.30, card 03 .42–.60, card 04 .70–.86.
 * Each visual starts once its card is ~85% landed and finishes a beat before the next card
 * starts covering it, so no stage plays out underneath another card (CARD_VISUAL).
 */
const CARD_ENTER: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.12, 0.3],
  [0.42, 0.6],
  [0.7, 0.86],
];
const CARD_VISUAL: readonly (readonly [number, number])[] = [
  [0, 0.1],
  [0.2, 0.4],
  [0.5, 0.7],
  [0.78, 0.96],
];

/** 0 → 1 as card `i` slides up into the stack. */
export function cardEnter(p: number, i: number) {
  return i === 0 ? 1 : segment(p, CARD_ENTER[i][0], CARD_ENTER[i][1]);
}

/** How many cards (continuously) sit on top of card `i`: drives its scale-down and lift. */
function cardDepth(p: number, i: number) {
  let d = 0;
  for (let j = i + 1; j <= LAST; j++) d += cardEnter(p, j);
  return d;
}

/**
 * Card `i`'s own 0..1 visual progress. The first card draws mostly while the section rises
 * (`arrival`: runway top from the viewport bottom to the top), then settles in the first
 * moments of the pinned scroll.
 */
export function cardVisual(p: number, arrival: number, i: number) {
  // Finished just before the stack pins, so the complete chart (with its end tag) holds on
  // screen for the first stretch of the pinned scroll instead of finishing under card 02.
  if (i === 0)
    return Math.max(segment(arrival, 0.3, 0.92), segment(p, 0, 0.04));
  return segment(p, CARD_VISUAL[i][0], CARD_VISUAL[i][1]);
}

/** 0..1 "this is the card in front" weight, for the progress list beside the stack. */
export function cardActive(p: number, i: number) {
  const mid = (k: number) => (CARD_ENTER[k][0] + CARD_ENTER[k][1]) / 2;
  const on = i === 0 ? 1 : segment(p, mid(i) - 0.03, mid(i) + 0.03);
  const off = i === LAST ? 0 : segment(p, mid(i + 1) - 0.03, mid(i + 1) + 0.03);
  return on * (1 - off);
}

/*
 * Stack geometry lives in CSS variables on the stack (see IntelligenceStack) so phones can use
 * tighter offsets than desktop:
 *   --stack-edge  each card sits this much lower than the one before it,
 *   --stack-lift  each covered card lifts this much per card stacked on it,
 *   --stack-head  room above card 01 for its full lift (3 × lift), so no edge is ever clipped.
 * The visible rim of a covered card is edge + lift: enough to show its number row whole.
 */
const SHRINK = 0.04;

const CARD_SHADOW =
  "inset 0 1px 0 rgb(255 255 255 / 0.07), 0 -18px 48px -26px rgb(0 0 0 / 0.75), var(--lp-card-shadow)";
/**
 * `lp-card`'s gradient is slightly translucent (its colour-mix weights add up to 94%), which let
 * the covered card's text ghost through the one in front. An opaque base colour underneath it.
 */
const CARD_BASE = "#12161C";

/*
 * In the stack, laptops (lg, 1024–1279) get a single-column card: the card column there is only
 * ~540px wide, which squeezed the visual into a ~250px strip beside the text. Text sits on top,
 * the visual takes the full width underneath (as on phones), and the facets are dropped. The
 * facets also need a tall enough viewport, because the stacked card's height follows it.
 */
const STACK_CARD = "h-full lg:flex xl:grid";
const STACK_VISUAL =
  "flex-1 lg:px-2.5 lg:pb-2.5 lg:pt-0 xl:py-3 xl:pl-0 xl:pr-3";
const STACK_FACETS =
  "[@media(min-width:768px)_and_(max-width:1023px)_and_(min-height:701px)]:block [@media(min-width:1280px)_and_(min-height:701px)]:block";

function CardVisual({
  id,
  progress,
}: {
  id: CardId;
  progress: MotionValue<number>;
}) {
  switch (id) {
    case "sales":
      return <SalesVisual progress={progress} />;
    case "conversion":
      return <ConversionVisual progress={progress} />;
    case "customers":
      return <CustomerVisual progress={progress} />;
    case "revenue":
      return <RevenueVisual progress={progress} />;
  }
}

function IntelligenceCard({
  card,
  progress,
  shade,
  dim,
  layout,
}: {
  card: IntelligenceCardData;
  progress: MotionValue<number>;
  shade?: MotionValue<number>;
  /** Opacity of the card's body once another card covers it; its number row stays as the visible rim. */
  dim?: MotionValue<number>;
  layout: "stack" | "list";
}) {
  const titleId = `signals-card-${card.id}`;
  const stack = layout === "stack";
  return (
    <article
      aria-labelledby={titleId}
      className={`lp-card relative flex flex-col overflow-hidden md:grid md:grid-cols-[minmax(0,0.84fr)_minmax(0,1fr)] ${stack ? STACK_CARD : "md:h-[460px]"}`}
      style={{ boxShadow: CARD_SHADOW, backgroundColor: CARD_BASE }}
    >
      <div
        className={`relative flex flex-col px-5 pb-4 md:px-7 md:pb-7 xl:px-9 ${stack ? "pt-4 md:pt-6 lg:pb-4" : "pt-5 md:pt-7 xl:pt-9"}`}
      >
        {/* In the stack this row is the part of a covered card that stays visible, so it is kept short. */}
        <div className="flex h-4 items-center gap-3">
          <span
            className="font-lp-mono text-[12px] font-medium tracking-[0.16em]"
            style={{ color: card.accent }}
          >
            {card.number}
          </span>
          <span
            aria-hidden
            className="h-px flex-1 bg-linear-to-r from-lp-line-strong to-transparent"
          />
        </div>
        <motion.div className="flex flex-1 flex-col" style={{ opacity: dim }}>
          <h3
            id={titleId}
            className={`lp-title text-balance ${stack ? "mt-3 md:mt-7 lg:mt-4 xl:mt-9" : "mt-3.5 md:mt-6"}`}
          >
            {card.title}
          </h3>
          <p className="mt-2 max-w-[36ch] text-pretty text-[15px] leading-[1.55] text-lp-text-2 md:mt-4 md:text-[16px]">
            {card.copy}
          </p>
          {/* In the pinned stack the card height follows the viewport, so short screens drop the facets. */}
          <ul
            className={`mt-auto hidden pt-6 ${stack ? STACK_FACETS : "md:block"}`}
          >
            {card.facets.map((f) => (
              <li
                key={f}
                className="flex items-center gap-2.5 border-t border-lp-line py-2.5 font-lp-mono text-[10.5px] uppercase tracking-[0.14em] text-lp-muted"
              >
                <span
                  aria-hidden
                  className="size-1 shrink-0 rounded-full"
                  style={{ background: card.accent }}
                />
                {f}
              </li>
            ))}
          </ul>
        </motion.div>
      </div>

      <motion.div
        className={`relative min-h-0 px-2.5 pb-2.5 md:py-3 md:pl-0 md:pr-3 ${stack ? STACK_VISUAL : "h-[300px] md:h-auto"}`}
        style={{ opacity: dim }}
      >
        <div
          data-cursor="EXPLORE"
          role="img"
          aria-label={card.description}
          className="relative h-full overflow-hidden rounded-[18px] border border-lp-line bg-lp-bg/70 p-4 md:p-5"
        >
          <div
            aria-hidden
            className="lp-grid pointer-events-none absolute inset-0 [mask-image:radial-gradient(120%_90%_at_70%_40%,black,transparent_75%)]"
          />
          <div aria-hidden className="relative h-full">
            <CardVisual id={card.id} progress={progress} />
          </div>
        </div>
      </motion.div>

      {shade && (
        <motion.div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-lp-bg"
          style={{ opacity: shade }}
        />
      )}
    </article>
  );
}

function StackedCard({
  card,
  index,
  progress,
  arrival,
}: {
  card: IntelligenceCardData;
  index: number;
  progress: MotionValue<number>;
  arrival: MotionValue<number>;
}) {
  const enter = useTransform(progress, (p) => cardEnter(p, index));
  const depth = useTransform(progress, (p) => cardDepth(p, index));
  // The incoming card starts fully below the pinned viewport (card height + 22svh clears the
  // space under the stack at every breakpoint) and slides up solid: no translucent phase in
  // which the card underneath ghosts through it, and no sliver parked at the bottom edge.
  const y = useTransform(
    enter,
    (e) => `calc((var(--card-h) + 22svh) * ${1 - easeOut(e)})`,
  );
  const rotateX = useTransform(enter, (e) => (1 - easeOut(e)) * 7);
  const lift = useTransform(depth, (d) => `calc(var(--stack-lift) * ${-d})`);
  const scale = useTransform(depth, (d) => 1 - d * SHRINK);
  const shade = useTransform(depth, (d) => Math.min(0.42, d * 0.16));
  // A covered card keeps only its rim and number row legible; its body fades once the next card
  // is most of the way over it (not while it is still on show).
  const dim = useTransform(
    depth,
    (d) => 1 - 0.94 * easeInOut(segment(d, 0.3, 0.8)),
  );
  const visual = useTransform([progress, arrival], (v: number[]) =>
    cardVisual(v[0], v[1], index),
  );
  // A card still sliding in must not catch the cursor ("EXPLORE") meant for the card it covers.
  const pointerEvents = useTransform(enter, (e) => (e > 0.2 ? "auto" : "none"));

  return (
    <motion.div
      className="absolute inset-x-0 will-change-transform"
      style={{
        top: `calc(var(--stack-head) + var(--stack-edge) * ${index})`,
        zIndex: index + 1,
        y,
        rotateX,
        pointerEvents,
        transformPerspective: 1600,
        transformOrigin: "50% 0%",
      }}
    >
      <motion.div
        className="h-[var(--card-h)] will-change-transform"
        style={{ y: lift, scale, transformOrigin: "50% 0%" }}
      >
        <IntelligenceCard
          card={card}
          progress={visual}
          shade={shade}
          dim={dim}
          layout="stack"
        />
      </motion.div>
    </motion.div>
  );
}

/**
 * The four cards as a scroll-driven stack. Lives inside the sticky viewport of the section's
 * runway; `progress` is the runway progress, `arrival` the section's rise before it pins.
 * Card height is a CSS variable so each breakpoint can fit the stack under the nav.
 */
export function IntelligenceStack({
  progress,
  arrival,
}: {
  progress: MotionValue<number>;
  arrival: MotionValue<number>;
}) {
  return (
    <div className="relative h-[calc(var(--card-h)_+_var(--stack-head)_+_var(--stack-edge)_*_3)] w-full [--card-h:min(600px,calc(100svh_-_186px))] [--stack-edge:20px] [--stack-head:36px] [--stack-lift:12px] md:[--card-h:min(560px,calc(100svh_-_250px))] md:[--stack-edge:26px] md:[--stack-head:54px] md:[--stack-lift:18px] lg:[--card-h:min(560px,72svh,calc(100svh_-_250px))]">
      {INTELLIGENCE_CARDS.map((card, i) => (
        <StackedCard
          key={card.id}
          card={card}
          index={i}
          progress={progress}
          arrival={arrival}
        />
      ))}
    </div>
  );
}

/** Reduced motion: the same four cards in a plain list, every visual in its final state. */
export function IntelligenceList({ className = "" }: { className?: string }) {
  const done = useMotionValue(1);
  return (
    <div className={`flex flex-col gap-5 md:gap-6 ${className}`}>
      {INTELLIGENCE_CARDS.map((card) => (
        <IntelligenceCard
          key={card.id}
          card={card}
          progress={done}
          layout="list"
        />
      ))}
    </div>
  );
}
