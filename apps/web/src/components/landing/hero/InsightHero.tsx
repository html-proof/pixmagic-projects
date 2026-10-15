"use client";
import { animate, motion, useMotionValue, useTransform, type MotionValue } from "motion/react";
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { usePauseWhenHidden } from "@/hooks/usePauseWhenHidden";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { useScrollProgress, useSegment } from "@/hooks/useScrollProgress";
import { EASE, easeInOut, easeOut, lerp, segment } from "@/lib/motion";
import { LoginPrompt, SignupButton, SrOnly } from "../shared/ui";
import { DataParticles } from "./DataParticles";
import { HeroDashboardReveal } from "./HeroDashboardReveal";
import { HeroFlowLists, HeroFlowsStacked, HeroFlowsWide } from "./HeroFlows";
import { ORB_POINT, WIDE_QUERY, coreGlow, coreOpacity, coreScale, coreX, coreY, ringOpacity } from "./heroLayout";
import { IntelligenceCore, type CoreMotion } from "./IntelligenceCore";

/* ---- Copy ------------------------------------------------------------------------------------ */

const SUB = "Insights turns every order, checkout, customer and payment into a clear picture of what your business is doing.";
const SUPPORT =
  "Insights transforms Shopify activity into clear business intelligence, so you can make better decisions without digging through reports.";
const FINAL = ["Know what happened.", "Understand why.", "Know what to do next."];
const STORY =
  "Illustration: tiny points standing for orders, customers, products, checkouts, payments, store visits, refunds and inventory drift across the screen, then gather into the Insights core. " +
  "The core links them into three paths: product viewed, added to cart, checkout started, purchase, order; channel, visitor, customer, repeat purchase; and gross sales minus discounts minus refunds equals net sales. " +
  "The core then opens into a dashboard with Business health, Sales, Conversion, Customers and Products modules.";

const HEADLINE_FINAL = "text-[clamp(28px,7.6vw,44px)] font-[550] leading-[1.04] tracking-[-0.04em] md:text-[clamp(40px,5.4vw,56px)] text-balance lg:text-[clamp(32px,3.4vw,58px)]";
/** Stage statements: section-headline scale, eased down beside the visual so they hold two lines. */
const STATEMENT = "lp-heading text-balance lg:text-[clamp(44px,4.4vw,76px)]";
/** Reduced motion: the stage statements as one readable pair beside the static flows. */
const STATIC_STATEMENT = "text-balance text-[clamp(30px,7vw,40px)] font-[550] leading-[1.06] tracking-[-0.035em] text-lp-text lg:text-[clamp(36px,3.2vw,52px)]";
/** Text column beside the visual on wide screens; the box takes 52vw, leaving a real gutter. */
const COLUMN = "col-start-1 row-start-1 self-start lg:max-w-[min(32vw,520px)] lg:self-center";

/** 1 while the side-by-side layout applies, 0 when stacked. A MotionValue, so nothing re-renders. */
function useWideValue() {
  const wide = useMotionValue(1);
  useEffect(() => {
    const mql = window.matchMedia(WIDE_QUERY);
    const sync = () => wide.set(mql.matches ? 1 : 0);
    sync();
    mql.addEventListener("change", sync);
    return () => mql.removeEventListener("change", sync);
  }, [wide]);
  return wide;
}

/**
 * Crossfade for one stage statement: rises in from below, leaves upwards. Windows are chosen so
 * only one statement is ever readable. Opacity and movement only (no blur): each statement is its
 * own layer (lp-layer), so the GPU just moves and fades it.
 */
function useStatement(progress: MotionValue<number>, enter: readonly [number, number] | null, exit: readonly [number, number] | null) {
  const inOf = (p: number) => (enter ? easeOut(segment(p, enter[0], enter[1])) : 1);
  const outOf = (p: number) => (exit ? easeInOut(segment(p, exit[0], exit[1])) : 0);
  const opacity = useTransform(progress, (p) => (enter ? segment(p, enter[0], enter[1]) : 1) * (1 - (exit ? segment(p, exit[0], exit[1]) : 0)));
  const y = useTransform(progress, (p) => (1 - inOf(p)) * 28 - outOf(p) * 28);
  return { opacity, y };
}

/** One headline line rising out of its own mask when the intro hands over. */
function RiseLine({ show, delay, children }: { show: boolean; delay: number; children: ReactNode }) {
  return (
    <span className="-mb-[0.12em] block overflow-hidden pb-[0.12em]">
      <motion.span className="lp-enter block" initial={{ y: "112%" }} animate={{ y: show ? "0%" : "112%" }} transition={{ duration: 1.2, ease: EASE, delay }}>
        {children}
      </motion.span>
    </span>
  );
}

function FinalLine({ progress, index, children }: { progress: MotionValue<number>; index: number; children: ReactNode }) {
  const a = 0.795 + index * 0.007;
  const opacity = useTransform(progress, (p) => segment(p, a, a + 0.016));
  const y = useTransform(progress, (p) => (1 - easeOut(segment(p, a, a + 0.02))) * 22);
  return (
    <motion.p className={`lp-layer ${HEADLINE_FINAL} ${index === 2 ? "lp-gradient-text" : "text-lp-text"}`} style={{ opacity, y }}>
      {children}
    </motion.p>
  );
}

/* ---- Cinematic hero (scroll runway) ---------------------------------------------------------- */

function HeroCinematic({ ready }: { ready: boolean }) {
  const sectionRef = useRef<HTMLElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const progress = useScrollProgress(sectionRef);
  const wide = useWideValue();

  // Particles fade in as the intro hands the screen over.
  const enter = useMotionValue(0);
  useEffect(() => {
    if (!ready) return;
    const controls = animate(enter, 1, { duration: 2.6, ease: EASE, delay: 0.1 });
    return () => controls.stop();
  }, [ready, enter]);

  // The core: one set of values drives the DOM sphere, the canvas orbits and the cards' origin.
  const cx = useTransform([progress, wide], ([p, w]: number[]) => coreX(p, w > 0.5));
  const cy = useTransform([progress, wide], ([p, w]: number[]) => coreY(p, w > 0.5));
  const cs = useTransform([progress, wide], ([p, w]: number[]) => coreScale(p, w > 0.5));
  const core: CoreMotion = {
    x: useTransform(cx, (v) => `${v - 50}%`),
    y: useTransform(cy, (v) => `${v - 50}%`),
    scale: cs,
    opacity: useTransform(progress, coreOpacity),
    rings: useTransform(progress, ringOpacity),
    glow: useTransform(progress, coreGlow),
  };

  // Statements, one readable at a time.
  const s1 = useStatement(progress, null, [0.13, 0.175]);
  const s2 = useStatement(progress, [0.185, 0.225], [0.345, 0.385]);
  const s3 = useStatement(progress, [0.395, 0.435], [0.565, 0.605]);
  const s4 = useStatement(progress, [0.615, 0.655], [0.772, 0.795]);
  const finalCopy = useTransform(progress, (p) => segment(p, 0.81, 0.83));
  const finalCopyY = useTransform(progress, (p) => (1 - easeOut(segment(p, 0.81, 0.835))) * 18);
  const finalEvents = useTransform(progress, (p) => (p >= 0.82 ? "auto" : "none"));
  const cue = useTransform(progress, (p) => 1 - segment(p, 0.012, 0.06));
  const cueRef = useRef<HTMLDivElement>(null);
  usePauseWhenHidden(cueRef, [cue]);

  // Visual box: on stacked screens the dashboard steps back and down under the final statement,
  // its top fading out so it never sits behind the copy or the CTAs.
  const settle = useTransform(progress, (p) => easeInOut(segment(p, 0.775, 0.83)));
  const boxOpacity = useTransform([settle, wide], ([d, w]: number[]) => (w > 0.5 ? 1 : lerp(1, 0.4, d)));
  const boxY = useTransform([settle, wide], ([d, w]: number[]) => (w > 0.5 ? "0%" : `${d * 18}%`));
  const boxMask = useTransform([settle, wide], ([d, w]: number[]) =>
    w > 0.5 || d <= 0 ? "none" : `linear-gradient(to bottom, transparent ${(d * 34).toFixed(1)}%, black ${(d * 62).toFixed(1)}%)`,
  );
  const boxEvents = useTransform(progress, (p) => (p > 0.2 ? "auto" : "none"));
  const grid = useTransform(progress, (p) => segment(p, 0.2, 0.32) * (1 - segment(p, 0.62, 0.72)) * 0.9);

  // Depth: the whole stage becomes a floating product window as the next scene rises over it.
  const depth = useSegment(progress, 0.86, 1);
  const stageScale = useTransform(depth, (d) => lerp(1, 0.88, easeInOut(d)));
  const stageRadius = useTransform(depth, (d) => easeInOut(d) * 36);
  const windowEdge = useTransform(depth, (d) => segment(d, 0, 0.45));
  // Scale towards the copy: stacked, the CTAs sit lower and must stay above the rising next scene.
  const stageOrigin = useTransform(wide, (w) => (w > 0.5 ? "50% 35%" : "50% 18%"));

  /** Keyboard users tabbing to the CTA before reaching it: bring the final stage into view. */
  const revealFinal = () => {
    const el = sectionRef.current;
    if (!el || progress.get() >= 0.83) return;
    const top = el.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top: top + (el.offsetHeight - window.innerHeight) * 0.9, behavior: "instant" });
  };

  return (
    <section ref={sectionRef} aria-labelledby="hero-title" className="relative h-[300vh] bg-lp-bg md:h-[350vh] xl:h-[450vh]">
      <div className="sticky top-0 h-svh overflow-hidden bg-[#06080a]">
        {/* Rounded at its final radius from the start: under the stage it only shows once the
            stage has shrunk, and animating a 140px soft shadow's radius re-rendered it every frame. */}
        <motion.div
          aria-hidden
          className="lp-layer absolute inset-0 rounded-[36px] shadow-[0_50px_140px_-40px_rgb(0_0_0/0.95),0_0_80px_-20px_rgb(140_123_255/0.12)]"
          style={{ scale: stageScale, opacity: windowEdge, transformOrigin: stageOrigin }}
        />
        {/* Layers (will-change) for everything the scroll moves, so moving it never repaints it. */}
        <motion.div className="absolute inset-0 overflow-hidden bg-lp-bg will-change-transform" style={{ scale: stageScale, borderRadius: stageRadius, transformOrigin: stageOrigin }}>
          <DataParticles progress={progress} enter={enter} coreX={cx} coreY={cy} coreScale={cs} wide={wide} boxRef={boxRef} />

          {/* Quiet the field behind the copy so text always reads first. Its own layer, so the stage's
              corners rounding at the end of the runway repaint only the stage, not this gradient. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 will-change-transform bg-[radial-gradient(ellipse_110%_46%_at_50%_42%,rgb(8_10_13/0.74),rgb(8_10_13/0)_75%)] lg:bg-[radial-gradient(ellipse_62%_60%_at_24%_52%,rgb(8_10_13/0.78),rgb(8_10_13/0)_72%)]"
          />

          {/* The visual box: core, flows and dashboard share its coordinates (HeroLayout). */}
          <div className="pointer-events-none absolute inset-0 px-4 pb-[5svh] md:px-8 lg:pb-0 lg:pt-[88px] xl:px-12">
            <div className="mx-auto flex h-full w-full max-w-[1380px] items-end justify-center lg:items-center lg:justify-end">
              <motion.div
                ref={boxRef}
                aria-hidden
                data-cursor="VIEW"
                className="relative aspect-[360/440] w-[min(100%,calc((100svh_-_270px)*0.818),560px)] will-change-transform lg:aspect-[1000/760] lg:w-[min(52vw,calc((100svh_-_200px)*1.316),780px)]"
                style={{ opacity: boxOpacity, y: boxY, pointerEvents: boxEvents, maskImage: boxMask, WebkitMaskImage: boxMask }}
              >
                <motion.div
                  className="lp-layer lp-grid absolute -inset-[8%] [mask-image:radial-gradient(closest-side,black_15%,transparent)]"
                  style={{ opacity: grid }}
                />
                <div className="hidden lg:block">
                  <HeroFlowsWide progress={progress} />
                </div>
                <div className="lg:hidden">
                  <HeroFlowsStacked progress={progress} />
                </div>
                <HeroDashboardReveal progress={progress} coreX={cx} coreY={cy} />
                <IntelligenceCore motion={core} />
              </motion.div>
            </div>
          </div>

          {/* Statements: all in the DOM in reading order; one visible at a time. */}
          <div className="pointer-events-none absolute inset-0 px-4 pb-[5svh] pt-[104px] md:px-8 lg:pb-[9svh] lg:pt-[96px] xl:px-12">
            <div className="mx-auto grid h-full w-full max-w-[1380px] grid-cols-1 grid-rows-1">
              <motion.div className="lp-layer col-start-1 row-start-1 self-center" style={s1}>
                <h1 id="hero-title" className="lp-display text-balance">
                  <RiseLine show={ready} delay={0.05}>
                    Your store
                  </RiseLine>
                  <RiseLine show={ready} delay={0.2}>
                    <span className="lp-gradient-text">is talking.</span>
                  </RiseLine>
                </h1>
                <motion.p
                  className="lp-enter lp-lead mt-7 max-w-[34rem] text-pretty md:mt-9"
                  initial={{ opacity: 0, y: 18 }}
                  animate={ready ? { opacity: 1, y: 0 } : { opacity: 0, y: 18 }}
                  transition={{ duration: 1, ease: EASE, delay: 0.25 }}
                >
                  {SUB}
                </motion.p>
              </motion.div>

              <motion.div className={`${COLUMN} lp-layer`} style={s2}>
                <p className="lp-eyebrow mb-5">Thousands of events</p>
                <p className={STATEMENT}>
                  But data alone <span className="text-lp-muted">isn&rsquo;t insight.</span>
                </p>
              </motion.div>

              <motion.div className={`${COLUMN} lp-layer`} style={s3}>
                <p className="lp-eyebrow mb-5">Patterns</p>
                <p className={STATEMENT}>
                  Insights connects <span className="lp-gradient-text">the dots.</span>
                </p>
              </motion.div>

              <motion.div className={`${COLUMN} lp-layer`} style={s4}>
                <p className="lp-eyebrow mb-5">Business intelligence</p>
                <p className={STATEMENT}>See what matters.</p>
              </motion.div>

              {/* Lifted above centre on wide screens (mb shifts a centred grid item up by half) so the
                  CTAs stay clear of the next scene, which rises over the runway's last 30vh. */}
              <motion.div
                className="col-start-1 row-start-1 self-start lg:mb-[18svh] lg:max-w-[min(34vw,540px)] lg:self-center"
                style={{ pointerEvents: finalEvents }}
                onFocusCapture={revealFinal}
              >
                <div className="space-y-0.5">
                  {FINAL.map((line, i) => (
                    <FinalLine key={line} progress={progress} index={i}>
                      {line}
                    </FinalLine>
                  ))}
                </div>
                <motion.div className="lp-layer" style={{ opacity: finalCopy, y: finalCopyY }}>
                  <p className="lp-lead mt-4 max-w-[32rem] text-pretty max-md:text-[15.5px] md:mt-7">{SUPPORT}</p>
                  <div className="mt-6 flex flex-col items-start gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-6 sm:gap-y-4 md:mt-9">
                    <SignupButton size="lg">Start with Insights</SignupButton>
                    <LoginPrompt />
                  </div>
                </motion.div>
              </motion.div>
            </div>
          </div>

          <SrOnly>{STORY}</SrOnly>

          {/* Scroll cue. */}
          <motion.div
            ref={cueRef}
            data-lp-paused=""
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-5 flex justify-center md:bottom-7"
            style={{ opacity: cue }}
          >
            <motion.div
              className="flex flex-col items-center gap-3"
              initial={{ opacity: 0 }}
              animate={{ opacity: ready ? 1 : 0 }}
              transition={{ duration: 1, ease: EASE, delay: 0.9 }}
            >
              <span className="lp-eyebrow text-[10.5px]">Scroll</span>
              <span className="relative block h-10 w-px overflow-hidden bg-white/10">
                {/* Mounted with the entrance, so the loop never runs under the intro. */}
                {ready && (
                  <span className="lp-loop lp-scroll-cue absolute inset-x-0 top-0 block h-1/2 bg-gradient-to-b from-transparent via-lp-violet-bright to-transparent" />
                )}
              </span>
            </motion.div>
          </motion.div>

          <motion.div aria-hidden className="pointer-events-none absolute inset-0 rounded-[inherit] border border-lp-line-strong" style={{ opacity: windowEdge }} />
        </motion.div>
      </div>
    </section>
  );
}

/* ---- Reduced motion: one static, natural-height composition ---------------------------------- */

function HeroStatic() {
  const zero = useMotionValue(0);
  const one = useMotionValue(1);
  const connected = useMotionValue(0.59);
  const boxRef = useRef<HTMLDivElement>(null);
  const fieldCore = useMotionValue(50);
  const orbX = useMotionValue(ORB_POINT.x);
  const orbY = useMotionValue(ORB_POINT.y);
  const connectScale = useMotionValue(coreScale(0.5, true));
  const wideCore: CoreMotion = {
    x: useMotionValue(`${coreX(0.5, true) - 50}%`),
    y: useMotionValue("0%"),
    scale: connectScale,
    opacity: one,
    rings: one,
    glow: one,
  };
  const smallCore: CoreMotion = {
    x: useMotionValue("0%"),
    y: useMotionValue("0%"),
    scale: one,
    opacity: one,
    rings: one,
    glow: one,
  };

  return (
    <section aria-labelledby="hero-title" className="relative overflow-hidden bg-lp-bg px-4 pb-24 pt-32 md:px-8 md:pb-32 md:pt-40 xl:px-12">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-svh [mask-image:linear-gradient(black_55%,transparent)]">
        <DataParticles progress={zero} enter={one} coreX={fieldCore} coreY={fieldCore} coreScale={one} wide={one} boxRef={boxRef} still />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_95%_55%_at_30%_40%,rgb(8_10_13/0.78),rgb(8_10_13/0)_75%)]" />
      </div>

      <div className="relative mx-auto max-w-[1380px]">
        <h1 id="hero-title" className="lp-display text-balance">
          <span className="block">Your store</span>
          <span className="lp-gradient-text block">is talking.</span>
        </h1>
        <p className="lp-lead mt-7 max-w-[34rem] text-pretty md:mt-9">{SUB}</p>

        <div className="mt-24 grid items-center gap-12 md:mt-32 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
          <div className="space-y-5 md:space-y-7">
            <p className={STATIC_STATEMENT}>
              But data alone <span className="text-lp-muted">isn&rsquo;t insight.</span>
            </p>
            <p className={STATIC_STATEMENT}>
              Insights connects <span className="lp-gradient-text">the dots.</span>
            </p>
          </div>
          <div>
            <div aria-hidden className="relative hidden aspect-[1000/760] w-full lg:block">
              <HeroFlowsWide progress={connected} still />
              <IntelligenceCore motion={wideCore} still />
            </div>
            <div className="lg:hidden">
              <div aria-hidden className="relative mx-auto mb-8 aspect-square w-56">
                <IntelligenceCore motion={smallCore} still />
              </div>
              <HeroFlowLists />
            </div>
          </div>
        </div>

        <div className="mt-24 grid items-center gap-12 md:mt-32 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
          <div>
            <p className="lp-title mb-6 text-lp-text-2">See what matters.</p>
            {FINAL.map((line, i) => (
              <p key={line} className={`${HEADLINE_FINAL} ${i === 2 ? "lp-gradient-text" : "text-lp-text"}`}>
                {line}
              </p>
            ))}
            <p className="lp-lead mt-6 max-w-[32rem] text-pretty md:mt-8">{SUPPORT}</p>
            <div className="mt-8 flex flex-col items-start gap-4 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-6">
              <SignupButton size="lg">Start with Insights</SignupButton>
              <LoginPrompt />
            </div>
          </div>
          <div aria-hidden className="relative mx-auto aspect-[360/440] w-full max-w-[520px] lg:aspect-[1000/760] lg:max-w-none">
            <HeroDashboardReveal progress={one} coreX={orbX} coreY={orbY} />
          </div>
        </div>
        <SrOnly>{STORY}</SrOnly>
      </div>
    </section>
  );
}

const noSubscribe = () => () => {};
const isClient = () => true;
const isServer = () => false;

/**
 * The first screen after the intro: a scroll-driven story in five stages. A calm field of store
 * events (orders, checkouts, customers, payments…) converges into the Insights core, which links
 * them into the relationships the product reports on and then unfolds into the dashboard, ending
 * on the hero's only calls to action. With reduced motion it renders as a static composition.
 *
 * `ready` stays false while the intro covers the screen; the entrance plays when it turns true.
 */
export function InsightHero({ ready }: { ready: boolean }) {
  const reduced = useReducedMotion();
  // `reduced` is already false during hydration; the mounted check is a second guard so the first
  // client render always matches the server HTML.
  const mounted = useSyncExternalStore(noSubscribe, isClient, isServer);
  return reduced && mounted ? <HeroStatic /> : <HeroCinematic ready={ready} />;
}
