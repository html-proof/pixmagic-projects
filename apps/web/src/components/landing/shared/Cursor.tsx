"use client";
import { motion, useMotionValue, useSpring } from "motion/react";
import { useEffect, useState } from "react";
import { useReducedMotion } from "@/hooks/useReducedMotion";

/**
 * Desktop-only cursor: a 5px dot that tracks the pointer exactly, and a ring that trails it.
 * Over links and buttons the ring opens to 36px; over anything with `data-cursor="VIEW"` (or
 * EXPLORE, OPEN…) it also shows that word. Never rendered on touch or coarse pointers, and the
 * system cursor comes back whenever this one is inactive.
 */
export function Cursor() {
  const reduced = useReducedMotion();
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState<{ hover: boolean; label: string | null; visible: boolean; down: boolean }>({
    hover: false,
    label: null,
    visible: false,
    down: false,
  });
  const x = useMotionValue(-100);
  const y = useMotionValue(-100);
  const ringX = useSpring(x, { stiffness: 420, damping: 38, mass: 0.6 });
  const ringY = useSpring(y, { stiffness: 420, damping: 38, mass: 0.6 });

  useEffect(() => {
    const mq = window.matchMedia("(hover: hover) and (pointer: fine)");
    const sync = () => setEnabled(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const root = document.documentElement;
    root.classList.add("lp-cursor-on");
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      x.set(e.clientX);
      y.set(e.clientY);
      const el = e.target instanceof Element ? e.target : null;
      const labelled = el?.closest<HTMLElement>("[data-cursor]");
      const interactive = el?.closest("a, button, [role='button'], summary, label");
      const label = labelled?.dataset.cursor || null;
      const hover = Boolean(interactive || labelled);
      setState((s) => (s.hover === hover && s.label === label && s.visible ? s : { ...s, hover, label, visible: true }));
    };
    const onLeave = () => setState((s) => ({ ...s, visible: false }));
    const onDown = () => setState((s) => ({ ...s, down: true }));
    const onUp = () => setState((s) => ({ ...s, down: false }));
    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerleave", onLeave);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("blur", onLeave);
    return () => {
      root.classList.remove("lp-cursor-on");
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("blur", onLeave);
    };
  }, [enabled, x, y]);

  if (!enabled) return null;
  const ring = state.label ? 64 : state.hover ? 36 : 22;
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[1000]" style={{ opacity: state.visible ? 1 : 0, transition: "opacity .25s" }}>
      <motion.div
        className="absolute left-0 top-0 flex items-center justify-center rounded-full border"
        style={{
          x: reduced ? x : ringX,
          y: reduced ? y : ringY,
          width: ring,
          height: ring,
          marginLeft: -ring / 2,
          marginTop: -ring / 2,
          borderColor: state.hover ? "rgb(167 152 255 / 0.7)" : "rgb(255 255 255 / 0.18)",
          background: state.label ? "rgb(140 123 255 / 0.14)" : state.hover ? "rgb(140 123 255 / 0.08)" : "transparent",
          backdropFilter: state.label ? "blur(6px)" : undefined,
          // Plain CSS transitions for size and colour only: `transform` (the position) must not ease.
          transition: "width .35s var(--lp-ease), height .35s var(--lp-ease), margin .35s var(--lp-ease), background-color .3s, border-color .3s, opacity .2s",
          opacity: state.down ? 0.6 : 1,
        }}
      >
        {state.label && <span className="font-lp-mono text-[9.5px] font-medium tracking-[0.16em] text-lp-text">{state.label}</span>}
      </motion.div>
      <motion.div
        className="absolute left-0 top-0 size-[5px] rounded-full bg-lp-text"
        style={{ x, y, marginLeft: -2.5, marginTop: -2.5, opacity: state.label ? 0 : 1 }}
      />
    </div>
  );
}
