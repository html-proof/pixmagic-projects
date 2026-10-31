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
 * Shortest time between two drawn frames. A 120–144 Hz screen offers a frame every 7–8 ms, and a
 * full-screen scene redrawn that often kept integrated graphics (and the page's main thread) busy
 * with nothing to show for it: drifting points look the same at half that rate. So those screens
 * draw every other frame (60–72 a second), while 60–100 Hz screens still draw every frame.
 */
const MIN_FRAME_GAP_MS = 9.5;
/**
 * After a frame is drawn, the next one is only asked for this much later, past the next refresh
 * on a 120–144 Hz screen: an animation frame that is asked for costs the page a full update even
 * when nothing gets drawn in it.
 */
const ASK_AFTER_MS = 8.5;

/**
 * Runs `draw` on animation frames (at most one every MIN_FRAME_GAP_MS) while the canvas is on
 * screen and the tab is visible, and pauses otherwise. Handles device-pixel-ratio scaling and
 * resizing (ResizeObserver). `draw` may change between renders; the latest one is always used,
 * so it can read MotionValues with `.get()` without re-subscribing anything.
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
    let timer = 0;
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

    const running = () => visible && !document.hidden;
    const frame = (now: number) => {
      raf = 0;
      // A fast screen came round again before the gap was up: skip this one.
      if (start && !resized && now - last < MIN_FRAME_GAP_MS) {
        if (!still && running()) raf = requestAnimationFrame(frame);
        return;
      }
      if (!start) start = last = now;
      const dt = Math.min(64, now - last);
      last = now;
      drawRef.current(ctx, { width, height, time: now - start, dt, resized });
      resized = false;
      if (!still && running()) {
        timer = window.setTimeout(() => {
          timer = 0;
          if (!raf && running()) raf = requestAnimationFrame(frame);
        }, ASK_AFTER_MS);
      }
    };
    const kick = () => {
      if (!raf && !timer && running()) raf = requestAnimationFrame(frame);
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
      if (timer) window.clearTimeout(timer);
    };
  }, [canvasRef, still, maxDpr]);
}
