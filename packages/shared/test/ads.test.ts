import { describe, expect, it } from "vitest";
import {
  adSeries,
  adsenseAccountId,
  adsenseSeries,
  adsenseTotals,
  adTotals,
  campaignTotals,
  fromAdsenseReport,
  fromGoogleAdsRow,
  fromMetaInsight,
  googleCustomerId,
  metaAccountId,
  previousRange,
  siteTotals,
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
  conversions: 0,
  conversionValue: 0,
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
    expect(r).toEqual({ provider: "meta", accountId: "act_9", campaignId: "77", campaignName: "Retargeting", day: "2026-10-03", spend: 12.35, impressions: 1000, clicks: 25, conversions: 2, conversionValue: 80.5, leads: 1 });
    expect(fromMetaInsight("act_9", { date_start: "2026-10-03" })).toMatchObject({ spend: 0, conversions: 0, campaignId: "account" });
  });

  it("reads Google Ads rows, turning micros into money", () => {
    expect(
      fromGoogleAdsRow("1234567890", {
        campaign: { id: "555", name: "Search - brand" },
        segments: { date: "2026-10-02" },
        metrics: { costMicros: "4567890", impressions: "320", clicks: "18", conversions: 1.5, conversionsValue: 99.999 },
      }),
    ).toEqual({ provider: "google", accountId: "1234567890", campaignId: "555", campaignName: "Search - brand", day: "2026-10-02", spend: 4.57, impressions: 320, clicks: 18, conversions: 1.5, conversionValue: 100, leads: 0 });
    expect(fromGoogleAdsRow("1", { metrics: {} })).toBeNull();
    expect(googleCustomerId("123-456-7890")).toBe("1234567890");
    expect(metaAccountId("42")).toBe("act_42");
    expect(metaAccountId("act_42")).toBe("act_42");
  });
});

describe("ad totals", () => {
  const rows = [
    row({ day: "2026-10-01", spend: 10, impressions: 1000, clicks: 20, conversions: 1, conversionValue: 50 }),
    row({ day: "2026-10-03", spend: 30, impressions: 3000, clicks: 40, conversions: 3, conversionValue: 150, leads: 2 }),
    row({ provider: "google", accountId: "9", campaignId: "g1", campaignName: "Search", day: "2026-10-03", spend: 20, impressions: 500, clicks: 30, conversions: 0 }),
  ];

  it("adds up spend and works out the rates from the totals", () => {
    expect(adTotals(rows)).toEqual({
      spend: 60,
      impressions: 4500,
      clicks: 90,
      conversions: 4,
      conversionValue: 200,
      leads: 2,
      ctr: 90 / 4500,
      cpc: 0.67,
      cpm: 13.33,
      costPerConversion: 15,
      roas: 200 / 60,
    });
    expect(adTotals([])).toMatchObject({ spend: 0, ctr: null, cpc: null, cpm: null, costPerConversion: null, roas: null });
  });

  it("charts every day of the range and ranks campaigns by spend", () => {
    expect(adSeries(rows, { from: "2026-10-01", to: "2026-10-04" })).toEqual([
      { day: "2026-10-01", spend: 10, clicks: 20, impressions: 1000, conversions: 1 },
      { day: "2026-10-02", spend: 0, clicks: 0, impressions: 0, conversions: 0 },
      { day: "2026-10-03", spend: 50, clicks: 70, impressions: 3500, conversions: 3 },
      { day: "2026-10-04", spend: 0, clicks: 0, impressions: 0, conversions: 0 },
    ]);
    const top = campaignTotals([...rows, row({ day: "2026-10-04", campaignName: "Spring (renamed)", spend: 1 })]);
    expect(top.map((c) => [c.provider, c.name, c.spend])).toEqual([
      ["meta", "Spring (renamed)", 41],
      ["google", "Search", 20],
    ]);
    expect(previousRange({ from: "2026-10-01", to: "2026-10-04" })).toEqual({ from: "2026-09-27", to: "2026-09-30" });
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
  });

  it("takes the publisher id out of an account name", () => {
    expect(adsenseAccountId("accounts/pub-123")).toBe("pub-123");
    expect(adsenseAccountId("pub-123")).toBe("pub-123");
  });
});
