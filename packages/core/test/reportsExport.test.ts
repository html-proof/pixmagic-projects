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
