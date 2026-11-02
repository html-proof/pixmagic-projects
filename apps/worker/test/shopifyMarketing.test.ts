import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectDb, systemDb } from "@app/db";
import { resetDb } from "@app/db/testing";
import { encryptTokenFields, memoryBlobs, memoryCoord, memoryMailer, memoryQueues, type FetchLike } from "@app/core";
import { localDay } from "@app/shared";
import { MarketingReadFailedError, runShopifyMarketing, scheduleShopifyMarketing } from "../src/shopifyMarketing.js";
import type { WorkerDeps } from "../src/handlers.js";

/** The worker's reads of what the store's marketing apps report to Shopify (ShopifyQL marketing_engagements), against a fake Admin API. */

let answer: (shopifyql: string) => Response | Promise<Response>;
const asked: string[] = [];
const fetchImpl: FetchLike = async (url, init) => {
  const body = JSON.parse(String(init?.body)) as { query: string; variables: { query: string } };
  if (!String(url).includes("/graphql.json") || !body.query.includes("shopifyqlQuery")) throw new Error(`unexpected fetch ${String(url)}`);
  asked.push(body.variables.query);
  return answer(body.variables.query);
};
const queues = memoryQueues();
const coord = memoryCoord();
const deps: WorkerDeps = { coord, queues, payloads: memoryBlobs(), mailer: memoryMailer(), fetchImpl };
const json = (data: unknown, errors?: unknown) => new Response(JSON.stringify({ data, ...(errors ? { errors } : {}) }), { status: 200, headers: { "content-type": "application/json" } });
const table = (rows: Array<Record<string, string | number | null>>) => json({ shopifyqlQuery: { tableData: { columns: Object.keys(rows[0] ?? {}).map((name) => ({ name })), rows }, parseErrors: [] } });

afterAll(async () => disconnectDb());
beforeEach(async () => {
  await resetDb();
  asked.length = 0;
  queues.clear();
});

const TZ = "Australia/Melbourne";
const today = localDay(new Date(), TZ);
const day = (n: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function makeStore(scopes = ["read_orders", "read_reports"], createdDaysAgo = 1000) {
  const ws = await systemDb.workspace.create({ data: { name: "M" } });
  const store = await systemDb.store.create({
    data: { workspaceId: ws.id, shopDomain: "m.myshopify.com", grantedScopes: scopes, status: "active", timezone: TZ, currency: "AUD", shopCreatedAt: new Date(Date.now() - createdDaysAgo * 86_400_000) },
  });
  await systemDb.store.update({
    where: { id: store.id },
    data: encryptTokenFields(store.id, { accessToken: "shpat_x", scopes, accessTokenExpiresAt: null, refreshToken: null, refreshTokenExpiresAt: null }),
  });
  return store;
}

const channelRow = (d: string, channel: string, app: string, spend: string | null, clicks: number) => ({
  day: d,
  marketing_channel: channel,
  marketing_app_name: app,
  engagements_ad_spend: spend,
  engagements_impressions: clicks * 50,
  engagements_clicks: clicks,
  engagements_orders: 2,
  engagements_total_sales: "150.00",
  engagements_first_time_customers: 1,
});

describe("reading what the store's marketing apps report to Shopify", () => {
  it("reads the last 90 days the first time, by channel and by campaign, keeps them by day and starts the walk back", async () => {
    const store = await makeStore();
    answer = (q) =>
      q.includes("marketing_campaign")
        ? table([{ ...channelRow(day(-1), "Meta Ads", "Facebook & Instagram", "30.00", 60), marketing_campaign: "Diwali" }])
        : table([channelRow(day(-1), "Meta Ads", "Facebook & Instagram", "42.50", 80), channelRow(day(0), "Google Ads", "Google & YouTube", null, 12)]);
    const res = await runShopifyMarketing({ kind: "shopify_marketing", storeId: store.id, mode: "recent" }, deps);
    expect(res).toMatchObject({ status: "done", from: day(-89), to: today, rows: 3, more: true });
    expect(asked).toHaveLength(2);
    expect(asked[0]).toContain(`GROUP BY day, marketing_channel, marketing_app_name SINCE ${day(-89)} UNTIL ${today}`);
    const kept = await systemDb.shopifyMarketingDay.findMany({ where: { storeId: store.id }, orderBy: [{ day: "asc" }, { campaign: "asc" }] });
    expect(kept.map((r) => ({ day: r.day, channel: r.channel, campaign: r.campaign, spend: r.spend === null ? null : Number(r.spend), clicks: r.clicks, currency: r.currency, workspaceId: r.workspaceId }))).toEqual([
      { day: day(-1), channel: "Meta Ads", campaign: "", spend: 42.5, clicks: 80, currency: "AUD", workspaceId: store.workspaceId },
      { day: day(-1), channel: "Meta Ads", campaign: "Diwali", spend: 30, clicks: 60, currency: "AUD", workspaceId: store.workspaceId },
      { day: today, channel: "Google Ads", campaign: "", spend: null, clicks: 12, currency: "AUD", workspaceId: store.workspaceId },
    ]);
    expect(await systemDb.shopifyMarketingSync.findUniqueOrThrow({ where: { storeId: store.id } })).toMatchObject({ coveredFrom: day(-89), syncedThrough: today, backfilled: false, lastError: null, consecutiveFailures: 0 });
    // The walk back through history, on its lease.
    expect(queues.sent.sync).toEqual([{ kind: "shopify_marketing", storeId: store.id, mode: "backfill" }]);
  });

  it("replaces the days it reads again, so a revised day is never counted twice or keeps a campaign gone since", async () => {
    const store = await makeStore();
    answer = (q) => (q.includes("marketing_campaign") ? table([{ ...channelRow(day(-1), "Meta Ads", "Facebook & Instagram", "10", 5), marketing_campaign: "Old name" }]) : table([channelRow(day(-1), "Meta Ads", "Facebook & Instagram", "10", 5)]));
    await runShopifyMarketing({ kind: "shopify_marketing", storeId: store.id, mode: "recent" }, deps);
    answer = (q) => (q.includes("marketing_campaign") ? table([{ ...channelRow(day(-1), "Meta Ads", "Facebook & Instagram", "12", 6), marketing_campaign: "New name" }]) : table([channelRow(day(-1), "Meta Ads", "Facebook & Instagram", "12", 6)]));
    const res = await runShopifyMarketing({ kind: "shopify_marketing", storeId: store.id, mode: "reconcile" }, deps);
    expect(res).toMatchObject({ status: "done", from: day(-7), to: today });
    const kept = await systemDb.shopifyMarketingDay.findMany({ where: { storeId: store.id }, orderBy: { campaign: "asc" } });
    expect(kept.map((r) => [r.campaign, Number(r.spend)])).toEqual([
      ["", 12],
      ["New name", 12],
    ]);
    // The days read only ever widen.
    expect(await systemDb.shopifyMarketingSync.findUniqueOrThrow({ where: { storeId: store.id } })).toMatchObject({ coveredFrom: day(-89), syncedThrough: today });
  });

  it("walks back 90 days at a time to the store's first day, then says it is done", async () => {
    const store = await makeStore(undefined, 200);
    answer = () => table([]);
    await runShopifyMarketing({ kind: "shopify_marketing", storeId: store.id, mode: "recent" }, deps);
    const step = await runShopifyMarketing({ kind: "shopify_marketing", storeId: store.id, mode: "backfill" }, deps);
    expect(step).toMatchObject({ status: "done", from: day(-179), to: day(-90), more: true });
    expect(queues.sent.sync.at(-1)).toEqual({ kind: "shopify_marketing", storeId: store.id, mode: "backfill" });
    const last = await runShopifyMarketing({ kind: "shopify_marketing", storeId: store.id, mode: "backfill" }, deps);
    expect(last).toMatchObject({ status: "done", to: day(-180), more: false });
    expect(await systemDb.shopifyMarketingSync.findUniqueOrThrow({ where: { storeId: store.id } })).toMatchObject({ backfilled: true });
    expect(await runShopifyMarketing({ kind: "shopify_marketing", storeId: store.id, mode: "backfill" }, deps)).toEqual({ status: "nothing_left" });
  });

  it("keeps Shopify refusing on the store's sync row, and throws a failed call for the queue to try again", async () => {
    const store = await makeStore();
    answer = () => json({ shopifyqlQuery: null }, [{ message: "Access denied for shopifyqlQuery field.", extensions: { code: "ACCESS_DENIED" } }]);
    expect(await runShopifyMarketing({ kind: "shopify_marketing", storeId: store.id, mode: "recent" }, deps)).toEqual({ status: "error", error: "access_denied" });
    answer = () => json({ shopifyqlQuery: { tableData: null, parseErrors: ["Unknown table marketing_engagements"] } });
    expect(await runShopifyMarketing({ kind: "shopify_marketing", storeId: store.id, mode: "recent" }, deps)).toEqual({ status: "error", error: "unsupported" });
    answer = () => {
      throw new TypeError("fetch failed");
    };
    await expect(runShopifyMarketing({ kind: "shopify_marketing", storeId: store.id, mode: "recent" }, deps)).rejects.toBeInstanceOf(MarketingReadFailedError);
    expect(await systemDb.shopifyMarketingSync.findUniqueOrThrow({ where: { storeId: store.id } })).toMatchObject({ lastError: "failed", consecutiveFailures: 3, lastSyncedAt: null, coveredFrom: null });
    expect(await systemDb.shopifyMarketingDay.count()).toBe(0);
  });

  it("reads a gap on from where the days read stop, and a read past it never says the gap was read", async () => {
    const store = await makeStore();
    answer = () => table([]);
    // Read up to 100 days ago, then nothing (reads failing, the permission given up).
    await systemDb.shopifyMarketingSync.create({ data: { storeId: store.id, workspaceId: store.workspaceId, coveredFrom: day(-300), syncedThrough: day(-100), lastSyncedAt: new Date() } });
    // The daily read of the last week: kept, but the days read with none missing still stop 100 days ago.
    expect(await runShopifyMarketing({ kind: "shopify_marketing", storeId: store.id, mode: "reconcile" }, deps)).toMatchObject({ status: "done", from: day(-7), behind: false });
    expect(await systemDb.shopifyMarketingSync.findUniqueOrThrow({ where: { storeId: store.id } })).toMatchObject({ coveredFrom: day(-300), syncedThrough: day(-100) });
    // The recent read takes the gap 90 days at a time, and reads on.
    expect(await runShopifyMarketing({ kind: "shopify_marketing", storeId: store.id, mode: "recent" }, deps)).toMatchObject({ status: "done", from: day(-101), to: day(-12), behind: true });
    expect(queues.sent.sync.at(-1)).toEqual({ kind: "shopify_marketing", storeId: store.id, mode: "recent" });
    expect(await runShopifyMarketing({ kind: "shopify_marketing", storeId: store.id, mode: "recent" }, deps)).toMatchObject({ status: "done", from: day(-13), to: today, behind: false });
    expect(await systemDb.shopifyMarketingSync.findUniqueOrThrow({ where: { storeId: store.id } })).toMatchObject({ coveredFrom: day(-300), syncedThrough: today });
  });

  it("keeps a window cut at the page limit only up to the day before the last it reached", async () => {
    const store = await makeStore();
    // Every page full: the days come oldest first, so the newest are the ones cut off.
    const full = Array.from({ length: 1000 }, (_, i) => channelRow(day(-89 + Math.floor(i / 20)), `Channel ${i % 20}`, "App", "1.00", 1));
    answer = (q) => (q.includes("marketing_campaign") ? table([]) : table(full));
    const res = await runShopifyMarketing({ kind: "shopify_marketing", storeId: store.id, mode: "recent" }, deps);
    expect(res).toMatchObject({ status: "done", from: day(-89), to: day(-41) });
    expect(await systemDb.shopifyMarketingDay.count({ where: { storeId: store.id, day: { gt: day(-41) } } })).toBe(0);
    expect(await systemDb.shopifyMarketingSync.findUniqueOrThrow({ where: { storeId: store.id } })).toMatchObject({ syncedThrough: day(-41) });
  });

  it("pages through a long answer", async () => {
    const store = await makeStore();
    const many = Array.from({ length: 1000 }, (_, i) => ({ ...channelRow(day(-(i % 90)), `Channel ${Math.floor(i / 90)}`, "App", "1.00", 1) }));
    answer = (q) => (q.includes("marketing_campaign") ? table([]) : q.includes("OFFSET 1000") ? table([channelRow(today, "Last", "App", "2.00", 1)]) : table(many));
    const res = await runShopifyMarketing({ kind: "shopify_marketing", storeId: store.id, mode: "recent" }, deps);
    expect(asked.filter((q) => !q.includes("marketing_campaign"))).toHaveLength(2);
    expect(res).toMatchObject({ status: "done", rows: 1001 });
  });

  it("reads nothing for a store that hasn't granted its reports, or is gone", async () => {
    const store = await makeStore(["read_orders"]);
    answer = () => table([]);
    expect(await runShopifyMarketing({ kind: "shopify_marketing", storeId: store.id, mode: "recent" }, deps)).toEqual({ skipped: true });
    expect(await runShopifyMarketing({ kind: "shopify_marketing", storeId: "nope", mode: "recent" }, deps)).toEqual({ skipped: true });
    expect(asked).toEqual([]);
  });
});

describe("the schedule", () => {
  it("queues a store's first read only, then its recent days, the last week and the walk back on their own leases", async () => {
    const store = await makeStore();
    await makeOther();
    const coordHere = memoryCoord();
    const here: WorkerDeps = { ...deps, coord: coordHere };
    expect(await scheduleShopifyMarketing(here)).toEqual({ queued: 1 });
    expect(queues.sent.sync).toEqual([{ kind: "shopify_marketing", storeId: store.id, mode: "recent" }]);
    // Read once: the next tick adds the last week and the walk back; the recent read's lease still holds.
    await systemDb.shopifyMarketingSync.create({ data: { storeId: store.id, workspaceId: store.workspaceId, coveredFrom: day(-89), syncedThrough: today, lastSyncedAt: new Date() } });
    queues.clear();
    expect(await scheduleShopifyMarketing(here)).toEqual({ queued: 2 });
    expect(queues.sent.sync.map((m) => (m as unknown as { mode: string }).mode)).toEqual(["reconcile", "backfill"]);
    queues.clear();
    expect(await scheduleShopifyMarketing(here)).toEqual({ queued: 0 });
  });
});

/** A store without its reports granted: never scheduled. */
async function makeOther() {
  const ws = await systemDb.workspace.create({ data: { name: "N" } });
  return systemDb.store.create({ data: { workspaceId: ws.id, shopDomain: "n.myshopify.com", grantedScopes: ["read_orders"], status: "active" } });
}
