import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { disconnectDb, systemDb } from "@app/db";
import { resetDb } from "@app/db/testing";
import { encryptAdTokens, memoryBlobs, memoryCoord, memoryMailer, memoryQueues, resetEnvCache, type AdsSyncData, type FetchLike } from "@app/core";
import { scheduleAdsSync, type WorkerDeps } from "../src/handlers.js";

/**
 * The schedule's daily re-check of an AdSense account: AdSense finalizes a month's estimated earnings in
 * the first days of the next, so in days 1 to 10 of the account's month the re-check fetches the whole
 * month before (recheckDays in core's sync.ts); after the 10th, the usual 30 days.
 */

const queues = memoryQueues();
const coord = memoryCoord();
let deps: WorkerDeps;
const KEYS = { GOOGLE_ADS_CLIENT_ID: "c", GOOGLE_ADS_CLIENT_SECRET: "cs" };

beforeAll(() => {
  Object.assign(process.env, KEYS);
  resetEnvCache();
  const fetchImpl: FetchLike = async (input) => {
    throw new Error(`unexpected fetch ${String(input)}`);
  };
  deps = { coord, queues, payloads: memoryBlobs(), mailer: memoryMailer(), fetchImpl };
});
afterAll(async () => disconnectDb());
beforeEach(async () => {
  await resetDb();
  queues.clear();
  coord.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

let stores = 0;
async function connection(provider: "adsense" | "meta", timezone = "UTC") {
  const ws = await systemDb.workspace.create({ data: { name: "W" } });
  const n = ++stores;
  const store = await systemDb.store.create({ data: { workspaceId: ws.id, shopDomain: `s${n}.myshopify.com`, grantedScopes: ["read_orders"], status: "active", timezone: "UTC", pixelIngestKey: `pk-${n}` } });
  const enc = encryptAdTokens(store.id, provider, { accessToken: "ACCESS", refreshToken: provider === "meta" ? null : "REFRESH", expiresAt: new Date(Date.now() + 3_600_000) });
  // Synced before, so the schedule doesn't leave it to its first sync.
  return systemDb.adConnection.create({
    data: { workspaceId: ws.id, storeId: store.id, provider, accountId: provider === "meta" ? "act_1" : "pub-1", timezone, lastSyncedAt: new Date(), ...enc },
  });
}

/** The one sync the schedule sends for `provider`'s account (in `timezone`) at `at`. */
async function scheduledAt(at: string, provider: "adsense" | "meta" = "adsense", timezone = "UTC") {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at));
  queues.clear();
  coord.clear();
  const conn = await connection(provider, timezone);
  expect(await scheduleAdsSync(deps)).toBe(1);
  const sent = (queues.sent.sync as unknown as AdsSyncData[]).filter((m) => m.connectionId === conn.id);
  expect(sent).toHaveLength(1);
  await systemDb.adConnection.delete({ where: { id: conn.id } });
  vi.useRealTimers();
  return sent[0];
}

describe("the AdSense re-check early in a month", () => {
  it("fetches the whole month before, from its first day to today, with the account's health", async () => {
    // 1 November: all of October (31 days) and today.
    expect(await scheduledAt("2026-11-01T12:00:00Z")).toEqual({ kind: "ads", connectionId: expect.any(String), since: "2026-10-01", until: "2026-11-01", trigger: "schedule", health: true });
    expect(await scheduledAt("2026-11-05T12:00:00Z")).toMatchObject({ since: "2026-10-01", until: "2026-11-05", trigger: "schedule", health: true });
    // The 10th is the last such day.
    expect(await scheduledAt("2026-11-10T12:00:00Z")).toMatchObject({ since: "2026-10-01", until: "2026-11-10", trigger: "schedule", health: true });
    // January looks back into December of the year before.
    expect(await scheduledAt("2027-01-03T12:00:00Z")).toMatchObject({ since: "2026-12-01", until: "2027-01-03" });
  });

  it("goes back to the usual 30 days after the 10th", async () => {
    expect(await scheduledAt("2026-11-11T12:00:00Z")).toEqual({ kind: "ads", connectionId: expect.any(String), since: "2026-10-13", until: "2026-11-11", trigger: "schedule", health: true });
    expect(await scheduledAt("2026-11-29T12:00:00Z")).toMatchObject({ since: "2026-10-31", until: "2026-11-29" });
  });

  it("goes by the day of the month in the account's own time zone", async () => {
    // 05:00 UTC on 11 November is still the 10th in Los Angeles.
    expect(await scheduledAt("2026-11-11T05:00:00Z", "adsense", "America/Los_Angeles")).toMatchObject({ since: "2026-10-01", until: "2026-11-10" });
    // 14:00 UTC on 31 October is already 1 November in Melbourne.
    expect(await scheduledAt("2026-10-31T14:00:00Z", "adsense", "Australia/Melbourne")).toMatchObject({ since: "2026-10-01", until: "2026-11-01" });
  });

  it("never fetches less than the usual 30 days: on 1 March they already reach past 1 February", async () => {
    expect(await scheduledAt("2027-03-01T12:00:00Z")).toMatchObject({ since: "2027-01-31", until: "2027-03-01" });
  });

  it("is AdSense's alone: a Meta account re-checks 30 days on the same day", async () => {
    expect(await scheduledAt("2026-11-05T12:00:00Z", "meta")).toMatchObject({ since: "2026-10-07", until: "2026-11-05", trigger: "schedule", health: true });
  });
});
