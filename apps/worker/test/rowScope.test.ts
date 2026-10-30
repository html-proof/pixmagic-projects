import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectDb, onUnscopedSystemQuery, rowScope, systemDb, withDb } from "@app/db";
import { resetDb } from "@app/db/testing";
import { memoryBlobs, memoryCoord, memoryMailer, memoryQueues, type FetchLike } from "@app/core";
import { consume, CRON, inJobScope, jobWorkspace, runScheduled, type QueueMessage } from "../src/index.js";
import type { WorkerDeps } from "../src/handlers.js";

/**
 * Jobs and sweeps name their row scope (docs/system-database-role.md): a job sees its own
 * workspace, read from the row it is about; the cron's sweeps see every workspace, for their
 * listed reason. Nothing the worker runs is left unscoped.
 */

afterAll(async () => disconnectDb());
beforeEach(async () => resetDb());

async function twoStores() {
  const [a, b] = await Promise.all([systemDb.workspace.create({ data: { name: "A" } }), systemDb.workspace.create({ data: { name: "B" } })]);
  const store = (ws: string, shop: string) => systemDb.store.create({ data: { workspaceId: ws, shopDomain: shop, grantedScopes: [], status: "active", timezone: "UTC", pixelIngestKey: `pk_${shop}` } });
  const [storeA, storeB] = await Promise.all([store(a.id, "a.myshopify.com"), store(b.id, "b.myshopify.com")]);
  const connection = await systemDb.adConnection.create({ data: { workspaceId: a.id, storeId: storeA.id, provider: "meta", accountId: "act_1", accessTokenEnc: "sealed", tokenKeyVersion: 1 } });
  const event = await systemDb.webhookEvent.create({ data: { webhookId: "w1", topic: "orders/create", shopDomain: storeB.shopDomain, storeId: storeB.id, workspaceId: b.id } });
  return { wsA: a.id, wsB: b.id, storeA, storeB, connection, event };
}

describe("a job's workspace", () => {
  it("is read from the row the job is about", async () => {
    const { wsA, wsB, storeA, connection, event } = await twoStores();
    expect(await jobWorkspace("sync", { storeId: storeA.id, kind: "orders", syncJobId: "j" })).toBe(wsA);
    expect(await jobWorkspace("sync", { kind: "verify", storeId: storeA.id, reconciliationId: "r" })).toBe(wsA);
    expect(await jobWorkspace("sync", { kind: "ads", connectionId: connection.id })).toBe(wsA);
    expect(await jobWorkspace("aggregate", { storeId: storeA.id, days: [] })).toBe(wsA);
    expect(await jobWorkspace("webhooks", { eventId: event.id, topic: "orders/create", shop: "b.myshopify.com" })).toBe(wsB);
  });

  it("is none when the job's row names none, is gone, or the job carries no id", async () => {
    await twoStores();
    const orphan = await systemDb.webhookEvent.create({ data: { webhookId: "w2", topic: "shop/redact", shopDomain: "gone.myshopify.com" } });
    expect(await jobWorkspace("webhooks", { eventId: orphan.id })).toBeNull();
    expect(await jobWorkspace("sync", { storeId: "no-such-store", kind: "orders" })).toBeNull();
    expect(await jobWorkspace("whatsapp", { kind: "wapp_event", eventId: "e" })).toBeNull();
    expect(await jobWorkspace("smsEvents", { eventType: "TEXT_DELIVERED" })).toBeNull();
    expect(await jobWorkspace("sync", {})).toBeNull();
  });

  it("scopes the job to it, or across workspaces (the `job` reason) when there is none", async () => {
    const { wsA, storeA } = await twoStores();
    expect(await inJobScope("sync", { storeId: storeA.id, kind: "orders" }, async () => rowScope())).toEqual({ kind: "tenant", workspaceId: wsA });
    expect(await inJobScope("whatsapp", { kind: "wapp_event", eventId: "e" }, async () => rowScope())).toEqual({ kind: "all", workspaceId: "", reason: "job" });
  });

  it("doesn't fail the job when the lookup does: consume() is the one to notice the database is down", async () => {
    const down = await withDb({ system: "postgresql://nobody:nothing@127.0.0.1:1/none_test" }, () => inJobScope("sync", { storeId: "s", kind: "orders" }, async () => rowScope()));
    expect(down).toEqual({ kind: "all", workspaceId: "", reason: "job" });
  });
});

describe("the worker's entry points", () => {
  const deps: WorkerDeps = {
    coord: memoryCoord(),
    queues: memoryQueues(),
    payloads: memoryBlobs(),
    mailer: memoryMailer(),
    fetchImpl: (async () => {
      throw new Error("no network in this test");
    }) as FetchLike,
  };

  it("run no system query outside a row scope: a job, and a whole cron tick", async () => {
    const { storeA } = await twoStores();
    const unscoped: string[] = [];
    onUnscopedSystemQuery(() => unscoped.push(new Error().stack ?? ""));
    try {
      const msg: QueueMessage = { id: "m1", body: { storeId: storeA.id, days: ["2026-10-28"] }, attempts: 1, ack: () => {}, retry: () => {} };
      await consume("aggregate", msg, deps);
      await runScheduled(CRON.refreshTokens, deps);
      await runScheduled(CRON.reconcile, deps);
    } finally {
      onUnscopedSystemQuery(undefined);
    }
    expect(unscoped).toEqual([]);
  });
});
