/** Response of GET /workspaces/:ws/stores/:storeId/overview (see apps/api/src/routes/dashboard.ts). */
import type { JourneyPageRow, JourneySummary } from "@app/shared/journey";

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
  deltas: { netSales: number | null; orders: number | null; averageOrderValue: number | null; grossSales: number | null };
  series: Array<{ day: string; netSales: number; orders: number }>;
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
  };
}
