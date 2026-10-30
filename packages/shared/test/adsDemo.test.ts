import { describe, expect, it } from "vitest";
import {
  addDays,
  apportion,
  apportionMoney,
  DEMO_ACCOUNT_ID,
  DEMO_CAMPAIGNS,
  DEMO_PERMISSIONS,
  demoAccountFacts,
  demoBreakdown,
  demoCampaignDay,
  demoCampaignDays,
  demoCampaignRows,
  demoHomeCountry,
  demoMoney,
  demoPrimaryStatus,
  demoReport,
  demoStoreDays,
  eachDay,
  demoStoreTotals,
  isDemoObjectId,
  isDemoSeed,
  newDemoSeed,
  type DemoContext,
} from "../src/index.js";

/**
 * The Google Ads demo's generator: the same seed always gives the same figures, every figure is
 * consistent with the others (the rates the page works out are true of the rows), the splits add up
 * to the totals, and the account says what it is.
 */

const ctx: DemoContext = { seed: 20261020, currency: "INR", epoch: "2026-10-20" };
const since = addDays(ctx.epoch, -89);
const until = ctx.epoch;

describe("the demo account", () => {
  it("says what it is: simulated, generated, not verified by Google, nothing billed", () => {
    const f = demoAccountFacts({});
    expect(f.accountId).toBe(DEMO_ACCOUNT_ID);
    expect(f).toMatchObject({ currency: "INR", timezone: "Asia/Kolkata", country: "India", isDemo: true, connectionType: "demo", verificationStatus: "simulated", authentication: "Simulated", verification: "Not Verified by Google" });
    expect(f.billingStatus).toContain("Demo");
    expect(DEMO_PERMISSIONS).toHaveLength(8);
    expect(DEMO_PERMISSIONS.every((p) => p.startsWith("Read demo"))).toBe(true);
  });

  it("adopts the store's currency and time zone, and its home country follows the currency", () => {
    expect(demoAccountFacts({ currency: "aud", timezone: "Australia/Melbourne" })).toMatchObject({ currency: "AUD", timezone: "Australia/Melbourne", country: "Australia" });
    expect(demoHomeCountry("USD").code).toBe("US");
    expect(demoHomeCountry("XYZ").code).toBe("IN");
  });

  it("scales money to the currency and rounds to its minor unit", () => {
    expect(demoMoney(1, "USD")).toBe(1);
    expect(demoMoney(1, "INR")).toBe(83);
    expect(demoMoney(1.234, "JPY")).toBe(Math.round(1.234 * 150));
    expect(Number.isInteger(demoMoney(3.3333, "JPY"))).toBe(true);
    expect(demoMoney(1.005, "AUD")).toBe(1.51);
  });

  it("seeds: any positive 31-bit integer; a new one is never 0", () => {
    expect(isDemoSeed(1)).toBe(true);
    expect(isDemoSeed(0)).toBe(false);
    expect(isDemoSeed(2 ** 31)).toBe(false);
    expect(isDemoSeed(1.5)).toBe(false);
    for (let i = 0; i < 20; i++) expect(isDemoSeed(newDemoSeed(i))).toBe(true);
  });
});

describe("the campaigns' days", () => {
  const rows = demoCampaignRows(ctx, since, until);

  it("are the same for the same seed, and differ for another", () => {
    expect(demoCampaignRows(ctx, since, until)).toEqual(rows);
    expect(demoCampaignRows({ ...ctx, seed: 7 }, since, until)).not.toEqual(rows);
    expect(rows.length).toBeGreaterThan(400);
  });

  it("can be generated a day at a time and agree with the whole window", () => {
    const day = addDays(ctx.epoch, -10);
    const one = demoCampaignRows(ctx, day, day);
    expect(one).toEqual(rows.filter((r) => r.day === day));
  });

  it("are consistent in every row: clicks within impressions, conversions within clicks, purchases plus leads, spend under the budget", () => {
    for (const r of rows) {
      const c = DEMO_CAMPAIGNS.find((x) => x.id === r.campaignId)!;
      expect(r.provider).toBe("google");
      expect(r.accountId).toBe(DEMO_ACCOUNT_ID);
      expect(r.impressions).toBeGreaterThanOrEqual(0);
      expect(r.clicks).toBeLessThanOrEqual(r.impressions);
      expect(r.linkClicks).toBe(r.clicks);
      expect(r.conversions).toBeLessThanOrEqual(r.clicks);
      expect((r.purchases ?? 0) + r.leads).toBe(r.conversions);
      expect(r.purchaseValue).toBe(r.conversionValue);
      expect(r.spend).toBeGreaterThanOrEqual(0);
      expect(r.spend).toBeLessThanOrEqual(demoMoney(c.dailyBudgetUsd * 1.6, ctx.currency) + 0.01);
      expect(Number.isInteger(r.impressions) && Number.isInteger(r.clicks) && Number.isInteger(r.conversions)).toBe(true);
    }
  });

  it("start when each campaign started and stop when it was paused", () => {
    const pmax = DEMO_CAMPAIGNS.find((c) => c.id === "demo-c7")!;
    const { start } = demoCampaignDays(ctx, pmax);
    expect(start).toBe(addDays(ctx.epoch, -45));
    expect(demoCampaignDay(ctx, pmax, addDays(start, -1))).toBeNull();
    expect(demoCampaignDay(ctx, pmax, start)).not.toBeNull();
    const paused = DEMO_CAMPAIGNS.find((c) => c.status === "PAUSED")!;
    const end = demoCampaignDays(ctx, paused).end!;
    expect(end).toBe(addDays(ctx.epoch, -20));
    expect(demoCampaignDay(ctx, paused, end)).not.toBeNull();
    expect(demoCampaignDay(ctx, paused, addDays(end, 1))).toBeNull();
    expect(rows.filter((r) => r.campaignId === paused.id && r.day > end)).toHaveLength(0);
  });

  it("gives leads only to the lead generation campaign", () => {
    const leads = rows.filter((r) => r.leads > 0).map((r) => r.campaignId);
    expect(new Set(leads)).toEqual(new Set(["demo-c5"]));
  });

  it("answers an empty or reversed window with nothing", () => {
    expect(demoCampaignRows(ctx, until, since)).toEqual([]);
    expect(demoCampaignRows(ctx, "nope", until)).toEqual([]);
  });
});

describe("splits", () => {
  const rows = demoCampaignRows(ctx, since, until);
  const sum = (list: Array<{ spend: number; impressions: number; clicks: number; conversions: number; conversionValue: number }>) =>
    list.reduce((a, r) => ({ spend: a.spend + r.spend, impressions: a.impressions + r.impressions, clicks: a.clicks + r.clicks, conversions: a.conversions + r.conversions, conversionValue: a.conversionValue + r.conversionValue }), { spend: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0 });

  it("apportion keeps whole numbers that add up, by largest remainder", () => {
    expect(apportion(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(apportion(0, [1, 2])).toEqual([0, 0]);
    expect(apportion(5, [0, 0])).toEqual([0, 0]);
    expect(apportionMoney(1, [1, 1, 1]).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it.each(["device", "country", "age", "segment"] as const)("%s rows add up exactly to the totals and are biggest spend first", (kind) => {
    const split = demoBreakdown(ctx, kind, rows);
    const t = sum(rows);
    const s = sum(split);
    expect(s.impressions).toBe(t.impressions);
    expect(s.clicks).toBe(t.clicks);
    expect(s.conversions).toBe(t.conversions);
    expect(s.spend).toBeCloseTo(t.spend, 2);
    expect(s.conversionValue).toBeCloseTo(t.conversionValue, 2);
    expect(split.map((r) => r.spend)).toEqual([...split.map((r) => r.spend)].sort((a, b) => b - a));
    expect(split.reduce((a, r) => a + (r.share ?? 0), 0)).toBeCloseTo(1, 6);
    for (const r of split) {
      expect(r.clicks).toBeLessThanOrEqual(r.impressions);
      expect(r.conversions).toBeLessThanOrEqual(r.clicks);
    }
  });

  it("names devices, countries (the home country first) and age groups", () => {
    expect(demoBreakdown(ctx, "device", rows).map((r) => r.id).sort()).toEqual(["DESKTOP", "MOBILE", "TABLET"]);
    const countries = demoBreakdown(ctx, "country", rows);
    expect(countries[0]!.name).toBe("India");
    expect(countries[0]!.id).toBe("2356");
    expect(demoBreakdown({ ...ctx, currency: "AUD" }, "country", rows)[0]!.name).toBe("Australia");
    expect(demoBreakdown(ctx, "age", rows).map((r) => r.id)).toContain("25-34");
  });

  it("splits nothing into zeros, never a division error", () => {
    for (const r of demoBreakdown(ctx, "device", [])) {
      expect(r.spend).toBe(0);
      expect(r.ctr).toBeNull();
      expect(r.roas).toBeNull();
      expect(r.share).toBeNull();
    }
  });
});

describe("the live report", () => {
  it("lists campaigns with their status, type and budget, totals that match, and nothing truncated", () => {
    const report = demoReport(ctx, "campaign", since, until);
    expect(report.truncated).toBe(false);
    expect(report.rows.length).toBe(DEMO_CAMPAIGNS.length);
    const sum = report.rows.reduce((a, r) => a + r.spend, 0);
    expect(sum).toBeCloseTo(report.totals.spend, 1);
    const search = report.rows.find((r) => r.id === "demo-c2")!;
    expect(search).toMatchObject({ name: "Search Advertising", status: "ENABLED", channel: "SEARCH" });
    expect(search.dailyBudget).toBe(demoMoney(60, "INR"));
    expect(report.rows.find((r) => r.id === "demo-c6")!.status).toBe("PAUSED");
  });

  it("rates each campaign's delivery as Google's primary status does, from its own figures, with a daily budget each", () => {
    const rows = demoReport(ctx, "campaign", since, until).rows;
    const of = (id: string) => rows.find((r) => r.id === id)!;
    // Search Advertising's clicks would cost more than its budget every ordinary day: its spend is held at the cap.
    expect(of("demo-c2")).toMatchObject({ primaryStatus: "LIMITED", primaryStatusReasons: ["BUDGET_CONSTRAINED"], budgetPeriod: "DAILY", totalBudget: null });
    for (const day of eachDay(since, until)) {
      const d = demoCampaignDay(ctx, DEMO_CAMPAIGNS.find((c) => c.id === "demo-c2")!, day);
      if (d) expect(d.spend).toBeCloseTo(demoMoney(60 * 1.6, ctx.currency), 1);
    }
    expect(of("demo-c1")).toMatchObject({ primaryStatus: "ELIGIBLE", primaryStatusReasons: [] });
    expect(of("demo-c6")).toMatchObject({ primaryStatus: "PAUSED", primaryStatusReasons: ["CAMPAIGN_PAUSED"] });
    expect(rows.every((r) => r.budgetPeriod === "DAILY" && r.dailyBudget !== null && r.totalBudget === null)).toBe(true);
    for (const c of DEMO_CAMPAIGNS) expect(demoPrimaryStatus(c).primaryStatus).toBe(of(c.id).primaryStatus);
    // Below a campaign, none of it.
    expect(demoReport(ctx, "ad_group", since, until).rows.every((r) => r.primaryStatus === null && r.budgetPeriod === null)).toBe(true);
  });

  it("gives Performance Max no ad groups, and names devices and countries as Google does", () => {
    const groups = demoReport(ctx, "ad_group", since, until);
    expect(groups.rows.some((r) => r.campaignName === "Conversion Optimization")).toBe(false);
    expect(groups.rows.filter((r) => r.campaignName === "Search Advertising")).toHaveLength(2);
    expect(demoReport(ctx, "device", since, until).rows.map((r) => r.name).sort()).toEqual(["Computers", "Phones", "Tablets"]);
    expect(demoReport(ctx, "country", since, until).rows[0]!.name).toBe("India");
  });
});

describe("the live report, down from a campaign", () => {
  const campaigns = demoReport(ctx, "campaign", since, until).rows;
  const campaign = (id: string) => campaigns.find((r) => r.id === id)!;
  const cents = (n: number) => Math.round(n * 100);
  const added = (rows: Array<{ spend: number; impressions: number; clicks: number; conversions: number; conversionValue: number }>) => ({
    spend: cents(rows.reduce((a, r) => a + r.spend, 0)),
    impressions: rows.reduce((a, r) => a + r.impressions, 0),
    clicks: rows.reduce((a, r) => a + r.clicks, 0),
    conversions: rows.reduce((a, r) => a + r.conversions, 0),
    conversionValue: cents(rows.reduce((a, r) => a + r.conversionValue, 0)),
  });
  const own = (r: { spend: number; impressions: number; clicks: number; conversions: number; conversionValue: number }) => added([r]);

  it("a campaign's ad groups add up to it exactly, and its totals are theirs", () => {
    const groups = demoReport(ctx, "ad_group", since, until, { campaign: "demo-c2" });
    expect(groups.rows.map((r) => r.id).sort()).toEqual(["demo-c2-broad", "demo-c2-core"]);
    expect(groups.rows.every((r) => r.campaignId === "demo-c2" && r.campaignName === "Search Advertising")).toBe(true);
    expect(added(groups.rows)).toEqual(own(campaign("demo-c2")));
    expect(own(groups.totals)).toEqual(own(campaign("demo-c2")));
    // The same groups, with the same figures, as on the whole account's list.
    const all = demoReport(ctx, "ad_group", since, until).rows.filter((r) => r.campaignId === "demo-c2");
    expect(all).toEqual(groups.rows);
  });

  it("a Performance Max campaign has asset groups instead, adding up to it; other campaigns have none", () => {
    const pmax = demoReport(ctx, "asset_group", since, until, { campaign: "demo-c7" });
    expect(pmax.rows).toHaveLength(2);
    expect(pmax.rows.every((r) => r.campaignId === "demo-c7" && r.status === "ENABLED")).toBe(true);
    expect(added(pmax.rows)).toEqual(own(campaign("demo-c7")));
    expect(demoReport(ctx, "ad_group", since, until, { campaign: "demo-c7" }).rows).toEqual([]);
    expect(demoReport(ctx, "asset_group", since, until, { campaign: "demo-c2" }).rows).toEqual([]);
  });

  it("an ad group's ads add up to it exactly, named by their type and id as Google names unnamed ads", () => {
    const group = demoReport(ctx, "ad_group", since, until, { campaign: "demo-c2" }).rows.find((r) => r.id === "demo-c2-core")!;
    const ads = demoReport(ctx, "ad", since, until, { campaign: "demo-c2", adGroup: "demo-c2-core" });
    expect(ads.rows.length).toBeGreaterThanOrEqual(2);
    expect(ads.rows.length).toBeLessThanOrEqual(3);
    for (const a of ads.rows) {
      expect(a).toMatchObject({ campaignId: "demo-c2", adGroupId: "demo-c2-core", adGroupName: "Search Advertising · Core", adType: "RESPONSIVE_SEARCH_AD", name: `Responsive search ad ${a.id}` });
      expect(a.clicks).toBeLessThanOrEqual(a.impressions);
    }
    expect(added(ads.rows)).toEqual(own(group));
    expect(own(ads.totals)).toEqual(own(group));
    // The same seed, the same ads; an ad group of another campaign gives none.
    expect(demoReport(ctx, "ad", since, until, { campaign: "demo-c2", adGroup: "demo-c2-core" })).toEqual(ads);
    expect(demoReport(ctx, "ad", since, until, { campaign: "demo-c3", adGroup: "demo-c2-core" }).rows).toEqual([]);
  });

  it("a Search campaign's keywords add up exactly to its ad groups; no other campaign has any", () => {
    const keywords = demoReport(ctx, "keyword", since, until);
    expect(new Set(keywords.rows.map((r) => r.campaignId))).toEqual(new Set(["demo-c2", "demo-c5"]));
    expect(new Set(keywords.rows.map((r) => r.id)).size).toBe(keywords.rows.length);
    const groups = demoReport(ctx, "ad_group", since, until).rows.filter((r) => r.campaignId === "demo-c2" || r.campaignId === "demo-c5");
    for (const g of groups) {
      const inGroup = keywords.rows.filter((r) => r.adGroupId === g.id);
      expect(inGroup.length).toBeGreaterThanOrEqual(4);
      // To the cent and the unit.
      expect(added(inGroup)).toEqual(own(g));
      for (const k of inGroup) {
        expect(k).toMatchObject({ campaignId: g.campaignId, campaignName: g.campaignName, adGroupName: g.name, status: "ENABLED", adType: null });
        expect(k.id.startsWith(`${g.id}~kw`)).toBe(true);
        expect(["EXACT", "PHRASE", "BROAD"]).toContain(k.matchType);
        expect(Number.isInteger(k.qualityScore)).toBe(true);
        expect(k.qualityScore).toBeGreaterThanOrEqual(1);
        expect(k.qualityScore).toBeLessThanOrEqual(10);
        expect(k.clicks).toBeLessThanOrEqual(k.impressions);
      }
    }
    // The whole account's own totals on top, which the keywords add up to less than.
    expect(own(keywords.totals)).toEqual(own(demoReport(ctx, "campaign", since, until).totals));
    expect(keywords.truncated).toBe(false);
  });

  it("keywords under a campaign or an ad group: only theirs, with the campaign's or ad group's own figures on top", () => {
    const inCampaign = demoReport(ctx, "keyword", since, until, { campaign: "demo-c5" });
    expect(inCampaign.rows.length).toBeGreaterThan(0);
    expect(inCampaign.rows.every((r) => r.campaignId === "demo-c5")).toBe(true);
    expect(own(inCampaign.totals)).toEqual(own(campaign("demo-c5")));
    const group = demoReport(ctx, "ad_group", since, until, { campaign: "demo-c2" }).rows.find((r) => r.id === "demo-c2-broad")!;
    const inGroup = demoReport(ctx, "keyword", since, until, { campaign: "demo-c2", adGroup: "demo-c2-broad" });
    expect(inGroup.rows.every((r) => r.adGroupId === "demo-c2-broad")).toBe(true);
    expect(own(inGroup.totals)).toEqual(own(group));
    expect(demoReport(ctx, "keyword", since, until, { adGroup: "demo-c2-broad" })).toEqual(inGroup);
    // A Shopping or Performance Max campaign has no keywords; an id the demo hasn't, nothing at all.
    expect(demoReport(ctx, "keyword", since, until, { campaign: "demo-c3" }).rows).toEqual([]);
    expect(demoReport(ctx, "keyword", since, until, { campaign: "demo-c7" }).rows).toEqual([]);
    const unknown = demoReport(ctx, "keyword", since, until, { adGroup: "demo-c9-core" });
    expect(unknown.rows).toEqual([]);
    expect(unknown.totals.spend).toBe(0);
  });

  it("search terms: Search, Shopping and Performance Max campaigns', never adding up past the campaign; none for Display or video", () => {
    const terms = demoReport(ctx, "search_term", since, until);
    expect(new Set(terms.rows.map((r) => r.campaignId))).toEqual(new Set(["demo-c2", "demo-c3", "demo-c5", "demo-c7"]));
    expect(new Set(terms.rows.map((r) => r.id)).size).toBe(terms.rows.length);
    for (const id of ["demo-c2", "demo-c3", "demo-c5", "demo-c7"]) {
      const mine = terms.rows.filter((r) => r.campaignId === id);
      const sum = added(mine);
      const whole = own(campaign(id));
      expect(sum.spend).toBeLessThan(whole.spend);
      expect(sum.impressions).toBeLessThanOrEqual(whole.impressions);
      expect(sum.clicks).toBeLessThanOrEqual(whole.clicks);
      expect(sum.conversions).toBeLessThanOrEqual(whole.conversions);
      expect(sum.conversionValue).toBeLessThanOrEqual(whole.conversionValue);
      expect(mine.every((r) => r.id === `${id}~${r.name}` && r.channel === DEMO_CAMPAIGNS.find((c) => c.id === id)!.type && r.status === null && r.adGroupId === null)).toBe(true);
    }
    // A Search campaign's terms include its keywords' own words.
    const keywordTexts = demoReport(ctx, "keyword", since, until, { campaign: "demo-c2" }).rows.map((r) => r.name);
    const termNames = terms.rows.filter((r) => r.campaignId === "demo-c2").map((r) => r.name);
    for (const k of keywordTexts) expect(termNames).toContain(k);
    const pmax = demoReport(ctx, "search_term", since, until, { campaign: "demo-c7" });
    expect(pmax.rows.length).toBeGreaterThanOrEqual(6);
    expect(own(pmax.totals)).toEqual(own(campaign("demo-c7")));
    expect(demoReport(ctx, "search_term", since, until, { campaign: "demo-c1" }).rows).toEqual([]);
  });

  it("keywords and search terms are the same for the same seed and differ for another", () => {
    for (const level of ["keyword", "search_term"] as const) {
      const a = demoReport(ctx, level, since, until);
      expect(demoReport(ctx, level, since, until)).toEqual(a);
      const b = demoReport({ ...ctx, seed: ctx.seed + 1 }, level, since, until);
      expect(b.rows.map((r) => r.spend)).not.toEqual(a.rows.map((r) => r.spend));
    }
  });

  it("names only its own ids as the demo's", () => {
    expect(isDemoObjectId("demo-c2")).toBe(true);
    expect(isDemoObjectId("demo-c2-core")).toBe(true);
    for (const bad of ["demo-", "demo-C2", "c2", "demo-c2' OR 1=1", "12345"]) expect(isDemoObjectId(bad)).toBe(false);
  });
});

describe("the simulated store", () => {
  const rows = demoCampaignRows(ctx, since, until);
  const days = demoStoreDays(ctx, rows, { from: since, to: until });

  it("has an order for every attributed one, and more", () => {
    expect(days).toHaveLength(90);
    for (const d of days) {
      expect(d.orders).toBeGreaterThanOrEqual(d.adOrders);
      expect(d.netSales).toBeGreaterThanOrEqual(d.adSales);
    }
    const t = demoStoreTotals(days);
    expect(t.adOrderShare!).toBeGreaterThan(0);
    expect(t.adOrderShare!).toBeLessThan(1);
    expect(t.mer!).toBeGreaterThan(t.roas!);
  });

  it("leaves a ratio undefined rather than dividing by zero", () => {
    const t = demoStoreTotals([{ day: "2026-01-01", orders: 0, netSales: 0, adOrders: 0, adSales: 0, spend: 0 }]);
    expect(t).toMatchObject({ mer: null, cac: null, roas: null, shareOfSales: null, adOrderShare: null });
  });
});
