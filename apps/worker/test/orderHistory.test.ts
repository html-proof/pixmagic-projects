import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectDb, systemDb } from "@app/db";
import { resetDb } from "@app/db/testing";
import { encryptTokenFields, failHistoryWindows, memoryBlobs, memoryCoord, memoryMailer, memoryQueues, MAX_ATTEMPTS, type FetchLike, type SyncJobData } from "@app/core";
import { runAggregate, runSync, type WorkerDeps } from "../src/handlers.js";
import { consume, type QueueMessage } from "../src/index.js";

/**
 * A store's full order history (read_all_orders), imported a calendar year at a time, newest first
 * (packages/core/src/orderHistory.ts, apps/worker/src/handlers/sync.ts): the plan, each year's own
 * export, a year that falls back to paging, resuming an import that stopped, and starting over.
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
});

const TZ = "Australia/Melbourne";
const ALL = ["read_orders", "read_all_orders"];

async function makeStore(scopes = ALL) {
  const ws = await systemDb.workspace.create({ data: { name: "W" } });
  const store = await systemDb.store.create({
    data: { workspaceId: ws.id, shopDomain: "h.myshopify.com", grantedScopes: scopes, status: "syncing", timezone: TZ, pixelIngestKey: "pk-h" },
  });
  await systemDb.store.update({
    where: { id: store.id },
    data: encryptTokenFields(store.id, { accessToken: "shpat_x", scopes, accessTokenExpiresAt: null, refreshToken: null, refreshTokenExpiresAt: null }),
  });
  return systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
}

const makeJob = (store: { id: string; workspaceId: string }) => systemDb.syncJob.create({ data: { workspaceId: store.workspaceId, storeId: store.id, kind: "orders" } });

const money = (amount: string) => ({ shopMoney: { amount } });
const gqlJson = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });

/** One order of the fake store, sold for 20 at `createdAt`. */
const orderNode = (id: number, createdAt: string) => ({
  id: `gid://shopify/Order/${id}`,
  name: `#${id}`,
  createdAt,
  processedAt: createdAt,
  updatedAt: createdAt,
  cancelledAt: null,
  currencyCode: "AUD",
  displayFinancialStatus: "PAID",
  sourceName: "web",
  displayFulfillmentStatus: "FULFILLED",
  discountCodes: [],
  subtotalPriceSet: money("20"),
  totalDiscountsSet: money("0"),
  totalTaxSet: money("0"),
  totalShippingPriceSet: money("0"),
  totalPriceSet: money("20"),
  fulfillments: [],
});

/** The order's line and its sale as bulk JSONL lines (children name their parent). */
const jsonlOf = (id: number, createdAt: string) => {
  const gid = `gid://shopify/Order/${id}`;
  return [
    JSON.stringify(orderNode(id, createdAt)),
    JSON.stringify({ id: `gid://shopify/SalesAgreement/${id}`, happenedAt: createdAt, __parentId: gid }),
    JSON.stringify({
      id: `gid://shopify/Sale/${id}`,
      actionType: "ORDER",
      lineType: "PRODUCT",
      quantity: 1,
      totalAmount: money("20"),
      totalDiscountAmountBeforeTaxes: money("0"),
      totalTaxAmount: money("0"),
      lineItem: { id: `gid://shopify/LineItem/${id}` },
      __parentId: `gid://shopify/SalesAgreement/${id}`,
    }),
    JSON.stringify({ id: `gid://shopify/LineItem/${id}`, title: "X", quantity: 1, sku: null, variant: null, product: null, originalUnitPriceSet: money("20"), totalDiscountSet: money("0"), __parentId: gid }),
  ];
};

/** The orders a Shopify order search matches: `created_at:>='…'` and `created_at:<'…'`, as the import asks. */
function matching(orders: Array<{ id: number; createdAt: string }>, search: string | null) {
  const from = /created_at:>='([^']+)'/.exec(search ?? "")?.[1];
  const to = /created_at:<'([^']+)'/.exec(search ?? "")?.[1];
  return orders
    .filter((o) => (!from || o.createdAt >= from) && (!to || o.createdAt < to))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * A fake Shopify holding `orders`: the first-order lookup, bulk exports (each run its own operation,
 * the last one lingering as the shop's current one, as Shopify keeps it), their files, and the paged
 * orders query. `rejectBulk` turns down the export for a search containing that text.
 */
function shopify(orders: Array<{ id: number; createdAt: string }>, opts: { rejectBulk?: string } = {}) {
  const runs: Array<string | null> = [];
  const paged: Array<string | null> = [];
  const files = new Map<string, string>();
  let current: Record<string, unknown> | null = null;
  fetchImpl = async (url, init) => {
    const file = files.get(String(url));
    if (file !== undefined) {
      const bytes = new TextEncoder().encode(file);
      return new Response(bytes, { status: 206, headers: { "content-range": `bytes 0-${Math.max(0, bytes.length - 1)}/${bytes.length}` } });
    }
    const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    if (query.includes("query OldestOrder")) {
      const first = [...orders].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      return gqlJson({ orders: { nodes: first ? [{ createdAt: first.createdAt }] : [] } });
    }
    if (query.includes("bulkOperationRunQuery")) {
      const search = /query: "([^"]*)"/.exec(String(variables.query))?.[1] ?? null;
      runs.push(search);
      if (opts.rejectBulk && search?.includes(opts.rejectBulk)) {
        return gqlJson({ bulkOperationRunQuery: { bulkOperation: null, userErrors: [{ message: "Bulk queries are not available right now" }] } });
      }
      const id = `gid://shopify/BulkOperation/${runs.length}`;
      const hits = matching(orders, search);
      const url = `https://files.example/${runs.length}.jsonl`;
      files.set(url, hits.flatMap((o) => jsonlOf(o.id, o.createdAt)).join("\n") + (hits.length ? "\n" : ""));
      current = { id, status: "COMPLETED", errorCode: null, objectCount: String(hits.length * 4), fileSize: "1", url: hits.length ? url : null, partialDataUrl: null, createdAt: new Date().toISOString() };
      return gqlJson({ bulkOperationRunQuery: { bulkOperation: { id, status: "CREATED" }, userErrors: [] } });
    }
    if (query.includes("currentBulkOperation")) return gqlJson({ currentBulkOperation: current });
    if (query.includes("node(")) return gqlJson({ node: current && current.id === variables.id ? current : null });
    if (query.includes("query Orders")) {
      const search = (variables.query as string | null) ?? null;
      paged.push(search);
      const nodes = matching(orders, search).map((o) => ({
        ...orderNode(o.id, o.createdAt),
        lineItems: { pageInfo: { hasNextPage: false }, nodes: [{ id: `gid://shopify/LineItem/${o.id}`, title: "X", quantity: 1, sku: null, variant: null, product: null, originalUnitPriceSet: money("20"), totalDiscountSet: money("0") }] },
        agreements: {
          pageInfo: { hasNextPage: false },
          nodes: [
            {
              id: `gid://shopify/SalesAgreement/${o.id}`,
              happenedAt: o.createdAt,
              sales: {
                pageInfo: { hasNextPage: false },
                nodes: [{ id: `gid://shopify/Sale/${o.id}`, actionType: "ORDER", lineType: "PRODUCT", quantity: 1, totalAmount: money("20"), totalDiscountAmountBeforeTaxes: money("0"), totalTaxAmount: money("0"), lineItem: { id: `gid://shopify/LineItem/${o.id}` } }],
              },
            },
          ],
        },
      }));
      return gqlJson({ orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } });
    }
    throw new Error(`unexpected Shopify call: ${query.slice(0, 60)}`);
  };
  return { runs, paged };
}

/** Follow the chain to its end; `after` sees the state between messages. Returns the messages run. */
async function drain(first: SyncJobData, after?: () => Promise<void>, limit = 80) {
  const ran: SyncJobData[] = [];
  let msg: SyncJobData | undefined = first;
  for (let i = 0; msg && i < limit; i++) {
    ran.push(msg);
    await runSync(msg, deps);
    if (after) await after();
    msg = queues.sent.sync.shift() as SyncJobData | undefined;
    while (msg && (msg as { kind: string }).kind === "verify") msg = queues.sent.sync.shift() as SyncJobData | undefined;
  }
  for (const j of queues.sent.aggregate.splice(0)) await runAggregate(j);
  return ran;
}

// Midnight on 1 January in Melbourne, as the plan's boundaries are.
const NEW_YEAR = { 2024: "2023-12-31T13:00:00.000Z", 2025: "2024-12-31T13:00:00.000Z", 2026: "2025-12-31T13:00:00.000Z" } as const;
const ORDERS = [
  { id: 1, createdAt: "2023-06-01T02:00:00.000Z" },
  { id: 2, createdAt: "2024-02-29T02:00:00.000Z" },
  // 31 Dec 2025 at 2 pm UTC is already 1 Jan 2026 in Melbourne: a 2026 order.
  { id: 3, createdAt: "2025-12-31T14:00:00.000Z" },
  { id: 4, createdAt: "2026-10-01T02:00:00.000Z" },
];
const years = (storeId: string) => systemDb.orderHistoryWindow.findMany({ where: { storeId }, orderBy: { year: "desc" } });

describe("full order history, a year at a time", () => {
  it("imports every year newest first, each its own export, and moves the history start back as each is in", async () => {
    const store = await makeStore();
    const job = await makeJob(store);
    const { runs } = shopify(ORDERS);
    const starts: Array<string | null> = [];
    await drain({ storeId: store.id, kind: "orders", syncJobId: job.id }, async () => {
      const s = await systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
      const at = s.ordersHistoryFrom?.toISOString() ?? null;
      if (starts.at(-1) !== at) starts.push(at);
    });

    // One export per year, newest first; the oldest has no lower bound. Last year's finished export,
    // still the shop's current one, was never read as the next year's.
    expect(runs).toEqual([
      `created_at:>='${NEW_YEAR[2026]}'`,
      `created_at:>='${NEW_YEAR[2025]}' AND created_at:<'${NEW_YEAR[2026]}'`,
      `created_at:>='${NEW_YEAR[2024]}' AND created_at:<'${NEW_YEAR[2025]}'`,
      `created_at:<'${NEW_YEAR[2024]}'`,
    ]);
    expect(await systemDb.order.count({ where: { storeId: store.id } })).toBe(4);
    expect((await years(store.id)).map((y) => [y.year, y.status, y.orders])).toEqual([
      [2026, "done", 2],
      [2025, "done", 0],
      [2024, "done", 1],
      [2023, "done", 1],
    ]);
    // The history reaches back a year at a time, then (the oldest year) the whole of it.
    expect(starts).toEqual([null, NEW_YEAR[2026], NEW_YEAR[2025], NEW_YEAR[2024], new Date(0).toISOString()]);
    const done = await systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(done).toMatchObject({ status: "active" });
    expect(done.lastSyncedAt).not.toBeNull();
    expect(await systemDb.syncJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "succeeded", progress: 4 });
    // Each year's days were added up as it came in, on the store's calendar.
    const days = (await systemDb.dailyStoreMetrics.findMany({ where: { storeId: store.id }, orderBy: { day: "asc" } })).map((m) => m.day);
    expect(days).toEqual(["2023-06-01", "2024-02-29", "2026-01-01", "2026-10-01"]);
  });

  it("reads a year page by page when its export is turned down, and tries bulk again for the next", async () => {
    const store = await makeStore();
    const job = await makeJob(store);
    const { runs, paged } = shopify(ORDERS, { rejectBulk: `created_at:>='${NEW_YEAR[2024]}'` });
    const ran = await drain({ storeId: store.id, kind: "orders", syncJobId: job.id });

    expect(paged).toEqual([`created_at:>='${NEW_YEAR[2024]}' AND created_at:<'${NEW_YEAR[2025]}'`]);
    // The paged walk carried the year with it.
    expect(ran.find((m) => m.pagedOnly)).toMatchObject({ history: { windowId: expect.any(String) } });
    expect(runs.at(-1)).toBe(`created_at:<'${NEW_YEAR[2024]}'`);
    expect(await systemDb.order.count({ where: { storeId: store.id } })).toBe(4);
    expect((await years(store.id)).every((y) => y.status === "done")).toBe(true);
    expect((await systemDb.store.findUniqueOrThrow({ where: { id: store.id } })).ordersHistoryFrom).toEqual(new Date(0));
  });

  it("marks the year it was reading failed when the job gives up, and the next import resumes there", async () => {
    const store = await makeStore();
    const job = await makeJob(store);
    shopify(ORDERS);
    // Run until 2024's year has started, then fail the job on its last attempt, as the queue does.
    let msg: SyncJobData | undefined = { storeId: store.id, kind: "orders", syncJobId: job.id };
    for (let i = 0; msg && i < 40; i++) {
      const running = (await years(store.id)).find((y) => y.status === "running");
      if (running?.year === 2024) break;
      await runSync(msg, deps);
      msg = queues.sent.sync.shift() as SyncJobData | undefined;
    }
    expect(msg?.history).toBeDefined();
    fetchImpl = async () => new Response("Shopify is down", { status: 503 });
    const outcome: string[] = [];
    const message: QueueMessage = {
      id: "m1",
      body: msg!,
      attempts: MAX_ATTEMPTS,
      ack: () => void outcome.push("ack"),
      retry: () => void outcome.push("retry"),
    };
    await consume("sync", message, deps);
    expect(outcome).toEqual(["ack"]);
    const failed = (await years(store.id)).find((y) => y.year === 2024)!;
    expect(failed).toMatchObject({ status: "failed" });
    expect(failed.error).toBeTruthy();
    expect((await systemDb.syncJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("failed");
    // The history stops at the last year that is in: 2025's.
    expect((await systemDb.store.findUniqueOrThrow({ where: { id: store.id } })).ordersHistoryFrom).toEqual(new Date(NEW_YEAR[2025]));

    // The next full import keeps 2025, reads this year again (orders kept coming) and carries on from 2024.
    // It comes half an hour later at the earliest: the dead job's 10-minute export lock is long gone.
    queues.clear();
    coord.clear();
    const again = await makeJob(store);
    const { runs } = shopify(ORDERS);
    await drain({ storeId: store.id, kind: "orders", syncJobId: again.id });
    expect(runs).toEqual([
      `created_at:>='${NEW_YEAR[2026]}'`,
      `created_at:>='${NEW_YEAR[2024]}' AND created_at:<'${NEW_YEAR[2025]}'`,
      `created_at:<'${NEW_YEAR[2024]}'`,
    ]);
    const after = await years(store.id);
    expect(after.map((y) => [y.year, y.status, y.planJobId === again.id])).toEqual([
      [2026, "done", true],
      [2025, "done", true],
      [2024, "done", true],
      [2023, "done", true],
    ]);
    expect(await systemDb.order.count({ where: { storeId: store.id } })).toBe(4);
    expect((await systemDb.store.findUniqueOrThrow({ where: { id: store.id } })).ordersHistoryFrom).toEqual(new Date(0));
  });

  it("starts over, not resumes, when customers arrive after a plan read without them, or the plan was finished", async () => {
    const store = await makeStore();
    shopify(ORDERS);
    const first = await makeJob(store);
    // Stop after the newest year, as a job that died would.
    await runSync({ storeId: store.id, kind: "orders", syncJobId: first.id }, deps);
    for (let i = 0; i < 6 && !(await years(store.id)).some((y) => y.year === 2025 && y.status !== "queued"); i++) {
      const m = queues.sent.sync.shift() as SyncJobData | undefined;
      if (!m) break;
      await runSync(m, deps);
    }
    await failHistoryWindows(first.id, "stopped");
    expect((await years(store.id)).find((y) => y.year === 2026)!.status).toBe("done");

    // read_customers granted since: every year again, with the customer.
    await systemDb.store.update({ where: { id: store.id }, data: { grantedScopes: [...ALL, "read_customers"] } });
    queues.clear();
    coord.clear();
    const second = await makeJob(store);
    const { runs } = shopify(ORDERS);
    await drain({ storeId: store.id, kind: "orders", syncJobId: second.id });
    expect(runs).toHaveLength(4);
    expect((await years(store.id)).every((y) => y.withCustomers && y.status === "done")).toBe(true);

    // A finished plan: the next full import reads everything again too.
    queues.clear();
    const third = await makeJob(store);
    const again = shopify(ORDERS);
    await drain({ storeId: store.id, kind: "orders", syncJobId: third.id });
    expect(again.runs).toHaveLength(4);
  });

  it("ends an older import whose years a newer one planned over, instead of leaving it running", async () => {
    const store = await makeStore();
    shopify(ORDERS);
    const older = await makeJob(store);
    await runSync({ storeId: store.id, kind: "orders", syncJobId: older.id }, deps);
    const leftOver = queues.sent.sync.splice(0) as SyncJobData[];
    coord.clear();
    // A newer full import plans the years again before the older one's next message runs.
    const newer = await makeJob(store);
    await drain({ storeId: store.id, kind: "orders", syncJobId: newer.id });
    for (const m of leftOver) await runSync(m, deps);
    expect(await systemDb.syncJob.findUniqueOrThrow({ where: { id: older.id } })).toMatchObject({ status: "failed", error: "Replaced by a newer import of the order history" });
    expect(await systemDb.syncJob.findUniqueOrThrow({ where: { id: newer.id } })).toMatchObject({ status: "succeeded" });
    expect((await years(store.id)).every((y) => y.status === "done" && y.planJobId === newer.id)).toBe(true);
    expect(await systemDb.order.count({ where: { storeId: store.id } })).toBe(4);
  });

  it("finishes a store without orders at once: nothing to plan, the whole (empty) history is in", async () => {
    const store = await makeStore();
    const job = await makeJob(store);
    const { runs } = shopify([]);
    await drain({ storeId: store.id, kind: "orders", syncJobId: job.id });
    expect(runs).toEqual([]);
    expect(await years(store.id)).toEqual([]);
    expect(await systemDb.store.findUniqueOrThrow({ where: { id: store.id } })).toMatchObject({ status: "active", ordersHistoryFrom: new Date(0) });
    expect((await systemDb.syncJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("succeeded");
  });

  it("leaves the 60-day import alone without read_all_orders: one window, no years", async () => {
    const store = await makeStore(["read_orders"]);
    const job = await makeJob(store);
    const recent = [{ id: 9, createdAt: new Date(Date.now() - 5 * 86_400_000).toISOString() }];
    const { runs } = shopify(recent);
    await drain({ storeId: store.id, kind: "orders", syncJobId: job.id });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatch(/^created_at:>='/);
    expect(await years(store.id)).toEqual([]);
    expect(await systemDb.order.count({ where: { storeId: store.id } })).toBe(1);
  });
});
