"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Compass } from "lucide-react";
import { overlay } from "@/components/AppUi";
import { readLocal, TOUR_SEEN_KEY, writeLocal } from "@/lib/storage";
import { placeCard, startTour, TOUR_STEPS, type Box, type TourStep } from "@/lib/tour";

// ---------------------------------------------------------------------------
// The look around: a few steps over the page itself, each lighting up one part of the frame (what
// needs you, the numbers, the dates, the menu, search, the bell, help) with a card beside it that
// says what it is for. It is only ever offered (the Home's card for a new device, the help button),
// can be left at any step with Skip or Escape, and changes nothing on the page. Steps whose part
// isn't on this page (the Home's, on another page) are left out.
// ---------------------------------------------------------------------------

/**
 * The Home's offer of the look around, on a device that hasn't taken or declined it: one quiet row,
 * gone for good on either answer. The help button keeps the tour for later.
 */
export function TourOffer() {
  const [show, setShow] = useState(false);
  useEffect(() => setShow(readLocal(TOUR_SEEN_KEY) === null), []);
  if (!show) return null;
  const answered = () => {
    writeLocal(TOUR_SEEN_KEY, "1");
    setShow(false);
  };
  return (
    <section aria-label="Look around" className="home-card animate-rise flex flex-wrap items-center gap-x-4 gap-y-3 bg-home-soft px-4 py-3 sm:px-5" data-testid="tour-offer">
      <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-accent text-accent-ink">
        <Compass className="h-4 w-4" />
      </span>
      <p className="min-w-[14rem] flex-1 text-sm">
        <span className="font-semibold">New here? </span>
        Take a one-minute look around: where your numbers are, how the menu is arranged and where to get help.
      </p>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => {
            answered();
            startTour();
          }}
          className="btn-primary px-3 py-1.5"
          data-testid="tour-offer-start"
        >
          Show me around
        </button>
        <button type="button" onClick={answered} className="rounded px-2 py-1.5 text-sm font-medium text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-accent" data-testid="tour-offer-skip">
          No thanks
        </button>
      </div>
    </section>
  );
}

/** The part of the page a step points at: the first of its targets that is on screen. */
function findTarget(step: TourStep): HTMLElement | null {
  for (const name of step.targets) {
    for (const el of document.querySelectorAll<HTMLElement>(`[data-tour="${name}"]`)) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return el;
    }
  }
  return null;
}

/** Whether `el` stays where it is as the page scrolls (the top bar, the sidebar, the help button). */
function pinned(el: HTMLElement): boolean {
  for (let node: HTMLElement | null = el; node && node !== document.body; node = node.parentElement) {
    const position = getComputedStyle(node).position;
    if (position === "fixed" || position === "sticky") return true;
  }
  return false;
}

/**
 * Scroll the page so `el` is clear of the top bar and has room for the card beside it: only a part
 * of the page that isn't already wholly in view, and never for something that doesn't scroll.
 */
function bringIntoView(el: HTMLElement) {
  if (pinned(el)) return;
  const r = el.getBoundingClientRect();
  const topBar = 80;
  if (r.top >= topBar && r.bottom <= window.innerHeight - 16) return;
  // At once: the highlight is drawn where the part ends up, not chasing it down the page.
  window.scrollBy({ top: r.top - Math.max(topBar, (window.innerHeight - r.height) / 2), behavior: "instant" });
}

/** The highlight around `el`: a little wider than it, and never off the window. */
function boxOf(el: HTMLElement): Box {
  const r = el.getBoundingClientRect();
  const pad = 6;
  const edge = 4;
  const top = Math.max(edge, r.top - pad);
  const left = Math.max(edge, r.left - pad);
  const bottom = Math.min(window.innerHeight - edge, r.bottom + pad);
  const right = Math.min(window.innerWidth - edge, r.right + pad);
  return { top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export function Tour({ onClose }: { onClose: () => void }) {
  // The steps this page has something to show for, decided once as the tour opens.
  const [steps] = useState(() => TOUR_STEPS.filter((s) => findTarget(s) !== null));
  const [at, setAt] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const step = steps[at];
  const last = at === steps.length - 1;

  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Nothing on this page to show (it can't happen while the help button is there): don't open.
  useEffect(() => {
    if (!steps.length) closeRef.current();
  }, [steps.length]);

  // Focus goes back to where it was (the button that started the tour) when the tour ends.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    return () => before?.focus?.();
  }, []);

  useLayoutEffect(() => {
    if (!step) return;
    const el = findTarget(step);
    if (!el) {
      setBox(null);
      return;
    }
    bringIntoView(el);
    const measure = () => {
      const b = boxOf(el);
      setBox(b);
      const c = card.current?.getBoundingClientRect();
      if (c) setPos(placeCard(b, { width: c.width, height: c.height }, { width: window.innerWidth, height: window.innerHeight }));
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [step]);

  useEffect(() => {
    primary.current?.focus();
  }, [at]);

  const next = useCallback(() => (last ? closeRef.current() : setAt((i) => i + 1)), [last]);
  const back = useCallback(() => setAt((i) => Math.max(0, i - 1)), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
      } else if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") back();
      else if (e.key === "Tab") {
        // The page behind is covered: Tab moves between the card's own buttons.
        const buttons = [...(card.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
        if (!buttons.length) return;
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        e.preventDefault();
        buttons[(i + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length]!.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [next, back]);

  if (!step) return null;
  return overlay(
    <div data-testid="tour" className="app-look print:hidden">
      {/* Covers the page, so a click meant for the card can't land on what is behind it. */}
      <div aria-hidden className="fixed inset-0 z-[59]" />
      {box && (
        <div
          aria-hidden
          data-testid="tour-spotlight"
          className="pointer-events-none fixed z-[60] rounded-xl outline-2 outline-emerald-400 transition-[top,left,width,height] duration-200 motion-reduce:transition-none"
          style={{ top: box.top, left: box.left, width: box.width, height: box.height, boxShadow: "0 0 0 200vmax rgb(8 15 30 / 0.55)" }}
        />
      )}
      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        className="fixed z-[61] w-[min(22rem,calc(100vw-1.5rem))] rounded-xl border border-border bg-surface p-5 text-text shadow-[var(--shadow-lift)]"
        style={pos ? { top: pos.top, left: pos.left } : { top: 12, left: 12, visibility: "hidden" }}
      >
        <p className="text-xs font-medium text-muted" data-testid="tour-count">
          {at + 1} of {steps.length}
        </p>
        <div aria-live="polite">
          <h2 id="tour-title" className="mt-1 text-base font-semibold">{step.title}</h2>
          <p id="tour-body" className="mt-1.5 text-sm leading-relaxed text-muted">{step.body}</p>
        </div>
        <div className="mt-4 flex items-center gap-2">
          <button type="button" onClick={() => closeRef.current()} className="rounded px-2 py-1.5 text-sm font-medium text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-accent" data-testid="tour-skip">
            {last ? "Close" : "Skip"}
          </button>
          <span className="flex-1" />
          {at > 0 && (
            <button type="button" onClick={back} className="btn-secondary px-3 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-accent" data-testid="tour-back">
              Back
            </button>
          )}
          <button ref={primary} type="button" onClick={next} className="btn-primary px-3 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2" data-testid="tour-next">
            {last ? "Done" : "Next"}
          </button>
        </div>
      </div>
    </div>,
  );
}
