/**
 * Zapier's advertising triggers and searches, all from the figures bizinsights has stored
 * (ad_campaign_daily, adsense_daily): nothing here asks Meta or Google. So they are as fresh as the
 * last sync, which every answer says.
 *
 * - Thresholds ("Ad spend passed an amount", "AdSense earnings passed an amount"): checked after each
 *   ad sync (zapierAfterAdSync) for the store's current period and the one before (platforms report
 *   late), once per period per trigger. Amounts in different currencies are never added up: such a
 *   trigger isn't checked, and Settings says why.
 * - "Daily advertising summary": once a day per store, once yesterday's figures are in for every
 *   account (or at noon with what there is, saying which accounts it lacks).
 * - Periods and "yesterday" are the store's calendar days; each platform's rows are its account's
 *   own days. Demo connections (the Google Ads demo) are left out: their figures are generated.
 */
import { systemDb, toNumber } from "@app/db";
import { addDays, localDay, localTime } from "@app/shared";
import { periodKey, periodRange, singleCurrencyTotal, thresholdReached, type ZapierPeriod, type ZapierSpendPlatform } from "@app/shared/zapier";
import { logger } from "../logger.js";
import type { Queues } from "../queues.js";
import type { AuthorizerAccess } from "./access.js";
import { recordZapierEvent } from "./events.js";

type SpendProvider = "meta" | "google";
const PLATFORM_NAME: Record<string, string> = { meta: "Meta Ads", google: "Google Ads", adsense: "Google AdSense" };
const r2 = (n: number) => Math.round(n * 100) / 100;
const providersOf = (p: ZapierSpendPlatform): SpendProvider[] => (p === "any" ? ["meta", "google"] : [p]);

const FRESHNESS =
  "Figures as stored in bizinsights at its last sync with each platform. Today's figures change during the day, and platforms credit conversions days later.";
const ATTRIBUTION = "Purchase value and ROAS are what each ad platform credits to its own ads (its attribution), not the store's revenue.";
const ADSENSE_ESTIMATES = "AdSense earnings are Google's estimates: Google can adjust them, and finalizes a month's earnings after it ends.";

// ---------------------------------------------------------------------------
// Reading the stored figures
// ---------------------------------------------------------------------------

export interface AccountSpend {
  platform: string;
  account_id: string;
  account_name: string | null;
  currency: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  /** The platform's own credit for purchases; null where the platform reports none (or hasn't yet). */
  platform_attributed_purchase_value: number | null;
  last_synced_at: string | null;
  /** The last of the account's own days stored without a gap. */
  data_through: string | null;
}

/** Each connected (enabled, real) ad account's figures for the days, one row per account and currency. */
export async function adSpendByAccount(storeId: string, providers: SpendProvider[], since: string, until: string): Promise<AccountSpend[]> {
  const conns = await systemDb.adConnection.findMany({
    where: { storeId, provider: { in: providers }, enabled: true, isDemo: false },
    select: { id: true, provider: true, accountId: true, accountName: true, currency: true, lastSyncedAt: true, syncedThrough: true },
  });
  if (!conns.length) return [];
  const sums = await systemDb.adCampaignDaily.groupBy({
    by: ["connectionId", "currency"],
    where: { connectionId: { in: conns.map((c) => c.id) }, day: { gte: since, lte: until } },
    _sum: { spend: true, impressions: true, clicks: true, conversions: true, purchaseValue: true },
  });
  const out: AccountSpend[] = [];
  for (const c of conns) {
    const rows = sums.filter((s) => s.connectionId === c.id);
    const base = { platform: c.provider, account_id: c.accountId, account_name: c.accountName, last_synced_at: c.lastSyncedAt?.toISOString() ?? null, data_through: c.syncedThrough };
    if (!rows.length) out.push({ ...base, currency: c.currency, spend: 0, impressions: 0, clicks: 0, conversions: 0, platform_attributed_purchase_value: null });
    for (const s of rows) {
      out.push({
        ...base,
        currency: s.currency ?? c.currency,
        spend: r2(toNumber(s._sum.spend)),
        impressions: s._sum.impressions ?? 0,
        clicks: s._sum.clicks ?? 0,
        conversions: r2(toNumber(s._sum.conversions)),
        platform_attributed_purchase_value: s._sum.purchaseValue === null ? null : r2(toNumber(s._sum.purchaseValue)),
      });
    }
  }
  return out;
}

export interface AccountEarnings {
  account_id: string;
  account_name: string | null;
  currency: string | null;
  earnings_estimated: number;
  page_views: number;
  impressions: number;
  clicks: number;
  last_synced_at: string | null;
  data_through: string | null;
}

/** Each connected AdSense account's estimated earnings for the days. */
export async function adsenseByAccount(storeId: string, since: string, until: string): Promise<AccountEarnings[]> {
  const conns = await systemDb.adConnection.findMany({
    where: { storeId, provider: "adsense", enabled: true, isDemo: false },
    select: { id: true, accountId: true, accountName: true, currency: true, lastSyncedAt: true, syncedThrough: true },
  });
  if (!conns.length) return [];
  const sums = await systemDb.adsenseDaily.groupBy({
    by: ["connectionId", "currency"],
    where: { connectionId: { in: conns.map((c) => c.id) }, day: { gte: since, lte: until } },
    _sum: { earnings: true, pageViews: true, impressions: true, clicks: true },
  });
  const out: AccountEarnings[] = [];
  for (const c of conns) {
    const rows = sums.filter((s) => s.connectionId === c.id);
    const base = { account_id: c.accountId, account_name: c.accountName, last_synced_at: c.lastSyncedAt?.toISOString() ?? null, data_through: c.syncedThrough };
    if (!rows.length) out.push({ ...base, currency: c.currency, earnings_estimated: 0, page_views: 0, impressions: 0, clicks: 0 });
    for (const s of rows) {
      out.push({ ...base, currency: s.currency ?? c.currency, earnings_estimated: r2(toNumber(s._sum.earnings)), page_views: s._sum.pageViews ?? 0, impressions: s._sum.impressions ?? 0, clicks: s._sum.clicks ?? 0 });
    }
  }
  return out;
}

const latest = (xs: Array<string | null>) => xs.filter((x): x is string => !!x).sort().at(-1) ?? null;

/** Totals over several accounts: money only when they share a currency (`mixed_currencies` lists them otherwise). */
function spendTotals(accounts: AccountSpend[]) {
  const spend = singleCurrencyTotal(accounts.map((a) => ({ currency: a.currency, amount: a.spend })));
  const valued = accounts.filter((a) => a.platform_attributed_purchase_value !== null);
  const value = valued.length ? singleCurrencyTotal(valued.map((a) => ({ currency: a.currency, amount: a.platform_attributed_purchase_value! }))) : null;
  const mixed = "mixed" in spend ? spend.mixed : null;
  const total = "total" in spend ? spend.total : null;
  const purchaseValue = value && "total" in value ? value.total : null;
  return {
    spend: total,
    currency: "total" in spend ? spend.currency : null,
    mixed_currencies: mixed,
    impressions: accounts.reduce((s, a) => s + a.impressions, 0),
    clicks: accounts.reduce((s, a) => s + a.clicks, 0),
    conversions: r2(accounts.reduce((s, a) => s + a.conversions, 0)),
    platform_attributed_purchase_value: purchaseValue,
    platform_attributed_roas: purchaseValue !== null && total ? r2(purchaseValue / total) : null,
  };
}

// ---------------------------------------------------------------------------
// Searches
// ---------------------------------------------------------------------------

/** "Find ad performance": the store's stored Meta and Google Ads figures for the days. Empty with no ad account connected. */
export async function findAdPerformance(storeId: string, platform: ZapierSpendPlatform, since: string, until: string) {
  const accounts = await adSpendByAccount(storeId, providersOf(platform), since, until);
  if (!accounts.length) return [];
  return [
    {
      id: `ad_performance:${storeId}:${platform}:${since}:${until}`,
      platform,
      since,
      until,
      ...spendTotals(accounts),
      accounts,
      last_successful_sync_at: latest(accounts.map((a) => a.last_synced_at)),
      data_through: latest(accounts.map((a) => a.data_through)),
      freshness_note: FRESHNESS,
      attribution_note: ATTRIBUTION,
    },
  ];
}

/** "Find AdSense earnings": the store's estimated AdSense earnings for the days. Empty with no AdSense account connected. */
export async function findAdsenseEarnings(storeId: string, since: string, until: string) {
  const accounts = await adsenseByAccount(storeId, since, until);
  if (!accounts.length) return [];
  const total = singleCurrencyTotal(accounts.map((a) => ({ currency: a.currency, amount: a.earnings_estimated })));
  return [
    {
      id: `adsense_earnings:${storeId}:${since}:${until}`,
      since,
      until,
      earnings_estimated: "total" in total ? total.total : null,
      currency: "total" in total ? total.currency : null,
      mixed_currencies: "mixed" in total ? total.mixed : null,
      page_views: accounts.reduce((s, a) => s + a.page_views, 0),
      impressions: accounts.reduce((s, a) => s + a.impressions, 0),
      clicks: accounts.reduce((s, a) => s + a.clicks, 0),
      accounts,
      last_successful_sync_at: latest(accounts.map((a) => a.last_synced_at)),
      data_through: latest(accounts.map((a) => a.data_through)),
      freshness_note: FRESHNESS,
      estimates_note: ADSENSE_ESTIMATES,
    },
  ];
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

export interface ThresholdInputs {
  platform?: ZapierSpendPlatform;
  period: ZapierPeriod;
  amount: number;
}

/**
 * Check the store's threshold triggers against its stored figures: the current period, and the one
 * before when it ended after the trigger was made (late figures can still cross it). Each crossing is
 * one event for that trigger (its key names the trigger and the period). Returns how many fired.
 */
export async function checkZapierThresholds(storeId: string, queues?: Pick<Queues, "sync">, now = new Date()): Promise<number> {
  const hooks = await systemDb.zapierHook.findMany({ where: { storeId, event: { in: ["ad_spend_threshold", "adsense_earnings_threshold"] }, grant: { revokedAt: null } } });
  if (!hooks.length) return 0;
  const store = await systemDb.store.findUnique({ where: { id: storeId }, select: { workspaceId: true, timezone: true } });
  if (!store) return 0;
  const today = localDay(now, store.timezone);
  let fired = 0;
  for (const hook of hooks) {
    const inputs = hook.inputs as unknown as ThresholdInputs;
    if (!inputs || !(inputs.amount > 0) || (inputs.period !== "day" && inputs.period !== "month")) continue;
    const current = periodKey(today, inputs.period);
    const previous = periodKey(inputs.period === "day" ? addDays(today, -1) : addDays(`${current}-01`, -1), inputs.period);
    const keys = [current];
    // A period that ended before the trigger existed is no news to it.
    if (periodRange(previous).until >= localDay(hook.createdAt, store.timezone)) keys.unshift(previous);
    let note: string | null = null;
    for (const key of keys) {
      const range = periodRange(key);
      const until = range.until > today ? today : range.until;
      const check =
        hook.event === "ad_spend_threshold"
          ? await spendCheck(storeId, inputs.platform ?? "any", range.since, until)
          : await earningsCheck(storeId, range.since, until);
      if (!check) continue;
      if ("mixed" in check) {
        note = `mixed_currencies:${check.mixed.join(",")}`;
        continue;
      }
      if (!thresholdReached(check.total, inputs.amount)) continue;
      const data = {
        trigger: { platform: hook.event === "ad_spend_threshold" ? (inputs.platform ?? "any") : "adsense", period: inputs.period, amount: inputs.amount },
        period: key,
        period_start: range.since,
        period_end: range.until,
        period_complete: range.until < today,
        ...(hook.event === "ad_spend_threshold" ? { spend: check.total } : { earnings_estimated: check.total }),
        currency: check.currency,
        accounts: check.accounts,
        last_successful_sync_at: latest(check.accounts.map((a) => a.last_synced_at)),
        freshness_note: FRESHNESS,
        ...(hook.event === "adsense_earnings_threshold" ? { estimates_note: ADSENSE_ESTIMATES } : {}),
      };
      fired += await recordZapierEvent({ workspaceId: store.workspaceId, storeId, event: hook.event as "ad_spend_threshold", dedupeKey: `${hook.event}:${hook.id}:${key}`, hookId: hook.id, data }, queues, now);
    }
    await systemDb.zapierHook.updateMany({ where: { id: hook.id }, data: { checkedAt: now, checkNote: note } });
  }
  return fired;
}

type Check = { total: number; currency: string | null; accounts: Array<{ last_synced_at: string | null }> } | { mixed: string[] } | null;

async function spendCheck(storeId: string, platform: ZapierSpendPlatform, since: string, until: string): Promise<Check> {
  const accounts = await adSpendByAccount(storeId, providersOf(platform), since, until);
  if (!accounts.length) return null;
  const t = singleCurrencyTotal(accounts.map((a) => ({ currency: a.currency, amount: a.spend })));
  return "mixed" in t ? t : { ...t, accounts: accounts.map((a) => ({ platform: a.platform, account_id: a.account_id, account_name: a.account_name, spend: a.spend, currency: a.currency, last_synced_at: a.last_synced_at })) };
}

async function earningsCheck(storeId: string, since: string, until: string): Promise<Check> {
  const accounts = await adsenseByAccount(storeId, since, until);
  if (!accounts.length) return null;
  const t = singleCurrencyTotal(accounts.map((a) => ({ currency: a.currency, amount: a.earnings_estimated })));
  return "mixed" in t ? t : { ...t, accounts: accounts.map((a) => ({ account_id: a.account_id, account_name: a.account_name, earnings_estimated: a.earnings_estimated, currency: a.currency, last_synced_at: a.last_synced_at })) };
}

// ---------------------------------------------------------------------------
// The daily summary
// ---------------------------------------------------------------------------

/** From this store-local hour the summary goes with whatever is in, rather than waiting for every account. */
const SUMMARY_LATEST_HOUR = 12;

/** One day's advertising for the store, per platform, with Shopify's own sales for the day beside it (redacted per person at delivery). */
export async function adsDailySummaryData(storeId: string, day: string): Promise<Record<string, unknown> | null> {
  const [spend, adsense, metrics] = await Promise.all([
    adSpendByAccount(storeId, ["meta", "google"], day, day),
    adsenseByAccount(storeId, day, day),
    systemDb.dailyStoreMetrics.findUnique({ where: { storeId_day: { storeId, day } } }),
  ]);
  if (!spend.length && !adsense.length) return null;
  const store = await systemDb.store.findUnique({ where: { id: storeId }, select: { currency: true } });
  const platforms = (["meta", "google"] as const)
    .map((p) => ({ p, accounts: spend.filter((a) => a.platform === p) }))
    .filter((x) => x.accounts.length)
    .map(({ p, accounts }) => ({ platform: p, name: PLATFORM_NAME[p], ...spendTotals(accounts), accounts }));
  const earnings = adsense.length ? singleCurrencyTotal(adsense.map((a) => ({ currency: a.currency, amount: a.earnings_estimated }))) : null;
  const missing = [...spend, ...adsense].filter((a) => !a.data_through || a.data_through < day).map((a) => a.account_id);
  const net = metrics ? r2(toNumber(metrics.grossSales) - toNumber(metrics.discounts) - toNumber(metrics.refunds)) : null;
  return {
    day,
    platforms,
    adsense: earnings
      ? {
          earnings_estimated: "total" in earnings ? earnings.total : null,
          currency: "total" in earnings ? earnings.currency : null,
          mixed_currencies: "mixed" in earnings ? earnings.mixed : null,
          page_views: adsense.reduce((s, a) => s + a.page_views, 0),
          clicks: adsense.reduce((s, a) => s + a.clicks, 0),
          accounts: adsense,
          estimates_note: ADSENSE_ESTIMATES,
        }
      : null,
    // Shopify's own figures for the day, kept apart from the platforms' attribution.
    shopify: metrics ? { net_sales: net, total_sales: r2(toNumber(metrics.totalSales)), orders: metrics.orders, currency: store?.currency ?? null } : null,
    accounts_without_the_day: missing,
    freshness_note: FRESHNESS,
    attribution_note: ATTRIBUTION,
  };
}

/**
 * Send yesterday's summary to the store's "Daily advertising summary" triggers once it is in: every
 * account has the day stored, or it is past noon at the store. Once per store and day.
 */
export async function maybeSendAdsDailySummary(storeId: string, queues?: Pick<Queues, "sync">, now = new Date()): Promise<boolean> {
  const hooks = await systemDb.zapierHook.count({ where: { storeId, event: "ads_daily_summary", grant: { revokedAt: null } } });
  if (!hooks) return false;
  const store = await systemDb.store.findUnique({ where: { id: storeId }, select: { workspaceId: true, timezone: true } });
  if (!store) return false;
  const day = addDays(localDay(now, store.timezone), -1);
  const dedupeKey = `ads_daily_summary:${storeId}:${day}`;
  if (await systemDb.zapierEvent.findUnique({ where: { dedupeKey }, select: { id: true } })) return false;
  const conns = await systemDb.adConnection.findMany({ where: { storeId, enabled: true, isDemo: false }, select: { syncedThrough: true } });
  if (!conns.length) return false;
  const allIn = conns.every((c) => !!c.syncedThrough && c.syncedThrough >= day);
  const hour = Number(localTime(now, store.timezone).slice(0, 2));
  if (!allIn && hour < SUMMARY_LATEST_HOUR) return false;
  const data = await adsDailySummaryData(storeId, day);
  if (!data) return false;
  return (await recordZapierEvent({ workspaceId: store.workspaceId, storeId, event: "ads_daily_summary", dedupeKey, data }, queues, now)) > 0;
}

/** Every store with a summary trigger: the cron's safety net for stores whose syncs didn't bring it. */
export async function sweepAdsDailySummaries(queues?: Pick<Queues, "sync">, now = new Date()): Promise<number> {
  const stores = await systemDb.zapierHook.findMany({ where: { event: "ads_daily_summary", grant: { revokedAt: null } }, select: { storeId: true }, distinct: ["storeId"] });
  let sent = 0;
  for (const s of stores) {
    if (await maybeSendAdsDailySummary(s.storeId, queues, now).catch((err: unknown) => (logger.error({ err, storeId: s.storeId }, "zapier daily summary failed"), false))) sent++;
  }
  return sent;
}

/**
 * After an ad account's sync stored its figures (the worker's runAdsSync): its store's thresholds and
 * daily summary. Never throws: the sync itself worked, whatever Zapier's side of it does.
 */
export async function zapierAfterAdSync(connectionId: string, deps: { queues: Pick<Queues, "sync"> }, now = new Date()): Promise<void> {
  try {
    const conn = await systemDb.adConnection.findUnique({ where: { id: connectionId }, select: { storeId: true, isDemo: true } });
    if (!conn || conn.isDemo) return;
    await checkZapierThresholds(conn.storeId, deps.queues, now);
    await maybeSendAdsDailySummary(conn.storeId, deps.queues, now);
  } catch (err) {
    logger.error({ err, connectionId }, "zapier checks after an ad sync failed");
  }
}

/** A real sample for "Daily advertising summary" when none was sent yet: yesterday's figures as stored (null without any). */
export async function summarySample(storeId: string, who: Pick<AuthorizerAccess, "store">, now = new Date()) {
  const day = addDays(localDay(now, who.store.timezone), -1);
  const data = await adsDailySummaryData(storeId, day);
  return data ? { dedupeKey: `ads_daily_summary:${storeId}:${day}`, data } : null;
}
