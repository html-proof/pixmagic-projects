import { createServer, type AddressInfo, type Socket } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb, toNumber } from "@app/db";
import { resetDb } from "@app/db/testing";
import { dbReachable, disconnectDb, withDb } from "@app/db";
import {
  bulkUpsertProducts,
  bulkUpsertVariants,
  normalizeGraphqlOrder,
  upsertOrder,
  writeOrderBatch,
  encryptTokenFields,
  memoryBlobs,
  memoryCoord,
  memoryMailer,
  memoryQueues,
  normalizeGraphqlProduct,
  normalizeGraphqlVariant,
  upsertProduct,
  upsertVariant,
  MAX_ATTEMPTS,
  PAGE_SIZE,
  recomputeDays,
  type FetchLike,
  type SyncJobData,
} from "@app/core";
import { aggregateDaily, localDay, summarize } from "@app/shared";
import { BACKFILL_DAYS, failStaleJobs, ordersSearch, pixelIngestUrl, processWebhook, RECONCILE_ORDER_DAYS, reconcileOrderDays, runAggregate, runSync, scheduleReconcile, seedAfterMove, type WorkerDeps } from "../src/handlers.js";
import { consume, CRON, runScheduled, type QueueMessage } from "../src/index.js";

const queues = memoryQueues();
const coord = memoryCoord();
const payloads = memoryBlobs();
const mailer = memoryMailer();
let fetchImpl: FetchLike;
let deps: WorkerDeps;

beforeAll(async () => {
  deps = { coord, queues, payloads, mailer, fetchImpl: ((...a: Parameters<FetchLike>) => fetchImpl(...a)) as FetchLike };
});
afterAll(async () => {
  await disconnectDb();
});
beforeEach(async () => {
  await resetDb();
  queues.clear();
  coord.clear();
  payloads.data.clear();
  mailer.sent.length = 0;
  fetchImpl = async () => {
    throw new Error("unexpected fetch");
  };
});

async function makeStore(scopes = ["read_orders", "read_products", "read_customers"], timezone = "America/New_York", shopDomain = "s.myshopify.com") {
  const ws = await systemDb.workspace.create({ data: { name: "W" } });
  const store = await systemDb.store.create({
    data: { workspaceId: ws.id, shopDomain, grantedScopes: scopes, status: "syncing", timezone, pixelIngestKey: `pk-${shopDomain}` },
  });
  await systemDb.store.update({
    where: { id: store.id },
    data: encryptTokenFields(store.id, { accessToken: "shpat_x", scopes, accessTokenExpiresAt: null, refreshToken: null, refreshTokenExpiresAt: null }),
  });
  return systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
}

let seq = 0;
async function webhook(topic: string, payload: unknown) {
  const ev = await systemDb.webhookEvent.create({ data: { webhookId: `w${++seq}`, topic, shopDomain: "s.myshopify.com" } });
  return processWebhook({ eventId: ev.id, topic, shop: "s.myshopify.com", payload }, deps).then((r) => ({ r, ev }));
}

const order = (over: Record<string, unknown> = {}) => ({
  id: 1001,
  name: "#1001",
  currency: "USD",
  created_at: "2026-03-01T15:00:00Z",
  updated_at: "2026-03-01T15:00:00Z",
  cancelled_at: null,
  subtotal_price: "90.00",
  total_discounts: "10.00",
  total_tax: "0",
  total_price: "90.00",
  customer: { id: 7, email: "pii@example.com", first_name: "Pat" },
  line_items: [{ id: 1, product_id: 50, title: "Tee", quantity: 2, price: "50.00", total_discount: "10.00" }],
  ...over,
});

async function drainAggregates() {
  for (const j of queues.sent.aggregate.splice(0)) await runAggregate(j);
}

describe("webhook processing", () => {
  it("upserts orders idempotently and aggregates by store time zone", async () => {
    const store = await makeStore();
    const { ev } = await webhook("orders/create", order());
    // Re-running the same event is a no-op.
    expect(await processWebhook({ eventId: ev.id, topic: "orders/create", shop: "s.myshopify.com", payload: order() }, deps)).toEqual({ skipped: true });
    await webhook("orders/updated", order()); // different delivery, same content
    await drainAggregates();

    expect(await systemDb.order.count()).toBe(1);
    expect(await systemDb.orderLineItem.count()).toBe(1);
    const m = await systemDb.dailyStoreMetrics.findUniqueOrThrow({ where: { storeId_day: { storeId: store.id, day: "2026-03-01" } } });
    expect(toNumber(m.grossSales)).toBe(100);
    expect(toNumber(m.discounts)).toBe(10);
    expect(m.orders).toBe(1);

    // No PII persisted.
    const o = await systemDb.order.findFirstOrThrow();
    expect(JSON.stringify(o)).not.toMatch(/pii@example\.com|Pat/);
    expect(o.customerKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps the newer copy when two deliveries of one order are processed at the same time", async () => {
    await makeStore();
    const newer = order({ updated_at: "2026-03-01T16:00:00Z", cancelled_at: "2026-03-01T16:00:00Z" });
    const older = order({ updated_at: "2026-03-01T15:30:00Z", cancelled_at: null });
    for (let i = 0; i < 8; i++) {
      await systemDb.order.deleteMany();
      await Promise.all(i % 2 ? [webhook("orders/updated", newer), webhook("orders/updated", older)] : [webhook("orders/updated", older), webhook("orders/updated", newer)]);
      const o = await systemDb.order.findFirstOrThrow();
      expect(o.shopifyUpdatedAt.toISOString()).toBe("2026-03-01T16:00:00.000Z");
      expect(o.cancelledAt).not.toBeNull();
      expect(await systemDb.orderLineItem.count()).toBe(1);
    }
  });

  it("ignores stale (out-of-order) updates", async () => {
    await makeStore();
    await webhook("orders/updated", order({ updated_at: "2026-03-01T16:00:00Z", cancelled_at: "2026-03-01T16:00:00Z" }));
    await webhook("orders/updated", order({ updated_at: "2026-03-01T15:30:00Z", cancelled_at: null }));
    const o = await systemDb.order.findFirstOrThrow();
    expect(o.cancelledAt).not.toBeNull();
  });

  it("books refunds on the refund date and reduces net sales there", async () => {
    const store = await makeStore();
    await webhook("orders/create", order());
    await webhook("refunds/create", { id: 9, order_id: 1001, created_at: "2026-03-05T12:00:00Z", refund_line_items: [{ subtotal: "45.00" }] });
    await drainAggregates();
    const day5 = await systemDb.dailyStoreMetrics.findUniqueOrThrow({ where: { storeId_day: { storeId: store.id, day: "2026-03-05" } } });
    expect(toNumber(day5.refunds)).toBe(45);
    expect(day5.refundedOrders).toBe(1);
  });

  it("retries refunds whose order hasn't arrived yet", async () => {
    await makeStore();
    await expect(webhook("refunds/create", { id: 9, order_id: 555, created_at: "2026-03-05T12:00:00Z", refund_line_items: [] })).rejects.toThrow(/not found/);
  });

  it("does not store customer keys without read_customers", async () => {
    await makeStore(["read_orders"]);
    await webhook("orders/create", order());
    expect((await systemDb.order.findFirstOrThrow()).customerKey).toBeNull();
  });

  it("app/uninstalled wipes tokens; scopes_update changes capabilities", async () => {
    const store = await makeStore();
    await webhook("app/scopes_update", { current: ["read_orders"] });
    expect((await systemDb.store.findUniqueOrThrow({ where: { id: store.id } })).grantedScopes).toEqual(["read_orders"]);
    await webhook("app/uninstalled", { id: 1 });
    const s = await systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(s.status).toBe("uninstalled");
    expect(s.accessTokenEnc).toBeNull();
    expect(s.refreshTokenEnc).toBeNull();
  });

  /**
   * The webhook is the only thing that sees a grant made outside our own flow — a merchant
   * approving in their Shopify admin, or our `scopes/refresh` never being reached. Updating
   * grantedScopes alone would unlock the module on the dashboard while leaving it empty: the
   * orders already imported carry no customer hash, and no web pixel exists yet.
   */
  it("app/scopes_update queues the import work a newly granted scope needs", async () => {
    const store = await makeStore(["read_orders", "read_products"]);
    await webhook("app/scopes_update", { current: ["read_orders", "read_products", "read_customers", "write_pixels"] });

    const after = await systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(after.grantedScopes).toContain("read_customers");
    const kinds = queues.sent.sync.map((j) => j.kind);
    expect(kinds).toContain("orders");
    expect(kinds).toContain("install_pixel");
    // A full re-import: the missing customer hash goes back as far as the history does.
    expect(queues.sent.sync.find((j) => j.kind === "orders")?.sinceDays).toBeUndefined();
  });

  it("app/scopes_update still queues the import when its first attempt failed to", async () => {
    // Before: the new scopes were saved first, so the retry found nothing newly granted and the
    // backfill was never queued.
    const store = await makeStore(["read_orders"]);
    const payload = { current: ["read_orders", "read_products"] };
    const ev = await systemDb.webhookEvent.create({ data: { webhookId: `w${++seq}`, topic: "app/scopes_update", shopDomain: "s.myshopify.com" } });
    const send = queues.sync.send;
    queues.sync.send = async () => {
      throw new Error("queue unavailable");
    };
    try {
      await expect(processWebhook({ eventId: ev.id, topic: "app/scopes_update", shop: "s.myshopify.com", payload }, deps)).rejects.toThrow(/queue unavailable/);
    } finally {
      queues.sync.send = send;
    }
    // The queue redelivers the same event.
    await processWebhook({ eventId: ev.id, topic: "app/scopes_update", shop: "s.myshopify.com", payload }, deps);
    expect(queues.sent.sync.map((j) => j.kind).sort()).toEqual(["products", "variants"]);
    expect((await systemDb.store.findUniqueOrThrow({ where: { id: store.id } })).grantedScopes).toEqual(["read_orders", "read_products"]);
    // Held back, so the jobs read the scopes saved after they were queued.
    expect(queues.sentOpts.sync.every((o) => (o?.delaySeconds ?? 0) >= 30)).toBe(true);
  });

  it("app/scopes_update queues nothing when a scope is only revoked", async () => {
    await makeStore(["read_orders", "read_products", "read_customers"]);
    await webhook("app/scopes_update", { current: ["read_orders", "read_products"] });
    expect(queues.sent.sync).toEqual([]);
  });

  it("ignores an app/uninstalled delivery that predates the current installation", async () => {
    const store = await makeStore();
    // Shopify retries a failed delivery for up to 48h. The merchant uninstalled, then reinstalled
    // (the usual fix for an accidental uninstall), and only now does the original delivery land.
    const uninstalledAtShopify = new Date(Date.now() - 20 * 60_000);
    await systemDb.store.update({ where: { id: store.id }, data: { installedAt: new Date() } });

    const ev = await systemDb.webhookEvent.create({ data: { webhookId: "stale-uninstall", topic: "app/uninstalled", shopDomain: "s.myshopify.com" } });
    await processWebhook(
      { eventId: ev.id, topic: "app/uninstalled", shop: "s.myshopify.com", payload: {}, app: "default", triggeredAt: uninstalledAtShopify.toISOString() },
      deps,
    );

    // The live installation is untouched: without this guard the tokens were wiped and the store
    // disconnected, with nothing to put it back.
    const after = await systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(after.status).toBe("syncing");
    expect(after.accessTokenEnc).toBeTruthy();
    expect(after.uninstalledAt).toBeNull();
    expect(await systemDb.auditLog.count({ where: { action: "store.uninstalled" } })).toBe(0);
  });

  it("applies an app/uninstalled delivery generated after the current installation", async () => {
    const store = await makeStore();
    await systemDb.store.update({ where: { id: store.id }, data: { installedAt: new Date(Date.now() - 60 * 60_000) } });
    const ev = await systemDb.webhookEvent.create({ data: { webhookId: "fresh-uninstall", topic: "app/uninstalled", shopDomain: "s.myshopify.com" } });
    await processWebhook(
      { eventId: ev.id, topic: "app/uninstalled", shop: "s.myshopify.com", payload: {}, app: "default", triggeredAt: new Date(Date.now() + 1000).toISOString() },
      deps,
    );
    const after = await systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(after.status).toBe("uninstalled");
    expect(after.accessTokenEnc).toBeNull();
  });

  it("applies an app/uninstalled delivery when the install time is unknown", async () => {
    // installedAt is nullable; an unknown install time must not make a real uninstall a no-op,
    // which would keep a revoked merchant's tokens.
    const store = await makeStore();
    expect(store.installedAt).toBeNull();
    const ev = await systemDb.webhookEvent.create({ data: { webhookId: "no-installedat", topic: "app/uninstalled", shopDomain: "s.myshopify.com" } });
    await processWebhook(
      { eventId: ev.id, topic: "app/uninstalled", shop: "s.myshopify.com", payload: {}, app: "default", triggeredAt: new Date(Date.now() - 20 * 60_000).toISOString() },
      deps,
    );
    const after = await systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(after.status).toBe("uninstalled");
    expect(after.accessTokenEnc).toBeNull();
  });

  it("ignores uninstall/scope/redact events from one of our other apps on the same shop", async () => {
    const store = await makeStore();
    await systemDb.store.update({ where: { id: store.id }, data: { shopifyAppKey: "client" } });
    for (const [topic, payload] of [["app/uninstalled", {}], ["app/scopes_update", { current: ["read_orders"] }], ["shop/redact", {}]] as const) {
      const ev = await systemDb.webhookEvent.create({ data: { webhookId: `other-${topic}`, topic, shopDomain: "s.myshopify.com" } });
      await processWebhook({ eventId: ev.id, topic, shop: "s.myshopify.com", payload, app: "default" }, deps);
    }
    const after = await systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(after.status).toBe("syncing");
    expect(after.accessTokenEnc).toBeTruthy();
    expect(after.grantedScopes).toEqual(store.grantedScopes);

    // The app it is connected through is listened to.
    const ev = await systemDb.webhookEvent.create({ data: { webhookId: "own-uninstall", topic: "app/uninstalled", shopDomain: "s.myshopify.com" } });
    await processWebhook({ eventId: ev.id, topic: "app/uninstalled", shop: "s.myshopify.com", payload: {}, app: "client" }, deps);
    expect((await systemDb.store.findUniqueOrThrow({ where: { id: store.id } })).status).toBe("uninstalled");
  });

  /** The workspace gets an owner, as one a merchant has claimed. */
  async function claim(workspaceId: string) {
    const user = await systemDb.user.create({ data: { email: `owner-${workspaceId}@x.com`, emailVerified: true } });
    await systemDb.membership.create({ data: { workspaceId, userId: user.id, role: "owner" } });
    return user;
  }

  it("GDPR: customers/redact unlinks the customer, shop/redact purges data", async () => {
    const store = await makeStore();
    await claim(store.workspaceId);
    await webhook("orders/create", order());
    await webhook("customers/redact", { customer: { id: 7 } });
    expect((await systemDb.order.findFirstOrThrow()).customerKey).toBeNull();
    // Shopify sends shop/redact 48 hours after the app is uninstalled.
    await webhook("app/uninstalled", {});
    await webhook("shop/redact", { shop_domain: "s.myshopify.com" });
    expect(await systemDb.order.count()).toBe(0);
    expect(await systemDb.orderLineItem.count()).toBe(0);
    expect(await systemDb.auditLog.count({ where: { action: { startsWith: "gdpr." } } })).toBe(2);
  });

  it("GDPR: shop/redact erases the store itself, so a later install can't join the old account", async () => {
    const store = await makeStore();
    await claim(store.workspaceId);
    await webhook("orders/create", order());
    await systemDb.syncJob.create({ data: { workspaceId: store.workspaceId, storeId: store.id, kind: "orders" } });
    await systemDb.alert.create({ data: { workspaceId: store.workspaceId, storeId: store.id, severity: "warning", code: "x", message: "x" } });
    await webhook("app/uninstalled", {});
    await webhook("shop/redact", { shop_domain: "s.myshopify.com" });
    expect(await systemDb.store.findUnique({ where: { id: store.id } })).toBeNull();
    expect(await systemDb.syncJob.count({ where: { storeId: store.id } })).toBe(0);
    expect(await systemDb.alert.count({ where: { storeId: store.id } })).toBe(0);
    expect(await systemDb.webhookEvent.count({ where: { storeId: store.id } })).toBe(0);
    // The account keeps its workspace and its record of what happened.
    expect(await systemDb.workspace.findUnique({ where: { id: store.workspaceId } })).not.toBeNull();
    expect(await systemDb.auditLog.count({ where: { workspaceId: store.workspaceId, action: "gdpr.shop_redacted" } })).toBe(1);
  });

  it("GDPR: shop/redact for a store nobody claimed removes its workspace too", async () => {
    const store = await makeStore();
    await webhook("app/uninstalled", {});
    await webhook("shop/redact", { shop_domain: "s.myshopify.com" });
    expect(await systemDb.store.count()).toBe(0);
    expect(await systemDb.workspace.findUnique({ where: { id: store.workspaceId } })).toBeNull();
  });

  it("GDPR: shop/redact for a store installed again since erases nothing", async () => {
    const store = await makeStore();
    await claim(store.workspaceId);
    await webhook("orders/create", order());
    // Uninstalled, then installed again before Shopify's 48-hour shop/redact arrived.
    await webhook("shop/redact", { shop_domain: "s.myshopify.com" });
    const after = await systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(after.accessTokenEnc).toBeTruthy();
    expect(await systemDb.order.count()).toBe(1);
    expect(await systemDb.auditLog.count({ where: { action: "gdpr.shop_redact_skipped" } })).toBe(1);
  });

  it("GDPR: customers/data_request is recorded once, owners are told, and redaction removes it", async () => {
    const store = await makeStore();
    const owner = await claim(store.workspaceId);
    await webhook("orders/create", order());
    const request = { shop_domain: "s.myshopify.com", customer: { id: 7, email: "Pii@Example.com", phone: "+61 412 345 678" }, orders_requested: [1001], data_request: { id: 9999 } };
    await webhook("customers/data_request", request);
    // Shopify delivers at least once: a redelivery (another webhook id) records nothing new.
    await webhook("customers/data_request", request);
    const rows = await systemDb.dataRequest.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspaceId: store.workspaceId, storeId: store.id, shopifyRequestId: "9999", customerId: "7", ordersRequested: ["1001"] });
    // Only keyed hashes are kept, never the address or the number.
    expect(rows[0]!.customerKey).toBe((await systemDb.order.findFirstOrThrow()).customerKey);
    expect(rows[0]!.emailHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.phoneHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows[0])).not.toMatch(/pii@example\.com|61412345678|\+61/i);
    expect(await systemDb.alert.count({ where: { storeId: store.id, code: "privacy_request", resolvedAt: null } })).toBe(1);
    expect(mailer.sent.filter((m) => m.to === owner.email && m.subject.includes("privacy_request"))).toHaveLength(1);
    expect(await systemDb.auditLog.count({ where: { action: "gdpr.customer_data_request" } })).toBe(1);

    await webhook("customers/redact", { customer: { id: 7 } });
    expect(await systemDb.dataRequest.count()).toBe(0);
  });
});

describe("initial sync", () => {
  it("syncs shop, fans out, backfills orders via GraphQL and marks the store active", async () => {
    const store = await makeStore(["read_orders"]);
    const shopJob = await systemDb.syncJob.create({ data: { workspaceId: store.workspaceId, storeId: store.id, kind: "shop" } });
    const ordersJob = await systemDb.syncJob.create({ data: { workspaceId: store.workspaceId, storeId: store.id, kind: "orders" } });
    let page = 0;
    fetchImpl = async (_url, init) => {
      const { query } = JSON.parse(String(init?.body));
      const json = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
      if (query.includes("shop {")) return json({ shop: { name: "Shop", currencyCode: "AUD", ianaTimezone: "Australia/Sydney" } });
      page++;
      const mk = (id: number) => ({
        id: `gid://shopify/Order/${id}`,
        name: `#${id}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        currencyCode: "AUD",
        subtotalPriceSet: { shopMoney: { amount: "20" } },
        totalDiscountsSet: { shopMoney: { amount: "0" } },
        totalTaxSet: { shopMoney: { amount: "0" } },
        totalShippingPriceSet: { shopMoney: { amount: "0" } },
        totalPriceSet: { shopMoney: { amount: "20" } },
        sourceName: "web",
        displayFulfillmentStatus: "UNFULFILLED",
        discountCodes: [],
        fulfillments: [],
        lineItems: {
          pageInfo: { hasNextPage: false },
          nodes: [{ id: `gid://shopify/LineItem/${id}`, title: "X", quantity: 1, sku: null, variant: null, product: null, originalUnitPriceSet: { shopMoney: { amount: "20" } }, totalDiscountSet: { shopMoney: { amount: "0" } } }],
        },
        refunds: [],
      });
      expect(query).not.toContain("customer {"); // no read_customers => don't ask for it
      return json({ orders: { pageInfo: { hasNextPage: page === 1, endCursor: "c1" }, nodes: page === 1 ? [mk(1), mk(2)] : [mk(3)] } });
    };

    await runSync({ storeId: store.id, kind: "shop", syncJobId: shopJob.id }, deps);
    const s1 = await systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(s1).toMatchObject({ timezone: "Australia/Sydney", currency: "AUD", name: "Shop" });
    expect(queues.sent.sync.map((j) => j.kind)).toEqual(["orders"]);
    queues.sent.sync.length = 0;

    // Page 1 re-enqueues itself with the next cursor; the job is not done yet.
    await runSync({ storeId: store.id, kind: "orders", syncJobId: ordersJob.id, pagedOnly: true }, deps);
    expect(queues.sent.sync).toEqual([{ storeId: store.id, kind: "orders", syncJobId: ordersJob.id, pagedOnly: true, cursor: "c1", progress: 2 }]);
    expect((await systemDb.syncJob.findUniqueOrThrow({ where: { id: ordersJob.id } })).status).toBe("running");
    await runSync(queues.sent.sync.pop()!, deps);
    expect(queues.sent.sync).toHaveLength(0);
    await drainAggregates();
    expect(await systemDb.order.count()).toBe(3);
    const s2 = await systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(s2.status).toBe("active");
    expect((await systemDb.syncJob.findUniqueOrThrow({ where: { id: ordersJob.id } })).status).toBe("succeeded");
    const total = await systemDb.dailyStoreMetrics.aggregate({ _sum: { orders: true } });
    expect(total._sum.orders).toBe(3);
  });

  it("the shop job starts only the jobs seeded with it, and never one that has been picked up", async () => {
    const store = await makeStore(["read_orders"]);
    const shopQuery = async () => gqlJson({ shop: { name: "Shop", currencyCode: "AUD", ianaTimezone: "Australia/Sydney" } });
    // Left behind by an earlier connect whose chain died after a retry rewrote it to "queued",
    // and a not-yet-started row from another connect (its own shop job starts it).
    await systemDb.syncJob.create({
      data: { workspaceId: store.workspaceId, storeId: store.id, kind: "orders", status: "queued", startedAt: new Date(Date.now() - 3600_000), createdAt: new Date(Date.now() - 4 * 3600_000) },
    });
    await systemDb.syncJob.create({ data: { workspaceId: store.workspaceId, storeId: store.id, kind: "orders" } });
    const shopJob = await makeJob(store, "shop");
    const ordersJob = await makeJob(store, "orders");
    fetchImpl = shopQuery;

    const msg = { storeId: store.id, kind: "shop" as const, syncJobId: shopJob.id, waitingJobIds: [ordersJob.id] };
    await runSync(msg, deps);
    // Every queued orders row used to go, each one a competing backfill.
    expect(queues.sent.sync).toEqual([{ storeId: store.id, kind: "orders", syncJobId: ordersJob.id }]);

    // The shop job is redelivered (its own success write was lost) after orders got going.
    queues.clear();
    await systemDb.syncJob.update({ where: { id: shopJob.id }, data: { status: "running" } });
    await systemDb.syncJob.update({ where: { id: ordersJob.id }, data: { status: "running", startedAt: new Date() } });
    await runSync(msg, deps);
    expect(queues.sent.sync).toEqual([]);
  });

  it("a shop message sent before the ids were carried starts the orders job seeded with it, not older ones", async () => {
    const store = await makeStore(["read_orders"]);
    await systemDb.syncJob.create({
      data: { workspaceId: store.workspaceId, storeId: store.id, kind: "orders", createdAt: new Date(Date.now() - 2 * 3600_000) },
    });
    const shopJob = await makeJob(store, "shop");
    const ordersJob = await makeJob(store, "orders");
    fetchImpl = async () => gqlJson({ shop: { name: "Shop", currencyCode: "AUD", ianaTimezone: "Australia/Sydney" } });
    await runSync({ storeId: store.id, kind: "shop", syncJobId: shopJob.id }, deps);
    expect(queues.sent.sync).toEqual([{ storeId: store.id, kind: "orders", syncJobId: ordersJob.id }]);
  });

  it("treats Shopify 401 as unrecoverable", async () => {
    const store = await makeStore();
    const job = await systemDb.syncJob.create({ data: { workspaceId: store.workspaceId, storeId: store.id, kind: "shop" } });
    fetchImpl = async () => new Response("", { status: 401 });
    await expect(runSync({ storeId: store.id, kind: "shop", syncJobId: job.id }, deps)).rejects.toMatchObject({ name: "UnrecoverableError" });
  });
});

describe("aggregation parity", () => {
  it("SQL aggregation matches the reference TypeScript implementation", async () => {
    const store = await makeStore(["read_orders", "read_customers"], "Asia/Tokyo");
    const raw = Array.from({ length: 25 }, (_, i) =>
      order({
        id: 2000 + i,
        created_at: new Date(Date.UTC(2026, 0, 1 + (i % 5), (i * 7) % 24)).toISOString(),
        updated_at: new Date(Date.UTC(2026, 0, 1 + (i % 5), (i * 7) % 24)).toISOString(),
        cancelled_at: i % 9 === 0 ? "2026-01-10T00:00:00Z" : null,
        customer: i % 3 === 0 ? null : { id: i % 4 },
        line_items: [{ id: 5000 + i, product_id: 1, title: "A", quantity: 1 + (i % 3), price: `${10 + i}.25`, total_discount: i % 2 ? "1.10" : "0" }],
        refunds: i % 4 === 0 ? [{ id: 9000 + i, created_at: "2026-01-06T23:30:00Z", refund_line_items: [{ subtotal: "3.33" }] }] : [],
      }),
    );
    for (const o of raw) await webhook("orders/create", o);
    const days = (await systemDb.order.findMany({ select: { localDay: true } })).map((o) => o.localDay);
    const refundDays = (await systemDb.refund.findMany({ select: { localDay: true } })).map((r) => r.localDay);
    await recomputeDays(store, [...new Set([...days, ...refundDays])]);

    const dbOrders = await systemDb.order.findMany({ include: { lineItems: true, refunds: true } });
    const ref = aggregateDaily(
      dbOrders.map((o) => ({
        createdAt: o.shopifyCreatedAt,
        cancelledAt: o.cancelledAt,
        customerKey: o.customerKey,
        isReturningCustomer: o.isReturningCustomer,
        lineItems: o.lineItems.map((li) => ({ price: toNumber(li.price), quantity: li.quantity, discount: toNumber(li.discount) })),
      })),
      dbOrders.flatMap((o) => o.refunds.map((r) => ({ orderId: o.id, createdAt: r.shopifyCreatedAt, lineSubtotal: toNumber(r.lineSubtotal) }))),
      "Asia/Tokyo",
      localDay,
    );
    const sql = await systemDb.dailyStoreMetrics.findMany({ where: { storeId: store.id } });
    const sqlSummary = summarize(
      sql.map((r) => ({ ...r, grossSales: toNumber(r.grossSales), discounts: toNumber(r.discounts), refunds: toNumber(r.refunds) })),
    );
    expect(sqlSummary).toEqual(summarize([...ref.values()]));
    for (const r of sql) {
      const t = ref.get(r.day);
      if (!t) continue;
      expect(r.orders).toBe(t.orders);
      expect(toNumber(r.grossSales)).toBeCloseTo(t.grossSales, 2);
      expect(toNumber(r.refunds)).toBeCloseTo(t.refunds, 2);
      expect(r.returningCustomerOrders).toBe(t.returningCustomerOrders);
    }
  });
});

describe("stale job watchdog", () => {
  /** A job claimed by a consumer that was killed: `running`, started long ago, never finished. */
  const wedged = (store: { id: string; workspaceId: string }, minutesAgo: number, kind = "products") =>
    systemDb.syncJob.create({
      data: {
        workspaceId: store.workspaceId,
        storeId: store.id,
        kind,
        status: "running",
        attempts: 1,
        startedAt: new Date(Date.now() - minutesAgo * 60_000),
      },
    });

  it("fails a job whose consumer died and moves the store out of syncing", async () => {
    const store = await makeStore();
    const owner = await systemDb.user.create({ data: { firebaseUid: "w1", email: "owner@w.com", emailVerified: true } });
    await systemDb.membership.create({ data: { workspaceId: store.workspaceId, userId: owner.id, role: "owner" } });
    const job = await wedged(store, 7 * 60);

    expect(await failStaleJobs(deps)).toBe(1);

    const after = await systemDb.syncJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe("failed");
    expect(after.finishedAt).not.toBeNull();
    expect(after.error).toMatch(/without reporting/);
    // The merchant must stop being told the import is still running.
    expect((await systemDb.store.findUniqueOrThrow({ where: { id: store.id } })).status).toBe("error");
    expect(await systemDb.alert.count({ where: { workspaceId: store.workspaceId, code: "sync_products_failed" } })).toBe(1);
  });

  it("leaves a job that is genuinely still running alone", async () => {
    const store = await makeStore();
    const job = await wedged(store, 2);

    expect(await failStaleJobs(deps)).toBe(0);
    expect((await systemDb.syncJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("running");
    expect((await systemDb.store.findUniqueOrThrow({ where: { id: store.id } })).status).toBe("syncing");
  });

  it("never drags an uninstalled store back into error", async () => {
    const store = await makeStore();
    await systemDb.store.update({ where: { id: store.id }, data: { status: "uninstalled" } });
    const job = await wedged(store, 7 * 60);

    expect(await failStaleJobs(deps)).toBe(1);
    expect((await systemDb.syncJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("failed");
    expect((await systemDb.store.findUniqueOrThrow({ where: { id: store.id } })).status).toBe("uninstalled");
    expect(await systemDb.alert.count({ where: { workspaceId: store.workspaceId } })).toBe(0);
  });

  it("judges a job by its last sign of life, which every page refreshes, not by when it started", async () => {
    const store = await makeStore();
    // A paged import started 40 minutes ago: startedAt is stamped once, on the first page only.
    const job = await wedged(store, 40);
    fetchImpl = async () =>
      gqlJson({
        products: {
          pageInfo: { hasNextPage: true, endCursor: "p2" },
          nodes: [{ id: "gid://shopify/Product/8", title: "Tee", status: "ACTIVE", vendor: "Acme", productType: "Shirts", createdAt: "2025-06-01T00:00:00Z", updatedAt: "2026-03-01T00:00:00Z" }],
        },
      });
    await runSync({ storeId: store.id, kind: "products", syncJobId: job.id, cursor: "p1", progress: 250 }, deps);
    expect((await systemDb.syncJob.findUniqueOrThrow({ where: { id: job.id } })).lastActivityAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);

    // Still going: it was reaped as dead (and its store flipped to error) half-way through.
    expect(await failStaleJobs(deps)).toBe(0);
    expect((await systemDb.syncJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("running");
    expect((await systemDb.store.findUniqueOrThrow({ where: { id: store.id } })).status).toBe("syncing");
  });

  it("reaps a started job a retry left queued, and only never-started jobs that lost their message", async () => {
    // pixmagic: the import's orders rows were rewritten to "queued" by a retry, then the chain
    // died. Nothing ever looked at them again; the store had already been reported as broken.
    const store = await makeStore();
    await systemDb.store.update({ where: { id: store.id }, data: { status: "error" } });
    const orphan = await systemDb.syncJob.create({
      data: { workspaceId: store.workspaceId, storeId: store.id, kind: "orders", status: "queued", progress: 133, startedAt: new Date(Date.now() - 5 * 3600_000) },
    });
    // Never started: waiting behind a backlog, or - hours on - its message is gone.
    const waiting = await systemDb.syncJob.create({ data: { workspaceId: store.workspaceId, storeId: store.id, kind: "products", createdAt: new Date(Date.now() - 60 * 60_000) } });
    const lost = await systemDb.syncJob.create({ data: { workspaceId: store.workspaceId, storeId: store.id, kind: "variants", createdAt: new Date(Date.now() - 7 * 3600_000) } });

    expect(await failStaleJobs(deps)).toBe(2);
    expect((await systemDb.syncJob.findUniqueOrThrow({ where: { id: orphan.id } })).status).toBe("failed");
    expect((await systemDb.syncJob.findUniqueOrThrow({ where: { id: lost.id } })).status).toBe("failed");
    expect((await systemDb.syncJob.findUniqueOrThrow({ where: { id: waiting.id } })).status).toBe("queued");
    // Already in error, already reported: no second round of alerts.
    expect((await systemDb.store.findUniqueOrThrow({ where: { id: store.id } })).status).toBe("error");
    expect(await systemDb.alert.count()).toBe(0);
  });

  it("leaves an active store alone when a newer sync of the same kind has succeeded", async () => {
    // A refresh died in a database outage; the next one, after the outage, went through.
    const store = await makeStore();
    await systemDb.store.update({ where: { id: store.id }, data: { status: "active", lastSyncedAt: new Date() } });
    const dead = await wedged(store, 40, "orders");
    await systemDb.syncJob.create({
      data: { workspaceId: store.workspaceId, storeId: store.id, kind: "orders", status: "succeeded", startedAt: new Date(Date.now() - 11 * 60_000), finishedAt: new Date(Date.now() - 10 * 60_000) },
    });

    expect(await failStaleJobs(deps)).toBe(1);
    expect((await systemDb.syncJob.findUniqueOrThrow({ where: { id: dead.id } })).status).toBe("failed");
    expect((await systemDb.store.findUniqueOrThrow({ where: { id: store.id } })).status).toBe("active");
    expect(await systemDb.alert.count()).toBe(0);
    expect(mailer.sent).toEqual([]);
  });

  it("only warns about an active store's dead refresh when nothing newer has succeeded", async () => {
    const store = await makeStore();
    await systemDb.store.update({ where: { id: store.id }, data: { status: "active", lastSyncedAt: new Date() } });
    await wedged(store, 40, "orders");

    expect(await failStaleJobs(deps)).toBe(1);
    // Its data is still good: no "Syncing this store has stopped" and Reconnect for a healthy store.
    expect((await systemDb.store.findUniqueOrThrow({ where: { id: store.id } })).status).toBe("active");
    const alerts = await systemDb.alert.findMany({ where: { workspaceId: store.workspaceId } });
    expect(alerts.map((a) => [a.severity, a.code])).toEqual([["warning", "sync_orders_stalled"]]);
  });
});

describe("queue consumer", () => {
  const message = (body: unknown, attempts: number) => {
    const m = { id: "m1", body, attempts, acked: false, retried: undefined as undefined | { delaySeconds?: number } };
    const msg: QueueMessage = { id: m.id, body, attempts, ack: () => (m.acked = true), retry: (o) => (m.retried = o ?? {}) };
    return { m, msg };
  };

  it("retries with backoff, then marks the job failed and alerts on the final attempt", async () => {
    const store = await makeStore();
    const ws = store.workspaceId;
    const owner = await systemDb.user.create({ data: { firebaseUid: "u", email: "owner@x.com", emailVerified: true } });
    await systemDb.membership.create({ data: { workspaceId: ws, userId: owner.id, role: "owner" } });
    const job = await systemDb.syncJob.create({ data: { workspaceId: ws, storeId: store.id, kind: "shop" } });
    const body = { storeId: store.id, kind: "shop", syncJobId: job.id };

    const first = message(body, 1);
    await consume("sync", first.msg, { ...deps, fetchImpl: async () => new Response(JSON.stringify({ errors: [{ message: "boom" }] }), { status: 200 }) });
    expect(first.m).toMatchObject({ acked: false, retried: { delaySeconds: 5 } });
    // A retry is the same run carrying on: the error is recorded, the status left as runSync set
    // it. This used to read "queued", which stranded a paged chain's row there for good.
    expect(await systemDb.syncJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "running", error: expect.stringMatching(/boom/) });

    const last = message(body, MAX_ATTEMPTS);
    await consume("sync", last.msg, { ...deps, fetchImpl: async () => new Response(JSON.stringify({ errors: [{ message: "boom" }] }), { status: 200 }) });
    expect(last.m).toMatchObject({ acked: true, retried: undefined });
    expect((await systemDb.syncJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("failed");
    expect((await systemDb.store.findUniqueOrThrow({ where: { id: store.id } })).status).toBe("error");
    expect(await systemDb.alert.count({ where: { workspaceId: ws, code: "sync_shop_failed" } })).toBe(1);
    expect(mailer.sent.map((x) => x.to)).toEqual(["owner@x.com"]);
  });

  it("fails unrecoverable errors immediately and acks successes", async () => {
    const store = await makeStore();
    const job = await systemDb.syncJob.create({ data: { workspaceId: store.workspaceId, storeId: store.id, kind: "shop" } });
    fetchImpl = async () => new Response("", { status: 401 });
    const bad = message({ storeId: store.id, kind: "shop", syncJobId: job.id }, 1);
    await consume("sync", bad.msg, deps);
    expect(bad.m).toMatchObject({ acked: true, retried: undefined });
    expect((await systemDb.syncJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("failed");

    const ok = message({ storeId: store.id, days: ["2026-01-01"] }, 1);
    await consume("aggregate", ok.msg, deps);
    expect(ok.m.acked).toBe(true);
  });

  it("has the next reconcile recompute the days of an aggregate job that gave up", async () => {
    // Before: the message was acked after a log line, and the reconcile only repairs days with no
    // totals at all, so days that already had (now wrong) totals stayed wrong for good.
    const store = await systemDb.store.update({ where: { id: (await makeStore(["read_orders"], "UTC")).id }, data: { status: "active" } });
    // A day Postgres refuses (a NUL byte) makes the recompute fail every time.
    const days = ["2026-03-01", "2026-03-02\u0000"];
    const last = message({ storeId: store.id, days }, MAX_ATTEMPTS);
    await consume("aggregate", last.msg, deps);
    expect(last.m.acked).toBe(true);

    await scheduleReconcile(deps);
    expect(queues.sent.aggregate.filter((a) => a.storeId === store.id).flatMap((a) => a.days).sort()).toEqual([...days].sort());
    // Handed over once: a later reconcile doesn't repeat them.
    queues.clear();
    coord.release(`reconcile:${store.id}`);
    await scheduleReconcile(deps);
    expect(queues.sent.aggregate).toEqual([]);
  });

  it("reads large webhook payloads from blob storage and deletes them after processing", async () => {
    const store = await makeStore();
    const ev = await systemDb.webhookEvent.create({ data: { webhookId: "big", topic: "orders/create", shopDomain: "s.myshopify.com" } });
    await payloads.put("webhooks/big.json", JSON.stringify(order()));
    const m = message({ eventId: ev.id, topic: "orders/create", shop: "s.myshopify.com", payloadKey: "webhooks/big.json" }, 1);
    await consume("webhooks", m.msg, deps);
    expect(m.m.acked).toBe(true);
    expect(await systemDb.order.count({ where: { storeId: store.id } })).toBe(1);
    expect(payloads.data.size).toBe(0);
  });

  it("deletes the blob of a webhook copy that finds its event already processed", async () => {
    await makeStore();
    // Intake re-queued the delivery under its own blob, and the other copy got there first.
    const ev = await systemDb.webhookEvent.create({ data: { webhookId: "big2", topic: "orders/create", shopDomain: "s.myshopify.com", status: "succeeded", attempts: 1 } });
    await payloads.put("webhooks/copy.json", JSON.stringify(order()));
    const m = message({ eventId: ev.id, topic: "orders/create", shop: "s.myshopify.com", payloadKey: "webhooks/copy.json" }, 1);
    await consume("webhooks", m.msg, deps);
    expect(m.m.acked).toBe(true);
    expect(payloads.data.size).toBe(0);
  });

  /**
   * A "Postgres" that accepts connections and drops them at once - what the worker sees while the
   * tunnel is down ("Connection terminated unexpectedly"). `stallMs` instead says nothing for that
   * long before dropping, like a link that hangs.
   */
  async function deadDb(stallMs = 0) {
    const sockets = new Set<Socket>();
    const server = createServer((s) => {
      sockets.add(s);
      setTimeout(() => s.destroy(), stallMs);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    return {
      run: <T>(fn: () => Promise<T>) => withDb({ system: `postgresql://app:app@127.0.0.1:${port}/outage_test` }, fn),
      close: () =>
        new Promise<void>((r) => {
          for (const s of sockets) s.destroy();
          server.close(() => r());
        }),
    };
  }

  it("probes the database: up, dropping connections, or stalled past the timeout", async () => {
    expect(await dbReachable()).toBe(true);
    const dropped = await deadDb();
    const stalled = await deadDb(1_500);
    try {
      expect(await dropped.run(() => dbReachable())).toBe(false);
      let elapsed = 0;
      const ok = await stalled.run(async () => {
        const started = Date.now();
        const r = await dbReachable(200);
        elapsed = Date.now() - started;
        return r;
      });
      expect(ok).toBe(false);
      expect(elapsed).toBeLessThan(1_000); // gave up on its own, before the link did
    } finally {
      await Promise.all([dropped.close(), stalled.close()]);
    }
  });

  it("defers a job that fails while the database is down, spending no attempts and recording nothing", async () => {
    const store = await makeStore();
    const job = await makeJob(store, "shop");
    const body = { storeId: store.id, kind: "shop", syncJobId: job.id };
    const db = await deadDb();
    try {
      // The last attempt. This used to be final: onFailure could not write either, so the
      // message was acked and lost with nothing recorded.
      const last = message(body, MAX_ATTEMPTS);
      await db.run(() => consume("sync", last.msg, deps));
      expect(last.m).toMatchObject({ acked: true, retried: undefined });
      expect(queues.sent.sync).toEqual([{ ...body, dbDeferral: { count: 1, since: expect.any(Number) } }]);
      expect(queues.sentOpts.sync).toEqual([{ delaySeconds: 30 }]);

      // The copy arrives as a new message (attempts back to 1) and the database is still down:
      // re-sent again, further out, still counting from the first deferral.
      const copy = queues.sent.sync[0] as unknown as typeof body & { dbDeferral: { count: number; since: number } };
      queues.clear();
      const again = message(copy, 1);
      await db.run(() => consume("sync", again.msg, deps));
      expect(again.m).toMatchObject({ acked: true, retried: undefined });
      expect(queues.sent.sync).toEqual([{ ...body, dbDeferral: { count: 2, since: copy.dbDeferral.since } }]);
      expect(queues.sentOpts.sync).toEqual([{ delaySeconds: 60 }]);
      queues.clear();

      // Waited a day already: retried normally, so it ends up in the dead-letter queue.
      const stale = message({ ...body, dbDeferral: { count: 290, since: Date.now() - 25 * 3600_000 } }, 1);
      await db.run(() => consume("sync", stale.msg, deps));
      expect(stale.m).toMatchObject({ acked: false, retried: { delaySeconds: 5 } });
      expect(queues.sent.sync).toEqual([]);

      // The re-send itself failed: keep the original rather than ack it.
      const unsent = message(body, 1);
      const brokenQueues = { ...queues, sync: { send: async () => Promise.reject(new Error("queue unavailable")) } };
      await db.run(() => consume("sync", unsent.msg, { ...deps, queues: brokenQueues }));
      expect(unsent.m).toMatchObject({ acked: false, retried: { delaySeconds: 60 } });
    } finally {
      await db.close();
    }
    expect((await systemDb.syncJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("queued");
    expect((await systemDb.store.findUniqueOrThrow({ where: { id: store.id } })).status).toBe("syncing");
    expect(await systemDb.alert.count()).toBe(0);
    expect(mailer.sent).toEqual([]);
  });

  it("does not carry a deferral into the messages a job sends on", async () => {
    const store = await makeStore();
    const job = await makeJob(store, "products");
    fetchImpl = async () =>
      gqlJson({
        products: {
          pageInfo: { hasNextPage: true, endCursor: "p1" },
          nodes: [{ id: "gid://shopify/Product/8", title: "Tee", status: "ACTIVE", vendor: "Acme", productType: "Shirts", createdAt: "2025-06-01T00:00:00Z", updatedAt: "2026-03-01T00:00:00Z" }],
        },
      });
    const m = message({ storeId: store.id, kind: "products", syncJobId: job.id, dbDeferral: { count: 3, since: Date.now() - 600_000 } }, 1);
    await consume("sync", m.msg, deps);
    expect(m.m.acked).toBe(true);
    // The next page is a fresh message: its own outage, if any, starts its own clock.
    expect(queues.sent.sync).toEqual([{ storeId: store.id, kind: "products", syncJobId: job.id, cursor: "p1", progress: 1 }]);
  });

  it("retries instead of acking when a final failure cannot be recorded", async () => {
    const store = await makeStore();
    const job = await makeJob(store, "shop");
    const db = await deadDb();
    const last = message({ storeId: store.id, kind: "shop", syncJobId: job.id }, MAX_ATTEMPTS);
    try {
      // The database answered the probe, then was gone again by the time onFailure wrote.
      await db.run(() => consume("sync", last.msg, { ...deps, dbHealthy: async () => true }));
    } finally {
      await db.close();
    }
    // Past maxReceiveCount SQS moves it to the dead-letter queue; acking would have dropped it.
    expect(last.m.acked).toBe(false);
    expect(last.m.retried).toBeDefined();
    expect(queues.sent.sync).toEqual([]);
  });
});

describe("transactions over the tunnel", () => {
  it("are not expired at Prisma's 5s default", async () => {
    // writeOrderBatch's 400-order transactions have run past 5s on the hotspot link and been
    // rolled back ("7247 ms passed since the start of the transaction"), costing a queue attempt.
    const n = await systemDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_sleep(5.2)`;
      return tx.workspace.count();
    });
    expect(n).toBe(0);
  });
});

// ---------------------------------------------------------------- data pipeline (orders, catalog, stock)

type GqlBody = { query: string; variables: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
const gqlBody = (init?: RequestInit) => JSON.parse(String(init?.body)) as GqlBody;
const gqlJson = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
const money = (amount: string) => ({ shopMoney: { amount } });
const costExceeded = () =>
  new Response(
    JSON.stringify({ errors: [{ message: "Query cost is 2003, which exceeds the single query max cost limit (1000).", extensions: { code: "MAX_COST_EXCEEDED" } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const gLine = (id: number, over: Record<string, unknown> = {}) => ({
  id: `gid://shopify/LineItem/${id}`,
  title: `Item ${id}`,
  quantity: 1,
  sku: `SKU-${id}`,
  variant: { id: `gid://shopify/ProductVariant/${id + 500}` },
  product: { id: "gid://shopify/Product/8" },
  originalUnitPriceSet: money("10.00"),
  totalDiscountSet: money("0"),
  ...over,
});
const gRefundLines = (count: number, amount = "1.00") => Array.from({ length: count }, () => ({ subtotalSet: money(amount) }));
const gOrder = (id: number, over: Record<string, unknown> = {}) => ({
  id: `gid://shopify/Order/${id}`,
  name: `#${id}`,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  cancelledAt: null,
  currencyCode: "USD",
  displayFinancialStatus: "PAID",
  sourceName: "web",
  displayFulfillmentStatus: "FULFILLED",
  discountCodes: ["SUMMER10"],
  subtotalPriceSet: money("10.00"),
  totalDiscountsSet: money("0"),
  totalTaxSet: money("1.00"),
  totalShippingPriceSet: money("5.00"),
  totalPriceSet: money("16.00"),
  fulfillments: [{ createdAt: "2026-03-02T09:30:00Z" }],
  lineItems: { pageInfo: { hasNextPage: false }, nodes: [gLine(id * 10)] },
  refunds: [],
  ...over,
});
const ordersPage = (nodes: unknown[], hasNextPage = false, endCursor: string | null = null) => ({ orders: { pageInfo: { hasNextPage, endCursor }, nodes } });

async function makeJob(store: { id: string; workspaceId: string }, kind: string) {
  return systemDb.syncJob.create({ data: { workspaceId: store.workspaceId, storeId: store.id, kind } });
}

describe("orders pipeline", () => {
  it("stores channel, fulfillment, discount codes and line-item variants from GraphQL", async () => {
    const store = await makeStore(["read_orders"]);
    const job = await makeJob(store, "orders");
    const calls: GqlBody[] = [];
    fetchImpl = async (_u, init) => {
      calls.push(gqlBody(init));
      return gqlJson(ordersPage([gOrder(1)]));
    };
    await runSync({ storeId: store.id, kind: "orders", syncJobId: job.id, pagedOnly: true }, deps);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.variables).toMatchObject({ first: PAGE_SIZE.orders, cursor: null });
    expect(calls[0]!.variables.query).toMatch(/^created_at:>='/);
    expect(calls[0]!.query).toContain("first: $first");

    const o = await systemDb.order.findFirstOrThrow({ include: { lineItems: true } });
    expect(o).toMatchObject({ sourceName: "web", fulfillmentStatus: "fulfilled", discountCodes: ["SUMMER10"], financialStatus: "paid" });
    expect(o.fulfilledAt?.toISOString()).toBe("2026-03-02T09:30:00.000Z");
    expect(toNumber(o.totalShipping)).toBe(5);
    expect(o.lineItems[0]).toMatchObject({ variantShopifyId: "510", sku: "SKU-10", productShopifyId: "8" });
    expect((await systemDb.syncJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("succeeded");
  });

  it("stores the same fields from REST order webhooks", async () => {
    await makeStore();
    await webhook(
      "orders/create",
      order({
        source_name: "pos",
        fulfillment_status: "partial",
        fulfillments: [{ created_at: "2026-03-03T10:00:00Z" }, { created_at: "2026-03-02T10:00:00Z" }],
        discount_codes: [{ code: "WELCOME", amount: "10.00", type: "fixed_amount" }],
        line_items: [{ id: 1, product_id: 50, variant_id: 501, sku: "TEE-M", title: "Tee", quantity: 2, price: "50.00", total_discount: "10.00" }],
      }),
    );
    const o = await systemDb.order.findFirstOrThrow({ include: { lineItems: true } });
    expect(o).toMatchObject({ sourceName: "pos", fulfillmentStatus: "partially_fulfilled", discountCodes: ["WELCOME"] });
    expect(o.fulfilledAt?.toISOString()).toBe("2026-03-02T10:00:00.000Z");
    expect(o.lineItems[0]).toMatchObject({ variantShopifyId: "501", sku: "TEE-M" });

    // A later update with no fulfillment yet (REST null) maps to "unfulfilled".
    await webhook("orders/updated", order({ updated_at: "2026-03-04T00:00:00Z", fulfillment_status: null, fulfillments: [], discount_codes: [] }));
    expect(await systemDb.order.findFirstOrThrow()).toMatchObject({ fulfillmentStatus: "unfulfilled", fulfilledAt: null, discountCodes: [] });
  });

  it("backfills all history with read_all_orders, else 60 days; reconcile uses updated_at", async () => {
    const now = Date.UTC(2026, 9, 1);
    expect(ordersSearch({}, ["read_orders", "read_all_orders"], now)).toBeNull();
    expect(ordersSearch({}, ["read_orders"], now)).toBe(`created_at:>='${new Date(now - BACKFILL_DAYS * 86400_000).toISOString()}'`);
    expect(ordersSearch({ sinceDays: 3 }, ["read_orders", "read_all_orders"], now)).toBe(`updated_at:>='${new Date(now - 3 * 86400_000).toISOString()}'`);

    const store = await makeStore(["read_orders", "read_all_orders"]);
    const job = await makeJob(store, "orders");
    let vars: Record<string, unknown> = {};
    fetchImpl = async (_u, init) => {
      vars = gqlBody(init).variables;
      return gqlJson(ordersPage([gOrder(1, { createdAt: "2019-05-01T00:00:00Z", updatedAt: "2019-05-01T00:00:00Z" })]));
    };
    await runSync({ storeId: store.id, kind: "orders", syncJobId: job.id, pagedOnly: true }, deps);
    expect(vars).toMatchObject({ query: null });
    expect((await systemDb.order.findFirstOrThrow()).localDay).toBe("2019-04-30"); // New York
    expect((await systemDb.store.findUniqueOrThrow({ where: { id: store.id } })).status).toBe("active");
  });

  it("halves the page size and re-enqueues the same page when Shopify reports MAX_COST_EXCEEDED", async () => {
    const store = await makeStore(["read_orders"]);
    const job = await makeJob(store, "orders");
    const firsts: number[] = [];
    fetchImpl = async (_u, init) => {
      const { variables } = gqlBody(init);
      firsts.push(variables.first);
      expect(variables.cursor).toBe("c5");
      return variables.first > 3 ? costExceeded() : gqlJson(ordersPage([gOrder(1), gOrder(2)]));
    };
    const msg = { storeId: store.id, kind: "orders" as const, syncJobId: job.id, pagedOnly: true, cursor: "c5", progress: 14 };
    expect(await runSync(msg, deps)).toMatchObject({ ok: true, continued: true });
    expect(queues.sent.sync).toEqual([{ ...msg, pageSize: 3 }]); // same cursor and progress
    expect(await systemDb.order.count()).toBe(0);

    await runSync(queues.sent.sync.pop()!, deps);
    expect(firsts).toEqual([7, 3]);
    expect(await systemDb.order.count()).toBe(2);
    const done = await systemDb.syncJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(done).toMatchObject({ status: "succeeded", progress: 16 });
  });

  it("fails at once, with a plain explanation, when Shopify withholds the orders", async () => {
    const store = await makeStore(["read_orders"]);
    const job = await makeJob(store, "orders");
    fetchImpl = async () =>
      new Response(JSON.stringify({ data: { orders: null }, errors: [{ message: "This app is not approved to access the Order object.", extensions: { code: "ACCESS_DENIED" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    await expect(runSync({ storeId: store.id, kind: "orders", syncJobId: job.id, pagedOnly: true }, deps)).rejects.toThrow(/withheld orders.*protected customer data/);
  });

  it("fails (no endless halving) when even one item per page is too expensive", async () => {
    const store = await makeStore();
    const job = await makeJob(store, "variants");
    const firsts: number[] = [];
    fetchImpl = async (_u, init) => {
      firsts.push(gqlBody(init).variables.first);
      return costExceeded();
    };
    await runSync({ storeId: store.id, kind: "variants", syncJobId: job.id }, deps);
    expect(queues.sent.sync[0]).toMatchObject({ kind: "variants", pageSize: 50 });
    await expect(runSync({ storeId: store.id, kind: "variants", syncJobId: job.id, pageSize: 1 }, deps)).rejects.toMatchObject({ name: "UnrecoverableError" });
    expect(firsts).toEqual([PAGE_SIZE.variants, 1]);
  });

  it("fetches full line items and refunds for orders that overflow the page", async () => {
    const store = await makeStore(["read_orders"]);
    const job = await makeJob(store, "orders");
    const big = gOrder(1, {
      lineItems: { pageInfo: { hasNextPage: true }, nodes: Array.from({ length: 10 }, (_, i) => gLine(100 + i)) },
      refunds: [
        { id: "gid://shopify/Refund/71", createdAt: "2026-03-05T00:00:00Z", refundLineItems: { pageInfo: { hasNextPage: true }, nodes: gRefundLines(5) } },
        { id: "gid://shopify/Refund/72", createdAt: "2026-03-06T00:00:00Z", refundLineItems: { pageInfo: { hasNextPage: false }, nodes: gRefundLines(1, "4.00") } },
      ],
    });
    const small = gOrder(2);
    const seen: string[] = [];
    fetchImpl = async (_u, init) => {
      const { query, variables } = gqlBody(init);
      if (query.includes("query OrderLineItems")) {
        seen.push(`lines:${variables.id}:${variables.cursor}`);
        return variables.cursor === null
          ? gqlJson({ order: { lineItems: { pageInfo: { hasNextPage: true, endCursor: "L1" }, nodes: Array.from({ length: 12 }, (_, i) => gLine(100 + i)) } } })
          : gqlJson({ order: { lineItems: { pageInfo: { hasNextPage: false, endCursor: "L2" }, nodes: [gLine(112), gLine(113), gLine(114)] } } });
      }
      if (query.includes("query OrderRefunds")) {
        seen.push(`refunds:${variables.id}`);
        return gqlJson({
          order: {
            refunds: [
              { id: "gid://shopify/Refund/71", createdAt: "2026-03-05T00:00:00Z", refundLineItems: { pageInfo: { hasNextPage: true, endCursor: "R1" }, nodes: gRefundLines(25) } },
              { id: "gid://shopify/Refund/72", createdAt: "2026-03-06T00:00:00Z", refundLineItems: { pageInfo: { hasNextPage: false, endCursor: "R9" }, nodes: gRefundLines(1, "4.00") } },
            ],
          },
        });
      }
      if (query.includes("query RefundLineItems")) {
        seen.push(`refundLines:${variables.id}:${variables.cursor}`);
        return gqlJson({ refund: { refundLineItems: { pageInfo: { hasNextPage: false, endCursor: "R2" }, nodes: gRefundLines(2) } } });
      }
      seen.push("orders");
      return gqlJson(ordersPage([big, small]));
    };
    await runSync({ storeId: store.id, kind: "orders", syncJobId: job.id, pagedOnly: true }, deps);

    // Only the overflowing order triggers detail queries.
    expect(seen).toEqual([
      "orders",
      "lines:gid://shopify/Order/1:null",
      "lines:gid://shopify/Order/1:L1",
      "refunds:gid://shopify/Order/1",
      "refundLines:gid://shopify/Refund/71:R1",
    ]);
    const o1 = await systemDb.order.findFirstOrThrow({ where: { shopifyId: "1" }, include: { lineItems: true, refunds: true } });
    expect(o1.lineItems).toHaveLength(15);
    const refunds = Object.fromEntries(o1.refunds.map((r) => [r.shopifyId, toNumber(r.lineSubtotal)]));
    expect(refunds).toEqual({ "71": 27, "72": 4 }); // 25 + 2 lines × 1.00; 1 × 4.00
    expect(await systemDb.orderLineItem.count({ where: { order: { shopifyId: "2" } } })).toBe(1);
  });
});

describe("catalog and stock pipeline", () => {
  const gVariant = (id: number, over: Record<string, unknown> = {}) => ({
    id: `gid://shopify/ProductVariant/${id}`,
    title: `V${id}`,
    sku: `SKU-${id}`,
    price: "25.00",
    inventoryQuantity: 4,
    updatedAt: "2026-03-01T00:00:00Z",
    product: { id: "gid://shopify/Product/8" },
    inventoryItem: { tracked: true, unitCost: { amount: "9.50" } },
    ...over,
  });
  const restProduct = (over: Record<string, unknown> = {}) => ({
    id: 8,
    title: "Tee",
    status: "active",
    vendor: "Acme",
    product_type: "Shirts",
    created_at: "2025-06-01T00:00:00Z",
    updated_at: "2026-03-02T00:00:00Z",
    variants: [
      { id: 70, product_id: 8, title: "M", sku: "TEE-M", price: "25.00", inventory_quantity: 3, inventory_management: "shopify", updated_at: "2026-03-02T00:00:00Z" },
      { id: 71, product_id: 8, title: "L", sku: "TEE-L", price: "26.00", inventory_quantity: 0, inventory_management: null, updated_at: "2026-03-02T00:00:00Z" },
    ],
    ...over,
  });

  it("syncs products with vendor, type and creation date", async () => {
    const store = await makeStore();
    const job = await makeJob(store, "products");
    let vars: Record<string, unknown> = {};
    fetchImpl = async (_u, init) => {
      vars = gqlBody(init).variables;
      return gqlJson({
        products: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{ id: "gid://shopify/Product/8", title: "Tee", status: "ACTIVE", vendor: "Acme", productType: "Shirts", createdAt: "2025-06-01T00:00:00Z", updatedAt: "2026-03-01T00:00:00Z" }],
        },
      });
    };
    await runSync({ storeId: store.id, kind: "products", syncJobId: job.id }, deps);
    expect(vars).toMatchObject({ first: PAGE_SIZE.products, cursor: null });
    const p = await systemDb.product.findFirstOrThrow();
    expect(p).toMatchObject({ shopifyId: "8", status: "active", vendor: "Acme", productType: "Shirts" });
    expect(p.shopifyCreatedAt?.toISOString()).toBe("2025-06-01T00:00:00.000Z");
  });

  it("syncs variants page by page with price, stock and unit cost", async () => {
    const store = await makeStore();
    const job = await makeJob(store, "variants");
    const calls: GqlBody[] = [];
    fetchImpl = async (_u, init) => {
      const body = gqlBody(init);
      calls.push(body);
      return body.variables.cursor === null
        ? gqlJson({ productVariants: { pageInfo: { hasNextPage: true, endCursor: "v1" }, nodes: [gVariant(70), gVariant(71, { inventoryItem: { tracked: false, unitCost: null } })] } })
        : gqlJson({ productVariants: { pageInfo: { hasNextPage: false, endCursor: "v2" }, nodes: [gVariant(72, { sku: "", inventoryItem: null, inventoryQuantity: 0 })] } });
    };
    await runSync({ storeId: store.id, kind: "variants", syncJobId: job.id }, deps);
    expect(calls[0]!.query).toContain("productVariants(first: $first");
    expect(calls[0]!.variables).toMatchObject({ first: PAGE_SIZE.variants });
    expect(queues.sent.sync).toEqual([{ storeId: store.id, kind: "variants", syncJobId: job.id, cursor: "v1", progress: 2 }]);
    await runSync(queues.sent.sync.pop()!, deps);

    const rows = await systemDb.productVariant.findMany({ orderBy: { shopifyId: "asc" } });
    expect(rows.map((r) => [r.shopifyId, r.productShopifyId, r.sku, toNumber(r.price), r.inventoryQuantity, r.unitCost === null ? null : toNumber(r.unitCost)])).toEqual([
      ["70", "8", "SKU-70", 25, 4, 9.5],
      ["71", "8", "SKU-71", 25, null, null], // not tracked; no cost
      ["72", "8", null, 25, 0, null], // inventoryItem withheld: cost unknown
    ]);
    expect(rows.every((r) => r.workspaceId === store.workspaceId && r.storeId === store.id)).toBe(true);
    expect(await systemDb.syncJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "succeeded", progress: 3 });
  });

  it("products webhooks upsert the product and its variants, keep known costs, prune and delete", async () => {
    const store = await makeStore();
    // GraphQL sync knows the cost of variant 70.
    const job = await makeJob(store, "variants");
    fetchImpl = async () => gqlJson({ productVariants: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [gVariant(70, { inventoryQuantity: 9 })] } });
    await runSync({ storeId: store.id, kind: "variants", syncJobId: job.id }, deps);

    await webhook("products/create", restProduct());
    const p = await systemDb.product.findFirstOrThrow();
    expect(p).toMatchObject({ title: "Tee", status: "active", vendor: "Acme", productType: "Shirts" });
    expect(p.shopifyCreatedAt?.toISOString()).toBe("2025-06-01T00:00:00.000Z");
    const v70 = await systemDb.productVariant.findFirstOrThrow({ where: { shopifyId: "70" } });
    expect(v70.inventoryQuantity).toBe(3); // stock from the webhook
    expect(toNumber(v70.unitCost)).toBe(9.5); // cost kept (REST payloads carry none)
    const v71 = await systemDb.productVariant.findFirstOrThrow({ where: { shopifyId: "71" } });
    expect(v71).toMatchObject({ inventoryQuantity: null, unitCost: null, title: "L" });

    // Variant 71 deleted in Shopify: the next (complete) payload no longer lists it.
    const [first] = restProduct().variants;
    await webhook("products/update", restProduct({ updated_at: "2026-03-03T00:00:00Z", variants: [{ ...first, inventory_quantity: 2, updated_at: "2026-03-03T00:00:00Z" }] }));
    expect((await systemDb.productVariant.findMany()).map((v) => [v.shopifyId, v.inventoryQuantity])).toEqual([["70", 2]]);

    // A stale (out-of-order) payload changes nothing and does not resurrect 71.
    await webhook("products/update", restProduct({ title: "Old", updated_at: "2026-03-02T12:00:00Z" }));
    expect((await systemDb.product.findFirstOrThrow()).title).toBe("Tee");
    expect((await systemDb.productVariant.findMany()).map((v) => [v.shopifyId, v.inventoryQuantity])).toEqual([["70", 2]]);

    await webhook("products/delete", { id: 8 });
    expect(await systemDb.product.count()).toBe(0);
    expect(await systemDb.productVariant.count()).toBe(0);
  });

  it("keeps the newer copy when two deliveries of one product are processed at the same time", async () => {
    // Before: each write checked staleness first and wrote second, so the older copy could commit last.
    await makeStore();
    const [v70] = restProduct().variants;
    const newer = restProduct({ title: "New", updated_at: "2026-03-05T00:00:00Z", variants: [{ ...v70, inventory_quantity: 9, updated_at: "2026-03-05T00:00:00Z" }] });
    const older = restProduct({ title: "Old", updated_at: "2026-03-04T00:00:00Z", variants: [{ ...v70, inventory_quantity: 1, updated_at: "2026-03-04T00:00:00Z" }] });
    for (let i = 0; i < 8; i++) {
      await systemDb.product.deleteMany();
      await systemDb.productVariant.deleteMany();
      await Promise.all(i % 2 ? [webhook("products/update", newer), webhook("products/update", older)] : [webhook("products/update", older), webhook("products/update", newer)]);
      expect((await systemDb.product.findFirstOrThrow()).title).toBe("New");
      expect((await systemDb.productVariant.findFirstOrThrow({ where: { shopifyId: "70" } })).inventoryQuantity).toBe(9);
    }
  });

  it("keeps untracked variants untracked when a webhook (API 2024-07+) doesn't say", async () => {
    const store = await makeStore();
    const job = await makeJob(store, "variants");
    fetchImpl = async () =>
      gqlJson({ productVariants: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [gVariant(70, { inventoryItem: { tracked: false, unitCost: null } })] } });
    await runSync({ storeId: store.id, kind: "variants", syncJobId: job.id }, deps);
    expect((await systemDb.productVariant.findFirstOrThrow({ where: { shopifyId: "70" } })).inventoryQuantity).toBeNull();

    // Current payloads carry inventory_quantity but no inventory_management.
    const strip = ({ inventory_management: _drop, ...v }: Record<string, unknown>) => v;
    const [v70, v71] = restProduct().variants.map(strip);
    await webhook("products/update", restProduct({ variants: [{ ...v70, inventory_quantity: 0 }, v71] }));
    // Known-untracked stays untracked; a variant we didn't know yet is assumed tracked.
    expect((await systemDb.productVariant.findFirstOrThrow({ where: { shopifyId: "70" } })).inventoryQuantity).toBeNull();
    expect((await systemDb.productVariant.findFirstOrThrow({ where: { shopifyId: "71" } })).inventoryQuantity).toBe(0);
  });

  it("prunes deleted variants of large products using variant_gids", async () => {
    const store = await makeStore();
    const ids = Array.from({ length: 101 }, (_, i) => 1000 + i);
    const job = await makeJob(store, "variants");
    fetchImpl = async () => gqlJson({ productVariants: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: ids.map((id) => gVariant(id)) } });
    await runSync({ storeId: store.id, kind: "variants", syncJobId: job.id }, deps);
    expect(await systemDb.productVariant.count()).toBe(101);

    // Variant 1050 deleted: variants[] still holds 100 entries (Shopify's cap), variant_gids lists all that remain.
    const remaining = ids.filter((id) => id !== 1050);
    const rest = (id: number) => ({ id, product_id: 8, title: `V${id}`, sku: `SKU-${id}`, price: "25.00", inventory_quantity: 4, updated_at: "2026-03-05T00:00:00Z" });
    await webhook(
      "products/update",
      restProduct({
        updated_at: "2026-03-05T00:00:00Z",
        variants: remaining.slice(0, 100).map(rest),
        variant_gids: remaining.map((id) => ({ admin_graphql_api_id: `gid://shopify/ProductVariant/${id}`, updated_at: "2026-03-05T00:00:00Z" })),
      }),
    );
    expect(await systemDb.productVariant.count()).toBe(100);
    expect(await systemDb.productVariant.count({ where: { shopifyId: "1050" } })).toBe(0);
  });

  it("a late update after products/delete doesn't bring the product back", async () => {
    await makeStore();
    await webhook("products/create", restProduct());
    await webhook("products/delete", { id: 8 });
    await webhook("products/update", restProduct({ title: "Retried", updated_at: "2026-03-09T00:00:00Z" }));
    expect(await systemDb.product.count()).toBe(0);
    expect(await systemDb.productVariant.count()).toBe(0);
  });

  it("shop/redact purges variants with the rest of the store data", async () => {
    await makeStore();
    await webhook("products/create", restProduct());
    await webhook("orders/create", order());
    expect(await systemDb.productVariant.count()).toBe(2);
    await webhook("app/uninstalled", {});
    await webhook("shop/redact", { shop_domain: "s.myshopify.com" });
    expect(await systemDb.productVariant.count()).toBe(0);
    expect(await systemDb.product.count()).toBe(0);
    expect(await systemDb.order.count()).toBe(0);
  });
});

describe("daily reconcile", () => {
  const emptyOrders = async () => gqlJson({ orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } });

  it("a reconcile finishing on a store whose backfill failed doesn't mark it fully synced", async () => {
    const store = await makeStore(["read_orders"]);
    await systemDb.store.update({ where: { id: store.id }, data: { status: "error", lastSyncedAt: null } });
    fetchImpl = emptyOrders;
    const job = await makeJob(store, "orders");
    await runSync({ storeId: store.id, kind: "orders", syncJobId: job.id, sinceDays: RECONCILE_ORDER_DAYS }, deps);
    const after = await systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(after.lastSyncedAt).toBeNull();
    expect(after.status).toBe("error");

    // A store that had completed its backfill is refreshed as before.
    const synced = new Date("2026-03-01T00:00:00Z");
    await systemDb.store.update({ where: { id: store.id }, data: { status: "active", lastSyncedAt: synced } });
    const job2 = await makeJob(store, "orders");
    await runSync({ storeId: store.id, kind: "orders", syncJobId: job2.id, sinceDays: RECONCILE_ORDER_DAYS }, deps);
    expect((await systemDb.store.findUniqueOrThrow({ where: { id: store.id } })).lastSyncedAt!.getTime()).toBeGreaterThan(synced.getTime());
  });

  it("re-pulls recent orders everywhere and the catalog + stock where products are readable", async () => {
    const withProducts = await makeStore(["read_orders", "read_products"], "UTC", "a.myshopify.com");
    const ordersOnly = await makeStore(["read_orders"], "UTC", "b.myshopify.com");
    await makeStore(["read_orders", "read_products"], "UTC", "c.myshopify.com"); // still "syncing": skipped
    await systemDb.store.updateMany({ where: { id: { in: [withProducts.id, ordersOnly.id] } }, data: { status: "active" } });

    expect(await scheduleReconcile(deps)).toBe(2);
    const sent = queues.sent.sync.map((j) => `${j.storeId === withProducts.id ? "a" : "b"}:${j.kind}:${j.sinceDays ?? "-"}`).sort();
    expect(sent).toEqual(["a:orders:3", "a:products:-", "a:variants:-", "b:orders:3"]);
    expect(RECONCILE_ORDER_DAYS).toBe(3);
    // Every message has its own job row (visible as sync progress).
    const jobs = await systemDb.syncJob.findMany({ where: { id: { in: queues.sent.sync.map((j) => j.syncJobId) } } });
    expect(jobs).toHaveLength(4);
    expect(jobs.every((j) => j.status === "queued")).toBe(true);
  });

  const activeStore = async (shopDomain = "s.myshopify.com") => {
    const store = await makeStore(["read_orders"], "UTC", shopDomain);
    return systemDb.store.update({ where: { id: store.id }, data: { status: "active" } });
  };

  it("runs from the quarter-hour tick too, so a missed 03:15 run is caught up, and never enqueues a store twice", async () => {
    await activeStore();
    // 03:15 came and went with the database unreachable. The first tick that reaches it catches up.
    expect(await runScheduled(CRON.refreshTokens, deps)).toMatchObject({ refreshed: 0, staleJobsFailed: 0, reconciled: 1, adsSynced: 0 });
    expect(queues.sent.sync.map((j) => j.kind)).toEqual(["orders"]);

    // Every later tick finds it done - including the next 03:15, when both triggers fire at once.
    await runScheduled(CRON.refreshTokens, deps);
    await Promise.all([runScheduled(CRON.reconcile, deps), runScheduled(CRON.refreshTokens, deps)]);
    expect(queues.sent.sync).toHaveLength(1);

    // A day on, the lease has lapsed: reconciled again, once, by whichever trigger gets there first.
    coord.clear();
    await Promise.all([runScheduled(CRON.reconcile, deps), runScheduled(CRON.refreshTokens, deps)]);
    expect(queues.sent.sync).toHaveLength(2);
  });

  it("gives a store whose enqueue failed back to the next tick, without repeating the ones already enqueued", async () => {
    const a = await activeStore("a.myshopify.com");
    const b = await activeStore("b.myshopify.com");
    // The run dies at the second store it reaches (the tunnel dropping mid-loop).
    let reached: string | undefined;
    const flaky = {
      ...queues,
      sync: {
        send: async (body: SyncJobData, opts?: { delaySeconds?: number }) => {
          reached ??= body.storeId;
          if (body.storeId !== reached) throw new Error("queue unavailable");
          return queues.sync.send(body, opts);
        },
      },
    };
    await expect(scheduleReconcile({ ...deps, queues: flaky })).rejects.toThrow("queue unavailable");
    expect(queues.sent.sync.map((j) => j.storeId)).toEqual([reached]);

    // The next tick does exactly the store that was missed, and the one after has nothing left.
    expect(await scheduleReconcile(deps)).toBe(1);
    expect(queues.sent.sync.map((j) => j.storeId).sort()).toEqual([a.id, b.id].sort());
    expect(await scheduleReconcile(deps)).toBe(0);
  });

  it("a reconcile failure on the tick holds up neither the token refresh nor the reaper", async () => {
    const store = await activeStore();
    await systemDb.syncJob.create({
      data: { workspaceId: store.workspaceId, storeId: store.id, kind: "products", status: "running", startedAt: new Date(Date.now() - 40 * 60_000) },
    });
    const broken = { ...deps, queues: { ...queues, sync: { send: async () => Promise.reject(new Error("queue unavailable")) } } };
    expect(await runScheduled(CRON.refreshTokens, broken)).toMatchObject({ refreshed: 0, staleJobsFailed: 1, reconciled: null, adsSynced: 0 });
    // Its lease was given back, so the next tick reconciles it.
    expect(await runScheduled(CRON.refreshTokens, deps)).toMatchObject({ reconciled: 1 });
  });

  it("re-pulls orders back past the last successful sweep, so days the reconcile could not run are covered", async () => {
    const now = Date.UTC(2026, 9, 6, 12);
    expect(reconcileOrderDays(null, now)).toBe(RECONCILE_ORDER_DAYS); // no completed backfill
    expect(reconcileOrderDays(new Date(now - 3600_000), now)).toBe(RECONCILE_ORDER_DAYS);
    expect(reconcileOrderDays(new Date(now - 5.5 * 86400_000), now)).toBe(7);
    // Capped where the search would switch to created_at and miss older orders updated in the gap.
    expect(reconcileOrderDays(new Date(now - 90 * 86400_000), now)).toBe(BACKFILL_DAYS - 1);
    expect(ordersSearch({ sinceDays: BACKFILL_DAYS - 1 }, ["read_orders"], now)).toMatch(/^updated_at:/);

    // The PC was off for five and a half days: three days would have left the first half unseen.
    const store = await activeStore();
    await systemDb.store.update({ where: { id: store.id }, data: { lastSyncedAt: new Date(Date.now() - 5.5 * 86400_000) } });
    await scheduleReconcile(deps);
    expect(queues.sent.sync).toEqual([{ storeId: store.id, kind: "orders", syncJobId: expect.any(String), sinceDays: 7 }]);
  });

  it("recomputes days in the backfill window that have orders or refunds but no daily totals", async () => {
    const store = await activeStore();
    const now = Date.now();
    const at = (daysAgo: number) => new Date(now - daysAgo * 86400_000).toISOString();
    const day = (daysAgo: number) => localDay(new Date(now - daysAgo * 86400_000), "UTC");
    const placed = (id: number, daysAgo: number) =>
      webhook(
        "orders/create",
        order({ id, created_at: at(daysAgo), updated_at: at(daysAgo), line_items: [{ id: id * 10, product_id: 50, title: "Tee", quantity: 2, price: "50.00", total_discount: "10.00" }] }),
      );
    await placed(1, 10);
    await drainAggregates();
    // The backfill stored these, then its aggregate messages were lost: no daily totals at all.
    await placed(2, 20);
    await placed(3, 40);
    await webhook("refunds/create", { id: 9, order_id: 3, created_at: at(30), refund_line_items: [{ subtotal: "45.00" }] });
    await placed(4, BACKFILL_DAYS + 30);
    queues.clear();

    await scheduleReconcile(deps);
    expect(queues.sent.aggregate).toEqual([{ storeId: store.id, days: [day(40), day(30), day(20)] }]);
    await drainAggregates();
    const metrics = await systemDb.dailyStoreMetrics.findMany({ where: { storeId: store.id }, orderBy: { day: "asc" } });
    expect(metrics.map((m) => [m.day, m.orders, toNumber(m.grossSales), toNumber(m.refunds)])).toEqual([
      [day(40), 1, 100, 0],
      [day(30), 0, 0, 45],
      [day(20), 1, 100, 0],
      [day(10), 1, 100, 0],
    ]);

    // Repaired, so the next day's reconcile has nothing to recompute.
    coord.clear();
    queues.clear();
    await scheduleReconcile(deps);
    expect(queues.sent.aggregate).toEqual([]);
  });
});

/**
 * The batched catalog writes replace a staleness pre-read plus an upsert per row with one
 * statement, which means the staleness guard moved from TypeScript into SQL and the timestamps
 * now travel as strings through a raw query. Both are easy to get subtly wrong in ways no
 * existing test would notice, so compare the two paths directly rather than asserting either
 * one in isolation.
 */
describe("batched catalog writes match the per-row path", () => {
  const gqlProduct = (id: number, over: Record<string, unknown> = {}) => ({
    id: `gid://shopify/Product/${id}`,
    title: `P${id}`,
    status: "ACTIVE",
    vendor: "Acme",
    productType: "Tee",
    createdAt: "2026-02-01T10:00:00Z",
    updatedAt: "2026-03-01T10:00:00Z",
    ...over,
  });
  const gqlVariant = (id: number, productId: number, over: Record<string, unknown> = {}) => ({
    id: `gid://shopify/ProductVariant/${id}`,
    product: { id: `gid://shopify/Product/${productId}` },
    title: `V${id}`,
    sku: `SKU-${id}`,
    price: "19.99",
    inventoryQuantity: 7,
    inventoryItem: { tracked: true, unitCost: { amount: "4.50" } },
    updatedAt: "2026-03-01T10:00:00Z",
    ...over,
  });

  const scrub = <T extends { id: string }>(rows: T[]) => rows.map(({ id: _id, ...rest }) => rest);

  it("writes the same product and variant rows as upsertProduct / upsertVariant", async () => {
    const bulkStore = await makeStore(["read_products"], "America/New_York", "bulk.myshopify.com");
    const rowStore = await makeStore(["read_products"], "America/New_York", "row.myshopify.com");
    const products = [gqlProduct(1), gqlProduct(2, { vendor: null, status: "DRAFT", createdAt: null })].map(normalizeGraphqlProduct);
    const variants = [gqlVariant(10, 1), gqlVariant(11, 1, { sku: null, inventoryQuantity: null, inventoryItem: { tracked: false, unitCost: null } })].map(
      normalizeGraphqlVariant,
    );

    await bulkUpsertProducts(bulkStore, products);
    await bulkUpsertVariants(bulkStore, variants);
    for (const p of products) await upsertProduct(rowStore, p);
    for (const v of variants) await upsertVariant(rowStore, v);

    const read = async (storeId: string) => ({
      products: scrub(await systemDb.product.findMany({ where: { storeId }, orderBy: { shopifyId: "asc" } })).map((p) => ({ ...p, storeId: null, workspaceId: null })),
      variants: scrub(await systemDb.productVariant.findMany({ where: { storeId }, orderBy: { shopifyId: "asc" } })).map((v) => ({
        ...v,
        storeId: null,
        workspaceId: null,
        price: toNumber(v.price),
        unitCost: v.unitCost === null ? null : toNumber(v.unitCost),
      })),
    });
    expect(await read(bulkStore.id)).toEqual(await read(rowStore.id));
    // And the timestamps really are the UTC instants Shopify sent, not shifted by the session
    // time zone on the way through the raw query.
    const [p1] = await systemDb.product.findMany({ where: { storeId: bulkStore.id }, orderBy: { shopifyId: "asc" } });
    expect(p1!.shopifyUpdatedAt.toISOString()).toBe("2026-03-01T10:00:00.000Z");
    expect(p1!.shopifyCreatedAt!.toISOString()).toBe("2026-02-01T10:00:00.000Z");
  });

  it("keeps the staleness guard: an older page never overwrites a newer row", async () => {
    const store = await makeStore(["read_products"], "America/New_York", "stale.myshopify.com");
    await bulkUpsertProducts(store, [normalizeGraphqlProduct(gqlProduct(1, { title: "New", updatedAt: "2026-03-10T00:00:00Z" }))]);
    await bulkUpsertVariants(store, [normalizeGraphqlVariant(gqlVariant(10, 1, { title: "NewV", updatedAt: "2026-03-10T00:00:00Z" }))]);
    // A page that was in flight while a newer webhook landed.
    await bulkUpsertProducts(store, [normalizeGraphqlProduct(gqlProduct(1, { title: "Old", updatedAt: "2026-03-01T00:00:00Z" }))]);
    await bulkUpsertVariants(store, [normalizeGraphqlVariant(gqlVariant(10, 1, { title: "OldV", updatedAt: "2026-03-01T00:00:00Z" }))]);
    expect((await systemDb.product.findFirstOrThrow({ where: { storeId: store.id } })).title).toBe("New");
    expect((await systemDb.productVariant.findFirstOrThrow({ where: { storeId: store.id } })).title).toBe("NewV");
  });

  it("applies the last of a repeated id rather than failing the statement", async () => {
    const store = await makeStore(["read_products"], "America/New_York", "dupe.myshopify.com");
    await bulkUpsertProducts(store, [gqlProduct(1, { title: "First" }), gqlProduct(1, { title: "Second" })].map(normalizeGraphqlProduct));
    const rows = await systemDb.product.findMany({ where: { storeId: store.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("Second");
  });
});


/**
 * `writeOrderBatch` reimplements `upsertOrder` in SQL so the bulk import can write hundreds of
 * orders per transaction instead of six round trips each. Two things in that translation are
 * easy to get silently wrong - the staleness guard, and timestamps crossing a raw query as
 * strings into `TIMESTAMP(3)` columns that hold UTC - and neither would show up as an error.
 * So assert the two paths against each other rather than against hand-written expectations.
 */
describe("writeOrderBatch matches upsertOrder", () => {
  const gqlOrder = (id: number, over: Record<string, unknown> = {}) => ({
    id: `gid://shopify/Order/${id}`,
    name: `#${id}`,
    createdAt: "2026-03-01T15:00:00Z",
    updatedAt: "2026-03-02T09:00:00Z",
    cancelledAt: null,
    currencyCode: "USD",
    displayFinancialStatus: "PAID",
    sourceName: "web",
    displayFulfillmentStatus: "FULFILLED",
    discountCodes: ["SAVE10"],
    subtotalPriceSet: { shopMoney: { amount: "90.00" } },
    totalDiscountsSet: { shopMoney: { amount: "10.00" } },
    totalTaxSet: { shopMoney: { amount: "5.00" } },
    totalShippingPriceSet: { shopMoney: { amount: "4.00" } },
    totalPriceSet: { shopMoney: { amount: "99.00" } },
    fulfillments: [{ createdAt: "2026-03-02T08:00:00Z" }],
    lineItems: {
      nodes: [
        {
          id: `gid://shopify/LineItem/${id}-1`,
          title: "Tee",
          quantity: 2,
          sku: "TEE-1",
          variant: { id: "gid://shopify/ProductVariant/9" },
          product: { id: "gid://shopify/Product/50" },
          originalUnitPriceSet: { shopMoney: { amount: "50.00" } },
          totalDiscountSet: { shopMoney: { amount: "10.00" } },
        },
      ],
    },
    refunds: [
      {
        id: `gid://shopify/Refund/${id}-1`,
        createdAt: "2026-03-03T12:00:00Z",
        refundLineItems: { nodes: [{ subtotalSet: { shopMoney: { amount: "25.00" } } }] },
      },
    ],
    ...over,
  });

  const readStore = async (storeId: string) => {
    const orders = await systemDb.order.findMany({ where: { storeId }, orderBy: { shopifyId: "asc" } });
    const out = [];
    for (const o of orders) {
      const items = await systemDb.orderLineItem.findMany({ where: { orderId: o.id }, orderBy: { shopifyId: "asc" } });
      const refunds = await systemDb.refund.findMany({ where: { orderId: o.id }, orderBy: { shopifyId: "asc" } });
      out.push({
        shopifyId: o.shopifyId,
        name: o.name,
        currency: o.currency,
        localDay: o.localDay,
        createdAt: o.shopifyCreatedAt.toISOString(),
        updatedAt: o.shopifyUpdatedAt.toISOString(),
        cancelledAt: o.cancelledAt?.toISOString() ?? null,
        financialStatus: o.financialStatus,
        subtotal: toNumber(o.subtotal),
        totalDiscounts: toNumber(o.totalDiscounts),
        totalTax: toNumber(o.totalTax),
        totalShipping: toNumber(o.totalShipping),
        totalPrice: toNumber(o.totalPrice),
        customerKey: o.customerKey,
        sourceName: o.sourceName,
        fulfillmentStatus: o.fulfillmentStatus,
        fulfilledAt: o.fulfilledAt?.toISOString() ?? null,
        discountCodes: o.discountCodes,
        items: items.map((li) => ({
          shopifyId: li.shopifyId,
          productShopifyId: li.productShopifyId,
          variantShopifyId: li.variantShopifyId,
          sku: li.sku,
          title: li.title,
          quantity: li.quantity,
          price: toNumber(li.price),
          discount: toNumber(li.discount),
        })),
        refunds: refunds.map((r) => ({
          shopifyId: r.shopifyId,
          localDay: r.localDay,
          createdAt: r.shopifyCreatedAt.toISOString(),
          lineSubtotal: toNumber(r.lineSubtotal),
        })),
      });
    }
    return out;
  };

  it("writes identical orders, line items and refunds, and the same affected days", async () => {
    const batch = await makeStore(["read_orders", "read_products"], "America/New_York", "batch.myshopify.com");
    const single = await makeStore(["read_orders", "read_products"], "America/New_York", "single.myshopify.com");
    const orders = [gqlOrder(1), gqlOrder(2, { cancelledAt: "2026-03-04T00:00:00Z", discountCodes: [], refunds: [] })].map(normalizeGraphqlOrder);

    const batchDays = await writeOrderBatch(batch, orders);
    const singleDays = new Set<string>();
    for (const o of orders) for (const d of await upsertOrder(single, o)) singleDays.add(d);

    expect(await readStore(batch.id)).toEqual(await readStore(single.id));
    expect([...batchDays].sort()).toEqual([...singleDays].sort());
    // Created 15:00Z on 1 Mar is still 1 Mar in New York; the refund on 3 Mar is its own day.
    expect([...batchDays].sort()).toEqual(["2026-03-01", "2026-03-03"]);
  });

  it("produces the same daily aggregates as the per-order path", async () => {
    const batch = await makeStore(["read_orders"], "America/New_York", "aggb.myshopify.com");
    const single = await makeStore(["read_orders"], "America/New_York", "aggs.myshopify.com");
    const orders = [gqlOrder(1), gqlOrder(2)].map(normalizeGraphqlOrder);
    await recomputeDays(batch, [...(await writeOrderBatch(batch, orders))]);
    const days = new Set<string>();
    for (const o of orders) for (const d of await upsertOrder(single, o)) days.add(d);
    await recomputeDays(single, [...days]);

    const strip = (rows: Array<Record<string, unknown>>) => rows.map(({ storeId: _s, workspaceId: _w, ...r }) => r);
    expect(strip(await systemDb.dailyStoreMetrics.findMany({ where: { storeId: batch.id }, orderBy: { day: "asc" } }))).toEqual(
      strip(await systemDb.dailyStoreMetrics.findMany({ where: { storeId: single.id }, orderBy: { day: "asc" } })),
    );
  });

  it("keeps the staleness guard, and leaves a newer order's line items untouched", async () => {
    const store = await makeStore(["read_orders"], "America/New_York", "ostale.myshopify.com");
    await writeOrderBatch(store, [normalizeGraphqlOrder(gqlOrder(1, { name: "#new", updatedAt: "2026-03-10T00:00:00Z" }))]);
    // An import page that was in flight while a newer webhook landed: it must change nothing,
    // including not deleting and reinserting the line items it thinks it owns.
    await writeOrderBatch(
      store,
      [normalizeGraphqlOrder(gqlOrder(1, { name: "#old", updatedAt: "2026-03-01T00:00:00Z", lineItems: { nodes: [] } }))],
    );
    const o = await systemDb.order.findFirstOrThrow({ where: { storeId: store.id } });
    expect(o.name).toBe("#new");
    expect(await systemDb.orderLineItem.count({ where: { orderId: o.id } })).toBe(1);
  });

  it("replaces line items wholesale when the order is newer", async () => {
    const store = await makeStore(["read_orders"], "America/New_York", "orepl.myshopify.com");
    await writeOrderBatch(store, [normalizeGraphqlOrder(gqlOrder(1))]);
    await writeOrderBatch(store, [
      normalizeGraphqlOrder(
        gqlOrder(1, {
          updatedAt: "2026-03-20T00:00:00Z",
          lineItems: {
            nodes: [
              {
                id: "gid://shopify/LineItem/2",
                title: "Mug",
                quantity: 1,
                sku: null,
                variant: null,
                product: null,
                originalUnitPriceSet: { shopMoney: { amount: "8.00" } },
                totalDiscountSet: { shopMoney: { amount: "0" } },
              },
            ],
          },
        }),
      ),
    ]);
    const items = await systemDb.orderLineItem.findMany({ where: { storeId: store.id } });
    expect(items.map((i) => i.title)).toEqual(["Mug"]);
  });

  it("is idempotent: writing the same batch twice changes nothing", async () => {
    const store = await makeStore(["read_orders"], "America/New_York", "oidem.myshopify.com");
    const orders = [gqlOrder(1), gqlOrder(2)].map(normalizeGraphqlOrder);
    await writeOrderBatch(store, orders);
    const before = await readStore(store.id);
    await writeOrderBatch(store, orders);
    expect(await readStore(store.id)).toEqual(before);
    expect(await systemDb.orderLineItem.count({ where: { storeId: store.id } })).toBe(2);
    expect(await systemDb.refund.count({ where: { storeId: store.id } })).toBe(2);
  });
});


/**
 * The bulk backfill. Shopify runs the query server-side and returns a JSONL file, so the parts
 * worth testing are the ones we own: adopting or submitting the operation, polling without
 * sleeping, reading the file in resumable chunks without ever splitting an order, and falling
 * back to the paged path rather than failing whenever any of that does not work out.
 */
describe("bulk order backfill", () => {
  const BULK_ID = "gid://shopify/BulkOperation/1";

  const jsonl = (orders: Array<{ id: number; items?: number[]; refund?: boolean }>) => {
    const lines: string[] = [];
    for (const o of orders) {
      const gid = `gid://shopify/Order/${o.id}`;
      lines.push(
        JSON.stringify({
          id: gid,
          name: `#${o.id}`,
          createdAt: "2026-03-01T15:00:00Z",
          updatedAt: "2026-03-01T15:00:00Z",
          cancelledAt: null,
          currencyCode: "USD",
          displayFinancialStatus: "PAID",
          sourceName: "web",
          displayFulfillmentStatus: "FULFILLED",
          discountCodes: [],
          subtotalPriceSet: money("20"),
          totalDiscountsSet: money("0"),
          totalTaxSet: money("0"),
          totalShippingPriceSet: money("0"),
          totalPriceSet: money("20"),
          fulfillments: [{ createdAt: "2026-03-02T09:30:00Z" }],
          refunds: o.refund
            ? [{ id: `gid://shopify/Refund/${o.id}`, createdAt: "2026-03-03T12:00:00Z", refundLineItems: { edges: [{ node: { subtotalSet: money("5") } }] } }]
            : [],
        }),
      );
      for (const li of o.items ?? [1]) {
        lines.push(
          JSON.stringify({
            id: `gid://shopify/LineItem/${o.id}-${li}`,
            title: "X",
            quantity: 1,
            sku: null,
            variant: null,
            product: null,
            originalUnitPriceSet: money("20"),
            totalDiscountSet: money("0"),
            __parentId: gid,
          }),
        );
      }
    }
    return lines.join("\n") + "\n";
  };

  /**
   * Serves the GraphQL calls and the result file. `body` is the JSONL; range requests are
   * honoured byte-exactly so the chunking logic is really exercised.
   */
  function shopify(opts: { body?: string; status?: string; objectCount?: number; runErrors?: Array<{ message: string }>; current?: unknown }) {
    const body = opts.body ?? "";
    const bytes = new TextEncoder().encode(body);
    const calls: string[] = [];
    fetchImpl = async (url, init) => {
      if (String(url).startsWith("https://files.example/")) {
        const m = /bytes=(\d+)-(\d+)/.exec(String((init?.headers as Record<string, string>)?.Range ?? ""));
        const start = m ? Number(m[1]) : 0;
        const end = Math.min(bytes.length - 1, m ? Number(m[2]) : bytes.length - 1);
        const slice = bytes.slice(start, end + 1);
        return new Response(slice, { status: 206, headers: { "content-range": `bytes ${start}-${end}/${bytes.length}` } });
      }
      const { query, variables } = gqlBody(init);
      if (query.includes("bulkOperationRunQuery")) {
        calls.push("run");
        // The window must be the same one the paged path would have used.
        expect(String(variables.query)).toContain("created_at:>=");
        expect(String(variables.query)).not.toContain("first:");
        return opts.runErrors
          ? gqlJson({ bulkOperationRunQuery: { bulkOperation: null, userErrors: opts.runErrors } })
          : gqlJson({ bulkOperationRunQuery: { bulkOperation: { id: BULK_ID, status: "CREATED" }, userErrors: [] } });
      }
      if (query.includes("currentBulkOperation")) {
        calls.push("current");
        return gqlJson({ currentBulkOperation: opts.current ?? null });
      }
      if (query.includes("bulkOperationCancel")) {
        calls.push("cancel");
        return gqlJson({ bulkOperationCancel: { bulkOperation: { id: BULK_ID, status: "CANCELED" }, userErrors: [] } });
      }
      calls.push("node");
      return gqlJson({
        node: {
          id: BULK_ID,
          status: opts.status ?? "COMPLETED",
          objectCount: String(opts.objectCount ?? 1),
          url: opts.status && opts.status !== "COMPLETED" ? null : "https://files.example/result.jsonl",
          partialDataUrl: null,
          createdAt: new Date().toISOString(),
        },
      });
    };
    return calls;
  }

  /** Run the chain to completion, following whatever each step enqueues. */
  async function drainSync(first: Parameters<typeof runSync>[0], limit = 40) {
    let msg: Parameters<typeof runSync>[0] | undefined = first;
    for (let i = 0; msg && i < limit; i++) {
      await runSync(msg, deps);
      msg = queues.sent.sync.shift();
    }
  }

  it("submits one export, polls without sleeping, ingests it and marks the store active", async () => {
    const store = await makeStore(["read_orders"]);
    const job = await makeJob(store, "orders");
    const calls = shopify({ body: jsonl([{ id: 1, refund: true }, { id: 2 }]), objectCount: 4 });

    await drainSync({ storeId: store.id, kind: "orders", syncJobId: job.id });
    await drainAggregates();

    expect(calls.filter((c) => c === "run")).toHaveLength(1);
    expect(await systemDb.order.count()).toBe(2);
    expect(await systemDb.orderLineItem.count()).toBe(2);
    expect(await systemDb.refund.count()).toBe(1);
    expect((await systemDb.store.findUniqueOrThrow({ where: { id: store.id } })).status).toBe("active");
    const done = await systemDb.syncJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(done).toMatchObject({ status: "succeeded", progress: 2 });
    // The refund landed on its own day, so both days were aggregated.
    expect((await systemDb.dailyStoreMetrics.findMany({ where: { storeId: store.id } })).map((m) => m.day).sort()).toEqual(["2026-03-01", "2026-03-03"]);
  });

  it("polls with a queue delay rather than holding the invocation", async () => {
    const store = await makeStore(["read_orders"]);
    const job = await makeJob(store, "orders");
    shopify({ status: "RUNNING" });
    await runSync({ storeId: store.id, kind: "orders", syncJobId: job.id }, deps); // start
    // Quick first look, then backing off: a small store's export is done in about a second, so a
    // longer first delay is pure waiting added to every import.
    expect(queues.sentOpts.sync.at(-1)).toEqual({ delaySeconds: 1 });
    await runSync(queues.sent.sync.pop()!, deps); // poll, still RUNNING
    expect(queues.sent.sync.at(-1)!.bulk).toMatchObject({ phase: "poll", polls: 1 });
    expect(queues.sentOpts.sync.at(-1)!.delaySeconds).toBeGreaterThan(0);
  });

  it("reads the file in chunks that never split an order, and resumes where it left off", async () => {
    const store = await makeStore(["read_orders"]);
    const job = await makeJob(store, "orders");
    // Three orders with several line items each, so one 300-byte chunk cannot hold them all.
    const body = jsonl([{ id: 1, items: [1, 2, 3] }, { id: 2, items: [1, 2, 3] }, { id: 3, items: [1, 2, 3] }]);
    shopify({ body, objectCount: 12 });

    const offsets: number[] = [];
    let msg: Parameters<typeof runSync>[0] | undefined = { storeId: store.id, kind: "orders", syncJobId: job.id };
    for (let i = 0; msg && i < 40; i++) {
      if (msg.bulk?.phase === "ingest") offsets.push(msg.bulk.byteOffset ?? 0);
      await runSync(msg, deps);
      msg = queues.sent.sync.shift();
    }
    // Every resume point is the first byte of an order line, never mid-order.
    for (const off of offsets.slice(1)) expect(body.slice(off)).toMatch(/^\{"id":"gid:\/\/shopify\/Order\//);
    expect(await systemDb.order.count()).toBe(3);
    expect(await systemDb.orderLineItem.count()).toBe(9);
    expect((await systemDb.syncJob.findUniqueOrThrow({ where: { id: job.id } })).progress).toBe(3);
  });

  it("does not double count when an ingest message is redelivered", async () => {
    const store = await makeStore(["read_orders"]);
    const job = await makeJob(store, "orders");
    shopify({ body: jsonl([{ id: 1 }, { id: 2 }]), objectCount: 4 });
    const ingest = { storeId: store.id, kind: "orders" as const, syncJobId: job.id, bulk: { phase: "ingest" as const, id: BULK_ID, byteOffset: 0 } };
    await runSync(ingest, deps);
    const after = await systemDb.syncJob.findUniqueOrThrow({ where: { id: job.id } });
    await systemDb.syncJob.update({ where: { id: job.id }, data: { status: "running" } }); // undo "succeeded" so it runs again
    await runSync(ingest, deps);
    expect(await systemDb.order.count()).toBe(2);
    expect(await systemDb.orderLineItem.count()).toBe(2);
    expect((await systemDb.syncJob.findUniqueOrThrow({ where: { id: job.id } })).progress).toBe(after.progress);
  });

  it("adopts an export already running for the shop instead of starting a second", async () => {
    const store = await makeStore(["read_orders"]);
    const job = await makeJob(store, "orders");
    const calls = shopify({ current: { id: BULK_ID, status: "RUNNING", createdAt: new Date().toISOString() }, status: "RUNNING" });
    await runSync({ storeId: store.id, kind: "orders", syncJobId: job.id }, deps);
    expect(calls).not.toContain("run");
    expect(queues.sent.sync.at(-1)!.bulk).toMatchObject({ phase: "poll", id: BULK_ID });
  });

  it("frees the export lock when starting fails, so the retry adopts the export instead of bowing out", async () => {
    const store = await makeStore(["read_orders"]);
    const job = await makeJob(store, "orders");
    const opts: { current?: unknown; status: string } = { status: "RUNNING" };
    const calls = shopify(opts);
    const start = { storeId: store.id, kind: "orders" as const, syncJobId: job.id };

    // The export is submitted, then the next step fails (here: the queue; the tunnel dropping
    // under the row update does the same).
    const brokenQueues = { ...queues, sync: { send: async () => Promise.reject(new Error("queue unavailable")) } };
    await expect(runSync(start, { ...deps, queues: brokenQueues })).rejects.toThrow(/queue unavailable/);
    expect(calls).toEqual(["current", "run"]);
    opts.current = { id: BULK_ID, status: "RUNNING", createdAt: new Date().toISOString() };

    // The retry used to find its own lock, log "another bulk backfill is starting" and ack: the
    // export ran on with nobody polling it and the row was reaped half an hour later.
    await runSync(start, deps);
    expect(calls.filter((c) => c === "run")).toHaveLength(1);
    expect(queues.sent.sync).toEqual([{ ...start, bulk: { phase: "poll", id: BULK_ID, polls: 0 } }]);
  });

  it("waits for another job's export lock, re-sending itself, rather than leaving its row for dead", async () => {
    const store = await makeStore(["read_orders"]);
    const job = await makeJob(store, "orders");
    const calls = shopify({ body: jsonl([{ id: 1 }]), objectCount: 2 });
    // A second connect's backfill got there first.
    expect(await coord.acquire(`bulk:orders:${store.id}`, 10 * 60_000)).toBe(true);
    const start = { storeId: store.id, kind: "orders" as const, syncJobId: job.id };

    await runSync(start, deps);
    expect(calls).toEqual([]);
    expect(queues.sent.sync).toEqual([{ ...start, bulk: { phase: "start", lockWaits: 1 } }]);
    expect(queues.sentOpts.sync).toEqual([{ delaySeconds: 60 }]);
    // Each wait is a sign of life, so the watchdog leaves the row be.
    const row = await systemDb.syncJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe("running");
    expect(row.lastActivityAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);

    // Once the lock is free it carries on as its own import and finishes its own row.
    await coord.release(`bulk:orders:${store.id}`);
    await drainSync(queues.sent.sync.shift()!);
    expect((await systemDb.syncJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("succeeded");
    expect((await systemDb.store.findUniqueOrThrow({ where: { id: store.id } })).status).toBe("active");
  });

  it("gives up waiting for the export lock in the end and takes the paged path, leaving the lock to its holder", async () => {
    const store = await makeStore(["read_orders"]);
    const job = await makeJob(store, "orders");
    shopify({});
    expect(await coord.acquire(`bulk:orders:${store.id}`, 10 * 60_000)).toBe(true);
    await runSync({ storeId: store.id, kind: "orders", syncJobId: job.id, bulk: { phase: "start", lockWaits: 12 } }, deps);
    expect(queues.sent.sync).toEqual([{ storeId: store.id, kind: "orders", syncJobId: job.id, pagedOnly: true }]);
    expect(await coord.acquire(`bulk:orders:${store.id}`, 10 * 60_000)).toBe(false);
  });

  /**
   * The important failure property: a merchant gets a slower import, not a broken one. The job
   * is NOT marked failed, and `pagedOnly` stops the paged path bouncing back into bulk.
   */
  it("falls back to the paged path when Shopify rejects the bulk query", async () => {
    const store = await makeStore(["read_orders"]);
    const job = await makeJob(store, "orders");
    shopify({ runErrors: [{ message: "invalid nesting" }] });
    await runSync({ storeId: store.id, kind: "orders", syncJobId: job.id }, deps);
    expect(queues.sent.sync).toEqual([{ storeId: store.id, kind: "orders", syncJobId: job.id, pagedOnly: true }]);
    expect((await systemDb.syncJob.findUniqueOrThrow({ where: { id: job.id } })).status).not.toBe("failed");
  });

  it("falls back when the operation fails outright", async () => {
    const store = await makeStore(["read_orders"]);
    const job = await makeJob(store, "orders");
    shopify({ status: "FAILED" });
    await runSync({ storeId: store.id, kind: "orders", syncJobId: job.id, bulk: { phase: "poll", id: BULK_ID, polls: 0 } }, deps);
    expect(queues.sent.sync.at(-1)).toMatchObject({ pagedOnly: true });
  });

  it("falls back when the result link has expired", async () => {
    const store = await makeStore(["read_orders"]);
    const job = await makeJob(store, "orders");
    fetchImpl = async (_u, init) => {
      const { query } = gqlBody(init);
      if (query.includes("node(")) return gqlJson({ node: { id: BULK_ID, status: "COMPLETED", objectCount: "2", url: null, partialDataUrl: null } });
      return gqlJson({});
    };
    await runSync({ storeId: store.id, kind: "orders", syncJobId: job.id, bulk: { phase: "ingest", id: BULK_ID, byteOffset: 0 } }, deps);
    expect(queues.sent.sync.at(-1)).toMatchObject({ pagedOnly: true });
  });

  it("never fetches a result link that isn't https (SSRF guard)", async () => {
    const store = await makeStore(["read_orders"]);
    const job = await makeJob(store, "orders");
    const fetched: string[] = [];
    fetchImpl = async (u, init) => {
      fetched.push(String(u));
      const { query } = gqlBody(init);
      if (query.includes("node(")) {
        return gqlJson({ node: { id: BULK_ID, status: "COMPLETED", objectCount: "2", url: "http://169.254.169.254/latest/meta-data/", partialDataUrl: null } });
      }
      return gqlJson({});
    };
    await runSync({ storeId: store.id, kind: "orders", syncJobId: job.id, bulk: { phase: "ingest", id: BULK_ID, byteOffset: 0 } }, deps);
    expect(fetched.filter((u) => u.includes("169.254.169.254"))).toEqual([]);
    expect(queues.sent.sync.at(-1)).toMatchObject({ pagedOnly: true });
  });

  it("marks a store with no orders in the window fully synced", async () => {
    const store = await makeStore(["read_orders"]);
    const job = await makeJob(store, "orders");
    shopify({ objectCount: 0 });
    await drainSync({ storeId: store.id, kind: "orders", syncJobId: job.id });
    expect((await systemDb.store.findUniqueOrThrow({ where: { id: store.id } })).status).toBe("active");
    expect((await systemDb.syncJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("succeeded");
  });

  it("writes the same rows as the paged path for the same orders", async () => {
    const bulkStore = await makeStore(["read_orders"], "America/New_York", "pb.myshopify.com");
    const bulkJob = await makeJob(bulkStore, "orders");
    shopify({ body: jsonl([{ id: 1, refund: true }]), objectCount: 2 });
    await drainSync({ storeId: bulkStore.id, kind: "orders", syncJobId: bulkJob.id });

    const pagedStore = await makeStore(["read_orders"], "America/New_York", "pp.myshopify.com");
    const pagedJob = await makeJob(pagedStore, "orders");
    fetchImpl = async () =>
      gqlJson(
        ordersPage([
          gOrder(1, {
            createdAt: "2026-03-01T15:00:00Z",
            updatedAt: "2026-03-01T15:00:00Z",
            discountCodes: [],
            subtotalPriceSet: money("20"),
            totalDiscountsSet: money("0"),
            totalTaxSet: money("0"),
            totalShippingPriceSet: money("0"),
            totalPriceSet: money("20"),
            fulfillments: [{ createdAt: "2026-03-02T09:30:00Z" }],
            lineItems: {
              pageInfo: { hasNextPage: false },
              nodes: [
                {
                  id: "gid://shopify/LineItem/1-1",
                  title: "X",
                  quantity: 1,
                  sku: null,
                  variant: null,
                  product: null,
                  originalUnitPriceSet: money("20"),
                  totalDiscountSet: money("0"),
                },
              ],
            },
            refunds: [{ id: "gid://shopify/Refund/1", createdAt: "2026-03-03T12:00:00Z", refundLineItems: { pageInfo: { hasNextPage: false }, nodes: [{ subtotalSet: money("5") }] } }],
          }),
        ]),
      );
    await runSync({ storeId: pagedStore.id, kind: "orders", syncJobId: pagedJob.id, pagedOnly: true }, deps);

    const read = async (storeId: string) => {
      const o = await systemDb.order.findFirstOrThrow({ where: { storeId }, include: { lineItems: true, refunds: true } });
      const { id: _i, storeId: _s, workspaceId: _w, ...rest } = o;
      return {
        ...rest,
        lineItems: o.lineItems.map(({ id: _a, orderId: _b, storeId: _c, workspaceId: _d, ...li }) => ({ ...li, price: toNumber(li.price), discount: toNumber(li.discount) })),
        refunds: o.refunds.map(({ id: _a, orderId: _b, storeId: _c, workspaceId: _d, ...r }) => ({ ...r, lineSubtotal: toNumber(r.lineSubtotal) })),
        subtotal: toNumber(rest.subtotal),
        totalDiscounts: toNumber(rest.totalDiscounts),
        totalTax: toNumber(rest.totalTax),
        totalShipping: toNumber(rest.totalShipping),
        totalPrice: toNumber(rest.totalPrice),
      };
    };
    expect(await read(bulkStore.id)).toEqual(await read(pagedStore.id));
  });
});

describe("moving to a new address", () => {
  const gqlJson = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
  const here = "http://localhost:4000/pixel/pk-s.myshopify.com";

  /** Shopify with our pixel already on the store, created with `existingUrl`; records what was sent. */
  function pixelShop(existingUrl: string | null) {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    fetchImpl = async (_url, init) => {
      const { query, variables } = JSON.parse(String(init?.body));
      calls.push({ query, variables });
      if (query.includes("webPixelCreate")) {
        return existingUrl === null
          ? gqlJson({ webPixelCreate: { userErrors: [], webPixel: { id: "gid://shopify/WebPixel/1" } } })
          : gqlJson({ webPixelCreate: { userErrors: [{ field: null, message: "Web pixel is taken.", code: "TAKEN" }], webPixel: null } });
      }
      if (query.includes("webPixelUpdate")) return gqlJson({ webPixelUpdate: { userErrors: [], webPixel: { id: variables.id } } });
      if (query.includes("webPixel")) return gqlJson({ webPixel: { id: "gid://shopify/WebPixel/1", settings: JSON.stringify({ ingestUrl: existingUrl }) } });
      throw new Error(`unexpected query ${query}`);
    };
    return calls;
  }

  async function installPixel() {
    const store = await makeStore(["read_orders", "write_pixels"]);
    const job = await systemDb.syncJob.create({ data: { workspaceId: store.workspaceId, storeId: store.id, kind: "install_pixel" } });
    await runSync({ storeId: store.id, kind: "install_pixel", syncJobId: job.id }, deps);
    expect((await systemDb.store.findUniqueOrThrow({ where: { id: store.id } })).pixelInstalled).toBe(true);
    expect((await systemDb.syncJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("succeeded");
  }

  it("points a pixel made for the old host at this one", async () => {
    // Before: TAKEN was taken as done, so the pixel kept posting to the old host for good.
    const calls = pixelShop("https://old-host.example/api/pixel/pk-s.myshopify.com");
    await installPixel();
    const update = calls.find((c) => c.query.includes("webPixelUpdate"));
    expect(update?.variables).toEqual({ id: "gid://shopify/WebPixel/1", settings: JSON.stringify({ ingestUrl: here }) });
  });

  it("leaves a pixel that already posts here alone, and asks nothing after a fresh create", async () => {
    const same = pixelShop(here);
    await installPixel();
    expect(same.some((c) => c.query.includes("webPixelUpdate"))).toBe(false);

    await resetDb();
    const fresh = pixelShop(null);
    await installPixel();
    expect(fresh.map((c) => (c.query.includes("webPixelCreate") ? "create" : "other"))).toEqual(["create"]);
  });

  it("fails the job when Shopify refuses the update", async () => {
    pixelShop("https://old.example/api/pixel/pk-s.myshopify.com");
    const refuse = fetchImpl;
    fetchImpl = async (url, init) =>
      String(init?.body).includes("webPixelUpdate")
        ? gqlJson({ webPixelUpdate: { userErrors: [{ field: ["settings"], message: "Settings are invalid.", code: "INVALID_SETTINGS" }], webPixel: null } })
        : refuse(url, init);
    const store = await makeStore(["read_orders", "write_pixels"]);
    const job = await systemDb.syncJob.create({ data: { workspaceId: store.workspaceId, storeId: store.id, kind: "install_pixel" } });
    await expect(runSync({ storeId: store.id, kind: "install_pixel", syncJobId: job.id }, deps)).rejects.toThrow(/webPixelUpdate: Settings are invalid/);
  });

  it("reads the ingest URL from settings as Shopify returns them", () => {
    expect(pixelIngestUrl(JSON.stringify({ ingestUrl: here }))).toBe(here);
    expect(pixelIngestUrl({ ingestUrl: here })).toBe(here);
    expect(pixelIngestUrl("not json")).toBeNull();
    expect(pixelIngestUrl(null)).toBeNull();
  });

  it("after-move queues a full re-import everywhere and a pixel re-point where there is a pixel", async () => {
    const withPixel = await makeStore(["read_orders", "read_customers", "write_pixels"], "UTC", "a.myshopify.com");
    await systemDb.store.update({ where: { id: withPixel.id }, data: { status: "active", pixelInstalled: true } });
    const noPixel = await makeStore(["read_orders"], "UTC", "b.myshopify.com");
    await systemDb.store.update({ where: { id: noPixel.id }, data: { status: "error" } });
    const gone = await makeStore(["read_orders", "write_pixels"], "UTC", "c.myshopify.com");
    await systemDb.store.update({ where: { id: gone.id }, data: { status: "uninstalled", pixelInstalled: true } });

    expect(await seedAfterMove(deps)).toEqual({ stores: 2, jobs: 3 });
    const sent = queues.sent.sync.map((m) => `${m.storeId === withPixel.id ? "a" : m.storeId === noPixel.id ? "b" : "c"}:${m.kind}:${m.sinceDays ?? "all"}`).sort();
    expect(sent).toEqual(["a:install_pixel:all", "a:orders:all", "b:orders:all"]);
    // Each message has its job row, so onboarding/settings show the work and failStaleJobs can see it.
    expect(await systemDb.syncJob.count({ where: { id: { in: queues.sent.sync.map((m) => m.syncJobId) } } })).toBe(3);
  });
});
