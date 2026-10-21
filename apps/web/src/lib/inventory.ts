// The Inventory pages' client side: the API's answers as types, the product panel's place in the
// URL (?product=), saved filters, and small helpers. Rules (statuses, thresholds, what each figure
// means) come from @app/shared/inventory, as the API uses them.
import { useSyncExternalStore } from "react";
import type { CapabilityState } from "@app/shared/capabilities";
import type { StockQuery, StockStatus } from "@app/shared/inventory";
import { readLocal, writeLocal } from "@/lib/storage";

export type StockSource = "levels" | "variants";

export interface InventoryCan {
  products: boolean;
  costs: boolean;
  history: boolean;
  export: boolean;
  adjust: boolean;
  alerts: boolean;
  settings: boolean;
  /** May ask Shopify for more access (owners and admins). */
  connect: boolean;
}

export interface SyncStatus {
  source: StockSource;
  running: boolean;
  lastPass: { trigger: "import" | "manual" | "reconcile"; status: string; startedAt: string; finishedAt: string | null; levelsChecked: number; differences: number; locations: number } | null;
  checkedAt: string | null;
  stockUpdatedAt: string | null;
  catalogSyncedAt: string | null;
  locations: number;
  levels: number;
  stale: boolean;
  reconcileHours: number;
}

export interface StatusAnswer {
  store: { id: string; name: string; currency: string; timezone: string; status: string; shopDomain: string };
  status: SyncStatus;
  capabilities: CapabilityState[];
  can: InventoryCan;
}

export interface Kpi {
  value: number | null;
  previous: number | null;
  change: number | null;
  note?: string;
  complete?: boolean;
  basis: "stock" | "orders";
}

export interface StockRow {
  variantId: string;
  productId: string;
  productTitle: string;
  productStatus: string | null;
  vendor: string | null;
  productType: string | null;
  imageUrl: string | null;
  variantTitle: string;
  options: Array<{ name: string; value: string }>;
  sku: string | null;
  barcode: string | null;
  price: number;
  unitCost?: number | null;
  stockValue?: number | null;
  tracked: boolean;
  continueSelling: boolean;
  threshold: number;
  available: number | null;
  onHand: number | null;
  committed: number | null;
  incoming: number | null;
  unavailable: number | null;
  locations: number | null;
  status: StockStatus;
  updatedAt: string | null;
  syncedAt: string | null;
  sold30: number;
  dailyRate: number | null;
  daysOfStock: number | null;
  depletionDate: string | null;
  restock: number | null;
}

export interface StockPage {
  rows: StockRow[];
  total: number;
  page: number;
  pageSize: number;
  source: StockSource;
  salesDays: number;
  location: string | null;
}

export interface Facets {
  vendors: string[];
  types: string[];
  collections: Array<{ id: string; title: string }>;
  statuses: Partial<Record<StockStatus, number>>;
  locations: Array<{ id: string; name: string; active: boolean }>;
}

export interface OverviewAnswer {
  range: { from: string; to: string };
  previous: { from: string; to: string };
  status: SyncStatus;
  source: StockSource;
  today: string;
  comparedWith: string;
  kpis: Record<string, Kpi | null>;
  untracked: { variants: number; onHand: number | null };
  tracked: number;
  salesDays: number;
  lowStock: { rows: StockRow[]; total: number };
  outOfStock: { rows: StockRow[]; total: number };
}

export interface LevelView {
  locationId: string;
  locationName: string;
  locationActive: boolean;
  available: number;
  onHand: number;
  committed: number;
  incoming: number;
  reserved: number;
  damaged: number;
  safetyStock: number;
  qualityControl: number;
  updatedAt: string;
  syncedAt: string;
}

export interface VariantView {
  id: string;
  title: string;
  sku: string | null;
  barcode: string | null;
  options: Array<{ name: string; value: string }>;
  price: number;
  compareAtPrice: number | null;
  unitCost?: number | null;
  taxable: boolean | null;
  requiresShipping: boolean | null;
  weight: number | null;
  weightUnit: string | null;
  tracked: boolean;
  continueSelling: boolean;
  inventoryItemId: string | null;
  lowStockThreshold: number | null;
  threshold: number | null;
  status: StockStatus | null;
  available: number | null;
  onHand: number | null;
  committed: number | null;
  incoming: number | null;
  createdAt: string | null;
  updatedAt: string;
  sales: { units7: number; units30: number; units90: number };
  dailyRate: number | null;
  daysOfStock: number | null;
  depletionDate: string | null;
  restock: number | null;
  levels: LevelView[];
}

export interface MovementRow {
  id: string;
  at: string;
  kind: "confirmed" | "observed";
  source: "webhook" | "sync" | "reconcile" | "adjustment";
  productId: string | null;
  productTitle: string | null;
  variantId: string | null;
  variantTitle: string | null;
  sku: string | null;
  locationId: string;
  locationName: string | null;
  quantityName: string;
  before: number | null;
  after: number;
  delta: number;
  adjustment: { id: string; kind: string; reason: string; note: string | null; referenceId: string | null; by: string | null } | null;
}

export interface MovementPage {
  rows: MovementRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ProductDetail {
  product: {
    id: string;
    title: string;
    status: string | null;
    vendor: string | null;
    productType: string | null;
    category: string | null;
    tags: string[];
    collections: Array<{ id: string; title: string }>;
    description: string | null;
    imageUrl: string | null;
    handle: string | null;
    onlineStoreUrl: string | null;
    adminUrl: string;
    createdAt: string | null;
    updatedAt: string;
    lowStockThreshold: number | null;
  };
  variants: VariantView[];
  sales: { days: Array<{ day: string; units: number }>; units7: number; units30: number; units90: number; revenue30: number; salesDays: number };
  history: MovementPage | null;
}

export interface LocationView {
  id: string;
  name: string;
  active: boolean;
  fulfillmentService: boolean;
  fulfillsOnlineOrders: boolean | null;
  address: string | null;
  countryCode: string | null;
  syncedAt: string;
  stock: null | {
    itemsStocked: number;
    available: number;
    onHand: number;
    committed: number;
    incoming: number;
    unavailable: number;
    lowStock: number;
    outOfStock: number;
    untrackedItems: number;
    costValue?: number | null;
    costComplete?: boolean;
  };
}

export interface AdjustmentRow {
  id: string;
  status: "pending" | "confirmed" | "failed" | "unknown";
  kind: string;
  reason: string;
  note: string | null;
  referenceId: string | null;
  productId: string | null;
  productTitle: string | null;
  variantId: string | null;
  variantTitle: string | null;
  sku: string | null;
  locationId: string;
  locationName: string | null;
  quantityName: string;
  delta: number | null;
  quantity: number | null;
  expectedBefore: number | null;
  resultQuantity: number | null;
  errorCode: string | null;
  by: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface InventorySettingsView {
  lowStockThreshold: number;
  emailAlerts: boolean;
  dashboardAlerts: boolean;
  whatsappAlerts: boolean;
  whatsappTemplate: string | null;
  /** Masked. */
  whatsappTo: string[];
  reconcileHours: number;
  leadTimeDays: number;
  coverDays: number;
  updatedAt: string | null;
}

/** The stock list's filters as the URL and the API take them (only what's set). */
export type StockFilters = Partial<Pick<StockQuery, "q" | "location" | "status" | "vendor" | "type" | "collection" | "priceMin" | "priceMax" | "sort" | "dir">>;

export function stockQueryString(f: StockFilters & { page?: number; pageSize?: number }): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  return p.toString();
}

// ---------------------------------------------------------------------------
// Saved filters (per device: a convenience, never shared)
// ---------------------------------------------------------------------------

export interface SavedFilter {
  name: string;
  filters: StockFilters;
}

const savedKey = (storeId: string) => `inventory-filters:${storeId}`;

export function readSavedFilters(storeId: string): SavedFilter[] {
  try {
    const v: unknown = JSON.parse(readLocal(savedKey(storeId)) ?? "[]");
    return Array.isArray(v) ? (v as SavedFilter[]).filter((x) => x && typeof x.name === "string" && x.filters && typeof x.filters === "object") : [];
  } catch {
    return [];
  }
}

export function writeSavedFilters(storeId: string, list: SavedFilter[]) {
  writeLocal(savedKey(storeId), JSON.stringify(list.slice(0, 20)));
}

// ---------------------------------------------------------------------------
// The product panel (?product=…), on any Inventory page
// ---------------------------------------------------------------------------

const PRODUCT_EVENT = "inventory:product";
const readProduct = () => (typeof window === "undefined" ? null : new URL(window.location.href).searchParams.get("product"));
const subscribe = (cb: () => void) => {
  window.addEventListener("popstate", cb);
  window.addEventListener(PRODUCT_EVENT, cb);
  return () => {
    window.removeEventListener("popstate", cb);
    window.removeEventListener(PRODUCT_EVENT, cb);
  };
};

/** The product whose panel is open, from the URL. */
export function useOpenProduct(): string | null {
  return useSyncExternalStore(subscribe, readProduct, () => null);
}

/** Open (or with null, close) a product's panel, keeping the page and its filters. */
export function openProduct(id: string | null) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("product", id);
  else url.searchParams.delete("product");
  window.history.pushState(window.history.state, "", url.href);
  window.dispatchEvent(new Event(PRODUCT_EVENT));
}

/** One key per confirmation dialog: the API and Shopify apply a change sent with it once. */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
