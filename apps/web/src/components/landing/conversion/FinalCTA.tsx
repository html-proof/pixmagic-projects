"use client";
import { motion, useMotionValue, useSpring, useTransform, type MotionValue } from "motion/react";
import { useEffect, useRef } from "react";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { useScrollProgress } from "@/hooks/useScrollProgress";
import { useViewportPerformance } from "@/hooks/useViewportPerformance";
import { easeInOut, easeOut, segment } from "@/lib/motion";
import { InsightMark } from "../shared/InsightMark";
import { LoginPrompt, SignupButton } from "../shared/ui";
import { CONVERGE, ConvergeCanvas } from "./ConvergeCanvas";

/** Desktop point count; scaled by the device budget. */
const POINTS = 1600;

/** Text beats, as the resolved mark rises to make room; everything is in by 0.8 and then holds. */
const TEXT = {
  heading: [0.6, 0.72],
  lead: [0.63, 0.76],
  actions: [0.66, 0.8],
} as const;

/** How much larger the mark is while it forms alone at the centre of the screen. */
const CENTRE_ZOOM = 0.28;

/**
 * Fade-and-rise for one text beat. `forced` (set when keyboard focus enters the scene) shows
 * everything at once, so nobody can tab onto a button that is still invisible.
 */
function useBeat(p: MotionValue<number>, forced: MotionValue<number>, [a, b]: readonly [number, number]) {
  const k = useTransform([p, forced], ([v, f]: number[]) => Math.max(f, easeOut(segment(v, a, b))));
  const y = useTransform(k, (v) => (1 - v) * 22);
  // Invisible links must not catch clicks or the custom cursor's "OPEN" state.
  const pointerEvents = useTransform(k, (v): "auto" | "none" => (v > 0.5 ? "auto" : "none"));
  return { opacity: k, y, pointerEvents };
}

/**
 * G2 — the final conversion scene. Thousands of faint data points fill the screen, then gather
 * into the Insights mark at the centre of the screen as the visitor scrolls; the mark resolves,
 * crisp and calm, then rises into place as the closing line and the sign-up action appear
 * beneath it. Reduced motion: the mark, the copy and the actions, still.
 */
export function FinalCTA() {
  const section = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const { particleScale, maxDpr } = useViewportPerformance();

  const scroll = useScrollProgress(section, ["start 0.4", "end end"]);
  const progress = useSpring(scroll, { stiffness: 120, damping: 28, mass: 0.5 });
  const forced = useMotionValue(0);
  /** Distance (px) from the mark's resting place down to the optical centre of the screen. */
  const centreGap = useMotionValue(0);

  useEffect(() => {
    if (reduced) return;
    const measure = () => {
      const st = stage.current;
      const sl = slot.current;
      if (!st || !sl) return;
      const a = st.getBoundingClientRect();
      const b = sl.getBoundingClientRect();
      // Slightly below true centre, to balance the floating nav above.
      centreGap.set(a.height * 0.5 + 24 - (b.top + b.height / 2 - a.top));
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (stage.current) ro.observe(stage.current);
    if (column.current) ro.observe(column.current);
    void document.fonts?.ready.then(measure);
    return () => ro.disconnect();
  }, [reduced, centreGap]);

  const rise = useTransform([progress, forced], ([v, f]: number[]) => Math.max(f, easeInOut(segment(v, CONVERGE.rise[0], CONVERGE.rise[1]))));
  const lift = useTransform([centreGap, rise], ([g, r]: number[]) => g * (1 - r));
  const zoom = useTransform(rise, (r) => 1 + CENTRE_ZOOM * (1 - r));
  const markIn = useTransform(progress, (v) => easeOut(segment(v, CONVERGE.resolve[0], CONVERGE.resolve[1])));
  const markScale = useTransform(markIn, (v) => 0.94 + 0.06 * v);
  const glow = useTransform(progress, (v) => 0.15 + 0.85 * easeOut(segment(v, CONVERGE.travel[0] + 0.3, CONVERGE.resolve[1])));
  const heading = useBeat(progress, forced, TEXT.heading);
  const lead = useBeat(progress, forced, TEXT.lead);
  const actions = useBeat(progress, forced, TEXT.actions);

  return (
    <section
      ref={section}
      aria-labelledby="final-cta-title"
      className={reduced ? "relative bg-lp-bg" : "relative h-[200vh] bg-lp-bg md:h-[220vh] xl:h-[240vh]"}
    >
      <div ref={stage} className={reduced ? "relative" : "sticky top-0 h-svh overflow-hidden"}>
        {!reduced && (
          <ConvergeCanvas
            progress={progress}
            count={POINTS * particleScale}
            slotRef={slot}
            lift={lift}
            zoom={zoom}
            maxDpr={maxDpr}
            className="absolute inset-0 size-full"
          />
        )}
        {/* Edge vignette keeps the field from reading as a flat texture and blends into the footer. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_75%_70%_at_50%_45%,transparent_40%,rgb(8_10_13/0.85)_100%)]"
        />
        {/* Top and bottom fades so the field never starts or ends on a visible line of points. */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-lp-bg to-transparent" />
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-lp-bg to-transparent" />

        <div
          ref={column}
          className={`relative mx-auto flex max-w-[1380px] flex-col items-center px-4 text-center md:px-8 xl:px-12 ${
            reduced ? "py-32 md:py-40" : "h-full justify-center pb-10 pt-20 md:pt-24"
          }`}
          onFocusCapture={() => forced.set(1)}
        >
          {/* The slot never moves (the canvas measures it); the mark inside it lifts and zooms. */}
          <div ref={slot} className="relative size-[clamp(112px,20svh,216px)] shrink-0 text-lp-text">
            <motion.div className="absolute inset-0" style={reduced ? undefined : { y: lift, scale: zoom }}>
              <motion.div
                aria-hidden
                className="pointer-events-none absolute -inset-[70%] rounded-full bg-[radial-gradient(closest-side,rgb(140_123_255/0.22),rgb(94_166_255/0.08)_45%,transparent_75%)]"
                style={reduced ? undefined : { opacity: glow }}
              />
              <motion.div className="relative size-full" style={reduced ? undefined : { opacity: markIn, scale: markScale }}>
                <InsightMark size={216} className="size-full" />
              </motion.div>
            </motion.div>
          </div>

          <motion.h2
            id="final-cta-title"
            className="lp-heading mt-8 text-balance md:mt-10"
            style={reduced ? undefined : heading}
          >
            See your business <span className="lp-gradient-text">clearly.</span>
          </motion.h2>
          <motion.p className="lp-lead mt-5 max-w-[34rem] text-pretty md:mt-6" style={reduced ? undefined : lead}>
            Connect your Shopify store and turn everyday commerce activity into decisions you can actually use.
          </motion.p>
          <motion.div className="mt-8 flex w-full flex-col items-center gap-5 md:mt-10" style={reduced ? undefined : actions}>
            <SignupButton size="lg" className="max-md:w-full max-md:max-w-[360px]">
              Create your Insights account
            </SignupButton>
            <LoginPrompt />
          </motion.div>
        </div>
      </div>
    </section>
  );
}
