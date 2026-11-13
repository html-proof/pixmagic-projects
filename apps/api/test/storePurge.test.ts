import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb } from "@app/db";
import { signShopifyQuery } from "@app/shared";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * What a store's data leaves behind when its row stays: Disconnect in the app removes what was read
 * from Shopify and keeps what the merchant entered, and a move to another workspace leaves nothing
 * of the store in the workspace it leaves. packages/core/test/storeTables.test.ts checks that every
 * store table is placed in one or the other.
 */

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));
beforeEach(async () => clean(ctx));

const SHOP = "leaving.myshopify.com";
const now = () => String(Math.floor(Date.now() / 1000));

function callbackUrl(state: string) {
  const params = { code: "authcode", shop: SHOP, state, timestamp: now() };
  return `/shopify/callback?${new URLSearchParams({ ...params, hmac: signShopifyQuery(params, "test_secret") })}`;
}

/** Shopify's marketing figures with how far they were read, and what the merchant entered: a cost, from when the costs are complete, a business event. */
async function seed(workspaceId: string, storeId: string) {
  await systemDb.shopifyMarketingSync.create({ data: { storeId, workspaceId, coveredFrom: "2026-09-01", syncedThrough: "2026-10-31", backfilled: true, lastSyncedAt: new Date() } });
  await systemDb.shopifyMarketingDay.create({ data: { workspaceId, storeId, day: "2026-10-31", channel: "Facebook", spend: 12.5, currency: "USD", fetchedAt: new Date() } });
  await systemDb.storeExpense.create({ data: { workspaceId, storeId, name: "Rent", category: "rent", amount: 1000, cadence: "monthly", startsOn: "2026-01-01" } });
  await systemDb.storeExpenseSettings.create({ data: { storeId, workspaceId, completeFrom: "2026-01-01" } });
  await systemDb.businessEvent.create({ data: { workspaceId, storeId, kind: "other", title: "Spring sale", startsOn: "2026-10-01", endsOn: "2026-10-07" } });
}

const left = async (storeId: string) => ({
  marketingDays: await systemDb.shopifyMarketingDay.count({ where: { storeId } }),
  marketingSync: await systemDb.shopifyMarketingSync.count({ where: { storeId } }),
  expenses: await systemDb.storeExpense.count({ where: { storeId } }),
  expenseSettings: await systemDb.storeExpenseSettings.count({ where: { storeId } }),
  businessEvents: await systemDb.businessEvent.count({ where: { storeId } }),
});

describe("a store's data when its row stays", () => {
  it("Disconnect removes Shopify's marketing figures with the rest, and keeps what the merchant entered", async () => {
    const owner = await signIn(ctx, "owner", "owner@x.com");
    const ws = await createWorkspace(ctx, owner.headers);
    const store = await createStore(ws, SHOP, ["read_orders", "read_products"]);
    await seed(ws, store.id);

    const res = await ctx.app.inject({ method: "DELETE", url: `/workspaces/${ws}/stores/${store.id}`, headers: owner.headers });
    expect(res.statusCode).toBe(200);
    // No marketing sync row left to tell the next connect's backfill that the history is read.
    expect(await left(store.id)).toEqual({ marketingDays: 0, marketingSync: 0, expenses: 1, expenseSettings: 1, businessEvents: 1 });
  });

  it("a move to another workspace leaves nothing of the store in the old one, and the privacy requests to answer follow it", async () => {
    const before = await signIn(ctx, "before", "before@x.com");
    const old = await createWorkspace(ctx, before.headers, "Before");
    const store = await createStore(old, SHOP, ["read_orders", "read_products"], { status: "uninstalled", uninstalledAt: new Date() });
    await seed(old, store.id);
    await systemDb.emailBusinessEvent.create({ data: { workspaceId: old, storeId: store.id, source: "shopify", eventType: "order.created", externalId: "1001", occurredAt: new Date(), status: "processed" } });
    const request = await systemDb.dataRequest.create({ data: { workspaceId: old, storeId: store.id, shopifyRequestId: "9999", customerId: "7" } });
    await systemDb.alert.createMany({
      data: [
        { workspaceId: old, storeId: store.id, severity: "critical", code: "sync_orders_failed", message: "m" },
        { workspaceId: old, storeId: store.id, severity: "warning", code: "privacy_request", message: "m" },
        // The old workspace's own, about no store.
        { workspaceId: old, storeId: null, severity: "warning", code: "zapier_delivery_failed", message: "m" },
      ],
    });

    // Someone else connects the store to their own workspace.
    const { headers, cookie } = await signIn(ctx, "after", "after@x.com");
    const ws = await createWorkspace(ctx, headers, "After");
    const start = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/shopify/install`, headers, payload: { shop: SHOP } });
    expect(start.statusCode).toBe(200);
    const state = new URL(start.json().url).searchParams.get("state")!;
    ctx.setFetch(async () => new Response(JSON.stringify({ access_token: "shpat_moved", scope: "read_orders,read_products" }), { status: 200, headers: { "content-type": "application/json" } }));
    const cb = await ctx.app.inject({ method: "GET", url: callbackUrl(state), headers: { cookie: `${cookie}; shopify_oauth_state=${state}` } });
    expect(cb.headers.location).toMatch(/\/onboarding\?step=sync&store=/);
    expect((await systemDb.store.findUniqueOrThrow({ where: { id: store.id } })).workspaceId).toBe(ws);

    expect(await left(store.id)).toEqual({ marketingDays: 0, marketingSync: 0, expenses: 0, expenseSettings: 0, businessEvents: 0 });
    expect(await systemDb.emailBusinessEvent.count({ where: { storeId: store.id } })).toBe(0);
    expect(await systemDb.dataRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({ workspaceId: ws });
    // The alert asking to answer the request goes with it; the old workspace's other alerts about the store go.
    const alerts = await systemDb.alert.findMany({ orderBy: { code: "asc" }, select: { workspaceId: true, storeId: true, code: true } });
    expect(alerts).toEqual([
      { workspaceId: ws, storeId: store.id, code: "privacy_request" },
      { workspaceId: old, storeId: null, code: "zapier_delivery_failed" },
    ]);
  });
});
