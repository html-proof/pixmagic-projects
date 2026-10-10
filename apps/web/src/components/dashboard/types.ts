/** Response of GET /workspaces/:ws/stores/:storeId/overview (see apps/api/src/routes/dashboard.ts). */
import type { JourneyPageRow, JourneySummary } from "@app/shared/journey";
import type { SalesDay, YearBreakdown } from "@app/shared/sales";

export interface Capability {
  id: string;
  title: string;
  description: string;
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

export interface SalesOverview {
  current: {
    grossSales: number;
    discounts: number;
    netSales: number;
    orders: number;
    units: number;
    averageOrderValue: number | null;
    tax: number;
    shipping: number;
  };
  /** The same figures for the period before (as many days, immediately before). */
  previous: { grossSales: number; netSales: number; orders: number; averageOrderValue: number | null };
  deltas: { netSales: number | null; orders: number | null; averageOrderValue: number | null; grossSales: number | null };
  /** Every day of the range, quiet days as zero. */
  series: SalesDay[];
  /** This calendar year by month, whatever the range. */
  year: YearBreakdown;
}

export interface AdTotals {
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValue: number;
  leads: number;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  costPerConversion: number | null;
  roas: number | null;
}

/** What connected Meta / Google ad accounts report for the dates (see adsModule in the API). */
export interface AdsModule {
  /** The one currency everything below is in. */
  currency: string;
  accounts: Array<{ id: string; provider: "meta" | "google"; accountId: string; name: string | null; currency: string | null; status: string; lastSyncedAt: string | null; counted: boolean }>;
  current: AdTotals;
  previous: { spend: number; clicks: number; conversions: number; conversionValue: number; roas: number | null };
  deltas: { spend: number | null; clicks: number | null; conversions: number | null; roas: number | null };
  series: Array<{ day: string; spend: number; clicks: number; impressions: number; conversions: number; conversionValue: number }>;
  byProvider: Array<AdTotals & { provider: "meta" | "google" }>;
  /** Each platform's own days (same shape as series). */
  seriesByProvider: Array<{ provider: "meta" | "google"; series: Array<{ day: string; spend: number; clicks: number; impressions: number; conversions: number; conversionValue: number }> }>;
  campaigns: Array<AdTotals & { provider: "meta" | "google"; accountId: string; campaignId: string; name: string }>;
  /** Ad spend divided by the store's net sales (same currency only). */
  shareOfSales: number | null;
}

export interface AdsenseTotals {
  earnings: number;
  pageViews: number;
  impressions: number;
  clicks: number;
  pageRpm: number | null;
  perClick: number | null;
  ctr: number | null;
}

/** What connected AdSense accounts earned from ads shown on the store's site (see adsenseModule in the API). */
export interface AdsenseModule {
  currency: string;
  accounts: Array<{ id: string; provider: "adsense"; accountId: string; name: string | null; currency: string | null; status: string; lastSyncedAt: string | null; counted: boolean }>;
  current: AdsenseTotals;
  previous: { earnings: number; pageViews: number; clicks: number; pageRpm: number | null };
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
  items: Array<{ code: string; orders: number; discount: number; sales: number }>;
}

export interface RecentOrder {
  id: string;
  shopifyId?: string;
  name: string;
  createdAt: string;
  total: number;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  channel: string;
  units: number;
  cancelled: boolean;
}

export interface InventoryModule {
  current: {
    trackedVariants: number;
    unitsInStock: number;
    stockValueAtCost: number | null;
    variantsWithCost?: number;
    retailValue: number;
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
  previous: { visits: number; conversionRate: number | null };
  deltas: { visits: number | null; conversionRate: number | null };
}

/** GET .../contacts: read live from Shopify, never stored (see apps/api/src/routes/contacts.ts). */
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
  recoveryUrl: string;
}

export interface CustomerContact extends ContactPerson {
  createdAt: string;
  orders: number;
  spent: number;
  currency: string | null;
}

export interface Contacts {
  fetchedAt: string;
  /** Shopify withheld names and emails: the app isn't approved for protected customer data on this store. */
  restricted: boolean;
  abandoned: AbandonedContact[];
  subscribers: CustomerContact[];
  recent: CustomerContact[];
}

export interface ImportedData {
  orders: number;
  products: number;
  variants: number;
  oldestOrderDay: string | null;
  newestOrderDay: string | null;
}

export interface Overview {
  store: OverviewStore;
  range: { from: string; to: string };
  previous: { from: string; to: string };
  /** The store's today (YYYY-MM-DD). */
  today: string;
  capabilities: Capability[];
  hasData: boolean;
  data?: ImportedData;
  modules: {
    sales_overview?: SalesOverview;
    refunds?: { current: { refunds: number; refundRate: number | null; refundedOrders: number }; deltas: { refunds: number | null } };
    customers?: { current: { returningCustomerRate: number | null }; previous: { returningCustomerRate: number | null } };
    top_products?: { items: Array<{ productId: string | null; title: string; revenue: number; units: number }> };
    funnel?: FunnelModule;
    channels?: ChannelsModule;
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
  };
}
