import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { disconnectDb, systemDb } from "@app/db";
import { resetDb } from "@app/db/testing";
import { AdsRateLimitedError, encryptAdTokens, googleAdsPaused, memoryBlobs, memoryCoord, memoryMailer, memoryQueues, resetEnvCache, type AdsSyncData, type FetchLike } from "@app/core";
import { localDay } from "@app/shared";
import type { WorkerDeps } from "../src/handlers.js";
import { consume, type QueueMessage } from "../src/index.js";

/**
 * Google saying bizinsights' daily allowance of Google Ads operations is used up: Google Ads syncs
 * pause for a while (every merchant's would fail the same way), and the account isn't blamed. The
 * Google Ads client is stood in for, to answer with that error.
 */

const state = vi.hoisted(() => ({ err: null as unknown, calls: 0 }));
vi.mock("../../../packages/core/src/ads/googleAds.js", async (importOriginal) => {
  const m = await importOriginal<Record<string, unknown>>();
  return {
    ...m,
    googleCampaignDays: vi.fn(async () => {
      state.calls++;
      if (state.err) throw state.err;
      return [];
    }),
  };
});

const queues = memoryQueues();
const coord = memoryCoord();
let deps: WorkerDeps;
beforeAll(() => {
  Object.assign(process.env, { GOOGLE_ADS_CLIENT_ID: "c", GOOGLE_ADS_CLIENT_SECRET: "cs", GOOGLE_ADS_ENABLED: "1" });
  resetEnvCache();
  deps = { coord, queues, payloads: memoryBlobs(), mailer: memoryMailer(), fetchImpl: (async () => new Response("{}")) as FetchLike };
});
afterAll(async () => disconnectDb());
beforeEach(async () => {
  await resetDb();
  queues.clear();
  coord.clear();
  state.err = null;
  state.calls = 0;
});

async function run(body: AdsSyncData) {
  const m = { acked: false, retried: null as null | { delaySeconds?: number } };
  const msg: QueueMessage = { id: "m1", body, attempts: 1, ack: () => (m.acked = true), retry: (o) => (m.retried = o ?? {}) };
  await consume("sync", msg, deps);
  return m;
}

describe("Google's daily allowance used up", () => {
  it("pauses Google Ads syncs and says why on the account, without counting it as one of its failures", async () => {
    const ws = await systemDb.workspace.create({ data: { name: "W" } });
    const store = await systemDb.store.create({ data: { workspaceId: ws.id, shopDomain: "q.myshopify.com", grantedScopes: ["read_orders"], status: "active", timezone: "UTC", pixelIngestKey: "pk-q" } });
    const conn = await systemDb.adConnection.create({
      data: {
        workspaceId: ws.id, storeId: store.id, provider: "google", accountId: "111", currency: "USD", timezone: "UTC", externalUserId: "1",
        ...encryptAdTokens(store.id, "google", { accessToken: "A", refreshToken: "R", expiresAt: new Date(Date.now() + 3600_000) }),
      },
    });
    const today = localDay(new Date(), "UTC");
    state.err = new AdsRateLimitedError("Too many requests. Retry in 7200 seconds.", 7200, "quota_exhausted");
    const m = await run({ kind: "ads", connectionId: conn.id, since: today, until: today, trigger: "schedule" });
    // Not retried: every attempt would spend more of the allowance.
    expect(m).toEqual({ acked: true, retried: null });
    expect(await systemDb.adConnection.findUniqueOrThrow({ where: { id: conn.id } })).toMatchObject({ status: "error", errorCode: "quota_exhausted", consecutiveFailures: 0 });
    expect(await googleAdsPaused(coord)).toBe(true);
    // The next scheduled one doesn't call Google at all.
    state.err = null;
    await run({ kind: "ads", connectionId: conn.id, since: today, until: today, trigger: "schedule" });
    expect(state.calls).toBe(1);
  });
});
