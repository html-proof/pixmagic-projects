import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { disconnectDb } from "@app/db";
import { AdsRateLimitedError, memoryBlobs, memoryCoord, memoryMailer, memoryQueues, type AdsSyncData, type FetchLike } from "@app/core";
import type { WorkerDeps } from "../src/handlers.js";
import { consume, type QueueMessage } from "../src/index.js";

/**
 * A platform that asks bizinsights to wait (Meta's throttling, a Google rate limit) is waited for
 * without spending the job's retries. The sync itself is stood in for: what matters here is what the
 * queue does with the error it throws.
 */

const state = vi.hoisted(() => ({ err: null as unknown, busy: false }));
vi.mock("@app/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@app/core")>();
  return {
    ...core,
    syncAdConnection: vi.fn(async () => {
      if (state.err) throw state.err;
      return { skipped: true, reason: state.busy ? "busy" : "nothing" };
    }),
  };
});

const queues = memoryQueues();
const deps: WorkerDeps & { dbHealthy: () => Promise<boolean> } = {
  coord: memoryCoord(),
  queues,
  payloads: memoryBlobs(),
  mailer: memoryMailer(),
  fetchImpl: (async () => new Response("{}")) as FetchLike,
  dbHealthy: async () => true,
};
afterAll(async () => disconnectDb());
beforeEach(() => {
  queues.clear();
  state.err = null;
  state.busy = false;
});

function message(body: AdsSyncData & { rateDeferral?: { count: number; since: number }; busyDeferral?: { count: number; since: number } }, attempts = 1) {
  const m = { acked: false, retried: null as null | { delaySeconds?: number } };
  const msg: QueueMessage = { id: "m1", body, attempts, ack: () => (m.acked = true), retry: (o) => (m.retried = o ?? {}) };
  return { msg, m };
}

const job: AdsSyncData = { kind: "ads", connectionId: "c1", since: "2026-10-17", until: "2026-10-19", trigger: "schedule" };

describe("an ad platform asking to wait", () => {
  it("is waited for as long as it said, as a new message, without spending a retry", async () => {
    state.err = new AdsRateLimitedError("There have been too many calls to this ad-account", 120);
    const { msg, m } = message(job, 3);
    await consume("sync", msg, deps);
    expect(m).toEqual({ acked: true, retried: null });
    expect(queues.sent.sync).toEqual([{ ...job, rateDeferral: { count: 1, since: expect.any(Number) } }]);
    const delay = queues.sentOpts.sync[0]!.delaySeconds!;
    expect(delay).toBeGreaterThanOrEqual(120);
    expect(delay).toBeLessThan(150);
  });

  it("without a wait given, waits longer each time, and after six hours lets the ordinary retries take over", async () => {
    state.err = new AdsRateLimitedError("User request limit reached", null);
    const since = Date.now() - 3600_000;
    await consume("sync", message({ ...job, rateDeferral: { count: 3, since } }).msg, deps);
    expect(queues.sent.sync[0]).toMatchObject({ rateDeferral: { count: 4, since } });
    expect(queues.sentOpts.sync[0]!.delaySeconds).toBeGreaterThanOrEqual(480);
    // Waited long enough: an ordinary retry, which the last attempt records.
    const late = message({ ...job, rateDeferral: { count: 12, since: Date.now() - 7 * 3600_000 } });
    await consume("sync", late.msg, deps);
    expect(queues.sent.sync).toHaveLength(1);
    expect(late.m.acked).toBe(false);
    expect(late.m.retried).not.toBeNull();
  });
});

describe("another sync of the same ad account running", () => {
  it("is waited for a little longer each time, as a new message, spending no retry; a wait for the platform goes on with it", async () => {
    state.busy = true;
    const { msg, m } = message(job, 4);
    await consume("sync", msg, deps);
    expect(m).toEqual({ acked: true, retried: null });
    expect(queues.sent.sync).toEqual([{ ...job, busyDeferral: { count: 1, since: expect.any(Number) } }]);
    expect(queues.sentOpts.sync[0]!.delaySeconds).toBeLessThan(30);
    // Later re-sends wait longer, up to five minutes, and keep the platform's count as it was.
    const since = Date.now() - 600_000;
    const rate = { count: 2, since: Date.now() - 900_000 };
    await consume("sync", message({ ...job, rateDeferral: rate, busyDeferral: { count: 6, since } }).msg, deps);
    expect(queues.sent.sync[1]).toEqual({ ...job, rateDeferral: rate, busyDeferral: { count: 7, since } });
    expect(queues.sentOpts.sync[1]!.delaySeconds).toBeGreaterThanOrEqual(300);
    expect(queues.sentOpts.sync[1]!.delaySeconds).toBeLessThan(315);
  });

  it("after two hours lets the ordinary retries take over", async () => {
    state.busy = true;
    const late = message({ ...job, busyDeferral: { count: 30, since: Date.now() - 2 * 3600_000 - 1 } });
    await consume("sync", late.msg, deps);
    expect(queues.sent.sync).toEqual([]);
    expect(late.m.acked).toBe(false);
    expect(late.m.retried).not.toBeNull();
  });
});
