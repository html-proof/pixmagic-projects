/**
 * Zapier's advertising triggers and searches, all from the figures bizinsights has stored
 * (ad_campaign_daily, adsense_daily): nothing here asks Meta or Google. So they are as fresh as the
 * last sync, which every answer says.
 *
 * - Thresholds ("Ad spend passed an amount", "AdSense earnings passed an amount"): checked after each
 *   ad sync (zapierAfterAdSync) for the store's current period and the one before (platforms report
 *   late), once per period per trigger. Amounts in different currencies are never added up: such a
 *   trigger isn't checked, and Settings says why. An AdSense trigger can instead watch for earnings
 *   that fell below the amount: only a finished period counts, once every account has its last day.
 * - "Ad account synced": after an ad account's sync, at most once an hour per account.
 * - "Daily advertising summary": once a day per store, once yesterday's figures are in for every
 *   account (or at noon with what there is, saying which accounts it lacks).
 * - Periods and "yesterday" are the store's calendar days; each platform's rows are its account's
 *   own days. Demo connections (the Google Ads demo) are left out: their figures are generated.
 * - Meta or Google with no API figures shown (no ad account, or its access ended before the dates)
 *   counts the spend its app reported to Shopify instead (shopify_marketing_days), as the dashboard
 *   does, tagged `source: "shopify_marketing"`; never both for one platform. Checked after each read
 *   of Shopify's marketing report too (zapierAfterMarketingRead), since such a store has no ad sync.
 */
import { systemDb, toNumber } from "@app/db";
import {
  addDays,
  adPlatformSources,
  adsenseSiteChosen,
  claimsAddUp,
  localDay,
  localTime,
  marketingFigures,
  marketingPlatform,
  resolveCapabilities,
  type AdSourceFacts,
  type MarketingRow,
} from "@app/shared";
import {
  integrationOfProvider,
  periodKey,
  periodRange,
  singleCurrencyTotal,
  thresholdReached,
  ZAPIER_INTEGRATIONS,
  type ZapierDirection,
  type ZapierPeriod,
  type ZapierSpendPlatform,
} from "@app/shared/zapier";
import { logger } from "../logger.js";
import type { Queues } from "../queues.js";
import { marketingReady } from "../shopifyMarketing.js";
import type { AuthorizerAccess } from "./access.js";
import { recordZapierEvent } from "./events.js";

type SpendProvider = "meta" | "google";
const PLATFORM_NAME: Record<string, string> = { meta: "Meta Ads", google: "Google Ads", adsense: "Google AdSense" };
const r2 = (n: number) => Math.round(n * 100) / 100;
const providersOf = (p: ZapierSpendPlatform): SpendProvider[] => (p === "any" ? ["meta", "google"] : [p]);

const FRESHNESS =
  "Figures as stored in bizinsights at its last sync with each platform. Today's figures change during the day, and platforms credit conversions days later.";
const ATTRIBUTION =
  "Purchase value and ROAS are what each ad platform credits to its own ads (its attribution), not the store's revenue. Two platforms can credit the same order: use each platform's own (platforms).";
const ADSENSE_ESTIMATES = "AdSense earnings are Google's estimates: Google can adjust them, and finalizes a month's earnings after it ends.";
const REPORTED_TO_SHOPIFY =
  "A platform with source shopify_marketing has no ad account figures in bizinsights: its spend is what its app (Facebook & Instagram, Google & YouTube) reported to Shopify, read every 6 hours. It can reach Shopify up to a day late and be revised for a few days.";

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
  /** The sites counted for the store (Settings → Advertising); empty: every site. */
  sites: string[];
  /**
   * Sites are chosen, and AdSense didn't split the account's earnings by site on some of the days (one
   * row with site ""): those days are left out, as the dashboard leaves them, so the store's share is
   * missing for them rather than counted wrong. The last such day, or null.
   */
  unsplit_through: string | null;
}

/**
 * Each connected AdSense account's estimated earnings for the days, counting only the sites chosen for
 * the store, as the dashboard does (reports/ads.ts adsenseFigures): every site when none are chosen; with
 * sites chosen, a day AdSense didn't split by site is left out (`unsplit_through`).
 */
export async function adsenseByAccount(storeId: string, since: string, until: string): Promise<AccountEarnings[]> {
  const conns = await systemDb.adConnection.findMany({
    where: { storeId, provider: "adsense", enabled: true, isDemo: false },
    select: { id: true, accountId: true, accountName: true, currency: true, lastSyncedAt: true, syncedThrough: true, sites: true },
  });
  if (!conns.length) return [];
  const rows = await systemDb.adsenseDaily.findMany({
    where: { connectionId: { in: conns.map((c) => c.id) }, day: { gte: since, lte: until } },
    select: { connectionId: true, site: true, day: true, currency: true, earnings: true, pageViews: true, impressions: true, clicks: true },
  });
  const out: AccountEarnings[] = [];
  for (const c of conns) {
    const sites = c.sites ?? [];
    const mine = rows.filter((r) => r.connectionId === c.id);
    const unsplit = mine.filter((r) => r.site === "" && !adsenseSiteChosen(sites, ""));
    const counted = mine.filter((r) => adsenseSiteChosen(sites, r.site));
    const base = {
      account_id: c.accountId,
      account_name: c.accountName,
      last_synced_at: c.lastSyncedAt?.toISOString() ?? null,
      data_through: c.syncedThrough,
      sites,
      unsplit_through: unsplit.map((r) => r.day).sort().at(-1) ?? null,
    };
    const byCurrency = new Map<string | null, typeof counted>();
    for (const r of counted) {
      const cur = r.currency ?? c.currency;
      byCurrency.set(cur, [...(byCurrency.get(cur) ?? []), r]);
    }
    if (!byCurrency.size) out.push({ ...base, currency: c.currency, earnings_estimated: 0, page_views: 0, impressions: 0, clicks: 0 });
    for (const [currency, list] of byCurrency) {
      out.push({
        ...base,
        currency,
        earnings_estimated: r2(list.reduce((s, r) => s + toNumber(r.earnings), 0)),
        page_views: list.reduce((s, r) => s + (r.pageViews ?? 0), 0),
        impressions: list.reduce((s, r) => s + (r.impressions ?? 0), 0),
        clicks: list.reduce((s, r) => s + (r.clicks ?? 0), 0),
      });
    }
  }
  return out;
}

/**
 * A platform's spend for the days as its app (Facebook & Instagram, Google & YouTube) reported it to
 * Shopify, in the store's currency (packages/core/src/shopifyMarketing.ts keeps it). As the dashboard
 * counts it (marketingFigures in @app/shared/shopifyMarketing): the channel's whole days only, never
 * its campaign rows (parts of those days); only the days read from Shopify with none missing; only
 * spend above 0. Its orders and sales are the channel's own claim, like a platform's purchases.
 */
export interface ReportedSpend {
  platform: SpendProvider;
  source: "shopify_marketing";
  /** The apps that reported it, as Shopify names them ("Google & YouTube"). */
  reported_by: string[];
  currency: string;
  spend: number;
  /** Null where the channel reported none. */
  impressions: number | null;
  clicks: number | null;
  /** The channel's own count of orders from its ads. */
  conversions: number | null;
  /** Those orders' sales, as the channel credits them to its ads. */
  platform_attributed_purchase_value: number | null;
  /** Sales ÷ spend over the days it reported spend, as the dashboard works it out. */
  platform_attributed_roas: number | null;
  /** When Shopify's marketing report was last read. */
  last_synced_at: string | null;
  /** The last day read from Shopify with none missing before it. */
  data_through: string | null;
}

const marketingOn = (grantedScopes: string[]) => resolveCapabilities(grantedScopes).some((c) => c.id === "shopify_marketing" && c.enabled);

/** How far Shopify's marketing report is read for the store, while "Ad spend reported to Shopify" is on for it; null otherwise. */
async function marketingRead(storeId: string) {
  const store = await systemDb.store.findUnique({ where: { id: storeId }, select: { grantedScopes: true, currency: true } });
  if (!store || !marketingOn(store.grantedScopes) || !(await marketingReady(systemDb))) return null;
  const sync = await systemDb.shopifyMarketingSync.findUnique({ where: { storeId }, select: { coveredFrom: true, syncedThrough: true, lastSyncedAt: true, lastError: true } });
  return sync ? { currency: store.currency, sync } : null;
}

/** Meta's and Google's spend for the days as their apps reported it to Shopify: a platform that reported none has no entry, never a 0. */
export async function reportedSpendByPlatform(storeId: string, providers: SpendProvider[], since: string, until: string): Promise<ReportedSpend[]> {
  const read = await marketingRead(storeId);
  const { coveredFrom, syncedThrough, lastSyncedAt } = read?.sync ?? {};
  if (!read || !coveredFrom || !syncedThrough) return [];
  // Only the days read: a day after a gap, or not read yet, isn't known.
  const from = coveredFrom > since ? coveredFrom : since;
  const to = syncedThrough < until ? syncedThrough : until;
  if (from > to) return [];
  const rows = await systemDb.shopifyMarketingDay.findMany({
    where: { storeId, campaign: "", day: { gte: from, lte: to } },
    select: { day: true, channel: true, app: true, spend: true, impressions: true, clicks: true, orders: true, sales: true, newCustomers: true },
  });
  const num = (v: { toString(): string } | null) => (v === null ? null : Number(v));
  const ours = rows.map(
    (r): MarketingRow => ({ day: r.day, channel: r.channel, app: r.app || null, campaign: null, spend: num(r.spend), impressions: r.impressions, clicks: r.clicks, orders: r.orders, sales: num(r.sales), newCustomers: r.newCustomers }),
  );
  return providers.flatMap((platform): ReportedSpend[] => {
    const mine = ours.filter((r) => marketingPlatform(r.channel, r.app) === platform);
    const f = marketingFigures(mine);
    if (f.spend === null) return [];
    return [
      {
        platform,
        source: "shopify_marketing",
        reported_by: [...new Set(mine.filter((r) => r.spend !== null && r.spend > 0).map((r) => r.app ?? r.channel))].sort(),
        currency: read.currency,
        spend: f.spend,
        impressions: f.impressions,
        clicks: f.clicks,
        conversions: f.orders,
        platform_attributed_purchase_value: f.sales,
        platform_attributed_roas: f.roas === null ? null : r2(f.roas),
        last_synced_at: lastSyncedAt?.toISOString() ?? null,
        data_through: syncedThrough,
      },
    ];
  });
}

/**
 * Meta's and Google's figures for the days, each from one place, as the dashboard picks it
 * (adPlatformSources in @app/shared/adsFromShopify, without the store's orders, which no Zapier figure
 * is): its own API's accounts while they sync, or while their stored days reach into the dates;
 * otherwise what its app reported to Shopify, when Shopify has its spend for them. A platform taken
 * from Shopify leaves its accounts out (their access ended before the dates: nothing of them is
 * stored), so no spend is counted from both.
 */
async function spendSources(storeId: string, providers: SpendProvider[], since: string, until: string): Promise<{ accounts: AccountSpend[]; reported: ReportedSpend[] }> {
  const [accounts, reported] = await Promise.all([adSpendByAccount(storeId, providers, since, until), reportedSpendByPlatform(storeId, providers, since, until)]);
  if (!reported.length) return { accounts, reported };
  const conns = await systemDb.adConnection.findMany({
    where: { storeId, provider: { in: providers }, enabled: true, isDemo: false },
    select: { provider: true, status: true, errorCode: true, accountStatus: true },
  });
  const facts = (p: SpendProvider): AdSourceFacts => ({
    accounts: conns.filter((c) => c.provider === p),
    figures: accounts.some((a) => a.platform === p && !!a.data_through && a.data_through >= since),
    hidden: 0,
    waiting: false,
  });
  const has = (p: SpendProvider) => reported.some((r) => r.platform === p);
  const sources = adPlatformSources({ meta: facts("meta"), google: facts("google") }, false, { meta: has("meta"), google: has("google") });
  const fromShopify = new Set<string>(sources.filter((s) => s.marketing).map((s) => s.provider));
  return { accounts: accounts.filter((a) => !fromShopify.has(a.platform)), reported: reported.filter((r) => fromShopify.has(r.platform)) };
}

const latest = (xs: Array<string | null>) => xs.filter((x): x is string => !!x).sort().at(-1) ?? null;
/** A count added up, or null when any part of it isn't known: never a short count. */
const known = (xs: Array<number | null>) => (xs.some((x) => x === null) ? null : xs.reduce<number>((s, x) => s + x!, 0));

type SpendRow = Pick<AccountSpend, "currency" | "spend" | "platform_attributed_purchase_value"> & { impressions: number | null; clicks: number | null; conversions: number | null };

/** Totals over several accounts: money only when they share a currency (`mixed_currencies` lists them otherwise). */
function spendTotals(accounts: SpendRow[]) {
  const spend = singleCurrencyTotal(accounts.map((a) => ({ currency: a.currency, amount: a.spend })));
  const valued = accounts.filter((a) => a.platform_attributed_purchase_value !== null);
  const value = valued.length ? singleCurrencyTotal(valued.map((a) => ({ currency: a.currency, amount: a.platform_attributed_purchase_value! }))) : null;
  const mixed = "mixed" in spend ? spend.mixed : null;
  const total = "total" in spend ? spend.total : null;
  const purchaseValue = value && "total" in value ? value.total : null;
  const conversions = known(accounts.map((a) => a.conversions));
  return {
    spend: total,
    currency: "total" in spend ? spend.currency : null,
    mixed_currencies: mixed,
    impressions: known(accounts.map((a) => a.impressions)),
    clicks: known(accounts.map((a) => a.clicks)),
    conversions: conversions === null ? null : r2(conversions),
    platform_attributed_purchase_value: purchaseValue,
    platform_attributed_roas: purchaseValue !== null && total ? r2(purchaseValue / total) : null,
  };
}

/** One platform's figures for the days, saying where they come from. */
export type PlatformSpend = ReturnType<typeof spendTotals> & {
  platform: SpendProvider;
  name: string;
  /** "platform_api": its ad accounts' own figures, as synced; "shopify_marketing": what its app reported to Shopify. */
  source: "platform_api" | "shopify_marketing";
  /** Its ad accounts; none from Shopify. */
  accounts: AccountSpend[];
  /** From Shopify only (ReportedSpend). */
  reported_by?: string[];
  last_synced_at?: string | null;
  data_through?: string | null;
};

/** Meta's, then Google's, figures: from its accounts when it has some here, else from Shopify (spendSources picked which). */
function platformsOf(accounts: AccountSpend[], reported: ReportedSpend[]): PlatformSpend[] {
  return (["meta", "google"] as const).flatMap((p): PlatformSpend[] => {
    const own = accounts.filter((a) => a.platform === p);
    if (own.length) return [{ platform: p, name: PLATFORM_NAME[p]!, source: "platform_api", ...spendTotals(own), accounts: own }];
    const r = reported.find((x) => x.platform === p);
    if (!r) return [];
    const { spend, currency, impressions, clicks, conversions, platform_attributed_purchase_value, platform_attributed_roas, reported_by, last_synced_at, data_through } = r;
    return [
      { platform: p, name: PLATFORM_NAME[p]!, source: r.source, spend, currency, mixed_currencies: null, impressions, clicks, conversions, platform_attributed_purchase_value, platform_attributed_roas, accounts: [], reported_by, last_synced_at, data_through },
    ];
  });
}

/**
 * The platforms together. Spend, impressions, clicks and conversions add up (money in one currency
 * only). Purchase value and ROAS are one platform's claim: with Meta and Google both in, they are
 * added across them only for Zaps made before `platforms` existed (deprecated: both platforms can
 * credit the same order, docs/kpis.md), and `claims_add_up` is false (claimsAddUp in @app/shared/ads).
 */
function acrossPlatforms(platforms: PlatformSpend[]) {
  const claims_add_up = claimsAddUp(platforms.map((p) => p.platform));
  if (platforms.length === 1) {
    const { spend, currency, mixed_currencies, impressions, clicks, conversions, platform_attributed_purchase_value, platform_attributed_roas } = platforms[0]!;
    return { spend, currency, mixed_currencies, impressions, clicks, conversions, platform_attributed_purchase_value, platform_attributed_roas, claims_add_up };
  }
  return { ...spendTotals(platforms.flatMap((p): SpendRow[] => (p.accounts.length ? p.accounts : [{ ...p, spend: p.spend ?? 0 }]))), claims_add_up };
}

// ---------------------------------------------------------------------------
// Searches
// ---------------------------------------------------------------------------

/**
 * "Find ad performance": the store's stored Meta and Google Ads figures for the days, each platform's
 * own in `platforms` (from Shopify for one without ad account figures), the platforms together beside
 * them. Empty with neither an ad account connected nor spend reported to Shopify.
 */
export async function findAdPerformance(storeId: string, platform: ZapierSpendPlatform, since: string, until: string) {
  const { accounts, reported } = await spendSources(storeId, providersOf(platform), since, until);
  if (!accounts.length && !reported.length) return [];
  const platforms = platformsOf(accounts, reported);
  const all = [...accounts, ...reported];
  return [
    {
      id: `ad_performance:${storeId}:${platform}:${since}:${until}`,
      platform,
      since,
      until,
      ...acrossPlatforms(platforms),
      platforms,
      accounts,
      last_successful_sync_at: latest(all.map((a) => a.last_synced_at)),
      data_through: latest(all.map((a) => a.data_through)),
      freshness_note: FRESHNESS,
      attribution_note: ATTRIBUTION,
      ...(reported.length ? { shopify_marketing_note: REPORTED_TO_SHOPIFY } : {}),
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
  /** AdSense only; absent (triggers made before it existed): "above". */
  direction?: ZapierDirection;
}

/**
 * Check the store's threshold triggers against its stored figures: the current period, and the one
 * before when it ended after the trigger was made (late figures can still cross it). Each crossing is
 * one event for that trigger (its key names the trigger and the period). Returns how many fired.
 *
 * "Below" (AdSense): a period still running can't have ended below the amount, and one whose last
 * days aren't stored yet would look lower than it was. So only the finished period is checked, once
 * every account has data through its last day; until then the next sync looks again.
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
    const below = hook.event === "adsense_earnings_threshold" && inputs.direction === "below";
    const current = periodKey(today, inputs.period);
    const previous = periodKey(inputs.period === "day" ? addDays(today, -1) : addDays(`${current}-01`, -1), inputs.period);
    const keys = below ? [] : [current];
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
      // Not all of the period is in yet: a total that low may only be days not synced.
      if (below && check.accounts.some((a) => !a.data_through || a.data_through < range.until)) continue;
      if (!thresholdReached(check.total, inputs.amount, below ? "below" : "above")) continue;
      const data = {
        trigger: {
          platform: hook.event === "ad_spend_threshold" ? (inputs.platform ?? "any") : "adsense",
          period: inputs.period,
          amount: inputs.amount,
          direction: below ? "below" : "above",
        },
        period: key,
        period_start: range.since,
        period_end: range.until,
        period_complete: range.until < today,
        ...(hook.event === "ad_spend_threshold" ? { spend: check.total } : { earnings_estimated: check.total }),
        currency: check.currency,
        ...(check.platforms ? { platforms: check.platforms } : {}),
        accounts: check.accounts,
        last_successful_sync_at: latest([...check.accounts, ...(check.platforms ?? [])].map((a) => a.last_synced_at)),
        freshness_note: FRESHNESS,
        ...(check.platforms?.some((p) => p.source === "shopify_marketing") ? { shopify_marketing_note: REPORTED_TO_SHOPIFY } : {}),
        ...(hook.event === "adsense_earnings_threshold" ? { estimates_note: ADSENSE_ESTIMATES } : {}),
      };
      fired += await recordZapierEvent({ workspaceId: store.workspaceId, storeId, event: hook.event as "ad_spend_threshold", dedupeKey: `${hook.event}:${hook.id}:${key}`, hookId: hook.id, data }, queues, now);
    }
    await systemDb.zapierHook.updateMany({ where: { id: hook.id }, data: { checkedAt: now, checkNote: note } });
  }
  return fired;
}

type ThresholdPlatform = Pick<PlatformSpend, "platform" | "name" | "source" | "spend" | "currency" | "reported_by" | "data_through"> & { last_synced_at: string | null };
type Check =
  | { total: number; currency: string | null; accounts: Array<{ last_synced_at: string | null; data_through?: string | null }>; platforms?: ThresholdPlatform[] }
  | { mixed: string[] }
  | null;

async function spendCheck(storeId: string, platform: ZapierSpendPlatform, since: string, until: string): Promise<Check> {
  const { accounts, reported } = await spendSources(storeId, providersOf(platform), since, until);
  if (!accounts.length && !reported.length) return null;
  const t = singleCurrencyTotal([...accounts, ...reported].map((a) => ({ currency: a.currency, amount: a.spend })));
  if ("mixed" in t) return t;
  return {
    ...t,
    // Each platform's spend and where it comes from; its accounts' own below.
    platforms: platformsOf(accounts, reported).map((p) => ({
      platform: p.platform,
      name: p.name,
      source: p.source,
      spend: p.spend,
      currency: p.currency,
      last_synced_at: p.source === "shopify_marketing" ? (p.last_synced_at ?? null) : latest(p.accounts.map((a) => a.last_synced_at)),
      ...(p.source === "shopify_marketing" ? { reported_by: p.reported_by, data_through: p.data_through } : {}),
    })),
    accounts: accounts.map((a) => ({ platform: a.platform, account_id: a.account_id, account_name: a.account_name, spend: a.spend, currency: a.currency, last_synced_at: a.last_synced_at })),
  };
}

async function earningsCheck(storeId: string, since: string, until: string): Promise<Check> {
  const accounts = await adsenseByAccount(storeId, since, until);
  if (!accounts.length) return null;
  const t = singleCurrencyTotal(accounts.map((a) => ({ currency: a.currency, amount: a.earnings_estimated })));
  return "mixed" in t
    ? t
    : { ...t, accounts: accounts.map((a) => ({ account_id: a.account_id, account_name: a.account_name, earnings_estimated: a.earnings_estimated, currency: a.currency, last_synced_at: a.last_synced_at, data_through: a.data_through })) };
}

// ---------------------------------------------------------------------------
// The daily summary
// ---------------------------------------------------------------------------

/** From this store-local hour the summary goes with whatever is in, rather than waiting for every account. */
const SUMMARY_LATEST_HOUR = 12;

/**
 * One day's advertising for the store, per platform (from Shopify for one without ad account figures),
 * with Shopify's own sales for the day beside it (redacted per person at delivery).
 */
export async function adsDailySummaryData(storeId: string, day: string): Promise<Record<string, unknown> | null> {
  const [{ accounts: spend, reported }, adsense, metrics] = await Promise.all([
    spendSources(storeId, ["meta", "google"], day, day),
    adsenseByAccount(storeId, day, day),
    systemDb.dailyStoreMetrics.findUnique({ where: { storeId_day: { storeId, day } } }),
  ]);
  if (!spend.length && !reported.length && !adsense.length) return null;
  const store = await systemDb.store.findUnique({ where: { id: storeId }, select: { currency: true } });
  const platforms = platformsOf(spend, reported);
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
    ...(reported.length ? { shopify_marketing_note: REPORTED_TO_SHOPIFY } : {}),
  };
}

/**
 * Send yesterday's summary to the store's "Daily advertising summary" triggers once it is in: every
 * account has the day stored, and Shopify's marketing report is read through it where it may stand in
 * for Meta or Google (a platform without an ad account here); or it is past noon at the store. Once
 * per store and day.
 */
export async function maybeSendAdsDailySummary(storeId: string, queues?: Pick<Queues, "sync">, now = new Date()): Promise<boolean> {
  const hooks = await systemDb.zapierHook.count({ where: { storeId, event: "ads_daily_summary", grant: { revokedAt: null } } });
  if (!hooks) return false;
  const store = await systemDb.store.findUnique({ where: { id: storeId }, select: { workspaceId: true, timezone: true } });
  if (!store) return false;
  const day = addDays(localDay(now, store.timezone), -1);
  const dedupeKey = `ads_daily_summary:${storeId}:${day}`;
  if (await systemDb.zapierEvent.findUnique({ where: { dedupeKey }, select: { id: true } })) return false;
  const conns = await systemDb.adConnection.findMany({ where: { storeId, enabled: true, isDemo: false }, select: { provider: true, syncedThrough: true } });
  const shopify = (["meta", "google"] as const).some((p) => !conns.some((c) => c.provider === p)) ? (await marketingRead(storeId))?.sync : null;
  // Never read from Shopify (or refused from the start): nothing of it to send or wait for.
  if (!conns.length && !shopify?.lastSyncedAt) return false;
  // Waited for only while its reads work: a refused or failing one would hold the summary to noon every day.
  const shopifyIn = !shopify?.lastSyncedAt || !!shopify.lastError || (!!shopify.syncedThrough && shopify.syncedThrough >= day);
  const allIn = shopifyIn && conns.every((c) => !!c.syncedThrough && c.syncedThrough >= day);
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

// ---------------------------------------------------------------------------
// Ad account synced
// ---------------------------------------------------------------------------

type SyncedConnection = { id: string; provider: string; accountId: string; accountName: string | null; lastSyncedAt: Date | null; syncedThrough: string | null };

/** "Ad account synced": which account, when, and the last of its days stored without a gap. No figures: those are the advertising triggers'. */
export function syncCompletedData(c: SyncedConnection, at: Date): Record<string, unknown> | null {
  const integration = integrationOfProvider(c.provider);
  if (!integration) return null;
  return {
    integration,
    integration_name: ZAPIER_INTEGRATIONS[integration],
    connection_id: c.id,
    account_id: c.accountId,
    account_name: c.accountName,
    synced_at: (c.lastSyncedAt ?? at).toISOString(),
    data_through: c.syncedThrough,
  };
}

/** One event per account and hour (UTC): accounts sync every few minutes, and a Zap needs to hear it once in a while, not every time. */
export const syncCompletedKey = (connectionId: string, at: Date) => `sync_completed:${connectionId}:${at.toISOString().slice(0, 13)}`;

/**
 * After an ad account's sync stored its figures (the worker's runAdsSync): its store's thresholds,
 * daily summary and "Ad account synced". Never throws: the sync itself worked, whatever Zapier's side
 * of it does.
 */
export async function zapierAfterAdSync(connectionId: string, deps: { queues: Pick<Queues, "sync"> }, now = new Date()): Promise<void> {
  try {
    const conn = await systemDb.adConnection.findUnique({
      where: { id: connectionId },
      select: { id: true, workspaceId: true, storeId: true, isDemo: true, provider: true, accountId: true, accountName: true, lastSyncedAt: true, syncedThrough: true },
    });
    if (!conn || conn.isDemo) return;
    await checkZapierThresholds(conn.storeId, deps.queues, now);
    await maybeSendAdsDailySummary(conn.storeId, deps.queues, now);
    const synced = syncCompletedData(conn, now);
    if (synced) {
      await recordZapierEvent({ workspaceId: conn.workspaceId, storeId: conn.storeId, event: "sync_completed", dedupeKey: syncCompletedKey(conn.id, now), data: synced, occurredAt: now }, deps.queues, now);
    }
  } catch (err) {
    logger.error({ err, connectionId }, "zapier checks after an ad sync failed");
  }
}

/**
 * After a read of the store's Shopify marketing report stored its days (the worker's
 * runShopifyMarketing): its thresholds and daily summary, which for a store with no ad account have
 * no ad sync to come after. Never throws, like zapierAfterAdSync.
 */
export async function zapierAfterMarketingRead(storeId: string, deps: { queues: Pick<Queues, "sync"> }, now = new Date()): Promise<void> {
  try {
    await checkZapierThresholds(storeId, deps.queues, now);
    await maybeSendAdsDailySummary(storeId, deps.queues, now);
  } catch (err) {
    logger.error({ err, storeId }, "zapier checks after a Shopify marketing read failed");
  }
}

/** A real sample for "Daily advertising summary" when none was sent yet: yesterday's figures as stored (null without any). */
export async function summarySample(storeId: string, who: Pick<AuthorizerAccess, "store">, now = new Date()) {
  const day = addDays(localDay(now, who.store.timezone), -1);
  const data = await adsDailySummaryData(storeId, day);
  return data ? { dedupeKey: `ads_daily_summary:${storeId}:${day}`, data } : null;
}
