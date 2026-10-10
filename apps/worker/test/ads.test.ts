import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectDb, systemDb, toNumber } from "@app/db";
import { resetDb } from "@app/db/testing";
import { encryptAdTokens, memoryBlobs, memoryCoord, memoryMailer, memoryQueues, resetEnvCache, type AdsSyncData, type FetchLike } from "@app/core";
import { addDays, localDay } from "@app/shared";
import { scheduleAdsSync, type WorkerDeps } from "../src/handlers.js";
import { consume, CRON, runScheduled, type QueueMessage } from "../src/index.js";

/** Ad account syncs: what they store, and how they fail without touching the store's own state. */

const queues = memoryQueues();
const coord = memoryCoord();
let fetchImpl: FetchLike;
let deps: WorkerDeps;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeAll(() => {
  Object.assign(process.env, { META_APP_ID: "a", META_APP_SECRET: "s", GOOGLE_ADS_CLIENT_ID: "c", GOOGLE_ADS_CLIENT_SECRET: "cs", GOOGLE_ADS_DEVELOPER_TOKEN: "d" });
  resetEnvCache();
  deps = { coord, queues, payloads: memoryBlobs(), mailer: memoryMailer(), fetchImpl: ((...a: Parameters<FetchLike>) => fetchImpl(...a)) as FetchLike };
});
afterAll(async () => disconnectDb());
beforeEach(async () => {
  await resetDb();
  queues.clear();
  coord.clear();
  fetchImpl = async () => {
    throw new Error("unexpected fetch");
  };
});

async function connection(provider: "meta" | "google", over: Record<string, unknown> = {}) {
  const ws = await systemDb.workspace.create({ data: { name: "W" } });
  const store = await systemDb.store.create({ data: { workspaceId: ws.id, shopDomain: `${provider}.myshopify.com`, grantedScopes: ["read_orders"], status: "active", timezone: "UTC", pixelIngestKey: `pk-${provider}` } });
  const tokens = encryptAdTokens(store.id, provider, { accessToken: "ACCESS", refreshToken: provider === "google" ? "REFRESH" : null, expiresAt: new Date(Date.now() + 86_400_000) });
  return systemDb.adConnection.create({
    data: { workspaceId: ws.id, storeId: store.id, provider, accountId: provider === "meta" ? "act_1" : "111", currency: "USD", timezone: "UTC", ...tokens, ...over },
  });
}

function message(body: AdsSyncData, attempts = 1) {
  const m = { acked: false, retried: null as null | { delaySeconds?: number } };
  const msg: QueueMessage = { id: "m1", body, attempts, ack: () => (m.acked = true), retry: (o) => (m.retried = o ?? {}) };
  return { msg, m };
}

const today = () => localDay(new Date(), "UTC");

describe("ad account sync", () => {
  it("stores Meta's numbers per campaign per day, replacing what was there for those days", async () => {
    const conn = await connection("meta");
    const d1 = addDays(today(), -1);
    await systemDb.adCampaignDaily.create({ data: { workspaceId: conn.workspaceId, storeId: conn.storeId, connectionId: conn.id, provider: "meta", accountId: "act_1", campaignId: "gone", campaignName: "Deleted campaign", day: d1, spend: 99 } });
    fetchImpl = async (input) => {
      const u = new URL(String(input));
      expect(u.pathname).toBe("/v25.0/act_1/insights");
      expect(u.searchParams.get("access_token")).toBe("ACCESS");
      return json({ data: [{ campaign_id: "7", campaign_name: "Spring", date_start: d1, spend: "12.5", impressions: "900", clicks: "30", actions: [{ action_type: "omni_purchase", value: "2" }], action_values: [{ action_type: "omni_purchase", value: "88" }] }] });
    };
    const { msg, m } = message({ kind: "ads", connectionId: conn.id, since: addDays(today(), -2), until: today() });
    await consume("sync", msg, deps);
    expect(m.acked).toBe(true);
    const rows = await systemDb.adCampaignDaily.findMany({ where: { connectionId: conn.id } });
    expect(rows.map((r) => [r.campaignName, r.day, toNumber(r.spend), r.clicks, toNumber(r.conversions), toNumber(r.conversionValue)])).toEqual([["Spring", d1, 12.5, 30, 2, 88]]);
    const after = await systemDb.adConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(after.status).toBe("active");
    expect(after.lastSyncedAt).toBeTruthy();
  });

  it("refreshes Google's hour-long access token before reading, and keeps the new one", async () => {
    const conn = await connection("google", { accessTokenExpiresAt: new Date(Date.now() - 1000) });
    const calls: string[] = [];
    fetchImpl = async (input, init) => {
      const u = new URL(String(input));
      calls.push(u.host);
      if (u.host === "oauth2.googleapis.com") {
        expect(new URLSearchParams(String(init?.body)).get("refresh_token")).toBe("REFRESH");
        return json({ access_token: "NEW_ACCESS", expires_in: 3599 });
      }
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer NEW_ACCESS");
      return json([{ results: [{ campaign: { id: "5", name: "Brand" }, segments: { date: today() }, metrics: { costMicros: "3000000", clicks: "4", impressions: "10" } }] }]);
    };
    const { msg, m } = message({ kind: "ads", connectionId: conn.id, since: today(), until: today() });
    await consume("sync", msg, deps);
    expect(m.acked).toBe(true);
    expect(calls).toEqual(["oauth2.googleapis.com", "googleads.googleapis.com"]);
    expect(toNumber((await systemDb.adCampaignDaily.findFirstOrThrow({ where: { connectionId: conn.id } })).spend)).toBe(3);
    expect((await systemDb.adConnection.findUniqueOrThrow({ where: { id: conn.id } })).accessTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("ended access asks for a reconnect at once; the store itself is untouched", async () => {
    const conn = await connection("meta");
    fetchImpl = async () => json({ error: { message: "Error validating access token: Session has expired", code: 190 } }, 400);
    const { msg, m } = message({ kind: "ads", connectionId: conn.id, since: today(), until: today() });
    await consume("sync", msg, deps);
    // No retries: they can't help.
    expect(m.acked).toBe(true);
    expect(m.retried).toBeNull();
    const after = await systemDb.adConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(after).toMatchObject({ status: "reconnect", lastError: expect.stringContaining("Session has expired") });
    const store = await systemDb.store.findUniqueOrThrow({ where: { id: conn.storeId } });
    expect(store.status).toBe("active");
    expect(await systemDb.alert.count()).toBe(0);
  });

  it("rate limits are retried, and only the last attempt marks the account", async () => {
    const conn = await connection("meta");
    fetchImpl = async () => json({ error: { message: "User request limit reached", code: 17 } }, 400);
    const first = message({ kind: "ads", connectionId: conn.id, since: today(), until: today() }, 1);
    await consume("sync", first.msg, deps);
    expect(first.m.retried).not.toBeNull();
    expect((await systemDb.adConnection.findUniqueOrThrow({ where: { id: conn.id } })).status).toBe("active");
    const last = message({ kind: "ads", connectionId: conn.id, since: today(), until: today() }, 6);
    await consume("sync", last.msg, deps);
    expect(last.m.acked).toBe(true);
    expect((await systemDb.adConnection.findUniqueOrThrow({ where: { id: conn.id } })).status).toBe("error");
  });

  it("the 15-minute tick refreshes recent days hourly and re-checks 30 days once a day, skipping accounts awaiting a reconnect", async () => {
    const a = await connection("meta");
    await systemDb.adConnection.create({
      data: { ...(({ id: _id, createdAt: _c, updatedAt: _u, ...rest }) => rest)(a), accountId: "act_2", status: "reconnect" },
    });
    await systemDb.adConnection.create({
      data: { ...(({ id: _id, createdAt: _c, updatedAt: _u, ...rest }) => rest)(a), accountId: "act_3", enabled: false },
    });
    expect(await scheduleAdsSync(deps)).toBe(1);
    expect(queues.sent.sync[0]).toMatchObject({ kind: "ads", connectionId: a.id, since: addDays(today(), -29), until: today() });
    // Next tick: the daily re-check is leased, so the recent-days refresh goes instead.
    expect(await scheduleAdsSync(deps)).toBe(1);
    expect(queues.sent.sync[1]).toMatchObject({ connectionId: a.id, since: addDays(today(), -2) });
    // And then nothing until the hour is up.
    expect(await scheduleAdsSync(deps)).toBe(0);
    // Wired into the cron.
    coord.clear();
    expect(await runScheduled(CRON.refreshTokens, deps)).toMatchObject({ adsSynced: 1 });
  });
});
