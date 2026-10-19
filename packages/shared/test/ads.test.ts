import { describe, expect, it } from "vitest";
import {
  accountCoverage,
  adComparisonWindows,
  adSeries,
  adsenseAccountId,
  adsenseSeries,
  adsenseSiteChosen,
  adsenseTotals,
  adTotals,
  campaignTotals,
  canCompareFrom,
  commonCoverage,
  coverageAfter,
  coveredPart,
  coversDays,
  isClosedAdAccount,
  lastWholeAdDay,
  sameDays,
  fromAdsenseReport,
  fromGoogleAdsRow,
  fromMetaInsight,
  fromMetaRangeInsight,
  metaAttributionLabel,
  metaReportMetrics,
  googleCustomerId,
  metaAccountId,
  previousRange,
  siteTotals,
  adErrorMessage,
  adsenseReportTotals,
  adStatusCode,
  adsVsSales,
  META_BREAKDOWN_PARAM,
  META_OBJECT_FIELDS,
  metaBudget,
  metaCountCampaign,
  metaObjectDetails,
  metaObjectiveLabel,
  metaStatusGroup,
  metaWords,
  minorUnitsPerUnit,
  noMetaCampaignCounts,
  trafficSourcePlatform,
  type AdDayRow,
  type AdsenseDayRow,
} from "../src/ads";

const row = (over: Partial<AdDayRow>): AdDayRow => ({
  provider: "meta",
  accountId: "act_1",
  campaignId: "c1",
  campaignName: "Spring",
  day: "2026-10-01",
  spend: 0,
  impressions: 0,
  clicks: 0,
  linkClicks: 0,
  conversions: 0,
  conversionValue: 0,
  purchases: 0,
  purchaseValue: 0,
  leads: 0,
  ...over,
});

describe("ad platform rows", () => {
  it("reads Meta insights without counting one purchase two or three times", () => {
    const r = fromMetaInsight("act_9", {
      campaign_id: "77",
      campaign_name: "Retargeting",
      date_start: "2026-10-03",
      spend: "12.345",
      impressions: "1000",
      clicks: "25",
      // Meta lists the same purchase under several overlapping types.
      actions: [
        { action_type: "link_click", value: "25" },
        { action_type: "offsite_conversion.fb_pixel_purchase", value: "2" },
        { action_type: "purchase", value: "2" },
        { action_type: "omni_purchase", value: "2" },
        { action_type: "lead", value: "1" },
      ],
      action_values: [
        { action_type: "purchase", value: "80.5" },
        { action_type: "omni_purchase", value: "80.5" },
      ],
    });
    expect(r).toEqual({
      provider: "meta",
      accountId: "act_9",
      campaignId: "77",
      campaignName: "Retargeting",
      day: "2026-10-03",
      spend: 12.35,
      impressions: 1000,
      clicks: 25,
      // Asked for but left out by Meta: no link clicks that day.
      linkClicks: 0,
      conversions: 2,
      conversionValue: 80.5,
      purchases: 2,
      purchaseValue: 80.5,
      leads: 1,
    });
    expect(fromMetaInsight("act_9", { date_start: "2026-10-03" })).toMatchObject({ spend: 0, conversions: 0, campaignId: "account" });
    expect(fromMetaInsight("act_9", { date_start: "2026-10-03", clicks: "30", inline_link_clicks: "12" }).linkClicks).toBe(12);
    // A row from a query that didn't ask for link clicks: unknown, not zero.
    expect(fromMetaInsight("act_9", { date_start: "2026-10-03", clicks: "30" }, {}).linkClicks).toBeNull();
  });

  it("reads Google Ads rows, turning micros into money", () => {
    expect(
      fromGoogleAdsRow("1234567890", {
        campaign: { id: "555", name: "Search - brand" },
        segments: { date: "2026-10-02" },
        metrics: { costMicros: "4567890", impressions: "320", clicks: "18", conversions: 1.5, conversionsValue: 99.999 },
      }),
    ).toEqual({
      provider: "google",
      accountId: "1234567890",
      campaignId: "555",
      campaignName: "Search - brand",
      day: "2026-10-02",
      spend: 4.57,
      impressions: 320,
      clicks: 18,
      linkClicks: 18,
      conversions: 1.5,
      conversionValue: 100,
      purchases: null,
      purchaseValue: null,
      leads: 0,
    });
    expect(fromGoogleAdsRow("1", { metrics: {} })).toBeNull();
    expect(googleCustomerId("123-456-7890")).toBe("1234567890");
    expect(metaAccountId("42")).toBe("act_42");
    expect(metaAccountId("act_42")).toBe("act_42");
  });
});

describe("ad totals", () => {
  const rows = [
    // Meta: clicks (all) include likes and comments; link clicks are the comparable figure.
    row({ day: "2026-10-01", spend: 10, impressions: 1000, clicks: 20, linkClicks: 12, conversions: 1, conversionValue: 50, purchases: 1, purchaseValue: 50 }),
    row({ day: "2026-10-03", spend: 30, impressions: 3000, clicks: 40, linkClicks: 28, conversions: 3, conversionValue: 150, purchases: 3, purchaseValue: 150, leads: 2 }),
    // Google: 4 conversions, of which 1 purchase (the rest leads and calls).
    row({ provider: "google", accountId: "9", campaignId: "g1", campaignName: "Search", day: "2026-10-03", spend: 20, impressions: 500, clicks: 30, linkClicks: 30, conversions: 4, conversionValue: 90, purchases: 1, purchaseValue: 40 }),
  ];

  it("adds up spend and works out the rates on link clicks and purchases, never on clicks (all) or every conversion", () => {
    expect(adTotals(rows)).toEqual({
      spend: 60,
      impressions: 4500,
      clicks: 90,
      linkClicks: 70,
      conversions: 8,
      conversionValue: 290,
      purchases: 5,
      purchaseValue: 240,
      leads: 2,
      ctr: 70 / 4500,
      cpc: 0.86,
      cpm: 13.33,
      costPerConversion: 7.5,
      costPerPurchase: 12,
      roas: 4,
    });
    expect(adTotals([])).toMatchObject({ spend: 0, linkClicks: 0, purchases: 0, ctr: null, cpc: null, cpm: null, costPerConversion: null, costPerPurchase: null, roas: null });
  });

  it("says nothing about link clicks or purchases while a day's aren't read yet, rather than a short count", () => {
    const older = [...rows, row({ day: "2026-09-30", spend: 5, impressions: 100, clicks: 9, linkClicks: null, purchases: null, purchaseValue: null })];
    const t = adTotals(older);
    expect(t).toMatchObject({ spend: 65, clicks: 99, linkClicks: null, ctr: null, cpc: null, purchases: null, purchaseValue: null, costPerPurchase: null, roas: null });
    // What every platform reports on every day still adds up.
    expect(t.conversions).toBe(8);
    expect(t.cpm).toBe(14.13);
  });

  it("charts every day of the range, with a day outside the stored days missing rather than 0", () => {
    expect(adSeries(rows, { from: "2026-10-01", to: "2026-10-04" })).toEqual([
      { day: "2026-10-01", spend: 10, clicks: 20, linkClicks: 12, impressions: 1000, conversions: 1, conversionValue: 50, purchases: 1, purchaseValue: 50 },
      { day: "2026-10-02", spend: 0, clicks: 0, linkClicks: 0, impressions: 0, conversions: 0, conversionValue: 0, purchases: 0, purchaseValue: 0 },
      { day: "2026-10-03", spend: 50, clicks: 70, linkClicks: 58, impressions: 3500, conversions: 7, conversionValue: 240, purchases: 4, purchaseValue: 190 },
      { day: "2026-10-04", spend: 0, clicks: 0, linkClicks: 0, impressions: 0, conversions: 0, conversionValue: 0, purchases: 0, purchaseValue: 0 },
    ]);
    // Stored up to the 3rd: the 4th isn't a quiet day, it isn't known.
    const series = adSeries(rows, { from: "2026-10-01", to: "2026-10-04" }, { from: "2026-09-01", through: "2026-10-03" });
    expect(series.map((d) => d.spend)).toEqual([10, 0, 50, null]);
    expect(series[3]).toEqual({ day: "2026-10-04", spend: null, impressions: null, clicks: null, linkClicks: null, conversions: null, conversionValue: null, purchases: null, purchaseValue: null });
    // Nothing stored at all: every day is missing.
    expect(adSeries([], { from: "2026-10-01", to: "2026-10-02" }, { from: null, through: null }).map((d) => d.spend)).toEqual([null, null]);
  });

  it("ranks campaigns by spend", () => {
    const top = campaignTotals([...rows, row({ day: "2026-10-04", campaignName: "Spring (renamed)", spend: 1 })]);
    expect(top.map((c) => [c.provider, c.name, c.spend])).toEqual([
      ["meta", "Spring (renamed)", 41],
      ["google", "Search", 20],
    ]);
    expect(previousRange({ from: "2026-10-01", to: "2026-10-04" })).toEqual({ from: "2026-09-27", to: "2026-09-30" });
  });
});

describe("what the stored days cover", () => {
  it("runs from an account's history start to the last day stored without a gap", () => {
    expect(accountCoverage({ historyFrom: "2026-07-21", syncedThrough: "2026-10-18" }, "2026-10-19")).toEqual({ from: "2026-07-21", through: "2026-10-18" });
    // Never synced, or a start without an end: nothing is covered, so nothing is shown as 0.
    expect(accountCoverage({ historyFrom: null, syncedThrough: null }, "2026-10-19")).toEqual({ from: null, through: null });
    expect(accountCoverage({ historyFrom: "2026-07-21", syncedThrough: null }, "2026-10-19")).toEqual({ from: null, through: null });
    // A closed account spends nothing after it closed: its zeros are real, up to its today.
    expect(accountCoverage({ historyFrom: "2026-07-21", syncedThrough: "2026-09-01", errorCode: "account_closed" }, "2026-10-19")).toEqual({ from: "2026-07-21", through: "2026-10-19" });
    expect(accountCoverage({ historyFrom: "2026-07-21", syncedThrough: "2026-09-01", accountStatus: "closed" }, "2026-10-19").through).toBe("2026-10-19");
    // Access ended or a failing sync: only what was stored.
    expect(accountCoverage({ historyFrom: "2026-07-21", syncedThrough: "2026-09-01", errorCode: "auth_expired" }, "2026-10-19").through).toBe("2026-09-01");
  });

  it("covers, for several accounts, only the days each of them has", () => {
    const a = { from: "2026-07-01", through: "2026-10-19" };
    const b = { from: "2026-08-15", through: "2026-10-16" };
    expect(commonCoverage([a, b])).toEqual({ from: "2026-08-15", through: "2026-10-16" });
    expect(commonCoverage([a, { from: null, through: null }])).toEqual({ from: null, through: null });
    expect(commonCoverage([])).toEqual({ from: null, through: null });
    // Ranges that don't meet cover nothing together.
    expect(commonCoverage([{ from: "2026-01-01", through: "2026-01-31" }, { from: "2026-03-01", through: "2026-03-31" }])).toEqual({ from: null, through: null });
    const both = commonCoverage([a, b]);
    expect(coversDays(both, { from: "2026-10-10", to: "2026-10-16" })).toBe(true);
    expect(coversDays(both, { from: "2026-10-13", to: "2026-10-19" })).toBe(false);
    expect(coveredPart(both, { from: "2026-10-13", to: "2026-10-19" })).toEqual({ from: "2026-10-13", to: "2026-10-16" });
    // A year asked for, 90 days held: the part held.
    expect(coveredPart({ from: "2026-07-21", through: "2026-10-19" }, { from: "2025-10-19", to: "2026-10-19" })).toEqual({ from: "2026-07-21", to: "2026-10-19" });
    expect(coveredPart(both, { from: "2026-01-01", to: "2026-01-31" })).toBeNull();
    expect(coveredPart({ from: null, through: null }, { from: "2026-01-01", to: "2026-01-31" })).toBeNull();
  });

  it("starts the days covered after a given day, and compares only from where they start", () => {
    const c = { from: "2026-07-21", through: "2026-10-19" };
    expect(coverageAfter(c, "2026-10-09")).toEqual({ from: "2026-10-10", through: "2026-10-19" });
    // A day before the start changes nothing; one on or after the end leaves nothing.
    expect(coverageAfter(c, "2026-06-01")).toEqual(c);
    expect(coverageAfter(c, "2026-10-19")).toEqual({ from: null, through: null });
    expect(coverageAfter({ from: null, through: null }, "2026-10-01")).toEqual({ from: null, through: null });
    expect(canCompareFrom(c, { from: "2026-07-21" })).toBe(true);
    expect(canCompareFrom(c, { from: "2026-07-20" })).toBe(false);
    expect(canCompareFrom({ from: null, through: null }, { from: "2026-10-01" })).toBe(false);
    expect(isClosedAdAccount({ errorCode: "account_closed" })).toBe(true);
    expect(isClosedAdAccount({ accountStatus: "closed" })).toBe(true);
    expect(isClosedAdAccount({ errorCode: "account_disabled", accountStatus: "disabled" })).toBe(false);
  });

  it("compares whole days only: a range reaching a running day loses it on both sides, and Today has nothing to compare", () => {
    const week = { from: "2026-10-13", to: "2026-10-19" };
    const before = { from: "2026-10-06", to: "2026-10-12" };
    // Today is the 19th: both sides lose their last day.
    expect(adComparisonWindows(week, before, "2026-10-18")).toEqual({ current: { from: "2026-10-13", to: "2026-10-18" }, previous: { from: "2026-10-06", to: "2026-10-11" }, trimmed: 1 });
    // A finished range compares as picked.
    expect(adComparisonWindows({ from: "2026-10-01", to: "2026-10-07" }, { from: "2026-09-24", to: "2026-09-30" }, "2026-10-18")).toEqual({
      current: { from: "2026-10-01", to: "2026-10-07" },
      previous: { from: "2026-09-24", to: "2026-09-30" },
      trimmed: 0,
    });
    // Today alone, or yesterday while an ad account's own day is still running.
    expect(adComparisonWindows({ from: "2026-10-19", to: "2026-10-19" }, { from: "2026-10-18", to: "2026-10-18" }, "2026-10-18")).toBeNull();
    expect(adComparisonWindows({ from: "2026-10-18", to: "2026-10-18" }, { from: "2026-10-17", to: "2026-10-17" }, "2026-10-17")).toBeNull();
    // Dates picked to compare with that are shorter than what's left out: nothing to compare.
    expect(adComparisonWindows(week, { from: "2026-09-01", to: "2026-09-01" }, "2026-10-18")).toBeNull();
    // The last day that is over everywhere: the store's yesterday, or earlier for an account whose day lags.
    expect(lastWholeAdDay("2026-10-19", [])).toBe("2026-10-18");
    expect(lastWholeAdDay("2026-10-19", ["2026-10-19", "2026-10-18"])).toBe("2026-10-17");
    expect(lastWholeAdDay("2026-10-19", ["2026-10-20"])).toBe("2026-10-18");
  });

  it("tells time zones with different days apart from ones that only have another name", () => {
    const now = new Date("2026-10-19T03:00:00Z");
    expect(sameDays("Australia/Melbourne", "Australia/Melbourne", now)).toBe(true);
    expect(sameDays("Australia/Melbourne", "Australia/Sydney", now)).toBe(true);
    expect(sameDays("Australia/Melbourne", "America/Los_Angeles", now)).toBe(false);
    // Same offset in one season only (Brisbane keeps no summer time): different days part of the year.
    expect(sameDays("Australia/Melbourne", "Australia/Brisbane", now)).toBe(false);
    expect(sameDays("Not/AZone", "UTC", now)).toBe(true);
  });
});

describe("AdSense", () => {
  const header = [
    { name: "DATE", type: "DIMENSION" },
    { name: "DOMAIN_CODE", type: "DIMENSION" },
    { name: "ESTIMATED_EARNINGS", type: "METRIC_CURRENCY", currencyCode: "AUD" },
    { name: "PAGE_VIEWS", type: "METRIC_TALLY" },
    { name: "IMPRESSIONS", type: "METRIC_TALLY" },
    { name: "CLICKS", type: "METRIC_TALLY" },
  ];
  const cells = (...v: string[]) => ({ cells: v.map((value) => ({ value })) });

  it("reads a report by day and site, with the currency from its header", () => {
    const r = fromAdsenseReport("pub-1", {
      headers: header,
      rows: [cells("2026-10-01", "shop.example.com", "3.456", "1200", "2400", "6"), cells("2026-10-01", "blog.example.com", "1", "300", "600", "1"), cells("", "x", "9", "9", "9", "9")],
    });
    expect(r.currency).toBe("AUD");
    expect(r.rows).toEqual([
      { accountId: "pub-1", site: "shop.example.com", day: "2026-10-01", earnings: 3.46, pageViews: 1200, impressions: 2400, clicks: 6 },
      { accountId: "pub-1", site: "blog.example.com", day: "2026-10-01", earnings: 1, pageViews: 300, impressions: 600, clicks: 1 },
    ]);
  });

  it("finds columns by name, and reads a report that isn't split by site as all sites", () => {
    const r = fromAdsenseReport("pub-1", {
      headers: [{ name: "CLICKS", type: "METRIC_TALLY" }, { name: "DATE", type: "DIMENSION" }, { name: "ESTIMATED_EARNINGS", type: "METRIC_CURRENCY", currencyCode: "USD" }],
      rows: [cells("4", "2026-10-02", "0.5")],
    });
    expect(r).toEqual({ currency: "USD", rows: [{ accountId: "pub-1", site: "", day: "2026-10-02", earnings: 0.5, pageViews: 0, impressions: 0, clicks: 4 }] });
    expect(fromAdsenseReport("pub-1", {})).toEqual({ rows: [], currency: null });
  });

  const day = (over: Partial<AdsenseDayRow>): AdsenseDayRow => ({ accountId: "pub-1", site: "shop.example.com", day: "2026-10-01", earnings: 0, pageViews: 0, impressions: 0, clicks: 0, ...over });

  it("adds up earnings, page RPM, earnings per click and click rate", () => {
    const rows = [day({ earnings: 6, pageViews: 2000, impressions: 4000, clicks: 8 }), day({ day: "2026-10-02", earnings: 4.01, pageViews: 1000, impressions: 1000, clicks: 2 })];
    expect(adsenseTotals(rows)).toEqual({ earnings: 10.01, pageViews: 3000, impressions: 5000, clicks: 10, pageRpm: 3.34, perClick: 1, ctr: 0.002 });
    expect(adsenseTotals([])).toEqual({ earnings: 0, pageViews: 0, impressions: 0, clicks: 0, pageRpm: null, perClick: null, ctr: null });
  });

  it("gives every day of the range a point, and ranks sites by earnings", () => {
    const rows = [day({ earnings: 2, pageViews: 10 }), day({ site: "blog.example.com", earnings: 5, pageViews: 20 }), day({ day: "2026-10-03", earnings: 1 })];
    expect(adsenseSeries(rows, { from: "2026-10-01", to: "2026-10-03" })).toEqual([
      { day: "2026-10-01", earnings: 7, pageViews: 30, impressions: 0, clicks: 0 },
      { day: "2026-10-02", earnings: 0, pageViews: 0, impressions: 0, clicks: 0 },
      { day: "2026-10-03", earnings: 1, pageViews: 0, impressions: 0, clicks: 0 },
    ]);
    expect(siteTotals(rows).map((s) => [s.site, s.earnings])).toEqual([["blog.example.com", 5], ["shop.example.com", 3]]);
    // Days AdSense was never read (before the account's history starts) are missing, not $0.
    expect(adsenseSeries(rows, { from: "2026-09-30", to: "2026-10-02" }, { from: "2026-10-01", through: "2026-10-01" })).toEqual([
      { day: "2026-09-30", earnings: null, pageViews: null, impressions: null, clicks: null },
      { day: "2026-10-01", earnings: 7, pageViews: 30, impressions: 0, clicks: 0 },
      { day: "2026-10-02", earnings: null, pageViews: null, impressions: null, clicks: null },
    ]);
  });

  it("keeps a connection's earnings to the sites chosen for the store, every site when none are", () => {
    expect(adsenseSiteChosen([], "blog.example.com")).toBe(true);
    expect(adsenseSiteChosen(["shop.example.com"], "shop.example.com")).toBe(true);
    expect(adsenseSiteChosen(["Shop.Example.com "], "shop.example.com")).toBe(true);
    expect(adsenseSiteChosen(["shop.example.com"], "blog.example.com")).toBe(false);
    // A report that wasn't split by site can't be told apart: not the chosen site's.
    expect(adsenseSiteChosen(["shop.example.com"], "")).toBe(false);
  });

  it("takes the publisher id out of an account name", () => {
    expect(adsenseAccountId("accounts/pub-123")).toBe("pub-123");
    expect(adsenseAccountId("pub-123")).toBe("pub-123");
  });
});

describe("the Meta Ads report's numbers", () => {
  it("works out link clicks, costs, purchases and return from one range's row, counting a purchase once", () => {
    const m = metaReportMetrics({
      spend: "250.00",
      impressions: "50000",
      reach: "20000",
      frequency: "2.5",
      clicks: "900",
      inline_link_clicks: "600",
      actions: [
        { action_type: "omni_purchase", value: "10" },
        { action_type: "purchase", value: "10" },
        { action_type: "offsite_conversion.fb_pixel_purchase", value: "10" },
        { action_type: "lead", value: "3" },
      ],
      action_values: [
        { action_type: "omni_purchase", value: "1000" },
        { action_type: "purchase", value: "1000" },
      ],
    });
    expect(m).toEqual({
      spend: 250,
      impressions: 50000,
      reach: 20000,
      frequency: 2.5,
      clicks: 900,
      linkClicks: 600,
      linkCtr: 0.012,
      costPerLinkClick: 0.42,
      cpm: 5,
      purchases: 10,
      purchaseValue: 1000,
      costPerPurchase: 25,
      roas: 4,
      leads: 3,
    });
  });

  it("says 'unknown' rather than zero when Meta leaves a figure out, and never divides by zero", () => {
    const m = metaReportMetrics({ spend: "0", impressions: "0" });
    expect(m).toMatchObject({ reach: null, frequency: null, linkCtr: null, costPerLinkClick: null, cpm: null, costPerPurchase: null, roas: null, purchases: 0 });
    // Frequency is impressions per person when Meta gives reach but not frequency.
    expect(metaReportMetrics({ impressions: "300", reach: "120" }).frequency).toBe(2.5);
  });

  it("names rows by their level and keeps the campaign and ad set they sit in", () => {
    const row = { campaign_id: "1", campaign_name: "Spring", adset_id: "2", adset_name: "Women 25-34", ad_id: "3", ad_name: "Carousel", attribution_setting: "7d_click_1d_view" };
    expect(fromMetaRangeInsight("campaign", row)).toMatchObject({ id: "1", name: "Spring", campaignName: null, adsetName: null });
    expect(fromMetaRangeInsight("adset", row)).toMatchObject({ id: "2", name: "Women 25-34", campaignName: "Spring", adsetName: null, attribution: "7d_click_1d_view" });
    expect(fromMetaRangeInsight("ad", row)).toMatchObject({ id: "3", name: "Carousel", campaignName: "Spring", adsetName: "Women 25-34", status: null });
  });

  it("puts Meta's attribution settings into words", () => {
    expect(metaAttributionLabel("7d_click_1d_view")).toBe("7-day click, 1-day view");
    expect(metaAttributionLabel("1d_click")).toBe("1-day click");
    expect(metaAttributionLabel("7d_click_1d_view_1d_ev")).toBe("7-day click, 1-day view, 1-day engaged view");
    expect(metaAttributionLabel("skan")).toBe("skan");
    expect(metaAttributionLabel(null)).toBeNull();
  });

  it("splits by device with publisher_platform, a combination Meta documents (impression_device alone isn't one)", () => {
    expect(META_BREAKDOWN_PARAM.device).toBe("publisher_platform,impression_device");
    expect(META_BREAKDOWN_PARAM.placement).toBe("publisher_platform,platform_position");
  });
});

describe("a connection's wording", () => {
  it("is its code's when the code belongs to its status, else the status's own; nothing when active", () => {
    expect(adStatusCode("active", "auth_expired")).toBeNull();
    expect(adStatusCode("reconnect", "connector_left")).toBe("connector_left");
    expect(adStatusCode("unavailable", "account_closed")).toBe("account_closed");
    // A code left from an earlier failure words nothing of another status.
    expect(adStatusCode("reconnect", "temporary")).toBe("auth_expired");
    expect(adStatusCode("permission", null)).toBe("no_access");
    expect(adStatusCode("unavailable", "no_access")).toBe("account_not_ready");
    expect(adStatusCode("error", "made_up")).toBe("provider_error");
    expect(adErrorMessage(adStatusCode("reconnect", "temporary"), "meta")).toContain("Press Reconnect");
  });
});

describe("the AdSense report's totals", () => {
  const headers = [{ name: "DOMAIN_CODE" }, { name: "ESTIMATED_EARNINGS" }, { name: "PAGE_VIEWS" }, { name: "IMPRESSIONS" }, { name: "CLICKS" }];
  const rows = [{ earnings: 1, pageViews: 100, impressions: 200, clicks: 2, pageRpm: 10, perClick: 0.5, ctr: 0.01 }];

  it("are AdSense's totals row when it sent one, read by column name, else the rows added up", () => {
    expect(adsenseReportTotals({ headers, totals: { cells: [{}, { value: "12.5" }, { value: "5000" }, { value: "8000" }, { value: "25" }] } }, rows)).toEqual({ earnings: 12.5, pageViews: 5000, impressions: 8000, clicks: 25, pageRpm: 2.5, perClick: 0.5, ctr: 25 / 8000 });
    expect(adsenseReportTotals({ headers }, rows)).toMatchObject({ earnings: 1, pageViews: 100, impressions: 200, clicks: 2 });
    expect(adsenseReportTotals({}, [])).toMatchObject({ earnings: 0, pageRpm: null });
  });
});

describe("what a campaign, ad set or ad is set to at Meta", () => {
  it("reads budgets in the currency's units (Meta states them in minor units), the schedule, the bidding and an ad's preview", () => {
    expect(minorUnitsPerUnit("USD")).toBe(100);
    expect(minorUnitsPerUnit("JPY")).toBe(1);
    expect(minorUnitsPerUnit("KWD")).toBe(1000);
    expect(minorUnitsPerUnit("NOPE")).toBe(100);
    expect(minorUnitsPerUnit(null)).toBe(100);
    expect(metaBudget("2500", "USD")).toBe(25);
    expect(metaBudget(2500, "JPY")).toBe(2500);
    expect(metaBudget("0", "USD")).toBeNull();
    expect(metaBudget("", "USD")).toBeNull();
    expect(metaBudget(undefined, "USD")).toBeNull();
    const campaign = metaObjectDetails(
      { id: "1", effective_status: "ACTIVE", objective: "OUTCOME_SALES", buying_type: "AUCTION", daily_budget: "1500", start_time: "2026-10-01T00:00:00+1100", stop_time: "", bid_strategy: "LOWEST_COST_WITHOUT_CAP" },
      "AUD",
    );
    expect(campaign).toEqual({
      objective: "OUTCOME_SALES",
      buyingType: "AUCTION",
      dailyBudget: 15,
      lifetimeBudget: null,
      startTime: "2026-10-01T00:00:00+1100",
      endTime: null,
      bidStrategy: "LOWEST_COST_WITHOUT_CAP",
      optimizationGoal: null,
      billingEvent: null,
      previewLink: null,
      creativeId: null,
    });
    // Ad sets say end_time where campaigns say stop_time.
    expect(metaObjectDetails({ optimization_goal: "OFFSITE_CONVERSIONS", billing_event: "IMPRESSIONS", lifetime_budget: 90000, end_time: "2026-12-31T23:59:59+1100" }, "AUD")).toMatchObject({
      dailyBudget: null,
      lifetimeBudget: 900,
      endTime: "2026-12-31T23:59:59+1100",
      optimizationGoal: "OFFSITE_CONVERSIONS",
      billingEvent: "IMPRESSIONS",
    });
    // Only Meta's own preview pages are kept, and a creative id is digits.
    expect(metaObjectDetails({ preview_shareable_link: "https://www.facebook.com/ads/preview/?x=1", creative: { id: "120330" } }, "USD")).toMatchObject({ previewLink: "https://www.facebook.com/ads/preview/?x=1", creativeId: "120330" });
    expect(metaObjectDetails({ preview_shareable_link: "https://evil.example/preview", creative: { id: "x; drop" } }, "USD")).toMatchObject({ previewLink: null, creativeId: null });
    // The fields each level is read with carry the settings beside the status.
    expect(META_OBJECT_FIELDS.campaign.split(",")).toEqual(expect.arrayContaining(["id", "effective_status", "objective", "daily_budget", "lifetime_budget", "start_time", "stop_time"]));
    expect(META_OBJECT_FIELDS.ad).toContain("preview_shareable_link");
  });

  it("words objectives, bidding and goals, and groups delivery statuses for the filter", () => {
    expect(metaObjectiveLabel("OUTCOME_SALES")).toBe("Sales");
    expect(metaObjectiveLabel("LINK_CLICKS")).toBe("Traffic");
    expect(metaObjectiveLabel("SOMETHING_NEW")).toBe("Something new");
    expect(metaObjectiveLabel(null)).toBeNull();
    expect(metaWords("LOWEST_COST_WITHOUT_CAP")).toBe("Lowest cost without cap");
    expect(metaWords("")).toBeNull();
    expect(metaStatusGroup("ACTIVE")).toBe("active");
    expect(metaStatusGroup("CAMPAIGN_PAUSED")).toBe("paused");
    expect(metaStatusGroup("ADSET_PAUSED")).toBe("paused");
    expect(metaStatusGroup("WITH_ISSUES")).toBe("other");
    expect(metaStatusGroup(null)).toBe("other");
  });

  it("counts campaigns by state: active, paused by the advertiser, and the rest", () => {
    const counts = noMetaCampaignCounts();
    for (const s of ["ACTIVE", "ACTIVE", "PAUSED", "ARCHIVED", "DELETED", "WITH_ISSUES", undefined]) metaCountCampaign(counts, s);
    expect(counts).toEqual({ active: 2, paused: 1, other: 4, total: 7, complete: true });
  });
});

describe("the store's own sales next to the ad spend", () => {
  it("sets net sales and orders against the spend: sales per unit of spend (MER), its share of sales, the cost per order", () => {
    expect(adsVsSales(250, 1000, 40)).toEqual({ netSales: 1000, orders: 40, salesPerSpend: 4, shareOfSales: 0.25, costPerOrder: 6.25 });
    // Nothing spent: no sales per spend; no sales or orders: no share or cost.
    expect(adsVsSales(0, 1000, 40)).toEqual({ netSales: 1000, orders: 40, salesPerSpend: null, shareOfSales: 0, costPerOrder: 0 });
    expect(adsVsSales(100, 0, 0)).toEqual({ netSales: 0, orders: 0, salesPerSpend: 0, shareOfSales: null, costPerOrder: null });
    // Either side unknown: nothing.
    expect(adsVsSales(null, 1000, 40)).toBeNull();
    expect(adsVsSales(100, null, 40)).toBeNull();
    expect(adsVsSales(100, 1000, null)).toBeNull();
  });

  it("knows which platform a Shopify traffic source belongs to", () => {
    expect(trafficSourcePlatform("facebook")).toBe("meta");
    expect(trafficSourcePlatform("instagram")).toBe("meta");
    expect(trafficSourcePlatform("google")).toBe("google");
    expect(trafficSourcePlatform("youtube")).toBe("google");
    expect(trafficSourcePlatform("tiktok")).toBeNull();
    expect(trafficSourcePlatform(null)).toBeNull();
  });
});
