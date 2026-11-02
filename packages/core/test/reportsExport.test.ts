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

  it("the summary with Meta and Google both counted: spend added up, each platform's own purchases, never their claims added up", () => {
    const meta = { provider: "meta", current: { ...totals, spend: 30, purchases: 3, purchaseValue: 120, roas: 4, conversions: 3 }, compared: null, notCompared: "no_history", previous: {}, deltas: {} };
    const google = { provider: "google", current: { ...totals, spend: 10, purchases: 2, purchaseValue: 60, roas: 6, conversions: 5 }, compared: null, notCompared: "no_history", previous: {}, deltas: {} };
    // The totals add the two claims up (5 purchases worth $180): for a single order both credit, that's twice.
    const ads = { current: { ...totals, purchases: 5, purchaseValue: 180, roas: 4.5 }, compared: null, notCompared: "no_history", previous: {}, deltas: {}, claimsAddUp: false, byProvider: [meta, google] };
    const t = exportTable("ads_summary", { ads });
    const label = t.rows.map((r) => r[0]);
    expect(t.rows).toContainEqual(["Ad spend", 40, null, null, null, "Not compared: no earlier data."]);
    expect(label).not.toContain("Purchases (platforms' count)");
    expect(label).not.toContain("Return on ad spend (platforms' own)");
    expect(t.rows).toContainEqual(["Purchases", "Each platform's own", null, null, null, "Meta Ads and Google Ads can both claim the same order, so their purchases, purchase value, ROAS and conversions are given per platform, never added up."]);
    expect(t.rows).toContainEqual(["Meta Ads purchases (its own count)", 3, null, null, null, "Not compared: no earlier data."]);
    expect(t.rows).toContainEqual(["Meta Ads return on ad spend (its own)", 4, null, null, null, "Not compared: no earlier data."]);
    expect(t.rows).toContainEqual(["Google Ads purchase value (its own count)", 60, null, null, null, "Not compared: no earlier data."]);
    expect(t.rows).toContainEqual(["Google Ads conversions (all conversion actions)", 5, null, null, null, "Not compared: no earlier data."]);
    // No figure anywhere is the sum of the two claims.
    expect(t.rows.some((r) => r[1] === 180 || r[1] === 4.5)).toBe(false);

    // An answer from before `claimsAddUp`: two platforms are worked out from `byProvider`; one platform's are its own totals.
    const older = { ...ads, claimsAddUp: undefined };
    expect(exportTable("ads_summary", { ads: older }).rows).toEqual(t.rows);
    const one = exportTable("ads_summary", { ads: { ...older, byProvider: [meta] } });
    expect(one.rows).toContainEqual(["Purchases (platforms' count)", 5, null, null, null, "Not compared: no earlier data."]);
  });

  it("the summary names the accounts left out in another currency under the spend", () => {
    const t = exportTable("ads_summary", {
      ads: {
        current: totals,
        compared: null,
        notCompared: "no_history",
        previous: {},
        deltas: {},
        leftOut: [
          { id: "x", provider: "meta", accountId: "act_x", name: "EU shop", currency: "EUR" },
          { id: "y", provider: "google", accountId: "456", name: null, currency: null },
        ],
      },
    });
    const at = t.rows.findIndex((r) => r[0] === "Left out");
    expect(t.rows[at]).toEqual(["Left out", "EU shop (EUR); 456 (currency not known yet)", null, null, null, "In another currency: their spend and purchases are in none of these figures."]);
    expect(t.rows[at - 1]![0]).toBe("Link clicks");
    expect(exportTable("ads_summary", { ads: { current: totals, compared: null, notCompared: "no_history", previous: {}, deltas: {}, leftOut: [] } }).rows.some((r) => r[0] === "Left out")).toBe(false);
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
          { provider: "meta", accountId: "act_1", campaignId: "1", name: "Spring", status: "ACTIVE", statusGroup: "active", ...totals, complete: true, change: { from: "2026-10-06", to: "2026-10-11", previous: { spend: 20, roas: 3 }, deltas: { spend: 1, roas: 0.5 } } },
          { provider: "google", accountId: "111", campaignId: "7", name: "Brand", ...totals, complete: false, change: null },
          {
            provider: "google",
            accountId: "111",
            campaignId: "8",
            name: "Shoes",
            status: "ENABLED",
            primaryStatus: "LIMITED",
            primaryStatusReasons: ["BUDGET_CONSTRAINED", "BIDDING_STRATEGY_LEARNING"],
            channelType: "SEARCH",
            budgetAmount: 40,
            budgetPeriod: "DAILY",
            ...totals,
            complete: true,
            change: null,
          },
        ],
      },
    });
    expect(t.header.slice(0, 9)).toEqual(["Platform", "Account", "Campaign", "Status", "Primary status (Google)", "Primary status reasons (Google)", "Campaign type (Google)", "Budget", "Budget period"]);
    expect(t.header.slice(-5)).toEqual(["Spend before", "Spend change (%)", "ROAS before", "ROAS change (%)", "Complete"]);
    expect(t.rows[0]).toEqual(["Meta Ads", "act_1", "Spring", "ACTIVE", null, null, null, null, null, 40, 4000, 100, 80, 5, 200, 4, 180, 4.5, 20, 100, 3, 50, "yes"]);
    expect(t.rows[1]!.slice(-5)).toEqual([null, null, null, null, "no"]);
    // A status not read yet is an empty cell.
    expect(t.rows[1]![3]).toBeNull();
    // Google's primary status, its reasons, the campaign's type and its budget, as the last sync stored them.
    expect(t.rows[2]!.slice(3, 9)).toEqual(["ENABLED", "LIMITED", "BUDGET_CONSTRAINED BIDDING_STRATEGY_LEARNING", "SEARCH", 40, "DAILY"]);
  });

  it("AdSense by day: earnings per day, a day without figures said so", () => {
    const t = exportTable("adsense_daily", { adsense: { series: [{ day: "2026-10-01", earnings: 2.5, pageViews: 300, impressions: 900, clicks: 4 }, { day: "2026-10-02", earnings: null, pageViews: null, impressions: null, clicks: null }] } });
    expect(t.rows).toEqual([
      ["2026-10-01", 2.5, 300, 900, 4],
      ["2026-10-02", "No figures", null, null, null],
    ]);
  });
});
