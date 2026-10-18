import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectDb, systemDb } from "@app/db";
import { resetDb } from "@app/db/testing";
import { encryptTokenFields, memoryBlobs, memoryCoord, memoryMailer, memoryQueues, type FetchLike } from "@app/core";
import { processWebhook, type WorkerDeps } from "../src/handlers.js";

/**
 * The plan when Shopify ends what pays for it (App Store requirement 1.2.2): uninstalling the app
 * cancels its charges, often without an app_subscriptions/update to say so, and a reinstall must
 * start from Free and ask for approval again. The API side (cancel, reinstall) is in
 * apps/api/test/billing.test.ts.
 */

const queues = memoryQueues();
const coord = memoryCoord();
let fetchImpl: FetchLike;
let deps: WorkerDeps;

beforeAll(() => {
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

const CHARGE = "gid://shopify/AppSubscription/1";
const PENDING = "gid://shopify/AppSubscription/2";

/** A workspace on Growth, paid on `shop`'s bill, with a change to Scale awaiting approval. */
async function payingWorkspace(shop = "paying.myshopify.com") {
  const ws = await systemDb.workspace.create({ data: { name: "W" } });
  const store = await addStore(ws.id, shop);
  await systemDb.subscription.create({
    data: { workspaceId: ws.id, plan: "growth", status: "active", shopifyChargeId: CHARGE, pendingPlan: "scale", pendingChargeId: PENDING, billingStoreId: store.id },
  });
  return { ws: ws.id, store };
}

async function addStore(workspaceId: string, shop: string) {
  const store = await systemDb.store.create({
    data: { workspaceId, shopDomain: shop, grantedScopes: ["read_orders"], status: "active", pixelIngestKey: `pk-${shop}`, installedAt: new Date(Date.now() - 3600_000) },
  });
  await systemDb.store.update({
    where: { id: store.id },
    data: encryptTokenFields(store.id, { accessToken: "shpat_x", scopes: ["read_orders"], accessTokenExpiresAt: null, refreshToken: null, refreshTokenExpiresAt: null }),
  });
  return store;
}

let seq = 0;
async function webhook(topic: string, shop: string, payload: unknown, triggeredAt = new Date().toISOString()) {
  const ev = await systemDb.webhookEvent.create({ data: { webhookId: `b${++seq}`, topic, shopDomain: shop } });
  return processWebhook({ eventId: ev.id, topic, shop, payload, app: "default", triggeredAt }, deps);
}

const sub = (ws: string) => systemDb.subscription.findUniqueOrThrow({ where: { workspaceId: ws } });

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
/** A late app/uninstalled first asks whether the current installation works (it does, here). */
const isInstallationCheck = (init?: RequestInit) => String(init?.body).includes("currentAppInstallation");
const installationWorks = () => json({ data: { currentAppInstallation: { id: "gid://shopify/AppInstallation/1" } } });

describe("billing when the app is uninstalled", () => {
  it("app/uninstalled ends the plan billed on that store, and the change awaiting approval with it", async () => {
    const { ws, store } = await payingWorkspace();
    await webhook("app/uninstalled", store.shopDomain, { id: 1 });
    expect(await sub(ws)).toMatchObject({ plan: "free", status: "active", shopifyChargeId: null, pendingPlan: null, pendingChargeId: null, billingStoreId: null });
    expect(await systemDb.auditLog.findFirstOrThrow({ where: { action: "billing.subscription_ended" } })).toMatchObject({
      workspaceId: ws,
      targetId: store.id,
      metadata: { plan: "growth", reason: "uninstalled" },
    });
  });

  it("uninstalling another of the workspace's stores leaves the plan alone", async () => {
    const { ws } = await payingWorkspace();
    const other = await addStore(ws, "other.myshopify.com");
    await webhook("app/uninstalled", other.shopDomain, { id: 1 });
    expect(await sub(ws)).toMatchObject({ plan: "growth", shopifyChargeId: CHARGE, pendingChargeId: PENDING });
  });

  it("a late app/uninstalled (reinstalled since) asks Shopify which charges still stand", async () => {
    const { ws, store } = await payingWorkspace();
    await systemDb.store.update({ where: { id: store.id }, data: { installedAt: new Date() } });
    const asked: unknown[] = [];
    // The charge in force was the old installation's (not visible now); the change was approved since.
    fetchImpl = async (_url, init) => {
      if (isInstallationCheck(init)) return installationWorks();
      const { variables } = JSON.parse(String(init?.body)) as { variables: { ids: string[] } };
      asked.push(variables.ids);
      return json({ data: { nodes: variables.ids.map((id) => (id === PENDING ? { id, status: "ACTIVE" } : null)) } });
    };
    await webhook("app/uninstalled", store.shopDomain, { id: 1 }, new Date(Date.now() - 20 * 60_000).toISOString());
    expect(asked).toEqual([[PENDING, CHARGE]]);
    // The store itself is untouched (the existing guard), and the plan is what Shopify says.
    expect((await systemDb.store.findUniqueOrThrow({ where: { id: store.id } })).status).toBe("active");
    expect(await sub(ws)).toMatchObject({ plan: "scale", shopifyChargeId: PENDING, pendingChargeId: null });
  });

  it("a late app/uninstalled for a store paying for nothing asks Shopify nothing about charges", async () => {
    const ws = await systemDb.workspace.create({ data: { name: "Free" } });
    const store = await addStore(ws.id, "free.myshopify.com");
    await systemDb.subscription.create({ data: { workspaceId: ws.id, plan: "free" } });
    await systemDb.store.update({ where: { id: store.id }, data: { installedAt: new Date() } });
    fetchImpl = async (_url, init) => {
      if (isInstallationCheck(init)) return installationWorks();
      throw new Error("unexpected fetch");
    };
    await webhook("app/uninstalled", store.shopDomain, { id: 1 }, new Date(Date.now() - 20 * 60_000).toISOString());
    expect((await sub(ws.id)).plan).toBe("free");
  });

  it("app_subscriptions/update CANCELLED for the charge in force drops the workspace to Free", async () => {
    const { ws, store } = await payingWorkspace();
    await webhook("app_subscriptions/update", store.shopDomain, { app_subscription: { admin_graphql_api_id: CHARGE, status: "CANCELLED" } });
    expect(await sub(ws)).toMatchObject({ plan: "free", shopifyChargeId: null, pendingPlan: "scale" });
  });
});
