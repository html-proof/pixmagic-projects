import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { disconnectDb, systemDb, toNumber } from "@app/db";
import { resetDb } from "@app/db/testing";
import {
  adsConfigured,
  countGoogleAdsOperations,
  encryptAdTokens,
  enqueueAdCatchUp,
  googleAdsOperationsToday,
  memoryBlobs,
  memoryCoord,
  memoryMailer,
  memoryQueues,
  pauseGoogleAds,
  releaseUserAdGrants,
  resetEnvCache,
  syncAdConnection,
  type AdsSyncData,
  type FetchLike,
} from "@app/core";
import { addDays, localDay } from "@app/shared";
import { ADS_HISTORY_STARTS_PER_TICK, scheduleAdsSync, sweepAdConnectionAlerts, type WorkerDeps } from "../src/handlers.js";
import { consume, CRON, runScheduled, type QueueMessage } from "../src/index.js";

/**
 * Ad syncs beyond storing one window: what a failure leaves (a code, never raw text), a disconnect
 * while a sync runs, holes and history, Google's daily allowance, the schedule's cadence, learning who
 * granted access, and the alerts the connections' state calls for.
 */

const queues = memoryQueues();
const coord = memoryCoord();
let fetchImpl: FetchLike;
let deps: WorkerDeps;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const KEYS = { META_APP_ID: "a", META_APP_SECRET: "s", GOOGLE_ADS_CLIENT_ID: "c", GOOGLE_ADS_CLIENT_SECRET: "cs", GOOGLE_ADS_ENABLED: "1" };

beforeAll(() => {
  Object.assign(process.env, KEYS);
  resetEnvCache();
  deps = { coord, queues, payloads: memoryBlobs(), mailer: memoryMailer(), fetchImpl: ((...a: Parameters<FetchLike>) => fetchImpl(...a)) as FetchLike };
});
afterAll(async () => disconnectDb());
beforeEach(async () => {
  Object.assign(process.env, KEYS);
  resetEnvCache();
  await resetDb();
  queues.clear();
  coord.clear();
  fetchImpl = async (input) => {
    throw new Error(`unexpected fetch ${String(input)}`);
  };
});

let stores = 0;
async function connection(provider: "meta" | "google" | "adsense", over: Record<string, unknown> = {}, tokens = { access: "ACCESS", refresh: "REFRESH" }) {
  const ws = await systemDb.workspace.create({ data: { name: "W" } });
  const n = ++stores;
  const store = await systemDb.store.create({ data: { workspaceId: ws.id, shopDomain: `s${n}.myshopify.com`, grantedScopes: ["read_orders"], status: "active", timezone: "UTC", pixelIngestKey: `pk-${n}` } });
  // Meta's long-lived token has weeks left; Google's hour-long one is still good.
  const expiresAt = new Date(Date.now() + (provider === "meta" ? 40 : 1) * 86_400_000);
  const enc = encryptAdTokens(store.id, provider, { accessToken: tokens.access, refreshToken: provider === "meta" ? null : tokens.refresh, expiresAt });
  const accountId = { meta: "act_1", google: "111", adsense: "pub-1" }[provider];
  return systemDb.adConnection.create({
    data: { workspaceId: ws.id, storeId: store.id, provider, accountId, accountName: "Shop ads", currency: provider === "adsense" ? null : "USD", timezone: "UTC", ...enc, ...over },
  });
}

function message(body: AdsSyncData, attempts = 1) {
  const m = { acked: false, retried: null as null | { delaySeconds?: number } };
  const msg: QueueMessage = { id: "m1", body, attempts, ack: () => (m.acked = true), retry: (o) => (m.retried = o ?? {}) };
  return { msg, m };
}

async function run(body: AdsSyncData, attempts = 1) {
  const { msg, m } = message(body, attempts);
  await consume("sync", msg, deps);
  return m;
}

const today = () => localDay(new Date(), "UTC");
const row = (id: string) => systemDb.adConnection.findUniqueOrThrow({ where: { id } });
const sent = () => queues.sent.sync as unknown as AdsSyncData[];

/**
 * Meta answering insights with no rows, and recording the date ranges asked for: the campaigns' in
 * `ranges`, the account's own totals (each window reads both) in `accountRanges`.
 */
function metaInsights(ranges: Array<{ since: string; until: string }>, extra: (u: URL) => Response | null = () => null, accountRanges: Array<{ since: string; until: string }> = []): FetchLike {
  return async (input) => {
    const u = new URL(String(input));
    const other = extra(u);
    if (other) return other;
    if (u.pathname.endsWith("/insights")) {
      (u.searchParams.get("level") === "account" ? accountRanges : ranges).push(JSON.parse(u.searchParams.get("time_range")!));
      return json({ data: [] });
    }
    return json({ error: { message: `unexpected ${u.pathname}`, code: 100 } }, 400);
  };
}

describe("what a failed sync leaves on its connection", () => {
  it("a failure that isn't the platform's keeps no text, only 'internal', and only once the retries ran out", async () => {
    const conn = await connection("google");
    // Google's report is fine; storing it isn't: the figure doesn't fit the column, and the database's
    // error (which names tables and types) must not reach the connection.
    fetchImpl = async () => json([{ results: [{ campaign: { id: "5", name: "Brand" }, segments: { date: today() }, metrics: { costMicros: "1e30", clicks: "4", impressions: "10" } }] }]);
    const first = await run({ kind: "ads", connectionId: conn.id, since: today(), until: today() }, 1);
    expect(first.retried).not.toBeNull();
    expect((await row(conn.id)).status).toBe("active");
    const last = await run({ kind: "ads", connectionId: conn.id, since: today(), until: today() }, 6);
    expect(last.acked).toBe(true);
    expect(await row(conn.id)).toMatchObject({ status: "error", errorCode: "internal", lastError: null, consecutiveFailures: 1 });
  });

  it("an answer from Google that isn't a report is Google's failure: recorded at once as a refusal, not retried", async () => {
    const conn = await connection("google");
    fetchImpl = async () => json({ unexpected: true });
    const m = await run({ kind: "ads", connectionId: conn.id, since: today(), until: today() }, 1);
    expect(m).toMatchObject({ acked: true, retried: null });
    expect(await row(conn.id)).toMatchObject({ status: "error", errorCode: "provider_error", consecutiveFailures: 1 });
  });

  it("the platform's own reason is kept without links or long ids, and a refusal isn't retried", async () => {
    const conn = await connection("google");
    const id = "x".repeat(40);
    fetchImpl = async () =>
      json([{ error: { code: 400, status: "INVALID_ARGUMENT", message: `Request ${id} is invalid, see https://console.developers.google.com/apis/api/googleads.googleapis.com/overview?project=123` } }], 400);
    const m = await run({ kind: "ads", connectionId: conn.id, since: today(), until: today() });
    expect(m).toMatchObject({ acked: true, retried: null });
    const after = await row(conn.id);
    expect(after).toMatchObject({ status: "error", errorCode: "provider_error", consecutiveFailures: 1 });
    expect(after.lastError).toContain("[link]");
    expect(after.lastError).not.toContain("https://");
    expect(after.lastError).not.toContain(id);
  });

  it("a sync that works clears it all, and records how far the stored days reach", async () => {
    const conn = await connection("meta", { status: "error", errorCode: "temporary", lastError: "Meta didn't answer", consecutiveFailures: 4, syncRequestedAt: new Date() });
    fetchImpl = metaInsights([]);
    await run({ kind: "ads", connectionId: conn.id, since: addDays(today(), -2), until: today() });
    expect(await row(conn.id)).toMatchObject({
      status: "active", errorCode: null, lastError: null, consecutiveFailures: 0, syncRequestedAt: null, historyFrom: addDays(today(), -2), syncedThrough: today(),
    });
  });
});

describe("storing an account's days", () => {
  it("keeps link clicks and purchases next to all clicks and conversions", async () => {
    const conn = await connection("meta");
    const d1 = addDays(today(), -1);
    fetchImpl = async () =>
      json({ data: [{ campaign_id: "7", campaign_name: "Spring", date_start: d1, spend: "12.5", impressions: "900", clicks: "30", inline_link_clicks: "12", actions: [{ action_type: "omni_purchase", value: "2" }], action_values: [{ action_type: "omni_purchase", value: "88" }] }] });
    await run({ kind: "ads", connectionId: conn.id, since: d1, until: today() });
    const [r] = await systemDb.adCampaignDaily.findMany({ where: { connectionId: conn.id } });
    expect([r!.clicks, r!.linkClicks, toNumber(r!.purchases!), toNumber(r!.purchaseValue!), toNumber(r!.conversions)]).toEqual([30, 12, 2, 88, 2]);
  });

  it("a disconnect while the sync runs leaves no days behind, and nothing is retried", async () => {
    const d1 = addDays(today(), -1);
    let calls = 0;
    /** The merchant presses Disconnect while the platform is still answering. */
    const disconnectingDuring = (provider: "meta" | "adsense", id: string): FetchLike => async () => {
      // Meta's sync reads the campaigns and the account's own totals: the row goes with the first
      // answer, and the second finds it gone already.
      calls++;
      await systemDb.adConnection.deleteMany({ where: { id } });
      if (provider === "meta") return json({ data: [{ campaign_id: "7", campaign_name: "Spring", date_start: d1, spend: "5", impressions: "9", clicks: "3" }] });
      return json({
        headers: [{ name: "DATE" }, { name: "DOMAIN_CODE" }, { name: "ESTIMATED_EARNINGS", type: "METRIC_CURRENCY", currencyCode: "AUD" }, { name: "PAGE_VIEWS" }, { name: "IMPRESSIONS" }, { name: "CLICKS" }],
        rows: [{ cells: [{ value: d1 }, { value: "shop.example.com" }, { value: "7.25" }, { value: "30" }, { value: "60" }, { value: "1" }] }],
      });
    };
    for (const provider of ["meta", "adsense"] as const) {
      // Storing the days meets the foreign key: the sync ends as "gone", not as a failure.
      calls = 0;
      const direct = await connection(provider);
      expect(await syncAdConnection(direct.id, d1, today(), disconnectingDuring(provider, direct.id), { queues, coord })).toEqual({ skipped: true, reason: "gone" });
      expect(calls).toBe(provider === "meta" ? 2 : 1);
      // Through the queue: acked, with nothing to retry and nothing queued after it.
      const conn = await connection(provider);
      fetchImpl = disconnectingDuring(provider, conn.id);
      expect(await run({ kind: "ads", connectionId: conn.id, since: d1, until: today() })).toEqual({ acked: true, retried: null });
      expect(sent()).toEqual([]);
    }
    expect(await systemDb.adCampaignDaily.count()).toBe(0);
    expect(await systemDb.adsenseDaily.count()).toBe(0);
  });

  it("the person who connected it leaving while the sync runs: the account keeps waiting for a reconnect, and says so", async () => {
    const conn = await connection("meta", { connectedByUserId: "user-1", externalUserId: "2001", status: "error", errorCode: "temporary", consecutiveFailures: 2 });
    const d1 = addDays(today(), -1);
    fetchImpl = async () => {
      // Their bizinsights account is deleted while Meta is still answering.
      await releaseUserAdGrants("user-1", undefined, async () => json({ success: true }));
      return json({ data: [{ campaign_id: "7", campaign_name: "Spring", date_start: d1, spend: "5", impressions: "9", clicks: "3" }] });
    };
    const m = await run({ kind: "ads", connectionId: conn.id, since: d1, until: today() });
    expect(m).toMatchObject({ acked: true, retried: null });
    expect(await row(conn.id)).toMatchObject({ status: "reconnect", errorCode: "connector_left", accessTokenEnc: "", consecutiveFailures: 2 });
    // The days fetched before it are kept, as a release keeps the others; the alert asks for a reconnect.
    expect(await systemDb.adCampaignDaily.count({ where: { connectionId: conn.id } })).toBe(1);
    await sweepAdConnectionAlerts(deps);
    expect(await systemDb.alert.findFirst({ where: { code: `ads_reconnect:${conn.id}`, resolvedAt: null } })).toMatchObject({ message: expect.stringContaining("no longer has access") });
  });
});

describe("holes and history", () => {
  it("a hole since the last day stored is fetched before the days asked for (an account back from 45 days in reconnect)", async () => {
    const conn = await connection("meta", { historyFrom: addDays(today(), -200), syncedThrough: addDays(today(), -45), lastSyncedAt: new Date(Date.now() - 45 * 86_400_000) });
    const ranges: Array<{ since: string; until: string }> = [];
    const accountRanges: Array<{ since: string; until: string }> = [];
    fetchImpl = metaInsights(ranges, undefined, accountRanges);
    await run({ kind: "ads", connectionId: conn.id, since: addDays(today(), -2), until: today() });
    // One window, read once by campaign and once for the account's own totals.
    expect(ranges).toEqual([{ since: addDays(today(), -44), until: today() }]);
    expect(accountRanges).toEqual(ranges);
    expect(await row(conn.id)).toMatchObject({ historyFrom: addDays(today(), -200), syncedThrough: today() });
  });

  it("a hole longer than 90 days is fetched 90 days at a time, each part queued once the one before it landed", async () => {
    const conn = await connection("meta", { historyFrom: addDays(today(), -759), syncedThrough: addDays(today(), -200) });
    const ranges: Array<{ since: string; until: string }> = [];
    const accountRanges: Array<{ since: string; until: string }> = [];
    fetchImpl = metaInsights(ranges, undefined, accountRanges);
    await run({ kind: "ads", connectionId: conn.id, since: addDays(today(), -2), until: today(), trigger: "schedule" });
    expect(ranges).toEqual([{ since: addDays(today(), -199), until: addDays(today(), -110) }]);
    expect((await row(conn.id)).syncedThrough).toBe(addDays(today(), -110));
    expect(sent()).toEqual([{ kind: "ads", connectionId: conn.id, since: addDays(today(), -109), until: today(), trigger: "schedule" }]);
    await run(sent()[0]!);
    expect(ranges[1]).toEqual({ since: addDays(today(), -109), until: addDays(today(), -20) });
    await run(sent()[1]!);
    expect(ranges).toEqual([
      { since: addDays(today(), -199), until: addDays(today(), -110) },
      { since: addDays(today(), -109), until: addDays(today(), -20) },
      { since: addDays(today(), -19), until: today() },
    ]);
    // Each window's account totals were read once, for the same days.
    expect(accountRanges).toEqual(ranges);
    expect(await row(conn.id)).toMatchObject({ historyFrom: addDays(today(), -759), syncedThrough: today() });
  });

  it("a hole Meta no longer reports moves history_from past it, so those days read as not stored rather than nothing spent", async () => {
    const conn = await connection("meta", { historyFrom: addDays(today(), -1500), syncedThrough: addDays(today(), -1300) });
    const ranges: Array<{ since: string; until: string }> = [];
    fetchImpl = metaInsights(ranges);
    await run({ kind: "ads", connectionId: conn.id, since: addDays(today(), -2), until: today() });
    expect(ranges[0]!.since).toBe(addDays(today(), -1119));
    expect(await row(conn.id)).toMatchObject({ historyFrom: addDays(today(), -1119), syncedThrough: addDays(today(), -1030) });
  });

  it("the first window starts the walk back through history; each window that lands queues the next, once", async () => {
    const conn = await connection("meta");
    const ranges: Array<{ since: string; until: string }> = [];
    fetchImpl = metaInsights(ranges);
    await run({ kind: "ads", connectionId: conn.id, since: addDays(today(), -89), until: today() });
    const first = sent().find((j) => j.trigger === "history")!;
    expect(first).toEqual({ kind: "ads", connectionId: conn.id, since: addDays(today(), -179), until: addDays(today(), -90), trigger: "history" });
    // A history window that lands doesn't touch the account's status or when it last updated.
    await systemDb.adConnection.update({ where: { id: conn.id }, data: { status: "error", errorCode: "temporary" } });
    await run(first);
    expect(await row(conn.id)).toMatchObject({ historyFrom: addDays(today(), -179), status: "error" });
    expect(sent().filter((j) => j.trigger === "history").map((j) => j.since)).toEqual([addDays(today(), -179), addDays(today(), -269)]);
    // The same window again (delivered twice) fetches nothing and queues nothing.
    const fetched = ranges.length;
    await run(first);
    expect(ranges).toHaveLength(fetched);
    expect(sent().filter((j) => j.trigger === "history")).toHaveLength(2);
  });

  it("an older history window that fails says nothing about the account now", async () => {
    const conn = await connection("meta", { historyFrom: addDays(today(), -89), syncedThrough: today() });
    fetchImpl = async () => json({ error: { message: "Unsupported request", code: 100 } }, 400);
    const m = await run({ kind: "ads", connectionId: conn.id, since: addDays(today(), -179), until: addDays(today(), -90), trigger: "history" });
    expect(m.acked).toBe(true);
    expect(await row(conn.id)).toMatchObject({ status: "active", errorCode: null, consecutiveFailures: 0 });
  });

  it("catching up: from a few days before the last day stored; Refresh again while one is on its way queues nothing", async () => {
    const conn = await connection("meta", { historyFrom: addDays(today(), -300), syncedThrough: addDays(today(), -30) });
    expect(await enqueueAdCatchUp(queues, conn, { interactive: true })).toEqual({ since: addDays(today(), -33), until: today() });
    expect(await enqueueAdCatchUp(queues, conn, { interactive: true })).toBeNull();
    expect(sent()).toEqual([{ kind: "ads", connectionId: conn.id, since: addDays(today(), -33), until: today(), trigger: "request" }]);
    expect((await row(conn.id)).syncRequestedAt).not.toBeNull();
    fetchImpl = metaInsights([]);
    await run(sent()[0]!);
    expect((await row(conn.id)).syncRequestedAt).toBeNull();
    // A requested sync that fails ends the wait too.
    await enqueueAdCatchUp(queues, conn, { interactive: true });
    fetchImpl = async () => json({ error: { message: "Error validating access token", code: 190 } }, 400);
    await run(sent()[1]!);
    expect(await row(conn.id)).toMatchObject({ status: "reconnect", errorCode: "auth_expired", syncRequestedAt: null });
  });
});

describe("Google Ads' daily allowance", () => {
  const googleRows: FetchLike = async (input) => {
    const u = new URL(String(input));
    if (u.host === "oauth2.googleapis.com" && u.pathname === "/tokeninfo") return json({ aud: "c", sub: "1" });
    return json([{ results: [] }]);
  };

  it("syncs count their operations; scheduled ones stop at 80% of the day's allowance, requested ones still run", async () => {
    const google = await connection("google", { createdAt: new Date(Date.now() - 2 * 3600_000) });
    const meta = await connection("meta", { createdAt: new Date(Date.now() - 2 * 3600_000) });
    fetchImpl = googleRows;
    await run({ kind: "ads", connectionId: google.id, since: today(), until: today() });
    const used = await googleAdsOperationsToday(coord);
    expect(used).toBeGreaterThanOrEqual(1);
    await countGoogleAdsOperations(coord, 2304 - used);
    expect(await scheduleAdsSync(deps)).toBe(1);
    expect(sent().filter((j) => j.trigger === "schedule").map((j) => j.connectionId)).toEqual([meta.id]);
    // A scheduled Google sync already queued holds back too, without a call to Google.
    let calls = 0;
    fetchImpl = async (...a) => (calls++, googleRows(...a));
    await run({ kind: "ads", connectionId: google.id, since: today(), until: today(), trigger: "schedule" });
    expect(calls).toBe(0);
    await run({ kind: "ads", connectionId: google.id, since: today(), until: today(), trigger: "request" });
    expect(calls).toBeGreaterThan(0);
  });

  it("while Google says the allowance is used up, Google syncs wait; a requested one says why without counting against the account", async () => {
    const conn = await connection("google");
    await pauseGoogleAds(coord, null);
    let calls = 0;
    fetchImpl = async () => (calls++, json([{ results: [] }]));
    const m = await run({ kind: "ads", connectionId: conn.id, since: today(), until: today() });
    expect(m.acked).toBe(true);
    expect(calls).toBe(0);
    expect(await row(conn.id)).toMatchObject({ status: "error", errorCode: "quota_exhausted", consecutiveFailures: 0 });
  });

  it("GOOGLE_ADS_ENABLED off stops new connections only: a connected account keeps syncing", async () => {
    process.env.GOOGLE_ADS_ENABLED = "";
    resetEnvCache();
    expect(adsConfigured().google).toBe(false);
    const conn = await connection("google", { accessTokenExpiresAt: new Date(Date.now() - 1000), externalUserId: "1" });
    fetchImpl = async (input) => {
      const u = new URL(String(input));
      if (u.host === "oauth2.googleapis.com") return json({ access_token: "NEW", expires_in: 3599 });
      return json([{ results: [{ campaign: { id: "5", name: "Brand" }, segments: { date: today() }, metrics: { costMicros: "3000000", clicks: "4", impressions: "10" } }] }]);
    };
    const m = await run({ kind: "ads", connectionId: conn.id, since: today(), until: today() });
    expect(m.acked).toBe(true);
    expect(await row(conn.id)).toMatchObject({ status: "active" });
    expect(await systemDb.adCampaignDaily.count({ where: { connectionId: conn.id } })).toBe(1);
  });
});

describe("the schedule", () => {
  it("leaves a new connection to its first sync for an hour", async () => {
    await connection("meta");
    expect(await scheduleAdsSync(deps)).toBe(0);
  });

  it("refreshes Google's recent days every 3 hours and Meta's hourly, and accounts that keep failing less often", async () => {
    const old = new Date(Date.now() - 2 * 3600_000);
    const g = await connection("google", { createdAt: old });
    const m = await connection("meta", { createdAt: old });
    const failing = await connection("meta", { createdAt: old, status: "error", consecutiveFailures: 3 });
    await connection("meta", { createdAt: old, status: "error", consecutiveFailures: 10 });
    // First tick: each account's daily re-check, with its health; Google's covers 90 days.
    expect(await scheduleAdsSync(deps)).toBe(4);
    expect(sent().find((j) => j.connectionId === g.id)).toMatchObject({ since: addDays(today(), -89), health: true, trigger: "schedule" });
    // Next tick: the recent days, except for the account that failed 10 times in a row (daily only).
    queues.clear();
    expect(await scheduleAdsSync(deps)).toBe(3);
    expect(sent().map((j) => j.connectionId).sort()).toEqual([g.id, m.id, failing.id].sort());
    // Two hours on: only the healthy Meta account is due again.
    const real = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => real() + 2 * 3600_000);
    try {
      queues.clear();
      expect(await scheduleAdsSync(deps)).toBe(1);
      expect(sent().map((j) => j.connectionId)).toEqual([m.id]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("starts walks back through history a few per tick, not every account's at once (as after a deploy)", async () => {
    const old = new Date(Date.now() - 2 * 3600_000);
    const ids: string[] = [];
    for (let i = 0; i < ADS_HISTORY_STARTS_PER_TICK + 2; i++) {
      ids.push((await connection("meta", { createdAt: old, lastSyncedAt: new Date(), historyFrom: addDays(today(), -89), syncedThrough: today() })).id);
    }
    const history = () => sent().filter((j) => j.trigger === "history").map((j) => j.connectionId);
    await scheduleAdsSync(deps);
    expect(history()).toHaveLength(ADS_HISTORY_STARTS_PER_TICK);
    // The next tick starts the rest; the walks on their way aren't started twice.
    await scheduleAdsSync(deps);
    expect(history()).toHaveLength(ADS_HISTORY_STARTS_PER_TICK + 2);
    expect(new Set(history())).toEqual(new Set(ids));
  });

  it("asks an account with nothing new to read only once a day whether it's back; one that is catches up", async () => {
    const old = new Date(Date.now() - 2 * 3600_000);
    const lost = await connection("meta", { createdAt: old, status: "permission", errorCode: "no_access", historyFrom: addDays(today(), -100), syncedThrough: addDays(today(), -10) });
    expect(await scheduleAdsSync(deps)).toBe(1);
    expect(sent()[0]).toMatchObject({ connectionId: lost.id, healthOnly: true, trigger: "schedule" });
    expect(await scheduleAdsSync(deps)).toBe(0);
    fetchImpl = async (input) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("/act_1")) return json({ account_status: 1, name: "Shop ads", currency: "USD", timezone_name: "UTC" });
      return json({ error: { message: "unexpected" } }, 400);
    };
    await run(sent()[0]!);
    // Readable again: the days it missed are fetched, and that sync is what puts it back to normal.
    expect(await row(lost.id)).toMatchObject({ status: "permission", errorCode: "no_access", accountStatus: "active" });
    expect(sent()[1]).toMatchObject({ connectionId: lost.id, since: addDays(today(), -13), until: today(), trigger: "schedule" });
    fetchImpl = metaInsights([]);
    await run(sent()[1]!);
    expect(await row(lost.id)).toMatchObject({ status: "active", errorCode: null, syncedThrough: today() });
  });

  it("an account readable again whose reports are still refused stays as it was, with its one alert, not a new one each day", async () => {
    const old = new Date(Date.now() - 2 * 3600_000);
    const lost = await connection("meta", { createdAt: old, status: "permission", errorCode: "no_access", historyFrom: addDays(today(), -100), syncedThrough: addDays(today(), -10) });
    expect(await sweepAdConnectionAlerts(deps)).toEqual({ raised: 1, resolved: 0 });
    // The account node answers; insights are refused (ads_read is still granted).
    fetchImpl = async (input) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("/act_1")) return json({ account_status: 1, name: "Shop ads", currency: "USD", timezone_name: "UTC" });
      if (u.pathname.endsWith("/me/permissions")) return json({ data: [{ permission: "ads_read", status: "granted" }] });
      return json({ error: { message: "(#10) Ad account owner has NOT grant ads_management or ads_read permission", code: 10 } }, 400);
    };
    for (let day = 0; day < 2; day++) {
      await run({ kind: "ads", connectionId: lost.id, since: today(), until: today(), trigger: "schedule", healthOnly: true });
      const catchUp = sent().filter((j) => !j.healthOnly).at(-1)!;
      expect(await run(catchUp)).toMatchObject({ acked: true, retried: null });
      expect(await row(lost.id)).toMatchObject({ status: "permission", errorCode: "no_access" });
      expect(await sweepAdConnectionAlerts(deps)).toEqual({ raised: 0, resolved: 0 });
    }
    expect(await systemDb.alert.count({ where: { code: `ads_reconnect:${lost.id}` } })).toBe(1);
  });

  it("Refresh on an account that is still closed ends with the look at it: nothing to catch up, no 'Synchronizing' left", async () => {
    const closed = await connection("meta", { status: "unavailable", errorCode: "account_closed", accountStatus: "closed", syncRequestedAt: new Date() });
    fetchImpl = async (input) => (new URL(String(input)).pathname.endsWith("/act_1") ? json({ account_status: 101, name: "Shop ads", currency: "USD", timezone_name: "UTC" }) : json({ error: { message: "unexpected" } }, 400));
    await run({ kind: "ads", connectionId: closed.id, since: today(), until: today(), healthOnly: true });
    expect(await row(closed.id)).toMatchObject({ status: "unavailable", accountStatus: "closed", syncRequestedAt: null });
    expect(sent()).toEqual([]);
  });

  it("the daily re-check keeps the account's status, name, currency and time zone; a health read that fails doesn't fail the sync", async () => {
    const conn = await connection("meta");
    fetchImpl = metaInsights([], (u) =>
      u.pathname.endsWith("/act_1") ? json({ account_status: 3, disable_reason: 3, name: "Renamed", currency: "EUR", timezone_name: "Europe/Paris" }) : null,
    );
    await run({ kind: "ads", connectionId: conn.id, since: addDays(today(), -29), until: today(), trigger: "schedule", health: true });
    expect(await row(conn.id)).toMatchObject({ status: "active", accountStatus: "payment_issue", accountName: "Renamed", currency: "EUR", timezone: "Europe/Paris" });
    fetchImpl = metaInsights([], (u) => (u.pathname.endsWith("/act_1") ? json({ error: { message: "Service temporarily unavailable", code: 2 } }, 500) : null));
    const m = await run({ kind: "ads", connectionId: conn.id, since: addDays(today(), -29), until: today(), trigger: "schedule", health: true });
    expect(m.acked).toBe(true);
    expect(await row(conn.id)).toMatchObject({ status: "active", accountStatus: "payment_issue" });
  });
});

describe("who granted access", () => {
  it("a Meta connection learns who granted it at its next sync, for every account of the same sign-in", async () => {
    const a = await connection("meta");
    const b = await systemDb.adConnection.create({ data: { ...(({ id: _i, createdAt: _c, updatedAt: _u, ...rest }) => rest)(a), accountId: "act_2" } });
    let lookups = 0;
    fetchImpl = metaInsights([], (u) => (u.pathname.endsWith("/me") ? (lookups++, json({ id: "5550001" })) : null));
    await run({ kind: "ads", connectionId: a.id, since: today(), until: today() });
    expect([(await row(a.id)).externalUserId, (await row(b.id)).externalUserId]).toEqual(["5550001", "5550001"]);
    await run({ kind: "ads", connectionId: b.id, since: today(), until: today() });
    expect(lookups).toBe(1);
  });
});

describe("ad connection alerts", () => {
  it("are raised once from a connection's state, worded by the app, and closed when it works again or is disconnected", async () => {
    const lost = await connection("meta", { status: "reconnect", errorCode: "auth_expired" });
    const expiring = await connection("meta", { accessTokenExpiresAt: new Date(Date.now() + 3 * 86_400_000) });
    // Ours to fix: nothing for the merchant.
    await connection("google", { status: "error", errorCode: "internal", consecutiveFailures: 12, lastSyncedAt: null, createdAt: new Date(Date.now() - 3 * 86_400_000) });
    expect(await sweepAdConnectionAlerts(deps)).toEqual({ raised: 2, resolved: 0 });
    const open = await systemDb.alert.findMany({ where: { resolvedAt: null }, orderBy: { code: "asc" } });
    expect(open.map((a) => a.code)).toEqual([`ads_expiring:${expiring.id}`, `ads_reconnect:${lost.id}`]);
    expect(open[1]).toMatchObject({ storeId: lost.storeId, workspaceId: lost.workspaceId, severity: "warning", message: expect.stringContaining('Meta ad account "Shop ads"') });
    // Again: nothing new.
    expect(await sweepAdConnectionAlerts(deps)).toEqual({ raised: 0, resolved: 0 });
    // The account works again; the other one is disconnected.
    fetchImpl = metaInsights([]);
    await run({ kind: "ads", connectionId: lost.id, since: today(), until: today() });
    expect(await systemDb.alert.count({ where: { code: `ads_reconnect:${lost.id}`, resolvedAt: null } })).toBe(0);
    await systemDb.adConnection.delete({ where: { id: expiring.id } });
    expect(await sweepAdConnectionAlerts(deps)).toEqual({ raised: 0, resolved: 1 });
    // Wired into the cron.
    coord.clear();
    expect(await runScheduled(CRON.refreshTokens, deps)).toMatchObject({ adAlerts: { raised: 0, resolved: 0 } });
  });
});
