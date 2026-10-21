import { describe, expect, it } from "vitest";
import {
  addDays,
  adsMetrics,
  adsRecommendations,
  adsSeries,
  campaignAnalytics,
  conversionSeries,
  demoCampaignRows,
  metricsOf,
  pageCampaigns,
  periodsOf,
  RECOMMENDATION_RULES,
  topConverting,
  weekKey,
  weekStart,
  type AdDayRow,
  type CampaignAnalytics,
  type DemoContext,
} from "../src/index.js";

/**
 * The Google Ads analytics figures: the formulas, what happens when a denominator is zero, series by
 * day, week and month, the campaign table's search, sort, filters and pages, and the recommendation
 * rules.
 */

const row = (over: Partial<AdDayRow> & { day: string; campaignId: string }): AdDayRow => ({
  provider: "google",
  accountId: "1",
  campaignName: `Campaign ${over.campaignId}`,
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

describe("the formulas", () => {
  it("CTR, CPC, conversion rate, cost per conversion and ROAS from the sums", () => {
    const m = metricsOf({ spend: 10_000, impressions: 200_000, clicks: 5_000, conversions: 250, conversionValue: 40_000 });
    expect(m.ctr).toBeCloseTo(0.025, 10);
    expect(m.cpc).toBe(2);
    expect(m.conversionRate).toBeCloseTo(0.05, 10);
    expect(m.costPerConversion).toBe(40);
    // ₹10,000 spent, ₹40,000 of conversion value: 4.0.
    expect(m.roas).toBe(4);
    expect(m.cpm).toBe(50);
  });

  it("leaves a rate undefined when its denominator is zero, never an error or an infinity", () => {
    const m = metricsOf({ spend: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0 });
    expect(m).toMatchObject({ ctr: null, cpc: null, cpm: null, conversionRate: null, costPerConversion: null, roas: null });
    expect(adsMetrics([]).spend).toBe(0);
    const spentNoClicks = metricsOf({ spend: 12, impressions: 100, clicks: 0, conversions: 0, conversionValue: 0 });
    expect(spentNoClicks.cpc).toBeNull();
    expect(spentNoClicks.roas).toBe(0);
  });
});

describe("periods", () => {
  it("weeks start on Monday and carry ISO week keys", () => {
    expect(weekStart("2026-10-20")).toBe("2026-10-19");
    expect(weekStart("2026-10-19")).toBe("2026-10-19");
    expect(weekStart("2026-10-18")).toBe("2026-10-12");
    expect(weekKey("2026-10-19")).toBe("2026-W43");
    expect(weekKey("2026-01-01")).toBe("2026-W01");
    expect(weekKey("2027-01-01")).toBe("2026-W53");
  });

  it("cuts a range into days, weeks and months clipped to it", () => {
    expect(periodsOf({ from: "2026-10-01", to: "2026-10-03" }, "day")).toHaveLength(3);
    const weeks = periodsOf({ from: "2026-10-14", to: "2026-10-27" }, "week");
    expect(weeks.map((w) => [w.from, w.to])).toEqual([
      ["2026-10-14", "2026-10-18"],
      ["2026-10-19", "2026-10-25"],
      ["2026-10-26", "2026-10-27"],
    ]);
    const months = periodsOf({ from: "2026-08-20", to: "2026-10-05" }, "month");
    expect(months.map((m) => [m.key, m.from, m.to])).toEqual([
      ["2026-08", "2026-08-20", "2026-08-31"],
      ["2026-09", "2026-09-01", "2026-09-30"],
      ["2026-10", "2026-10-01", "2026-10-05"],
    ]);
    expect(periodsOf({ from: "2026-10-05", to: "2026-10-01" }, "day")).toEqual([]);
  });

  it("gives every period of the range, quiet ones at zero", () => {
    const rows = [row({ day: "2026-10-02", campaignId: "a", spend: 10, impressions: 100, clicks: 5, conversions: 1, conversionValue: 30 })];
    const days = adsSeries(rows, { from: "2026-10-01", to: "2026-10-03" }, "day");
    expect(days.map((d) => d.spend)).toEqual([0, 10, 0]);
    expect(days[1]!.roas).toBe(3);
    expect(days[0]!.ctr).toBeNull();
    const conv = conversionSeries(rows, { from: "2026-10-01", to: "2026-10-03" });
    expect(conv[1]).toMatchObject({ day: "2026-10-02", conversions: 1, conversionRate: 0.2, costPerConversion: 10 });
  });
});

describe("campaigns", () => {
  const range = { from: "2026-10-01", to: "2026-10-10" };
  const rows: AdDayRow[] = [];
  for (let i = 1; i <= 10; i++) {
    const day = `2026-10-${String(i).padStart(2, "0")}`;
    rows.push(row({ day, campaignId: "a", campaignName: "Alpha", spend: 10, impressions: 1000, clicks: 50, conversions: 2, conversionValue: 100 }));
    // Beta ran only in the second half, and spends much more for little.
    if (i > 5) rows.push(row({ day, campaignId: "b", campaignName: "Beta", spend: 100, impressions: 50_000, clicks: 100, conversions: 1, conversionValue: 20 }));
  }
  const settings = [
    { id: "a", name: "Alpha", type: "SEARCH", status: "ENABLED", startDay: "2026-09-01", dailyBudget: 10 },
    { id: "b", name: "Beta", type: "DISPLAY", status: "ENABLED", startDay: "2026-10-06", dailyBudget: 200 },
    { id: "c", name: "Gamma (paused)", type: "VIDEO", status: "PAUSED", startDay: "2026-08-01", dailyBudget: 5 },
  ];
  const list = campaignAnalytics(rows, range, settings);

  it("lists every campaign with figures or settings, with its budget use and halves, biggest spend first", () => {
    expect(list.map((c) => c.id)).toEqual(["b", "a", "c"]);
    const a = list.find((c) => c.id === "a")!;
    expect(a).toMatchObject({ activeDays: 10, budget: 100, budgetUse: 1, type: "SEARCH", startDay: "2026-09-01" });
    expect(a.halves!.first.spend).toBe(50);
    expect(a.halves!.second.spend).toBe(50);
    const b = list.find((c) => c.id === "b")!;
    expect(b).toMatchObject({ activeDays: 5, budget: 1000, budgetUse: 0.5 });
    const c = list.find((c) => c.id === "c")!;
    expect(c).toMatchObject({ spend: 0, activeDays: 0, budget: 0, budgetUse: null, status: "PAUSED" });
  });

  it("names a campaign from its rows when it has no settings", () => {
    const bare = campaignAnalytics(rows, range);
    expect(bare.find((c) => c.id === "a")).toMatchObject({ name: "Alpha", type: null, dailyBudget: null, budget: null });
  });

  it("searches, filters, sorts (nulls last) and pages", () => {
    expect(pageCampaigns(list, { q: "alp" }).rows.map((c) => c.id)).toEqual(["a"]);
    expect(pageCampaigns(list, { status: "PAUSED" }).total).toBe(1);
    expect(pageCampaigns(list, { type: "DISPLAY" }).rows[0]!.id).toBe("b");
    expect(pageCampaigns(list, { sort: "roas", dir: "desc" }).rows.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(pageCampaigns(list, { sort: "roas", dir: "asc" }).rows.map((c) => c.id)).toEqual(["b", "a", "c"]);
    expect(pageCampaigns(list, { sort: "name" }).rows.map((c) => c.name)).toEqual(["Alpha", "Beta", "Gamma (paused)"]);
    const page = pageCampaigns(list, { pageSize: 2, page: 2 });
    expect(page).toMatchObject({ total: 3, page: 2, pages: 2, pageSize: 2 });
    expect(page.rows).toHaveLength(1);
    expect(pageCampaigns(list, { page: 99, pageSize: 2 }).page).toBe(2);
    expect(pageCampaigns([], {})).toMatchObject({ rows: [], total: 0, page: 1, pages: 1 });
  });

  it("recommends: high spend with low return, few clicks, and nothing for a paused campaign", () => {
    const recs = adsRecommendations(list);
    const beta = recs.filter((r) => r.campaignId === "b").map((r) => r.code);
    expect(beta).toContain("high_spend_low_roas");
    expect(beta).toContain("low_ctr");
    expect(recs.some((r) => r.campaignId === "c")).toBe(false);
    expect(recs[0]!.severity).toBe("attention");
  });

  it("recommends a rising cost per click, an improving conversion rate and room for budget", () => {
    const trend: AdDayRow[] = [];
    for (let i = 1; i <= 10; i++) {
      const day = `2026-10-${String(i).padStart(2, "0")}`;
      const late = i > 5;
      trend.push(row({ day, campaignId: "t", campaignName: "Trend", spend: late ? 300 : 200, impressions: 10_000, clicks: 200, conversions: late ? 40 : 20, conversionValue: late ? 1500 : 800 }));
    }
    const list = campaignAnalytics(trend, range, [{ id: "t", name: "Trend", type: "SEARCH", status: "ENABLED", startDay: "2026-01-01", dailyBudget: 260 }]);
    const codes = adsRecommendations(list).map((r) => r.code);
    expect(codes).toContain("rising_cpc");
    expect(codes).toContain("improving_conversion_rate");
    expect(codes).toContain("budget_opportunity");
    expect(RECOMMENDATION_RULES.trendUp).toBe(0.15);
  });

  it("picks the campaigns that convert most", () => {
    expect(topConverting(list).map((c) => c.id)).toEqual(["a", "b"]);
    expect(topConverting([] as CampaignAnalytics[])).toEqual([]);
  });
});

describe("the demo through the analytics", () => {
  it("finds something to recommend in a demo's 90 days without any division by zero", () => {
    const ctx: DemoContext = { seed: 20261020, currency: "AUD", epoch: "2026-10-20" };
    const range = { from: addDays(ctx.epoch, -89), to: ctx.epoch };
    const rows = demoCampaignRows(ctx, range.from, range.to);
    const list = campaignAnalytics(rows, range);
    expect(list).toHaveLength(7);
    for (const c of list) expect(Number.isFinite(c.roas ?? 0) && Number.isFinite(c.ctr ?? 0)).toBe(true);
    expect(adsRecommendations(list).length).toBeGreaterThan(0);
  });
});
