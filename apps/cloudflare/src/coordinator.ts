import { DurableObject } from "cloudflare:workers";
import type { Coord } from "@app/core";

interface Entry {
  value: string;
  count: number;
  expiresAt: number;
}

/**
 * One instance per key (rate-limit window, OAuth state nonce, lock). A Durable
 * Object processes its calls one at a time against its own storage, which makes
 * every operation below atomic. An alarm deletes the entry once it expires, so
 * idle objects keep no data.
 */
export class Coordinator extends DurableObject<Env> {
  private async live(): Promise<Entry | undefined> {
    const e = await this.ctx.storage.get<Entry>("e");
    if (e && e.expiresAt <= Date.now()) {
      await this.ctx.storage.deleteAll();
      return undefined;
    }
    return e;
  }

  private async save(e: Entry) {
    await this.ctx.storage.put("e", e);
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > e.expiresAt) await this.ctx.storage.setAlarm(e.expiresAt);
  }

  async hit(windowSec: number): Promise<number> {
    const e = (await this.live()) ?? { value: "", count: 0, expiresAt: Date.now() + windowSec * 1000 };
    e.count++;
    await this.save(e);
    return e.count;
  }

  async put(value: string, ttlSec: number): Promise<void> {
    await this.save({ value, count: 0, expiresAt: Date.now() + ttlSec * 1000 });
  }

  async take(): Promise<string | null> {
    const e = await this.live();
    if (!e) return null;
    await this.ctx.storage.deleteAll();
    return e.value;
  }

  /** Read without consuming (blob storage fallback). */
  async peek(): Promise<string | null> {
    return (await this.live())?.value ?? null;
  }

  async acquire(ttlMs: number): Promise<boolean> {
    if (await this.live()) return false;
    await this.save({ value: "1", count: 0, expiresAt: Date.now() + ttlMs });
    return true;
  }

  async release(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  ping(): boolean {
    return true;
  }

  override async alarm() {
    const e = await this.ctx.storage.get<Entry>("e");
    if (!e || e.expiresAt <= Date.now()) await this.ctx.storage.deleteAll();
    else await this.ctx.storage.setAlarm(e.expiresAt);
  }
}

/** Coord backed by Coordinator objects, addressed by key. */
export function durableCoord(ns: DurableObjectNamespace<Coordinator>): Coord {
  const stub = (key: string) => ns.get(ns.idFromName(key));
  return {
    hit: (key, windowSec) => stub(key).hit(windowSec),
    put: (key, value, ttlSec) => stub(key).put(value, ttlSec),
    take: (key) => stub(key).take(),
    acquire: (key, ttlMs) => stub(key).acquire(ttlMs),
    release: (key) => stub(key).release(),
    ping: () => stub("__ping").ping(),
  };
}
