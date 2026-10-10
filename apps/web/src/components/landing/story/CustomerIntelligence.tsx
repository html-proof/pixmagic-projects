"use client";
import { motion, useTransform, type MotionValue } from "motion/react";
import { useRef } from "react";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { useScrollProgress } from "@/hooks/useScrollProgress";
import { riseIn, segment } from "@/lib/motion";
import { IllustrativeNote, SectionIntro } from "../shared/ui";
import { CustomerDots, CustomerLensMultiples, LENSES, LENS_STAGES } from "./CustomerDots";

const TITLE_ID = "customer-intelligence-title";

const DESCRIPTION =
  "Illustration: hundreds of dots, each a customer, start scattered. They then gather into two groups, new and returning customers; " +
  "regroup by sales channel: online store, point of sale, draft orders and other apps; " +
  "and finally regroup by when they buy: morning, afternoon, evening and night. Group sizes are illustrative.";

/**
 * Section E1. The same customers, regrouped three ways as you scroll, so the idea lands
 * without a chart: one audience is really several. Only dimensions the dashboard actually
 * reports are used (new vs returning, sales channel, time of purchase).
 */
export function CustomerIntelligence() {
  const reduced = useReducedMotion();
  const runway = useRef<HTMLDivElement>(null);
  const progress = useScrollProgress(runway);

  return (
    <section aria-labelledby={TITLE_ID} className="relative isolate bg-lp-bg-2">
      {/*
        Edge blends are owned by one side only, so no seam appears where two fades meet: the
        journey runway above already fades into lp-bg-2 (its static reduced-motion version does
        not, hence the fade here only then), and the profit scene below fades in from lp-bg-2.
      */}
      {reduced && (
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-48 bg-gradient-to-b from-lp-bg to-transparent" />
      )}

      <div className="mx-auto max-w-[1380px] px-4 md:px-8 xl:px-12">
        {reduced ? (
          <div ref={runway} className="pb-28 pt-28 md:pb-36 md:pt-40">
            <Intro />
            <div className="mt-14 md:mt-16">
              <CustomerLensMultiples />
            </div>
          </div>
        ) : (
          <div className="lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-12 xl:gap-16">
            <div className="pb-2 pt-28 md:pt-40 lg:pb-0 lg:pt-0">
              <div className="lg:sticky lg:top-0 lg:flex lg:h-svh lg:flex-col lg:justify-center lg:pt-20">
                <Intro />
              </div>
            </div>

            <div ref={runway} className="relative h-[280vh] md:h-[300vh] lg:h-[320vh]">
              <div className="sticky top-0 flex h-svh flex-col pb-6 pt-24 md:pb-10 md:pt-28 lg:pb-12 lg:pt-32">
                <LensIndicator progress={progress} />
                <div role="img" aria-label={DESCRIPTION} className="relative mt-4 min-h-0 flex-1 md:mt-6">
                  {/* A faint technical grid behind the field only, fading out at the edges. */}
                  <div
                    aria-hidden
                    className="lp-grid absolute inset-0 opacity-70 [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_72%)]"
                  />
                  <CustomerDots progress={progress} />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function Intro() {
  return (
    <>
      <SectionIntro
        id={TITLE_ID}
        eyebrow="Customers"
        title={<span className="block lg:text-[clamp(44px,4.4vw,76px)]">Not every customer behaves the same.</span>}
        lead="Understand who buys, who returns and which audiences create long-term value."
      />
      <motion.div {...riseIn(0.25)} className="mt-8 flex flex-col items-start gap-3 md:mt-10">
        <IllustrativeNote />
        <p className="max-w-md text-[14px] leading-relaxed text-lp-muted">
          Groups and sizes are illustrative. Insight shows new and returning customers, sales by channel and when customers
          buy.
        </p>
      </motion.div>
    </>
  );
}

/** Where each lens's underline fills, in runway progress. */
const FILL_SPANS: readonly (readonly [number, number])[] = [
  [LENS_STAGES[0][0], LENS_STAGES[1][0]],
  [LENS_STAGES[1][0], LENS_STAGES[2][0]],
  [LENS_STAGES[2][0], 0.98],
];

/**
 * Three tab-like labels naming the current grouping. Purely presentational (progress drives
 * them, they are not controls), so they are hidden from assistive tech; the description says it.
 */
function LensIndicator({ progress }: { progress: MotionValue<number> }) {
  return (
    <div aria-hidden className="grid grid-cols-3 gap-3 md:gap-5">
      {LENSES.map((lens, i) => (
        <LensTab key={lens.name} name={lens.name} index={i} progress={progress} />
      ))}
    </div>
  );
}

function LensTab({ name, index, progress }: { name: string; index: number; progress: MotionValue<number> }) {
  const [a, b] = FILL_SPANS[index];
  const fill = useTransform(progress, (p) => segment(p, a, b));
  // Active from the middle of its own transition until the middle of the next one.
  const active = useTransform(progress, (p) => {
    const [s0, e0] = LENS_STAGES[index];
    const next = LENS_STAGES[index + 1];
    const on = segment(p, s0 + (e0 - s0) * 0.3, s0 + (e0 - s0) * 0.6);
    const off = next ? segment(p, next[0] + (next[1] - next[0]) * 0.3, next[0] + (next[1] - next[0]) * 0.6) : 0;
    return on * (1 - off);
  });
  const color = useTransform(active, [0, 1], ["#7d8693", "#f7f9fc"]);
  const numberColor = useTransform(active, [0, 1], ["#7d8693", "#a798ff"]);

  return (
    <div className="relative pb-3">
      <motion.span style={{ color: numberColor }} className="block font-lp-mono text-[10.5px] tracking-[0.16em]">
        0{index + 1}
      </motion.span>
      <motion.span style={{ color }} className="mt-1 block text-[12.5px] font-medium leading-tight md:text-[14px]">
        {name}
      </motion.span>
      <span className="absolute inset-x-0 bottom-0 h-px overflow-hidden bg-lp-line">
        <motion.span className="absolute inset-0 origin-left bg-lp-violet-bright/80" style={{ scaleX: fill }} />
      </span>
    </div>
  );
}
