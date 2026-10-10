"use client";
import { useEffect, useRef, type RefObject } from "react";

export interface CanvasFrame {
  /** Canvas size in CSS pixels (the context is already scaled for the device pixel ratio). */
  width: number;
  height: number;
  /** Milliseconds since the loop started. */
  time: number;
  /** Milliseconds since the previous frame, capped at 64 so a background tab doesn't jump. */
  dt: number;
  /** True when the size changed since the previous frame: rebuild layouts that depend on it. */
  resized: boolean;
}

export interface CanvasLoopOptions {
  /** Draw a single frame (and again on resize) instead of animating: reduced motion. */
  still?: boolean;
  /** Upper bound for the device pixel ratio (2 keeps 4K/retina canvases affordable). */
  maxDpr?: number;
}

/**
 * Runs `draw` every animation frame while the canvas is on screen and the tab is visible, and
 * pauses otherwise. Handles device-pixel-ratio scaling and resizing (ResizeObserver). `draw`
 * may change between renders; the latest one is always used, so it can read MotionValues with
 * `.get()` without re-subscribing anything.
 */
export function useCanvasLoop(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  draw: (ctx: CanvasRenderingContext2D, frame: CanvasFrame) => void,
  { still = false, maxDpr = 2 }: CanvasLoopOptions = {},
) {
  const drawRef = useRef(draw);
  drawRef.current = draw;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let resized = true;
    let visible = false;
    let raf = 0;
    let start = 0;
    let last = 0;

    const resize = () => {
      // Layout size, not getBoundingClientRect: that includes CSS transforms, so a canvas inside a
      // scaled parent (the hero shrinking into a window) would be sized too small.
      const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
      const w = Math.max(1, canvas.clientWidth);
      const h = Math.max(1, canvas.clientHeight);
      if (w === width && h === height && canvas.width === Math.round(w * dpr)) return false;
      width = w;
      height = h;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      resized = true;
      return true;
    };

    const frame = (now: number) => {
      raf = 0;
      if (!start) start = last = now;
      const dt = Math.min(64, now - last);
      last = now;
      drawRef.current(ctx, { width, height, time: now - start, dt, resized });
      resized = false;
      if (!still && visible && !document.hidden) raf = requestAnimationFrame(frame);
    };
    const kick = () => {
      if (!raf && visible && !document.hidden) raf = requestAnimationFrame(frame);
    };

    const ro = new ResizeObserver(() => {
      if (resize() && still) kick();
    });
    ro.observe(canvas);
    const io = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        if (visible) kick();
      },
      { rootMargin: "120px" },
    );
    io.observe(canvas);
    const onVisibility = () => {
      if (!document.hidden) {
        last = performance.now();
        kick();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    resize();

    return () => {
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [canvasRef, still, maxDpr]);
}
