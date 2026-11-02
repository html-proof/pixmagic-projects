// Without the ".js" the rest of the package uses: the web app imports this file directly
// (@app/shared/shopifyMarketing), and its bundler doesn't map "./dates.js" to dates.ts.
import type { AdSpendProvider } from "./ads";
import { eachDay, type DateRange } from "./dates";
import { delta } from "./kpi";

/**
 * Ad spend, impressions and clicks as the store's marketing apps report them to Shopify: Shopify's
 * `marketing_engagements` report (ShopifyQL, read with `read_reports`), which the Facebook & Instagram
 * app, the Google & YouTube app and other channel apps fill with their own figures for the campaigns
 * they run for the store. Nothing to connect beyond the store: the first place bizinsights looks for
 * Meta's and Google's spend, before a direct ad account connection (which, once connected, is the
 * platform's own report and replaces these for that platform, never added to them).
 *
 * Each figure is what the channel told Shopify, in the store's currency, by the day Shopify files it
 * under. A channel that reports clicks but no spend has no spend here ("Data unavailable"), never a 0;
 * a platform that has reported nothing to Shopify has no figures at all. Its orders and sales are the
 * channel's own claim (its attribution), not the store's orders (adsFromShopify.ts has those).
 */

/** The platform a Shopify marketing channel belongs to: Meta's, Google's, or another (TikTok, Pinterest, an email app...). */
export type MarketingPlatform = AdSpendProvider | "other";

/**
 * Which platform a channel is, by the channel Shopify names (`marketing_channel`: "Meta Ads",
 * "Google Ads", or the app's name for other activities) and the app that reported it
 * (`marketing_app_name`: "Facebook & Instagram", "Google & YouTube"). Words, not ids: Shopify
 * gives no platform id, and an app's id differs between stores' installs.
 */
export function marketingPlatform(channel: string | null | undefined, app?: string | null): MarketingPlatform {
  const words = `${channel ?? ""} ${app ?? ""}`;
  if (/\b(meta|facebook|instagram)\b/i.test(words)) return "meta";
  if (/\b(google|youtube)\b/i.test(words)) return "google";
  return "other";
}

/**
 * One stored row (shopify_marketing_days): a channel's figures for one store-local day as Shopify's
 * report gave them. `campaign` null: the channel's whole day (what totals add up); a name: that
 * campaign's part of it (marketing_campaign: the activity's title, or the links' utm_campaign), only
 * ever used for the campaign list, so a channel whose day isn't split into campaigns isn't counted twice.
 * A figure Shopify left empty is null.
 */
export interface MarketingRow {
  day: string;
  channel: string;
  app: string | null;
  campaign: string | null;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  orders: number | null;
  sales: number | null;
  newCustomers: number | null;
}

/** The figures a channel reported, added up, and the rates worked out from them (null where a part is missing or 0). */
export interface MarketingFigures {
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  /** The channel's own count of orders from its marketing, and their sales: its attribution, not the store's orders. */
  orders: number | null;
  sales: number | null;
  /** Of those orders, the customers' first (Shopify's first_time_customers). */
  newCustomers: number | null;
  /** Clicks ÷ impressions. */
  ctr: number | null;
  /** Spend ÷ clicks. */
  cpc: number | null;
  /** Spend per 1,000 impressions. */
  cpm: number | null;
  /** Sales ÷ spend, both as the channel reported them. */
  roas: number | null;
  /** Spend ÷ orders (cost per acquisition). */
  costPerOrder: number | null;
  /** Spend ÷ first-time customers (customer acquisition cost). */
  costPerNewCustomer: number | null;
}

/**
 * What Shopify has of a platform's spend for the dates. "reported": spend on at least one day.
 * "no_spend": the channel reported to Shopify (clicks, sales, or other dates) but no spend for these
 * dates. "unavailable": it has never reported anything bizinsights has read: no app of the platform
 * sends Shopify its figures, or none has been read yet.
 */
export type MarketingAvailability = "reported" | "no_spend" | "unavailable";

export interface MarketingDay {
  day: string;
  /** Null on a day not read from Shopify yet, and for a figure the channel didn't report. */
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  orders: number | null;
  sales: number | null;
}

export interface MarketingCampaign {
  campaign: string;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  orders: number | null;
  sales: number | null;
  roas: number | null;
}

/** One platform (Meta, Google), or one other channel, as Shopify has it for the dates. */
export interface MarketingGroup {
  platform: MarketingPlatform;
  /** "Meta Ads", "Google Ads", or the channel as Shopify names it. */
  name: string;
  /** The channels (marketing_channel) and apps (marketing_app_name) whose figures these are. */
  channels: string[];
  apps: string[];
  availability: MarketingAvailability;
  /** Null when unavailable. */
  totals: MarketingFigures | null;
  /** The dates compared with; null when not compared (`ShopifyMarketing.compared`). */
  previous: MarketingFigures | null;
  deltas: { spend: number | null; clicks: number | null; impressions: number | null; sales: number | null; roas: number | null };
  /** Every day of the dates. */
  daily: MarketingDay[];
  /** By campaign, the 10 that spent most (then sold most). */
  campaigns: MarketingCampaign[];
  /** The last day this platform reported anything to Shopify, of the days read. */
  lastDay: string | null;
}

/** Where the store's Shopify marketing figures stand (shopify_marketing_syncs). */
export interface MarketingSyncState {
  /** The last time the worker read the report, successfully. */
  lastSyncedAt: string | null;
  /** The earliest day read so far; null: nothing read yet. */
  coveredFrom: string | null;
  /** The last day read with no day missing since `coveredFrom`: later days aren't known yet. */
  syncedThrough: string | null;
  /** Every day back to the store's first has been read. */
  backfilled: boolean;
  /** Why the last read failed, when it did: no access to Shopify's reports, a report Shopify won't run for the store, or a failed call (tried again). */
  error: "access_denied" | "unsupported" | "failed" | null;
  lastAttemptAt: string | null;
}

/**
 * How a platform's spend for a stretch of days stands. "reported": its channel told Shopify some spend
 * on the days read. "no_spend": it reported to Shopify (other figures, or on other days) but no spend
 * on these. "unavailable": it has never reported anything bizinsights has read (not reported by
 * Shopify). "not_read": none of these days has been read from Shopify yet.
 */
export type MarketingSpendState = "reported" | "no_spend" | "unavailable" | "not_read";

export interface MarketingSpendFigure {
  /** Null unless "reported". */
  spend: number | null;
  state: MarketingSpendState;
}

/** Every channel's spend reported to Shopify for one stretch of days (today, this month so far). */
export interface MarketingSpendPeriod {
  from: string;
  to: string;
  /** The figures are of `from` to `through`, the days of it read so far; null: none of them yet. */
  through: string | null;
  meta: MarketingSpendFigure;
  google: MarketingSpendFigure;
  /** The other channels that reported spend in it (TikTok, Pinterest...), the biggest first. */
  others: Array<{ name: string; spend: number }>;
  /** Meta's, Google's and the others' reported spend added up; null when none reported any. */
  total: number | null;
}

export interface ShopifyMarketing {
  /** Where every figure here comes from, for the badge and the export. */
  source: "shopify_marketing";
  /** The store's: Shopify reports every channel's money in it. */
  currency: string;
  /** "ready": figures read; "syncing": the first read hasn't finished; an error: why there are none. */
  status: "ready" | "syncing" | "access_denied" | "unsupported" | "failed";
  sync: MarketingSyncState;
  /** Meta and Google, always both (each may be unavailable). */
  platforms: MarketingGroup[];
  /** Other channels that reported ad spend for the dates, the biggest first. */
  others: MarketingGroup[];
  /**
   * What every channel reported to Shopify as spend, together (Meta's, Google's, the others'); null
   * when none did. A platform whose own API is connected is in it too: never add it to that API's spend.
   */
  reportedSpend: number | null;
  /** The dates compared with; null: not compared (still running, or not read back that far). */
  compared: DateRange | null;
  /**
   * The days of the dates whose figures are read, `from` to `through`: the dates' own, or less while
   * earlier days are still being read (`sync.coveredFrom`) or the latest aren't read yet
   * (`sync.syncedThrough`). Every figure is of these days only; null both: none of them.
   */
  from: string | null;
  through: string | null;
  /**
   * Today and this calendar month so far (store-local days), whatever the dates: the spend tiles.
   * Null when the module was worked out without them.
   */
  current: { today: MarketingSpendPeriod; month: MarketingSpendPeriod } | null;
}

const r2 =(n: number) => Math.round(n * 100) / 100;
const ratio = (a: number | null, b: number | null, per = 1) => (a !== null && b !== null && b > 0 ? (a / b) * per : null);

type Measure = "spend" | "impressions" | "clicks" | "orders" | "sales" | "newCustomers";
const MEASURES: readonly Measure[] = ["spend", "impressions", "clicks", "orders", "sales", "newCustomers"];
const MONEY: ReadonlySet<Measure> = new Set(["spend", "sales"]);

/** Each measure added up over the rows; null where every row left it empty (or there are none). */
function sums(rows: readonly MarketingRow[]): Record<Measure, number | null> {
  const out = { spend: null, impressions: null, clicks: null, orders: null, sales: null, newCustomers: null } as Record<Measure, number | null>;
  for (const r of rows) {
    for (const m of MEASURES) {
      const v = r[m];
      if (v === null) continue;
      const total = (out[m] ?? 0) + v;
      out[m] = MONEY.has(m) ? r2(total) : total;
    }
  }
  return out;
}

/**
 * A total of 0 as not reported: Shopify's report gives 0, not empty, for a figure the channel never
 * sent (seen on a dev store, 2026-11-02: spend and clicks sent, orders "0.0" and sales "0" back).
 */
const told = (v: number | null) => (v === 0 ? null : v);

/**
 * The rows' figures and rates. Spend counts only when it is more than 0: a channel reporting 0 spend
 * beside its clicks hasn't told Shopify what it spent (free posts, an app without spend reporting).
 * Every other figure adding up to 0 is taken as not reported too (`told`): Shopify can't tell a 0 the
 * channel sent from one it never sent. The rates set against spend are worked out from the rows that
 * reported some, their clicks, impressions, orders and sales with it: another activity's sales or
 * clicks, with no spend told, would make the spend look better than it did.
 */
export function marketingFigures(rows: readonly MarketingRow[]): MarketingFigures {
  const all = sums(rows);
  const s = { ...all, impressions: told(all.impressions), clicks: told(all.clicks), orders: told(all.orders), sales: told(all.sales), newCustomers: told(all.newCustomers) };
  const paid = sums(rows.filter((r) => r.spend !== null && r.spend > 0));
  const spend = paid.spend;
  return {
    ...s,
    spend,
    ctr: ratio(s.clicks, s.impressions),
    cpc: ratio(spend, paid.clicks),
    cpm: ratio(spend, paid.impressions, 1000),
    roas: spend !== null && told(paid.sales) !== null ? paid.sales! / spend : null,
    costPerOrder: ratio(spend, paid.orders),
    costPerNewCustomer: ratio(spend, paid.newCustomers),
  };
}

const PLATFORM_NAME: Record<AdSpendProvider, string> = { meta: "Meta Ads", google: "Google Ads" };
const uniq = (xs: Array<string | null>) => [...new Set(xs.filter((x): x is string => !!x))].sort();
const spent = (rows: readonly MarketingRow[]) => rows.some((r) => r.spend !== null && r.spend > 0);

function group(input: {
  platform: MarketingPlatform;
  name: string;
  rows: readonly MarketingRow[];
  previousRows: readonly MarketingRow[] | null;
  /** Every day this platform's channels reported anything, of the days read (for `lastDay` and availability). */
  lastDay: string | null;
  range: DateRange;
  from: string | null;
  through: string | null;
}): MarketingGroup {
  const { rows, previousRows, range, from, through } = input;
  const day = rows.filter((r) => r.campaign === null);
  const availability: MarketingAvailability = spent(day) ? "reported" : input.lastDay ? "no_spend" : "unavailable";
  const totals = availability === "unavailable" ? null : marketingFigures(day);
  const previous = previousRows && availability !== "unavailable" ? marketingFigures(previousRows.filter((r) => r.campaign === null)) : null;
  const byDay = new Map<string, MarketingRow[]>();
  for (const r of day) byDay.set(r.day, [...(byDay.get(r.day) ?? []), r]);
  const campaigns = new Map<string, MarketingRow[]>();
  for (const r of rows) if (r.campaign !== null) campaigns.set(r.campaign, [...(campaigns.get(r.campaign) ?? []), r]);
  return {
    platform: input.platform,
    name: input.name,
    channels: uniq(rows.map((r) => r.channel)),
    apps: uniq(rows.map((r) => r.app)),
    availability,
    totals,
    previous,
    deltas: {
      spend: previous ? delta(totals?.spend ?? null, previous.spend) : null,
      clicks: previous ? delta(totals?.clicks ?? null, previous.clicks) : null,
      impressions: previous ? delta(totals?.impressions ?? null, previous.impressions) : null,
      sales: previous ? delta(totals?.sales ?? null, previous.sales) : null,
      roas: previous ? delta(totals?.roas ?? null, previous.roas) : null,
    },
    daily: eachDay(range.from, range.to).map((d) => {
      // A day not read yet, or a platform that reports nothing: unknown. A read day it reported nothing
      // on: 0. A figure it left empty that day stays unknown.
      if (availability === "unavailable" || !from || !through || d < from || d > through) return { day: d, spend: null, impressions: null, clicks: null, orders: null, sales: null };
      const s = sums(byDay.get(d) ?? []);
      const quiet = !byDay.has(d);
      const of = (m: Measure) => (quiet ? 0 : s[m]);
      return { day: d, spend: availability === "reported" ? of("spend") : null, impressions: of("impressions"), clicks: of("clicks"), orders: of("orders"), sales: of("sales") };
    }),
    campaigns: [...campaigns.entries()]
      .map(([campaign, rs]) => {
        const f = marketingFigures(rs);
        return { campaign, spend: f.spend, impressions: f.impressions, clicks: f.clicks, orders: f.orders, sales: f.sales, roas: f.roas };
      })
      .sort((a, b) => (b.spend ?? 0) - (a.spend ?? 0) || (b.sales ?? 0) - (a.sales ?? 0) || a.campaign.localeCompare(b.campaign))
      .slice(0, 10),
    lastDay: input.lastDay,
  };
}

type LastDays = ReadonlyArray<{ channel: string; app: string | null; day: string }>;

/** The days of `range` read from Shopify with none missing (`sync`), as [from, through]; nulls: none of them. */
function readSpan(range: DateRange, sync: MarketingSyncState): [string, string] | [null, null] {
  const start = sync.coveredFrom && sync.coveredFrom <= range.to ? (sync.coveredFrom > range.from ? sync.coveredFrom : range.from) : null;
  const end = sync.syncedThrough && sync.syncedThrough >= range.from ? (sync.syncedThrough < range.to ? sync.syncedThrough : range.to) : null;
  return start && end && start <= end ? [start, end] : [null, null];
}

const platformOf = (r: { channel: string; app: string | null }) => marketingPlatform(r.channel, r.app);

/** The last day any of the channels `pick` keeps reported anything, of every day read. */
const lastOfDays = (lastDays: LastDays, pick: (x: { channel: string; app: string | null }) => boolean) =>
  lastDays.filter(pick).reduce<string | null>((last, x) => (last === null || x.day > last ? x.day : last), null);

/**
 * Every channel's spend reported to Shopify for one stretch of days (`period`): Meta's and Google's
 * each with how it stands, the other channels', and all of it together. Only the days read count
 * (`through`), and only spend above 0, as everywhere here; a platform with none is never a 0.
 */
export function marketingSpendPeriod(input: { rows: readonly MarketingRow[]; lastDays: LastDays; period: DateRange; sync: MarketingSyncState }): MarketingSpendPeriod {
  const { period } = input;
  const [from, through] = readSpan(period, input.sync);
  const rows = from && through ? input.rows.filter((r) => r.campaign === null && r.day >= from && r.day <= through && r.spend !== null && r.spend > 0) : [];
  const spendOf = (rs: readonly MarketingRow[]) => r2(rs.reduce((n, r) => n + r.spend!, 0));
  const figure = (p: AdSpendProvider): MarketingSpendFigure => {
    const mine = rows.filter((r) => platformOf(r) === p);
    if (mine.length) return { spend: spendOf(mine), state: "reported" };
    if (!through) return { spend: null, state: "not_read" };
    return { spend: null, state: lastOfDays(input.lastDays, (x) => platformOf(x) === p) ? "no_spend" : "unavailable" };
  };
  const meta = figure("meta");
  const google = figure("google");
  const others = uniq(rows.filter((r) => platformOf(r) === "other").map((r) => r.channel))
    .map((name) => ({ name, spend: spendOf(rows.filter((r) => platformOf(r) === "other" && r.channel === name)) }))
    .sort((a, b) => b.spend - a.spend || a.name.localeCompare(b.name));
  const spends = [meta.spend, google.spend, ...others.map((o) => o.spend)].filter((s): s is number => s !== null);
  return { from: period.from, to: period.to, through, meta, google, others, total: spends.length ? r2(spends.reduce((a, b) => a + b, 0)) : null };
}

/**
 * The Shopify marketing module for the dates: Meta's and Google's figures as their apps report them
 * to Shopify, the other channels that reported spend, and where the reading stands. `rows`: the
 * stored rows of the dates; `previousRows`: those of the dates compared with, or null when they aren't
 * (the dates still running, or not read back that far); `lastDays`: the last day each channel
 * reported anything, of every day read (a channel quiet in these dates isn't "unavailable");
 * `current`: the store's today and the rows of its month so far, for today's and this month's spend.
 */
export function shopifyMarketing(input: {
  rows: readonly MarketingRow[];
  previousRows: readonly MarketingRow[] | null;
  lastDays: LastDays;
  range: DateRange;
  compared: DateRange | null;
  currency: string;
  sync: MarketingSyncState;
  current?: { today: string; rows: readonly MarketingRow[] };
}): ShopifyMarketing {
  const { previousRows, range, sync, current } = input;
  const [from, through] = readSpan(range, sync);
  // Only the days read: a day after a gap, read on its own, waits for the days before it.
  const rows = from && through ? input.rows.filter((r) => r.day >= from && r.day <= through) : [];
  const lastOf = (pick: (x: { channel: string; app: string | null }) => boolean) => lastOfDays(input.lastDays, pick);
  const platforms = (["meta", "google"] as const).map((p) =>
    group({
      platform: p,
      name: PLATFORM_NAME[p],
      rows: rows.filter((r) => platformOf(r) === p),
      previousRows: previousRows?.filter((r) => platformOf(r) === p) ?? null,
      lastDay: lastOf((x) => platformOf(x) === p),
      range,
      from,
      through,
    }),
  );
  // Other channels, each on its own, only when they reported spend in these dates: an email app's
  // sends and clicks aren't advertising.
  const otherChannels = uniq(rows.filter((r) => platformOf(r) === "other" && r.campaign === null && r.spend !== null && r.spend > 0).map((r) => r.channel));
  const others = otherChannels
    .map((channel) =>
      group({
        platform: "other",
        name: channel,
        rows: rows.filter((r) => platformOf(r) === "other" && r.channel === channel),
        previousRows: previousRows?.filter((r) => platformOf(r) === "other" && r.channel === channel) ?? null,
        lastDay: lastOf((x) => platformOf(x) === "other" && x.channel === channel),
        range,
        from,
        through,
      }),
    )
    .sort((a, b) => (b.totals?.spend ?? 0) - (a.totals?.spend ?? 0) || a.name.localeCompare(b.name));
  const spends = [...platforms, ...others].map((g) => g.totals?.spend ?? null).filter((s): s is number => s !== null);
  const status: ShopifyMarketing["status"] = sync.lastSyncedAt ? "ready" : sync.error ?? "syncing";
  return {
    source: "shopify_marketing",
    currency: input.currency,
    status,
    sync,
    platforms,
    others,
    reportedSpend: spends.length ? r2(spends.reduce((a, b) => a + b, 0)) : null,
    compared: previousRows ? input.compared : null,
    from,
    through,
    current: current
      ? {
          today: marketingSpendPeriod({ rows: current.rows, lastDays: input.lastDays, period: { from: current.today, to: current.today }, sync }),
          month: marketingSpendPeriod({ rows: current.rows, lastDays: input.lastDays, period: { from: `${current.today.slice(0, 7)}-01`, to: current.today }, sync }),
        }
      : null,
  };
}

/** Whether Shopify has a platform's ad spend for the dates: its apps reported some. */
export const marketingReports = (m: ShopifyMarketing | null | undefined, p: AdSpendProvider): boolean =>
  m?.platforms.find((g) => g.platform === p)?.availability === "reported";

/** The module without its campaigns (Team & Access "View campaigns", redactOverview in access.ts). */
export function shopifyMarketingWithoutCampaigns(m: ShopifyMarketing): ShopifyMarketing {
  const strip = (g: MarketingGroup): MarketingGroup => ({ ...g, campaigns: [] });
  return { ...m, platforms: m.platforms.map(strip), others: m.others.map(strip) };
}
