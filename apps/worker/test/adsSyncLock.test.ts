import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { disconnectDb, systemDb } from "@app/db";
import { resetDb } from "@app/db/testing";
import {
  encryptAdTokens,
  enqueueAdCatchUp,
  memoryBlobs,
  memoryCoord,
  memoryMailer,
  memoryQueues,
  metaAdsPaused,
  resetEnvCache,
  syncAdConnection,
  type AdsSyncData,
  type AdsSyncTrigger,
  type FetchLike,
} from "@app/core";
import { addDays, localDay } from "@app/shared";
import { scheduleAdsSync, type WorkerDeps } from "../src/handlers.js";
import { consume, type QueueMessage } from "../src/index.js";

/**
 * One sync of an ad account at a time (the coordinator's lock per connection), and Meta's limit on
 * bizinsights' app (code 4), which pauses every Meta account's syncs while one account's or one
 * person's throttling stays with its own job. The platforms are stood in for at the fetch.
 */

const queues = memoryQueues();
const coord = memoryCoord();
let fetchImpl: FetchLike;
let deps: WorkerDeps;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const KEYS = { META_APP_ID: "a", META_APP_SECRET: "s", GOOGLE_ADS_CLIENT_ID: "c", GOOGLE_ADS_CLIENT_SECRET: "cs", GOOGLE_ADS_ENABLED: "1" };

beforeAll(() => {
  Object.assign(process.env, KEYS);
  resetEnvCache();
  deps = { coord, queues, payloads: memoryBlobs(), mailer: memoryMailer(), fetchImpl: ((...a: Parameters<FetchLike>) => fetchImpl(...a)) as FetchLike };
});
afterAll(async () => disconnectDb());
beforeEach(async () => {
  await resetDb();
  queues.clear();
  coord.clear();
  fetchImpl = async (input) => {
    throw new Error(`unexpected fetch ${String(input)}`);
  };
});

let stores = 0;
/** A connected account; who granted it is known already, so a sync makes only its own calls. */
async function connection(provider: "meta" | "google", over: Record<string, unknown> = {}) {
  const ws = await systemDb.workspace.create({ data: { name: "W" } });
  const n = ++stores;
  const store = await systemDb.store.create({ data: { workspaceId: ws.id, shopDomain: `l${n}.myshopify.com`, grantedScopes: ["read_orders"], status: "active", timezone: "UTC", pixelIngestKey: `pk-l${n}` } });
  const expiresAt = new Date(Date.now() + (provider === "meta" ? 40 : 1) * 86_400_000);
  const enc = encryptAdTokens(store.id, provider, { accessToken: "ACCESS", refreshToken: provider === "meta" ? null : "REFRESH", expiresAt });
  return systemDb.adConnection.create({
    data: { workspaceId: ws.id, storeId: store.id, provider, accountId: provider === "meta" ? "act_1" : "111", accountName: "Shop ads", currency: "USD", timezone: "UTC", externalUserId: "2001", ...enc, ...over },
  });
}

async function run(body: AdsSyncData, attempts = 1) {
  const m = { acked: false, retried: null as null | { delaySeconds?: number } };
  const msg: QueueMessage = { id: "m1", body, attempts, ack: () => (m.acked = true), retry: (o) => (m.retried = o ?? {}) };
  await consume("sync", msg, deps);
  return m;
}

const today = () => localDay(new Date(), "UTC");
const row = (id: string) => systemDb.adConnection.findUniqueOrThrow({ where: { id } });
const sent = () => queues.sent.sync as unknown as Array<AdsSyncData & { busyDeferral?: { count: number; since: number }; rateDeferral?: unknown }>;
/** The jobs sent again because another sync of their account was running. */
const waiting = () => sent().filter((j) => j.busyDeferral);
const job = (connectionId: string, trigger: AdsSyncTrigger = "schedule", since = today()): AdsSyncData => ({ kind: "ads", connectionId, since, until: today(), trigger });

/**
 * Meta answering every call with no rows, its insights only once let go: the sync reading them holds
 * its account meanwhile. Each call is recorded with the first day it asked for.
 */
function heldMeta() {
  let letGo!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((r) => (letGo = r));
  const arrived = new Promise<void>((r) => (reached = r));
  const calls: Array<{ path: string; since: string | null }> = [];
  const impl: FetchLike = async (input) => {
    const u = new URL(String(input));
    const range = u.searchParams.get("time_range");
    calls.push({ path: u.pathname, since: range ? (JSON.parse(range) as { since: string }).since : null });
    if (u.pathname.endsWith("/insights")) {
      reached();
      await gate;
    }
    return json({ data: [] });
  };
  return { fetchImpl: impl, calls, arrived, letGo: () => letGo() };
}

describe("one sync of an ad account at a time", () => {
  it("two at once: one calls the platform; the other reads nothing and is sent again shortly, spending no retry", async () => {
    const conn = await connection("meta");
    const held = heldMeta();
    fetchImpl = held.fetchImpl;
    const first = run(job(conn.id));
    await held.arrived;
    // A Refresh's catch-up of the same account, on its third attempt.
    const refresh = job(conn.id, "request", addDays(today(), -2));
    const askedFor = () => held.calls.filter((c) => c.since === addDays(today(), -2));
    const before = held.calls.length;
    expect(await run(refresh, 3)).toEqual({ acked: true, retried: null });
    // No call of any kind: not its days, nor the account, the person or the token.
    expect(held.calls).toHaveLength(before);
    expect(askedFor()).toEqual([]);
    expect(waiting()).toEqual([{ ...refresh, busyDeferral: { count: 1, since: expect.any(Number) } }]);
    const delay = queues.sentOpts.sync[sent().indexOf(waiting()[0]!)]!.delaySeconds!;
    expect(delay).toBeGreaterThanOrEqual(15);
    expect(delay).toBeLessThan(30);
    held.letGo();
    expect(await first).toEqual({ acked: true, retried: null });
    // Sent again, it finds the account free and reads its days.
    expect(await run(waiting()[0]!)).toEqual({ acked: true, retried: null });
    expect(askedFor().length).toBeGreaterThan(0);
    expect(waiting()).toHaveLength(1);
  });

  it("a Refresh that finds a sync running still gets its days, and the card says Synchronizing until they have landed", async () => {
    const conn = await connection("meta", { historyFrom: addDays(today(), -100), syncedThrough: addDays(today(), -1) });
    await enqueueAdCatchUp(queues, conn, { interactive: true });
    const refresh = sent()[0]!;
    const held = heldMeta();
    fetchImpl = held.fetchImpl;
    // The schedule's sync of the account has started before the Refresh's job comes.
    const scheduled = run(job(conn.id, "schedule", addDays(today(), -2)));
    await held.arrived;
    expect(await run(refresh)).toEqual({ acked: true, retried: null });
    held.letGo();
    await scheduled;
    expect((await row(conn.id)).syncRequestedAt).not.toBeNull();
    await run(waiting()[0]!);
    expect(await row(conn.id)).toMatchObject({ status: "active", syncRequestedAt: null, syncedThrough: today() });
  });

  it("the lock is given back when the sync fails", async () => {
    const conn = await connection("meta");
    fetchImpl = async () => json({ error: { message: "Service temporarily unavailable" } }, 503);
    expect((await run(job(conn.id))).retried).not.toBeNull();
    let calls = 0;
    fetchImpl = async () => (calls++, json({ data: [] }));
    expect(await run(job(conn.id))).toEqual({ acked: true, retried: null });
    expect(calls).toBeGreaterThan(0);
    expect(waiting()).toEqual([]);
  });

  it("the daily look at an account with nothing new to read isn't held back by a sync of it", async () => {
    const conn = await connection("meta", { status: "unavailable", errorCode: "account_closed", accountStatus: "closed" });
    const held = heldMeta();
    fetchImpl = held.fetchImpl;
    const syncing = run(job(conn.id));
    await held.arrived;
    expect(await run({ ...job(conn.id), healthOnly: true })).toEqual({ acked: true, retried: null });
    // One read of the account itself, not of its insights.
    expect(held.calls.filter((c) => !c.path.endsWith("/insights"))).toEqual([{ path: expect.stringMatching(/\/act_1$/), since: null }]);
    expect(waiting()).toEqual([]);
    held.letGo();
    await syncing;
  });

  it("without a coordinator (tests, ops scripts) two syncs run side by side, as before", async () => {
    const conn = await connection("meta");
    const held = heldMeta();
    const first = syncAdConnection(conn.id, today(), today(), held.fetchImpl, { queues });
    await held.arrived;
    let calls = 0;
    const meta: FetchLike = async () => (calls++, json({ data: [] }));
    expect(await syncAdConnection(conn.id, today(), today(), meta, { queues })).toMatchObject({ skipped: false });
    expect(calls).toBeGreaterThan(0);
    held.letGo();
    expect(await first).toMatchObject({ skipped: false });
  });
});

describe("Meta's limit on bizinsights' app (code 4)", () => {
  const old = () => new Date(Date.now() - 2 * 3600_000);

  it("pauses every Meta account's syncs: none is scheduled, one queued already doesn't call Meta, and a Refresh says why; Google's go on", async () => {
    const a = await connection("meta", { createdAt: old() });
    const b = await connection("meta", { createdAt: old(), accountId: "act_2" });
    const g = await connection("google", { createdAt: old() });
    const meta: string[] = [];
    let google = 0;
    fetchImpl = async (input) => {
      const u = new URL(String(input));
      if (u.host === "graph.facebook.com") {
        meta.push(u.pathname);
        return json({ error: { message: "(#4) Application request limit reached", type: "OAuthException", code: 4 } }, 400);
      }
      google++;
      return json([{ results: [] }]);
    };
    // a's sync meets it: it waits out the pause (sent again for then, no retry spent), and the account isn't blamed.
    expect(await run(job(a.id))).toEqual({ acked: true, retried: null });
    expect(await metaAdsPaused(coord)).toBe(true);
    expect(sent()).toEqual([{ ...job(a.id), rateDeferral: { count: 1, since: expect.any(Number) } }]);
    expect(queues.sentOpts.sync[0]!.delaySeconds).toBeGreaterThanOrEqual(905);
    expect(await row(a.id)).toMatchObject({ status: "active", errorCode: null, consecutiveFailures: 0 });
    const asked = meta.length;

    // The schedule queues none of Meta's accounts; Google's as ever.
    queues.clear();
    await scheduleAdsSync(deps);
    expect(sent().map((j) => j.connectionId)).toEqual([g.id]);
    // b's sync, queued before the pause: no call to Meta, and nothing to mark.
    expect(await run(job(b.id))).toEqual({ acked: true, retried: null });
    expect(meta).toHaveLength(asked);
    expect(await row(b.id)).toMatchObject({ status: "active", errorCode: null, consecutiveFailures: 0 });
    // Refresh of b, pressed again and again: still no call, and the card says why ("Meta asked bizinsights
    // to slow down"). The limit is bizinsights', so no failure is counted against the account.
    for (let press = 0; press < 4; press++) {
      queues.clear();
      await enqueueAdCatchUp(queues, await row(b.id), { interactive: true });
      expect(await run(sent()[0]!)).toEqual({ acked: true, retried: null });
    }
    expect(meta).toHaveLength(asked);
    expect(await row(b.id)).toMatchObject({ status: "error", errorCode: "rate_limited", syncRequestedAt: null, consecutiveFailures: 0 });
    // Google's accounts sync as ever.
    expect(await run(job(g.id))).toEqual({ acked: true, retried: null });
    expect(google).toBeGreaterThan(0);
    expect(await row(g.id)).toMatchObject({ status: "active" });

    // Once the pause has ended, the schedule queues Meta's accounts again.
    const real = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => real() + 16 * 60_000);
    try {
      expect(await metaAdsPaused(coord)).toBe(false);
      queues.clear();
      await scheduleAdsSync(deps);
      expect(sent().map((j) => j.connectionId)).toEqual(expect.arrayContaining([a.id, b.id]));
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("Meta's throttling of one account or one person (17, 80000) stays with that account's job: the others keep syncing", async () => {
    for (const code of [17, 80000]) {
      await resetDb();
      queues.clear();
      coord.clear();
      const a = await connection("meta", { createdAt: old() });
      const b = await connection("meta", { createdAt: old(), accountId: "act_2" });
      let others = 0;
      fetchImpl = async (input) => {
        if (new URL(String(input)).pathname.includes("/act_1/")) return json({ error: { message: "There have been too many calls to this ad-account", code } }, 400);
        others++;
        return json({ data: [] });
      };
      expect(await run(job(a.id))).toEqual({ acked: true, retried: null });
      expect(sent()).toEqual([expect.objectContaining({ connectionId: a.id, rateDeferral: { count: 1, since: expect.any(Number) } })]);
      expect(await metaAdsPaused(coord)).toBe(false);
      expect(await run(job(b.id))).toEqual({ acked: true, retried: null });
      expect(others).toBeGreaterThan(0);
      expect(await row(b.id)).toMatchObject({ status: "active", syncedThrough: today() });
      queues.clear();
      await scheduleAdsSync(deps);
      expect(sent().map((j) => j.connectionId)).toEqual(expect.arrayContaining([a.id, b.id]));
    }
  });
});
