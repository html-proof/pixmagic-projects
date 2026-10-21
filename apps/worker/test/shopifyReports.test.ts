import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectDb, systemDb } from "@app/db";
import { resetDb } from "@app/db/testing";
import { encryptTokenFields, memoryBlobs, memoryCoord, memoryMailer, memoryQueues, type FetchLike, type ReportRequest } from "@app/core";
import { runShopifyReports } from "../src/shopifyReports.js";
import type { WorkerDeps } from "../src/handlers.js";

/** The worker's fetch of Shopify's own report figures (ShopifyQL), against a fake Admin API. */

let answer: (shopifyql: string) => Response | Promise<Response>;
const asked: string[] = [];
const fetchImpl: FetchLike = async (url, init) => {
  const body = JSON.parse(String(init?.body)) as { query: string; variables: { query: string } };
  if (!String(url).includes("/graphql.json") || !body.query.includes("shopifyqlQuery")) throw new Error(`unexpected fetch ${String(url)}`);
  asked.push(body.variables.query);
  return answer(body.variables.query);
};
const deps: WorkerDeps = { coord: memoryCoord(), queues: memoryQueues(), payloads: memoryBlobs(), mailer: memoryMailer(), fetchImpl };
const json = (data: unknown, errors?: unknown) => new Response(JSON.stringify({ data, ...(errors ? { errors } : {}) }), { status: 200, headers: { "content-type": "application/json" } });
const table = (row: Record<string, string | number>) => json({ shopifyqlQuery: { tableData: { columns: Object.keys(row).map((name) => ({ name })), rows: [row] }, parseErrors: [] } });

afterAll(async () => disconnectDb());
beforeEach(async () => {
  await resetDb();
  asked.length = 0;
});

async function makeStore(scopes = ["read_orders", "read_reports"]) {
  const ws = await systemDb.workspace.create({ data: { name: "R" } });
  const store = await systemDb.store.create({ data: { workspaceId: ws.id, shopDomain: "r.myshopify.com", grantedScopes: scopes, status: "active", timezone: "Australia/Melbourne" } });
  await systemDb.store.update({
    where: { id: store.id },
    data: encryptTokenFields(store.id, { accessToken: "shpat_x", scopes, accessTokenExpiresAt: null, refreshToken: null, refreshTokenExpiresAt: null }),
  });
  return store;
}

const today: ReportRequest = { dataset: "sessions", window: { from: "2026-10-17", to: "2026-10-17", until: "16:40:00" } };
const september: ReportRequest = { dataset: "sales", window: { from: "2026-09-01", to: "2026-09-30" } };
const kept = (storeId: string, r: ReportRequest) =>
  systemDb.shopifyReport.findUniqueOrThrow({ where: { storeId_dataset_window: { storeId, dataset: r.dataset, window: `${r.window.from}|${r.window.to}|${r.window.until ?? ""}` } } });

describe("Shopify reports", () => {
  it("asks Shopify for each window and keeps its figures in our names", async () => {
    const store = await makeStore();
    answer = (q) =>
      q.startsWith("FROM sessions")
        ? table({ sessions: "212", online_store_visitors: "180", sessions_with_cart_additions: 31, sessions_that_reached_checkout: 12, sessions_that_completed_checkout: 7, pageviews: "655" })
        : table({ gross_sales: "1699.08", discounts: "-54.53", sales_reversals: "-45.50", net_sales: "1599.05", shipping_charges: "34.54", duties: "12.40", additional_fees: "0", taxes: "167.91", total_sales: "1813.90", orders: 5 });
    await runShopifyReports({ kind: "shopify_reports", storeId: store.id, requests: [today, september] }, deps);
    expect(asked).toEqual([
      "FROM sessions SHOW sessions, online_store_visitors, sessions_with_cart_additions, sessions_that_reached_checkout, sessions_that_completed_checkout, pageviews WHERE human_or_bot_session = 'human' SINCE 2026-10-17 UNTIL 2026-10-17T16:39:59",
      "FROM sales SHOW gross_sales, discounts, sales_reversals, net_sales, shipping_charges, duties, additional_fees, taxes, total_sales, orders SINCE 2026-09-01 UNTIL 2026-09-30",
    ]);
    expect((await kept(store.id, today)).values).toEqual({ sessions: 212, visitors: 180, cartSessions: 31, checkoutSessions: 12, completedSessions: 7, pageviews: 655 });
    expect(await kept(store.id, september)).toMatchObject({ error: null, values: { netSales: 1599.05, discounts: -54.53, duties: 12.4, additionalFees: 0, totalSales: 1813.9, orders: 5 } });
  });

  it("keeps Shopify's refusals as such, and a failed refresh keeps the last figures", async () => {
    const store = await makeStore();
    // Withheld: protected customer data or the scope, next to otherwise valid data.
    answer = () => json({ shopifyqlQuery: null }, [{ message: "Access denied for shopifyqlQuery field.", extensions: { code: "ACCESS_DENIED" } }]);
    await runShopifyReports({ kind: "shopify_reports", storeId: store.id, requests: [today] }, deps);
    expect(await kept(store.id, today)).toMatchObject({ error: "access_denied", values: null });

    // A report this store can't run (a plan, a field Shopify renamed).
    answer = () => json({ shopifyqlQuery: { tableData: null, parseErrors: ["Unknown column gross_profit"] } });
    const profit: ReportRequest = { dataset: "profit", window: september.window };
    await runShopifyReports({ kind: "shopify_reports", storeId: store.id, requests: [profit] }, deps);
    expect(await kept(store.id, profit)).toMatchObject({ error: "unsupported", values: null });

    // Shopify rejecting the query itself (no such field on this API version): asking again won't help.
    answer = () => new Response(JSON.stringify({ errors: [{ message: "Field 'shopifyqlQuery' doesn't exist on type 'QueryRoot'", extensions: { code: "undefinedField" } }] }), { status: 200 });
    const lastMonth: ReportRequest = { dataset: "sessions", window: september.window };
    await runShopifyReports({ kind: "shopify_reports", storeId: store.id, requests: [lastMonth] }, deps);
    expect(await kept(store.id, lastMonth)).toMatchObject({ error: "unsupported", values: null });

    // Figures, then a refresh that can't reach Shopify: the figures stay, marked failed.
    answer = () => table({ gross_sales: "10", discounts: "0", sales_reversals: "0", net_sales: "10", shipping_charges: "0", taxes: "0", total_sales: "10", orders: 1 });
    await runShopifyReports({ kind: "shopify_reports", storeId: store.id, requests: [september] }, deps);
    answer = () => {
      throw new TypeError("fetch failed");
    };
    await runShopifyReports({ kind: "shopify_reports", storeId: store.id, requests: [september] }, deps);
    expect(await kept(store.id, september)).toMatchObject({ error: "failed", values: { netSales: 10 } });
  });

  it("asks nothing for a store that hasn't granted its reports, or is gone", async () => {
    const store = await makeStore(["read_orders"]);
    answer = () => table({ sessions: 1 });
    expect(await runShopifyReports({ kind: "shopify_reports", storeId: store.id, requests: [today] }, deps)).toEqual({ skipped: true });
    expect(await runShopifyReports({ kind: "shopify_reports", storeId: "nope", requests: [today] }, deps)).toEqual({ skipped: true });
    expect(asked).toEqual([]);
  });
});
