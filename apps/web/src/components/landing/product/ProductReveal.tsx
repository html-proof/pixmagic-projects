"use client";
import { animate, motion, useInView, useMotionValue, useSpring, useTransform } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { useScrollProgress } from "@/hooks/useScrollProgress";
import { easeInOut, segment } from "@/lib/motion";
import { IllustrativeNote, SectionIntro } from "../shared/ui";
import { ProductRevealWindow, REVEAL_STAGES } from "./ProductRevealWindow";

/** How the window's build is driven: scroll (tablet and up), a timer (phones), or finished. */
const MODE = { scroll: 0, timed: 1, still: 2 } as const;

/** Where the build is complete on a phone: the settle stage after it only applies to the 3D window. */
const BUILT = REVEAL_STAGES.health[1] + 0.02;

const WINDOW_LABEL =
  "Illustrative Insights dashboard. A top bar with a store selector and search; a sidebar with Overview, Sales, Orders, Customers, Funnel, Products, Inventory, Fulfillment and Settings; " +
  "empty key figures for sales, orders, conversion and net sales; a sales-over-time chart compared with the previous period; a business health panel; the shopping funnel from visit to purchase; " +
  "new versus returning customers; and product activity. No real figures are shown.";

/**
 * G1 — the product reveal. The Insights application assembles itself part by part as the visitor
 * scrolls (sidebar, top bar, key figures, chart, customers, funnel, health), then the tilted
 * window settles flat, as if it had physically landed. Phones play the same build once on a timer
 * without the 3D; reduced motion shows the finished window.
 */
export function ProductReveal() {
  const runway = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const [wide, setWide] = useState(true);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 48rem)");
    const sync = () => setWide(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // Starts while the runway is still entering, so the sidebar is arriving as the window pins.
  const scroll = useScrollProgress(runway, ["start 0.55", "end end"]);
  // A little inertia on scroll so the window settles rather than snapping with each wheel tick.
  const smooth = useSpring(scroll, { stiffness: 140, damping: 30, mass: 0.5 });
  const timed = useMotionValue(0);
  const mode = useMotionValue<number>(MODE.scroll);
  const progress = useTransform([smooth, timed, mode], ([s, t, m]: number[]) => (m === MODE.still ? 1 : m === MODE.timed ? t * BUILT : s));

  useEffect(() => {
    mode.set(reduced ? MODE.still : wide ? MODE.scroll : MODE.timed);
  }, [mode, reduced, wide]);

  const inView = useInView(frame, { once: true, amount: 0.2 });
  useEffect(() => {
    if (reduced || wide || !inView) return;
    const controls = animate(timed, 1, { duration: 3.2, ease: "linear" });
    return () => controls.stop();
  }, [reduced, wide, inView, timed]);

  // The physical settle: only in scroll mode (phones and reduced motion stay flat).
  const settle = useTransform([progress, mode], ([v, m]: number[]) =>
    m === MODE.scroll ? easeInOut(segment(v, REVEAL_STAGES.settle[0], REVEAL_STAGES.settle[1])) : 1,
  );
  // A straight lean back (no sideways yaw, which read as a skewed, crooked frame) that lifts upright.
  const rotateX = useTransform(settle, (s) => 16 * (1 - s));
  const scale = useTransform(settle, (s) => 0.9 + 0.1 * s);
  const y = useTransform(settle, (s) => (1 - s) * 24);
  const glow = useTransform(settle, (s) => 0.35 + 0.65 * s);

  return (
    <section aria-labelledby="product-reveal-title" className="relative overflow-x-clip bg-lp-bg">
      {/* Blend out of the previous scene's slightly lighter ground instead of a hard edge. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-48 bg-gradient-to-b from-lp-bg-2 to-lp-bg" />

      <div className="relative mx-auto max-w-[1380px] px-4 pt-28 md:px-8 md:pt-36 xl:px-12">
        <SectionIntro
          id="product-reveal-title"
          align="center"
          eyebrow="The Insights dashboard"
          title="Everything comes together here."
          lead="Sales, orders, customers, the funnel, products and stock, read from your Shopify store and laid out in one calm overview."
        />
      </div>

      <div ref={runway} className={reduced ? "relative" : "relative md:h-[260vh] xl:h-[300vh]"}>
        <div
          className={`relative flex flex-col items-center px-4 pb-16 pt-10 md:px-8 xl:px-12 ${
            reduced ? "md:pt-16" : "md:sticky md:top-0 md:h-svh md:justify-center md:overflow-hidden md:pb-6 md:pt-[100px]"
          }`}
        >
          <div
            aria-hidden
            className="lp-grid pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_65%_60%_at_50%_55%,#000_15%,transparent_75%)]"
          />
          <div className="relative w-full max-w-[1220px]" style={{ perspective: 1800 }}>
            <motion.div
              aria-hidden
              className="pointer-events-none absolute -inset-x-[8%] -bottom-[14%] top-[30%] rounded-[50%] bg-[radial-gradient(closest-side,rgb(140_123_255/0.16),rgb(94_166_255/0.06)_55%,transparent)]"
              style={{ opacity: glow }}
            />
            <motion.div
              ref={frame}
              role="img"
              aria-label={WINDOW_LABEL}
              data-cursor="VIEW"
              className={`relative max-md:[transform:none]! ${reduced ? "md:h-[660px]" : "md:h-[clamp(440px,calc(100svh-160px),700px)]"}`}
              style={{ rotateX, scale, y, transformOrigin: "50% 60%" }}
            >
              <ProductRevealWindow progress={progress} />
            </motion.div>
          </div>
          <div className="relative mt-5 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-center md:mt-4 md:[@media(max-height:700px)]:mt-3!">
            <IllustrativeNote>Illustrative interface</IllustrativeNote>
            <span className="text-[13px] text-lp-muted">Shows how Insights is laid out, not real figures.</span>
          </div>
        </div>
      </div>
    </section>
  );
}
