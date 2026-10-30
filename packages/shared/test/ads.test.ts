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
  CAMPAIGN_STATUS_GROUP_LABEL,
  CAMPAIGN_STATUS_GROUPS,
  campaignStatusGroup,
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
  groupSeries,
  fromMetaRangeInsight,
  metaAttributionLabel,
  metaReportMetrics,
  googleAdName,
  googleAdTypeLabel,
  googleCampaignStatus,
  googleCustomerId,
  googleMatchTypeLabel,
  googleParentFits,
  googleReportRows,
  googleReportTotals,
  GOOGLE_DETAIL_LEVELS,
  isGoogleDetailLevel,
  isGoogleObjectId,
  isMetaObjectId,
  metaParentFits,
  metaAccountId,
  previousRange,
  siteTotals,
  adErrorMessage,
  ADSENSE_FINALIZED_BY_DAY,
  adsenseFinalThrough,
  adsenseReportRows,
  adsenseReportTotals,
  adStatusCode,
  adsVsSales,
  META_ATTRIBUTION_WINDOWS,
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
        campaign: { id: "555", name: "Search - brand", status: "PAUSED" },
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
      campaignStatus: "PAUSED",
    });
    expect(fromGoogleAdsRow("1", { metrics: {} })).toBeNull();
    expect(fromGoogleAdsRow("1", { segments: { date: "2026-10-02" } })!.campaignStatus).toBeNull();
    expect(googleCustomerId("123-456-7890")).toBe("1234567890");
    expect(metaAccountId("42")).toBe("act_42");
    expect(metaAccountId("act_42")).toBe("act_42");
  });
});

describe("the Google Ads report, down from a campaign", () => {
  it("names each ad group's, asset group's and ad's campaign (and an ad's ad group) by id, so a row can be opened", () => {
    const groups = googleReportRows("ad_group", [
      { campaign: { id: "11", name: "Brand" }, adGroup: { id: 55, name: "Shoes", status: "ENABLED" }, metrics: { costMicros: "4000000", impressions: "100", clicks: "5" } },
    ]);
    expect(groups[0]).toMatchObject({ id: "55", name: "Shoes", campaignId: "11", campaignName: "Brand", adGroupId: null, adType: null, status: "ENABLED", spend: 4 });
    const assets = googleReportRows("asset_group", [
      { campaign: { id: "12", name: "PMax" }, assetGroup: { id: "901", name: "Summer", status: "PAUSED" }, metrics: { costMicros: "1500000" } },
      { campaign: { id: "12", name: "PMax" }, assetGroup: { id: "902", name: "Winter", status: "ENABLED" }, metrics: { costMicros: "2500000" } },
    ]);
    expect(assets.map((r) => [r.id, r.name, r.campaignId, r.status, r.spend])).toEqual([
      ["902", "Winter", "12", "ENABLED", 2.5],
      ["901", "Summer", "12", "PAUSED", 1.5],
    ]);
  });

  it("names an ad by Google's own name, or, as most ad types have none, by its type and id", () => {
    const ads = googleReportRows("ad", [
      {
        campaign: { id: "11", name: "Brand" },
        adGroup: { id: "55", name: "Shoes" },
        adGroupAd: { status: "ENABLED", ad: { id: "7001", type: "RESPONSIVE_SEARCH_AD" } },
        metrics: { costMicros: "3000000", impressions: "300", clicks: "30", conversions: 1.5, conversionsValue: 60 },
      },
      { campaign: { id: "11", name: "Brand" }, adGroup: { id: "55", name: "Shoes" }, adGroupAd: { status: "PAUSED", ad: { id: 7002, name: " Spring video ", type: "VIDEO_AD" } }, metrics: { costMicros: "1000000" } },
      { campaign: { id: "11" }, adGroup: { id: "55" }, adGroupAd: { ad: { id: "7003", name: "", type: "UNKNOWN" } }, metrics: { costMicros: "500000" } },
    ]);
    expect(ads.map((r) => [r.id, r.name, r.adType, r.status, r.campaignId, r.adGroupId, r.adGroupName])).toEqual([
      ["7001", "Responsive search ad 7001", "RESPONSIVE_SEARCH_AD", "ENABLED", "11", "55", "Shoes"],
      ["7002", "Spring video", "VIDEO_AD", "PAUSED", "11", "55", "Shoes"],
      ["7003", "Ad 7003", "UNKNOWN", null, "11", "55", null],
    ]);
    expect(ads[0]).toMatchObject({ spend: 3, cpc: 0.1, conversions: 1.5, roas: 20 });
    expect(googleAdTypeLabel("RESPONSIVE_DISPLAY_AD")).toBe("Responsive display ad");
    expect(googleAdName(null, null, "9")).toBe("Ad 9");
  });

  it("adds every row up for a drill-down's totals, in micros, with the rates worked out from the sums", () => {
    const totals = googleReportTotals([
      { metrics: { costMicros: "1005000", impressions: "100", clicks: "4", conversions: 1, conversionsValue: 10 } },
      { metrics: { costMicros: "2005000", impressions: "300", clicks: "6", conversions: 0.5, conversionsValue: 5 } },
      {},
    ]);
    expect(totals).toMatchObject({ spend: 3.01, impressions: 400, clicks: 10, ctr: 0.025, conversions: 1.5, conversionValue: 15 });
    expect(googleReportTotals([])).toMatchObject({ spend: 0, impressions: 0, ctr: null, roas: null });
  });

  it("opens ad groups (one campaign's or the account's), asset groups only under a campaign, ads only under an ad group", () => {
    expect(googleParentFits("ad_group", {})).toBe(true);
    expect(googleParentFits("ad_group", { campaign: "1" })).toBe(true);
    expect(googleParentFits("ad_group", { adGroup: "2" })).toBe(false);
    expect(googleParentFits("asset_group", { campaign: "1" })).toBe(true);
    expect(googleParentFits("asset_group", {})).toBe(false);
    expect(googleParentFits("ad", { adGroup: "2" })).toBe(true);
    expect(googleParentFits("ad", { campaign: "1", adGroup: "2" })).toBe(true);
    expect(googleParentFits("ad", { campaign: "1" })).toBe(false);
    expect(googleParentFits("ad", {})).toBe(false);
    for (const level of ["campaign", "device", "country"] as const) {
      expect(googleParentFits(level, {})).toBe(true);
      expect(googleParentFits(level, { campaign: "1" })).toBe(false);
    }
    expect(isGoogleObjectId("12345678901")).toBe(true);
    for (const bad of ["1 OR 1=1", "1;", "demo-c1", "", "1".repeat(21)]) expect(isGoogleObjectId(bad)).toBe(false);
  });
});

describe("the Google Ads report's keywords and search terms", () => {
  it("reads keywords for the account, a campaign or an ad group, and search terms for the account or a campaign (Google gives them by campaign)", () => {
    for (const parent of [{}, { campaign: "1" }, { adGroup: "2" }, { campaign: "1", adGroup: "2" }]) expect(googleParentFits("keyword", parent)).toBe(true);
    expect(googleParentFits("search_term", {})).toBe(true);
    expect(googleParentFits("search_term", { campaign: "1" })).toBe(true);
    expect(googleParentFits("search_term", { adGroup: "2" })).toBe(false);
    expect(googleParentFits("search_term", { campaign: "1", adGroup: "2" })).toBe(false);
    expect([...GOOGLE_DETAIL_LEVELS]).toEqual(["keyword", "search_term"]);
    expect(isGoogleDetailLevel("keyword")).toBe(true);
    expect(isGoogleDetailLevel("search_term")).toBe(true);
    for (const level of ["campaign", "ad_group", "device", "country", "asset_group", "ad"] as const) expect(isGoogleDetailLevel(level)).toBe(false);
  });

  it("a keyword is one per ad group, with its match type, status and Quality Score (none when Google gives none)", () => {
    const rows = googleReportRows("keyword", [
      {
        campaign: { id: "11", name: "Brand" },
        adGroup: { id: "55", name: "Shoes" },
        adGroupCriterion: { criterionId: "9001", status: "ENABLED", keyword: { text: "running shoes", matchType: "EXACT" }, qualityInfo: { qualityScore: 7 } },
        metrics: { costMicros: "5000000", impressions: "500", clicks: "25", conversions: 2, conversionsValue: 120 },
      },
      // The same words in another ad group: another keyword.
      { campaign: { id: "11", name: "Brand" }, adGroup: { id: "56", name: "Boots" }, adGroupCriterion: { criterionId: "9001", status: "REMOVED", keyword: { text: "running shoes", matchType: "BROAD" } }, metrics: { costMicros: "1000000", impressions: "90" } },
      { campaign: { id: "11" }, adGroup: { id: "55" }, adGroupCriterion: { criterionId: 9002, keyword: { matchType: "PHRASE" }, qualityInfo: { qualityScore: 0 } }, metrics: { costMicros: "250000", impressions: "10" } },
    ]);
    expect(rows.map((r) => [r.id, r.name, r.campaignId, r.adGroupId, r.adGroupName, r.status, r.matchType, r.qualityScore])).toEqual([
      ["55~9001", "running shoes", "11", "55", "Shoes", "ENABLED", "EXACT", 7],
      ["56~9001", "running shoes", "11", "56", "Boots", "REMOVED", "BROAD", null],
      ["55~9002", "Keyword 9002", "11", "55", null, null, "PHRASE", null],
    ]);
    expect(rows[0]).toMatchObject({ spend: 5, ctr: 0.05, cpc: 0.2, conversions: 2, conversionValue: 120, roas: 24, adType: null, channel: null, dailyBudget: null });
    expect(googleMatchTypeLabel("EXACT")).toBe("Exact match");
    expect(googleMatchTypeLabel("PHRASE")).toBe("Phrase match");
    expect(googleMatchTypeLabel("UNKNOWN")).toBeNull();
    expect(googleMatchTypeLabel(null)).toBeNull();
  });

  it("a search term is one per campaign, with the campaign's type and no status of its own", () => {
    const rows = googleReportRows("search_term", [
      { campaign: { id: "12", name: "PMax", advertisingChannelType: "PERFORMANCE_MAX" }, campaignSearchTermView: { searchTerm: "trail shoes" }, metrics: { costMicros: "3000000", impressions: "300", clicks: "12" } },
      { campaign: { id: "11", name: "Brand", advertisingChannelType: "SEARCH" }, campaignSearchTermView: { searchTerm: "trail shoes" }, metrics: { costMicros: "4000000", impressions: "200", clicks: "20" } },
    ]);
    expect(rows.map((r) => [r.id, r.name, r.campaignId, r.campaignName, r.channel, r.status, r.matchType, r.qualityScore, r.spend])).toEqual([
      ["11~trail shoes", "trail shoes", "11", "Brand", "SEARCH", null, null, null, 4],
      ["12~trail shoes", "trail shoes", "12", "PMax", "PERFORMANCE_MAX", null, null, null, 3],
    ]);
  });

  it("every other level's rows carry none of a keyword's fields, and devices and countries read as before", () => {
    const devices = googleReportRows("device", [{ segments: { device: "MOBILE" }, metrics: { costMicros: "1000000" } }]);
    expect(devices[0]).toMatchObject({ id: "MOBILE", name: "Phones", matchType: null, qualityScore: null, adGroupName: null });
    const countries = googleReportRows("country", [{ userLocationView: { countryCriterionId: "2840" }, metrics: { costMicros: "1000000" } }], new Map([["2840", "US"]]));
    expect(countries[0]).toMatchObject({ id: "2840", name: "United States", matchType: null, qualityScore: null });
    expect(googleReportRows("campaign", [{ campaign: { id: "1", name: "Brand" } }])[0]).toMatchObject({ matchType: null, qualityScore: null });
  });
});

describe("a Google campaign's delivery and budget", () => {
  it("keeps Google's primary status and reasons, and its budget per day or as one total, never both", () => {
    const rows = googleReportRows("campaign", [
      {
        campaign: { id: "1", name: "Brand", status: "ENABLED", primaryStatus: "LIMITED", primaryStatusReasons: ["BUDGET_CONSTRAINED", "UNKNOWN"] },
        campaignBudget: { period: "DAILY", amountMicros: "40000000" },
        metrics: { costMicros: "9000000" },
      },
      // A campaign total budget: Google gives total_amount_micros, not amount_micros.
      { campaign: { id: "2", name: "Launch", status: "ENABLED", primaryStatus: "ELIGIBLE" }, campaignBudget: { period: "CUSTOM_PERIOD", totalAmountMicros: "500000000" }, metrics: { costMicros: "8000000" } },
      // Neither status nor budget given: unknown, never a made-up one.
      { campaign: { id: "3", name: "Old", status: "PAUSED", primaryStatus: "UNSPECIFIED" }, metrics: { costMicros: "1000000" } },
    ]);
    expect(rows.map((r) => [r.id, r.primaryStatus, r.primaryStatusReasons, r.budgetPeriod, r.dailyBudget, r.totalBudget])).toEqual([
      ["1", "LIMITED", ["BUDGET_CONSTRAINED"], "DAILY", 40, null],
      ["2", "ELIGIBLE", [], "CUSTOM_PERIOD", null, 500],
      ["3", null, [], null, null, null],
    ]);
    // Every other level has none of them.
    expect(googleReportRows("ad_group", [{ campaign: { id: "1" }, adGroup: { id: "5" }, metrics: {} }])[0]).toMatchObject({ primaryStatus: null, primaryStatusReasons: [], budgetPeriod: null, totalBudget: null });
  });

  it("words the status and its most telling reason first, leaving out the reasons that only say the status again", () => {
    expect(googleCampaignStatus("LIMITED", ["SEARCH_VOLUME_LIMITED", "BUDGET_CONSTRAINED"])).toEqual({ label: "Limited", reasons: ["limited by budget", "missing some relevant searches"] });
    expect(googleCampaignStatus("ELIGIBLE", [])).toEqual({ label: "Eligible", reasons: [] });
    expect(googleCampaignStatus("LEARNING", ["BIDDING_STRATEGY_LEARNING"])).toEqual({ label: "Learning", reasons: ["bid strategy learning"] });
    expect(googleCampaignStatus("NOT_ELIGIBLE", ["HAS_ADS_DISAPPROVED", "NO_AD_GROUP_ADS"])).toEqual({ label: "Not eligible", reasons: ["no ads that can run", "some ads disapproved"] });
    expect(googleCampaignStatus("PAUSED", ["CAMPAIGN_PAUSED"])).toEqual({ label: "Paused", reasons: [] });
    expect(googleCampaignStatus("ENDED", ["CAMPAIGN_ENDED"])).toEqual({ label: "Ended", reasons: [] });
    expect(googleCampaignStatus("PENDING", ["CAMPAIGN_PENDING"])).toEqual({ label: "Pending", reasons: ["start date still to come"] });
    // A reason newer than the list reads as Google words it.
    expect(googleCampaignStatus("LIMITED", ["SOME_NEW_REASON"])).toEqual({ label: "Limited", reasons: ["some new reason"] });
    // No status from Google: the campaign's own status shows instead.
    for (const none of [null, undefined, "UNKNOWN", "UNSPECIFIED"]) expect(googleCampaignStatus(none, ["BUDGET_CONSTRAINED"])).toBeNull();
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

describe("a daily series in weeks and months", () => {
  const d = (day: string, spend: number | null, clicks: number | null = spend === null ? null : 1) => ({ day, spend, clicks });

  it("adds each Monday-to-Sunday week's days up, and leaves a week missing any day blank", () => {
    // Thursday 1 Oct to Wednesday 14 Oct: 4 days of one week, a whole week, 3 days of the next.
    const days = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14"];
    const series = days.map((day) => d(day, day === "2026-10-13" ? null : 10.1));
    const weeks = groupSeries(series, { from: "2026-10-01", to: "2026-10-14" }, "week");
    expect(weeks.map((w) => [w.key, w.day, w.from, w.to, w.spend, w.clicks])).toEqual([
      ["2026-W40", "2026-10-01", "2026-10-01", "2026-10-04", 40.4, 4],
      ["2026-W41", "2026-10-05", "2026-10-05", "2026-10-11", 70.7, 7],
      // 13 Oct has no figures yet: the week is unknown, not 20.2.
      ["2026-W42", "2026-10-12", "2026-10-12", "2026-10-14", null, null],
    ]);
  });

  it("adds calendar months up, and keeps a figure missing on one day apart from the others", () => {
    const series = [d("2026-09-29", 5), d("2026-09-30", 5), { day: "2026-10-01", spend: 7, clicks: null }, d("2026-10-02", 3)];
    expect(groupSeries(series, { from: "2026-09-29", to: "2026-10-02" }, "month")).toEqual([
      { day: "2026-09-29", key: "2026-09", from: "2026-09-29", to: "2026-09-30", spend: 10, clicks: 2 },
      { day: "2026-10-01", key: "2026-10", from: "2026-10-01", to: "2026-10-02", spend: 10, clicks: null },
    ]);
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
        { action_type: "omni_landing_page_view", value: "500" },
        { action_type: "landing_page_view", value: "500" },
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
      // Counted once, though Meta reports it under two names.
      landingPageViews: 500,
      costPerLandingPageView: 0.5,
      purchases: 10,
      purchaseValue: 1000,
      costPerPurchase: 25,
      roas: 4,
      leads: 3,
      // No window was asked for: none is reported, never 0.
      byWindow: {
        "1d_click": { purchases: null, purchaseValue: null, costPerPurchase: null, roas: null },
        "7d_click": { purchases: null, purchaseValue: null, costPerPurchase: null, roas: null },
        "1d_view": { purchases: null, purchaseValue: null, costPerPurchase: null, roas: null },
      },
    });
  });

  it("reads each attribution window's purchases from the same action as the ad set's own setting, and says not reported where Meta's figure can't be read", () => {
    const m = metaReportMetrics(
      {
        spend: "100",
        actions: [
          // The ad set's own setting (value), and each window Meta reported, as keys of the action.
          { action_type: "omni_purchase", value: "8", "1d_click": "5", "7d_click": "7" },
          { action_type: "purchase", value: "8", "1d_click": "5", "7d_click": "7", "1d_view": "1" },
        ],
        action_values: [{ action_type: "omni_purchase", value: "400", "1d_click": "250", "7d_click": "350", "1d_view": "" }],
      },
      true,
    );
    expect(m).toMatchObject({ purchases: 8, purchaseValue: 400, costPerPurchase: 12.5, roas: 4 });
    expect(m.byWindow["1d_click"]).toEqual({ purchases: 5, purchaseValue: 250, costPerPurchase: 20, roas: 2.5 });
    expect(m.byWindow["7d_click"]).toEqual({ purchases: 7, purchaseValue: 350, costPerPurchase: 14.29, roas: 3.5 });
    // omni_purchase is the action counted, and purchase's 1-day view figure isn't borrowed for it: Meta left
    // that window out of the count (none), and its value can't be read (not reported).
    expect(m.byWindow["1d_view"]).toEqual({ purchases: 0, purchaseValue: null, costPerPurchase: null, roas: null });
    // A window with purchases but nothing spent: no cost per purchase or return to work out.
    expect(metaReportMetrics({ spend: "0", actions: [{ action_type: "purchase", value: "1", "1d_click": "0" }] }, true).byWindow["1d_click"]).toEqual({ purchases: 0, purchaseValue: 0, costPerPurchase: null, roas: null });
    expect([...META_ATTRIBUTION_WINDOWS]).toEqual(["1d_click", "7d_click", "1d_view"]);
    expect(META_ATTRIBUTION_WINDOWS.map(metaAttributionLabel)).toEqual(["1-day click", "7-day click", "1-day view"]);
  });

  it("reads no purchase under a window as none once the windows were asked for, as under each ad set's own setting", () => {
    // Spent with no purchase: Meta lists no purchase action. Each ad set's setting reads 0, and so does every window.
    const none = metaReportMetrics({ spend: "40", actions: [{ action_type: "link_click", value: "9", "7d_click": "9" }] }, true);
    expect(none).toMatchObject({ purchases: 0, purchaseValue: 0, costPerPurchase: null, roas: 0 });
    for (const w of META_ATTRIBUTION_WINDOWS) expect(none.byWindow[w]).toEqual({ purchases: 0, purchaseValue: 0, costPerPurchase: null, roas: 0 });
    // The same answer read without the windows (not asked, or Meta refused them): not reported, never 0.
    for (const w of META_ATTRIBUTION_WINDOWS) expect(metaReportMetrics({ spend: "40" }).byWindow[w]).toEqual({ purchases: null, purchaseValue: null, costPerPurchase: null, roas: null });
    // The rows of a report read with them carry the same reading.
    expect(fromMetaRangeInsight("campaign", { campaign_id: "1", spend: "40" }, true).byWindow["1d_view"].purchases).toBe(0);
    expect(fromMetaRangeInsight("campaign", { campaign_id: "1", spend: "40" }).byWindow["1d_view"].purchases).toBeNull();
  });

  it("says 'unknown' rather than zero when Meta leaves a figure out, and never divides by zero", () => {
    const m = metaReportMetrics({ spend: "0", impressions: "0" });
    expect(m).toMatchObject({ reach: null, frequency: null, linkCtr: null, costPerLinkClick: null, cpm: null, landingPageViews: 0, costPerLandingPageView: null, costPerPurchase: null, roas: null, purchases: 0 });
    // Frequency is impressions per person when Meta gives reach but not frequency.
    expect(metaReportMetrics({ impressions: "300", reach: "120" }).frequency).toBe(2.5);
  });

  it("names rows by their level and keeps the campaign and ad set they sit in", () => {
    const row = { campaign_id: "1", campaign_name: "Spring", adset_id: "2", adset_name: "Women 25-34", ad_id: "3", ad_name: "Carousel", attribution_setting: "7d_click_1d_view" };
    expect(fromMetaRangeInsight("campaign", row)).toMatchObject({ id: "1", name: "Spring", campaignId: null, campaignName: null, adsetId: null, adsetName: null });
    expect(fromMetaRangeInsight("adset", row)).toMatchObject({ id: "2", name: "Women 25-34", campaignId: "1", campaignName: "Spring", adsetId: null, adsetName: null, attribution: "7d_click_1d_view" });
    expect(fromMetaRangeInsight("ad", row)).toMatchObject({ id: "3", name: "Carousel", campaignId: "1", campaignName: "Spring", adsetId: "2", adsetName: "Women 25-34", status: null });
    // A row Meta sent without its parents' ids can't be opened or kept to one campaign: unknown, never made up.
    expect(fromMetaRangeInsight("ad", { ad_id: "3" })).toMatchObject({ campaignId: null, adsetId: null });
  });

  it("opens a campaign's ad sets or ads and an ad set's ads, nothing else, by Meta's own ids", () => {
    expect(metaParentFits("adset", { campaign: "1" })).toBe(true);
    expect(metaParentFits("ad", { campaign: "1" })).toBe(true);
    expect(metaParentFits("ad", { campaign: "1", adset: "2" })).toBe(true);
    expect(metaParentFits("ad", { adset: "2" })).toBe(true);
    expect(metaParentFits("campaign", { campaign: "1" })).toBe(false);
    expect(metaParentFits("adset", { adset: "2" })).toBe(false);
    expect(metaParentFits("placement", { campaign: "1" })).toBe(false);
    for (const level of ["campaign", "adset", "ad", "country"] as const) expect(metaParentFits(level, {})).toBe(true);
    expect(isMetaObjectId("120210000000000001")).toBe(true);
    for (const bad of ["", "1 OR 1=1", "act_1", "-1", "1".repeat(31), 12]) expect(isMetaObjectId(bad)).toBe(false);
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
  const rows = [{ earnings: 1, pageViews: 100, impressions: 200, clicks: 2, pageRpm: 10, perClick: 0.5, ctr: 0.01, adRequests: null, coverage: null, viewability: null }];

  it("are AdSense's totals row when it sent one, read by column name, else the rows added up", () => {
    expect(adsenseReportTotals({ headers, totals: { cells: [{}, { value: "12.5" }, { value: "5000" }, { value: "8000" }, { value: "25" }] } }, rows)).toEqual({
      earnings: 12.5,
      pageViews: 5000,
      impressions: 8000,
      clicks: 25,
      pageRpm: 2.5,
      perClick: 0.5,
      ctr: 25 / 8000,
      // Not asked of AdSense (an answer without the columns): unknown, never 0.
      adRequests: null,
      coverage: null,
      viewability: null,
    });
    expect(adsenseReportTotals({ headers }, rows)).toMatchObject({ earnings: 1, pageViews: 100, impressions: 200, clicks: 2 });
    expect(adsenseReportTotals({}, [])).toMatchObject({ earnings: 0, pageRpm: null, adRequests: null, coverage: null, viewability: null });
  });

  it("take ad requests, coverage and viewability as AdSense's totals row gives them, or add up what can be", () => {
    const all = [...headers, { name: "AD_REQUESTS" }, { name: "AD_REQUESTS_COVERAGE" }, { name: "ACTIVE_VIEW_VIEWABILITY" }];
    const totals = { cells: [{}, { value: "12.5" }, { value: "5000" }, { value: "8000" }, { value: "25" }, { value: "10000" }, { value: "0.8" }, { value: "0.62" }] };
    expect(adsenseReportTotals({ headers: all, totals }, [])).toMatchObject({ adRequests: 10000, coverage: 0.8, viewability: 0.62 });
    // Without one: requests add, coverage is worked back through them (600 + 100 of 1,000), viewability can't be.
    const a = { ...rows[0]!, adRequests: 800, coverage: 0.75, viewability: 0.5 };
    const b = { ...rows[0]!, adRequests: 200, coverage: 0.5, viewability: 0.9 };
    expect(adsenseReportTotals({ headers: all }, [a, b])).toMatchObject({ adRequests: 1000, coverage: 0.7, viewability: null });
    // One row's are its own; one row without requests leaves the sum unknown.
    expect(adsenseReportTotals({ headers: all }, [a])).toMatchObject({ adRequests: 800, coverage: 0.75, viewability: 0.5 });
    expect(adsenseReportTotals({ headers: all }, [a, { ...b, adRequests: null }])).toMatchObject({ adRequests: null, coverage: null });
  });
});

describe("the AdSense report by ad unit", () => {
  const headers = [
    { name: "AD_UNIT_ID", type: "DIMENSION" },
    { name: "AD_UNIT_NAME", type: "DIMENSION" },
    { name: "ESTIMATED_EARNINGS", type: "METRIC_CURRENCY", currencyCode: "AUD" },
    { name: "PAGE_VIEWS", type: "METRIC_TALLY" },
    { name: "IMPRESSIONS", type: "METRIC_TALLY" },
    { name: "CLICKS", type: "METRIC_TALLY" },
    { name: "AD_REQUESTS", type: "METRIC_TALLY" },
    { name: "AD_REQUESTS_COVERAGE", type: "METRIC_RATIO" },
    { name: "ACTIVE_VIEW_VIEWABILITY", type: "METRIC_RATIO" },
  ];
  const cells = (...v: string[]) => ({ cells: v.map((value) => ({ value })) });

  it("names each ad unit as AdSense does, with its requests, coverage and viewability; a ratio AdSense left empty is unknown", () => {
    const { rows, currency } = adsenseReportRows("ad_unit", {
      headers,
      rows: [cells("ca-pub-1:111", "Sidebar", "1.50", "300", "280", "2", "320", "0.875", "0.6"), cells("ca-pub-1:222", "Footer", "4.20", "900", "850", "5", "1000", "0.85", "")],
    });
    expect(currency).toBe("AUD");
    expect(rows).toEqual([
      { id: "ca-pub-1:222", name: "Footer", earnings: 4.2, pageViews: 900, impressions: 850, clicks: 5, pageRpm: 4.67, perClick: 0.84, ctr: 5 / 850, adRequests: 1000, coverage: 0.85, viewability: null },
      { id: "ca-pub-1:111", name: "Sidebar", earnings: 1.5, pageViews: 300, impressions: 280, clicks: 2, pageRpm: 5, perClick: 0.75, ctr: 2 / 280, adRequests: 320, coverage: 0.875, viewability: 0.6 },
    ]);
    // An ad unit AdSense gives no name for goes by its id.
    expect(adsenseReportRows("ad_unit", { headers, rows: [cells("ca-pub-1:333", "", "1", "1", "1", "0", "1", "1", "1")] }).rows[0]).toMatchObject({ id: "ca-pub-1:333", name: "ca-pub-1:333" });
  });
});

describe("whether AdSense's figures are final", () => {
  it("are final for every month that ended before the month before the read, and for that month too once it was past the 10th", () => {
    expect(ADSENSE_FINALIZED_BY_DAY).toBe(10);
    // Read on 5 Nov: October is still being finalized (and re-read daily); September is final.
    expect(adsenseFinalThrough("2026-11-05")).toBe("2026-09-30");
    expect(adsenseFinalThrough("2026-11-10")).toBe("2026-09-30");
    // On the 11th the re-reads of October's first ten days are done.
    expect(adsenseFinalThrough("2026-11-11")).toBe("2026-10-31");
    expect(adsenseFinalThrough("2026-11-30")).toBe("2026-10-31");
    // Across the year's turn, and February's short month.
    expect(adsenseFinalThrough("2027-01-03")).toBe("2026-11-30");
    expect(adsenseFinalThrough("2027-01-20")).toBe("2026-12-31");
    expect(adsenseFinalThrough("2028-03-11")).toBe("2028-02-29");
    // Never read: nothing is final.
    expect(adsenseFinalThrough(null)).toBeNull();
    expect(adsenseFinalThrough("not a day")).toBeNull();
  });
});

describe("a campaign's status, as the campaign filters group it", () => {
  it("puts Google's and Meta's own words in the same four groups, and an unread status in none", () => {
    expect(["ENABLED", "ACTIVE", "enabled"].map(campaignStatusGroup)).toEqual(["active", "active", "active"]);
    expect(["PAUSED", "CAMPAIGN_PAUSED", "ADSET_PAUSED"].map(campaignStatusGroup)).toEqual(["paused", "paused", "paused"]);
    expect(["REMOVED", "DELETED", "ARCHIVED"].map(campaignStatusGroup)).toEqual(["ended", "ended", "ended"]);
    expect(["WITH_ISSUES", "IN_PROCESS", "PENDING_BILLING_INFO", "UNKNOWN"].map(campaignStatusGroup)).toEqual(["other", "other", "other", "other"]);
    expect([null, undefined, ""].map(campaignStatusGroup)).toEqual([null, null, null]);
    expect(CAMPAIGN_STATUS_GROUPS.map((g) => CAMPAIGN_STATUS_GROUP_LABEL[g])).toEqual(["Active", "Paused", "Removed or archived", "Other"]);
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
