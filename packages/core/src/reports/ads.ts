import { toNumber, type Tx } from "@app/db";
import {
  accountCoverage,
  adSeries,
  adsenseFinalThrough,
  adsenseSeries,
  adsenseSiteChosen,
  adsenseTotals,
  adsVsSales,
  adTotals,
  campaignStatusGroup,
  campaignTotals,
  claimsAddUp,
  commonCoverage,
  coverageAfter,
  coveredPart,
  coversDays,
  isClosedAdAccount,
  lastWholeAdDay,
  localDay,
  sameDays,
  siteTotals,
  trafficSourcePlatform,
  type AdCampaignFacts,
  type AdDayRow,
  type AdsenseDayRow,
  type AdSpendProvider,
  type AdTotals,
  type DateRange,
} from "@app/shared";
import { campaignKeyOf, storedCampaigns, type StoredCampaign } from "../adConnections/campaigns.js";
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
  /** A sync someone asked for (connect, Refresh, re-enable) that hasn't finished yet. */
  syncRequestedAt?: Date | null;
  /** When the last sync started, whatever came of it. */
  lastSyncAttemptAt?: Date | null;
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
  storeCurrency: string;
  /** The store's time zone: the dashboard's days. */
  storeTimeZone: string;
  /** The store's net sales for the range (null: not known, or not the member's to see). */
  netSales: number | null;
  /** The store's orders for the range (Shopify's count; null: not known, or not the member's to see). */
  orders?: number | null;
  /** Orders Shopify's own visit record credits to each platform's ads, for the range (sourcedOrders; null: not read). */
  sourced?: SourcedOrders[] | null;
  now: Date;
  /** Every campaign, rather than the 10 that spent most: the Advertising area's campaign comparison. */
  allCampaigns?: boolean;
  /**
   * Each campaign as its platform described it to the last sync (ad_campaigns): its status, and Google's
   * channel type, primary status and budget, Meta's budget. By provider:accountId:campaignId.
   */
  campaignSettings?: Map<string, Pick<StoredCampaign, "status" | keyof AdCampaignFacts>>;
}

/** Orders (and their net sales, in the store's currency) that Shopify's visit record credits to one platform's ads. */
export interface SourcedOrders {
  provider: AdSpendProvider;
  orders: number;
  sales: number;
}

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
  syncRequestedAt: true,
  lastSyncAttemptAt: true,
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
    /** The last sync that worked: what its figures are as of. */
    lastSyncedAt: c.lastSyncedAt,
    /**
     * A sync someone asked for after connecting (Refresh, Sync all now, turning it back on) is on its
     * way while this is set and recent (the worker clears it when the last window asked for lands, or
     * fails): the page says it is refreshing, with lastSyncedAt's figures meanwhile.
     */
    syncRequestedAt: c.syncRequestedAt ?? null,
    /** When the last sync started, whatever came of it: for an account that fails, when it was last tried. */
    lastSyncAttemptAt: c.lastSyncAttemptAt ?? null,
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
 * The figures of some accounts (all counted ones, or one platform's) for the range: totals only
 * when every one of them covers every day they need.
 *
 * - `current`: the range's totals; null unless every account covers the whole range.
 * - `partial`: then, the part of the range they all cover and its totals (null when there's none).
 * - `soFar`: the same as `partial` when the only days it lacks are at the range's end and not over
 *   yet: every day up to the last one that is over everywhere is there, and each account that stops
 *   short still syncs. That's the day still running before its next sync, or (an account in a time
 *   zone behind the store's) a store day it hasn't reached. The page shows it as the figure, dated
 *   "up to" its last day; the days after are never filled with 0. Null otherwise ("Unavailable").
 * - `updatedAt`: when the least recently updated account last synced (null: one never has).
 */
function figures<R extends { day: string }, T>(accounts: AccountView[], rows: R[], total: (rows: R[]) => T, ask: AdsAsk, storeToday: string) {
  const cov = commonCoverage(accounts.map((a) => a.coverage));
  const complete = coversDays(cov, ask.range);
  const within = (w: DateRange) => rows.filter((r) => r.day >= w.from && r.day <= w.to);
  const window = (w: DateRange): Window<T> => ({ from: w.from, to: w.to, totals: total(within(w)) });
  const part = complete ? null : coveredPart(cov, ask.range);
  const lastWhole = lastWholeAdDay(storeToday, accounts.map((a) => a.today));
  const soFar = part && part.from === ask.range.from && part.to >= lastWhole && accounts.every((a) => a.coversRange || keepsUp(a)) ? part : null;
  const synced = accounts.map((a) => a.lastSyncedAt);
  const oldest = synced.length && synced.every((s): s is Date => s !== null) ? new Date(Math.min(...synced.map((s) => s.getTime()))) : null;
  const partial = part ? window(part) : null;
  return {
    coverage: { from: cov.from, through: cov.through, complete },
    current: complete ? total(within(ask.range)) : null,
    partial,
    soFar: soFar ? partial : null,
    /** The first day every account has figures from (null: one has none yet). */
    historyFrom: cov.from,
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

/** A campaign as campaignTotals gives it. */
type CampaignFigures = ReturnType<typeof campaignTotals>[number];
const campaignKey = (c: Pick<CampaignFigures, "provider" | "accountId" | "campaignId">) => `${c.provider}:${c.accountId}:${c.campaignId}`;

/**
 * The store's own sales set against the ad spend (adsVsSales in @app/shared): Shopify's net sales and
 * orders for the same dates, the sales per unit of spend (MER) and the cost per order. Same currency
 * and every day of the spend known only.
 */
function salesVsSpend(all: ReturnType<typeof figures<AdDayRow, AdTotals>>, ask: AdsAsk, currency: string) {
  if (currency !== ask.storeCurrency || !all.current) return null;
  return adsVsSales(all.current.spend, ask.netSales, ask.orders ?? null);
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
 * platform's gap never hides another's figures. Spend adds up across platforms; their purchases
 * only when one platform is counted (`claimsAddUp`).
 */
export function adsFigures(conns: AdConn[], rows: Array<AdDayRow & { connectionId: string }>, ask: AdsAsk) {
  if (!conns.length) return null;
  const currency = chooseCurrency(conns, ask.storeCurrency);
  const accounts = conns.map((c) => accountView(c, (c.currency ?? currency) === currency, ask));
  const counted = accounts.filter((a) => a.counted);
  const ids = new Set(counted.map((a) => a.id));
  const mine = rows.filter((r) => ids.has(r.connectionId));
  const storeToday = localDay(ask.now, ask.storeTimeZone);
  const all = figures(counted, mine, adTotals, ask, storeToday);
  const providers = [...new Set(counted.map((a) => a.provider as AdSpendProvider))];
  const inRange = mine.filter((r) => r.day >= ask.range.from && r.day <= ask.range.to);
  const byProvider = providers.map((p) => {
    const own = counted.filter((a) => a.provider === p);
    const f = figures(own, mine.filter((r) => r.provider === p), adTotals, ask, storeToday);
    return { provider: p, ...(f.current ?? NULL_AD_TOTALS), ...f, accounts: own.map((a) => a.id), /** Every account of this platform here is a demo: its card says so. */ demo: own.every((a) => a.demo) };
  });
  // Simulated figures are never set against the store's real sales, not even as part of a total: a demo
  // among the counted accounts leaves the store's own figures out (the Google Ads analytics page sets
  // the demo against a simulated store instead).
  const demo = counted.some((a) => a.demo);
  const covering = new Set(counted.filter((a) => a.coversRange).map((a) => `${a.provider}:${a.accountId}`));
  return {
    currency,
    accounts,
    /**
     * Accounts not added up, in another currency than `currency` (the demo aside, its spend being
     * simulated): none of their spend is in any figure here, so a cost worked out from it is short.
     */
    leftOut: accounts.filter((a) => !a.counted && !a.demo).map((a) => ({ id: a.id, provider: a.provider as AdSpendProvider, accountId: a.accountId, name: a.name, currency: a.currency })),
    ...all,
    /**
     * The purchases, purchase value, ROAS and cost per purchase of the totals are one platform's
     * (claimsAddUp in @app/shared/ads). False with Meta and Google both counted: the totals then add up
     * claims that can overlap (both may credit one order), so a page shows each platform's own
     * (`byProvider`) and, across them, the store's own sales (`sales`).
     */
    claimsAddUp: claimsAddUp(providers),
    /** Every day of the range, null on a day a counted account has no figures for. */
    series: adSeries(inRange, ask.range, all.coverage),
    /** Each platform's own days, missing where that platform's accounts have none. */
    seriesByProvider: byProvider.map((p) => ({ provider: p.provider, series: adSeries(inRange.filter((r) => r.provider === p.provider), ask.range, p.coverage) })),
    byProvider,
    /**
     * The campaigns that spent most (every one, with `allCampaigns`); `complete`
     * false: its account's figures stop before the range ends.
     */
    campaigns: campaignTotals(inRange, ask.allCampaigns ? Number.POSITIVE_INFINITY : 10).map((c) => {
      const s = ask.campaignSettings?.get(campaignKey(c));
      return {
        ...c,
        complete: covering.has(`${c.provider}:${c.accountId}`),
        /** The platform's own word for its delivery now (null: not read yet), and the group the campaign filters use. */
        status: s?.status ?? null,
        statusGroup: campaignStatusGroup(s?.status),
        /** Google's channel type and primary status (with its reasons) as of the last sync; null (none) for Meta and while unread. */
        channelType: s?.channelType ?? null,
        primaryStatus: s?.primaryStatus ?? null,
        primaryStatusReasons: s?.primaryStatusReasons ?? [],
        /**
         * The campaign's budget as of the last sync, in its account's currency: DAILY, Google's CUSTOM_PERIOD
         * (one total over the campaign's own dates) or Meta's LIFETIME; null when none is known (a Meta
         * campaign whose budgets are its ad sets', or not read yet).
         */
        budgetPeriod: s?.budgetPeriod ?? null,
        budgetAmount: s?.budgetAmount ?? null,
      };
    }),
    /** Ad spend as a share of the store's net sales: same currency and every day known only. */
    shareOfSales: !demo && all.current && currency === ask.storeCurrency && ask.netSales !== null && ask.netSales > 0 ? all.current.spend / ask.netSales : null,
    /** The store's own sales (Shopify's net sales and orders) set against the ad spend (salesVsSpend); null with a demo among the accounts. */
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
 *
 * Earnings are AdSense's estimate until it finalizes the month, in the first days of the next; the
 * daily re-check reads the whole month before again during days 1–10 (recheckDays in
 * adConnections/sync.ts). So each account's figures are final up to `finalThrough`, worked out from
 * its last sync that worked (adsenseFinalThrough), and `final` says whether every day of the figures
 * given (`current`, else `partial`) is. A closed account is never read again, so its stored days stay
 * as final as they were then; its days since are zeros, final, and never hold the others' figures back.
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
  // A closed account isn't read again, and earns nothing after the days it stored (accountCoverage
  // counts the days since as the zeros they are): only those stored days can be AdSense's estimate.
  const closedThrough = new Map(conns.filter((c) => isClosedAdAccount(c) && c.syncedThrough).map((c) => [c.id, c.syncedThrough!]));
  const accounts = conns.map((c) => {
    const view = accountView(c, (c.currency ?? currency) === currency, ask);
    const unsplitThrough = lastUnsplit.get(c.id) ?? null;
    const coverage = unsplitThrough ? coverageAfter(view.coverage, unsplitThrough) : view.coverage;
    const read = adsenseFinalThrough(c.lastSyncedAt ? adToday(c, c.lastSyncedAt) : null);
    const stopped = closedThrough.get(c.id);
    return {
      ...view,
      provider: "adsense" as const,
      sites: c.sites ?? [],
      /** Sites chosen, and AdSense didn't split this account's earnings by site up to this day: the store's share of them isn't known. */
      unsplitThrough,
      coverage,
      coversRange: coversDays(coverage, ask.range),
      /**
       * Its figures are final, not AdSense's estimate, up to this day (its own); null: none is yet. A
       * closed account whose stored days were all final by its last sync is final through its today.
       */
      finalThrough: read && stopped && read >= stopped ? view.today : read,
    };
  });
  const counted = accounts.filter((a) => a.counted);
  const ids = new Set(counted.map((a) => a.id));
  const mine = rows.filter((r) => ids.has(r.connectionId) && !unsplit(r));
  const chosen = mine.filter((r) => adsenseSiteChosen(sitesOf.get(r.connectionId)!, r.site));
  const others = mine.filter((r) => !adsenseSiteChosen(sitesOf.get(r.connectionId)!, r.site));
  const inRange = <R extends { day: string }>(list: R[]) => list.filter((r) => r.day >= ask.range.from && r.day <= ask.range.to);
  const f = figures(counted, chosen, adsenseTotals, ask, localDay(ask.now, ask.storeTimeZone));
  // The days of the figures given: the range's, else the part every account covers.
  const givenFrom = f.current ? ask.range.from : (f.partial?.from ?? null);
  const givenTo = f.current ? ask.range.to : (f.partial?.to ?? null);
  // For figures that start after a closed account's stored days, its part is all zeros: final through its today.
  const finals = counted.map((a) => {
    const stopped = closedThrough.get(a.id);
    return stopped && givenFrom && stopped < givenFrom ? a.today : a.finalThrough;
  });
  const finalThrough = finals.length && finals.every((x): x is string => x !== null) ? finals.reduce((a, b) => (a < b ? a : b)) : null;
  return {
    currency,
    accounts,
    ...f,
    /** The day every counted account's figures for these dates are final up to (null: one has none final yet). */
    finalThrough,
    /** Every day of the figures given (`current`, else `partial`, which `soFar` is) is final: "Final", else "Estimated". */
    final: givenTo !== null && finalThrough !== null && givenTo <= finalThrough,
    series: adsenseSeries(inRange(chosen), ask.range, f.coverage),
    /** The store's sites, biggest earner first. */
    sites: siteTotals(inRange(chosen), 10),
    /** Sites on the same AdSense account that aren't the store's: not counted anywhere above. */
    sitesLeftOut: siteTotals(inRange(others), 10),
    /** Estimated earnings next to the store's own net sales: same currency and every day known only. */
    vsSales: f.current && currency === ask.storeCurrency && ask.netSales !== null && ask.netSales > 0 ? f.current.earnings / ask.netSales : null,
  };
}

/** The days to read: the range's, of the accounts that are added up (the ones in the currency chosen). */
export function daysToRead(conns: AdConn[], ask: Pick<AdsAsk, "range" | "storeCurrency">) {
  const currency = chooseCurrency(conns, ask.storeCurrency);
  const counted = conns.filter((c) => (c.currency ?? currency) === currency);
  return { ids: counted.map((c) => c.id), day: { gte: ask.range.from, lte: ask.range.to } };
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
  /** Every campaign (AdsAsk.allCampaigns). */
  allCampaigns?: boolean;
  timeZone?: string;
  now?: Date;
  /** The store's orders for the range (AdsAsk). */
  orders?: number | null;
  /** Read which orders Shopify credits to each platform's ads (sourcedOrders): when the store's traffic sources are read at all. */
  attribution?: boolean;
}

/** The ads module of the dashboard (see `adsFigures`): null when no ad account is shown on the store. */
export async function adsModule(tx: Tx, scope: Scope, range: DateRange, storeCurrency: string, netSales: number | null, opts: AdsOptions = {}) {
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
    storeCurrency,
    netSales,
    orders: opts.orders ?? null,
    sourced: opts.attribution ? await sourcedOrders(tx, scope, range) : null,
    now: opts.now ?? new Date(),
    storeTimeZone: opts.timeZone ?? (await storeTimeZone(tx, scope)),
    allCampaigns: opts.allCampaigns,
  };
  const read = daysToRead(conns, ask);
  const raw = await tx.adCampaignDaily.findMany({ where: { workspaceId: ws, storeId, connectionId: { in: read.ids }, day: read.day } });
  const stored = await storedCampaigns(tx, { workspaceId: ws, storeId, connectionId: { in: conns.map((c) => c.id) } });
  ask.campaignSettings = new Map(stored.map((s) => [campaignKeyOf(s), s]));
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
  return adsFigures(conns, rows, ask);
}

/** The AdSense module of the dashboard (see `adsenseFigures`): null when no AdSense account is shown on the store. */
export async function adsenseModule(tx: Tx, scope: Scope, range: DateRange, storeCurrency: string, netSales: number | null, opts: AdsOptions = {}) {
  const { ws, storeId } = scope;
  const conns = await tx.adConnection.findMany({
    where: { workspaceId: ws, storeId, enabled: true, provider: "adsense", ...(opts.connections ? { id: { in: opts.connections } } : {}) },
    select: { ...SELECT, sites: true },
    orderBy: { createdAt: "asc" },
  });
  if (!conns.length) return null;
  const ask: AdsAsk = { range, storeCurrency, netSales, now: opts.now ?? new Date(), storeTimeZone: opts.timeZone ?? (await storeTimeZone(tx, scope)) };
  const read = daysToRead(conns, ask);
  const raw = await tx.adsenseDaily.findMany({ where: { workspaceId: ws, storeId, connectionId: { in: read.ids }, day: read.day } });
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
  return adsenseFigures(conns, rows, ask);
}

export type AdsFigures = NonNullable<ReturnType<typeof adsFigures>>;
export type AdsenseFigures = NonNullable<ReturnType<typeof adsenseFigures>>;
