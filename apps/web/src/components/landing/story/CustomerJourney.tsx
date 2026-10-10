"use client";
import { motion, useMotionValue, useTransform, type MotionValue } from "motion/react";
import { useRef } from "react";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { useScrollProgress } from "@/hooks/useScrollProgress";
import { IllustrativeNote } from "../shared/ui";
import {
  FINAL_WINDOW,
  GATES,
  JourneyVisual,
  QUESTION_WINDOWS,
  RUNWAY_FRAME,
  STAGES,
  STATIC_FRAME,
  cameraAt,
} from "./CustomerJourneyCanvas";

/**
 * The questions the journey answers, one per stretch of the camera move. "Which pages lose them?"
 * stands where a device question might go: Insight reports the site section and exit page where
 * visits leave, not devices.
 */
const QUESTIONS = [
  "Where are customers leaving?",
  "Which products lose them?",
  "Which pages lose them?",
  "Where does checkout slow down?",
] as const;

const GUTTER = "mx-auto max-w-[1380px] px-4 md:px-8 xl:px-12";
const GRID_MASK = "[mask-image:radial-gradient(ellipse_75%_55%_at_50%_62%,black_15%,transparent_75%)]";
/** Headline and message size, capped by viewport height so short laptop screens keep the stream clear. */
const MESSAGE_TYPE =
  "font-[550] leading-[0.98] tracking-[-0.045em] text-balance text-lp-text text-[clamp(30px,8.6vw,48px)] md:text-[clamp(40px,min(4.9vw,7.4svh),76px)]";

/**
 * Customer journey: a stream of shoppers through Discovery → Product → Cart → Checkout →
 * Purchase, visibly thinning as people leave at each gate. A sticky runway moves the camera along
 * the journey while questions appear one at a time, then pulls back to show every exit point.
 * Reduced motion gets a static diagram with every message listed.
 */
export function CustomerJourney() {
  const reduced = useReducedMotion();
  return reduced ? <JourneyStatic /> : <JourneyRunway />;
}

function JourneyRunway() {
  const ref = useRef<HTMLElement>(null);
  const progress = useScrollProgress(ref);
  // Gone just before the first question starts (QUESTION_WINDOWS[0][0]), so the two never overlap.
  const headOpacity = useTransform(progress, [0.045, 0.08], [1, 0]);
  const headY = useTransform(progress, [0.045, 0.08], [0, -32]);
  const finalOpacity = useTransform(progress, [...FINAL_WINDOW], [0, 1]);
  const finalY = useTransform(progress, [...FINAL_WINDOW], [32, 0]);
  const fadeToNext = useTransform(progress, [0.9, 1], [0, 1]);

  return (
    <section ref={ref} aria-labelledby="journey-title" className="relative h-[260vh] bg-lp-bg md:h-[300vh] xl:h-[320vh]">
      <div className="sticky top-0 h-svh overflow-hidden">
        <div aria-hidden className={`lp-grid pointer-events-none absolute inset-0 ${GRID_MASK}`} />
        {/* Soft side edges so labels and the stream slide in and out of view rather than being cut. */}
        <JourneyVisual
          progress={progress}
          frame={RUNWAY_FRAME}
          className="absolute inset-0 md:landscape:[mask-image:linear-gradient(90deg,transparent,black_6%,black_94%,transparent)]"
        />

        <div className="pointer-events-none absolute inset-x-0 top-[max(96px,12svh)] md:top-[max(112px,13svh)]">
          <div className={GUTTER}>
            <div className="flex items-center gap-3">
              <p className="lp-eyebrow">Shopping funnel</p>
              <IllustrativeNote />
            </div>
            <div className="mt-4 grid max-w-[940px] md:mt-6">
              <motion.h2 id="journey-title" style={{ opacity: headOpacity, y: headY }} className={`[grid-area:1/1] ${MESSAGE_TYPE}`}>
                See where customers disappear.
              </motion.h2>
              {QUESTIONS.map((q, i) => (
                <Question key={q} progress={progress} index={i} text={q} />
              ))}
              <motion.p style={{ opacity: finalOpacity, y: finalY }} className={`[grid-area:1/1] ${MESSAGE_TYPE}`}>
                Insight shows you <span className="lp-gradient-text">where to look.</span>
              </motion.p>
            </div>
          </div>
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-6 hidden md:landscape:block">
          <div className={GUTTER}>
            <JourneyMinimap progress={progress} />
          </div>
        </div>

        {/* Blend into the next scene's background as the runway ends. */}
        <motion.div
          aria-hidden
          style={{ opacity: fadeToNext }}
          className="pointer-events-none absolute inset-x-0 bottom-0 h-28 bg-gradient-to-b from-transparent to-lp-bg-2"
        />
      </div>
    </section>
  );
}

function Question({ progress, index, text }: { progress: MotionValue<number>; index: number; text: string }) {
  const [a, b, c, d] = QUESTION_WINDOWS[index];
  const opacity = useTransform(progress, [a, b, c, d], [0, 1, 1, 0]);
  const y = useTransform(progress, [a, b, c, d], [32, 0, 0, -32]);
  return (
    <motion.div style={{ opacity, y }} className="[grid-area:1/1]">
      <p className={MESSAGE_TYPE}>{text}</p>
    </motion.div>
  );
}

/**
 * Where the camera is: the journey as a thin track with the visible window sliding along it,
 * widening to the full track as the camera pulls back.
 */
function JourneyMinimap({ progress }: { progress: MotionValue<number> }) {
  const span = (p: number) => {
    const { cf, z } = cameraAt(p, RUNWAY_FRAME.world);
    const half = 0.5 / (RUNWAY_FRAME.world * z);
    return [Math.max(0, cf - half), Math.min(1, cf + half)] as const;
  };
  const x = useTransform(progress, (p) => `${span(p)[0] * 100}%`);
  const scaleX = useTransform(progress, (p) => {
    const [a, b] = span(p);
    return b - a;
  });
  const opacity = useTransform(progress, [0.72, 0.82], [1, 0]);
  return (
    <motion.div aria-hidden style={{ opacity }} className="w-[400px]">
      <div className="relative h-[5px] overflow-hidden rounded-full bg-lp-line">
        <motion.div className="absolute inset-0 origin-left rounded-full bg-lp-violet/55" style={{ x, scaleX }} />
      </div>
      <div className="relative mt-3 h-3">
        {STAGES.map((s, i) => (
          <span
            key={s.name}
            className="absolute top-0 -translate-x-1/2 font-lp-mono text-[10px] uppercase leading-none tracking-[0.08em] text-lp-muted"
            style={{ left: `${GATES[i] * 100}%` }}
          >
            {s.name}
          </span>
        ))}
      </div>
    </motion.div>
  );
}

function JourneyStatic() {
  const settled = useMotionValue(1);
  return (
    <section aria-labelledby="journey-title" className="relative overflow-hidden bg-lp-bg py-24 md:py-32">
      <div aria-hidden className={`lp-grid pointer-events-none absolute inset-0 ${GRID_MASK}`} />
      <div className={`relative ${GUTTER}`}>
        <div className="flex items-center gap-3">
          <p className="lp-eyebrow">Shopping funnel</p>
          <IllustrativeNote />
        </div>
        <h2 id="journey-title" className="lp-heading mt-5 max-w-4xl text-balance">
          See where customers disappear.
        </h2>
      </div>

      <div className="relative mx-auto mt-10 h-[620px] max-w-[1380px] md:mt-14 md:h-[760px] md:landscape:h-[480px] md:landscape:px-8 xl:px-12">
        <JourneyVisual progress={settled} frame={STATIC_FRAME} still className="relative h-full w-full" />
      </div>

      <div className={`relative ${GUTTER}`}>
        <ol className="mt-12 grid gap-px overflow-hidden rounded-[20px] border border-lp-line bg-lp-line md:grid-cols-2 xl:grid-cols-4">
          {QUESTIONS.map((q, i) => (
            <li key={q} className="bg-lp-bg p-5 md:p-6">
              <span className="font-lp-mono text-[11px] tracking-[0.16em] text-lp-violet-bright">0{i + 1}</span>
              <p className="mt-3 text-[21px] font-[550] leading-tight tracking-[-0.025em] text-lp-text md:text-[24px]">{q}</p>
            </li>
          ))}
        </ol>
        <p className="mt-12 text-balance text-[clamp(32px,4.4vw,64px)] font-[550] leading-[1] tracking-[-0.045em] text-lp-text">
          Insight shows you <span className="lp-gradient-text">where to look.</span>
        </p>
      </div>
    </section>
  );
}
