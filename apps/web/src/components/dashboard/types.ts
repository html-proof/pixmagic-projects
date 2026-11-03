/** Response of GET /workspaces/:ws/stores/:storeId/overview (built by packages/core/src/reports/overview.ts, served by apps/api/src/routes/dashboard.ts). */
import type { AdCoverage, AdProvider, AdSeriesDay, AdsenseReportLevel, AdsenseReportTotals, AdsenseSeriesDay, AdsenseTotals, AdSpendProvider, AdsVsSales, AdTotals, CampaignStatusGroup } from "@app/shared/ads";
import type { AdPlatformSource, AdsFromShopify } from "@app/shared/adsFromShopify";
import type { HistoryAccess } from "@app/shared/capabilities";
import type { CompareMode } from "@app/shared/dates";
import type { CustomCategory, ExpenseTotals } from "@app/shared/expenses";
import type { ProfitCost } from "@app/shared/profit";
import type { FunnelFilter, FunnelInsight, FunnelTransition, SegmentFunnel } from "@app/shared/funnel";
import type { JourneyPageRow, JourneySummary } from "@app/shared/journey";
import type { OrderOutcomes } from "@app/shared/orders";
import type { MonthLine, SalesDay, SalesMonth, YearBreakdown } from "@app/shared/sales";
import type { SalesCalculation } from "@app/shared/salesCalculation";
import type { ShopifyMarketing } from "@app/shared/shopifyMarketing";
import type { TrafficSplit } from "@app/shared/traffic";

/**
 * A month of `SalesOverview.year`: its lines of total sales (`MONTH_LINES`) and its refunds only for
 * a member who may see them (Team & Access: "View gross sales, discounts, tax and shipping", "View refunds").
 */
export type YearMonth = Omit<SalesMonth, MonthLine | "refunds"> & Partial<Pick<SalesMonth, MonthLine | "refunds">>;
/** A calendar year month by month, as `SalesOverview.year` carries it. */
export type YearOf = Omit<YearBreakdown, "months"> & { months: YearMonth[] };

export interface Capability {
  id: string;
  title: string;
  description: string;
  /** "inventory": the Inventory pages' own access, offered there rather than among the dashboard's locked modules. */
  area?: "dashboard" | "inventory";
  enabled: boolean;
  missingScopes: string[];
  /** Subsets of missingScopes: askable now, vs fixed by reconnecting (see @app/shared). */
  requestableScopes: string[];
  reconnectableScopes: string[];
  missingRequirements: string[];
}

export interface OverviewStore {
  id: string;
  shopDomain: string;
  name: string | null;
  currency: string;
  timezone: string;
  status: string;
  grantedScopes: string[];
  pixelInstalled: boolean;
  lastSyncedAt: string | null;
  installedAt?: string | null;
  /** When Shopify created the store; null until its details are read. */
  shopCreatedAt?: string | null;
}

/**
 * Shopify's own sales figures, from its sales records (docs/kpis.md). Fields marked "Team & Access"
 * are left out for a member without the permission they need (`redactOverview` in
 * @app/shared/access): the page shows what's there and says nothing of the rest.
 */
export interface SalesOverview {
  current: {
    /** Team & Access: "View gross sales, discounts, tax and shipping" (also discounts, tax, shipping, totalSales). */
    grossSales?: number;
    discounts?: number;
    /** What refunds, cancellations and edits took back (Shopify's "returns"). Team & Access: "View refunds". */
    returns?: number;
    /** Gross − discounts − returns. */
    netSales: number;
    /** Net sales + additional fees + duties + shipping + taxes: Shopify's headline "Total sales". */
    totalSales?: number;
    /**
     * What refunds, returns and cancellations took off that total sales, tax and shipping in.
     * Team & Access: both "View refunds" and the breakdown; absent from answers of older releases.
     */
    totalRefunded?: number;
    orders: number;
    units: number;
    averageOrderValue: number | null;
    tax?: number;
    shipping?: number;
    /** Import duties, before tax. Team & Access as grossSales; absent from answers of older releases. */
    duties?: number;
    /** Shopify's fees and additional fees, before tax. As duties. */
    additionalFees?: number;
  };
  /**
   * The same figures for the dates compared with (`Overview.previous`); null when the imported
   * orders don't reach back to them (`previous.imported` false), and every delta is then null too.
   */
  previous: {
    grossSales?: number;
    netSales: number;
    totalSales?: number;
    /** The lines of total sales, as in `current` (Team & Access as grossSales). */
    tax?: number;
    shipping?: number;
    duties?: number;
    additionalFees?: number;
    orders: number;
    units: number;
    averageOrderValue: number | null;
  } | null;
  deltas: {
    netSales: number | null;
    totalSales?: number | null;
    orders: number | null;
    averageOrderValue: number | null;
    grossSales?: number | null;
    units: number | null;
  };
  /**
   * Every day of the range, quiet days as zero. Each day's `refunds`: Team & Access "View refunds";
   * its `totalSales`: "View gross sales, discounts, tax and shipping"; its `newCustomerOrders` (orders
   * that were a customer's first): "View returning vs new customers". `units`: net items sold that day;
   * `orderValue`: what its orders sold for, which average order value divides (both absent from
   * older answers).
   */
  series: Array<
    Omit<SalesDay, "refunds" | "totalSales"> & {
      /** Items at full price and their discounts: with refunds, net sales (the breakdown permission's, absent from older answers). */
      grossSales?: number;
      discounts?: number;
      refunds?: number;
      totalSales?: number;
      shipping?: number;
      tax?: number;
      duties?: number;
      additionalFees?: number;
      units?: number;
      orderValue?: number;
      newCustomerOrders?: number;
    }
  >;
  /**
   * This calendar year by month, whatever the range. Team & Access: "View financial reports"; each
   * month's lines of total sales as `totalSales`.
   */
  year?: YearOf & {
    /**
     * The same months of the two years before (last year first), each whole (`pastYearBreakdown`):
     * the overview's monthly comparison. Redacted as this year's months; absent from older answers.
     */
    past?: YearOf[];
  };
  /**
   * The store's own calculation from the lines of total sales (Custom sales): which it counts and
   * whether the dashboard shows it. Team & Access: as grossSales (its figures are drawn from them).
   */
  calculation?: SalesCalculation;
}

/**
 * One connected ad account as the ads modules list it (accountView in packages/core/src/reports/ads.ts):
 * its state, its time zone, and the days its stored figures cover.
 */
export interface AdAccount<P extends AdProvider = AdProvider> {
  id: string;
  provider: P;
  accountId: string;
  name: string | null;
  currency: string | null;
  /** AD_CONNECTION_STATUSES: active, reconnect, permission, unavailable, error. */
  status: string;
  /** Why it isn't active (AD_ERROR_CODES); null when it is, or unknown. */
  errorCode?: string | null;
  /** The account's own health at the platform (AD_ACCOUNT_STATUSES); null until read. */
  accountStatus?: string | null;
  /** The last sync that worked: what its figures are as of. */
  lastSyncedAt: string | null;
  /** A sync someone asked for (Refresh, Sync all now, turning it back on) that hasn't finished yet (syncRunning in lib/adConnections). Absent from older answers. */
  syncRequestedAt?: string | null;
  /** When the last sync started, whatever came of it. Absent from older answers. */
  lastSyncAttemptAt?: string | null;
  /** Added up: in the currency the module is in. */
  counted: boolean;
  /** The Google Ads demo: simulated figures, shown as such and never set against the store's sales. Absent from older answers. */
  demo?: boolean;
  timezone?: string | null;
  /** Its days follow another time zone than the store's. */
  otherTimeZone?: boolean;
  /** The account's own today (YYYY-MM-DD). */
  today?: string;
  /** The days its stored figures cover (its own days); nulls: nothing stored yet. */
  coverage?: AdCoverage;
  /** Whether those days include every day of the range. */
  coversRange?: boolean;
  /** AdSense: the sites chosen as the store's (empty: every site). */
  sites?: string[];
  /** AdSense, sites chosen: the last day read whose earnings AdSense didn't split by site (the store's share of them isn't known). */
  unsplitThrough?: string | null;
  /** AdSense: its figures are final, not AdSense's estimate, up to this day; null: none is yet. Absent from older answers. */
  finalThrough?: string | null;
}

/** Why a change isn't given: only running days picked, a comparison before the figures start, or days missing on either side. */
export type NotCompared = "running" | "no_history" | "incomplete";

export interface FiguresWindow<T> {
  from: string;
  to: string;
  totals: T;
}

/**
 * Figures that exist only for days every account they add up has stored. `current` is null when
 * one of them lacks a day of the range ("Unavailable"), and `partial` then gives the days they all
 * have; `soFar` is that same part when the only days it lacks are at the end and not over yet (shown
 * as the figure, "through" its last day); `compared` is what each side of the change is worked out
 * on (whole days only: while the dates include today, both sides stop at the last day that is
 * over), null with `notCompared` why.
 */
export interface AdFigures<T> {
  coverage: AdCoverage & { complete: boolean };
  current: T | null;
  partial: FiguresWindow<T> | null;
  /** Absent from answers that predate it. */
  soFar?: FiguresWindow<T> | null;
  compared: { current: FiguresWindow<T>; previous: FiguresWindow<T>; trimmed: number } | null;
  notCompared: NotCompared | null;
  /** The first day every account has figures from (each brings the 90 days before it was connected). */
  historyFrom: string | null;
  /** When the least recently updated account last synced; null while one never has. */
  updatedAt: string | null;
}

export interface AdsComparison {
  /** The dates the "before" figures are from (the compared side); null when nothing is compared. */
  from: string | null;
  to: string | null;
  spend: number | null;
  linkClicks: number | null;
  conversions: number | null;
  conversionValue: number | null;
  purchases: number | null;
  purchaseValue: number | null;
  roas: number | null;
  /** False when the comparison starts before `historyFrom`: "No earlier data". */
  imported: boolean;
}
export interface AdsDeltas {
  spend: number | null;
  linkClicks: number | null;
  conversions: number | null;
  purchases: number | null;
  purchaseValue: number | null;
  roas: number | null;
}

/** One platform's figures (byProvider): its totals flat on the entry too (null when unavailable). */
export type AdsProviderFigures = AdFigures<AdTotals> & { [K in keyof AdTotals]: AdTotals[K] | null } & {
  provider: AdSpendProvider;
  accounts: string[];
  previous: AdsComparison;
  deltas: AdsDeltas;
  /** Every account of this platform here is the demo: its card says so. */
  demo?: boolean;
};

/** What connected Meta / Google ad accounts report for the dates (see adsFigures in the API). */
export interface AdsModule extends AdFigures<AdTotals> {
  /** The one currency everything below is in. */
  currency: string;
  accounts: Array<AdAccount<AdSpendProvider>>;
  /**
   * The accounts not added up, in another currency than `currency` (the Google Ads demo aside, its
   * spend being simulated): none of their spend is in any figure here, so a cost worked out from it
   * is short ("Left out: …", leftOutWords in profitFigures.ts). Absent from older answers.
   */
  leftOut?: Array<Pick<AdAccount<AdSpendProvider>, "id" | "provider" | "accountId" | "name" | "currency">>;
  /**
   * Whether the purchases, purchase value, ROAS and cost per purchase of the totals and `series` are
   * one platform's (claimsAddUp in @app/shared/ads). False with Meta and Google both counted: they then
   * add up claims that can overlap (both may credit one order), so a page shows each platform's own
   * (`byProvider`, `seriesByProvider`) instead. Absent from older answers.
   */
  claimsAddUp?: boolean;
  /** The figures compared with (from `compared.previous`): all null when nothing is compared. */
  previous: AdsComparison;
  deltas: AdsDeltas;
  /** Every day of the range; a day a counted account has no figures for is null throughout. */
  series: AdSeriesDay[];
  byProvider: AdsProviderFigures[];
  /** Each platform's own days (missing where its accounts have none). */
  seriesByProvider: Array<{ provider: AdSpendProvider; series: AdSeriesDay[] }>;
  /**
   * Team & Access: "View campaigns and their performance". `complete` false: its account's figures stop
   * before the range ends. The dashboard gets the 10 that spent most; the Advertising pages
   * (?parts=advertising) every one, each with its `change`.
   */
  campaigns?: Array<
    AdTotals & {
      provider: AdSpendProvider;
      accountId: string;
      campaignId: string;
      name: string;
      complete?: boolean;
      change?: CampaignChange | null;
      /** The platform's own word for the campaign's delivery now (Google's campaign.status, Meta's effective_status); null: not read yet. Absent from older answers. */
      status?: string | null;
      statusGroup?: CampaignStatusGroup | null;
      /** Google's channel type (SEARCH, PERFORMANCE_MAX...) as of the last sync; null for Meta and while unread. Absent from older answers. */
      channelType?: string | null;
      /** Google's primary status (ELIGIBLE, LIMITED...) and its reasons as of the last sync; null and none for Meta and while unread. */
      primaryStatus?: string | null;
      primaryStatusReasons?: string[];
      /** The budget as of the last sync, in the account's currency: DAILY, CUSTOM_PERIOD (Google: a total) or LIFETIME (Meta); null when none is known. */
      budgetPeriod?: string | null;
      budgetAmount?: number | null;
    }
  >;
  /** Ad spend divided by the store's net sales (same currency, every day known); null with a demo among the accounts. */
  shareOfSales: number | null;
  /** A demo account (simulated figures) is among the counted accounts: the store's own sales are left out of this module. */
  demo?: boolean;
  /**
   * The store's own sales (Shopify's net sales and orders for the same dates) set against the ad
   * spend: sales per unit of spend (MER), the spend's share of sales, the cost per order; with the
   * dates compared with and the changes when both sides are whole ranges. Null when not known,
   * in another currency, or some days of the spend are missing. Absent from older answers.
   */
  sales?: AdsVsSalesFigures | null;
  /**
   * Per platform, the orders Shopify's own visit record credits to its ads (a paid visit from
   * Facebook or Instagram, from Google or YouTube) and the store's sales from them per unit of that
   * platform's spend: the store's attribution, beside the platform's own purchases. Team & Access
   * "View conversion attribution"; null when the sources weren't read. Absent from older answers.
   */
  sourced?: Array<{ provider: AdSpendProvider; orders: number; sales: number; salesPerSpend: number | null }> | null;
}

/**
 * A campaign's change on the same whole days as the totals' (`compared`); null when the totals have
 * none. A campaign that ran on no day of the dates compared with has a spend of 0 then, and no change.
 */
export interface CampaignChange {
  /** The dates compared with. */
  from: string;
  to: string;
  previous: { spend: number | null; linkClicks: number | null; purchases: number | null; purchaseValue: number | null; roas: number | null };
  deltas: { spend: number | null; linkClicks: number | null; purchases: number | null; purchaseValue: number | null; roas: number | null };
}

/** adsVsSales (@app/shared/ads) with the dates compared with and the changes (salesVsSpend in the API). */
export interface AdsVsSalesFigures extends AdsVsSales {
  previous: { netSales: number; orders: number; salesPerSpend: number | null; costPerOrder: number | null } | null;
  deltas: { netSales: number | null; orders: number | null; salesPerSpend: number | null; costPerOrder: number | null };
}

/** What connected AdSense accounts earned from ads shown on the store's site (see adsenseFigures in the API). */
export interface AdsenseModule extends AdFigures<AdsenseTotals> {
  currency: string;
  accounts: Array<AdAccount<"adsense">>;
  previous: { from: string | null; to: string | null; earnings: number | null; pageViews: number | null; clicks: number | null; pageRpm: number | null; imported: boolean };
  deltas: { earnings: number | null; pageViews: number | null; clicks: number | null; pageRpm: number | null };
  series: AdsenseSeriesDay[];
  /** The store's sites the ads were shown on; one row with site "" when AdSense didn't split by site. */
  sites: Array<AdsenseTotals & { site: string }>;
  /** Sites on the same AdSense accounts that aren't the store's: left out of every figure above. */
  sitesLeftOut?: Array<AdsenseTotals & { site: string }>;
  /** Estimated earnings divided by the store's net sales (same currency, every day known). */
  vsSales: number | null;
  /** The day every counted account's figures are final up to (null: one has none final yet). Absent from older answers. */
  finalThrough?: string | null;
  /** AdSense has finalized every day of the figures given (`current`, else `partial`): "Final", else "Estimated". Absent from older answers. */
  final?: boolean;
}

/** GET .../ads/adsense/report: one AdSense account split by country or device type, asked of AdSense for exactly these dates. */
export interface AdsenseReportAnswer {
  account: { id: string; accountId: string; name: string | null };
  today: string;
  cached: boolean;
  report: AdsenseReport;
}

/** A live report's figures: the stored days' measures, and ad requests, coverage and viewability (absent from answers before 2026-10-29). */
export type AdsenseReportFigures = AdsenseTotals & Partial<Pick<AdsenseReportTotals, "adRequests" | "coverage" | "viewability">>;

/** The report itself (AdsenseLiveReport in @app/core). */
export interface AdsenseReport {
  level: AdsenseReportLevel;
  since: string;
  until: string;
  currency: string | null;
  rows: Array<AdsenseReportFigures & { id: string; name: string }>;
  totals: AdsenseReportFigures;
  truncated: boolean;
  /** The sites the answer is limited to (the connection's chosen sites; empty: every site). Absent: taken as the connection's. */
  sites?: string[];
}

export interface ChannelsModule {
  items: Array<{ source: string | null; label: string; orders: number; sales: number; share: number | null }>;
}

/** Where this period's sales came from (Shopify's record of the visit behind each order). */
export interface TrafficModule {
  /** `paidOrders`, `paidSales`, `paid` and `campaigns`: Team & Access "View conversion attribution". */
  items: Array<{ id: string; source: string; label: string; orders: number; sales: number; paidOrders?: number; paidSales?: number; share: number | null }>;
  paid?: { orders: number; sales: number; share: number | null };
  campaigns?: Array<{ source: string; label: string; campaign: string; orders: number; sales: number }>;
  /**
   * Paid vs organic: the same sales by how each order's last visit came, as Shopify recorded it (last click).
   * Every split, in order; Team & Access "View conversion attribution"; absent from older answers.
   */
  split?: Array<{ id: TrafficSplit; label: string; orders: number; sales: number; share: number | null }>;
  /** Orders whose source hasn't been read from Shopify yet. */
  pending: number;
}

export interface OrderTimingModule {
  /** Monday … Sunday. */
  byWeekday: number[];
  /** 0 … 23, store-local hour. */
  byHour: number[];
  busiestDay: string | null;
  busiestHour: number | null;
}

export interface FulfillmentModule {
  current: { orders: number; fulfilled: number; partiallyFulfilled: number; unfulfilled: number; avgHoursToFulfill: number | null };
  openNow: number;
  oldestOpenDays: number | null;
}

export interface DiscountCodesModule {
  /** `discount` and `sales`: Team & Access "View discount performance". */
  items: Array<{ code: string; orders: number; discount?: number; sales?: number }>;
}

export interface RecentOrder {
  id: string;
  shopifyId?: string;
  name: string;
  createdAt: string;
  total: number;
  /** Team & Access: "View payment status", "View fulfillment status", "View cancellations". */
  financialStatus?: string | null;
  fulfillmentStatus?: string | null;
  channel: string;
  units: number;
  cancelled?: boolean;
}

export interface InventoryModule {
  current: {
    trackedVariants: number;
    unitsInStock: number;
    /** Stock value: Team & Access "View stock value and prices". */
    stockValueAtCost?: number | null;
    variantsWithCost?: number;
    retailValue?: number;
    outOfStock: number;
    lowStock: number;
  };
  /** Low as the Inventory section counts it (at or under the low-stock threshold), the ones about to run out first; a rate needs 14 days of imported orders. */
  lowStockItems: Array<{ productTitle: string; variantTitle: string; sku: string | null; quantity: number; dailySales: number | null; daysOfCover: number | null }>;
}

export interface CatalogModule {
  products: { active: number; draft: number; archived: number; total: number };
  variants: number;
  topVendors: Array<{ vendor: string; revenue: number; units: number }>;
}

/** Storefront visits from the web pixel: the funnel, site sections and top landing/exit pages. */
export interface FunnelModule extends JourneySummary {
  entryPages: JourneyPageRow[];
  exitPages: JourneyPageRow[];
  /** The first day every visit was counted from: the day after the pixel was put in place. */
  historyFrom?: string | null;
  /** Null, and `imported` false, when the comparison starts before `historyFrom`: "No earlier data". `reached`: visits per step then. */
  previous: { visits: number | null; conversionRate: number | null; imported?: boolean; reached?: number[] | null };
  deltas: { visits: number | null; conversionRate: number | null };
  /** The Profit sheet's answer (?parts=sheet) only: visits day by day, null on a day before they were counted. */
  visitsByDay?: Array<{ day: string; visits: number | null }>;
}

/** One product page on the Shopping Funnel page (funnelDetail in packages/core/src/reports/funnel.ts). */
export interface FunnelProduct {
  handle: string;
  productId: string | null;
  title: string | null;
  imageUrl: string | null;
  url: string | null;
  /** Visits that viewed its page; null when product pages weren't recorded in these dates. */
  viewed: number | null;
  /** Visits that added it to cart from its page. */
  added: number | null;
  addRate: number | null;
  /**
   * Visits that added it to cart from anywhere else (a quick add), started a checkout holding it, and
   * bought it; and bought ÷ started checkout on those visits. Null when they weren't recorded in these
   * dates (`sourcesFrom`).
   */
  quickAdded: number | null;
  checkouts: number | null;
  purchased: number | null;
  checkoutCompletion: number | null;
  /** Visits that started on its page; of those, visits that left the store from it without buying; and all visits that left from it without buying. */
  landed: number;
  landedLeft: number;
  exits: number;
  /** The store's orders of it in these dates (only with the top products permission). */
  orders?: number;
  units?: number;
  netSales?: number;
}

/** The Shopping Funnel page's funnel (GET …/overview?parts=funnel): the dashboard's, and everything funnelDetail adds. */
export interface FunnelPageModule extends FunnelModule {
  filter: FunnelFilter;
  stepDeltas: Array<number | null>;
  browsers: number;
  transitions: FunnelTransition[];
  /** Day by day, visits reached per step; null on a day before visits were counted. */
  daily: Array<{ day: string; reached: number[] | null }>;
  /** `source`: only for members who see traffic sources. */
  segments: { device: SegmentFunnel[]; country: SegmentFunnel[]; landing: SegmentFunnel[]; visitor: SegmentFunnel[]; source?: SegmentFunnel[] };
  products: FunnelProduct[];
  productSales: boolean;
  /** The first day device, country and product pages were recorded. */
  detailsFrom: string | null;
  /** The first day traffic sources, and quick adds, checkouts and purchases per product, were recorded. */
  sourcesFrom: string | null;
  lastEventAt: string | null;
  insights: FunnelInsight[];
  actions: Array<{ id: string; doneAt: string; doneBy: string | null; doneByName: string | null }>;
}

/** GET .../contacts: read live from Shopify, never stored (see apps/api/src/routes/contacts.ts). Names, contact details and order history can each be withheld (Team & Access). */
export interface ContactPerson {
  customerId: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  /** Agreed to email marketing. */
  subscribed: boolean;
  /** Agreed to marketing by text message. */
  smsSubscribed: boolean;
  adminUrl: string | null;
}

export interface AbandonedContact extends ContactPerson {
  id: string;
  createdAt: string;
  total: number;
  currency: string;
  items: Array<{ title: string; quantity: number }>;
  /** Null when this member may not see contact information (the link opens the shopper's own checkout). */
  recoveryUrl: string | null;
}

export interface CustomerContact extends ContactPerson {
  createdAt: string;
  /** Null when this member may not see order history. */
  orders: number | null;
  spent: number | null;
  currency: string | null;
}

export interface Contacts {
  fetchedAt: string;
  /** Shopify withheld names and emails: the app isn't approved for protected customer data on this store. */
  restricted: boolean;
  /** What this member may see (Team & Access); absent from older answers, which meant everything. */
  shown?: { abandoned: boolean; customers: boolean; names: boolean; contact: boolean; orders: boolean };
  abandoned: AbandonedContact[];
  subscribers: CustomerContact[];
  recent: CustomerContact[];
}

/** Order figures need "View sales and revenue" or "View order list", product figures a product permission (Team & Access). */
export interface ImportedData {
  orders?: number;
  products?: number;
  variants?: number;
  oldestOrderDay?: string | null;
  newestOrderDay?: string | null;
  /**
   * The first day every order was imported from (the start of Shopify's 60-day window, or
   * 1970-01-01 with the whole history): comparisons and "not imported" days go by this, not by
   * the first order, which a quiet store has days later.
   */
  historyFrom?: string | null;
  /** The store-local day Shopify created the store; null until its details are read. */
  createdDay?: string | null;
  /** The store's first day (that, or an earlier order's): how early custom dates may start, the first year offered. */
  startDay?: string | null;
  /**
   * The orders older than Shopify's 60 days: how the store can have them (`HistoryAccess` in
   * @app/shared) and, once it has, how their import is going, a year at a time, newest first.
   * Left out for a member who may not see orders.
   */
  history?: OrderHistory;
}

export interface OrderHistory {
  access: HistoryAccess;
  years: Array<{ year: number; status: "queued" | "running" | "done" | "failed"; orders: number; finishedAt: string | null }>;
}

export interface Freshness {
  asOf: string | null;
  waiting: number;
  waitingSince: string | null;
  failed: number;
}

export interface ProductPerformance {
  items: Array<{
    key: string; rank: number; productId: string | null; title: string; imageUrl: string | null; sku: string | null;
    units: number; grossUnits: number; returnedUnits: number; revenue: number; grossSales: number; discounts: number; returns: number;
    orders: number; growth: number | null; trend: string; trendScore: number | null; lastSold: string | null;
    variants: Array<{ variantId: string | null; sku: string | null; units: number; revenue: number }>;
  }>;
  total: number; complete: boolean; baseline: boolean; lastSyncedAt: string | null; unknownIdentitySales?: number;
  historyFrom: string | null; previous: { from: string; to: string };
}

export interface Overview {
  store: OverviewStore;
  /** While the store is in error: why Shopify stopped the sync (see syncProblem in the API). */
  syncProblem?: "shop_unavailable" | "shop_gone" | "shop_locked" | "access" | "not_approved" | "other" | null;
  range: { from: string; to: string };
  /**
   * What the range is compared with (`Comparison` in @app/shared): `until` while the range is still
   * running; `compare`, how it was chosen (the period before, the previous year or dates picked);
   * `imported` false when the store's imported orders don't reach back to it, so the order figures
   * aren't compared ("No earlier data").
   */
  previous: { from: string; to: string; until?: string; compare?: CompareMode; imported?: boolean };
  /** The store's today (YYYY-MM-DD). */
  today: string;
  /**
   * How current the numbers are (dataFreshness in packages/core/src/reports/overview.ts): when they
   * last matched Shopify, changes from Shopify received and not counted yet, and since when, and
   * changes that failed for good in the last 24 hours.
   */
  freshness?: Freshness;
  /** The last check of the figures against Shopify's own records (outcome only). */
  check?: CheckSummary;
  capabilities: Capability[];
  hasData: boolean;
  data?: ImportedData;
  modules: {
    sales_overview?: SalesOverview;
    refunds?: { current: { refunds: number; refundRate: number | null; refundedOrders: number }; deltas: { refunds: number | null } };
    /** Customers counted once each, as Shopify's reports count them; rate = returning ÷ customers. */
    customers?: { current: CustomerCounts; previous: { [K in keyof CustomerCounts]: CustomerCounts[K] | null } };
    top_products?: ProductPerformance;
    funnel?: FunnelModule;
    channels?: ChannelsModule;
    traffic?: TrafficModule;
    order_timing?: OrderTimingModule;
    fulfillment?: FulfillmentModule;
    discount_codes?: DiscountCodesModule;
    /** The latest orders placed in the dates; `cancelledInRange`: orders cancelled in them (needs "View cancellations"). */
    recent_orders?: { items: RecentOrder[]; cancelledInRange?: number };
    /** How the dates' orders went: completed, awaiting payment, unsuccessful, sent, and checkouts left (Orders at a glance). */
    order_outcomes?: OrderOutcomes;
    inventory?: InventoryModule;
    catalog?: CatalogModule;
    ads?: AdsModule;
    adsense?: AdsenseModule;
    /**
     * How many accounts of each platform are connected to the store, hidden ones included. `waiting`:
     * the platforms whose sign-in is connected with no ad account yet (absent from an older API).
     */
    ad_connections?: { meta: number; google: number; adsense: number; hidden: number; waiting?: string[] };
    /** Which platforms this server can connect (absent: none is set up). */
    ad_configured?: { meta: boolean; google: boolean; adsense: boolean };
    /**
     * Where Meta's and Google's figures come from, each on its own (adPlatformSources): the platform's own
     * API, the store's Shopify orders, or none. One platform's page: that one only. Absent from an older API.
     */
    ad_sources?: AdPlatformSource[];
    /**
     * Meta's and Google's sales from the store's own orders: on the Advertising pages, and on the dashboard
     * while a platform's source is the orders (`ad_sources`). Needs "View traffic sources"; its tagged-ad
     * figures and campaigns, "View conversion attribution"; its storefront visits, "View conversion rates".
     */
    ads_from_shopify?: AdsFromShopify;
    /**
     * The ad spend, impressions and clicks the store's marketing apps (Facebook & Instagram, Google &
     * YouTube, others) report to Shopify (core shopifyMarketing.ts), with its reports granted: Meta's and
     * Google's where `ad_sources` says `marketing`. Its campaigns need "View campaigns".
     */
    shopify_marketing?: ShopifyMarketing;
    /** Shopify's own figures (packages/core/src/reports/shopify.ts), with its reports granted. */
    shopify_sessions?: ShopifySessionsModule;
    profit?: ProfitModule;
    /**
     * Product costs from the store's orders at each product's cost per item in Shopify (core
     * productCosts), while Shopify's profit report gives none: absent while it does or is on its way.
     */
    product_costs?: ProductCostsModule;
    shopify_check?: ShopifyCheckModule;
    /** The owner's own costs (Settings → Costs) for the dates; needs finance.breakdown. */
    expenses?: ExpensesModule;
  };
}

/** The store's own costs for the dates (core expensesModule), in the store's currency. */
export interface ExpensesModule {
  currency: string;
  /** Every cost the store keeps, whether or not it falls in the dates. */
  count: number;
  current: ExpenseTotals;
  previous: { total: number } | null;
  delta: number | null;
  /** From which day the owner says the list holds every cost; null: not said. */
  completeFrom: string | null;
  /** The list holds every cost for all of the dates. */
  complete: boolean;
  /** The weekdays the store is open, Monday = 0 (empty: every day): recurring costs are spread over those (absent from older answers). */
  operatingWeekdays?: number[];
  /** The Profit sheet's question only: every cost's terms (no names or notes), to spread over its own columns. */
  terms?: ProfitCost[];
  /** The store's own cost categories, for their names (absent from older answers). */
  categories?: CustomCategory[];
}

/** Customers who ordered in a range (the customers module): each once, however many orders. */
export interface CustomerCounts {
  customers: number;
  /** Customers with an order placed when their history already held one. */
  returningCustomers: number;
  /** Customers whose very first purchase is in the range (one can be in both). */
  newCustomers: number;
  returningCustomerRate: number | null;
}

/** The figures a check against Shopify compares (RECONCILE_METRICS in packages/core/src/reconcile.ts). */
export type CheckMetric = "orders" | "grossSales" | "discounts" | "returns" | "netSales" | "shipping" | "taxes" | "totalSales" | "units";

/** The last check against Shopify's own records, as the overview gives it to everyone: no figures. */
export interface CheckSummary {
  /** When the check now running began; null when none is. */
  running: string | null;
  last: {
    status: "verified" | "repaired" | "differences" | "incomplete";
    from: string;
    to: string;
    checkedAt: string;
    ordersChecked: number;
    matched: number;
    compared: number;
    /** Orders written again or removed so the figures match. */
    repaired: number;
    /** Orders Shopify no longer shares (placed over 60 days ago), left out of the comparison. */
    setAside: number;
  } | null;
}

/** GET .../check: the last check with its figures (needs the sales breakdown permission). */
export interface CheckDetail {
  running: string | null;
  last: {
    id: string;
    status: string;
    from: string;
    to: string;
    checkedAt: string;
    currency: string;
    findings: Partial<Record<string, number>>;
    repaired: number;
    removed: number;
    /** Orders Shopify no longer shares, left out of the comparison, and their share of each figure. */
    setAside: { orders: number; totals: Record<CheckMetric, number> } | null;
    /** `setAside`: the part of `bizinsights` left out of the comparison (0 when nothing was). */
    results: Array<{ metric: CheckMetric; shopify: number | null; before: number | null; bizinsights: number | null; setAside: number; status: string; cause: string | null }>;
  } | null;
}

/** Where a Shopify report answer stands: figures, being fetched, or why Shopify gave none. */
export type ReportStatus = "ready" | "loading" | "access_denied" | "unsupported" | "failed";

interface ReportAnswer {
  status: ReportStatus;
  /** When Shopify was asked. */
  asOf: string | null;
  /** While the range runs: the store-local time both windows stop at (a 5-minute mark). */
  until: string | null;
}

export interface SessionFigures {
  sessions: number | null;
  visitors: number | null;
  cartSessions: number | null;
  checkoutSessions: number | null;
  completedSessions: number | null;
  pageviews: number | null;
  conversionRate: number | null;
}

export interface ShopifySessionsModule extends ReportAnswer {
  current: SessionFigures | null;
  previous: SessionFigures | null;
  deltas: { sessions: number | null; visitors: number | null; conversionRate: number | null };
}

export interface ProfitModule extends ReportAnswer {
  current: {
    grossProfit: number | null;
    costOfGoodsSold: number | null;
    netSalesWithCost: number | null;
    netSalesWithoutCost: number | null;
    profitOnCosted: number | null;
    marginOnCosted: number | null;
  } | null;
  previous: { grossProfit: number | null } | null;
  deltas: { grossProfit: number | null };
}

/** The items sold in the dates at their cost per item in Shopify now, and the net sales of items with and without one. */
export interface ProductCostsModule {
  current: { costOfGoodsSold: number; netSalesWithCost: number; netSalesWithoutCost: number };
  /** The Profit sheet's question only: the same day by day, every day of the dates. */
  byDay?: Array<{ day: string; costOfGoodsSold: number; netSalesWithCost: number; netSalesWithoutCost: number }>;
}

export interface ShopifyCheckModule extends ReportAnswer {
  window: { from: string; to: string };
  rows: Array<{ metric: string; shopify: number | null; ours: number; difference: number | null; state: "match" | "differs" | "delay" | "unknown" }> | null;
  matches: boolean | null;
}
