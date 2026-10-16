import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectDb, systemDb } from "@app/db";
import { resetDb } from "@app/db/testing";
import { applySubscriptionUpdate, encryptTokenFields, MAX_ATTEMPTS, memoryBlobs, memoryCoord, memoryMailer, memoryQueues, resetEnvCache, type FetchLike, type Mailer } from "@app/core";
import { processWebhook, type WorkerDeps } from "../src/handlers.js";
import { consume, type QueueMessage } from "../src/index.js";

/**
 * Regressions found by the full test pass (2026-10-06). Each case failed before its fix.
 */

const queues = memoryQueues();
const coord = memoryCoord();
const payloads = memoryBlobs();
const sent = memoryMailer();
let mailer: Mailer = sent;
let fetchImpl: FetchLike;
let deps: WorkerDeps;

beforeAll(() => {
  deps = {
    coord,
    queues,
    payloads,
    mailer: { send: (...a) => mailer.send(...a) },
    fetchImpl: ((...a: Parameters<FetchLike>) => fetchImpl(...a)) as FetchLike,
  };
});
afterAll(async () => disconnectDb());
beforeEach(async () => {
  await resetDb();
  queues.clear();
  coord.clear();
  sent.sent.length = 0;
  mailer = sent;
  fetchImpl = async () => {
    throw new Error("unexpected fetch");
  };
});

const SHOP = "r.myshopify.com";
const gqlJson = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
const shopOk: FetchLike = async () => gqlJson({ shop: { name: "Shop", currencyCode: "AUD", ianaTimezone: "Australia/Sydney" } });
const shopBroken: FetchLike = async () => new Response(JSON.stringify({ errors: [{ message: "boom" }] }), { status: 200 });

async function makeStore(status: "active" | "syncing" | "uninstalled" = "active", owners = ["owner@r.com"]) {
  const ws = await systemDb.workspace.create({ data: { name: "R" } });
  const store = await systemDb.store.create({
    data: { workspaceId: ws.id, shopDomain: SHOP, grantedScopes: ["read_orders", "read_products"], status, timezone: "UTC", pixelIngestKey: "pk-r", lastSyncedAt: new Date() },
  });
  await systemDb.store.update({
    where: { id: store.id },
    data: encryptTokenFields(store.id, { accessToken: "shpat_x", scopes: ["read_orders"], accessTokenExpiresAt: null, refreshToken: null, refreshTokenExpiresAt: null }),
  });
  for (const [i, email] of owners.entries()) {
    const user = await systemDb.user.create({ data: { firebaseUid: `o${i}`, email, emailVerified: true } });
    await systemDb.membership.create({ data: { workspaceId: ws.id, userId: user.id, role: i === 0 ? "owner" : "admin" } });
  }
  return store;
}

function message(body: unknown, attempts: number) {
  const m = { acked: false, retried: undefined as undefined | { delaySeconds?: number } };
  const msg: QueueMessage = { id: "m", body, attempts, ack: () => (m.acked = true), retry: (o) => (m.retried = o ?? {}) };
  return { m, msg };
}

/** Run one sync job of `kind` to its final attempt (or success) with `fetch` answering Shopify. */
async function syncOnce(store: { id: string; workspaceId: string }, kind: "shop" | "products", fetch: FetchLike) {
  const job = await systemDb.syncJob.create({ data: { workspaceId: store.workspaceId, storeId: store.id, kind } });
  fetchImpl = fetch;
  const { m, msg } = message({ storeId: store.id, kind, syncJobId: job.id }, MAX_ATTEMPTS);
  await consume("sync", msg, { ...deps, dbHealthy: async () => true });
  return m;
}

const storeStatus = async (id: string) => (await systemDb.store.findUniqueOrThrow({ where: { id } })).status;
const openAlerts = (storeId: string) => systemDb.alert.findMany({ where: { storeId, resolvedAt: null } });

describe("alerts", () => {
  it("are resolved when the failing sync works again, so the next failure is announced", async () => {
    const store = await makeStore("syncing");
    await syncOnce(store, "shop", shopBroken);
    expect((await openAlerts(store.id)).map((a) => a.code)).toEqual(["sync_shop_failed"]);
    expect(sent.sent).toHaveLength(1);

    await syncOnce(store, "shop", shopOk);
    expect(await openAlerts(store.id)).toEqual([]);

    // Before: the first alert stayed open forever and de-duplicated every later incident away.
    await syncOnce(store, "shop", shopBroken);
    expect((await openAlerts(store.id)).map((a) => a.code)).toEqual(["sync_shop_failed"]);
    expect(sent.sent).toHaveLength(2);
  });

  it("for a failed webhook are resolved by the store's next processed webhook", async () => {
    const store = await makeStore();
    await systemDb.alert.create({ data: { workspaceId: store.workspaceId, storeId: store.id, severity: "warning", code: "webhook_failed", message: "x" } });
    const ev = await systemDb.webhookEvent.create({ data: { webhookId: "w-ok", topic: "shop/update", shopDomain: SHOP, storeId: store.id, workspaceId: store.workspaceId } });
    await processWebhook({ eventId: ev.id, topic: "shop/update", shop: SHOP, payload: {} }, deps);
    expect(await openAlerts(store.id)).toEqual([]);
  });

  it("reach every recipient and Slack even when one email fails", async () => {
    process.env.ALERT_SLACK_WEBHOOK_URL = "https://hooks.slack.test/x";
    resetEnvCache();
    try {
      const store = await makeStore("syncing", ["bounces@r.com", "admin@r.com"]);
      mailer = {
        async send(to, subject, text) {
          if (to === "bounces@r.com") throw new Error("sender refused");
          await sent.send(to, subject, text);
        },
      };
      const slack: string[] = [];
      await syncOnce(store, "shop", async (input, init) => {
        if (String(input).startsWith("https://hooks.slack.test")) {
          slack.push(String(init?.body));
          return new Response("ok");
        }
        return shopBroken(input, init);
      });
      // Before: the first refused address aborted the loop, so neither of these happened.
      expect(sent.sent.map((s) => s.to)).toEqual(["admin@r.com"]);
      expect(slack).toHaveLength(1);
    } finally {
      delete process.env.ALERT_SLACK_WEBHOOK_URL;
      resetEnvCache();
    }
  });
});

describe("a sync job that gives up", () => {
  it("does not mark a healthy store broken over a catalog refresh", async () => {
    const store = await makeStore("active");
    await syncOnce(store, "products", shopBroken);
    expect(await storeStatus(store.id)).toBe("active");
    expect((await openAlerts(store.id)).map((a) => [a.severity, a.code])).toEqual([["warning", "sync_products_failed"]]);
  });

  it("marks the store broken when Shopify refuses our credentials", async () => {
    const store = await makeStore("active");
    await syncOnce(store, "products", async () => new Response("unauthorized", { status: 401 }));
    expect(await storeStatus(store.id)).toBe("error");
    expect((await openAlerts(store.id)).map((a) => a.severity)).toEqual(["critical"]);
  });

  it("marks an import in progress as broken", async () => {
    const store = await makeStore("syncing");
    await syncOnce(store, "products", shopBroken);
    expect(await storeStatus(store.id)).toBe("error");
  });

  it("leaves a store that was uninstalled mid-sync uninstalled", async () => {
    // Uninstalling revokes the token, so a sync in flight gets a 401 at the same moment the
    // app/uninstalled webhook marks the store. The failure used to flip it to `error`, which the
    // dashboard's auto-refresh then kept re-importing every 30 minutes, for a store that is gone.
    const store = await makeStore("active");
    await syncOnce(store, "products", async () => {
      await systemDb.store.update({ where: { id: store.id }, data: { status: "uninstalled" } });
      return new Response("unauthorized", { status: 401 });
    });
    expect(await storeStatus(store.id)).toBe("uninstalled");
  });
});

describe("app_subscriptions/update", () => {
  const CURRENT = "gid://shopify/AppSubscription/1";
  const NEXT = "gid://shopify/AppSubscription/2";
  let ws: string;
  beforeEach(async () => {
    ws = (await systemDb.workspace.create({ data: { name: "B" } })).id;
    await systemDb.subscription.create({ data: { workspaceId: ws, plan: "growth", status: "active", shopifyChargeId: CURRENT, pendingPlan: "scale", pendingChargeId: NEXT } });
  });
  afterEach(async () => {
    await systemDb.subscription.deleteMany({ where: { workspaceId: ws } });
  });
  const sub = () => systemDb.subscription.findUniqueOrThrow({ where: { workspaceId: ws } });

  it("switches plan only when Shopify activates the pending charge", async () => {
    await applySubscriptionUpdate(ws, NEXT, "pending");
    expect(await sub()).toMatchObject({ plan: "growth", pendingPlan: "scale" });
    await applySubscriptionUpdate(ws, NEXT, "active");
    expect(await sub()).toMatchObject({ plan: "scale", status: "active", shopifyChargeId: NEXT, pendingPlan: null, pendingChargeId: null });
    // The replaced charge's cancellation arrives afterwards and must not touch the new plan.
    await applySubscriptionUpdate(ws, CURRENT, "cancelled");
    expect(await sub()).toMatchObject({ plan: "scale", status: "active" });
  });

  it("keeps the plan in force when the change is declined", async () => {
    await applySubscriptionUpdate(ws, NEXT, "declined");
    expect(await sub()).toMatchObject({ plan: "growth", status: "active", pendingPlan: null, pendingChargeId: null });
  });

  it("drops to free when the charge in force ends", async () => {
    // Before: only `status` changed, so a cancelled Growth subscription stayed Growth.
    await applySubscriptionUpdate(ws, CURRENT, "cancelled");
    expect(await sub()).toMatchObject({ plan: "free", status: "active", shopifyChargeId: null, pendingPlan: "scale" });
  });

  it("keeps the new plan when the old charge's cancellation is processed at the same time as the activation", async () => {
    // Shopify sends both together when a plan change is approved. Processed concurrently, each
    // read the row before the other wrote; the cancellation's unconditional write then set the
    // workspace back to free after the new plan had been applied.
    for (let i = 0; i < 10; i++) {
      await systemDb.subscription.update({
        where: { workspaceId: ws },
        data: { plan: "growth", status: "active", shopifyChargeId: CURRENT, pendingPlan: "scale", pendingChargeId: NEXT },
      });
      await Promise.all([applySubscriptionUpdate(ws, NEXT, "active"), applySubscriptionUpdate(ws, CURRENT, "cancelled")]);
      expect(await sub()).toMatchObject({ plan: "scale", status: "active", shopifyChargeId: NEXT, pendingPlan: null, pendingChargeId: null });
    }
  });
});
