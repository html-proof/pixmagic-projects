import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectDb, systemDb, toNumber } from "@app/db";
import { resetDb } from "@app/db/testing";
import {
  checkWindow,
  encryptTokenFields,
  memoryBlobs,
  memoryCoord,
  memoryMailer,
  memoryQueues,
  normalizeGraphqlOrder,
  recomputeDays,
  settleReturningCustomers,
  startReconciliation,
  upsertOrder,
  writeOrderBatch,
  type FetchLike,
  type VerifyJob,
} from "@app/core";
import { addDays, localDay } from "@app/shared";
import { processWebhook, runAggregate, type WorkerDeps } from "../src/handlers.js";
import { consume, type QueueMessage } from "../src/index.js";
import { runVerify } from "../src/verify.js";
import { agreement, sale, saleMoney, salesAnswer, shopifySales } from "./shopifySales.js";

/**
 * The check against Shopify (packages/core/src/reconcile.ts, apps/worker/src/verify.ts), new and
 * returning customers as Shopify tells them apart, and orders deleted in Shopify.
 */

const queues = memoryQueues();
const coord = memoryCoord();
const payloads = memoryBlobs();
const mailer = memoryMailer();
let fetchImpl: FetchLike;
let deps: WorkerDeps;

beforeAll(() => {
  deps = { coord, queues, payloads, mailer, fetchImpl: ((...a: Parameters<FetchLike>) => fetchImpl(...a)) as FetchLike };
});
afterAll(async () => {
  await disconnectDb();
});
beforeEach(async () => {
  await resetDb();
  queues.clear();
  coord.clear();
  mailer.sent.length = 0;
  shopifySales.clear();
  fetchImpl = async (url, init) => {
    const sales = salesAnswer(url, init);
    if (sales) return sales;
    throw new Error("unexpected fetch");
  };
});

async function makeStore(scopes = ["read_orders", "read_products", "read_customers"], timezone = "UTC") {
  const ws = await systemDb.workspace.create({ data: { name: "W" } });
  const store = await systemDb.store.create({
    data: { workspaceId: ws.id, shopDomain: "s.myshopify.com", grantedScopes: scopes, status: "active", timezone, currency: "AUD", pixelIngestKey: "pk-s" },
  });
  await systemDb.store.update({
    where: { id: store.id },
    data: encryptTokenFields(store.id, { accessToken: "shpat_x", scopes, accessTokenExpiresAt: null, refreshToken: null, refreshTokenExpiresAt: null }),
  });
  return systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
}

const money = (amount: string | number) => ({ shopMoney: { amount: String(amount) } });

/** Noon UTC `daysAgo` days back: inside the last 7 finished days of a UTC store when 1..7. */
const at = (daysAgo: number, hour = 12) => {
  const d = new Date();
  d.setUTCHours(hour, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString();
};
const dayOf = (iso: string) => iso.slice(0, 10);

/** A GraphQL orders-page node, whole (no detail reads needed): one product sale plus shipping. */
function gOrder(id: number, over: Record<string, unknown> = {}, opts: { price?: number; refund?: { at: string; amount: number }; customer?: number; index?: number | null; count?: number } = {}) {
  const createdAt = (over.createdAt as string | undefined) ?? at(3);
  const price = opts.price ?? 100;
  const agreements = [
    agreement(createdAt, [
      sale({ id: `gid://shopify/Sale/${id}1`, quantity: 1, totalAmount: saleMoney(price), totalTaxAmount: saleMoney((price / 11).toFixed(2)), lineItem: { id: `gid://shopify/LineItem/${id}` } }),
      sale({ id: `gid://shopify/Sale/${id}2`, lineType: "SHIPPING", quantity: null, totalAmount: saleMoney(10) }),
    ]),
    ...(opts.refund
      ? [agreement(opts.refund.at, [sale({ id: `gid://shopify/Sale/${id}3`, actionType: "RETURN", quantity: -1, totalAmount: saleMoney(-opts.refund.amount), lineItem: { id: `gid://shopify/LineItem/${id}` } })])]
      : []),
  ];
  return {
    id: `gid://shopify/Order/${id}`,
    name: `#${id}`,
    createdAt,
    updatedAt: opts.refund?.at ?? createdAt,
    cancelledAt: null,
    test: false,
    currencyCode: "AUD",
    displayFinancialStatus: "PAID",
    sourceName: "web",
    displayFulfillmentStatus: "UNFULFILLED",
    discountCodes: [],
    customerJourneySummary: { ready: true, customerOrderIndex: opts.index === undefined ? null : opts.index, lastVisit: null },
    subtotalPriceSet: money(price),
    totalDiscountsSet: money(0),
    totalTaxSet: money((price / 11).toFixed(2)),
    totalShippingPriceSet: money(10),
    totalPriceSet: money(price + 10),
    customer: opts.customer ? { id: `gid://shopify/Customer/${opts.customer}`, numberOfOrders: String(opts.count ?? 1) } : null,
    fulfillments: [],
    lineItems: { pageInfo: { hasNextPage: false }, nodes: [{ id: `gid://shopify/LineItem/${id}`, title: "Tee", quantity: 1, sku: "T", variant: null, product: null, originalUnitPriceSet: money(price), totalDiscountSet: money(0) }] },
    agreements: { pageInfo: { hasNextPage: false }, nodes: agreements },
    ...over,
  };
}

type GqlBody = { query: string; variables: Record<string, unknown> };
const gqlJson = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });

/**
 * A fake Shopify for the check: `orders` is what it lists (newest first, pages of the size asked),
 * `gone` the order ids it says don't exist any more, `tests` those that are test orders.
 */
function fakeShopify(orders: Array<ReturnType<typeof gOrder>>, opts: { gone?: string[]; tests?: string[] } = {}) {
  const calls: GqlBody[] = [];
  fetchImpl = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as GqlBody;
    calls.push(body);
    if (body.query.includes("query Orders(")) {
      const sorted = [...orders].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const start = Number(body.variables.cursor ?? 0);
      const first = Number(body.variables.first);
      const nodes = sorted.slice(start, start + first);
      const more = start + first < sorted.length;
      return gqlJson({ orders: { pageInfo: { hasNextPage: more, endCursor: more ? String(start + first) : null }, nodes } });
    }
    if (body.query.includes("query OrdersStillThere")) {
      const ids = body.variables.ids as string[];
      return gqlJson({
        nodes: ids.map((gid) => {
          const id = gid.split("/").pop()!;
          if (opts.gone?.includes(id)) return null;
          return { id: gid, test: !!opts.tests?.includes(id) };
        }),
      });
    }
    throw new Error(`unexpected query ${body.query.slice(0, 60)}`);
  };
  return calls;
}

async function drainAggregates() {
  for (const j of queues.sent.aggregate.splice(0)) await runAggregate(j);
}

/** Run the check job(s) the queue holds until none is left. */
async function runChecks(now?: () => number) {
  for (let i = 0; i < 20; i++) {
    const jobs = (queues.sent.sync as unknown as VerifyJob[]).splice(0).filter((j) => j.kind === "verify");
    if (!jobs.length) return;
    for (const j of jobs) await runVerify(j, deps, now);
  }
  throw new Error("check never finished");
}

async function seed(store: { id: string; workspaceId: string; timezone: string; grantedScopes: string[] }, nodes: Array<ReturnType<typeof gOrder>>) {
  const days = await writeOrderBatch(store, nodes.map((n) => normalizeGraphqlOrder(n)));
  await recomputeDays(store, [...days]);
}

const results = async (id: string) => Object.fromEntries((await systemDb.reconciliationResult.findMany({ where: { reconciliationId: id } })).map((r) => [r.metric, r]));

describe("new and returning customers, as Shopify tells them apart", () => {
  it("a customer's first purchase stays new after they buy again (Shopify's position of the order)", async () => {
    const store = await makeStore();
    // Imported after both orders: Shopify's lifetime count is 2 on each, which used to mark both returning.
    await writeOrderBatch(store, [
      normalizeGraphqlOrder(gOrder(1, { createdAt: at(5) }, { customer: 7, index: 1, count: 2 })),
      normalizeGraphqlOrder(gOrder(2, { createdAt: at(2) }, { customer: 7, index: 2, count: 2 })),
    ]);
    const byId = Object.fromEntries((await systemDb.order.findMany()).map((o) => [o.shopifyId, o]));
    expect(byId["1"]!.isReturningCustomer).toBe(false);
    expect(byId["2"]!.isReturningCustomer).toBe(true);
    expect(byId["1"]!.customerOrderIndex).toBe(1);
    expect(byId["2"]!.customerOrderCount).toBe(2);
  });

  it("without Shopify's position: an earlier stored order, or more lifetime orders than stored, makes it returning", async () => {
    const store = await makeStore();
    await writeOrderBatch(store, [
      // POS orders have no journey. Customer 8: two orders stored, lifetime 2 → first new, second returning.
      normalizeGraphqlOrder(gOrder(11, { createdAt: at(6), customerJourneySummary: null }, { customer: 8, count: 2 })),
      normalizeGraphqlOrder(gOrder(12, { createdAt: at(4), customerJourneySummary: null }, { customer: 8, count: 2 })),
      // Customer 9: one order stored, lifetime 3 → bought before the imported history: returning.
      normalizeGraphqlOrder(gOrder(13, { createdAt: at(3), customerJourneySummary: null }, { customer: 9, count: 3 })),
      // Customer 10: one order, lifetime 1 → new.
      normalizeGraphqlOrder(gOrder(14, { createdAt: at(3), customerJourneySummary: null }, { customer: 10, count: 1 })),
    ]);
    const flags = Object.fromEntries((await systemDb.order.findMany()).map((o) => [o.shopifyId, o.isReturningCustomer]));
    expect(flags).toEqual({ "11": false, "12": true, "13": true, "14": false });
  });

  it("repairs flags an earlier rule set, and returns the days that changed", async () => {
    const store = await makeStore();
    await seed(store, [gOrder(21, { createdAt: at(5) }, { customer: 7, index: 1, count: 2 }), gOrder(22, { createdAt: at(2) }, { customer: 7, index: 2, count: 2 })]);
    await systemDb.order.updateMany({ data: { isReturningCustomer: true } });
    const days = await settleReturningCustomers(store.id);
    expect([...days]).toEqual([dayOf(at(5))]);
    expect((await systemDb.order.findFirstOrThrow({ where: { shopifyId: "21" } })).isReturningCustomer).toBe(false);
  });

  it("a webhook's order learns its position from the sales read that follows it", async () => {
    const store = await makeStore();
    await writeOrderBatch(store, [normalizeGraphqlOrder(gOrder(30, { createdAt: at(9) }, { customer: 5, index: 1, count: 1 }))]);
    // Shopify's answer to the sales read: the new order is the customer's second.
    shopifySales.set("31", { updatedAt: at(1), agreements: [agreement(at(1), [sale({ totalAmount: saleMoney(50) })])] });
    const realFetch = fetchImpl;
    fetchImpl = async (url, init) => {
      const res = await realFetch(url, init);
      const body = (await res.json()) as { data: { order: Record<string, unknown> | null } };
      if (body.data.order) body.data.order.customerJourneySummary = { customerOrderIndex: 2 };
      return gqlJson(body.data);
    };
    const ev = await systemDb.webhookEvent.create({ data: { webhookId: "w1", topic: "orders/create", shopDomain: "s.myshopify.com" } });
    await processWebhook(
      {
        eventId: ev.id,
        topic: "orders/create",
        shop: "s.myshopify.com",
        payload: { id: 31, name: "#31", currency: "AUD", created_at: at(1), updated_at: at(1), customer: { id: 5 }, line_items: [{ id: 3, quantity: 1, price: "50.00" }], total_price: "50.00" },
      },
      deps,
    );
    const o = await systemDb.order.findFirstOrThrow({ where: { shopifyId: "31" } });
    expect(o.customerOrderIndex).toBe(2);
    expect(o.isReturningCustomer).toBe(true);
  });
});

describe("orders deleted in Shopify", () => {
  it("orders/delete removes the order and its sales, and recomputes its days", async () => {
    const store = await makeStore();
    await seed(store, [gOrder(40, { createdAt: at(2) })]);
    const day = dayOf(at(2));
    expect((await systemDb.dailyStoreMetrics.findUniqueOrThrow({ where: { storeId_day: { storeId: store.id, day } } })).orders).toBe(1);
    const ev = await systemDb.webhookEvent.create({ data: { webhookId: "d1", topic: "orders/delete", shopDomain: "s.myshopify.com" } });
    await processWebhook({ eventId: ev.id, topic: "orders/delete", shop: "s.myshopify.com", payload: { id: 40 } }, deps);
    await drainAggregates();
    expect(await systemDb.order.count()).toBe(0);
    expect(await systemDb.orderSale.count()).toBe(0);
    const m = await systemDb.dailyStoreMetrics.findUniqueOrThrow({ where: { storeId_day: { storeId: store.id, day } } });
    expect(m.orders).toBe(0);
    expect(toNumber(m.totalSales)).toBe(0);
  });
});

describe("checked against Shopify", () => {
  it("the window: the last 7 finished days, within Shopify's 60 days and the imported history", () => {
    const now = new Date("2026-10-18T05:00:00Z");
    expect(checkWindow({ timezone: "UTC", grantedScopes: ["read_orders"], ordersHistoryFrom: null }, 7, now)).toEqual({ from: "2026-10-11", to: "2026-10-17", timezone: "UTC" });
    // 60 days back is as far as Shopify lists without read_all_orders.
    expect(checkWindow({ timezone: "UTC", grantedScopes: ["read_orders"], ordersHistoryFrom: null }, 90, now)!.from).toBe("2026-08-20");
    expect(checkWindow({ timezone: "UTC", grantedScopes: ["read_all_orders"], ordersHistoryFrom: null }, 90, now)!.from).toBe("2026-07-20");
    // Not before the first whole imported day.
    expect(checkWindow({ timezone: "UTC", grantedScopes: ["read_orders"], ordersHistoryFrom: new Date("2026-10-15T10:00:00Z") }, 7, now)!.from).toBe("2026-10-16");
    // Imported today: nothing finished to check.
    expect(checkWindow({ timezone: "UTC", grantedScopes: ["read_orders"], ordersHistoryFrom: new Date("2026-10-17T10:00:00Z") }, 7, now)).toBeNull();
  });

  it("verifies a store whose figures already match, and records each figure", async () => {
    const store = await makeStore();
    const orders = [gOrder(1, { createdAt: at(2) }), gOrder(2, { createdAt: at(4) }, { refund: { at: at(3), amount: 40 } })];
    await seed(store, orders);
    fakeShopify(orders);
    const started = await startReconciliation(deps, store, "manual");
    await runChecks();
    const rec = await systemDb.reconciliation.findUniqueOrThrow({ where: { id: started!.id } });
    expect(rec.status).toBe("verified");
    expect(rec.state).toBeNull();
    const r = await results(rec.id);
    expect(r.orders!.status).toBe("match");
    expect(toNumber(r.orders!.shopifyValue)).toBe(2);
    expect(toNumber(r.returns!.shopifyValue)).toBe(40);
    expect(toNumber(r.netSales!.shopifyValue)).toBeCloseTo(2 * (100 - 9.09) - 40, 2);
    expect(Object.values(r).every((x) => x.status === "match")).toBe(true);
  });

  it("finds and repairs a missing order, an out-of-date order and a day total left behind", async () => {
    const store = await makeStore();
    const shopify = [gOrder(1, { createdAt: at(2) }), gOrder(2, { createdAt: at(4) }, { refund: { at: at(3), amount: 40 } }), gOrder(3, { createdAt: at(5) })];
    // Stored: order 2 without its refund (its webhook was lost), order 3 never arrived.
    await seed(store, [shopify[0]!, gOrder(2, { createdAt: at(4) })]);
    // And one day's total was never recomputed after a change.
    await systemDb.dailyStoreMetrics.update({ where: { storeId_day: { storeId: store.id, day: dayOf(at(2)) } }, data: { grossSales: 1 } });
    fakeShopify(shopify);
    const started = await startReconciliation(deps, store, "scheduled");
    await runChecks();
    const rec = await systemDb.reconciliation.findUniqueOrThrow({ where: { id: started!.id } });
    expect(rec.status).toBe("repaired");
    const f = rec.findings as Record<string, { count: number; orders: Array<{ name: string }> }>;
    expect(f.missing!.count).toBe(1);
    expect(f.missing!.orders[0]!.name).toBe("#3");
    expect(f.outdated!.count).toBe(1);
    expect(f.stale_day!.count).toBe(1);
    const r = await results(rec.id);
    expect(r.orders!.status).toBe("repaired");
    expect(toNumber(r.orders!.beforeValue)).toBe(2);
    expect(toNumber(r.orders!.afterValue)).toBe(3);
    expect(r.returns!.status).toBe("repaired");
    expect(r.returns!.cause).toBe("missing");
    expect(await systemDb.order.count()).toBe(3);
    expect(await systemDb.orderSale.count({ where: { actionType: "return" } })).toBe(1);
  });

  it("removes an order deleted in Shopify and a stored test order, and nothing else", async () => {
    const store = await makeStore();
    const kept = gOrder(1, { createdAt: at(2) });
    await seed(store, [kept, gOrder(5, { createdAt: at(3) }), gOrder(6, { createdAt: at(4) })]);
    // Shopify lists only #1: #5 was deleted, #6 is a test order (only test, imported, draft or manually paid orders can be deleted).
    fakeShopify([kept], { gone: ["5"], tests: ["6"] });
    const started = await startReconciliation(deps, store, "manual");
    await runChecks();
    const rec = await systemDb.reconciliation.findUniqueOrThrow({ where: { id: started!.id } });
    expect(rec.status).toBe("repaired");
    expect((rec.findings as Record<string, { count: number }>).deleted!.count).toBe(1);
    expect((rec.findings as Record<string, { count: number }>).test_order!.count).toBe(1);
    expect((await systemDb.order.findMany()).map((o) => o.shopifyId)).toEqual(["1"]);
    expect((rec.actions as { removed: number }).removed).toBe(2);
  });

  // Regression (2026-10-18, production): PixMagic's #2718S was created 61 days before the first
  // 60-day check and edited inside the window. Shopify neither lists nor returns an order that old
  // without read_all_orders, so the check took it for deleted and removed it.
  it("never removes an order Shopify no longer shares (over 60 days old): it is out of reach, not deleted", async () => {
    const store = await makeStore(["read_orders"]);
    const kept = gOrder(1, { createdAt: at(2) });
    // Placed 61 days ago, with a sale (an edit) inside the window.
    const old = gOrder(7, { createdAt: at(61) });
    await seed(store, [kept, old]);
    const edit = await systemDb.order.findFirstOrThrow({ where: { shopifyId: "7" } });
    await systemDb.orderSale.create({
      data: { workspaceId: store.workspaceId, storeId: store.id, orderId: edit.id, shopifyId: "edit-1", localDay: dayOf(at(3)), happenedAt: new Date(at(3)), actionType: "order", lineType: "product", quantity: 1, amount: 37, discount: 0, tax: 3.36 },
    });
    await recomputeDays(store, [dayOf(at(3))]);
    // Shopify lists only #1, and answers null for #7 (it doesn't share it any more).
    const calls = fakeShopify([kept], { gone: ["7"] });
    const started = await startReconciliation(deps, store, "scheduled");
    await runChecks();
    const rec = await systemDb.reconciliation.findUniqueOrThrow({ where: { id: started!.id } });
    expect(await systemDb.order.count({ where: { shopifyId: "7" } })).toBe(1);
    expect((rec.actions as { removed: number }).removed).toBe(0);
    expect((rec.findings as Record<string, { count: number; orders: Array<{ name: string }> }>).not_listed).toMatchObject({ count: 1, orders: [{ name: "#7" }] });
    expect(rec.findings).not.toHaveProperty("deleted");
    // Never even looked up: to the API it is indistinguishable from a deleted order.
    expect(calls.some((c) => c.query.includes("OrdersStillThere"))).toBe(false);
    // The figures it touches can't be vouched for; the rest still match.
    expect(rec.status).toBe("incomplete");
    const r = await results(rec.id);
    expect(r.totalSales!.status).toBe("not_verifiable");
    expect(r.orders!.status).toBe("match");
  });

  it("only looks in a dry run: the differences are recorded and alerted, nothing is written", async () => {
    const store = await makeStore();
    await seed(store, [gOrder(1, { createdAt: at(2) })]);
    fakeShopify([gOrder(1, { createdAt: at(2) }), gOrder(2, { createdAt: at(3) })]);
    const started = await startReconciliation(deps, store, "manual", { dryRun: true });
    await runChecks();
    const rec = await systemDb.reconciliation.findUniqueOrThrow({ where: { id: started!.id } });
    expect(rec.status).toBe("differences");
    expect(await systemDb.order.count()).toBe(1);
    const r = await results(rec.id);
    expect(r.orders!.status).toBe("difference");
    expect(r.orders!.cause).toBe("missing");
    const alert = await systemDb.alert.findFirstOrThrow({ where: { code: "reconciliation_mismatch" } });
    expect(alert.resolvedAt).toBeNull();
    // The next check that matches resolves it.
    const again = await startReconciliation(deps, store, "manual");
    await runChecks();
    expect((await systemDb.reconciliation.findUniqueOrThrow({ where: { id: again!.id } })).status).toBe("repaired");
    expect((await systemDb.alert.findFirstOrThrow({ where: { code: "reconciliation_mismatch" } })).resolvedAt).not.toBeNull();
  });

  it("an order changed in Shopify while the check ran is a sync delay, not an error", async () => {
    const store = await makeStore();
    await seed(store, [gOrder(1, { createdAt: at(2) })]);
    const started = await startReconciliation(deps, store, "manual");
    // Refunded after the check began: Shopify's copy is newer than the check.
    const later = new Date(Date.now() + 60_000).toISOString();
    fakeShopify([gOrder(1, { createdAt: at(2), updatedAt: later }, { refund: { at: at(1), amount: 20 } })]);
    await runChecks();
    const rec = await systemDb.reconciliation.findUniqueOrThrow({ where: { id: started!.id } });
    expect((rec.findings as Record<string, { count: number }>).changed_during_check!.count).toBe(1);
    // Brought up to date anyway, so the figures match after.
    expect(["repaired", "incomplete"]).toContain(rec.status);
    expect(await systemDb.orderSale.count({ where: { actionType: "return" } })).toBe(1);
  });

  it("a big store's check carries on in the next job with its progress kept", async () => {
    const store = await makeStore();
    const orders = Array.from({ length: 12 }, (_, i) => gOrder(100 + i, { createdAt: at(1 + (i % 6), 8 + i) }));
    await seed(store, orders);
    const calls = fakeShopify(orders);
    const started = await startReconciliation(deps, store, "manual");
    // Each Shopify call "takes" 5 minutes, so an invocation stops after two pages.
    let t = Date.now();
    const clock = () => (t += 5 * 60_000);
    const first = (queues.sent.sync as unknown as VerifyJob[]).splice(0)[0]!;
    expect(await runVerify(first, deps, clock)).toEqual({ continued: true });
    const mid = await systemDb.reconciliation.findUniqueOrThrow({ where: { id: started!.id } });
    expect(mid.status).toBe("running");
    expect((mid.state as { cursor: string }).cursor).toBeTruthy();
    await runChecks(clock);
    const rec = await systemDb.reconciliation.findUniqueOrThrow({ where: { id: started!.id } });
    expect(rec.status).toBe("verified");
    expect(rec.ordersChecked).toBe(12);
    expect(calls.filter((c) => c.query.includes("query Orders(")).length).toBe(3);
  });

  it("one check per store at a time; a failed job closes its run", async () => {
    const store = await makeStore();
    await seed(store, [gOrder(1, { createdAt: at(2) })]);
    const a = await startReconciliation(deps, store, "manual");
    const b = await startReconciliation(deps, store, "scheduled");
    expect(b).toEqual({ id: a!.id, started: false });
    fetchImpl = async () => new Response("no", { status: 401 });
    const job = (queues.sent.sync as unknown as VerifyJob[]).splice(0)[0]!;
    const msg: QueueMessage = { id: "m1", body: job, attempts: 99, ack() {}, retry() {} };
    await consume("sync", msg, { ...deps, dbHealthy: async () => true });
    const rec = await systemDb.reconciliation.findUniqueOrThrow({ where: { id: a!.id } });
    expect(rec.status).toBe("failed");
    expect(rec.state).toBeNull();
  });

  it("waits for a full import to finish rather than report its orders missing", async () => {
    const store = await makeStore();
    await systemDb.store.update({ where: { id: store.id }, data: { status: "syncing" } });
    const started = await startReconciliation(deps, store, "scheduled");
    const job = (queues.sent.sync as unknown as VerifyJob[]).splice(0)[0]!;
    expect(await runVerify(job, deps)).toEqual({ waiting: true });
    expect((queues.sent.sync as unknown as VerifyJob[])[0]).toMatchObject({ kind: "verify", reconciliationId: started!.id, importWaits: 1 });
  });

  it("days follow the store's time zone", async () => {
    const store = await makeStore(["read_orders"], "Australia/Melbourne");
    // 20:00 UTC is the next morning in Melbourne.
    const o = gOrder(1, { createdAt: at(3, 20) });
    await seed(store, [o]);
    fakeShopify([o]);
    const started = await startReconciliation(deps, store, "manual");
    await runChecks();
    const rec = await systemDb.reconciliation.findUniqueOrThrow({ where: { id: started!.id } });
    expect(rec.status).toBe("verified");
    expect(rec.toDay).toBe(addDays(localDay(new Date(), "Australia/Melbourne"), -1));
    const m = await systemDb.dailyStoreMetrics.findFirstOrThrow({ where: { storeId: store.id, orders: 1 } });
    expect(m.day).toBe(localDay(new Date(at(3, 20)), "Australia/Melbourne"));
  });

  it("upserting a webhook copy and the check agree (a check right after a webhook finds nothing)", async () => {
    const store = await makeStore(["read_orders"]);
    const o = gOrder(1, { createdAt: at(2) });
    await upsertOrder(store, normalizeGraphqlOrder(o));
    await drainAggregates();
    await recomputeDays(store, [dayOf(at(2))]);
    fakeShopify([o]);
    const started = await startReconciliation(deps, store, "manual");
    await runChecks();
    expect((await systemDb.reconciliation.findUniqueOrThrow({ where: { id: started!.id } })).status).toBe("verified");
  });
});
