"use client";
import Link from "next/link";
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { EASE } from "@/lib/motion";
import { InsightMark } from "../shared/InsightMark";
import { ROUTES, SignupButton } from "../shared/ui";

/**
 * Floating nav: logo, Log in, Sign up. Nothing else, on any screen size.
 *
 * The intro hands its mark over to this bar. While it runs, `revealed` is false (the bar is
 * hidden) and then `brandVisible` stays false until the intro's mark has flown into the slot
 * marked `data-nav-mark` (and its wordmark into `data-nav-wordmark`); the intro measures those
 * two elements to know where to land.
 */
export function Navbar({ revealed = true, brandVisible = true }: { revealed?: boolean; brandVisible?: boolean }) {
  const [scrolled, setScrolled] = useState(false);
  // "Scrolled" = a marker 24px down the page has left the viewport. An observer instead of a
  // scroll listener: reading `scrollY` on every scroll event forced a style recalc mid-frame.
  const marker = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = marker.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setScrolled(!entry.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <>
      <div ref={marker} aria-hidden className="pointer-events-none absolute left-0 top-6 h-px w-px" />
      <motion.header
        initial={false}
        animate={{ opacity: revealed ? 1 : 0, y: revealed ? 0 : -12 }}
        transition={{ duration: 0.8, ease: EASE }}
        className={`lp-enter fixed left-1/2 top-3 z-[100] h-14 w-[calc(100%-24px)] max-w-[1380px] -translate-x-1/2 rounded-[18px] border transition-[background-color,border-color,box-shadow,backdrop-filter] duration-500 ease-lp md:top-6 md:h-16 md:w-[calc(100%-48px)] md:rounded-[20px] ${
          scrolled
            ? "border-lp-line-strong bg-[rgb(13_16_21/0.72)] shadow-[0_12px_40px_-12px_rgb(0_0_0/0.6)] backdrop-blur-xl"
            : "border-lp-line bg-transparent shadow-[0_8px_30px_-18px_rgb(0_0_0/0.5)]"
        }`}
        style={{ pointerEvents: revealed ? "auto" : "none" }}
      >
        <nav aria-label="Main" className="flex h-full items-center justify-between pl-4 pr-2 md:pl-6 md:pr-3">
          <Link
            href="/"
            aria-label="Insight home"
            className="lp-focus flex items-center gap-2.5 rounded-lg text-lp-text"
            onClick={(e) => {
              // Already home: glide back to the top instead of reloading the page.
              e.preventDefault();
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
          >
            {/* No opacity transition on these two: the intro's mark lands exactly here and the swap must be instant. */}
            <span data-nav-mark className="lp-enter block size-7" style={{ opacity: brandVisible ? 1 : 0 }}>
              <InsightMark size={28} />
            </span>
            <span
              data-nav-wordmark
              className="lp-enter text-[14px] font-semibold tracking-[0.16em] md:text-[15px]"
              style={{ opacity: brandVisible ? 1 : 0 }}
            >
              INSIGHT
            </span>
          </Link>
          <div className="flex items-center gap-1 md:gap-2">
            <Link href={ROUTES.login} className="lp-btn-ghost lp-focus h-10 px-3 text-[14px] md:px-4" data-cursor="OPEN">
              Log in
            </Link>
            <SignupButton className="max-[380px]:px-3" />
          </div>
        </nav>
      </motion.header>
    </>
  );
}
