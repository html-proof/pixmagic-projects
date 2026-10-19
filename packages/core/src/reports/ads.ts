import { toNumber, type Tx } from "@app/db";
import {
  accountCoverage,
  adComparisonWindows,
  adSeries,
  adsenseSeries,
  adsenseSiteChosen,
  adsenseTotals,
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
  type AdDayRow,
  type AdsenseDayRow,
  type AdSpendProvider,
  type AdTotals,
  type Comparison,
  type DateRange,
} from "@app/shared";
import { adToday } from "../adConnections/sync.js";
import type { Scope } from "./common.js";

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
  now: Date;
  /** False: the comparison's days weren't read (see `daysToRead`), so nothing is compared rather than set against $0. */
  previousRead?: boolean;
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
    const f = adsBlock(figures(counted.filter((a) => a.provider === p), mine.filter((r) => r.provider === p), adTotals, ask, storeToday));
    return { provider: p, ...(f.current ?? NULL_AD_TOTALS), ...f, accounts: counted.filter((a) => a.provider === p).map((a) => a.id) };
  });
  const covering = new Set(counted.filter((a) => a.coversRange).map((a) => `${a.provider}:${a.accountId}`));
  return {
    currency,
    accounts,
    ...all,
    /** Every day of the range, null on a day a counted account has no figures for. */
    series: adSeries(inRange, ask.range, all.coverage),
    /** Each platform's own days, missing where that platform's accounts have none. */
    seriesByProvider: byProvider.map((p) => ({ provider: p.provider, series: adSeries(inRange.filter((r) => r.provider === p.provider), ask.range, p.coverage) })),
    byProvider,
    /** The campaigns that spent most; `complete` false: its account's figures stop before the range ends. */
    campaigns: campaignTotals(inRange, 10).map((c) => ({ ...c, complete: covering.has(`${c.provider}:${c.accountId}`) })),
    /** Ad spend as a share of the store's net sales: same currency and every day known only. */
    shareOfSales: all.current && currency === ask.storeCurrency && ask.netSales !== null && ask.netSales > 0 ? all.current.spend / ask.netSales : null,
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
  timeZone?: string;
  now?: Date;
}

/** The ads module of the dashboard (see `adsFigures`): null when no ad account is shown on the store. */
export async function adsModule(tx: Tx, scope: Scope, range: DateRange, previous: Comparison, storeCurrency: string, netSales: number | null, opts: AdsOptions = {}) {
  const { ws, storeId } = scope;
  const conns = await tx.adConnection.findMany({
    // Spend only: AdSense accounts earn money for the store and have their own module below.
    where: { workspaceId: ws, storeId, enabled: true, provider: { in: ["meta", "google"] } },
    select: SELECT,
    orderBy: [{ provider: "asc" }, { createdAt: "asc" }],
  });
  if (!conns.length) return null;
  const ask: AdsAsk = { range, previous, storeCurrency, netSales, now: opts.now ?? new Date(), storeTimeZone: opts.timeZone ?? (await storeTimeZone(tx, scope)) };
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
    where: { workspaceId: ws, storeId, enabled: true, provider: "adsense" },
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
