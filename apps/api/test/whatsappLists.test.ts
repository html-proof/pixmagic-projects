import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb } from "@app/db";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * The WhatsApp list endpoints' paging and the campaign list's figures, pinned before they were
 * moved onto one paging helper and one query per list (they had no test of their own).
 */

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => teardown(ctx));
beforeEach(async () => clean(ctx));

async function owner() {
  const u = await signIn(ctx, "u1", "o@shop.test");
  const ws = await createWorkspace(ctx, u.headers);
  const store = await createStore(ws, "lists.myshopify.com", ["read_orders"]);
  return { ...u, ws, store, base: `/workspaces/${ws}/stores/${store.id}/whatsapp` };
}

let seq = 0;
async function order(o: Awaited<ReturnType<typeof owner>>, at: string, total: string, codes: string[], cancelled = false) {
  seq++;
  await systemDb.order.create({
    data: {
      workspaceId: o.ws,
      storeId: o.store.id,
      shopifyId: String(seq),
      name: `#${1000 + seq}`,
      currency: "USD",
      localDay: at.slice(0, 10),
      shopifyCreatedAt: new Date(at),
      shopifyUpdatedAt: new Date(at),
      cancelledAt: cancelled ? new Date(at) : null,
      subtotal: total,
      totalDiscounts: "0",
      totalTax: "0",
      totalShipping: "0",
      totalPrice: total,
      discountCodes: codes,
    },
  });
}

async function campaign(o: Awaited<ReturnType<typeof owner>>, name: string, discountCode: string | null, startedAt: string | null, endAt: string | null) {
  return systemDb.whatsappCampaign.create({
    data: {
      workspaceId: o.ws,
      storeId: o.store.id,
      name,
      occasion: "custom",
      templateName: "t",
      templateLanguage: "en",
      discountCode,
      startAt: new Date(startedAt ?? "2026-05-01T00:00:00Z"),
      startedAt: startedAt ? new Date(startedAt) : null,
      endAt: endAt ? new Date(endAt) : null,
      status: startedAt ? "completed" : "draft",
    },
  });
}

describe("campaign list", () => {
  it("counts each campaign's discount-code orders in its own window, case-insensitively, cancelled orders excluded", async () => {
    const o = await owner();
    // Default attribution: 3 days after the campaign ends.
    const a = await campaign(o, "A", "ONAM20", "2026-03-01T00:00:00Z", "2026-03-05T00:00:00Z");
    const b = await campaign(o, "B", "diwali", "2026-04-01T00:00:00Z", "2026-04-02T00:00:00Z");
    const noCode = await campaign(o, "C", null, "2026-03-01T00:00:00Z", null);
    const notStarted = await campaign(o, "D", "ONAM20", null, null);
    await order(o, "2026-02-28T23:00:00Z", "10.00", ["ONAM20"]); // before A started
    await order(o, "2026-03-02T10:00:00Z", "25.50", ["onam20"]); // A
    await order(o, "2026-03-07T10:00:00Z", "4.50", ["Onam20", "OTHER"]); // A, inside its 3 attribution days
    await order(o, "2026-03-08T00:00:01Z", "99.00", ["ONAM20"]); // after A's window
    await order(o, "2026-03-03T10:00:00Z", "50.00", ["ONAM20"], true); // cancelled
    await order(o, "2026-04-01T12:00:00Z", "7.25", ["DIWALI"]); // B

    const res = await ctx.app.inject({ method: "GET", url: `${o.base}/campaigns`, headers: o.headers });
    expect(res.statusCode).toBe(200);
    const byId = new Map((res.json().campaigns as Array<{ id: string; metrics: { codeOrders: unknown } }>).map((c) => [c.id, c.metrics.codeOrders]));
    expect(byId.get(a.id)).toEqual({ orders: 2, revenue: 30 });
    expect(byId.get(b.id)).toEqual({ orders: 1, revenue: 7.25 });
    expect(byId.get(noCode.id)).toBeNull();
    expect(byId.get(notStarted.id)).toBeNull();
  });
});

describe("paging", () => {
  it("pages reviews by cursor, newest first, and clamps the page size", async () => {
    const o = await owner();
    for (let i = 0; i < 5; i++) {
      await systemDb.customerReview.create({
        data: { workspaceId: o.ws, storeId: o.store.id, trackingId: `t${i}`, shopifyOrderId: String(i), orderName: `#${i}`, rating: 5, status: "published", submittedAt: new Date(Date.UTC(2026, 4, 1 + i)) },
      });
    }
    const get = (qs: string) => ctx.app.inject({ method: "GET", url: `${o.base}/reviews?${qs}`, headers: o.headers }).then((r) => r.json());
    const first = await get("limit=2");
    expect(first.reviews.map((r: { orderName: string }) => r.orderName)).toEqual(["#4", "#3"]);
    const second = await get(`limit=2&cursor=${first.nextCursor}`);
    expect(second.reviews.map((r: { orderName: string }) => r.orderName)).toEqual(["#2", "#1"]);
    const last = await get(`limit=2&cursor=${second.nextCursor}`);
    expect(last.reviews.map((r: { orderName: string }) => r.orderName)).toEqual(["#0"]);
    expect(last.nextCursor).toBeNull();
    // Unreadable or out-of-range sizes fall back as they always did.
    expect((await get("limit=abc")).reviews).toHaveLength(5);
    expect((await get("limit=-3")).reviews).toHaveLength(1);
    expect((await get("limit=1000")).reviews).toHaveLength(5);
  });
});
