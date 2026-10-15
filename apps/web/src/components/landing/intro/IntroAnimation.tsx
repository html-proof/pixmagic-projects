"use client";
import { animate, motion, useMotionTemplate, useMotionValue, useTransform, type MotionValue } from "motion/react";
import { useEffect, useId, useRef } from "react";
import { flushSync } from "react-dom";
import { EASE, easeInOut, easeOut, lerp, segment } from "@/lib/motion";
import { MARK, MarkGradient, barPath } from "@/components/Brand";

/**
 * Every stage reads one master clock `t` (design seconds), so the whole build is a pure function
 * of time: playing it faster or skipping it is just running the clock to `handoff` quicker, and
 * the server HTML is `t = 0` (a black screen with one point of light). The clock runs faster than
 * real time (see introPace), so these 2.3 design seconds play in about 1.25 s.
 */
const T = {
  spark: [0.1, 0.55],
  bar: [0.15, 0.75],
  barStagger: 0.16,
  lift: [1.0, 1.75],
  word: [1.06, 1.62],
  tagIn: [1.28, 1.58],
  tagOut: [2.02, 2.22],
  handoff: 2.3,
  /** Real seconds after the flight starts: when the page behind starts to appear, so the mark clears the hero first. */
  reveal: 0.1,
} as const;

/**
 * The opening holds the hero (and its headline, the page's largest paint) back, so it is short:
 * the build takes BUILD seconds. The static HTML already shows its first frame (one point of light)
 * from the first paint, and the build starts when the script has loaded, which on a slow phone can
 * be a second or more later; it then plays faster still, so the hand-off comes at most about
 * INTRO_BUDGET seconds after the first paint (but the build never takes less than T.handoff / MAX_PACE).
 */
const BUILD = 1.25;
const INTRO_BUDGET = 1.8;
const MAX_PACE = 3.2;

/** Design seconds per real second for the build. */
function introPace() {
  const paint = performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? 0;
  const left = INTRO_BUDGET - Math.max(0, performance.now() - paint) / 1000;
  return Math.min(MAX_PACE, Math.max(T.handoff / BUILD, T.handoff / Math.max(0.01, left)));
}

/**
 * The flight is one 0..1 progress on a critically damped spring: the same calm settle as SPRING,
 * without its long overdamped tail (which crept for half a second and still snapped at the swap).
 * Rest thresholds are tight enough that it stops well under a pixel from the slot.
 */
const FLIGHT = { type: "spring", stiffness: 100, damping: 20, mass: 1, restDelta: 0.00012, restSpeed: 0.002 } as const;

/** Ease-out (fast first) and ease-in (late) shaping for the wordmark's path round the mark. */
const early = (p: number) => 1 - (1 - p) ** 3;
const late = (p: number) => p ** 1.35;

/** Where the point of light sits: the middle of the mark. */
const SPARK = { x: 14, y: 15.5 };

type Stage = "intro" | "handoff" | "done";
type Stoppable = { stop: () => void };

/**
 * If the JavaScript never arrives, the overlay must not hold the page hostage: this CSS fades it
 * away on its own after a few seconds. The effect cancels it as soon as the intro takes over.
 */
const FALLBACK_CSS =
  "@keyframes lp-intro-fallback{to{opacity:0;visibility:hidden}}.lp-intro[data-fallback]{animation:lp-intro-fallback .5s ease 3.5s forwards}";

/** Vertical offset of an element's nav header right now, so we can aim at where it will rest. */
function headerShift(el: Element) {
  const header = el.closest("header");
  if (!header) return 0;
  const transform = getComputedStyle(header).transform;
  return transform && transform !== "none" ? new DOMMatrix(transform).m42 : 0;
}

const centreOf = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

/**
 * Opening sequence: one point of light becomes the bizinsights mark (its three bars rise out of the
 * baseline one after another), the wordmark arrives under it, then the overlay dissolves into the hero
 * while the mark and wordmark fly into their slots in the nav and are swapped for the nav's own.
 */
export function IntroAnimation({ onHandoff, onDone }: { onHandoff: () => void; onDone: () => void }) {
  const t = useMotionValue(0);
  const backdropOpacity = useMotionValue(1);
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLDivElement>(null);
  const wordRef = useRef<HTMLSpanElement>(null);

  // Parent callbacks are inline arrows; keep the latest without restarting the sequence.
  const onHandoffRef = useRef(onHandoff);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onHandoffRef.current = onHandoff;
    onDoneRef.current = onDone;
  }, [onHandoff, onDone]);

  // Survive StrictMode's mount → unmount → mount: each callback fires once, in order.
  const stage = useRef<Stage>("intro");
  const handoffCalled = useRef(false);
  const doneCalled = useRef(false);
  const lift = useRef(0);

  const haloOpacity = useTransform(t, (v) => easeOut(segment(v, 0, 0.7)));
  const haloScale = useTransform(t, (v) => lerp(0.35, 1, easeOut(segment(v, 0.05, 1.2))));
  const groupY = useTransform(t, (v) => -lift.current * easeInOut(segment(v, T.lift[0], T.lift[1])));

  const wordP = useTransform(t, (v) => easeOut(segment(v, T.word[0], T.word[1])));
  const maskFrom = useTransform(wordP, (p) => lerp(-35, 100, p));
  const maskTo = useTransform(maskFrom, (m) => m + 35);
  const wordMask = useMotionTemplate`linear-gradient(90deg, #000 ${maskFrom}%, transparent ${maskTo}%)`;
  const wordY = useTransform(wordP, (p) => (1 - p) * 8);
  const wordOpacity = useTransform(t, (v) => segment(v, T.word[0], T.word[0] + 0.25));

  // A skip before the tagline has shown keeps it hidden rather than flashing it on the way past.
  const tagGate = useMotionValue(1);
  const tagOpacity = useTransform(
    t,
    (v) => tagGate.get() * segment(v, T.tagIn[0], T.tagIn[1]) * (1 - segment(v, T.tagOut[0], T.tagOut[1])),
  );
  const tagY = useTransform(t, (v) => (1 - easeOut(segment(v, T.tagIn[0], T.tagIn[1]))) * 6);

  useEffect(() => {
    const root = rootRef.current;
    const html = document.documentElement;
    let disposed = false;
    let locked = false;
    let prevOverflow = "";
    let clock: Stoppable | null = null;
    let skipping = false;
    const running: Stoppable[] = [];
    let safety: ReturnType<typeof setTimeout> | undefined;
    let revealTimer: ReturnType<typeof setTimeout> | undefined;

    const callHandoff = () => {
      if (handoffCalled.current) return;
      handoffCalled.current = true;
      onHandoffRef.current();
    };
    const callDone = () => {
      callHandoff();
      if (doneCalled.current) return;
      doneCalled.current = true;
      onDoneRef.current();
    };

    /**
     * Hiding a classic (Windows) scrollbar widens the viewport, which would nudge the centred point
     * sideways the moment the script takes over; hold the lockup where the static HTML drew it.
     */
    const lock = () => {
      if (locked) return;
      const gutter = window.innerWidth - html.clientWidth;
      if (root && gutter > 0) root.style.setProperty("--lp-intro-shift", `${-gutter / 2}px`);
      prevOverflow = html.style.overflow;
      html.style.overflow = "hidden";
      locked = true;
    };
    const unlock = () => {
      if (!locked) return;
      html.style.overflow = prevOverflow;
      root?.style.removeProperty("--lp-intro-shift");
      locked = false;
    };

    const skipEvents = ["keydown", "pointerdown", "wheel", "touchmove"] as const;
    const removeSkipListeners = () => skipEvents.forEach((e) => window.removeEventListener(e, skip));

    /**
     * The nav's own mark and wordmark replace ours at the same size and position. Any opacity
     * transition on them is suspended for this one commit so the swap is a single frame.
     */
    const finish = (slots: HTMLElement[]) => {
      if (stage.current === "done") return;
      stage.current = "done";
      if (safety) clearTimeout(safety);
      slots.forEach((el) => (el.style.transitionDuration = "0s"));
      flushSync(callDone);
      slots.forEach((el) => {
        void getComputedStyle(el).opacity;
        el.style.transitionDuration = "";
      });
    };

    const handoff = () => {
      if (disposed || stage.current !== "intro") return;
      stage.current = "handoff";
      clock?.stop();
      removeSkipListeners();

      const markEl = markRef.current;
      const wordEl = wordRef.current;
      const before = markEl && wordEl ? [markEl.getBoundingClientRect(), wordEl.getBoundingClientRect()] : null;

      // Giving the scrollbar back can narrow the viewport; measure on both sides of that change.
      unlock();
      const navMark = document.querySelector<HTMLElement>("[data-nav-mark]");
      const navWord = document.querySelector<HTMLElement>("[data-nav-wordmark]");

      if (root) {
        root.style.pointerEvents = "none";
        root.style.backgroundColor = "transparent";
      }
      const settled: Promise<unknown>[] = [];
      const track = (anim: Stoppable & { finished: Promise<unknown> }) => {
        running.push(anim);
        settled.push(anim.finished);
      };

      // The page (nav reveal, hero entrance) starts a beat after the flight, so the hero builds
      // in behind a mark that has already left the centre rather than underneath it.
      const reveal = () => {
        if (disposed) return;
        callHandoff();
        track(animate(backdropOpacity, 0, { duration: 0.6, ease: [0.4, 0, 0.2, 1] }));
      };

      if (!markEl || !wordEl || !before || !navMark || !navWord) {
        reveal();
        if (stageRef.current) track(animate(stageRef.current, { opacity: 0 }, { duration: 0.5, ease: EASE }));
        safety = setTimeout(() => finish([]), 1500);
        void Promise.all(settled).then(() => !disposed && finish([]));
        return;
      }

      // Start and end offsets for each piece: from where it is now (after the scrollbar came back)
      // to its slot, aiming at where the nav will rest once its own entrance has finished.
      const path = (el: HTMLElement, from: DOMRect, target: HTMLElement) => {
        const rect = el.getBoundingClientRect();
        const now = centreOf(rect);
        const f = centreOf(from);
        const dest = target.getBoundingClientRect();
        const d = centreOf(dest);
        return {
          x0: f.x - now.x,
          y0: f.y - now.y,
          x1: d.x - now.x,
          y1: d.y - headerShift(target) - now.y,
          s1: dest.width / rect.width,
        };
      };
      const m = path(markEl, before[0], navMark);
      const w = path(wordEl, before[1], navWord);

      /**
       * The lockup changes shape on the way (word under the mark → word beside it). Straight lines
       * would drag the word through the mark, so the word travels relative to the mark: sideways
       * early, up late, and never crosses it.
       */
      const place = (p: number) => {
        const mx = lerp(m.x0, m.x1, p);
        const my = lerp(m.y0, m.y1, p);
        markEl.style.transform = `translate3d(${mx}px, ${my}px, 0) scale(${lerp(1, m.s1, p)})`;
        const rx = lerp(w.x0 - m.x0, w.x1 - m.x1, early(p));
        const ry = lerp(w.y0 - m.y0, w.y1 - m.y1, late(p));
        wordEl.style.transform = `translate3d(${mx + rx}px, ${my + ry}px, 0) scale(${lerp(1, w.s1, p)})`;
      };
      place(0);
      track(animate(0, 1, { ...FLIGHT, onUpdate: place, onComplete: () => place(1) }));
      revealTimer = setTimeout(reveal, T.reveal * 1000);
      safety = setTimeout(() => finish([navMark, navWord]), 3200);
      void Promise.all(settled).then(() => !disposed && finish([navMark, navWord]));
    };

    function skip() {
      if (disposed || skipping || stage.current !== "intro") return;
      skipping = true;
      clock?.stop();
      if (t.get() < T.tagIn[0]) tagGate.set(0);
      // About half the time the build had left at its normal pace, so skipping is always quicker.
      const remaining = (T.handoff - t.get()) / (T.handoff / BUILD);
      clock = animate(t, T.handoff, {
        duration: Math.min(0.3, Math.max(0.12, remaining * 0.5)),
        ease: EASE,
        onComplete: handoff,
      });
    }

    // A restored scroll position, a request for less motion, or a fallback that already hid the
    // overlay: go straight to the page.
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const fallbackStarted = root ? Number(getComputedStyle(root).opacity) < 1 : false;
    if (stage.current !== "intro" || reduce || fallbackStarted || window.scrollY > 10) {
      if (stage.current === "intro") {
        stage.current = "done";
        callDone();
      }
      return;
    }
    if (root) root.style.animation = "none";

    // Lift the lockup so mark + wordmark sit centred together once the words arrive.
    const text = textRef.current;
    const mark = markRef.current;
    if (text && mark) lift.current = Math.max(0, (text.offsetTop + text.offsetHeight - mark.offsetHeight / 2) / 2);

    lock();
    skipEvents.forEach((e) => window.addEventListener(e, skip, { passive: true }));
    clock = animate(t, T.handoff, { duration: Math.max(0.01, (T.handoff - t.get()) / introPace()), ease: "linear", onComplete: handoff });

    return () => {
      disposed = true;
      clock?.stop();
      running.forEach((a) => a.stop());
      removeSkipListeners();
      if (safety) clearTimeout(safety);
      if (revealTimer) clearTimeout(revealTimer);
      unlock();
    };
  }, [t, tagGate, backdropOpacity]);

  return (
    <div ref={rootRef} data-fallback="" aria-hidden className="lp-intro fixed inset-0 z-[150] select-none bg-lp-bg text-lp-text">
      <style>{FALLBACK_CSS}</style>
      <motion.div className="absolute inset-0 overflow-hidden bg-lp-bg" style={{ opacity: backdropOpacity }}>
        <motion.div
          className="absolute left-1/2 top-1/2 -mt-[280px] ml-[calc(var(--lp-intro-shift,0px)_-_280px)] size-[560px] rounded-full will-change-transform"
          style={{
            opacity: haloOpacity,
            scale: haloScale,
            y: groupY,
            background:
              "radial-gradient(circle, rgb(63 207 138 / 0.16), rgb(35 147 92 / 0.06) 38%, rgb(101 216 208 / 0.02) 55%, transparent 70%)",
          }}
        />
      </motion.div>

      <motion.div ref={stageRef} className="absolute left-1/2 top-1/2 ml-[var(--lp-intro-shift,0px)]" style={{ y: groupY }}>
        <div ref={markRef} className="absolute left-0 top-0 -ml-[44px] -mt-[44px] size-[88px] md:-ml-[56px] md:-mt-[56px] md:size-[112px]">
          <IntroMark t={t} />
        </div>

        <div ref={textRef} className="absolute left-0 top-[62px] flex -translate-x-1/2 flex-col items-center md:top-[80px]">
          <span
            ref={wordRef}
            className="block whitespace-nowrap text-[23px] font-semibold leading-[1.5] tracking-[-0.01em] md:text-[29px]"
          >
            <motion.span
              className="block"
              style={{ opacity: wordOpacity, y: wordY, maskImage: wordMask, WebkitMaskImage: wordMask }}
            >
              bizinsights
            </motion.span>
          </span>
          <motion.p className="lp-eyebrow mr-[-0.16em] mt-2.5 whitespace-nowrap text-lp-text-2 md:mt-3 md:text-[12.5px]" style={{ opacity: tagOpacity, y: tagY }}>
            Commerce Intelligence
          </motion.p>
        </div>
      </motion.div>
    </div>
  );
}

/**
 * The mark, built up from `t`: a point of light, then the bars rising out of the baseline, shortest
 * first. Its end state is exactly BrandMark's geometry and paint, so scaled down into the nav it is
 * indistinguishable from the real thing.
 */
function IntroMark({ t }: { t: MotionValue<number> }) {
  const id = useId().replace(/:/g, "");
  const sparkP = useTransform(t, (v) => easeOut(segment(v, T.spark[0], T.spark[1])));
  const glowR = useTransform(sparkP, (p) => lerp(3.2, 12, p));
  const sparkR = useTransform(sparkP, (p) => lerp(1.15, 2.2, p));
  const sparkOpacity = useTransform(t, (v) => 1 - segment(v, 0.2, 0.6));

  return (
    <svg viewBox="0 0 28 28" width="100%" height="100%" fill="none" className="block overflow-visible">
      <defs>
        <MarkGradient id={`intro-bar-${id}`} />
        <radialGradient id={`intro-glow-${id}`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0%" stopColor="#3fcf8a" stopOpacity="0.42" />
          <stop offset="100%" stopColor="#3fcf8a" stopOpacity="0" />
        </radialGradient>
        {/* The baseline: bars rise from below it, so each one comes up through it with its rounded top first. */}
        <clipPath id={`intro-floor-${id}`}>
          <rect x="0" y="-12" width="28" height={MARK.baseline + 12} />
        </clipPath>
      </defs>
      <motion.circle cx={SPARK.x} cy={SPARK.y} r={glowR} fill={`url(#intro-glow-${id})`} />
      <g clipPath={`url(#intro-floor-${id})`}>
        {MARK.bars.map((_, i) => (
          <RisingBar key={i} t={t} index={i} fill={`url(#intro-bar-${id})`} />
        ))}
      </g>
      <motion.circle cx={SPARK.x} cy={SPARK.y} r={sparkR} fill="#F7F9FC" style={{ opacity: sparkOpacity }} />
    </svg>
  );
}

/** One bar: rises from under the baseline to its place, fading in as it comes. */
function RisingBar({ t, index, fill }: { t: MotionValue<number>; index: number; fill: string }) {
  const bar = MARK.bars[index];
  const a = T.bar[0] + index * T.barStagger;
  const b = T.bar[1] + index * T.barStagger;
  const p = useTransform(t, (v) => easeOut(segment(v, a, b)));
  const y = useTransform(p, (q) => (q >= 1 ? 0 : (1 - q) * (MARK.baseline - bar.top)));
  const opacity = useTransform(p, (q) => bar.opacity * Math.min(1, q * 2.5));
  return <motion.path d={barPath(index)} fill={fill} style={{ y, opacity }} />;
}
