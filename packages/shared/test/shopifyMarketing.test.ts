import { describe, expect, it } from "vitest";
import { redactOverview, type MemberAccess } from "../src/access";
import { adPlatformSources, type AdSourceFacts } from "../src/adsFromShopify";
import { marketingFigures, marketingPlatform, marketingReports, marketingSpendPeriod, shopifyMarketing, type MarketingRow, type MarketingSyncState } from "../src/shopifyMarketing";

const range = { from: "2026-10-01", to: "2026-10-03" };
const compared = { from: "2026-09-28", to: "2026-09-30" };
const sync: MarketingSyncState = { lastSyncedAt: "2026-10-04T01:00:00.000Z", coveredFrom: "2026-07-06", syncedThrough: "2026-10-04", backfilled: false, error: null, lastAttemptAt: "2026-10-04T01:00:00.000Z" };

const row = (over: Partial<MarketingRow>): MarketingRow => ({
  day: "2026-10-01",
  channel: "Meta Ads",
  app: "Facebook & Instagram",
  campaign: null,
  spend: null,
  impressions: null,
  clicks: null,
  orders: null,
  sales: null,
  newCustomers: null,
  ...over,
});

const rows: MarketingRow[] = [
  row({ day: "2026-10-01", spend: 40, impressions: 10000, clicks: 200, orders: 4, sales: 320, newCustomers: 2 }),
  row({ day: "2026-10-02", spend: 60, impressions: 15000, clicks: 300, orders: 6, sales: 480, newCustomers: 3 }),
  // Its campaigns: only ever the breakdown, never added to the day's totals again.
  row({ day: "2026-10-01", campaign: "Diwali", spend: 40, impressions: 10000, clicks: 200, orders: 4, sales: 320 }),
  row({ day: "2026-10-02", campaign: "Diwali", spend: 25, clicks: 120, sales: 200 }),
  row({ day: "2026-10-02", campaign: "Retargeting", spend: 35, clicks: 180, sales: 280 }),
  // Google's app reports clicks but no spend.
  row({ day: "2026-10-02", channel: "Google Ads", app: "Google & YouTube", spend: 0, impressions: 900, clicks: 30 }),
  // Another channel with spend, and an email app with none (not advertising).
  row({ day: "2026-10-03", channel: "TikTok", app: "TikTok", spend: 12.5, clicks: 40, sales: 50 }),
  row({ day: "2026-10-03", channel: "Klaviyo", app: "Klaviyo: Email Marketing & SMS", clicks: 80, sales: 90 }),
];
const lastDays = [
  { channel: "Meta Ads", app: "Facebook & Instagram", day: "2026-10-02" },
  { channel: "Google Ads", app: "Google & YouTube", day: "2026-10-02" },
  { channel: "TikTok", app: "TikTok", day: "2026-10-03" },
  { channel: "Klaviyo", app: "Klaviyo: Email Marketing & SMS", day: "2026-10-03" },
];

const ask = (over: Partial<Parameters<typeof shopifyMarketing>[0]> = {}) =>
  shopifyMarketing({ rows, previousRows: null, lastDays, range, compared, currency: "AUD", sync, ...over });

describe("which platform a Shopify marketing channel is", () => {
  it("knows Meta and Google by the channel Shopify names or the app that reported it", () => {
    expect(marketingPlatform("Meta Ads")).toBe("meta");
    expect(marketingPlatform("Facebook & Instagram")).toBe("meta");
    expect(marketingPlatform(null, "Facebook & Instagram")).toBe("meta");
    expect(marketingPlatform("Instagram")).toBe("meta");
    expect(marketingPlatform("Google Ads")).toBe("google");
    expect(marketingPlatform("Shopping campaigns", "Google & YouTube")).toBe("google");
    expect(marketingPlatform("YouTube")).toBe("google");
    expect(marketingPlatform("TikTok")).toBe("other");
    expect(marketingPlatform("Shopify Email", "Shopify Email")).toBe("other");
    // A word inside another isn't the platform.
    expect(marketingPlatform("Metaverse Ads")).toBe("other");
  });
});

describe("the figures a channel reported, and the rates from them", () => {
  it("adds them up and works out CTR, CPC, CPM, ROAS, cost per order and per new customer", () => {
    const f = marketingFigures(rows.slice(0, 2));
    expect(f).toMatchObject({ spend: 100, impressions: 25000, clicks: 500, orders: 10, sales: 800, newCustomers: 5 });
    expect(f.ctr).toBeCloseTo(0.02);
    expect(f.cpc).toBeCloseTo(0.2);
    expect(f.cpm).toBeCloseTo(4);
    expect(f.roas).toBeCloseTo(8);
    expect(f.costPerOrder).toBeCloseTo(10);
    expect(f.costPerNewCustomer).toBeCloseTo(20);
  });

  it("sets spend only against the clicks and sales of the rows that reported it", () => {
    // Another activity of the platform reported sales and clicks but no spend: not counted against the spend.
    const f = marketingFigures([row({ spend: 50, clicks: 100, impressions: 5000, sales: 200 }), row({ channel: "Facebook", clicks: 900, sales: 1800 })]);
    expect(f).toMatchObject({ spend: 50, clicks: 1000, sales: 2000 });
    expect(f.roas).toBeCloseTo(4);
    expect(f.cpc).toBeCloseTo(0.5);
    expect(f.cpm).toBeCloseTo(10);
  });

  it("never turns a figure the channel didn't report into 0, nor a 0 spend into a rate", () => {
    const f = marketingFigures([row({ spend: 0, clicks: 30, impressions: 900 })]);
    expect(f.spend).toBeNull();
    expect(f.cpc).toBeNull();
    expect(f.cpm).toBeNull();
    expect(f.roas).toBeNull();
    expect(f.sales).toBeNull();
    expect(f.ctr).toBeCloseTo(30 / 900);
    expect(marketingFigures([])).toMatchObject({ spend: null, impressions: null, clicks: null, orders: null, sales: null });
  });
});

describe("the Shopify marketing module", () => {
  it("gives Meta's reported figures, its campaigns apart, and Google's clicks without a spend", () => {
    const m = ask();
    expect(m.status).toBe("ready");
    expect(m.source).toBe("shopify_marketing");
    const [meta, google] = m.platforms;
    expect(meta).toMatchObject({ platform: "meta", name: "Meta Ads", availability: "reported", apps: ["Facebook & Instagram"], channels: ["Meta Ads"] });
    expect(meta!.totals).toMatchObject({ spend: 100, clicks: 500, sales: 800 });
    expect(meta!.campaigns).toEqual([
      { campaign: "Diwali", spend: 65, impressions: 10000, clicks: 320, orders: 4, sales: 520, roas: 8 },
      { campaign: "Retargeting", spend: 35, impressions: null, clicks: 180, orders: null, sales: 280, roas: 8 },
    ]);
    expect(google).toMatchObject({ platform: "google", availability: "no_spend", lastDay: "2026-10-02" });
    expect(google!.totals).toMatchObject({ spend: null, clicks: 30, impressions: 900 });
    expect(marketingReports(m, "meta")).toBe(true);
    expect(marketingReports(m, "google")).toBe(false);
  });

  it("lists other channels only when they reported ad spend, and adds every reported spend together", () => {
    const m = ask();
    expect(m.others.map((g) => g.name)).toEqual(["TikTok"]);
    expect(m.others[0]!.totals).toMatchObject({ spend: 12.5, clicks: 40, sales: 50 });
    expect(m.reportedSpend).toBe(112.5);
  });

  it("says a platform that never reported to Shopify is unavailable, with no figure at all", () => {
    const m = ask({ rows: rows.filter((r) => r.channel !== "Google Ads"), lastDays: lastDays.filter((l) => l.channel !== "Google Ads") });
    const google = m.platforms[1]!;
    expect(google.availability).toBe("unavailable");
    expect(google.totals).toBeNull();
    expect(google.daily.every((d) => d.spend === null && d.clicks === null)).toBe(true);
  });

  it("gives every day: a read day with nothing reported as 0, a day not read yet as unknown", () => {
    const [meta] = ask().platforms;
    expect(meta!.daily.map((d) => d.spend)).toEqual([40, 60, 0]);
    const [late] = ask({ sync: { ...sync, coveredFrom: "2026-10-02" } }).platforms;
    expect(late!.daily.map((d) => d.spend)).toEqual([null, 60, 0]);
    expect(ask({ sync: { ...sync, coveredFrom: "2026-10-02" } }).from).toBe("2026-10-02");
    // No spend reported: the spend stays unknown every day, even where clicks came in.
    expect(ask().platforms[1]!.daily.map((d) => d.spend)).toEqual([null, null, null]);
  });

  it("counts only the days read with none missing: a day not read yet is unknown, not 0", () => {
    // Read up to 2 October: the 3rd is unknown, and nothing of it is counted.
    const m = ask({ sync: { ...sync, syncedThrough: "2026-10-02" } });
    expect(m.through).toBe("2026-10-02");
    expect(m.platforms[0]!.daily.map((d) => d.spend)).toEqual([40, 60, null]);
    expect(m.others).toEqual([]);
    expect(m.reportedSpend).toBe(100);
    // A day it reported clicks without spend: that day's spend unknown.
    const g = ask({ rows: [row({ day: "2026-10-01", spend: 10 }), row({ day: "2026-10-02", clicks: 5 })], lastDays }).platforms[0]!;
    expect(g.daily.map((d) => d.spend)).toEqual([10, null, 0]);
    // Nothing read yet in the dates.
    expect(ask({ sync: { ...sync, syncedThrough: "2026-09-30" } })).toMatchObject({ from: null, through: null, reportedSpend: null });
  });

  it("compares with the dates before when given them", () => {
    const before = [row({ day: "2026-09-29", spend: 50, clicks: 250, sales: 400 })];
    const m = ask({ previousRows: before });
    expect(m.compared).toEqual(compared);
    expect(m.platforms[0]!.previous).toMatchObject({ spend: 50 });
    expect(m.platforms[0]!.deltas.spend).toBeCloseTo(1);
    expect(m.platforms[0]!.deltas.roas).toBeCloseTo(0);
    expect(ask().compared).toBeNull();
    expect(ask().platforms[0]!.deltas.spend).toBeNull();
  });

  it("says why there are no figures: not read yet, or Shopify refused", () => {
    expect(ask({ rows: [], lastDays: [], sync: { ...sync, lastSyncedAt: null, coveredFrom: null } }).status).toBe("syncing");
    expect(ask({ rows: [], lastDays: [], sync: { ...sync, lastSyncedAt: null, coveredFrom: null, error: "access_denied" } }).status).toBe("access_denied");
    // A failed refresh after figures were read: the figures stay, the error is said beside them.
    expect(ask({ sync: { ...sync, error: "failed" } }).status).toBe("ready");
    expect(ask({ rows: [], lastDays: [] }).reportedSpend).toBeNull();
  });
});

describe("today's and this month's spend, whatever the dates", () => {
  // The store's today is 3 October; read through it.
  const month = [
    ...rows.filter((r) => r.campaign === null),
    row({ day: "2026-10-03", channel: "Google Ads", app: "Google & YouTube", spend: 7.25, clicks: 11 }),
    row({ day: "2026-10-03", channel: "Pinterest", app: "Pinterest", spend: 3 }),
  ];
  const current = (over: Partial<Parameters<typeof marketingSpendPeriod>[0]> = {}) =>
    marketingSpendPeriod({ rows: month, lastDays, period: { from: "2026-10-01", to: "2026-10-03" }, sync, ...over });

  it("gives Meta's, Google's and every channel's reported spend together, the others named", () => {
    expect(current()).toEqual({
      from: "2026-10-01",
      to: "2026-10-03",
      through: "2026-10-03",
      meta: { spend: 100, state: "reported" },
      google: { spend: 7.25, state: "reported" },
      others: [
        { name: "TikTok", spend: 12.5 },
        { name: "Pinterest", spend: 3 },
      ],
      total: 122.75,
    });
  });

  it("never makes a 0 of a platform with no spend: no spend reported, not reported by Shopify, or not read yet", () => {
    // Meta reported on the 1st and 2nd, nothing on the 3rd: no spend that day, not a 0.
    const today = current({ period: { from: "2026-10-03", to: "2026-10-03" } });
    expect(today.meta).toEqual({ spend: null, state: "no_spend" });
    expect(today.total).toBe(22.75);
    // Google's app never reported to Shopify at all.
    const never = current({ rows: month.filter((r) => r.channel !== "Google Ads"), lastDays: lastDays.filter((l) => l.channel !== "Google Ads") });
    expect(never.google).toEqual({ spend: null, state: "unavailable" });
    // Today isn't read yet: nothing of it is known, the month up to yesterday is.
    const late = { ...sync, syncedThrough: "2026-10-02" };
    expect(current({ period: { from: "2026-10-03", to: "2026-10-03" }, sync: late })).toMatchObject({ through: null, meta: { state: "not_read" }, google: { state: "not_read" }, others: [], total: null });
    expect(current({ sync: late })).toMatchObject({ through: "2026-10-02", meta: { spend: 100 }, google: { spend: null, state: "no_spend" }, total: 100 });
  });

  it("is worked out with the module from the store's today, beside whatever dates are picked", () => {
    const m = ask({ range: { from: "2026-09-01", to: "2026-09-07" }, current: { today: "2026-10-03", rows: month } });
    expect(m.current?.today).toMatchObject({ from: "2026-10-03", to: "2026-10-03", google: { spend: 7.25 }, total: 22.75 });
    expect(m.current?.month).toMatchObject({ from: "2026-10-01", to: "2026-10-03", meta: { spend: 100 }, total: 122.75 });
    expect(ask().current).toBeNull();
  });
});

describe("where Meta's and Google's figures come from, with what their apps report to Shopify", () => {
  const none: AdSourceFacts = { accounts: [], figures: false, hidden: 0, waiting: false };
  const connected: AdSourceFacts = { accounts: [{ status: "active", errorCode: null, accountStatus: null }], figures: true, hidden: 0, waiting: false };
  const lost: AdSourceFacts = { accounts: [{ status: "reconnect", errorCode: "auth_expired", accountStatus: null }], figures: false, hidden: 0, waiting: false };

  it("takes the reported spend for a platform not connected, never beside its own API", () => {
    expect(adPlatformSources({ meta: none, google: connected }, true, { meta: true, google: true })).toEqual([
      { provider: "meta", state: "not_connected", source: "shopify", marketing: true },
      { provider: "google", state: "connected", source: "platform" },
    ]);
    // Without the store's traffic sources: still the reported spend.
    expect(adPlatformSources({ meta: none, google: none }, false, { meta: true })).toEqual([
      { provider: "meta", state: "not_connected", source: "none", marketing: true },
      { provider: "google", state: "not_connected", source: "none" },
    ]);
  });

  it("falls back to the reported spend once a connection's access ends, and its own view without either", () => {
    expect(adPlatformSources({ meta: lost, google: none }, false, { meta: true })[0]).toEqual({ provider: "meta", state: "access_lost", source: "none", marketing: true });
    expect(adPlatformSources({ meta: lost, google: none }, false, {})[0]).toEqual({ provider: "meta", state: "access_lost", source: "platform" });
    // Days its API stored before still win.
    expect(adPlatformSources({ meta: { ...lost, figures: true }, google: none }, true, { meta: true })[0]).toEqual({ provider: "meta", state: "access_lost", source: "platform" });
  });
});

describe("Team & Access", () => {
  const member = (permissions: string[]): MemberAccess => ({ role: "custom", permissions });

  it("shows the reported figures with the ad figures, their campaigns only with the campaigns permission", () => {
    const report = { modules: { shopify_marketing: ask() } as Record<string, unknown>, capabilities: [] };
    const out = redactOverview(report, member(["marketing.ads"])) as unknown as { modules: { shopify_marketing?: ReturnType<typeof ask> } };
    expect(out.modules.shopify_marketing?.platforms[0]!.campaigns).toEqual([]);
    expect(out.modules.shopify_marketing?.platforms[0]!.totals?.spend).toBe(100);
    const both = redactOverview(report, member(["marketing.ads", "marketing.campaigns"])) as unknown as typeof out;
    expect(both.modules.shopify_marketing?.platforms[0]!.campaigns).toHaveLength(2);
    const neither = redactOverview(report, member(["analytics.sales"])) as unknown as typeof out;
    expect(neither.modules.shopify_marketing).toBeUndefined();
  });
});
