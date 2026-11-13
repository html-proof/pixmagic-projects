import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb, type Store } from "@app/db";
import { addDays, localDay } from "@app/shared";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * The ad spend the store's marketing apps report to Shopify on the dashboard (`shopify_marketing`), and
 * Meta's and Google's figures taken from it while their own API isn't connected (`ad_sources`).
 */

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));
beforeEach(async () => clean(ctx));

const SCOPES = ["read_orders", "read_products", "read_reports"];
const RANGE = "preset=custom&from=2026-09-01&to=2026-09-03";

async function owner(scopes = SCOPES) {
  const a = await signIn(ctx, "ua", "a@x.com");
  const ws = await createWorkspace(ctx, a.headers, "A");
  const store = await createStore(ws, "a.myshopify.com", scopes);
  return { a, ws, store };
}

type Day = { day: string; channel: string; app?: string; campaign?: string; spend?: number | null; impressions?: number | null; clicks?: number | null; orders?: number | null; sales?: number | null };

async function keep(store: Store, days: Day[], sync: { coveredFrom?: string; syncedThrough?: string; backfilled?: boolean } = {}) {
  await systemDb.shopifyMarketingSync.create({
    data: { storeId: store.id, workspaceId: store.workspaceId, coveredFrom: sync.coveredFrom ?? "2026-06-01", syncedThrough: sync.syncedThrough ?? "2026-09-30", backfilled: sync.backfilled ?? false, lastSyncedAt: new Date(), lastAttemptAt: new Date() },
  });
  await systemDb.shopifyMarketingDay.createMany({
    data: days.map((d) => ({
      workspaceId: store.workspaceId,
      storeId: store.id,
      day: d.day,
      channel: d.channel,
      app: d.app ?? "",
      campaign: d.campaign ?? "",
      spend: d.spend ?? null,
      impressions: d.impressions ?? null,
      clicks: d.clicks ?? null,
      orders: d.orders ?? null,
      sales: d.sales ?? null,
      currency: "USD",
      fetchedAt: new Date(),
    })),
  });
}

const META = { channel: "Meta Ads", app: "Facebook & Instagram" };
const overview = (headers: Record<string, string>, ws: string, storeId: string, qs = RANGE) => ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/overview?${qs}`, headers });
const marketingJobs = () => ctx.deps.queues.sent.sync.filter((j) => (j as { kind?: string }).kind === "shopify_marketing");

describe("ad spend reported to Shopify on the dashboard", () => {
  it("gives Meta's spend from its app's report while Meta isn't connected, for the dates alone", async () => {
    const { a, ws, store } = await owner();
    await keep(store, [
      { ...META, day: "2026-09-01", spend: 40, impressions: 10000, clicks: 200, orders: 4, sales: 320 },
      { ...META, day: "2026-09-02", spend: 60, impressions: 15000, clicks: 300, orders: 6, sales: 480 },
      { ...META, day: "2026-09-02", campaign: "Back to school", spend: 60, clicks: 300, sales: 480 },
      { ...META, day: "2026-08-30", spend: 50, clicks: 250, sales: 300 },
      // Outside the dates (the 30th before them too): not counted.
      { ...META, day: "2026-09-10", spend: 999 },
    ]);
    const res = await overview(a.headers, ws, store.id, `${RANGE}&parts=advertising`);
    expect(res.statusCode).toBe(200);
    const m = res.json().modules;
    expect(m.shopify_marketing).toMatchObject({ status: "ready", currency: "USD", reportedSpend: 100, from: "2026-09-01", through: "2026-09-03" });
    expect(m.shopify_marketing).not.toHaveProperty("compared");
    const [meta, google] = m.shopify_marketing.platforms;
    expect(meta).toMatchObject({ availability: "reported", totals: { spend: 100, clicks: 500, sales: 800, roas: 8 } });
    for (const k of ["previous", "deltas"]) expect(meta).not.toHaveProperty(k);
    expect(meta.campaigns).toEqual([{ campaign: "Back to school", spend: 60, impressions: null, clicks: 300, orders: null, sales: 480, roas: 8 }]);
    expect(meta.daily.map((d: { spend: number | null }) => d.spend)).toEqual([40, 60, 0]);
    expect(google).toMatchObject({ availability: "unavailable", totals: null });
    // Meta's figures come from the report; Google has nothing to show but the store's orders.
    expect(m.ad_sources).toEqual([
      { provider: "meta", state: "not_connected", source: "shopify", marketing: true },
      { provider: "google", state: "not_connected", source: "shopify" },
    ]);
    expect(marketingJobs()).toEqual([]);
  });

  it("gives today's and this month's spend whatever the dates picked, never last month's", async () => {
    const { a, ws, store } = await owner();
    const today = localDay(new Date(), store.timezone);
    const first = `${today.slice(0, 7)}-01`;
    await keep(
      store,
      [
        { ...META, day: today, spend: 25, clicks: 90 },
        { channel: "Google Ads", app: "Google & YouTube", day: first, spend: 10 },
        { ...META, day: addDays(first, -1), spend: 999 },
      ],
      { coveredFrom: addDays(first, -40), syncedThrough: today },
    );
    const current = (await overview(a.headers, ws, store.id)).json().modules.shopify_marketing.current;
    expect(current.month).toMatchObject({ from: first, to: today, through: today, meta: { spend: 25, state: "reported" }, google: { spend: 10, state: "reported" }, others: [], total: 35 });
    // On the 1st, today is the whole month so far.
    expect(current.today).toMatchObject(
      today === first
        ? { from: today, through: today, meta: { spend: 25 }, google: { spend: 10 }, total: 35 }
        : { from: today, through: today, meta: { spend: 25 }, google: { spend: null, state: "no_spend" }, total: 25 },
    );
  });

  it("says when it hasn't been read yet, and asks the worker for the first read once", async () => {
    const { a, ws, store } = await owner();
    const first = (await overview(a.headers, ws, store.id)).json().modules;
    expect(first.shopify_marketing).toMatchObject({ status: "syncing", reportedSpend: null, from: null, through: null });
    expect(first.shopify_marketing.platforms.map((g: { availability: string }) => g.availability)).toEqual(["unavailable", "unavailable"]);
    expect(first.shopify_marketing.current.today).toMatchObject({ through: null, meta: { spend: null, state: "not_read" }, google: { state: "not_read" }, total: null });
    expect(marketingJobs()).toEqual([{ kind: "shopify_marketing", storeId: store.id, mode: "recent" }]);
    await overview(a.headers, ws, store.id);
    expect(marketingJobs()).toHaveLength(1);
  });

  it("gives the dates' spend whether or not the days before them were read", async () => {
    const { a, ws, store } = await owner();
    await keep(store, [{ ...META, day: "2026-09-01", spend: 40 }], { coveredFrom: "2026-09-01" });
    const m = (await overview(a.headers, ws, store.id)).json().modules.shopify_marketing;
    expect(m.platforms[0]).toMatchObject({ availability: "reported", totals: { spend: 40 } });
    expect(m).not.toHaveProperty("compared");
    const today = (await overview(a.headers, ws, store.id, "preset=today")).json().modules.shopify_marketing;
    expect(today).not.toHaveProperty("compared");
  });

  it("isn't there for a store that hasn't granted its Shopify reports: the capability says what's missing", async () => {
    const { a, ws, store } = await owner(["read_orders", "read_products"]);
    const body = (await overview(a.headers, ws, store.id, `${RANGE}&parts=advertising`)).json();
    expect(body.modules.shopify_marketing).toBeUndefined();
    expect(body.capabilities.find((c: { id: string }) => c.id === "shopify_marketing")).toMatchObject({ enabled: false, missingScopes: ["read_reports"] });
    expect(body.modules.ad_sources.every((s: { marketing?: boolean }) => !s.marketing)).toBe(true);
    expect(marketingJobs()).toEqual([]);
  });

  it("never shows another workspace's figures", async () => {
    const { a, ws, store } = await owner();
    const b = await signIn(ctx, "ub", "b@x.com");
    const wsB = await createWorkspace(ctx, b.headers, "B");
    const other = await createStore(wsB, "b.myshopify.com", SCOPES);
    await keep(other, [{ ...META, day: "2026-09-01", spend: 500 }]);
    const mine = (await overview(a.headers, ws, store.id)).json().modules.shopify_marketing;
    expect(mine.status).toBe("syncing");
    expect(mine.reportedSpend).toBeNull();
    expect((await overview(a.headers, ws, other.id)).statusCode).toBe(404);
  });
});
