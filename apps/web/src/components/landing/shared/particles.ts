"use client";

/*
 * Particles drawn in one batch.
 *
 * The landing page's canvases stamp ~700–1,600 small shapes every frame. Drawn one by one with the
 * 2D canvas API, each shape is a separate command that Chrome records, ships to the GPU process and
 * replays there, on the same thread that composites the page: on integrated graphics that alone held
 * the GPU process at 60–100% and dropped frames while scrolling, however few pixels the shapes cover.
 * Here every particle of a frame goes into one buffer and is drawn by WebGL with a single instanced
 * call, on a canvas of its own stacked with the scene's 2D canvas. Where WebGL is unavailable (or its
 * context is lost) the same calls draw with the 2D canvas instead, exactly as before.
 *
 * Usage, inside a frame of useCanvasLoop:
 *   particles.begin(width, height, dpr);
 *   particles.add(x, y, w, h, SHAPE.circle, r, g, b, alpha);   // css px, colour 0–255
 *   particles.flush(ctx, "normal");                             // draws them, in the order added
 */

export const SHAPE = {
  /** Filled rectangle w × h (squares, dashes, trails). */
  rect: 0,
  /** Filled circle, diameter w. */
  circle: 1,
  /** Diamond, w from tip to tip. */
  diamond: 2,
  /** Circle outline: w = radius, h = line width. */
  ring: 3,
  /** Soft radial glows (ellipses w × h), one per profile below. */
  glow: 4,
  dot: 5,
  halo: 6,
  bead: 7,
} as const;
export type Shape = (typeof SHAPE)[keyof typeof SHAPE];

/**
 * Opacity along the radius (0 centre → 1 edge) of each soft shape: the radial gradients the scenes'
 * pre-rendered sprites used, so both renderers draw the same glow.
 */
const PROFILES: Record<number, readonly (readonly [number, number])[]> = {
  [SHAPE.glow]: [[0, 0.9], [0.35, 0.28], [1, 0]],
  [SHAPE.dot]: [[0, 1], [0.18, 0.92], [0.4, 0.28], [1, 0]],
  [SHAPE.halo]: [[0, 0.55], [0.4, 0.16], [1, 0]],
  [SHAPE.bead]: [[0, 1], [0.2132, 1], [0.26, 0.32], [0.55, 0.07], [1, 0]],
};

export type Blend = "normal" | "add";

/** "140, 123, 255" (the RGB constants in lib/motion) as numbers. */
export const rgbOf = (rgb: string) => rgb.split(",").map(Number) as [number, number, number];

export interface Particles {
  /** Start a frame: size of the scene in CSS px and its device pixel ratio. Clears the WebGL canvas. */
  begin(width: number, height: number, dpr: number): void;
  /** Queue one particle. Position and size in CSS px, colour 0–255, alpha 0–1. */
  add(x: number, y: number, w: number, h: number, shape: Shape, r: number, g: number, b: number, a: number): void;
  /**
   * Draw everything queued since the last flush, in order. WebGL draws onto its own canvas; the 2D
   * fallback draws onto `ctx` here, so call it where the particles belong in the scene's 2D order.
   */
  flush(ctx: CanvasRenderingContext2D, blend: Blend): void;
  /** True when the particles land on the WebGL canvas (the 2D canvas no longer has them). */
  readonly gpu: boolean;
}

/* ---- Shared queue ------------------------------------------------------------------------------ */

/** Floats per particle: x, y, w, h, shape, r, g, b, a. */
const STRIDE = 9;

class Queue {
  data = new Float32Array(STRIDE * 1024);
  n = 0;
  add(x: number, y: number, w: number, h: number, shape: number, r: number, g: number, b: number, a: number) {
    if ((this.n + 1) * STRIDE > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    const d = this.data;
    const o = this.n * STRIDE;
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = w;
    d[o + 3] = h;
    d[o + 4] = shape;
    d[o + 5] = r / 255;
    d[o + 6] = g / 255;
    d[o + 7] = b / 255;
    d[o + 8] = a;
    this.n++;
  }
}

/* ---- WebGL ------------------------------------------------------------------------------------- */

const VERTEX = `
attribute vec2 a_corner;
attribute vec2 a_center;
attribute vec2 a_size;
attribute float a_shape;
attribute vec4 a_color;
uniform vec2 u_view;
uniform float u_dpr;
varying vec2 v_local;
varying vec2 v_size;
varying float v_shape;
varying vec4 v_color;
void main() {
  float ring = step(2.5, a_shape) * step(a_shape, 3.5);
  vec2 extent = mix(a_size * 0.5, vec2(a_size.x + a_size.y), ring);
  vec2 local = a_corner * (extent + 1.0 / u_dpr);
  vec2 pos = a_center + local;
  gl_Position = vec4(pos.x / u_view.x * 2.0 - 1.0, 1.0 - pos.y / u_view.y * 2.0, 0.0, 1.0);
  v_local = local * u_dpr;
  v_size = a_size * u_dpr;
  v_shape = a_shape;
  v_color = a_color;
}`;

/** One piecewise-linear profile as GLSL, for `t` in 0..1 (0 beyond the edge). */
function profileGlsl(stops: readonly (readonly [number, number])[]) {
  const f = (n: number) => n.toFixed(5);
  let code = "if (t >= 1.0) return 0.0;\n";
  for (let i = 1; i < stops.length; i++) {
    const [t0, a0] = stops[i - 1];
    const [t1, a1] = stops[i];
    code += `if (t < ${f(t1)}) return mix(${f(a0)}, ${f(a1)}, (t - ${f(t0)}) / ${f(t1 - t0)});\n`;
  }
  return code + "return 0.0;";
}

const FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_local;
varying vec2 v_size;
varying float v_shape;
varying vec4 v_color;
${Object.entries(PROFILES)
  .map(([shape, stops]) => `float profile${shape}(float t) {\n${profileGlsl(stops)}\n}`)
  .join("\n")}
void main() {
  vec2 half_ = v_size * 0.5;
  float cover;
  if (v_shape < 0.5) {
    vec2 c = clamp(half_ - abs(v_local) + 0.5, 0.0, 1.0);
    cover = c.x * c.y;
  } else if (v_shape < 1.5) {
    cover = clamp(half_.x - length(v_local) + 0.5, 0.0, 1.0);
  } else if (v_shape < 2.5) {
    cover = clamp((half_.x - abs(v_local.x) - abs(v_local.y)) * 0.70710678 + 0.5, 0.0, 1.0);
  } else if (v_shape < 3.5) {
    cover = clamp(v_size.y * 0.5 - abs(length(v_local) - v_size.x) + 0.5, 0.0, 1.0);
  } else {
    float t = length(v_local / max(half_, vec2(0.0001)));
    ${Object.keys(PROFILES)
      .map((shape) => `if (v_shape < ${Number(shape) + 0.5}) cover = profile${shape}(t); else`)
      .join("\n    ")}
    cover = 0.0;
  }
  float a = v_color.a * cover;
  if (a <= 0.001) discard;
  gl_FragColor = vec4(v_color.rgb * a, a);
}`;

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
}

/**
 * A context whose particle program is compiling. Asking for its link status makes the page wait
 * until the GPU process has finished, so where the browser compiles in parallel
 * (KHR_parallel_shader_compile) that question is only asked once the compile has had time to end.
 */
interface GlPending {
  gl: WebGLRenderingContext;
  instancing: ANGLE_instanced_arrays;
  program: WebGLProgram;
  shaders: WebGLShader[];
  parallel: { COMPLETION_STATUS_KHR: number } | null;
}

interface GlState {
  gl: WebGLRenderingContext;
  instancing: ANGLE_instanced_arrays;
  buffer: WebGLBuffer;
  view: WebGLUniformLocation | null;
  dpr: WebGLUniformLocation | null;
  capacity: number;
}

function startGl(canvas: HTMLCanvasElement): GlPending | null {
  const gl = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    // Software-emulated WebGL (no usable GPU) is slower than the 2D canvas: use the fallback there.
    failIfMajorPerformanceCaveat: true,
  });
  if (!gl) return null;
  const instancing = gl.getExtension("ANGLE_instanced_arrays");
  if (!instancing) return null;
  const parallel = gl.getExtension("KHR_parallel_shader_compile") as { COMPLETION_STATUS_KHR: number } | null;
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
  const program = gl.createProgram();
  if (!vs || !fs || !program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  return { gl, instancing, program, shaders: [vs, fs], parallel };
}

function finishGl({ gl, instancing, program, shaders }: GlPending): GlState | null {
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    if (!gl.isContextLost()) console.warn("particles: WebGL program did not link", shaders.map((sh) => gl.getShaderInfoLog(sh)).join(" "), gl.getProgramInfoLog(program));
    return null;
  }
  gl.useProgram(program);

  const corners = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, corners);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const corner = gl.getAttribLocation(program, "a_corner");
  gl.enableVertexAttribArray(corner);
  gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);

  const buffer = gl.createBuffer();
  if (!buffer) return null;
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  const bytes = STRIDE * 4;
  const instanced: [string, number, number][] = [
    ["a_center", 2, 0],
    ["a_size", 2, 2],
    ["a_shape", 1, 4],
    ["a_color", 4, 5],
  ];
  for (const [name, size, offset] of instanced) {
    const loc = gl.getAttribLocation(program, name);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, bytes, offset * 4);
    instancing.vertexAttribDivisorANGLE(loc, 1);
  }
  gl.enable(gl.BLEND);
  gl.clearColor(0, 0, 0, 0);
  return { gl, instancing, buffer, view: gl.getUniformLocation(program, "u_view"), dpr: gl.getUniformLocation(program, "u_dpr"), capacity: 0 };
}

/*
 * Setting a context up is the expensive part: creating it and compiling the program takes the GPU
 * process ~50–300ms the first time on Windows, on the thread that also composites the page, so
 * doing it the moment a scene scrolls into view (or during the intro) froze the page. Scenes queue
 * here instead and are set up one at a time, in idle moments, once the landing page says the
 * opening has finished (allowGpuParticles); until then they draw with the 2D fallback.
 */
const setupQueue: GlParticles[] = [];
let setupAllowed = false;
let settingUp = false;

const whenIdle = (cb: () => void) =>
  typeof window.requestIdleCallback === "function" ? window.requestIdleCallback(cb, { timeout: 2000 }) : window.setTimeout(cb, 200);

/** Runs `cb` in the browser's next idle period (a short timeout where there is none); returns a cancel. */
export function onIdle(cb: () => void) {
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(cb, { timeout: 2000 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(cb, 200);
  return () => window.clearTimeout(id);
}

function setUpNext() {
  if (!setupAllowed || settingUp) return;
  const next = setupQueue.shift();
  if (!next) return;
  settingUp = true;
  whenIdle(() =>
    next.setUp(() => {
      settingUp = false;
      setUpNext();
    }),
  );
}

/** Lets the queued scenes switch to WebGL (one at a time, when the browser is idle). */
export function allowGpuParticles() {
  setupAllowed = true;
  setUpNext();
}

/**
 * WebGL once its context is set up; until then (and for good if it never is, or the context is
 * lost and not restored) the 2D fallback draws the queued particles onto the scene's 2D canvas.
 */
class GlParticles implements Particles {
  private queue = new Queue();
  private fallback = new CanvasParticles(this.queue);
  private state: GlState | null = null;
  private lost = false;

  constructor(private canvas: HTMLCanvasElement) {
    canvas.addEventListener("webglcontextlost", this.onLost);
    canvas.addEventListener("webglcontextrestored", this.onRestored);
    setupQueue.push(this);
    setUpNext();
  }

  /**
   * Creates the context and starts compiling. Where the browser compiles in parallel the link
   * result is only read a moment later, so reading it never waits on the compile.
   */
  setUp(done: () => void) {
    const pending = startGl(this.canvas);
    if (!pending) return done();
    const finish = () => {
      this.state = finishGl(pending);
      done();
    };
    if (pending.parallel) window.setTimeout(() => whenIdle(finish), 400);
    else finish();
  }

  get gpu() {
    return this.state !== null && !this.lost;
  }

  private onLost = (e: Event) => {
    e.preventDefault();
    this.lost = true;
  };

  private onRestored = () => {
    this.state = null;
    this.lost = false;
    setupQueue.push(this);
    setUpNext();
  };

  begin(width: number, height: number, dpr: number) {
    this.queue.n = 0;
    const s = this.state;
    if (!s || this.lost) return;
    const { gl } = s;
    const w = Math.max(1, Math.round(width * dpr));
    const h = Math.max(1, Math.round(height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.uniform2f(s.view, width, height);
    gl.uniform1f(s.dpr, dpr);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  add(x: number, y: number, w: number, h: number, shape: Shape, r: number, g: number, b: number, a: number) {
    this.queue.add(x, y, w, h, shape, r, g, b, a);
  }

  flush(ctx: CanvasRenderingContext2D, blend: Blend) {
    const s = this.state;
    const q = this.queue;
    if (!s || this.lost) {
      this.fallback.flush(ctx, blend);
      return;
    }
    if (q.n === 0) return;
    const { gl } = s;
    gl.bindBuffer(gl.ARRAY_BUFFER, s.buffer);
    if (q.data.length > s.capacity) {
      gl.bufferData(gl.ARRAY_BUFFER, q.data.byteLength, gl.DYNAMIC_DRAW);
      s.capacity = q.data.length;
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, q.data.subarray(0, q.n * STRIDE));
    if (blend === "add") gl.blendFunc(gl.ONE, gl.ONE);
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    s.instancing.drawArraysInstancedANGLE(gl.TRIANGLE_STRIP, 0, 4, q.n);
    q.n = 0;
  }
}

/* ---- 2D fallback ------------------------------------------------------------------------------- */

const SPRITE_PX = 48;
const spriteCache = new Map<string, HTMLCanvasElement>();

function sprite(shape: number, r: number, g: number, b: number) {
  const key = `${shape}:${r},${g},${b}`;
  let c = spriteCache.get(key);
  if (!c) {
    c = document.createElement("canvas");
    c.width = c.height = SPRITE_PX;
    const ctx = c.getContext("2d");
    if (ctx) {
      const h = SPRITE_PX / 2;
      const grad = ctx.createRadialGradient(h, h, 0, h, h, h);
      for (const [t, a] of PROFILES[shape]) grad.addColorStop(t, `rgba(${r}, ${g}, ${b}, ${a})`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, SPRITE_PX, SPRITE_PX);
    }
    spriteCache.set(key, c);
  }
  return c;
}

class CanvasParticles implements Particles {
  readonly gpu = false;
  constructor(private queue = new Queue()) {}

  begin() {
    this.queue.n = 0;
  }

  add(x: number, y: number, w: number, h: number, shape: Shape, r: number, g: number, b: number, a: number) {
    this.queue.add(x, y, w, h, shape, r, g, b, a);
  }

  flush(ctx: CanvasRenderingContext2D, blend: Blend) {
    const { data: d, n } = this.queue;
    const op = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = blend === "add" ? "lighter" : "source-over";
    let fill = "";
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE;
      const x = d[o];
      const y = d[o + 1];
      const w = d[o + 2];
      const h = d[o + 3];
      const shape = d[o + 4];
      const r = Math.round(d[o + 5] * 255);
      const g = Math.round(d[o + 6] * 255);
      const b = Math.round(d[o + 7] * 255);
      ctx.globalAlpha = d[o + 8];
      if (shape >= SHAPE.glow) {
        ctx.drawImage(sprite(shape, r, g, b), x - w / 2, y - h / 2, w, h);
        continue;
      }
      const style = `rgb(${r}, ${g}, ${b})`;
      if (shape === SHAPE.ring) {
        ctx.strokeStyle = style;
        ctx.lineWidth = h;
        ctx.beginPath();
        ctx.arc(x, y, w, 0, Math.PI * 2);
        ctx.stroke();
        continue;
      }
      if (style !== fill) ctx.fillStyle = fill = style;
      if (shape === SHAPE.rect) ctx.fillRect(x - w / 2, y - h / 2, w, h);
      else if (shape === SHAPE.circle) {
        ctx.beginPath();
        ctx.arc(x, y, w / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        const s = w / 2;
        ctx.beginPath();
        ctx.moveTo(x, y - s);
        ctx.lineTo(x + s, y);
        ctx.lineTo(x, y + s);
        ctx.lineTo(x - s, y);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = op;
    this.queue.n = 0;
  }
}

/**
 * The particle renderer for a scene: WebGL on `glCanvas` when the browser can, the 2D fallback
 * otherwise (pass null to force it, e.g. for a single still frame).
 */
export function createParticles(glCanvas: HTMLCanvasElement | null): Particles {
  return glCanvas ? new GlParticles(glCanvas) : new CanvasParticles();
}
