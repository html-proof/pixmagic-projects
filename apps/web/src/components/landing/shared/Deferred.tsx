"use client";
import { Suspense, use, useEffect, useRef, type ReactNode } from "react";

/*
 * Deferred hydration for the scenes below the hero.
 *
 * Every scene is in the static HTML (readable, laid out, indexable), but hydrating all of them in
 * one go held a phone's main thread for half a second at a time, and the opening could only start
 * after it. Each <Deferred> is its own Suspense boundary whose content suspends during the first
 * hydration until it is released; React leaves the server HTML untouched until then. A scene is
 * released when it comes within a screen of the viewport, when someone points at or focuses inside
 * it, or in the browser's idle moments (one scene per idle period), so the whole page is live
 * within a few seconds of loading, hydrated in small pieces between the opening's frames.
 */

interface Gate {
  released: boolean;
  promise: Promise<void>;
  release: () => void;
}

const gates = new Map<string, Gate>();

function gate(id: string): Gate {
  let g = gates.get(id);
  if (!g) {
    let resolve = () => {};
    const promise = new Promise<void>((r) => (resolve = r));
    const created: Gate = {
      released: false,
      promise,
      release: () => {
        if (created.released) return;
        created.released = true;
        resolve();
      },
    };
    gates.set(id, created);
    g = created;
  }
  return g;
}

/** Releases the remaining scenes in page order, one per idle period, from `delayMs` on. */
export function releaseWhenIdle(delayMs: number) {
  // Safari has no requestIdleCallback; a short timeout keeps the queue moving there.
  const idle = (cb: () => void) =>
    typeof window.requestIdleCallback === "function" ? window.requestIdleCallback(cb, { timeout: 1500 }) : setTimeout(cb, 120);
  let cancelled = false;
  const next = () => {
    if (cancelled) return;
    const pending = [...gates.values()].find((g) => !g.released);
    if (!pending) return;
    pending.release();
    idle(next);
  };
  const timer = window.setTimeout(() => idle(next), delayMs);
  return () => {
    cancelled = true;
    window.clearTimeout(timer);
  };
}

/**
 * Only the first hydration waits: that is when this scene's server HTML is already in the
 * document. A client-side visit back to `/` has no HTML to keep, so it renders straight away.
 */
const hasServerHtml = (id: string) => typeof document !== "undefined" && document.querySelector(`[data-deferred="${id}"]`) !== null;

function Gated({ id, children }: { id: string; children: ReactNode }) {
  const g = gate(id);
  if (!g.released && hasServerHtml(id)) use(g.promise);
  return children;
}

export function Deferred({ id, children }: { id: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // Registered during render, so the idle queue releases scenes in page order.
  gate(id);

  useEffect(() => {
    const g = gate(id);
    const el = ref.current;
    if (g.released || !el) return;
    const release = () => g.release();
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && release(), {
      rootMargin: "100% 0px 100% 0px",
    });
    io.observe(el);
    el.addEventListener("pointerdown", release, { capture: true, once: true });
    el.addEventListener("focusin", release, { capture: true, once: true });
    void g.promise.then(() => io.disconnect());
    return () => {
      io.disconnect();
      el.removeEventListener("pointerdown", release, { capture: true });
      el.removeEventListener("focusin", release, { capture: true });
    };
  }, [id]);

  return (
    <div ref={ref} data-deferred={id}>
      <Suspense fallback={null}>
        <Gated id={id}>{children}</Gated>
      </Suspense>
    </div>
  );
}
