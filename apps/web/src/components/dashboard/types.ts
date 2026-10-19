/** Response of GET /workspaces/:ws/stores/:storeId/overview (built by packages/core/src/reports/overview.ts, served by apps/api/src/routes/dashboard.ts). */
import type { AdsenseTotals, AdTotals } from "@app/shared/ads";
import type { CompareMode } from "@app/shared/dates";
import type { JourneyPageRow, JourneySummary } from "@app/shared/journey";
import type { SalesDay, YearBreakdown } from "@app/shared/sales";
import type { SalesCalculation } from "@app/shared/salesCalculation";

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
   * its `totalSales`: "View gross sales, discounts, tax and shipping".
   */
  series: Array<
    Omit<SalesDay, "refunds" | "totalSales"> & { refunds?: number; totalSales?: number; shipping?: number; tax?: number; duties?: number; additionalFees?: number }
  >;
  /** This calendar year by month, whatever the range. Team & Access: "View financial reports". */
  year?: YearBreakdown;
  /**
   * The store's own calculation from the lines of total sales (Custom sales): which it counts and
   * whether the dashboard shows it. Team & Access: as grossSales (its figures are drawn from them).
   */
  calculation?: SalesCalculation;
}

/** What connected Meta / Google ad accounts report for the dates (see adsModule in the API). */
export interface AdsModule {
  /** The one currency everything below is in. */
  currency: string;
  accounts: Array<{ id: string; provider: "meta" | "google"; accountId: string; name: string | null; currency: string | null; status: string; lastSyncedAt: string | null; counted: boolean }>;
  current: AdTotals;
  /** The first day every counted account has figures from (each account brings the 90 days before it was connected). */
  historyFrom?: string | null;
  /** All null, and `imported` false, when the comparison starts before `historyFrom`: "No earlier data". */
  previous: { spend: number | null; clicks: number | null; conversions: number | null; conversionValue: number | null; roas: number | null; imported?: boolean };
  deltas: { spend: number | null; clicks: number | null; conversions: number | null; roas: number | null };
  series: Array<{ day: string; spend: number; clicks: number; impressions: number; conversions: number; conversionValue: number }>;
  byProvider: Array<AdTotals & { provider: "meta" | "google" }>;
  /** Each platform's own days (same shape as series). */
  seriesByProvider: Array<{ provider: "meta" | "google"; series: Array<{ day: string; spend: number; clicks: number; impressions: number; conversions: number; conversionValue: number }> }>;
  /** Team & Access: "View campaigns and their performance". */
  campaigns?: Array<AdTotals & { provider: "meta" | "google"; accountId: string; campaignId: string; name: string }>;
  /** Ad spend divided by the store's net sales (same currency only). */
  shareOfSales: number | null;
}

/** What connected AdSense accounts earned from ads shown on the store's site (see adsenseModule in the API). */
export interface AdsenseModule {
  currency: string;
  accounts: Array<{ id: string; provider: "adsense"; accountId: string; name: string | null; currency: string | null; status: string; lastSyncedAt: string | null; counted: boolean }>;
  current: AdsenseTotals;
  /** The first day every counted account has figures from (as for ads). */
  historyFrom?: string | null;
  /** All null, and `imported` false, when the comparison starts before `historyFrom`: "No earlier data". */
  previous: { earnings: number | null; pageViews: number | null; clicks: number | null; pageRpm: number | null; imported?: boolean };
  deltas: { earnings: number | null; pageViews: number | null; clicks: number | null; pageRpm: number | null };
  series: Array<{ day: string; earnings: number; pageViews: number; impressions: number; clicks: number }>;
  /** Per site the ads were shown on; one row with site "" when AdSense didn't split by site. */
  sites: Array<AdsenseTotals & { site: string }>;
  /** Ad earnings divided by the store's net sales (same currency only). */
  vsSales: number | null;
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
  lowStockItems: Array<{ productTitle: string; variantTitle: string; sku: string | null; quantity: number; dailySales: number; daysOfCover: number | null }>;
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
  /** Null, and `imported` false, when the comparison starts before `historyFrom`: "No earlier data". */
  previous: { visits: number | null; conversionRate: number | null; imported?: boolean };
  deltas: { visits: number | null; conversionRate: number | null };
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
}

export interface Freshness {
  asOf: string | null;
  waiting: number;
  waitingSince: string | null;
  failed: number;
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
    top_products?: { items: Array<{ productId: string | null; title: string; revenue: number; units: number }> };
    funnel?: FunnelModule;
    channels?: ChannelsModule;
    traffic?: TrafficModule;
    order_timing?: OrderTimingModule;
    fulfillment?: FulfillmentModule;
    discount_codes?: DiscountCodesModule;
    recent_orders?: { items: RecentOrder[] };
    inventory?: InventoryModule;
    catalog?: CatalogModule;
    ads?: AdsModule;
    adsense?: AdsenseModule;
    /** How many accounts of each platform are connected to the store, hidden ones included. */
    ad_connections?: { meta: number; google: number; adsense: number; hidden: number };
    /** Which platforms this server can connect (absent: none is set up). */
    ad_configured?: { meta: boolean; google: boolean; adsense: boolean };
    /** Shopify's own figures (packages/core/src/reports/shopify.ts), with its reports granted. */
    shopify_sessions?: ShopifySessionsModule;
    profit?: ProfitModule;
    shopify_check?: ShopifyCheckModule;
  };
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

export interface ShopifyCheckModule extends ReportAnswer {
  window: { from: string; to: string };
  rows: Array<{ metric: string; shopify: number | null; ours: number; difference: number | null; state: "match" | "differs" | "delay" | "unknown" }> | null;
  matches: boolean | null;
}
