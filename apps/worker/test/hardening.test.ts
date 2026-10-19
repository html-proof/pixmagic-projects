import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectDb, systemDb } from "@app/db";
import { resetDb } from "@app/db/testing";
import { encryptAdTokens, memoryBlobs, memoryCoord, memoryMailer, memoryQueues, purgeStoreData, resetEnvCache, type FetchLike } from "@app/core";
import { scheduleAdsSync, type WorkerDeps } from "../src/handlers.js";
import { prunePixelDedupe } from "../src/index.js";

/** Security audit 2026-10-14: background-job controls (docs/security/SECURITY_AUDIT.md). */

const queues = memoryQueues();
const coord = memoryCoord();
let calls: Array<{ url: string; body: string }> = [];
let deps: WorkerDeps;

beforeAll(() => {
  Object.assign(process.env, { META_APP_ID: "a", META_APP_SECRET: "s", GOOGLE_ADS_CLIENT_ID: "c", GOOGLE_ADS_CLIENT_SECRET: "cs", GOOGLE_ADS_ENABLED: "1" });
  resetEnvCache();
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ url: String(input), body: String(init?.body ?? "") });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  deps = { coord, queues, payloads: memoryBlobs(), mailer: memoryMailer(), fetchImpl };
});
afterAll(async () => disconnectDb());
beforeEach(async () => {
  await resetDb();
  queues.clear();
  coord.clear();
  calls = [];
});

async function storeWithGoogleAds(shop: string, externalUserId: string | null = "g-person-1") {
  const ws = await systemDb.workspace.create({ data: { name: "W" } });
  const store = await systemDb.store.create({ data: { workspaceId: ws.id, shopDomain: shop, grantedScopes: ["read_orders"], status: "active", timezone: "UTC", pixelIngestKey: `pk-${shop}` } });
  const tokens = encryptAdTokens(store.id, "google", { accessToken: "ACCESS", refreshToken: `REFRESH-${shop}`, expiresAt: new Date(Date.now() + 86_400_000) });
  // Synced before: a connection's very first sync is left to the one queued when it was connected.
  const conn = await systemDb.adConnection.create({
    data: { workspaceId: ws.id, storeId: store.id, provider: "google", accountId: "111", currency: "USD", timezone: "UTC", externalUserId, lastSyncedAt: new Date(Date.now() - 3600_000), ...tokens },
  });
  return { ws, store, conn };
}

describe("ad accounts of a store that left", () => {
  it("stop syncing while the store is uninstalled, and resume if it comes back", async () => {
    const { store } = await storeWithGoogleAds("gone.myshopify.com");
    await systemDb.store.update({ where: { id: store.id }, data: { status: "uninstalled" } });
    expect(await scheduleAdsSync(deps)).toBe(0);
    await systemDb.store.update({ where: { id: store.id }, data: { status: "active" } });
    expect(await scheduleAdsSync(deps)).toBe(1);
  });

  it("have their Google grant revoked when the store's data is purged, unless another store still uses it", async () => {
    const shared = await storeWithGoogleAds("one.myshopify.com", "g-shared");
    await storeWithGoogleAds("two.myshopify.com", "g-shared");
    await purgeStoreData(shared.store.id, deps.fetchImpl);
    expect(await systemDb.adConnection.count({ where: { storeId: shared.store.id } })).toBe(0);
    expect(calls.filter((c) => c.url === "https://oauth2.googleapis.com/revoke")).toHaveLength(0); // the other store relies on it

    const alone = await storeWithGoogleAds("three.myshopify.com", "g-alone");
    await purgeStoreData(alone.store.id, deps.fetchImpl);
    const revokes = calls.filter((c) => c.url === "https://oauth2.googleapis.com/revoke");
    expect(revokes).toHaveLength(1);
    expect(new URLSearchParams(revokes[0]!.body).get("token")).toBe("REFRESH-three.myshopify.com");
  });
});

describe("pixel dedupe pruning", () => {
  it("removes ids old enough that no event they'd dedupe can still be accepted, and keeps recent ones", async () => {
    const ws = await systemDb.workspace.create({ data: { name: "W" } });
    const store = await systemDb.store.create({ data: { workspaceId: ws.id, shopDomain: "p.myshopify.com", grantedScopes: [], status: "active", timezone: "UTC", pixelIngestKey: "pk-p" } });
    const old = new Date(Date.now() - 4 * 86_400_000);
    await systemDb.pixelEventSeen.createMany({
      data: [
        { storeId: store.id, eventId: "e:old1", seenAt: old },
        { storeId: store.id, eventId: "e:old2", seenAt: old },
        { storeId: store.id, eventId: "e:new", seenAt: new Date() },
      ],
    });
    expect(await prunePixelDedupe(1)).toBe(1); // bounded per tick
    expect(await prunePixelDedupe()).toBe(1);
    expect((await systemDb.pixelEventSeen.findMany()).map((r) => r.eventId)).toEqual(["e:new"]);
  });
});
