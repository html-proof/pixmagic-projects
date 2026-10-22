import { toNumber, type Tx } from "@app/db";
import {
  accountCoverage,
  adComparisonWindows,
  adSeries,
  adsenseSeries,
  adsenseSiteChosen,
  adsenseTotals,
  adsVsSales,
  adTotals,
  campaignTotals,
  canCompareFrom,
  commonCoverage,
  coverageAfter,
  coveredPart,
  coversDays,
  delta,
  isClosedAdAccount,
  lastWholeAdDay,
  localDay,
  sameDays,
  siteTotals,
  trafficSourcePlatform,
  type AdDayRow,
  type AdsenseDayRow,
  type AdSpendProvider,
  type AdTotals,
  type Comparison,
  type DateRange,
} from "@app/shared";
import { adToday } from "../adConnections/sync.js";
import { num, r2, type Scope } from "./common.js";
import { salesByOrder } from "./orders.js";

// ---------------------------------------------------------------------------
// Ad platforms (Meta Ads, Google Ads) and Google AdSense, connected on Settings → Ad accounts: what
// their stored days add up to for the dashboard.
//
// Every figure is given only for days the accounts it adds up have stored. Each account covers the
// days from where its history starts (history_from) to the last day stored without a gap
// (synced_through). A day an account hasn't stored (never synced yet, its syncs stopped, access
// ended, or the day hasn't started yet in the account's own time zone) is missing: never added in as
// 0. A total that would need a missing day is null, and `partial` gives the part of the range every
// account covers, so the page can say "Unavailable" and why, and what it does know. When the only
// days missing are ones not over yet (`soFar`), the page shows the total up to the last day stored.
// ---------------------------------------------------------------------------

/** What these modules read of each connection. */
export interface AdConn {
  id: string;
  provider: string;
  accountId: string;
  accountName: string | null;
  currency: string | null;
  timezone: string | null;
  status: string;
  errorCode: string | null;
  accountStatus: string | null;
  lastSyncedAt: Date | null;
  historyFrom: string | null;
  syncedThrough: string | null;
  /** AdSense: the sites (DOMAIN_CODE) whose earnings belong to the store; empty = every site. */
  sites?: string[];
  /** Google Ads: a demo connection, whose figures bizinsights generates (never set against the store's real sales). */
  isDemo?: boolean;
}

/** The dates asked about, and the store they're asked for. */
export interface AdsAsk {
  range: DateRange;
  previous: Comparison;
  storeCurrency: string;
  /** The store's time zone: the dashboard's days. */
  storeTimeZone: string;
  /** The store's net sales for the range (null: not known, or not the member's to see). */
  netSales: number | null;
  /** The store's orders for the range (Shopify's count; null: not known, or not the member's to see). */
  orders?: number | null;
  /** The store's net sales and orders for the dates compared with (null: not imported, or not known). */
  before?: { netSales: number | null; orders: number | null } | null;
  /** Orders Shopify's own visit record credits to each platform's ads, for the range (sourcedOrders; null: not read). */
  sourced?: SourcedOrders[] | null;
  now: Date;
  /** False: the comparison's days weren't read (see `daysToRead`), so nothing is compared rather than set against $0. */
  previousRead?: boolean;
  /** Every campaign, each with its change (`campaignChanges`), rather than the 10 that spent most: the Advertising area's campaign comparison. */
  allCampaigns?: boolean;
}

/** Orders (and their net sales, in the store's currency) that Shopify's visit record credits to one platform's ads. */
export interface SourcedOrders {
  provider: AdSpendProvider;
  orders: number;
  sales: number;
}

/** Why a change isn't given: only running days picked, a comparison before the figures start, or days missing on either side. */
export type NotCompared = "running" | "no_history" | "incomplete";

const SELECT = {
  id: true,
  provider: true,
  accountId: true,
  accountName: true,
  currency: true,
  timezone: true,
  status: true,
  errorCode: true,
  accountStatus: true,
  lastSyncedAt: true,
  historyFrom: true,
  syncedThrough: true,
  isDemo: true,
} as const;

/**
 * Only accounts in one currency are added up: the store's, when any account uses it, otherwise the
 * first known. Adding dollars to euros means nothing; the others are listed as left out.
 */
function chooseCurrency(conns: AdConn[], storeCurrency: string) {
  return conns.some((c) => c.currency === storeCurrency) ? storeCurrency : (conns.find((c) => c.currency)?.currency ?? storeCurrency);
}

/** One connected account as the dashboard lists it: its state, its days, and whether it is added up. */
function accountView(c: AdConn, counted: boolean, ask: AdsAsk) {
  const today = adToday(c, ask.now);
  const coverage = accountCoverage(c, today);
  return {
    id: c.id,
    provider: c.provider,
    accountId: c.accountId,
    name: c.accountName,
    currency: c.currency,
    status: c.status,
    /** Why it isn't active (AD_ERROR_CODES in @app/shared/ads); null when it is. */
    errorCode: c.errorCode,
    /** The account's own health at the platform (AD_ACCOUNT_STATUSES); null until read. */
    accountStatus: c.accountStatus,
    lastSyncedAt: c.lastSyncedAt,
    counted,
    /** Its figures are simulated (the Google Ads demo): shown as such, and never set against the store's own sales. */
    demo: !!c.isDemo,
    timezone: c.timezone,
    /** Its days follow another time zone than the store's: they don't start and end with the store's. */
    otherTimeZone: !!c.timezone && !sameDays(c.timezone, ask.storeTimeZone, ask.now),
    /** The account's own today. */
    today,
    /** The days its stored figures cover (its own days); nothing before its first sync. */
    coverage,
    /** Whether those days include every day of the range. */
    coversRange: coversDays(coverage, ask.range),
  };
}
type AccountView = ReturnType<typeof accountView>;

interface Window<T> {
  from: string;
  to: string;
  totals: T;
}

/** An account whose missing days are still to come: it syncs (or it was closed, and spends nothing). */
const keepsUp = (a: Pick<AccountView, "status" | "errorCode" | "accountStatus">) => a.status === "active" || isClosedAdAccount(a);

/**
 * The figures of some accounts (all counted ones, or one platform's) for the range and its
 * comparison: totals only when every one of them covers every day they need.
 *
 * - `current`: the range's totals; null unless every account covers the whole range.
 * - `partial`: then, the part of the range they all cover and its totals (null when there's none).
 * - `soFar`: the same as `partial` when the only days it lacks are at the range's end and not over
 *   yet: every day up to the last one that is over everywhere is there, and each account that stops
 *   short still syncs. That's the day still running before its next sync, or (an account in a time
 *   zone behind the store's) a store day it hasn't reached. The page shows it as the figure, dated
 *   "up to" its last day; the days after are never filled with 0. Null otherwise ("Unavailable").
 * - `compared`: the days each side of the change is worked out on and their totals. Platforms
 *   report whole days, so while the range reaches a day still running (the store's today, or an
 *   account's today in its own zone), both sides stop at the last day that is over everywhere
 *   ("through yesterday"); for running days only (Today) there is no change. Null with the reason
 *   in `notCompared`.
 * - `updatedAt`: when the least recently updated account last synced (null: one never has).
 */
function figures<R extends { day: string }, T>(accounts: AccountView[], rows: R[], total: (rows: R[]) => T, ask: AdsAsk, storeToday: string) {
  const cov = commonCoverage(accounts.map((a) => a.coverage));
  const complete = coversDays(cov, ask.range);
  const within = (w: DateRange) => rows.filter((r) => r.day >= w.from && r.day <= w.to);
  const window = (w: DateRange): Window<T> => ({ from: w.from, to: w.to, totals: total(within(w)) });
  const part = complete ? null : coveredPart(cov, ask.range);
  const lastWhole = lastWholeAdDay(storeToday, accounts.map((a) => a.today));
  const windows = adComparisonWindows(ask.range, ask.previous, lastWhole);
  const soFar = part && part.from === ask.range.from && part.to >= lastWhole && accounts.every((a) => a.coversRange || keepsUp(a)) ? part : null;
  // The comparison starts where every account's figures do (the old "imported" rule), and its days were read.
  const imported = ask.previousRead !== false && canCompareFrom(cov, ask.previous);
  let notCompared: NotCompared | null = null;
  if (!windows) notCompared = "running";
  else if (cov.from === null) notCompared = "incomplete";
  else if (!imported) notCompared = "no_history";
  else if (!coversDays(cov, windows.current) || !coversDays(cov, windows.previous)) notCompared = "incomplete";
  const synced = accounts.map((a) => a.lastSyncedAt);
  const oldest = synced.length && synced.every((s): s is Date => s !== null) ? new Date(Math.min(...synced.map((s) => s.getTime()))) : null;
  const partial = part ? window(part) : null;
  return {
    coverage: { from: cov.from, through: cov.through, complete },
    current: complete ? total(within(ask.range)) : null,
    partial,
    soFar: soFar ? partial : null,
    compared: windows && !notCompared ? { current: window(windows.current), previous: window(windows.previous), trimmed: windows.trimmed } : null,
    notCompared,
    /** The first day every account has figures from (null: one has none yet). */
    historyFrom: cov.from,
    imported,
    updatedAt: oldest ? oldest.toISOString() : null,
  };
}

const NULL_AD_TOTALS: { [K in keyof AdTotals]: null } = {
  spend: null,
  impressions: null,
  clicks: null,
  linkClicks: null,
  conversions: null,
  conversionValue: null,
  purchases: null,
  purchaseValue: null,
  leads: null,
  ctr: null,
  cpc: null,
  cpm: null,
  costPerConversion: null,
  costPerPurchase: null,
  roas: null,
};

/** Ads figures with the comparison the page shows: the dates compared with and their totals, and the changes. */
function adsBlock(f: ReturnType<typeof figures<AdDayRow, AdTotals>>) {
  const now = f.compared?.current.totals ?? null;
  const before = f.compared?.previous.totals ?? null;
  const change = (k: "spend" | "linkClicks" | "conversions" | "purchases" | "purchaseValue" | "roas") => (now && before ? delta(now[k], before[k]) : null);
  return {
    ...f,
    previous: {
      from: f.compared?.previous.from ?? null,
      to: f.compared?.previous.to ?? null,
      spend: before?.spend ?? null,
      linkClicks: before?.linkClicks ?? null,
      conversions: before?.conversions ?? null,
      conversionValue: before?.conversionValue ?? null,
      purchases: before?.purchases ?? null,
      purchaseValue: before?.purchaseValue ?? null,
      roas: before?.roas ?? null,
      imported: f.imported,
    },
    deltas: { spend: change("spend"), linkClicks: change("linkClicks"), conversions: change("conversions"), purchases: change("purchases"), purchaseValue: change("purchaseValue"), roas: change("roas") },
  };
}

/** A campaign as campaignTotals gives it. */
type CampaignFigures = ReturnType<typeof campaignTotals>[number];
const campaignKey = (c: Pick<CampaignFigures, "provider" | "accountId" | "campaignId">) => `${c.provider}:${c.accountId}:${c.campaignId}`;

/**
 * Each campaign's change, on the same whole days as the totals' (`compared`: both windows covered by
 * every counted account, so a campaign with no row in one of them spent nothing then, never a day
 * missing). Null for every campaign when the totals aren't compared.
 */
function campaignChanges(rows: AdDayRow[], compared: { current: DateRange; previous: DateRange } | null) {
  if (!compared) return () => null;
  const on = (w: DateRange) => new Map(campaignTotals(rows.filter((r) => r.day >= w.from && r.day <= w.to), Number.POSITIVE_INFINITY).map((c) => [campaignKey(c), c]));
  const now = on(compared.current);
  const before = on(compared.previous);
  return (c: CampaignFigures) => {
    const n = now.get(campaignKey(c));
    const b = before.get(campaignKey(c));
    const pick = (t: CampaignFigures | undefined, k: "spend" | "linkClicks" | "purchases" | "purchaseValue" | "roas") => (t ? t[k] : k === "roas" ? null : 0);
    const keys = ["spend", "linkClicks", "purchases", "purchaseValue", "roas"] as const;
    return {
      /** The days each side is worked out on (`compared`'s). */
      from: compared.previous.from,
      to: compared.previous.to,
      previous: Object.fromEntries(keys.map((k) => [k, pick(b, k)])) as Record<(typeof keys)[number], number | null>,
      deltas: Object.fromEntries(keys.map((k) => [k, delta(pick(n, k), pick(b, k))])) as Record<(typeof keys)[number], number | null>,
    };
  };
}

/**
 * The store's own sales set against the ad spend (adsVsSales in @app/shared): Shopify's net sales and
 * orders for the same dates, the sales per unit of spend (MER) and the cost per order, and their
 * change against the dates compared with. Same currency and every day of the spend known only; the
 * change only while both sides are whole ranges (no running day trimmed off the ads' comparison),
 * since the store's figures are for the whole of each.
 */
function salesVsSpend(all: ReturnType<typeof adsBlock>, ask: AdsAsk, currency: string) {
  if (currency !== ask.storeCurrency || !all.current) return null;
  const now = adsVsSales(all.current.spend, ask.netSales, ask.orders ?? null);
  if (!now) return null;
  const c = all.compared;
  const before = c && c.trimmed === 0 && ask.before ? adsVsSales(c.previous.totals.spend, ask.before.netSales, ask.before.orders) : null;
  return {
    ...now,
    /** The same for the dates compared with; null when they can't be compared. */
    previous: before ? { netSales: before.netSales, orders: before.orders, salesPerSpend: before.salesPerSpend, costPerOrder: before.costPerOrder } : null,
    deltas: {
      netSales: delta(now.netSales, before?.netSales ?? null),
      orders: delta(now.orders, before?.orders ?? null),
      salesPerSpend: delta(now.salesPerSpend, before?.salesPerSpend ?? null),
      costPerOrder: delta(now.costPerOrder, before?.costPerOrder ?? null),
    },
  };
}

/**
 * Orders Shopify's own visit record credits to each ad platform's ads: the last visit before the order
 * came from Facebook or Instagram (Meta) or from Google or YouTube (Google Ads) through a link tagged as
 * an ad (traffic_medium "paid"; packages/shared/src/traffic.ts). The store's view of a sale, in its own
 * currency: never what the platform claims. The orders placed in the range (gift-card-only ones aside)
 * and their net sales from the sales in the range, as the traffic module counts them (salesByOrder).
 */
export async function sourcedOrders(tx: Tx, { ws, storeId }: Scope, r: DateRange): Promise<SourcedOrders[]> {
  const rows = await tx.$queryRaw<Array<{ source: string | null; orders: number; sales: string }>>`
    SELECT o.traffic_source AS source, (COUNT(*) FILTER (WHERE o.placed))::int AS orders, COALESCE(SUM(o.sales), 0)::text AS sales
    FROM (${salesByOrder(ws, storeId, r)}) o
    WHERE o.traffic_medium = 'paid' AND o.traffic_source IN ('facebook', 'instagram', 'google', 'youtube')
    GROUP BY 1`;
  const by = new Map<AdSpendProvider, SourcedOrders>();
  for (const x of rows) {
    const provider = trafficSourcePlatform(x.source);
    if (!provider) continue;
    const s = by.get(provider) ?? { provider, orders: 0, sales: 0 };
    s.orders += num(x.orders);
    s.sales = r2(s.sales + num(x.sales));
    by.set(provider, s);
  }
  return [...by.values()];
}

/**
 * What the store's ad accounts (Meta Ads, Google Ads) report for these dates, from their stored
 * days: the counted accounts together, then each platform on its own (`byProvider`, its totals
 * flat on the entry as well, null when that platform's accounts don't cover the range), so one
 * platform's gap never hides another's figures.
 */
export function adsFigures(conns: AdConn[], rows: Array<AdDayRow & { connectionId: string }>, ask: AdsAsk) {
  if (!conns.length) return null;
  const currency = chooseCurrency(conns, ask.storeCurrency);
  const accounts = conns.map((c) => accountView(c, (c.currency ?? currency) === currency, ask));
  const counted = accounts.filter((a) => a.counted);
  const ids = new Set(counted.map((a) => a.id));
  const mine = rows.filter((r) => ids.has(r.connectionId));
  const storeToday = localDay(ask.now, ask.storeTimeZone);
  const all = adsBlock(figures(counted, mine, adTotals, ask, storeToday));
  const providers = [...new Set(counted.map((a) => a.provider as AdSpendProvider))];
  const inRange = mine.filter((r) => r.day >= ask.range.from && r.day <= ask.range.to);
  const byProvider = providers.map((p) => {
    const own = counted.filter((a) => a.provider === p);
    const f = adsBlock(figures(own, mine.filter((r) => r.provider === p), adTotals, ask, storeToday));
    return { provider: p, ...(f.current ?? NULL_AD_TOTALS), ...f, accounts: own.map((a) => a.id), /** Every account of this platform here is a demo: its card says so. */ demo: own.every((a) => a.demo) };
  });
  // Simulated figures are never set against the store's real sales, not even as part of a total: a demo
  // among the counted accounts leaves the store's own figures out (the Google Ads analytics page sets
  // the demo against a simulated store instead).
  const demo = counted.some((a) => a.demo);
  const covering = new Set(counted.filter((a) => a.coversRange).map((a) => `${a.provider}:${a.accountId}`));
  const changeOf = ask.allCampaigns ? campaignChanges(mine, all.compared) : null;
  return {
    currency,
    accounts,
    ...all,
    /** Every day of the range, null on a day a counted account has no figures for. */
    series: adSeries(inRange, ask.range, all.coverage),
    /** Each platform's own days, missing where that platform's accounts have none. */
    seriesByProvider: byProvider.map((p) => ({ provider: p.provider, series: adSeries(inRange.filter((r) => r.provider === p.provider), ask.range, p.coverage) })),
    byProvider,
    /**
     * The campaigns that spent most (every one, with `allCampaigns`, each with its `change`); `complete`
     * false: its account's figures stop before the range ends.
     */
    campaigns: campaignTotals(inRange, ask.allCampaigns ? Number.POSITIVE_INFINITY : 10).map((c) => ({
      ...c,
      complete: covering.has(`${c.provider}:${c.accountId}`),
      ...(changeOf ? { change: changeOf(c) } : {}),
    })),
    /** Ad spend as a share of the store's net sales: same currency and every day known only. */
    shareOfSales: !demo && all.current && currency === ask.storeCurrency && ask.netSales !== null && ask.netSales > 0 ? all.current.spend / ask.netSales : null,
    /** The store's own sales (Shopify's net sales and orders) set against the ad spend, with the change (salesVsSpend); null with a demo among the accounts. */
    sales: demo ? null : salesVsSpend(all, ask, currency),
    /** A demo account (simulated figures) is among the counted accounts: the page marks the figures and leaves the store's own out. */
    demo,
    /**
     * Per platform, the orders Shopify's visit record credits to its ads (sourcedOrders) and the store's
     * sales from them per unit of that platform's spend: the store's attribution, next to the platform's
     * own purchases. Team & Access "View conversion attribution"; null when the sources weren't read.
     */
    sourced: ask.sourced && !demo
      ? providers.map((p) => {
          const s = ask.sourced!.find((x) => x.provider === p);
          const spend = byProvider.find((b) => b.provider === p)?.current?.spend ?? null;
          const sales = s?.sales ?? 0;
          return { provider: p, orders: s?.orders ?? 0, sales, salesPerSpend: currency === ask.storeCurrency && spend !== null && spend > 0 ? r2(sales / spend) : null };
        })
      : null,
  };
}

/**
 * What the store's AdSense accounts earned from ads on its site, from their stored days. Money the
 * other way from ads: never added to ad spend. Only the sites chosen for the store count (each
 * connection's `sites`, every site when none are chosen); the others' earnings are listed as left
 * out, and "next to your sales" is worked out on the chosen ones alone.
 *
 * A day AdSense wouldn't split by site is stored as one row with site "". With sites chosen, nobody
 * can tell which part of it was the store's, so it is neither counted nor listed as another site's:
 * the account's figures start after the last such day read (`unsplitThrough`), and the days up to it
 * are missing, never $0.
 */
export function adsenseFigures(conns: AdConn[], rows: Array<AdsenseDayRow & { connectionId: string }>, ask: AdsAsk) {
  if (!conns.length) return null;
  const currency = chooseCurrency(conns, ask.storeCurrency);
  const sitesOf = new Map(conns.map((c) => [c.id, c.sites ?? []]));
  const unsplit = (r: AdsenseDayRow & { connectionId: string }) => r.site === "" && !adsenseSiteChosen(sitesOf.get(r.connectionId) ?? [], "");
  const lastUnsplit = new Map<string, string>();
  for (const r of rows) {
    if (!unsplit(r)) continue;
    const last = lastUnsplit.get(r.connectionId);
    if (!last || r.day > last) lastUnsplit.set(r.connectionId, r.day);
  }
  const accounts = conns.map((c) => {
    const view = accountView(c, (c.currency ?? currency) === currency, ask);
    const unsplitThrough = lastUnsplit.get(c.id) ?? null;
    const coverage = unsplitThrough ? coverageAfter(view.coverage, unsplitThrough) : view.coverage;
    return {
      ...view,
      provider: "adsense" as const,
      sites: c.sites ?? [],
      /** Sites chosen, and AdSense didn't split this account's earnings by site up to this day: the store's share of them isn't known. */
      unsplitThrough,
      coverage,
      coversRange: coversDays(coverage, ask.range),
    };
  });
  const counted = accounts.filter((a) => a.counted);
  const ids = new Set(counted.map((a) => a.id));
  const mine = rows.filter((r) => ids.has(r.connectionId) && !unsplit(r));
  const chosen = mine.filter((r) => adsenseSiteChosen(sitesOf.get(r.connectionId)!, r.site));
  const others = mine.filter((r) => !adsenseSiteChosen(sitesOf.get(r.connectionId)!, r.site));
  const inRange = <R extends { day: string }>(list: R[]) => list.filter((r) => r.day >= ask.range.from && r.day <= ask.range.to);
  const f = figures(counted, chosen, adsenseTotals, ask, localDay(ask.now, ask.storeTimeZone));
  const now = f.compared?.current.totals ?? null;
  const before = f.compared?.previous.totals ?? null;
  const change = (k: "earnings" | "pageViews" | "clicks" | "pageRpm") => (now && before ? delta(now[k], before[k]) : null);
  return {
    currency,
    accounts,
    ...f,
    previous: {
      from: f.compared?.previous.from ?? null,
      to: f.compared?.previous.to ?? null,
      earnings: before?.earnings ?? null,
      pageViews: before?.pageViews ?? null,
      clicks: before?.clicks ?? null,
      pageRpm: before?.pageRpm ?? null,
      imported: f.imported,
    },
    deltas: { earnings: change("earnings"), pageViews: change("pageViews"), clicks: change("clicks"), pageRpm: change("pageRpm") },
    series: adsenseSeries(inRange(chosen), ask.range, f.coverage),
    /** The store's sites, biggest earner first. */
    sites: siteTotals(inRange(chosen), 10),
    /** Sites on the same AdSense account that aren't the store's: not counted anywhere above. */
    sitesLeftOut: siteTotals(inRange(others), 10),
    /** Estimated earnings next to the store's own net sales: same currency and every day known only. */
    vsSales: f.current && currency === ask.storeCurrency && ask.netSales !== null && ask.netSales > 0 ? f.current.earnings / ask.netSales : null,
  };
}

/**
 * The days to read: the range, and the comparison too when some figures can be compared at all.
 * Each platform is compared on its own (`byProvider`), so the comparison is read when any counted
 * platform's figures reach back to it, even if another's start later; one from before every
 * platform's figures start isn't read.
 */
export function daysToRead(conns: AdConn[], ask: AdsAsk) {
  const currency = chooseCurrency(conns, ask.storeCurrency);
  const counted = conns.filter((c) => (c.currency ?? currency) === currency);
  const coverage = (list: AdConn[]) => commonCoverage(list.map((c) => accountCoverage(c, adToday(c, ask.now))));
  const providers = [...new Set(counted.map((c) => c.provider))];
  const compared = providers.some((p) => canCompareFrom(coverage(counted.filter((c) => c.provider === p)), ask.previous));
  return {
    ids: counted.map((c) => c.id),
    /** Whether the comparison's days are read (`AdsAsk.previousRead`). */
    compared,
    // The comparison needn't sit just before the range (a year earlier, dates picked, even
    // overlapping it): two windows, never one span from the comparison's start to the range's end.
    OR: [{ day: { gte: ask.range.from, lte: ask.range.to } }, ...(compared ? [{ day: { gte: ask.previous.from, lte: ask.previous.to } }] : [])],
  };
}

/** The store's time zone, when the caller didn't pass it. */
async function storeTimeZone(tx: Tx, { ws, storeId }: Scope) {
  const store = await tx.store.findFirst({ where: { id: storeId, workspaceId: ws }, select: { timezone: true } });
  return store?.timezone ?? "UTC";
}

/** Who asks, beyond the dates: the store's zone (read when absent) and the time to work today out from. */
export interface AdsOptions {
  /** Only these accounts (ad connection ids), of the ones shown on the store. */
  connections?: string[];
  /** Only this platform's accounts (Meta Ads or Google Ads; the ads module only). */
  provider?: AdSpendProvider;
  /** Every campaign, each with its change (AdsAsk.allCampaigns). */
  allCampaigns?: boolean;
  timeZone?: string;
  now?: Date;
  /** The store's orders for the range, and its net sales and orders for the dates compared with (AdsAsk). */
  orders?: number | null;
  before?: { netSales: number | null; orders: number | null } | null;
  /** Read which orders Shopify credits to each platform's ads (sourcedOrders): when the store's traffic sources are read at all. */
  attribution?: boolean;
}

/** The ads module of the dashboard (see `adsFigures`): null when no ad account is shown on the store. */
export async function adsModule(tx: Tx, scope: Scope, range: DateRange, previous: Comparison, storeCurrency: string, netSales: number | null, opts: AdsOptions = {}) {
  const { ws, storeId } = scope;
  const conns = await tx.adConnection.findMany({
    // Spend only: AdSense accounts earn money for the store and have their own module below.
    where: { workspaceId: ws, storeId, enabled: true, provider: opts.provider ?? { in: ["meta", "google"] }, ...(opts.connections ? { id: { in: opts.connections } } : {}) },
    select: SELECT,
    orderBy: [{ provider: "asc" }, { createdAt: "asc" }],
  });
  if (!conns.length) return null;
  const ask: AdsAsk = {
    range,
    previous,
    storeCurrency,
    netSales,
    orders: opts.orders ?? null,
    before: opts.before ?? null,
    sourced: opts.attribution ? await sourcedOrders(tx, scope, range) : null,
    now: opts.now ?? new Date(),
    storeTimeZone: opts.timeZone ?? (await storeTimeZone(tx, scope)),
    allCampaigns: opts.allCampaigns,
  };
  const read = daysToRead(conns, ask);
  const raw = await tx.adCampaignDaily.findMany({ where: { workspaceId: ws, storeId, connectionId: { in: read.ids }, OR: read.OR } });
  const rows = raw.map((r) => ({
    connectionId: r.connectionId,
    provider: r.provider as AdSpendProvider,
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
  return adsFigures(conns, rows, { ...ask, previousRead: read.compared });
}

/** The AdSense module of the dashboard (see `adsenseFigures`): null when no AdSense account is shown on the store. */
export async function adsenseModule(tx: Tx, scope: Scope, range: DateRange, previous: Comparison, storeCurrency: string, netSales: number | null, opts: AdsOptions = {}) {
  const { ws, storeId } = scope;
  const conns = await tx.adConnection.findMany({
    where: { workspaceId: ws, storeId, enabled: true, provider: "adsense", ...(opts.connections ? { id: { in: opts.connections } } : {}) },
    select: { ...SELECT, sites: true },
    orderBy: { createdAt: "asc" },
  });
  if (!conns.length) return null;
  const ask: AdsAsk = { range, previous, storeCurrency, netSales, now: opts.now ?? new Date(), storeTimeZone: opts.timeZone ?? (await storeTimeZone(tx, scope)) };
  const read = daysToRead(conns, ask);
  const raw = await tx.adsenseDaily.findMany({ where: { workspaceId: ws, storeId, connectionId: { in: read.ids }, OR: read.OR } });
  const rows = raw.map((r) => ({
    connectionId: r.connectionId,
    accountId: r.accountId,
    site: r.site,
    day: r.day,
    earnings: toNumber(r.earnings),
    pageViews: r.pageViews,
    impressions: r.impressions,
    clicks: r.clicks,
  }));
  return adsenseFigures(conns, rows, { ...ask, previousRead: read.compared });
}

export type AdsFigures = NonNullable<ReturnType<typeof adsFigures>>;
export type AdsenseFigures = NonNullable<ReturnType<typeof adsenseFigures>>;
