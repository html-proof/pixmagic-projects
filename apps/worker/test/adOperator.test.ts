import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { disconnectDb, systemDb } from "@app/db";
import { resetDb } from "@app/db/testing";
import {
  adCheckWindow,
  checkAdConnectionFigures,
  checkAdFiguresDaily,
  encryptAdTokens,
  memoryBlobs,
  memoryCoord,
  memoryMailer,
  memoryQueues,
  recordAdFailure,
  resetEnvCache,
  type AdFailure,
  type AdsSyncData,
  type FetchLike,
} from "@app/core";
import { addDays, eachDay, localDay } from "@app/shared";
import { scheduleReconcile, type WorkerDeps } from "../src/handlers.js";
import { consume, type QueueMessage } from "../src/index.js";

/**
 * What the operator hears about ad connections, and merchants don't: the one log line when a
 * connection turns to needing the merchant (counted by an alarm), and the daily check of a settled
 * week of stored figures against what the platform reports for it.
 */

const queues = memoryQueues();
const coord = memoryCoord();
let fetchImpl: FetchLike;
let deps: WorkerDeps;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const KEYS = { META_APP_ID: "a", META_APP_SECRET: "s", GOOGLE_ADS_CLIENT_ID: "c", GOOGLE_ADS_CLIENT_SECRET: "cs", GOOGLE_ADS_ENABLED: "1" };

/** Every log line written, parsed. */
let lines: Array<Record<string, unknown>>;
let prevLevel: string | undefined;
const logged = (msg: string) => lines.filter((l) => l.msg === msg);

beforeAll(() => {
  Object.assign(process.env, KEYS);
  resetEnvCache();
  deps = { coord, queues, payloads: memoryBlobs(), mailer: memoryMailer(), fetchImpl: ((...a: Parameters<FetchLike>) => fetchImpl(...a)) as FetchLike };
});
afterAll(async () => disconnectDb());
beforeEach(async () => {
  await resetDb();
  queues.clear();
  coord.clear();
  fetchImpl = async (input) => {
    throw new Error(`unexpected fetch ${String(input)}`);
  };
  lines = [];
  prevLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "info";
  const keep = (line: unknown) => {
    if (String(line).startsWith("{")) lines.push(JSON.parse(String(line)) as Record<string, unknown>);
  };
  vi.spyOn(console, "log").mockImplementation(keep);
  vi.spyOn(console, "warn").mockImplementation(keep);
  vi.spyOn(console, "error").mockImplementation(keep);
});
afterEach(() => {
  vi.restoreAllMocks();
  process.env.LOG_LEVEL = prevLevel;
});

const today = () => localDay(new Date(), "UTC");

let stores = 0;
/** A working connection whose stored days run from 40 days back to today (the week checked included). */
async function connection(provider: "meta" | "google" | "adsense", over: Record<string, unknown> = {}) {
  const ws = await systemDb.workspace.create({ data: { name: "W" } });
  const n = ++stores;
  const store = await systemDb.store.create({ data: { workspaceId: ws.id, shopDomain: `s${n}.myshopify.com`, grantedScopes: ["read_orders"], status: "active", timezone: "UTC", pixelIngestKey: `pk-${n}` } });
  const enc = encryptAdTokens(store.id, provider, { accessToken: "ACCESS", refreshToken: provider === "meta" ? null : "REFRESH", expiresAt: new Date(Date.now() + (provider === "meta" ? 40 : 1) * 86_400_000) });
  const accountId = { meta: "act_1", google: "111", adsense: "pub-1" }[provider];
  return systemDb.adConnection.create({
    data: {
      workspaceId: ws.id,
      storeId: store.id,
      provider,
      accountId,
      currency: provider === "adsense" ? "AUD" : "USD",
      timezone: "UTC",
      lastSyncedAt: new Date(),
      historyFrom: addDays(today(), -40),
      syncedThrough: today(),
      ...enc,
      ...over,
    },
  });
}

type Conn = Awaited<ReturnType<typeof connection>>;
const weekOf = (c: Conn) => adCheckWindow(c)!;

/**
 * The week stored for a Meta account: one campaign every day (10.10 spent, 1,000 impressions, 50
 * clicks, 20 on the link, 2 purchases worth 80), the "Other campaigns" row on its first day (1.50),
 * and a day after the week that mustn't count. In all: 72.20, 7,000, 350, 140, 14 and 560.
 */
async function storeMetaWeek(c: Conn) {
  const w = weekOf(c);
  const base = { workspaceId: c.workspaceId, storeId: c.storeId, connectionId: c.id, provider: "meta", accountId: c.accountId, currency: "USD" };
  await systemDb.adCampaignDaily.createMany({
    data: [
      ...eachDay(w.since, addDays(w.until, 1)).map((day) => ({ ...base, campaignId: "7", campaignName: "Spring", day, spend: 10.1, impressions: 1000, clicks: 50, linkClicks: 20, purchases: 2, purchaseValue: 80 })),
      { ...base, campaignId: "other", campaignName: "Other campaigns (archived or deleted)", day: w.since, spend: 1.5, linkClicks: 0, purchases: 0, purchaseValue: 0 },
    ],
  });
}

/** Meta's account-level insights for the week, recording each request. */
function metaWeek(answer: Record<string, unknown>, asked: URL[] = []): FetchLike {
  return async (input) => {
    const u = new URL(String(input));
    asked.push(u);
    if (u.pathname === "/v26.0/act_1/insights") return json({ data: [answer] });
    throw new Error(`unexpected fetch ${u.pathname}`);
  };
}

const METAS_WEEK = {
  spend: "72.20",
  impressions: "7000",
  clicks: "350",
  inline_link_clicks: "140",
  actions: [{ action_type: "omni_purchase", value: "14" }],
  action_values: [{ action_type: "omni_purchase", value: "560" }],
};

describe("an ad connection that turns to needing the merchant", () => {
  const failure = (status: AdFailure["status"], code: AdFailure["code"]): AdFailure => ({ status, code, detail: null, retryable: false, retryAfterS: null });

  it("says so in one log line when it turns, not on every failure after", async () => {
    const conn = await connection("meta");
    await recordAdFailure(conn.id, failure("reconnect", "auth_expired"), "sync");
    expect(logged("ad connection needs the merchant")).toEqual([
      expect.objectContaining({ level: "warn", connectionId: conn.id, storeId: conn.storeId, provider: "meta", status: "reconnect", errorCode: "auth_expired", from: "sync" }),
    ]);
    // The next failure is still recorded, and said no more.
    await recordAdFailure(conn.id, failure("reconnect", "scope_missing"), "sync");
    expect(logged("ad connection needs the merchant")).toHaveLength(1);
    expect(await systemDb.adConnection.findUniqueOrThrow({ where: { id: conn.id } })).toMatchObject({ status: "reconnect", errorCode: "scope_missing", consecutiveFailures: 2 });
    // Waiting for another reason (this login lost the account) is a turn of its own.
    await recordAdFailure(conn.id, failure("permission", "no_access"), "report");
    expect(logged("ad connection needs the merchant").map((l) => [l.status, l.errorCode, l.from])).toEqual([
      ["reconnect", "auth_expired", "sync"],
      ["permission", "no_access", "report"],
    ]);
    // Ids and the code only: nothing the connection holds.
    expect(JSON.stringify(lines)).not.toContain("ACCESS");
    expect(JSON.stringify(lines)).not.toContain(conn.accessTokenEnc);
  });

  it("says nothing for a passing failure, nor for a connection whose connector left", async () => {
    const working = await connection("meta");
    await recordAdFailure(working.id, failure("error", "temporary"), "sync");
    const left = await connection("adsense", { status: "reconnect", errorCode: "connector_left" });
    await recordAdFailure(left.id, failure("permission", "no_access"), "sync");
    expect(logged("ad connection needs the merchant")).toEqual([]);
    expect((await systemDb.adConnection.findUniqueOrThrow({ where: { id: left.id } })).status).toBe("reconnect");
  });

  it("is said by the sync that meets ended access, once however often it is asked again", async () => {
    const conn = await connection("meta");
    fetchImpl = async () => json({ error: { message: "Invalid OAuth access token", type: "OAuthException", code: 190 } }, 400);
    for (const attempt of [1, 2]) {
      const m = { acked: false };
      const msg: QueueMessage = { id: `m${attempt}`, body: { kind: "ads", connectionId: conn.id, since: today(), until: today() } satisfies AdsSyncData, attempts: 1, ack: () => (m.acked = true), retry: () => {} };
      await consume("sync", msg, deps);
      expect(m.acked).toBe(true);
    }
    expect(logged("ad connection needs the merchant")).toEqual([expect.objectContaining({ connectionId: conn.id, provider: "meta", status: "reconnect", errorCode: "auth_expired" })]);
    // Each sync failed for good on its first attempt (no retry helps): the alarm on sync jobs counts
    // only those whose attempts ran out (attempts >= 6), and leaves this to the line above's alarm.
    expect(logged("sync job failed").map((l) => [l.final, l.attempts])).toEqual([
      [true, 1],
      [true, 1],
    ]);
  });
});

describe("the daily check of stored ad figures against the platform", () => {
  it("Meta: the stored week adds up to Meta's account totals for it, read once with the sync's attribution", async () => {
    const conn = await connection("meta");
    await storeMetaWeek(conn);
    const asked: URL[] = [];
    fetchImpl = metaWeek(METAS_WEEK, asked);
    const w = weekOf(conn);
    expect(w).toEqual({ since: addDays(today(), -14), until: addDays(today(), -8) });
    expect(await checkAdConnectionFigures(conn, { fetchImpl: deps.fetchImpl })).toEqual({ outcome: "match", ...w, currency: "USD", differences: [] });
    // One read of the whole account for exactly those days, totals only, each ad set's own attribution.
    expect(asked).toHaveLength(1);
    const q = asked[0]!.searchParams;
    expect([q.get("level"), JSON.parse(q.get("time_range")!), q.get("time_increment"), q.get("use_unified_attribution_setting")]).toEqual(["account", w, null, "true"]);
    expect(q.get("fields")).toContain("inline_link_clicks");
    expect(logged("ad figures match the platform")).toEqual([
      expect.objectContaining({ level: "info", provider: "meta", connectionId: conn.id, ...w, currency: "USD", fields: ["spend", "impressions", "clicks", "linkClicks", "purchases", "purchaseValue"] }),
    ]);
    expect(logged("ad figures differ from the platform")).toEqual([]);
  });

  it("Meta: a figure further off than 1% is logged with both sides; one within it is not", async () => {
    const conn = await connection("meta");
    await storeMetaWeek(conn);
    // Spend 10% off; impressions 0.5% off (Meta's own late corrections look like this).
    fetchImpl = metaWeek({ ...METAS_WEEK, spend: "80.00", impressions: "7035" });
    const res = await checkAdConnectionFigures(conn, { fetchImpl: deps.fetchImpl });
    expect(res).toMatchObject({ outcome: "differ", differences: [{ field: "spend", stored: 72.2, platform: 80, relative: -0.0975 }] });
    expect(logged("ad figures differ from the platform")).toEqual([
      expect.objectContaining({ level: "warn", provider: "meta", connectionId: conn.id, ...weekOf(conn), currency: "USD", field: "spend", stored: 72.2, platform: 80, relative: -0.0975 }),
    ]);
    expect(logged("ad figures match the platform")).toEqual([]);
    // Nothing changes on the connection and no merchant hears of it.
    expect(await systemDb.adConnection.findUniqueOrThrow({ where: { id: conn.id } })).toMatchObject({ status: "active", errorCode: null, consecutiveFailures: 0 });
    expect(await systemDb.alert.count()).toBe(0);
  });

  it("Meta: stored rows in another currency than the account's differ", async () => {
    const conn = await connection("meta");
    await storeMetaWeek(conn);
    await systemDb.adCampaignDaily.updateMany({ where: { connectionId: conn.id, campaignId: "other" }, data: { currency: "EUR" } });
    fetchImpl = metaWeek(METAS_WEEK);
    expect(await checkAdConnectionFigures(conn, { fetchImpl: deps.fetchImpl })).toMatchObject({ outcome: "differ", differences: [{ field: "currency", stored: "EUR,USD", platform: "USD", relative: null }] });
  });

  it("Meta: purchases and link clicks are compared only when every stored day has them", async () => {
    const conn = await connection("meta");
    await storeMetaWeek(conn);
    // A day stored before purchases were read: Meta's purchases (40, not the 14 stored) aren't compared.
    await systemDb.adCampaignDaily.updateMany({ where: { connectionId: conn.id, day: weekOf(conn).since }, data: { purchases: null, purchaseValue: null } });
    fetchImpl = metaWeek({ ...METAS_WEEK, actions: [{ action_type: "omni_purchase", value: "40" }], inline_link_clicks: "300" });
    expect(await checkAdConnectionFigures(conn, { fetchImpl: deps.fetchImpl })).toMatchObject({ outcome: "differ", differences: [{ field: "linkClicks", stored: 140, platform: 300 }] });
    // And one stored before link clicks were read: those aren't compared either.
    await systemDb.adCampaignDaily.updateMany({ where: { connectionId: conn.id, day: addDays(weekOf(conn).since, 1) }, data: { linkClicks: null } });
    lines = [];
    expect(await checkAdConnectionFigures(conn, { fetchImpl: deps.fetchImpl })).toMatchObject({ outcome: "match" });
    expect(logged("ad figures match the platform")[0]).toMatchObject({ fields: ["spend", "impressions", "clicks"] });
  });

  it("AdSense: every stored site against the report's totals for every site, in the report's currency", async () => {
    // The store shows one site; the account earns on two, and both are stored.
    const conn = await connection("adsense", { sites: ["a.com"] });
    const w = weekOf(conn);
    const base = { workspaceId: conn.workspaceId, storeId: conn.storeId, connectionId: conn.id, accountId: conn.accountId, currency: "AUD" };
    await systemDb.adsenseDaily.createMany({
      data: eachDay(w.since, w.until).flatMap((day) => [
        { ...base, site: "a.com", day, earnings: 5.25, pageViews: 300, impressions: 250, clicks: 6 },
        { ...base, site: "b.com", day, earnings: 1.25, pageViews: 100, impressions: 80, clicks: 2 },
      ]),
    });
    const asked: URL[] = [];
    const report = (earnings: string) => ({
      headers: [{ name: "DOMAIN_CODE", type: "DIMENSION" }, { name: "ESTIMATED_EARNINGS", type: "METRIC_CURRENCY", currencyCode: "AUD" }, { name: "PAGE_VIEWS" }, { name: "IMPRESSIONS" }, { name: "CLICKS" }],
      rows: [{ cells: [{ value: "a.com" }, { value: "36.75" }, { value: "2100" }, { value: "1750" }, { value: "42" }] }],
      // The totals row counts every matched row, also those a cut-off report leaves out.
      totals: { cells: [{}, { value: earnings }, { value: "2800" }, { value: "2310" }, { value: "56" }] },
    });
    let earnings = "45.50";
    fetchImpl = async (input) => {
      const u = new URL(String(input));
      asked.push(u);
      if (u.host === "adsense.googleapis.com" && u.pathname === "/v2/accounts/pub-1/reports:generate") return json(report(earnings));
      throw new Error(`unexpected fetch ${String(input)}`);
    };
    expect(await checkAdConnectionFigures(conn, { fetchImpl: deps.fetchImpl })).toEqual({ outcome: "match", ...w, currency: "AUD", differences: [] });
    const q = asked[0]!.searchParams;
    expect(q.has("filters")).toBe(false);
    expect([q.get("reportingTimeZone"), q.get("startDate.day"), q.get("endDate.day")]).toEqual(["ACCOUNT_TIME_ZONE", String(Number(w.since.slice(8))), String(Number(w.until.slice(8)))]);
    // AdSense later reports less than was stored.
    earnings = "40.00";
    expect(await checkAdConnectionFigures(conn, { fetchImpl: deps.fetchImpl })).toMatchObject({ outcome: "differ", differences: [{ field: "earnings", stored: 45.5, platform: 40, relative: 0.1375 }] });
    expect(logged("ad figures differ from the platform")).toEqual([expect.objectContaining({ provider: "adsense", connectionId: conn.id, field: "earnings", currency: "AUD" })]);
  });

  it("AdSense: an account AdSense won't split by site is checked against the totals of a report by platform", async () => {
    const conn = await connection("adsense");
    const w = weekOf(conn);
    // Stored as the sync stores such an account: its daily totals, under no site.
    const base = { workspaceId: conn.workspaceId, storeId: conn.storeId, connectionId: conn.id, accountId: conn.accountId, currency: "AUD" };
    await systemDb.adsenseDaily.createMany({ data: eachDay(w.since, w.until).map((day) => ({ ...base, site: "", day, earnings: 6.5, pageViews: 400, impressions: 330, clicks: 8 })) });
    const asked: string[][] = [];
    fetchImpl = async (input) => {
      const u = new URL(String(input));
      if (u.host !== "adsense.googleapis.com" || u.pathname !== "/v2/accounts/pub-1/reports:generate") throw new Error(`unexpected fetch ${String(input)}`);
      const dimensions = u.searchParams.getAll("dimensions");
      asked.push(dimensions);
      if (dimensions.includes("DOMAIN_CODE")) return json({ error: { code: 400, message: "Invalid dimension: DOMAIN_CODE.", status: "INVALID_ARGUMENT" } }, 400);
      return json({
        headers: [{ name: "PLATFORM_TYPE_CODE", type: "DIMENSION" }, { name: "PLATFORM_TYPE_NAME", type: "DIMENSION" }, { name: "ESTIMATED_EARNINGS", type: "METRIC_CURRENCY", currencyCode: "AUD" }, { name: "PAGE_VIEWS" }, { name: "IMPRESSIONS" }, { name: "CLICKS" }],
        rows: [
          { cells: [{ value: "HighEndMobile" }, { value: "High-end mobile devices" }, { value: "30.00" }, { value: "1800" }, { value: "1500" }, { value: "36" }] },
          { cells: [{ value: "Desktop" }, { value: "Desktop" }, { value: "15.50" }, { value: "1000" }, { value: "810" }, { value: "20" }] },
        ],
        totals: { cells: [{}, {}, { value: "45.50" }, { value: "2800" }, { value: "2310" }, { value: "56" }] },
      });
    };
    expect(await checkAdConnectionFigures(conn, { fetchImpl: deps.fetchImpl })).toEqual({ outcome: "match", ...w, currency: "AUD", differences: [] });
    expect(asked).toEqual([["DOMAIN_CODE"], ["PLATFORM_TYPE_CODE", "PLATFORM_TYPE_NAME"]]);
  });

  it("a platform that asks to wait skips the account until tomorrow, without failing the sweep", async () => {
    const conn = await connection("meta");
    await storeMetaWeek(conn);
    let calls = 0;
    fetchImpl = async () => {
      calls++;
      return json({ error: { message: "User request limit reached", code: 17 } }, 400);
    };
    expect(await checkAdFiguresDaily(deps)).toEqual({ checked: 0, differed: 0, skipped: 1, failed: 0 });
    expect(logged("ad figures not checked: the platform asked to wait")).toEqual([expect.objectContaining({ connectionId: conn.id, errorCode: "rate_limited" })]);
    // The next tick leaves it to tomorrow's check.
    fetchImpl = metaWeek(METAS_WEEK);
    expect(await checkAdFiguresDaily(deps)).toEqual({ checked: 0, differed: 0, skipped: 0, failed: 0 });
    expect(calls).toBe(1);
    // And the connection is as it was.
    expect(await systemDb.adConnection.findUniqueOrThrow({ where: { id: conn.id } })).toMatchObject({ status: "active", errorCode: null });
  });

  it("leaves out Google Ads (its daily allowance is shared), demos, and accounts it can't compare", async () => {
    const google = await connection("google");
    const demo = await connection("google", { isDemo: true, demoSeed: 1, accessTokenEnc: "" });
    // Connected five days ago: its stored days don't reach back to the week.
    await connection("meta", { historyFrom: addDays(today(), -5) });
    await connection("meta", { status: "reconnect", errorCode: "auth_expired" });
    await connection("meta", { enabled: false });
    await connection("meta", { accountStatus: "closed" });
    // Any fetch here would fail the test's sweep ("unexpected fetch").
    expect(await checkAdFiguresDaily(deps)).toEqual({ checked: 0, differed: 0, skipped: 0, failed: 0 });
    expect(await checkAdConnectionFigures(google)).toEqual({ outcome: "skipped", reason: "google" });
    expect(await checkAdConnectionFigures(demo)).toEqual({ outcome: "skipped", reason: "demo" });
  });

  it("runs once a day per account from the reconcile sweep; one account's failure doesn't stop the others", async () => {
    const failing = await connection("meta", { accountId: "act_9" });
    const fine = await connection("meta");
    await storeMetaWeek(fine);
    fetchImpl = async (input) => {
      const u = new URL(String(input));
      if (u.pathname === "/v26.0/act_9/insights") return json({ error: { message: "Service temporarily unavailable", code: 2 } }, 503);
      return metaWeek(METAS_WEEK)(input);
    };
    await scheduleReconcile(deps);
    expect(logged("ad figures match the platform")).toEqual([expect.objectContaining({ connectionId: fine.id })]);
    expect(logged("ad figures not checked")).toEqual([expect.objectContaining({ connectionId: failing.id, errorCode: "temporary" })]);
    expect(logged("ad figures checked against the platforms")).toEqual([expect.objectContaining({ checked: 1, differed: 0, failed: 1 })]);
    // The next tick: both are done for the day.
    lines = [];
    await scheduleReconcile(deps);
    expect(logged("ad figures match the platform")).toEqual([]);
    expect(logged("ad figures checked against the platforms")).toEqual([]);
  });

  it("runs even when a store's reconcile fails, which the reconcile still throws", async () => {
    const conn = await connection("meta");
    await storeMetaWeek(conn);
    fetchImpl = metaWeek(METAS_WEEK);
    const queueDown: WorkerDeps = {
      ...deps,
      queues: {
        ...queues,
        sync: {
          send: async () => {
            throw new Error("queue unreachable");
          },
        },
      },
    };
    await expect(scheduleReconcile(queueDown)).rejects.toThrow("queue unreachable");
    expect(logged("ad figures match the platform")).toEqual([expect.objectContaining({ connectionId: conn.id })]);
  });

  it("starts no account after its time budget", async () => {
    for (let i = 0; i < 3; i++) await storeMetaWeek(await connection("meta"));
    fetchImpl = metaWeek(METAS_WEEK);
    expect(await checkAdFiguresDaily(deps, { budgetMs: 0 })).toEqual({ checked: 0, differed: 0, skipped: 0, failed: 0 });
    // Nothing was leased: the next tick does them all, a few at a time.
    expect(await checkAdFiguresDaily(deps, { concurrency: 2 })).toEqual({ checked: 3, differed: 0, skipped: 0, failed: 0 });
  });
});
