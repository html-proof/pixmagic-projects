import { toNumber, type Tx } from "@app/db";
import {
  adSeries,
  adTotals,
  adsenseSeries,
  adsenseTotals,
  adsHistoryStart,
  campaignTotals,
  comparisonImported,
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
 * Ad platforms report whole days, so a running comparison's `until` doesn't apply. A comparison
 * from before the accounts' history isn't read at all (see `adsHistory`).
 */
const rangeAndComparison = (range: DateRange, previous: DateRange, compared: boolean) => [
  { day: { gte: range.from, lte: range.to } },
  ...(compared ? [{ day: { gte: previous.from, lte: previous.to } }] : []),
];

/**
 * From which day the counted accounts all have their figures (`historyFrom`: the latest of their
 * starts, see `adsHistoryStart`), and whether the comparison is from then on (`imported`). An
 * account connected today brings the 90 days before it: a comparison reaching back further would
 * count it in the dates picked and not in the dates compared with, a rise that never happened, so
 * its figures and changes are left out (null) and the page says there is no earlier data.
 */
function adsHistory(counted: Array<{ historyFrom: string | null }>, previous: DateRange) {
  const historyFrom = adsHistoryStart(counted.map((c) => c.historyFrom));
  return { historyFrom, imported: comparisonImported(previous, historyFrom) };
}

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
    select: { id: true, provider: true, accountId: true, accountName: true, currency: true, status: true, lastSyncedAt: true, lastError: true, historyFrom: true },
    orderBy: [{ provider: "asc" }, { createdAt: "asc" }],
  });
  if (!conns.length) return null;
  const currency = conns.some((c) => c.currency === storeCurrency) ? storeCurrency : (conns.find((c) => c.currency)?.currency ?? storeCurrency);
  const counted = conns.filter((c) => (c.currency ?? currency) === currency);
  const { historyFrom, imported } = adsHistory(counted, previous);
  const raw = await tx.adCampaignDaily.findMany({
    where: { workspaceId: ws, storeId, connectionId: { in: counted.map((c) => c.id) }, OR: rangeAndComparison(range, previous, imported) },
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
    /** The first day every counted account has figures from (null: none synced yet). */
    historyFrom,
    previous: imported
      ? { spend: before.spend, clicks: before.clicks, conversions: before.conversions, conversionValue: before.conversionValue, roas: before.roas, imported }
      : { spend: null, clicks: null, conversions: null, conversionValue: null, roas: null, imported },
    deltas: {
      spend: imported ? delta(current.spend, before.spend) : null,
      clicks: imported ? delta(current.clicks, before.clicks) : null,
      conversions: imported ? delta(current.conversions, before.conversions) : null,
      roas: imported ? delta(current.roas, before.roas) : null,
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
    select: { id: true, accountId: true, accountName: true, currency: true, status: true, lastSyncedAt: true, historyFrom: true },
    orderBy: { createdAt: "asc" },
  });
  if (!conns.length) return null;
  const currency = conns.some((c) => c.currency === storeCurrency) ? storeCurrency : (conns.find((c) => c.currency)?.currency ?? storeCurrency);
  const counted = conns.filter((c) => (c.currency ?? currency) === currency);
  const { historyFrom, imported } = adsHistory(counted, previous);
  const raw = await tx.adsenseDaily.findMany({
    where: { workspaceId: ws, storeId, connectionId: { in: counted.map((c) => c.id) }, OR: rangeAndComparison(range, previous, imported) },
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
    /** The first day every counted account has figures from (null: none synced yet). */
    historyFrom,
    previous: imported
      ? { earnings: before.earnings, pageViews: before.pageViews, clicks: before.clicks, pageRpm: before.pageRpm, imported }
      : { earnings: null, pageViews: null, clicks: null, pageRpm: null, imported },
    deltas: {
      earnings: imported ? delta(current.earnings, before.earnings) : null,
      pageViews: imported ? delta(current.pageViews, before.pageViews) : null,
      clicks: imported ? delta(current.clicks, before.clicks) : null,
      pageRpm: imported ? delta(current.pageRpm, before.pageRpm) : null,
    },
    series: adsenseSeries(cur, range),
    sites: siteTotals(cur, 10),
    /** Ad earnings next to the store's own net sales, when both are in the same currency. */
    vsSales: currency === storeCurrency && netSales !== null && netSales > 0 ? current.earnings / netSales : null,
  };
}
