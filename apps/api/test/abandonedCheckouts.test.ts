import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb, type Store } from "@app/db";
import { reportWindows } from "@app/core/reports";
import { addDays, localDay, resolvePreset } from "@app/shared";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * GET .../abandoned-checkouts: Shopify's own abandoned checkouts on the Shopping Funnel page, from
 * the answers the worker keeps (packages/core/src/shopifyCheckouts.ts). Nothing here calls Shopify.
 */

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));
beforeEach(async () => clean(ctx));

// Whole days within the 60 days Shopify shares, compared with the 7 days before.
const today = localDay(new Date(), "UTC");
const FROM = addDays(today, -20);
const TO = addDays(today, -14);
const RANGE = `preset=custom&from=${FROM}&to=${TO}`;
const windows = (compare = "previous") => reportWindows(...(Object.values(resolvePreset("custom", new Date(), "UTC", { from: FROM, to: TO }, { mode: compare as "previous" })) as [never, never]));

async function owner(scopes = ["read_orders", "read_products"]) {
  const a = await signIn(ctx, "ua", "a@x.com");
  const ws = await createWorkspace(ctx, a.headers, "A");
  const store = await createStore(ws, "a.myshopify.com", scopes);
  return { a, ws, store };
}

const values = (abandoned: number, recovered: number, value: number) => ({
  abandoned,
  abandonedExact: true,
  recovered,
  recoveredExact: true,
  value,
  recoveredValue: value / 5,
  valueGap: null,
  currency: "AUD",
  days: null,
});

async function keep(store: Store, w: { from: string; to: string; until?: string }, v: unknown, error: string | null = null) {
  await systemDb.shopifyReport.create({
    data: { workspaceId: store.workspaceId, storeId: store.id, dataset: "abandoned_checkouts", window: `${w.from}|${w.to}|${w.until ?? ""}`, values: v ?? undefined, error, fetchedAt: new Date() },
  });
}

const get = (headers: Record<string, string>, ws: string, storeId: string, qs = RANGE) => ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/abandoned-checkouts?${qs}`, headers });
const jobs = () =>
  ctx.deps.queues.sent.sync.filter((j) => (j as { kind?: string }).kind === "shopify_reports") as unknown as Array<{ storeId: string; requests: Array<{ dataset: string; window: { from: string; to: string } }> }>;

describe("Shopify's abandoned checkouts (GET .../abandoned-checkouts)", () => {
  it("says it is asking Shopify, and queues the fetch once, when nothing is kept yet", async () => {
    const { a, ws, store } = await owner();
    const res = await get(a.headers, ws, store.id);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.range).toEqual({ from: FROM, to: TO });
    expect(body.module).toMatchObject({ status: "loading", previousStatus: "loading", current: null, previous: null, visibleFrom: addDays(today, -59) });
    expect(jobs()).toHaveLength(1);
    expect(jobs()[0]!.requests).toEqual([
      { dataset: "abandoned_checkouts", window: windows().current },
      { dataset: "abandoned_checkouts", window: windows().previous },
    ]);
    // Another poll (another tab) within the minute doesn't queue it twice.
    await get(a.headers, ws, store.id);
    expect(jobs()).toHaveLength(1);
  });

  it("shows the kept answers with the recovered rate and the changes, and asks nothing while they're fresh", async () => {
    const { a, ws, store } = await owner();
    const w = windows();
    await keep(store, w.current, values(40, 10, 2000));
    await keep(store, w.previous, values(20, 4, 1000));
    const m = (await get(a.headers, ws, store.id)).json().module;
    expect(m).toMatchObject({ status: "ready", previousStatus: "ready", current: { abandoned: 40, recovered: 10, recoveredRate: 0.25, value: 2000, recoveredValue: 400, currency: "AUD" }, previous: { abandoned: 20, recoveredRate: 0.2 } });
    expect(m.deltas.abandoned).toBe(1);
    expect(m.deltas.value).toBe(1);
    expect(m.deltas.recoveredRate).toBeCloseTo(0.25, 9);
    expect(jobs()).toEqual([]);
  });

  it("says why Shopify gave no figures, never 0", async () => {
    const { a, ws, store } = await owner();
    const w = windows();
    await keep(store, w.current, null, "access_denied");
    await keep(store, w.previous, null, "access_denied");
    const m = (await get(a.headers, ws, store.id)).json().module;
    expect(m).toMatchObject({ status: "access_denied", current: null, deltas: { abandoned: null, value: null, recoveredRate: null } });
    expect(jobs()).toEqual([]);
  });

  it("never asks Shopify for a comparison older than the 60 days it shares", async () => {
    const { a, ws, store } = await owner();
    const res = await get(a.headers, ws, store.id, `${RANGE}&compare=year`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().module).toMatchObject({ status: "loading", previousStatus: "beyond_history", previous: null });
    expect(jobs()[0]!.requests.map((r) => r.window)).toEqual([windows().current]);
  });

  it("needs View checkout abandonment, and the store's orders", async () => {
    const { ws, store } = await owner();
    const sales = await signIn(ctx, "us", "s@x.com");
    await systemDb.membership.create({ data: { workspaceId: ws, userId: sales.user.id, role: "custom", permissions: ["analytics.sales", "analytics.conversion"] } });
    expect((await get(sales.headers, ws, store.id)).statusCode).toBe(403);
    const abandonment = await signIn(ctx, "uc", "c@x.com");
    await systemDb.membership.create({ data: { workspaceId: ws, userId: abandonment.user.id, role: "custom", permissions: ["analytics.abandonment"] } });
    const res = await get(abandonment.headers, ws, store.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().module.status).toBe("loading");

    const products = await createStore(ws, "p.myshopify.com", ["read_products"]);
    const refused = await get(abandonment.headers, ws, products.id);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe("missing_scopes");
    expect(jobs().filter((j) => j.storeId === products.id)).toEqual([]);
  });

  it("answers 404 for another workspace's store before reading the question", async () => {
    const { a, ws, store } = await owner();
    const b = await signIn(ctx, "ub", "b@x.com");
    const wsB = await createWorkspace(ctx, b.headers, "B");
    const storeB = await createStore(wsB, "b.myshopify.com", ["read_orders"]);
    await keep(storeB, windows().current, values(99, 9, 999));
    // Through one's own workspace, or the other's: nothing of it, whatever the question.
    for (const qs of [RANGE, "preset=nonsense"]) {
      expect((await get(a.headers, ws, storeB.id, qs)).statusCode).toBe(404);
      expect((await get(a.headers, wsB, storeB.id, qs)).statusCode).toBe(404);
    }
    expect(jobs()).toEqual([]);
    // One's own store with a question that can't be read is a 400.
    expect((await get(a.headers, ws, store.id, "preset=nonsense")).statusCode).toBe(400);
  });
});
