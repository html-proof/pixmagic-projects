/**
 * The daily check that what bizinsights stored for an ad account is what the platform reports for the
 * same days. A settled week of the stored days (ad_campaign_daily for Meta, adsense_daily for AdSense)
 * is added up and set against one account-level read of the platform for that week: on the account's
 * own calendar and in its own currency, as the sync reads them, and for Meta with the same attribution
 * (each ad set's own setting, metaRangeInsights). The answer goes to the operator's logs only, "ad
 * figures match the platform" or one "ad figures differ from the platform" per figure that doesn't,
 * counted by the alarm `ad-figures-differ` (docs/RUNBOOK.md). Merchants are never told, and nothing
 * on the connection changes: what a sync meets is the sync's to record.
 *
 * Google Ads is left out: every read spends operations from the one daily allowance all merchants
 * share (budget.ts), which its own syncs already stop at 80% of. A demo is left out too: its figures
 * are bizinsights' own.
 */
import { systemDb, toNumber, type AdConnection } from "@app/db";
import { addDays, metaReportMetrics } from "@app/shared";
import { AdsRateLimitedError, AdsRetryableError, adsenseReport, classifyAdError, metaRangeInsights } from "../ads.js";
import type { Coord } from "../coord.js";
import { fetchUntil } from "../http.js";
import { logger } from "../logger.js";
import type { FetchLike } from "../shopify.js";
import { adsenseConfig, metaConfig } from "./config.js";
import { adAccessToken, isNangoConnection } from "./credentials.js";
import { adToday } from "./sync.js";

/** The days checked: one week. */
export const AD_CHECK_DAYS = 7;
/**
 * The week ends this many days before the account's today. Meta credits a purchase to the day of the
 * ad's click or view, up to 7 days after the click (7-day click is the longest attribution an ad set
 * can have), so by the 8th day back that has run out for every day of the week; spend and clicks
 * settle sooner. A purchase a store's server reports late can still come in: the tolerance allows it.
 * The daily re-check (30 days, recheckDays in sync.ts) has normally stored the week again within the
 * last day, so both sides speak of finished days. AdSense's estimated earnings of those days are what
 * its own report says today, which is what the re-check stored.
 */
export const AD_CHECK_SETTLED_DAYS = 8;
/**
 * How far a stored total may sit from the platform's and still match: 1% of the platform's figure,
 * or what rounding alone can make (adFigureSlack), whichever is more. What the platforms still change
 * on settled days (invalid clicks taken out, a purchase reported late) moves a week's total by a
 * fraction of a percent; what a fault here would do (a day or a campaign missing, a figure read from
 * the wrong field) moves it by far more: one day of seven is 14%.
 */
export const AD_CHECK_TOLERANCE = 0.01;
/** Each connection is checked once a day, whatever came of it (a platform that asked to wait is asked tomorrow). */
export const AD_CHECK_LEASE_MS = 22 * 3_600_000;
/** How long one cron tick may start checks for, and how many accounts it reads at once. Accounts not reached wait for the next tick. */
export const AD_CHECK_BUDGET_MS = 60_000;
export const AD_CHECK_CONCURRENCY = 3;
/** How long one account's reads may take (a Meta report job polled included). */
export const AD_CHECK_CALL_MS = 30_000;

const lease = (connectionId: string) => `ads-figures:${connectionId}`;

/**
 * The week checked for a connection (its own days), or null when its stored days don't cover all of it
 * (connected less than about two weeks ago, or its history starts later).
 */
export function adCheckWindow(conn: Pick<AdConnection, "timezone" | "historyFrom" | "syncedThrough">, now = new Date()): { since: string; until: string } | null {
  const until = addDays(adToday(conn, now), -AD_CHECK_SETTLED_DAYS);
  const since = addDays(until, -(AD_CHECK_DAYS - 1));
  if (!conn.historyFrom || !conn.syncedThrough || conn.historyFrom > since || conn.syncedThrough < until) return null;
  return { since, until };
}

/** One figure of the week on both sides. */
export interface AdFigure {
  field: string;
  stored: number;
  platform: number;
  /** The difference rounding alone can make (adFigureSlack); 1 for counts. */
  slack: number;
}

/** A figure that doesn't match: `relative` is (stored − platform) ÷ platform, null when the platform says 0. */
export interface AdFigureDifference {
  field: string;
  stored: number | string;
  platform: number | string;
  relative: number | null;
}

/**
 * What rounding alone can make of a money total: half a cent for every figure rounded on the way.
 * Meta: each stored row; each day twice, since a day's campaigns may miss its account total by half a
 * cent more without an "Other campaigns" row (withMetaOtherCampaigns) and that total is rounded
 * itself; and the week's own total. AdSense: each stored row and the report's total.
 */
export function adFigureSlack(provider: "meta" | "adsense", rows: number, days: number): number {
  return 0.005 * (rows + (provider === "meta" ? 2 * days : 0) + 1);
}

/** The figures further from the platform's than AD_CHECK_TOLERANCE and their slack allow. */
export function adFigureDifferences(figures: readonly AdFigure[]): AdFigureDifference[] {
  return figures
    .filter((f) => Math.abs(f.stored - f.platform) > Math.max(f.slack, AD_CHECK_TOLERANCE * Math.abs(f.platform)) + 1e-9)
    .map((f) => ({ field: f.field, stored: f.stored, platform: f.platform, relative: f.platform ? Math.round(((f.stored - f.platform) / f.platform) * 10_000) / 10_000 : null }));
}

export type AdFiguresSkip = "google" | "demo" | "not_active" | "not_covered" | "not_configured" | "rate_limited";

export type AdFiguresCheck =
  | { outcome: "match" | "differ"; since: string; until: string; currency: string | null; differences: AdFigureDifference[] }
  | { outcome: "skipped"; reason: AdFiguresSkip };

/** Both sides of one connection's week, as compared. */
interface Read {
  figures: AdFigure[];
  /** The currencies the stored rows are in, and the account's own. */
  storedCurrencies: string[];
  currency: string | null;
}

const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * Meta: the stored campaign days (the "Other campaigns" row included, so each day adds up to the
 * account's total) against one account-level insights read of the week. Link clicks, purchases and
 * their value only when every stored row has them (rows stored before they were read have none).
 */
async function metaRead(conn: AdConnection, w: { since: string; until: string }, fetchImpl: FetchLike | undefined, deadline: number): Promise<Read | null> {
  const cfg = metaConfig(fetchImpl);
  if (!cfg) return null;
  const token = await adAccessToken(conn, fetchImpl);
  const [row] = await metaRangeInsights(cfg, token, conn.accountId, "account", w.since, w.until, 1, undefined, { deadline });
  // No row: nothing was shown that week.
  const p = metaReportMetrics(row ?? {});
  const groups = await systemDb.adCampaignDaily.groupBy({
    by: ["currency"],
    where: { connectionId: conn.id, day: { gte: w.since, lte: w.until } },
    _sum: { spend: true, impressions: true, clicks: true, linkClicks: true, purchases: true, purchaseValue: true },
    _count: { _all: true, linkClicks: true, purchases: true, purchaseValue: true },
  });
  const rows = groups.reduce((n, g) => n + g._count._all, 0);
  const sum = (k: "spend" | "impressions" | "clicks" | "linkClicks" | "purchases" | "purchaseValue") => groups.reduce((n, g) => n + toNumber(g._sum[k]), 0);
  const every = (k: "linkClicks" | "purchases" | "purchaseValue") => groups.every((g) => g._count[k] === g._count._all);
  const money = adFigureSlack("meta", rows, AD_CHECK_DAYS);
  const figures: AdFigure[] = [
    { field: "spend", stored: cents(sum("spend")), platform: p.spend, slack: money },
    { field: "impressions", stored: sum("impressions"), platform: p.impressions, slack: 1 },
    { field: "clicks", stored: sum("clicks"), platform: p.clicks, slack: 1 },
  ];
  if (every("linkClicks")) figures.push({ field: "linkClicks", stored: sum("linkClicks"), platform: p.linkClicks, slack: 1 });
  if (every("purchases")) figures.push({ field: "purchases", stored: cents(sum("purchases")), platform: p.purchases, slack: 1 });
  if (every("purchaseValue")) figures.push({ field: "purchaseValue", stored: cents(sum("purchaseValue")), platform: p.purchaseValue, slack: money });
  // Meta reports in the account's currency, which the daily health read keeps on the connection.
  return { figures, storedCurrencies: currenciesOf(groups), currency: conn.currency };
}

/**
 * AdSense: every stored site of the account (adsense_daily keeps them all; the store's choice of sites
 * is for what the dashboard shows, not for this) against the totals of one report of the week, every
 * site included.
 */
async function adsenseRead(conn: AdConnection, w: { since: string; until: string }, fetchImpl: FetchLike | undefined, deadline: number): Promise<Read | null> {
  const f = fetchUntil(fetchImpl, deadline, () => new AdsRetryableError("AdSense didn't answer in time"));
  const cfg = adsenseConfig(f);
  if (!cfg) return null;
  const report = await adsenseReport(cfg, await adAccessToken(conn, f), conn.accountId, "site", w.since, w.until);
  const groups = await systemDb.adsenseDaily.groupBy({
    by: ["currency"],
    where: { connectionId: conn.id, day: { gte: w.since, lte: w.until } },
    _sum: { earnings: true, pageViews: true, impressions: true, clicks: true },
    _count: { _all: true },
  });
  const rows = groups.reduce((n, g) => n + g._count._all, 0);
  const sum = (k: "earnings" | "pageViews" | "impressions" | "clicks") => groups.reduce((n, g) => n + toNumber(g._sum[k]), 0);
  const p = report.totals;
  return {
    figures: [
      { field: "earnings", stored: cents(sum("earnings")), platform: p.earnings, slack: adFigureSlack("adsense", rows, AD_CHECK_DAYS) },
      { field: "pageViews", stored: sum("pageViews"), platform: p.pageViews, slack: 1 },
      { field: "impressions", stored: sum("impressions"), platform: p.impressions, slack: 1 },
      { field: "clicks", stored: sum("clicks"), platform: p.clicks, slack: 1 },
    ],
    storedCurrencies: currenciesOf(groups),
    currency: report.currency ?? conn.currency,
  };
}

const currenciesOf = (groups: Array<{ currency: string | null }>) => [...new Set(groups.map((g) => g.currency).filter((c): c is string => !!c))].sort();

/**
 * Check one connection's settled week against its platform, and log what was found. A platform that
 * asks to wait skips it ("rate_limited"); any other failure is thrown for the caller to log. `deadline`
 * (epoch ms): when the platform's reads must be done, by default AD_CHECK_CALL_MS from now.
 */
export async function checkAdConnectionFigures(conn: AdConnection, opts: { fetchImpl?: FetchLike; now?: Date; deadline?: number } = {}): Promise<AdFiguresCheck> {
  if (conn.isDemo) return { outcome: "skipped", reason: "demo" };
  if (conn.provider === "google") return { outcome: "skipped", reason: "google" };
  // Only an account whose syncs work: one that waits for someone, fails, is hidden, closed or still
  // reads through Nango has stored days nobody is keeping current.
  if (!conn.enabled || conn.status !== "active" || conn.accountStatus === "closed" || !conn.accessTokenEnc || isNangoConnection(conn)) return { outcome: "skipped", reason: "not_active" };
  const w = adCheckWindow(conn, opts.now);
  if (!w) return { outcome: "skipped", reason: "not_covered" };
  const deadline = opts.deadline ?? Date.now() + AD_CHECK_CALL_MS;
  let read: Read | null;
  try {
    read = conn.provider === "meta" ? await metaRead(conn, w, opts.fetchImpl, deadline) : conn.provider === "adsense" ? await adsenseRead(conn, w, opts.fetchImpl, deadline) : null;
  } catch (err) {
    if (!(err instanceof AdsRateLimitedError)) throw err;
    logger.info({ connectionId: conn.id, provider: conn.provider, errorCode: err.errorCode }, "ad figures not checked: the platform asked to wait");
    return { outcome: "skipped", reason: "rate_limited" };
  }
  if (!read) return { outcome: "skipped", reason: "not_configured" };
  const differences = adFigureDifferences(read.figures);
  if (read.currency && read.storedCurrencies.some((c) => c !== read.currency)) {
    differences.unshift({ field: "currency", stored: read.storedCurrencies.join(","), platform: read.currency, relative: null });
  }
  const at = { provider: conn.provider, connectionId: conn.id, since: w.since, until: w.until, currency: read.currency };
  for (const d of differences) logger.warn({ ...at, ...d }, "ad figures differ from the platform");
  if (!differences.length) logger.info({ ...at, fields: read.figures.map((f) => f.field) }, "ad figures match the platform");
  return { outcome: differences.length ? "differ" : "match", ...w, currency: read.currency, differences };
}

export interface AdFiguresSweep {
  /** Connections compared with their platform this run. */
  checked: number;
  /** Of those, how many had a figure that differs. */
  differed: number;
  /** Leased but not compared: the platform asked to wait, or isn't set up here. */
  skipped: number;
  /** Leased, and the platform or the database failed: tried again tomorrow. */
  failed: number;
}

/**
 * The cron's daily check (scheduleReconcile in apps/worker): every Meta and AdSense account whose
 * syncs work and whose stored days cover the week, each once a day (its lease, AD_CHECK_LEASE_MS),
 * AD_CHECK_CONCURRENCY at a time, none started after AD_CHECK_BUDGET_MS. Best effort: a connection's
 * failure is logged and the rest go on, and nothing is thrown for one.
 */
export async function checkAdFiguresDaily(deps: { coord: Coord; fetchImpl?: FetchLike }, opts: { now?: Date; budgetMs?: number; concurrency?: number } = {}): Promise<AdFiguresSweep> {
  const now = opts.now ?? new Date();
  const deadline = Date.now() + (opts.budgetMs ?? AD_CHECK_BUDGET_MS);
  const listed = await systemDb.adConnection.findMany({
    where: { provider: { in: ["meta", "adsense"] }, enabled: true, status: "active", isDemo: false, source: "direct", accessTokenEnc: { not: "" } },
    select: { id: true, storeId: true, timezone: true, historyFrom: true, syncedThrough: true, accountStatus: true },
    orderBy: { id: "asc" },
  });
  // A store that uninstalled the app isn't read with the tokens it left behind (as scheduleAdsSync).
  const gone = new Set(
    (await systemDb.store.findMany({ where: { id: { in: [...new Set(listed.map((c) => c.storeId))] }, status: "uninstalled" }, select: { id: true } })).map((s) => s.id),
  );
  const due = listed.filter((c) => !gone.has(c.storeId) && c.accountStatus !== "closed" && adCheckWindow(c, now));
  const sweep: AdFiguresSweep = { checked: 0, differed: 0, skipped: 0, failed: 0 };
  let next = 0;
  const worker = async () => {
    while (next < due.length && Date.now() < deadline) {
      const id = due[next++]!.id;
      // A coordinator that doesn't answer leaves the account for a later tick.
      if (!(await deps.coord.acquire(lease(id), AD_CHECK_LEASE_MS).catch(() => false))) continue;
      try {
        const conn = await systemDb.adConnection.findUnique({ where: { id } });
        const res = conn ? await checkAdConnectionFigures(conn, { fetchImpl: deps.fetchImpl, now, deadline: Date.now() + AD_CHECK_CALL_MS }) : null;
        if (res && res.outcome !== "skipped") {
          sweep.checked++;
          if (res.outcome === "differ") sweep.differed++;
        } else sweep.skipped++;
      } catch (err) {
        sweep.failed++;
        logger.info({ err, connectionId: id, errorCode: classifyAdError(err).code }, "ad figures not checked");
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? AD_CHECK_CONCURRENCY, due.length) }, worker));
  if (sweep.checked || sweep.failed) logger.info({ ...sweep, due: due.length }, "ad figures checked against the platforms");
  return sweep;
}
