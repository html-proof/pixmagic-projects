"use client";
import {
  motion,
  motionValue,
  useScroll,
  useSpring,
  useTransform,
  type MotionValue,
} from "motion/react";
import { useRef, useSyncExternalStore, type ReactNode } from "react";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { useScrollProgress } from "@/hooks/useScrollProgress";
import { easeInOut, easeOut } from "@/lib/motion";
import { IllustrativeNote, SectionIntro } from "../shared/ui";
import {
  INTELLIGENCE_CARDS,
  IntelligenceList,
  IntelligenceStack,
  cardActive,
  cardVisual,
} from "./IntelligenceStack";

const TITLE_ID = "signals-to-decisions-title";
/** Stand-in for `rise` on the static sheet, which does not animate. */
const STILL = motionValue(1);
const LEAD =
  "Insights follows the path of your business from first visit to final purchase, then reveals where growth is happening and where revenue is being lost.";

/**
 * Section C. A sheet that rises over the end of the hero runway (the hero shrinks into a
 * floating window underneath it), then pins and stacks four intelligence cards one over the
 * other, each card's visual playing as it lands.
 */
export function SignalsToDecisions() {
  // Motion's reduced-motion flag is already settled when this (lazily loaded) section hydrates,
  // so on its own it would render the static variant against the server's runway HTML and
  // break hydration. Hydrate as the runway first, then swap.
  const hydrated = useSyncExternalStore(noopSubscribe, isClient, isServer);
  const reduced = useReducedMotion() && hydrated;
  return reduced ? <SignalsStatic /> : <SignalsRunway />;
}

const noopSubscribe = () => () => {};
const isClient = () => true;
const isServer = () => false;

/**
 * Rounded sheet with a lit top edge and an upward shadow, so it reads as sliding over the hero.
 * While it rises (`rise` 0 → 1) the top of the sheet widens from a slightly inset panel to full
 * bleed and the light spreads along its edge: the new scene takes over the screen. Only the
 * top 100vh carries that motion (scaleX, compositor-only); nothing below it is on screen yet.
 */
function Sheet({
  overlap,
  rise,
  children,
}: {
  overlap: boolean;
  rise?: MotionValue<number>;
  children: ReactNode;
}) {
  const widen = useTransform(rise ?? STILL, (r) => 0.94 + 0.06 * easeInOut(r));
  const light = useTransform(rise ?? STILL, (r) => 0.35 + 0.65 * easeOut(r));
  const glow = useTransform(rise ?? STILL, (r) => 0.55 + 0.45 * r);
  return (
    <section
      aria-labelledby={TITLE_ID}
      className={`relative z-10 ${overlap ? "-mt-[30vh]" : ""}`}
    >
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <motion.div
          className="absolute inset-x-0 top-0 h-lvh rounded-t-[36px] bg-lp-bg-2 shadow-[inset_0_1px_0_rgb(255_255_255/0.14),0_-30px_80px_-10px_rgb(0_0_0/0.7)] will-change-transform max-md:rounded-t-[28px]"
          style={{ scaleX: rise ? widen : 1, transformOrigin: "50% 0%" }}
        >
          <div className="absolute inset-x-0 top-0 h-[460px] overflow-hidden rounded-t-[inherit]">
            <motion.div
              className="absolute inset-0 bg-[radial-gradient(55%_100%_at_50%_0%,rgb(140_123_255/0.13),transparent_70%)]"
              style={{ opacity: glow }}
            />
            <div className="lp-grid absolute inset-0 [mask-image:radial-gradient(60%_85%_at_50%_0%,black,transparent_80%)]" />
          </div>
          <motion.div
            className="absolute left-1/2 top-0 h-px w-[min(900px,80%)] -translate-x-1/2 bg-[linear-gradient(90deg,transparent,rgb(140_123_255/0.75)_30%,rgb(94_166_255/0.85)_50%,rgb(101_216_208/0.7)_70%,transparent)]"
            style={{ scaleX: light, opacity: light }}
          />
        </motion.div>
        <div className="absolute inset-x-0 bottom-0 top-[calc(100lvh_-_1px)] bg-lp-bg-2" />
      </div>
      <div className="relative">{children}</div>
      {/*
       * Ends on lp-bg-2: Business Pulse opens with its own lp-bg-2 → lp-bg hand-off, and a second
       * fade here left a dark band with a hard step where the two met.
       */}
      <div aria-hidden className="h-16 md:h-24" />
    </section>
  );
}

function Intro({ className = "" }: { className?: string }) {
  return (
    <SectionIntro
      id={TITLE_ID}
      eyebrow="Signals → Decisions"
      title={
        <>
          From signals to <span className="lp-gradient-text">decisions.</span>
        </>
      }
      lead={LEAD}
      className={`lg:[&_h2]:text-[length:clamp(40px,min(4.4vw,7.6svh),72px)] ${className}`}
    />
  );
}

function ProgressItem({
  index,
  progress,
  arrival,
}: {
  index: number;
  progress: MotionValue<number>;
  arrival: MotionValue<number>;
}) {
  const card = INTELLIGENCE_CARDS[index];
  const active = useTransform(progress, (p) => cardActive(p, index));
  const color = useTransform(active, [0, 1], ["#7D8693", "#F7F9FC"]);
  const fill = useTransform([progress, arrival], (v: number[]) =>
    cardVisual(v[0], v[1], index),
  );
  return (
    <li className="relative flex items-center gap-4 border-t border-lp-line py-3 last:border-b">
      <motion.span
        className="absolute inset-x-0 -top-px h-px origin-left"
        style={{
          scaleX: active,
          opacity: active,
          background: `linear-gradient(90deg, ${card.accent}, transparent)`,
        }}
      />
      <motion.span
        className="w-6 font-lp-mono text-[11.5px] tracking-[0.16em]"
        style={{ color }}
      >
        {card.number}
      </motion.span>
      <motion.span
        className="text-[15px] font-medium tracking-[-0.01em]"
        style={{ color }}
      >
        {card.title}
      </motion.span>
      <span className="ml-auto h-[2px] w-14 overflow-hidden rounded-full bg-lp-line">
        <motion.span
          className="block h-full origin-left rounded-full"
          style={{ scaleX: fill, background: card.accent }}
        />
      </span>
    </li>
  );
}

/**
 * Which card is in front, beside the stack (desktop). Purely a visual mirror of the cards'
 * own headings, so it is hidden from assistive technology.
 */
function ProgressRail({
  progress,
  arrival,
}: {
  progress: MotionValue<number>;
  arrival: MotionValue<number>;
}) {
  return (
    <ol
      aria-hidden
      className="mt-7 hidden max-w-[440px] lg:block [@media(min-height:780px)]:mt-11"
    >
      {INTELLIGENCE_CARDS.map((card, i) => (
        <ProgressItem
          key={card.id}
          index={i}
          progress={progress}
          arrival={arrival}
        />
      ))}
    </ol>
  );
}

function SignalsRunway() {
  const runway = useRef<HTMLDivElement>(null);
  const pinned = useScrollProgress(runway);
  // A light spring gives the stack a little physical inertia without lagging the scroll.
  const progress = useSpring(pinned, {
    stiffness: 260,
    damping: 42,
    mass: 0.5,
    restDelta: 0.0005,
  });
  const { scrollYProgress: arrival } = useScroll({
    target: runway,
    offset: ["start end", "start start"],
  });
  // The sheet's own rise: from its top edge entering at the bottom to it reaching ~15% from the top.
  const sheet = useRef<HTMLDivElement>(null);
  const { scrollYProgress: rise } = useScroll({
    target: sheet,
    offset: ["start end", "start 0.15"],
  });

  return (
    <Sheet overlap rise={rise}>
      <div ref={sheet} aria-hidden className="absolute inset-x-0 top-0 h-px" />
      <div className="relative mx-auto max-w-[1380px] px-4 md:px-8 lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-10 xl:gap-16 xl:px-12">
        <div className="pb-6 pt-20 md:pb-8 md:pt-28 lg:sticky lg:top-0 lg:flex lg:h-svh lg:flex-col lg:justify-center-safe lg:self-start lg:pb-10 lg:pt-28">
          <Intro />
          <ProgressRail progress={progress} arrival={arrival} />
          <IllustrativeNote className="mt-6 lg:mt-8">
            Illustrative shapes, not your data
          </IllustrativeNote>
        </div>
        <div ref={runway} className="relative h-[280vh] lg:h-[320vh]">
          <div className="sticky top-0 flex h-svh flex-col justify-center overflow-y-clip pb-2 pt-[76px] md:pb-4 md:pt-24">
            <IntelligenceStack progress={progress} arrival={arrival} />
          </div>
        </div>
      </div>
    </Sheet>
  );
}

/** Reduced motion: natural height, no pinning, cards listed with their finished visuals. */
function SignalsStatic() {
  return (
    <Sheet overlap={false}>
      <div className="relative mx-auto max-w-[1380px] px-4 pb-8 pt-24 md:px-8 md:pt-32 xl:px-12">
        <Intro />
        <IllustrativeNote className="mt-6">
          Illustrative shapes, not your data
        </IllustrativeNote>
        <IntelligenceList className="mt-12 md:mt-16" />
      </div>
    </Sheet>
  );
}
