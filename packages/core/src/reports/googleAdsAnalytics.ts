import { toNumber, type AdConnection, type Tx } from "@app/db";
import {
  accountCoverage,
  adsMetrics,
  adsRecommendations,
  adsSeries,
  campaignAnalytics,
  conversionSeries,
  coversDays,
  delta,
  DEMO_CAMPAIGNS,
  DEMO_DISCLAIMER,
  demoBreakdown,
  demoCampaignFacts,
  demoStoreDays,
  demoStoreTotals,
  topConverting,
  type AdDayRow,
  type AdsMetrics,
  type CampaignSettings,
  type DateRange,
  type DemoBreakdownRow,
} from "@app/shared";
import { demoContextOf, isDemoConnection } from "../ads/googleAdsSource.js";
import { googleAdsConnectionStatus } from "../adConnections/demo.js";
import { adToday } from "../adConnections/sync.js";

// ---------------------------------------------------------------------------
// The Google Ads analytics page's answer for one connection and range (apps/api/src/routes/
// adsGoogleDemo.ts): the connection's stored campaign-days worked into the overview, the series by day,
// week and month, the campaign table, the conversion analytics and the recommendations
// (@app/shared/adsAnalytics), the same for a demo account and a real one. What only a demo has is
// generated from its seed (@app/shared/adsDemo): the splits by device, country, age group and audience
// segment, and the simulated store its spend is set against. A real connection's device and country
// splits come from Google's live report, which the route reads; nothing here is ever generated for one.
// ---------------------------------------------------------------------------

export interface GoogleAdsAnalyticsOptions {
  now?: Date;
  /** Whether campaign-level figures are included (Team & Access "View campaigns"); true unless said otherwise. */
  campaigns?: boolean;
}

/** A change between the range's figures and the comparison's, per metric (null without a comparison or a before figure). */
export type AdsDeltas = { [K in keyof AdsMetrics]: number | null };

export async function googleAdsAnalytics(tx: Tx, conn: AdConnection, range: DateRange, previous: DateRange, opts: GoogleAdsAnalyticsOptions = {}) {
  const now = opts.now ?? new Date();
  const demo = isDemoConnection(conn);
  const withCampaigns = opts.campaigns !== false;
  const raw = await tx.adCampaignDaily.findMany({
    where: {
      workspaceId: conn.workspaceId,
      storeId: conn.storeId,
      connectionId: conn.id,
      OR: [{ day: { gte: range.from, lte: range.to } }, { day: { gte: previous.from, lte: previous.to } }],
    },
  });
  const rows: AdDayRow[] = raw.map((r) => ({
    provider: "google",
    accountId: r.accountId,
    campaignId: r.campaignId,
    campaignName: r.campaignName,
    day: r.day,
    spend: toNumber(r.spend),
    impressions: r.impressions,
    clicks: r.clicks,
    linkClicks: r.linkClicks,
    conversions: toNumber(r.conversions),
    conversionValue: toNumber(r.conversionValue),
    purchases: r.purchases === null ? null : toNumber(r.purchases),
    purchaseValue: r.purchaseValue === null ? null : toNumber(r.purchaseValue),
    leads: r.leads,
  }));
  const within = (w: DateRange) => rows.filter((r) => r.day >= w.from && r.day <= w.to);
  const inRange = within(range);
  const today = adToday(conn, now);
  const coverage = accountCoverage(conn, today);
  const ctx = demo ? demoContextOf(conn) : null;
  const settings: CampaignSettings[] = ctx
    ? DEMO_CAMPAIGNS.map((c) => {
        const f = demoCampaignFacts(ctx, c);
        return { id: f.id, name: f.name, type: f.type, status: f.status, startDay: f.startDay, dailyBudget: f.dailyBudget };
      })
    : [];
  const campaigns = campaignAnalytics(inRange, range, settings);
  const current = adsMetrics(inRange);
  // Compared only with days the connection has stored in full: a comparison from before its history would read as growth from nothing.
  const before = coversDays(coverage, previous) ? adsMetrics(within(previous)) : null;
  const deltas = Object.fromEntries((Object.keys(current) as Array<keyof AdsMetrics>).map((k) => [k, before ? delta(current[k], before[k]) : null])) as AdsDeltas;
  const split = (kind: "device" | "country" | "age" | "segment"): DemoBreakdownRow[] | null => (ctx ? demoBreakdown(ctx, kind, inRange) : null);
  const storeDays = ctx ? demoStoreDays(ctx, inRange, range) : null;
  return {
    account: {
      id: conn.id,
      accountId: conn.accountId,
      name: conn.accountName,
      currency: conn.currency,
      timezone: conn.timezone,
      /** Simulated figures (the Google Ads demo). */
      demo,
      connectionType: demo ? ("demo" as const) : ("production" as const),
      /** "simulated": bizinsights' own demo; "authorized": the person authorized a real account at Google (which says nothing about Google verifying bizinsights). */
      verificationStatus: demo ? ("simulated" as const) : ("authorized" as const),
      status: googleAdsConnectionStatus(conn, now.getTime()),
      lastSyncedAt: conn.lastSyncedAt?.toISOString() ?? null,
      historyFrom: conn.historyFrom,
      syncedThrough: conn.syncedThrough,
      /** The seed a demo's figures are generated from; null for a real account. */
      seed: demo ? conn.demoSeed : null,
    },
    range,
    previous,
    today,
    /** The days the connection has stored without a gap, and whether they cover the range (a figure for days it lacks is a short count). */
    coverage: { from: coverage.from, through: coverage.through, complete: coversDays(coverage, range) },
    disclaimer: demo ? DEMO_DISCLAIMER : null,
    overview: { current, previous: before, deltas },
    series: { day: adsSeries(inRange, range, "day"), week: adsSeries(inRange, range, "week"), month: adsSeries(inRange, range, "month") },
    /** Every campaign with figures in the range (the campaigns endpoint searches, sorts and pages them). */
    campaigns: withCampaigns ? campaigns : null,
    conversions: { series: conversionSeries(inRange, range), top: withCampaigns ? topConverting(campaigns) : null },
    /** Devices: a demo's generated split; a real account's comes from Google's live report (the route adds it). */
    devices: split("device"),
    audience: {
      age: split("age"),
      countries: split("country"),
      segments: split("segment"),
      devices: split("device"),
      note: demo
        ? "Aggregated synthetic audience figures, generated with the demo: they describe no person."
        : "Google shares device and country splits through its report; age groups and audience segments aren't read for real accounts.",
    },
    /** Rule-based (RECOMMENDATION_RULES in @app/shared); `simulated` says they are drawn from demo figures. */
    recommendations: withCampaigns ? adsRecommendations(campaigns).map((r) => ({ ...r, simulated: demo })) : null,
    /**
     * A demo's spend next to a simulated store: modeled attribution, never a real store's sales. Null for a
     * real account, whose spend the dashboard sets against the store's own sales.
     */
    combined: storeDays
      ? {
          days: storeDays,
          totals: demoStoreTotals(storeDays),
          note: "Simulated store figures generated with the demo (modeled attribution: the demo campaigns credit a part of the orders to themselves, never all of them). Not your Shopify sales.",
        }
      : null,
  };
}

export type GoogleAdsAnalytics = Awaited<ReturnType<typeof googleAdsAnalytics>>;
