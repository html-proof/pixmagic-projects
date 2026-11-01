import { isClosedAdAccount, trafficSourcePlatform, type AdSpendProvider } from "./ads";
import { eachDay, type Comparison, type DateRange } from "./dates";
import { FUNNEL_STEPS, PURCHASED_STEP } from "./journey";
import { delta } from "./kpi";
import { TRAFFIC_LABEL, type TrafficSource } from "./traffic";

/**
 * Meta Ads and Google Ads as the store's own orders record them: the Advertising pages' figures for a
 * platform with no ad account connected, read from what Shopify already sends bizinsights (read_orders,
 * nothing to connect). Each order's last visit before it (packages/shared/src/traffic.ts) came from
 * Facebook or Instagram (Meta's) or from Google or YouTube (Google Ads'), through a link tagged as an
 * ad ("paid") or not (a post, a search result, an ad whose links carry no tags).
 *
 * This is the store's view of a sale, the last click before it: never what Meta or Google would credit
 * to their ads, and nothing of what was spent, shown or clicked, which only the platform knows. The
 * sales are net sales (after discounts and returns, before tax and shipping) in the store's currency.
 */

/** The visit sources each spend platform's ads, posts and search results send shoppers from. */
export const PLATFORM_SOURCES: Record<AdSpendProvider, readonly TrafficSource[]> = {
  meta: ["facebook", "instagram"],
  google: ["google", "youtube"],
};

/** The orders read for some dates, grouped by their visit's source and medium (and the link's utm_campaign); null source: not read yet. */
export interface SourcedSales {
  source: string | null;
  medium: string | null;
  campaign?: string | null;
  /** Orders placed in the dates. */
  orders: number;
  /** Their net sales from the sales in the dates (and returns in them of orders placed before). */
  sales: number;
}

/** The same for one day: the orders placed that day, the sales that happened that day. */
export interface SourcedDay extends SourcedSales {
  day: string;
}

/** Orders and their net sales; `paid…`: of them, the ones whose visit came through a link tagged as an ad. */
export interface ShopifyAdFigures {
  orders: number;
  sales: number;
  /** Team & Access "View conversion attribution", like the traffic module's tagged-ad figures. */
  paidOrders?: number;
  paidSales?: number;
}

export interface ShopifyAdPlatform extends ShopifyAdFigures {
  provider: AdSpendProvider;
  /** Of the store's net sales over the dates; null when those are none. */
  share: number | null;
  /** Each of the platform's sources (Facebook and Instagram; Google and YouTube), always both. */
  sources: Array<ShopifyAdFigures & { source: TrafficSource; label: string }>;
  /** By the campaign named in the links (utm_campaign), the 10 that sold most. Attribution. */
  campaigns?: Array<{ source: TrafficSource; label: string; campaign: string; orders: number; sales: number; paidSales: number }>;
  /** Every day of the dates; null on a day before the store's imported orders start (unknown, never 0). */
  daily: Array<{ day: string; orders: number | null; sales: number | null; paidSales?: number | null }>;
  /**
   * Visits to the storefront that arrived from the platform's sites, as the storefront pixel recorded
   * them (funnel_visits), counted from `AdsFromShopify.visitsFrom`; null: it recorded none of the dates'
   * days. Absent without the pixel, or without "View conversion rates" (the funnel's visits).
   */
  visits?: number | null;
  /**
   * Those visits by how far they went in the store, each counted once at its furthest step (`AdJourney`);
   * null with `visits`. Absent with `visits`, and from answers that predate it.
   */
  journey?: AdJourney | null;
  /** The dates compared with; null when they weren't (`AdsFromShopify.compared`). */
  previous: ShopifyAdFigures | null;
  deltas: { orders: number | null; sales: number | null; paidSales?: number | null };
}

export interface AdsFromShopify {
  /** The store's: every figure here is Shopify's, in it. */
  currency: string;
  platforms: ShopifyAdPlatform[];
  /** The store's net sales over the dates, every source together: the whole the shares are of. */
  storeSales: number;
  /** Orders in the dates whose visit hasn't been read from Shopify yet: counted in no platform, never guessed. */
  pending: number;
  /** The dates compared with (to the same time of day while the dates are running); null: not compared, their orders aren't imported. */
  compared: Comparison | null;
  /** The first day of the store's imported orders. */
  historyFrom: string | null;
  /**
   * The day the platforms' `visits` count from: the dates' first, or the later day the storefront pixel
   * began to record where visits came from. Null: none of the dates' days. Absent with `visits`.
   */
  visitsFrom?: string | null;
}

/**
 * Storefront visits by where they came from (funnel_visits.source), and the first day any visit's source
 * was recorded. `furthestStep`: how far those visits went (FUNNEL_STEPS); rows without it count as visits only.
 */
export interface SourcedVisits {
  from: string | null;
  rows: ReadonlyArray<{ source: string; visits: number; furthestStep?: number }>;
}

/**
 * The storefront visits from a platform's sites that reached each step of the Shopping Funnel or a later
 * one: the same visits throughout, so each step is a share of the one before. Visits, not orders: a visit
 * that bought counts once however many orders it placed, and an order whose visit the pixel didn't see
 * isn't here.
 */
export interface AdJourney {
  visits: number;
  viewedProduct: number;
  addedToCart: number;
  startedCheckout: number;
  purchased: number;
}

/** Visits by furthest step → the visits that reached each step or a later one. */
export function adJourney(rows: ReadonlyArray<{ visits: number; furthestStep?: number }>): AdJourney {
  const at = FUNNEL_STEPS.map(() => 0);
  for (const r of rows) at[Math.min(Math.max(r.furthestStep ?? 0, 0), PURCHASED_STEP)]! += r.visits;
  const reached = (k: number) => at.slice(k).reduce((a, b) => a + b, 0);
  return { visits: reached(0), viewedProduct: reached(1), addedToCart: reached(2), startedCheckout: reached(3), purchased: reached(4) };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function figuresOf(rows: readonly SourcedSales[]): Required<ShopifyAdFigures> {
  const f = { orders: 0, sales: 0, paidOrders: 0, paidSales: 0 };
  for (const x of rows) {
    f.orders += x.orders;
    f.sales = r2(f.sales + x.sales);
    if (x.medium === "paid") {
      f.paidOrders += x.orders;
      f.paidSales = r2(f.paidSales + x.sales);
    }
  }
  return f;
}

const ofPlatform = (p: AdSpendProvider) => (x: SourcedSales) => trafficSourcePlatform(x.source) === p;

/**
 * Each platform's figures (`providers`, in that order) from the store's orders for the dates (`rows`,
 * every source, the unread ones too), day by day (`days`, the platforms' sources), and for the dates
 * compared with (`previousRows`; null when not compared).
 */
export function adsFromShopify(input: {
  providers: readonly AdSpendProvider[];
  rows: readonly SourcedSales[];
  days: readonly SourcedDay[];
  previousRows: readonly SourcedSales[] | null;
  range: DateRange;
  compared: Comparison | null;
  currency: string;
  historyFrom: string | null;
  /** The storefront pixel's visits over the dates (from `visitsCounted`'s day); absent without the pixel. */
  visits?: SourcedVisits | null;
}): AdsFromShopify {
  const { rows, days, previousRows, range, historyFrom } = input;
  const visitsFrom = input.visits ? visitsCounted(input.visits.from, range) : undefined;
  const storeSales = r2(rows.reduce((a, x) => a + x.sales, 0));
  const pending = rows.filter((x) => !x.source).reduce((a, x) => a + x.orders, 0);
  const platforms = input.providers.map((provider): ShopifyAdPlatform => {
    const mine = rows.filter(ofPlatform(provider));
    const total = figuresOf(mine);
    const campaigns = new Map<string, { source: TrafficSource; label: string; campaign: string; orders: number; sales: number; paidSales: number }>();
    for (const x of mine) {
      if (!x.campaign) continue;
      const source = x.source as TrafficSource;
      const key = `${source}\u0000${x.campaign}`;
      const c = campaigns.get(key) ?? { source, label: TRAFFIC_LABEL[source], campaign: x.campaign, orders: 0, sales: 0, paidSales: 0 };
      c.orders += x.orders;
      c.sales = r2(c.sales + x.sales);
      if (x.medium === "paid") c.paidSales = r2(c.paidSales + x.sales);
      campaigns.set(key, c);
    }
    const byDay = new Map<string, SourcedDay[]>();
    for (const x of days.filter(ofPlatform(provider))) byDay.set(x.day, [...(byDay.get(x.day) ?? []), x]);
    const before = previousRows ? figuresOf(previousRows.filter(ofPlatform(provider))) : null;
    return {
      provider,
      ...total,
      share: storeSales > 0 ? total.sales / storeSales : null,
      sources: PLATFORM_SOURCES[provider].map((source) => ({ source, label: TRAFFIC_LABEL[source], ...figuresOf(mine.filter((x) => x.source === source)) })),
      campaigns: [...campaigns.values()].sort((a, b) => b.sales - a.sales || b.orders - a.orders || a.campaign.localeCompare(b.campaign)).slice(0, 10),
      daily: eachDay(range.from, range.to).map((day) => {
        if (historyFrom === null || day < historyFrom) return { day, orders: null, sales: null, paidSales: null };
        const f = figuresOf(byDay.get(day) ?? []);
        return { day, orders: f.orders, sales: f.sales, paidSales: f.paidSales };
      }),
      previous: before,
      deltas: {
        orders: before ? delta(total.orders, before.orders) : null,
        sales: before ? delta(total.sales, before.sales) : null,
        paidSales: before ? delta(total.paidSales, before.paidSales) : null,
      },
      ...(input.visits ? visitsOf(input.visits.rows.filter((x) => trafficSourcePlatform(x.source) === provider), !!visitsFrom) : {}),
    };
  });
  return { currency: input.currency, platforms, storeSales, pending, compared: previousRows ? input.compared : null, historyFrom, ...(input.visits ? { visitsFrom } : {}) };
}

/** A platform's visits and how far they went; null both while none of the dates' days is counted. */
function visitsOf(rows: SourcedVisits["rows"], counted: boolean): Pick<ShopifyAdPlatform, "visits" | "journey"> {
  if (!counted) return { visits: null, journey: null };
  const journey = adJourney(rows);
  return { visits: journey.visits, journey };
}

/**
 * The first day of `range` whose visits are counted: its first, or the later day the pixel began to
 * record where visits came from (`from`); null when that is after the dates, or it never has.
 */
export function visitsCounted(from: string | null, range: DateRange): string | null {
  if (!from || from > range.to) return null;
  return from > range.from ? from : range.from;
}

/** The module without the storefront's visits (the funnel's, "View conversion rates"). */
export function adsFromShopifyWithoutVisits(m: AdsFromShopify): AdsFromShopify {
  const { visitsFrom: _from, ...rest } = m;
  return { ...rest, platforms: m.platforms.map(({ visits: _visits, journey: _journey, ...p }) => p) };
}

const PAID = ["paidOrders", "paidSales"] as const;
const withoutPaid = <T extends object>(o: T): T => {
  const out = { ...o };
  for (const k of PAID) delete (out as Record<string, unknown>)[k];
  return out;
};

/**
 * The module without what Team & Access "View conversion attribution" shows (redactOverview in
 * access.ts): the tagged-ad figures and the campaigns, as the traffic module's.
 */
export function adsFromShopifyWithoutAttribution(m: AdsFromShopify): AdsFromShopify {
  return {
    ...m,
    platforms: m.platforms.map((p) => {
      const { campaigns: _campaigns, ...rest } = withoutPaid(p);
      return {
        ...rest,
        sources: p.sources.map(withoutPaid),
        daily: p.daily.map(({ paidSales: _paid, ...d }) => d),
        previous: p.previous && withoutPaid(p.previous),
        deltas: { orders: p.deltas.orders, sales: p.deltas.sales },
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Where each spend platform's figures come from, Meta and Google each on its own: the platform's own
// API (its connected ad accounts' stored days) first, the store's Shopify orders above otherwise, and
// nothing rather than a made-up figure. Decided on every read, so connecting a platform replaces its
// Shopify figures with its own at once, a connection whose access ends falls back to the orders, and
// reconnecting brings the platform's own back, with nothing for the merchant to switch.
// ---------------------------------------------------------------------------

/** Where a spend platform's figures come from: its own API, the store's Shopify orders, or nowhere. */
export type AdDataSource = "platform" | "shopify" | "none";

/**
 * The platform's connection to the store. "connected": an account shown on the store that still syncs
 * (or a retry may fix; or closed, whose spend is a real 0). "access_lost": every account shown needs
 * someone to act (reconnect, a login with access) or the platform won't report on it. "waiting": a
 * sign-in connected with no ad account yet. "hidden": accounts connected, every one hidden from the
 * store. "not_connected": none of these.
 */
export type AdConnectionState = "connected" | "access_lost" | "waiting" | "hidden" | "not_connected";

export interface AdPlatformSource {
  provider: AdSpendProvider;
  source: AdDataSource;
  state: AdConnectionState;
}

/** What decides one platform's source. */
export interface AdSourceFacts {
  /** Its accounts shown on the store (enabled), as ad_connections hold them. */
  accounts: ReadonlyArray<{ status: string; errorCode: string | null; accountStatus: string | null }>;
  /** Its own figures cover the dates: their totals, or up to the last day stored while the rest is still to come. */
  figures: boolean;
  /** Its accounts connected but hidden from the store. */
  hidden: number;
  /** A sign-in of it is connected with no ad account yet. */
  waiting: boolean;
}

/** Statuses (AD_CONNECTION_STATUSES) a sync can't get out of by itself: someone has to reconnect, or the platform won't report. */
const NEEDS_SOMEONE: ReadonlySet<string> = new Set(["reconnect", "permission", "unavailable"]);
const accessLost = (a: AdSourceFacts["accounts"][number]) => NEEDS_SOMEONE.has(a.status) && !isClosedAdAccount(a);

/**
 * Each spend platform's source. Its own figures whenever its accounts still sync, or have stored the
 * dates even from an account whose access has ended since (what the platform reported then stays
 * true); otherwise the store's orders, when `attribution` (the store's traffic sources are read, and
 * the member may see them); otherwise none. A platform whose access ended and with no orders to show
 * keeps its own view, which says what to reconnect.
 */
export function adPlatformSources(facts: Record<AdSpendProvider, AdSourceFacts>, attribution: boolean): AdPlatformSource[] {
  return (["meta", "google"] as const).map((provider) => {
    const f = facts[provider];
    const state: AdConnectionState = f.accounts.length ? (f.accounts.every(accessLost) ? "access_lost" : "connected") : f.waiting ? "waiting" : f.hidden > 0 ? "hidden" : "not_connected";
    const own = state === "connected" || (state === "access_lost" && (f.figures || !attribution));
    return { provider, state, source: own ? "platform" : attribution ? "shopify" : "none" };
  });
}
