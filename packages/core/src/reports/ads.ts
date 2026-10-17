import { toNumber, type Tx } from "@app/db";
import {
  adSeries,
  adTotals,
  adsenseSeries,
  adsenseTotals,
  campaignTotals,
  delta,
  siteTotals,
  type AdDayRow,
  type AdsenseDayRow,
  type AdSpendProvider,
  type DateRange,
} from "@app/shared";
import type { Scope } from "./common.js";

// ---------------------------------------------------------------------------
// Ad platforms (Meta Ads, Google Ads), connected on Settings → Ad accounts.
// ---------------------------------------------------------------------------

/**
 * The days to read: the range and its comparison, each on its own. The comparison needn't sit just
 * before the range (a year earlier, dates picked, even overlapping it), so one span from the
 * comparison's start to the range's end could read a year of rows, or miss a comparison after it.
 * Ad platforms report whole days, so a running comparison's `until` doesn't apply.
 */
const rangeAndComparison = (range: DateRange, previous: DateRange) => [
  { day: { gte: range.from, lte: range.to } },
  { day: { gte: previous.from, lte: previous.to } },
];

/**
 * What the store's connected ad accounts report for these dates. Only accounts in one currency
 * are added up (the store's, when any account uses it): adding dollars to euros means nothing.
 * Accounts in other currencies are listed as left out. The platforms' days are their own
 * accounts' calendar days, which match the store's when the time zones do.
 */
export async function adsModule(tx: Tx, { ws, storeId }: Scope, range: DateRange, previous: DateRange, storeCurrency: string, netSales: number | null) {
  const conns = await tx.adConnection.findMany({
    // Spend only: AdSense accounts earn money for the store and have their own module below.
    where: { workspaceId: ws, storeId, enabled: true, provider: { in: ["meta", "google"] } },
    select: { id: true, provider: true, accountId: true, accountName: true, currency: true, status: true, lastSyncedAt: true, lastError: true },
    orderBy: [{ provider: "asc" }, { createdAt: "asc" }],
  });
  if (!conns.length) return null;
  const currency = conns.some((c) => c.currency === storeCurrency) ? storeCurrency : (conns.find((c) => c.currency)?.currency ?? storeCurrency);
  const counted = conns.filter((c) => (c.currency ?? currency) === currency);
  const raw = await tx.adCampaignDaily.findMany({
    where: { workspaceId: ws, storeId, connectionId: { in: counted.map((c) => c.id) }, OR: rangeAndComparison(range, previous) },
  });
  const rows: AdDayRow[] = raw.map((r) => ({
    provider: r.provider as AdSpendProvider,
    accountId: r.accountId,
    campaignId: r.campaignId,
    campaignName: r.campaignName,
    day: r.day,
    spend: toNumber(r.spend),
    impressions: r.impressions,
    clicks: r.clicks,
    conversions: toNumber(r.conversions),
    conversionValue: toNumber(r.conversionValue),
    leads: r.leads,
  }));
  const inRange = (d: DateRange) => rows.filter((r) => r.day >= d.from && r.day <= d.to);
  const cur = inRange(range);
  const prev = inRange(previous);
  const current = adTotals(cur);
  const before = adTotals(prev);
  const providers = [...new Set(counted.map((c) => c.provider as AdSpendProvider))];
  return {
    currency,
    accounts: conns.map((c) => ({
      id: c.id,
      provider: c.provider,
      accountId: c.accountId,
      name: c.accountName,
      currency: c.currency,
      status: c.status,
      lastSyncedAt: c.lastSyncedAt,
      counted: counted.some((x) => x.id === c.id),
    })),
    current,
    previous: { spend: before.spend, clicks: before.clicks, conversions: before.conversions, conversionValue: before.conversionValue, roas: before.roas },
    deltas: {
      spend: delta(current.spend, before.spend),
      clicks: delta(current.clicks, before.clicks),
      conversions: delta(current.conversions, before.conversions),
      roas: delta(current.roas, before.roas),
    },
    series: adSeries(cur, range),
    byProvider: providers.map((p) => ({ provider: p, ...adTotals(cur.filter((r) => r.provider === p)) })),
    /** Each platform's own days, for comparing platforms on the main page. */
    seriesByProvider: providers.map((p) => ({ provider: p, series: adSeries(cur.filter((r) => r.provider === p), range) })),
    campaigns: campaignTotals(cur, 10),
    /** Ad spend as a share of the store's net sales, when both are in the same currency. */
    shareOfSales: currency === storeCurrency && netSales !== null && netSales > 0 ? current.spend / netSales : null,
  };
}

/**
 * What the store's connected AdSense accounts earned from ads shown on its site, for these dates.
 * Money the other way from adsModule: never added to ad spend. One currency only, chosen as for
 * ads; AdSense says an account's currency in its reports, so it's known after the first sync.
 */
export async function adsenseModule(tx: Tx, { ws, storeId }: Scope, range: DateRange, previous: DateRange, storeCurrency: string, netSales: number | null) {
  const conns = await tx.adConnection.findMany({
    where: { workspaceId: ws, storeId, enabled: true, provider: "adsense" },
    select: { id: true, accountId: true, accountName: true, currency: true, status: true, lastSyncedAt: true },
    orderBy: { createdAt: "asc" },
  });
  if (!conns.length) return null;
  const currency = conns.some((c) => c.currency === storeCurrency) ? storeCurrency : (conns.find((c) => c.currency)?.currency ?? storeCurrency);
  const counted = conns.filter((c) => (c.currency ?? currency) === currency);
  const raw = await tx.adsenseDaily.findMany({
    where: { workspaceId: ws, storeId, connectionId: { in: counted.map((c) => c.id) }, OR: rangeAndComparison(range, previous) },
  });
  const rows: AdsenseDayRow[] = raw.map((r) => ({
    accountId: r.accountId,
    site: r.site,
    day: r.day,
    earnings: toNumber(r.earnings),
    pageViews: r.pageViews,
    impressions: r.impressions,
    clicks: r.clicks,
  }));
  const inRange = (d: DateRange) => rows.filter((r) => r.day >= d.from && r.day <= d.to);
  const cur = inRange(range);
  const current = adsenseTotals(cur);
  const before = adsenseTotals(inRange(previous));
  return {
    currency,
    accounts: conns.map((c) => ({
      id: c.id,
      provider: "adsense" as const,
      accountId: c.accountId,
      name: c.accountName,
      currency: c.currency,
      status: c.status,
      lastSyncedAt: c.lastSyncedAt,
      counted: counted.some((x) => x.id === c.id),
    })),
    current,
    previous: { earnings: before.earnings, pageViews: before.pageViews, clicks: before.clicks, pageRpm: before.pageRpm },
    deltas: {
      earnings: delta(current.earnings, before.earnings),
      pageViews: delta(current.pageViews, before.pageViews),
      clicks: delta(current.clicks, before.clicks),
      pageRpm: delta(current.pageRpm, before.pageRpm),
    },
    series: adsenseSeries(cur, range),
    sites: siteTotals(cur, 10),
    /** Ad earnings next to the store's own net sales, when both are in the same currency. */
    vsSales: currency === storeCurrency && netSales !== null && netSales > 0 ? current.earnings / netSales : null,
  };
}
