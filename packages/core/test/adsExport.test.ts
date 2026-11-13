import { describe, expect, it } from "vitest";
import { googleRowBlank, type GoogleReportMetrics, type GoogleReportRow } from "@app/shared";
import { googleAnalyticsTable, googleReportTable, metaReportTable, type GoogleAdsAnalytics } from "../src/reports/index.js";

/**
 * The Advertising area's own CSVs (reports/adsExport.ts): each level's columns, the top row named as the
 * page names it, and figures that aren't there said in words, never written as 0.
 */

const g = (spend: number): GoogleReportMetrics => ({ spend, impressions: 100, clicks: 10, ctr: 0.1, cpc: spend / 10, cpm: spend * 10, conversions: 2, conversionRate: 0.2, costPerConversion: spend / 2, conversionValue: 40, roas: 40 / spend });
const row = (id: string, name: string, spend: number, extra: Partial<GoogleReportRow> = {}): GoogleReportRow => ({ ...googleRowBlank(), id, name, ...g(spend), ...extra });

describe("the Google Ads report's CSV", () => {
  it("a split of the whole account: no object columns, the account's row on top", () => {
    const t = googleReportTable({ level: "device", since: "2026-09-01", until: "2026-09-30", totals: g(30), rows: [row("MOBILE", "Phones", 20), row("DESKTOP", "Computers", 10)], truncated: false }, null, {}, { currency: "EUR", timezone: "Europe/Paris" });
    expect(t.header).toEqual([
      "Device",
      "Google id",
      "Spend (EUR)",
      "Impressions",
      "Clicks",
      "Click-through rate (%)",
      "Cost per click (EUR)",
      "Cost per 1,000 impressions (EUR)",
      "Conversions (Google's count, all conversion actions)",
      "Conversion rate (%)",
      "Cost per conversion (EUR)",
      "Conversion value (EUR; Google's count)",
      "Conversion value / cost",
    ]);
    expect(t.rows[0]).toEqual(["Whole ad account", null, 30, 100, 10, 10, 3, 300, 2, 20, 15, 40, 1.33]);
    expect(t.rows[1]!.slice(0, 3)).toEqual(["Phones", "MOBILE", 20]);
    expect(t.rows.at(-1)![1]).toMatch(/not Shopify orders/);
    expect(t.rows.some((r) => r[0] === "Simulated data")).toBe(false);
  });

  it("an ad group's ads, cut short: what the top row adds up, each ad's type, and that only the biggest are listed", () => {
    const ads = [row("9", "Responsive search ad 9", 5, { campaignName: "Brand", adGroupName: "Core", adType: "RESPONSIVE_SEARCH_AD", status: "ENABLED" })];
    const t = googleReportTable({ level: "ad", since: "2026-09-01", until: "2026-09-30", totals: g(8), rows: ads, truncated: true }, null, { campaign: "1", adGroup: "2" }, { currency: null, timezone: null });
    expect(t.header.slice(0, 7)).toEqual(["Ad", "Google id", "Campaign", "Ad group", "Status at Google now", "Ad type", "Spend"]);
    expect(t.rows[0]![0]).toBe("All ads in this ad group");
    expect(t.rows[1]!.slice(0, 6)).toEqual(["Responsive search ad 9", "9", "Brand", "Core", "ENABLED", "Responsive search ad"]);
    expect(t.rows.map((r) => r[1])).toContain("Only the 1 that spent most are listed.");
  });

  it("keywords Google gives no Quality Score for say so; down from a campaign, what its own row has beyond them is search traffic without a keyword", () => {
    const kw = [row("2~5", "running shoes", 4, { matchType: "PHRASE", qualityScore: null, status: "ENABLED" })];
    const t = googleReportTable({ level: "keyword", since: "2026-09-01", until: "2026-09-30", totals: g(9), rows: kw, truncated: false }, null, { campaign: "1" }, { currency: "AUD", timezone: null });
    expect(t.rows[0]![0]).toBe("Whole campaign");
    expect(t.rows[1]![t.header.indexOf("Quality Score now (1 to 10)")]).toBe("Not rated by Google");
    expect(t.rows[1]![t.header.indexOf("Match type")]).toBe("Phrase match");
    const notes = t.rows.filter((r) => r[0] === "Note").map((r) => r[1]);
    expect(notes).toContainEqual(expect.stringMatching(/^The top row is Google's own row for it\. Spend in this campaign without a keyword \(dynamic search ads/));
    // Not blamed on campaign types an opened Search campaign can't be.
    expect(notes.join(" ")).not.toContain("(Shopping, Performance Max, Display, YouTube)");
    // The whole account's keywords: there, other campaign types are what has no keyword.
    const account = googleReportTable({ level: "keyword", since: "2026-09-01", until: "2026-09-30", totals: g(9), rows: kw, truncated: false }, null, {}, { currency: "AUD", timezone: null });
    expect(account.rows.map((r) => r[1]).join(" ")).toContain("(Shopping, Performance Max, Display, YouTube)");
  });

  it("the demo's file says it is simulated first, and calls none of its figures or facts Google's", () => {
    const kw = [row("2~5", "running shoes", 4, { matchType: "PHRASE", qualityScore: null, status: "ENABLED" })];
    const t = googleReportTable({ level: "keyword", since: "2026-09-01", until: "2026-09-30", totals: g(9), rows: kw, truncated: false }, null, { campaign: "1" }, { currency: "AUD", timezone: null, demo: true });
    expect(t.rows[0]![0]).toBe("Simulated data");
    expect(t.rows[1]![0]).toBe("Whole campaign");
    expect(t.header).toContain("Conversions (simulated, all conversion actions)");
    expect(t.header).toContain("Conversion value (AUD; simulated)");
    expect(t.header).toContain("Status now (simulated)");
    expect(t.rows[2]![t.header.indexOf("Quality Score now (1 to 10)")]).toBe("Not rated");
    const text = [...t.header, ...t.rows.flat()].join(" ");
    expect(text).not.toMatch(/Google's count|Google's own|at Google now|rated by Google/);
    expect(t.rows.filter((r) => r[0] === "Note").map((r) => r[1])).toContainEqual(expect.stringMatching(/^Conversions and their value are simulated/));
  });

  it("dates reaching today say their figures are still coming in, as the page does; past dates don't", () => {
    const report = (until: string) => ({ level: "campaign" as const, since: "2026-10-01", until, totals: g(9), rows: [row("7", "Brand", 9)], truncated: false });
    const notes = (until: string, today?: string) => googleReportTable(report(until), null, {}, { currency: "USD", timezone: "UTC", today }).rows.filter((r) => r[0] === "Note").map((r) => r[1]);
    expect(notes("2026-10-30", "2026-10-30")).toContainEqual(expect.stringMatching(/^Today's numbers are still coming in: Google/));
    expect(notes("2026-10-29", "2026-10-30").join(" ")).not.toContain("still coming in");
    expect(notes("2026-10-30").join(" ")).not.toContain("still coming in");
  });

  it("down from a campaign with no ad groups listed: what Google reported, never that the campaign didn't run", () => {
    const t = googleReportTable({ level: "ad_group", since: "2026-09-01", until: "2026-09-30", totals: g(0), rows: [], truncated: false }, null, { campaign: "7" }, { currency: "USD", timezone: null });
    const notes = t.rows.filter((r) => r[0] === "Note").map((r) => r[1]);
    expect(notes).toContain("Google reported no ad groups with any activity in this campaign for these dates.");
    expect(notes.join(" ")).not.toContain("shown to anyone");
    // The whole account's top row is its own: nothing there is nothing shown.
    const none = googleReportTable({ level: "ad_group", since: "2026-09-01", until: "2026-09-30", totals: { ...g(0), impressions: 0 }, rows: [], truncated: false }, null, {}, { currency: "USD", timezone: null });
    expect(none.rows.map((r) => r[1])).toContain("Nothing in this ad account was shown to anyone in these dates.");
    // ...and an account that ran with no ad group listed says where its spend is.
    const pmax = googleReportTable({ level: "ad_group", since: "2026-09-01", until: "2026-09-30", totals: g(30), rows: [], truncated: false }, null, {}, { currency: "USD", timezone: null });
    expect(pmax.rows.map((r) => r[1]).join(" ")).toContain("Performance Max campaigns have no ad groups");
  });
});

describe("the Meta Ads report's CSV", () => {
  it("a split by age: no object or budget columns, and reach Meta didn't give is Not reported", () => {
    const m = { spend: 10, impressions: 500, reach: null, frequency: null, clicks: 5, linkClicks: 3, linkCtr: 0.006, costPerLinkClick: 3.33, cpm: 20, landingPageViews: 2, costPerLandingPageView: 5, purchases: 1, purchaseValue: 30, costPerPurchase: 10, roas: 3, leads: 0 };
    const report = {
      level: "age" as const,
      since: "2026-09-01",
      until: "2026-09-30",
      totals: { ...m, byWindow: undefined as never },
      rows: [{ id: "25-34", name: "Aged 25-34", campaignId: null, campaignName: null, adsetId: null, adsetName: null, status: null, attribution: null, ...m, byWindow: undefined as never }],
      truncated: false,
      attribution: [],
      campaigns: null,
    };
    const t = metaReportTable(report, null, {}, { currency: "USD", timezone: "UTC" });
    expect(t.header.slice(0, 4)).toEqual(["Age group", "Meta id", "Attribution setting", "Spend (USD)"]);
    expect(t.rows[0]!.slice(0, 7)).toEqual(["Whole ad account", null, null, 10, 500, "Not reported", "Not reported"]);
    // An answer without the windows (cached before they were read) has none of their figures: Not reported, never 0.
    expect(t.rows[1]![t.header.indexOf("Purchases (Meta's count, 1-day click)")]).toBe("Not reported");
    expect(t.rows[1]![t.header.indexOf("Purchases (Meta's count, each ad set's own setting)")]).toBe(1);
    // Dates reaching the ad account's today: still coming in, as the page says.
    expect(t.rows.map((r) => r[1]).join(" ")).not.toContain("still coming in");
    const live = metaReportTable({ ...report, until: "2026-10-30" }, null, {}, { currency: "USD", timezone: "UTC", today: "2026-10-30" });
    expect(live.rows.filter((r) => r[0] === "Note").map((r) => r[1])).toContainEqual(expect.stringMatching(/^Today's numbers are still coming in: Meta/));
  });
});

describe("the Google Ads analytics page's CSV", () => {
  const zero = { spend: 0, impressions: 0, clicks: 0, ctr: null, cpc: null, cpm: null, conversions: 0, conversionRate: null, costPerConversion: null, conversionValue: 0, roas: null };
  const analytics = (coverage: { from: string | null; through: string | null; complete: boolean }) =>
    ({
      account: { id: "c1", accountId: "123", name: "Shop", currency: "USD", timezone: "UTC", demo: false },
      range: { from: "2026-09-28", to: "2026-10-11" },
      previous: { from: "2026-09-14", to: "2026-09-27" },
      today: "2026-10-30",
      coverage,
      overview: { current: { ...zero, spend: 50 }, previous: null, deltas: {} },
      series: {
        day: [],
        week: [
          { key: "2026-W40", from: "2026-09-28", to: "2026-10-04", ...zero },
          { key: "2026-W41", from: "2026-10-05", to: "2026-10-11", ...zero, spend: 50 },
        ],
        month: [],
      },
      campaigns: [],
      devices: null,
      audience: { age: null, countries: null, segments: null, devices: null, note: "Google's device and country splits couldn't be read just now." },
      recommendations: [],
      combined: null,
    }) as unknown as GoogleAdsAnalytics;

  it("weeks the account hasn't stored are Not stored, a week partly stored says which days", () => {
    const t = googleAnalyticsTable("weeks", analytics({ from: "2026-10-02", through: "2026-10-11", complete: false }));
    expect(t.header.slice(0, 4)).toEqual(["Week", "From", "To", "Spend (USD)"]);
    expect(t.rows[0]!.slice(0, 4)).toEqual(["2026-W40", "2026-09-28", "2026-10-04", 0]);
    expect(t.rows[0]!.at(-1)).toBe("Only 2026-10-02 to 2026-10-04 are stored.");
    expect(t.rows[1]!.at(-1)).toBeNull();
    const none = googleAnalyticsTable("weeks", analytics({ from: "2026-10-05", through: "2026-10-11", complete: false }));
    expect(none.rows[0]!.slice(3, 5)).toEqual(["Not stored", null]);
  });

  it("the overview with nothing stored is Not stored, and stored, the figure alone", () => {
    const empty = googleAnalyticsTable("overview", analytics({ from: null, through: null, complete: false }));
    expect(empty.header).toEqual(["Measure", "Value", "Note"]);
    expect(empty.rows[0]).toEqual(["Spend (USD)", "Not stored", "Nothing is stored for this account for these dates yet."]);
    const stored = googleAnalyticsTable("overview", analytics({ from: "2026-09-28", through: "2026-10-29", complete: true }));
    expect(stored.rows[0]).toEqual(["Spend (USD)", 50, null]);
  });

  it("a split that couldn't be read says why; a real account has no demo store", () => {
    expect(googleAnalyticsTable("devices", analytics({ from: "2026-09-28", through: "2026-10-29", complete: true })).rows).toEqual([["Not available", "Google's device and country splits couldn't be read just now."]]);
    expect(googleAnalyticsTable("combined", analytics({ from: "2026-09-28", through: "2026-10-29", complete: true })).rows[0]![0]).toBe("Not available");
  });
});
