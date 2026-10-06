/**
 * Small, strongly consistent coordination primitives (rate-limit counters,
 * one-time OAuth state, short locks). On Cloudflare each key is backed by its
 * own Durable Object (see apps/cloudflare/src/coordinator.ts); tests use the
 * in-memory implementation below.
 */
export interface Coord {
  /** Fixed-window counter: records a hit and returns the count in the current window. */
  hit(key: string, windowSec: number): Promise<number>;
  /** Store a value that expires after `ttlSec`. */
  put(key: string, value: string, ttlSec: number): Promise<void>;
  /** Atomically read and delete a value (null when missing or expired). */
  take(key: string): Promise<string | null>;
  /** Try to take an expiring lock. Returns false if someone else holds it. */
  acquire(key: string, ttlMs: number): Promise<boolean>;
  release(key: string): Promise<void>;
  ping(): Promise<boolean>;
}

export function memoryCoord(): Coord & { clear(): void } {
  const m = new Map<string, { value: string; count: number; expiresAt: number }>();
  const live = (key: string) => {
    const e = m.get(key);
    if (e && e.expiresAt <= Date.now()) {
      m.delete(key);
      return undefined;
    }
    return e;
  };
  return {
    async hit(key, windowSec) {
      const e = live(key) ?? { value: "", count: 0, expiresAt: Date.now() + windowSec * 1000 };
      e.count++;
      m.set(key, e);
      return e.count;
    },
    async put(key, value, ttlSec) {
      m.set(key, { value, count: 0, expiresAt: Date.now() + ttlSec * 1000 });
    },
    async take(key) {
      const e = live(key);
      m.delete(key);
      return e?.value ?? null;
    },
    async acquire(key, ttlMs) {
      if (live(key)) return false;
      m.set(key, { value: "1", count: 0, expiresAt: Date.now() + ttlMs });
      return true;
    },
    async release(key) {
      m.delete(key);
    },
    async ping() {
      return true;
    },
    clear: () => m.clear(),
  };
}
