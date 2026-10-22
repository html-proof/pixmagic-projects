import { describe, expect, it } from "vitest";
import { exportTable } from "../src/reports/index.js";

/**
 * The Advertising section as CSV: the same figures the dashboard shows, with names that say what each
 * is (clicks of every kind and link clicks, every conversion action and purchases), whether a row's
 * days are all stored, and why a platform has no total rather than a blank.
 */

const totals = { spend: 40, impressions: 4000, clicks: 100, linkClicks: 80, conversions: 5, conversionValue: 200, purchases: 4, purchaseValue: 180, roas: 4.5 };

describe("the Advertising CSV", () => {
  it("lists the campaigns with link clicks, purchases, their value and return, and whether every day is stored", () => {
    const t = exportTable("ads", {
      ads: {
        campaigns: [
          { provider: "meta", accountId: "act_1", campaignId: "1", name: "Spring", ...totals, complete: true },
          { provider: "google", accountId: "111", campaignId: "7", name: "Brand", ...totals, purchases: null, purchaseValue: null, roas: null, complete: false },
        ],
      },
    });
    expect(t.header).toEqual([
      "Platform",
      "Campaign",
      "Spend",
      "Impressions",
      "Clicks (all)",
      "Link clicks",
      "Conversions (all conversion actions)",
      "Conversion value",
      "Purchases",
      "Purchase value",
      "Return on ad spend (purchases)",
      "Complete",
    ]);
    expect(t.rows).toEqual([
      ["Meta Ads", "Spring", 40, 4000, 100, 80, 5, 200, 4, 180, 4.5, "yes"],
      ["Google Ads", "Brand", 40, 4000, 100, 80, 5, 200, null, null, null, "no"],
    ]);
  });

  it("without campaigns, each platform's totals; one without every day stored says Unavailable and why, or what it has so far", () => {
    const t = exportTable("ads", {
      ads: {
        campaigns: [],
        byProvider: [
          { provider: "meta", ...totals, coverage: { from: "2026-08-01", through: "2026-10-18", complete: true }, soFar: null, partial: null },
          { provider: "google", ...Object.fromEntries(Object.keys(totals).map((k) => [k, null])), coverage: { from: "2026-10-10", through: "2026-10-18", complete: false }, soFar: null, partial: { from: "2026-10-10", to: "2026-10-18", totals } },
        ],
      },
    });
    expect(t.header).toEqual(["Platform", "Spend", "Impressions", "Clicks (all)", "Link clicks", "Conversions (all conversion actions)", "Conversion value", "Purchases", "Purchase value", "Return on ad spend (purchases)", "Complete", "Note"]);
    expect(t.rows[0]).toEqual(["Meta Ads", 40, 4000, 100, 80, 5, 200, 4, 180, 4.5, "yes", null]);
    expect(t.rows[1]).toEqual(["Google Ads", ...Array(9).fill("Unavailable"), "no", "Figures are stored for 2026-10-10 to 2026-10-18 only."]);

    // Only the day still running is missing: the figures up to the last day stored, dated.
    const soFar = exportTable("ads", { ads: { byProvider: [{ provider: "meta", spend: null, coverage: { complete: false }, soFar: { from: "2026-10-13", to: "2026-10-18", totals: { ...totals, spend: 35 } } }] } });
    expect(soFar.header).toEqual(["Platform", "Spend", "Complete", "Note"]);
    expect(soFar.rows).toEqual([["Meta Ads", 35, "up to 2026-10-18", "Up to the last day stored: the days after it aren't over yet."]]);
    // Nothing stored for the dates at all.
    expect(exportTable("ads", { ads: { byProvider: [{ provider: "google", spend: null, coverage: { complete: false } }] } }).rows).toEqual([["Google Ads", "Unavailable", "no", "No figures are stored for these dates yet."]]);
  });
});

describe("the Advertising area's reports", () => {
  const compared = { current: { from: "2026-10-13", to: "2026-10-18", totals }, previous: { from: "2026-10-06", to: "2026-10-11", totals: { ...totals, spend: 20 } }, trimmed: 1 };

  it("the summary: each figure with the one compared with and the change, the store's own sales apart from the platforms' counts, AdSense apart from the spend", () => {
    const t = exportTable("ads_summary", {
      ads: {
        current: totals,
        compared,
        notCompared: null,
        previous: { spend: 20, linkClicks: 80, conversions: 5, purchases: 2, purchaseValue: 90, roas: 4.5 },
        deltas: { spend: 1, linkClicks: 0, conversions: 0, purchases: 1, purchaseValue: 1, roas: 0 },
        sales: { netSales: 400, orders: 8, salesPerSpend: 10, shareOfSales: 0.1, costPerOrder: 5, previous: null, deltas: { netSales: null, orders: null, salesPerSpend: null, costPerOrder: null } },
      },
      adsense: { current: null, soFar: null, partial: null, compared: null, notCompared: "incomplete", previous: {}, deltas: {} },
    });
    expect(t.header).toEqual(["Measure", "Value", "Value on the days compared", "Before", "Change (%)", "Note"]);
    // Today isn't over: the change is on the days through yesterday, said so, beside the whole dates' figure.
    const through = "Compared through 2026-10-18: whole days only.";
    expect(t.rows).toContainEqual(["Ad spend", 40, 40, 20, 100, through]);
    // Impressions have no change of their own.
    expect(t.rows).toContainEqual(["Impressions", 4000, null, null, null, null]);
    expect(t.rows).toContainEqual(["Purchases (platforms' count)", 4, 4, 2, 100, through]);
    // Shopify's figures, not compared here: they say why rather than show a change.
    expect(t.rows).toContainEqual(["Sales per unit of ad spend (MER)", 10, null, null, null, "Not compared: needs whole dates on both sides, with the store's orders imported for them."]);
    // AdSense without its days stored: Unavailable, never $0.
    expect(t.rows).toContainEqual(["AdSense estimated earnings (money in, not ad spend)", "Unavailable", null, null, null, "No figures are stored for these dates yet."]);
    // Shopify's sales are named as Shopify's, the platforms' purchases as the platforms' own.
    expect(t.rows.map((r) => r[0])).toEqual(expect.arrayContaining(["Net sales (Shopify)", "Orders (Shopify)", "Purchase value (platforms' count)"]));
  });

  it("the summary without a change says why, and with the days so far says up to when", () => {
    const t = exportTable("ads_summary", { ads: { current: null, soFar: { from: "2026-10-13", to: "2026-10-18", totals }, compared: null, notCompared: "no_history", previous: {}, deltas: {} } });
    expect(t.rows[0]).toEqual(["Ad spend", 40, null, null, null, "Up to 2026-10-18: the days after it aren't over yet. Not compared: no earlier data."]);
  });

  it("by day: each platform's days, a day without figures said so rather than 0", () => {
    const day = (d: string, spend: number | null) => ({ day: d, spend, impressions: spend === null ? null : 100, clicks: spend === null ? null : 5, linkClicks: spend === null ? null : 4, purchases: spend === null ? null : 1, purchaseValue: spend === null ? null : 30 });
    const t = exportTable("ads_daily", { ads: { seriesByProvider: [{ provider: "meta", series: [day("2026-10-01", 10), day("2026-10-02", 12)] }, { provider: "google", series: [day("2026-10-01", null), day("2026-10-02", 3)] }] } });
    expect(t.rows).toEqual([
      ["2026-10-01", "Meta Ads", 10, 100, 5, 4, 1, 30],
      ["2026-10-01", "Google Ads", "No figures", null, null, null, null, null],
      ["2026-10-02", "Meta Ads", 12, 100, 5, 4, 1, 30],
      ["2026-10-02", "Google Ads", 3, 100, 5, 4, 1, 30],
    ]);
  });

  it("campaigns: every one, with its account and its change where the totals are compared", () => {
    const t = exportTable("ads_campaigns", {
      ads: {
        campaigns: [
          { provider: "meta", accountId: "act_1", campaignId: "1", name: "Spring", ...totals, complete: true, change: { from: "2026-10-06", to: "2026-10-11", previous: { spend: 20, roas: 3 }, deltas: { spend: 1, roas: 0.5 } } },
          { provider: "google", accountId: "111", campaignId: "7", name: "Brand", ...totals, complete: false, change: null },
        ],
      },
    });
    expect(t.header.slice(0, 3)).toEqual(["Platform", "Account", "Campaign"]);
    expect(t.header.slice(-5)).toEqual(["Spend before", "Spend change (%)", "ROAS before", "ROAS change (%)", "Complete"]);
    expect(t.rows[0]).toEqual(["Meta Ads", "act_1", "Spring", 40, 4000, 100, 80, 5, 200, 4, 180, 4.5, 20, 100, 3, 50, "yes"]);
    expect(t.rows[1]!.slice(-5)).toEqual([null, null, null, null, "no"]);
  });

  it("AdSense by day: earnings per day, a day without figures said so", () => {
    const t = exportTable("adsense_daily", { adsense: { series: [{ day: "2026-10-01", earnings: 2.5, pageViews: 300, impressions: 900, clicks: 4 }, { day: "2026-10-02", earnings: null, pageViews: null, impressions: null, clicks: null }] } });
    expect(t.rows).toEqual([
      ["2026-10-01", 2.5, 300, 900, 4],
      ["2026-10-02", "No figures", null, null, null],
    ]);
  });
});
