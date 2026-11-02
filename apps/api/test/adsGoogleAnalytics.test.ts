import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { systemDb } from "@app/db";
import { countGoogleAdsOperations, encryptAdTokens, googleAdsOperationsToday, pauseGoogleAds, type FetchLike } from "@app/core";
import { addDays, googleRowBlank, localDay, type GoogleReportMetrics } from "@app/shared";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * A real Google Ads account on the analytics page (routes/adsGoogleDemo.ts): its device and country
 * splits are the only figures there read from Google, and bizinsights' Google Ads operations are shared
 * by every merchant (2,880 a day on Explorer access). So they are asked of Google only once the
 * account's first sync has landed, read from the live Google Ads report's cache (the same keys, kept as
 * long) and cached for it, and not asked while the day's allowance is held back for the syncs.
 */

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));

/** Google's sign-in set up here, and Explorer's allowance (2,880 operations a day). */
const ENV = { GOOGLE_ADS_CLIENT_ID: "g_client", GOOGLE_ADS_CLIENT_SECRET: "g_secret", GOOGLE_ADS_ENABLED: "1", GOOGLE_ADS_DAILY_OPERATIONS: "" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let headers: Record<string, string>;
let ws: string;
let storeId: string;
/** Every call the app made out (Google's report requests). */
let calls: string[];

const metrics = (cost: number) => ({ costMicros: String(cost * 1_000_000), impressions: "1000", clicks: "40", conversions: 2, conversionsValue: 80 });
/** Google's answers for the splits: the account's own row, its devices, its countries and their codes. */
const google: FetchLike = async (input, init) => {
  const u = new URL(String(input));
  calls.push(u.pathname);
  if (!u.pathname.endsWith("googleAds:searchStream")) return json({ error: { message: `unexpected ${u.pathname}` } }, 400);
  const query = (JSON.parse(String(init?.body)) as { query: string }).query;
  if (query.includes("segments.device")) return json([{ results: [{ segments: { device: "MOBILE" }, metrics: metrics(30) }, { segments: { device: "DESKTOP" }, metrics: metrics(10) }] }]);
  if (query.includes("FROM user_location_view")) return json([{ results: [{ userLocationView: { countryCriterionId: "2036" }, metrics: metrics(40) }] }]);
  if (query.includes("FROM geo_target_constant")) return json([{ results: [{ geoTargetConstant: { id: "2036", countryCode: "AU" } }] }]);
  return json([{ results: [{ metrics: metrics(40) }] }]);
};

beforeEach(async () => {
  await clean(ctx);
  ctx.setEnv(ENV);
  calls = [];
  ctx.setFetch(google);
  const u = await signIn(ctx, "ga-owner", "owner@x.com");
  headers = u.headers;
  ws = await createWorkspace(ctx, headers);
  storeId = (await createStore(ws, "ga-shop.myshopify.com", ["read_orders"], { currency: "USD" })).id;
});

const get = (url: string) => ctx.app.inject({ method: "GET", url, headers });

/** A real Google Ads connection of the store, synced unless `data` says otherwise; its token lasts the day, so none is refreshed. */
function googleConnection(data: { status?: string; lastSyncedAt?: Date | null } = {}) {
  return systemDb.adConnection.create({
    data: {
      workspaceId: ws,
      storeId,
      provider: "google",
      accountId: "1234567890",
      accountName: "Shop Google ads",
      currency: "USD",
      timezone: "UTC",
      lastSyncedAt: new Date(),
      ...data,
      ...encryptAdTokens(storeId, "google", { accessToken: "G_ACCESS_SECRET", refreshToken: "G_REFRESH_SECRET", expiresAt: new Date(Date.now() + 86_400_000) }),
    },
  });
}

const analytics = (part: string, connection: string, from: string, to: string) => get(`/workspaces/${ws}/stores/${storeId}/ads/google/analytics${part}?${new URLSearchParams({ preset: "custom", from, to, connection })}`);
const download = (part: string, connection: string, from: string, to: string) =>
  get(`/workspaces/${ws}/stores/${storeId}/ads/google/analytics/export?${new URLSearchParams({ part, preset: "custom", from, to, connection })}`);
/** The live Google Ads report's cache key for the whole account's split (routes/ads.ts). */
const reportKey = (connection: string, level: string, from: string, to: string) => `ads-greport:v4:${connection}:${level}:-:-:${from}:${to}`;

describe("a real Google Ads account's device and country splits on the analytics page", () => {
  const today = () => localDay(new Date(), "UTC");

  it("before the account's first sync has landed, or while its syncs fail, Google is asked nothing: the page, its sections and its downloads say why", async () => {
    const fresh = await googleConnection({ lastSyncedAt: null });
    const [from, to] = [addDays(today(), -6), today()];
    // The page looks again every few seconds until the first sync lands: none of those looks reaches Google.
    for (let i = 0; i < 3; i++) {
      const res = await analytics("", fresh.id, from, to);
      expect(res.statusCode, res.body).toBe(200);
      const a = res.json();
      expect(a.account).toMatchObject({ demo: false, lastSyncedAt: null });
      expect(a.devices).toBeNull();
      expect(a.audience).toMatchObject({ devices: null, countries: null, note: expect.stringMatching(/once this account's first sync has finished/) });
    }
    expect((await analytics("/devices", fresh.id, from, to)).json()).toMatchObject({ devices: null, note: expect.stringMatching(/first sync/) });
    expect((await analytics("/audience", fresh.id, from, to)).json()).toMatchObject({ countries: null, note: expect.stringMatching(/first sync/) });
    const file = await download("devices", fresh.id, from, to);
    expect(file.statusCode, file.body).toBe(200);
    expect(file.body).toContain("once this account's first sync has finished");

    // Synced before, now asked to reconnect: the stored figures, and the splits not asked for.
    const ended = await systemDb.adConnection.update({ where: { id: fresh.id }, data: { status: "reconnect", lastSyncedAt: new Date() } });
    const res = await analytics("", ended.id, from, to);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ devices: null, audience: { countries: null, note: expect.stringMatching(/syncs fail: Settings → Advertising says why/) } });

    expect(calls).toEqual([]);
    expect(await googleAdsOperationsToday(ctx.deps.coord)).toBe(0);
  });

  it("once synced: read from Google once for the dates, under the live report's keys; asked again, the page, its sections, its downloads and the live report ask nothing more", async () => {
    const conn = await googleConnection();
    const [from, to] = [addDays(today(), -7), addDays(today(), -1)];
    const first = await analytics("", conn.id, from, to);
    expect(first.statusCode, first.body).toBe(200);
    const a = first.json();
    expect(a.devices.map((d: { name: string; share: number }) => [d.name, d.share])).toEqual([
      ["Phones", 0.75],
      ["Computers", 0.25],
    ]);
    expect(a.audience.devices).toEqual(a.devices);
    expect(a.audience.countries.map((d: { name: string; share: number }) => [d.name, d.share])).toEqual([["Australia", 1]]);
    const asked = calls.length;
    expect(asked).toBeGreaterThan(0);
    // Counted against the day's allowance like any report.
    expect(await googleAdsOperationsToday(ctx.deps.coord)).toBe(asked);
    expect(await ctx.deps.coord.peek(reportKey(conn.id, "device", from, to))).not.toBeNull();
    expect(await ctx.deps.coord.peek(reportKey(conn.id, "country", from, to))).not.toBeNull();

    // The same dates again: from the cache.
    const second = await analytics("", conn.id, from, to);
    expect(second.json().devices).toEqual(a.devices);
    expect(second.json().audience.countries).toEqual(a.audience.countries);
    expect((await analytics("/devices", conn.id, from, to)).json().devices).toEqual(a.devices);
    expect((await analytics("/audience", conn.id, from, to)).json().countries).toEqual(a.audience.countries);
    expect((await download("devices", conn.id, from, to)).body).toContain("Phones");
    expect((await download("audience", conn.id, from, to)).body).toContain("Australia");
    // The live report's device and country levels for these dates are the same answers.
    for (const level of ["device", "country"]) {
      const report = await get(`/workspaces/${ws}/stores/${storeId}/ads/google/report?${new URLSearchParams({ connection: conn.id, level, from, to })}`);
      expect(report.statusCode, report.body).toBe(200);
      expect(report.json().cached).toBe(true);
    }
    expect(calls).toHaveLength(asked);

    // Other dates are another report.
    expect((await analytics("", conn.id, addDays(from, -7), addDays(to, -7))).json().devices).toHaveLength(2);
    expect(calls).toHaveLength(asked * 2);
  });

  it("splits the live report cached are what the page shows, without asking Google", async () => {
    const conn = await googleConnection();
    const [from, to] = ["2026-09-01", "2026-09-30"];
    const g = (spend: number): GoogleReportMetrics => ({ spend, impressions: 1000, clicks: 50, ctr: 0.05, cpc: spend / 50, cpm: spend, conversions: 1, conversionRate: 0.02, costPerConversion: spend, conversionValue: 100, roas: 100 / spend });
    const report = (level: string, rows: Array<{ id: string; name: string; spend: number }>) => ({
      level,
      since: from,
      until: to,
      totals: g(rows.reduce((s, r) => s + r.spend, 0)),
      rows: rows.map((r) => ({ ...googleRowBlank(), ...g(r.spend), id: r.id, name: r.name })),
      truncated: false,
    });
    await ctx.deps.coord.put(reportKey(conn.id, "device", from, to), JSON.stringify(report("device", [{ id: "TABLET", name: "Tablets", spend: 9 }, { id: "MOBILE", name: "Phones", spend: 3 }])), 600);
    await ctx.deps.coord.put(reportKey(conn.id, "country", from, to), JSON.stringify(report("country", [{ id: "2554", name: "New Zealand", spend: 12 }])), 600);
    const res = await analytics("", conn.id, from, to);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().devices.map((d: { name: string; share: number }) => [d.name, d.share])).toEqual([
      ["Tablets", 0.75],
      ["Phones", 0.25],
    ]);
    expect(res.json().audience.countries.map((d: { name: string }) => d.name)).toEqual(["New Zealand"]);
    expect(calls).toEqual([]);
  });

  it("kept as the live report keeps them: 10 minutes while the dates take in today, an hour once they're over", async () => {
    const conn = await googleConnection();
    const put = vi.spyOn(ctx.deps.coord, "put");
    try {
      await analytics("", conn.id, addDays(today(), -6), today());
      await analytics("", conn.id, addDays(today(), -7), addDays(today(), -1));
      const kept = put.mock.calls.filter(([key]) => key.startsWith("ads-greport:")).map(([key, , ttl]) => [key, ttl]);
      expect(kept).toEqual(
        expect.arrayContaining([
          [reportKey(conn.id, "device", addDays(today(), -6), today()), 600],
          [reportKey(conn.id, "country", addDays(today(), -6), today()), 600],
          [reportKey(conn.id, "device", addDays(today(), -7), addDays(today(), -1)), 3600],
          [reportKey(conn.id, "country", addDays(today(), -7), addDays(today(), -1)), 3600],
        ]),
      );
      expect(kept).toHaveLength(4);
    } finally {
      put.mockRestore();
    }
  });

  it("on a miss, Google isn't asked once the day's allowance is down to the syncs' share, or used up; splits already read still show", async () => {
    const conn = await googleConnection();
    const read = [addDays(today(), -7), addDays(today(), -1)] as const;
    const other = [addDays(today(), -14), addDays(today(), -8)] as const;
    expect((await analytics("", conn.id, ...read)).json().devices).toHaveLength(2);
    const asked = calls.length;

    // 70% of Explorer's 2,880: the keyword reports' share, past which the syncs keep the rest.
    await countGoogleAdsOperations(ctx.deps.coord, 2016 - (await googleAdsOperationsToday(ctx.deps.coord)));
    const held = (await analytics("", conn.id, ...other)).json();
    expect(held).toMatchObject({ devices: null, audience: { countries: null, note: expect.stringMatching(/^Google's device and country splits are paused for a few hours so your Google Ads figures keep syncing/) } });
    expect((await analytics("", conn.id, ...read)).json().devices).toHaveLength(2);
    expect(calls).toHaveLength(asked);

    // Google said the allowance is used up.
    await pauseGoogleAds(ctx.deps.coord, null);
    expect((await analytics("", conn.id, ...other)).json().audience.note).toMatch(/bizinsights has used today's allowance of Google Ads requests/);
    expect((await analytics("", conn.id, ...read)).json().audience.countries).toHaveLength(1);
    expect(calls).toHaveLength(asked);
    // bizinsights' limit, not the account's.
    expect((await systemDb.adConnection.findUniqueOrThrow({ where: { id: conn.id } })).status).toBe("active");
  });
});
