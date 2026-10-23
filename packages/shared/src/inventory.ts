// The Inventory module's rules, shared by the API, the worker and the UI: Shopify's quantity
// states, what makes a variant low or out of stock, the sales-based forecasts, the stock changes
// a person may ask for, the settings, and what every figure on the overview means.
//
// Every forecast here takes real sales (units sold over a number of days the store's orders cover)
// and answers null when there are too few days to say: nothing is ever estimated from nothing.
//
// Imported by the UI through `@app/shared/inventory`: no I/O, relative imports stay extensionless.

import { z } from "./zod";
import { addDays } from "./dates";

// ---------------------------------------------------------------------------
// Shopify's quantity states
// ---------------------------------------------------------------------------

/**
 * Every quantity state Shopify keeps per inventory item and location (InventoryLevel.quantities).
 * They are not interchangeable: `on_hand` = available + committed + reserved + damaged +
 * safety_stock + quality_control, and `incoming` is stock on its way, in none of the others.
 */
export const QUANTITY_NAMES = ["available", "on_hand", "committed", "incoming", "reserved", "damaged", "safety_stock", "quality_control"] as const;
export type QuantityName = (typeof QUANTITY_NAMES)[number];

export const QUANTITY_INFO: Record<QuantityName, { label: string; description: string }> = {
  available: { label: "Available", description: "Units that can be sold now." },
  on_hand: { label: "On hand", description: "Units physically at the location: available, committed and unavailable together." },
  committed: { label: "Committed", description: "Units in orders that haven't been fulfilled yet." },
  incoming: { label: "Incoming", description: "Units on their way to the location (transfers and purchase orders)." },
  reserved: { label: "Reserved", description: "Units set aside, for example for draft orders." },
  damaged: { label: "Damaged", description: "Units on hand that can't be sold because they are damaged." },
  safety_stock: { label: "Safety stock", description: "Units on hand held back as a buffer." },
  quality_control: { label: "Quality control", description: "Units on hand waiting for a quality check." },
};

/** One level's quantities, as stored (inventory_levels) and as the API returns them. */
export interface Quantities {
  available: number;
  onHand: number;
  committed: number;
  incoming: number;
  reserved: number;
  damaged: number;
  safetyStock: number;
  qualityControl: number;
}

/** The camelCase field of each Shopify quantity name. */
export const QUANTITY_FIELD: Record<QuantityName, keyof Quantities> = {
  available: "available",
  on_hand: "onHand",
  committed: "committed",
  incoming: "incoming",
  reserved: "reserved",
  damaged: "damaged",
  safety_stock: "safetyStock",
  quality_control: "qualityControl",
};

/** Shopify's quantities list (`[{name, quantity}]`) as a Quantities; a name it didn't send counts 0. */
export function quantitiesFrom(list: ReadonlyArray<{ name: string; quantity: number }>): Quantities {
  const q: Quantities = { available: 0, onHand: 0, committed: 0, incoming: 0, reserved: 0, damaged: 0, safetyStock: 0, qualityControl: 0 };
  for (const { name, quantity } of list) {
    const field = QUANTITY_FIELD[name as QuantityName];
    if (field) q[field] = quantity;
  }
  return q;
}

// ---------------------------------------------------------------------------
// Stock status
// ---------------------------------------------------------------------------

export type StockStatus = "in_stock" | "low" | "out" | "untracked";

export const STOCK_STATUS_INFO: Record<StockStatus, { label: string; description: string }> = {
  in_stock: { label: "In stock", description: "More units available than the low-stock threshold." },
  low: { label: "Low stock", description: "Between 1 unit and the low-stock threshold available." },
  out: { label: "Out of stock", description: "No units available (or fewer than none, when Shopify keeps selling)." },
  untracked: { label: "Not tracked", description: "Shopify doesn't track this item's stock, so it never runs out there." },
};

export const INVENTORY_DEFAULTS = {
  lowStockThreshold: 10,
  emailAlerts: true,
  dashboardAlerts: true,
  whatsappAlerts: false,
  reconcileHours: 6,
  leadTimeDays: 14,
  coverDays: 30,
} as const;

/** The threshold that applies to a variant: its own, else its product's, else the store's. */
export function effectiveThreshold(variant: number | null | undefined, product: number | null | undefined, store: number): number {
  return variant ?? product ?? store;
}

/**
 * Where `available` units put an item: out at 0 or below, low from 1 to the threshold, in stock
 * above it. `tracked` false (Shopify doesn't count its stock) is "not tracked", whatever it holds.
 */
export function stockStatus(available: number, threshold: number, tracked = true): StockStatus {
  if (!tracked) return "untracked";
  if (available <= 0) return "out";
  if (available <= threshold) return "low";
  return "in_stock";
}

// ---------------------------------------------------------------------------
// Sales-based figures
// ---------------------------------------------------------------------------

/** Days of sales the velocity, days of stock, fast- and slow-moving figures look back over. */
export const VELOCITY_DAYS = 30;
/** Fewer imported days of orders than this, and no forecast is made ("Not enough sales history"). */
export const MIN_HISTORY_DAYS = 14;
/** Fast-moving: the best sellers that together make up this share of the units sold. */
export const FAST_MOVING_SHARE = 0.8;
/** An unusual sell-off: at least this many units in a day, and this many times the usual daily rate. */
export const FAST_MOVEMENT_MIN_UNITS = 5;
export const FAST_MOVEMENT_FACTOR = 3;

/**
 * Units sold per day over `days` days, or null when the days the store's orders cover are fewer
 * than MIN_HISTORY_DAYS (a rate from a few days of sales says little).
 */
export function dailyRate(unitsSold: number, days: number): number | null {
  if (days < MIN_HISTORY_DAYS) return null;
  return Math.max(0, unitsSold) / days;
}

/** How many days `available` units last at `rate` per day; null without a rate or with no sales. */
export function daysOfStock(available: number, rate: number | null): number | null {
  if (rate === null || rate <= 0) return null;
  return Math.max(0, available) / rate;
}

/** The store-local day the stock runs out at `rate`, or null when that can't be said. */
export function depletionDay(today: string, available: number, rate: number | null): string | null {
  const days = daysOfStock(available, rate);
  if (days === null) return null;
  return addDays(today, Math.floor(days));
}

/**
 * Units to order now so the stock covers the lead time and then `coverDays` of sales: the sales
 * expected over both, less what is available and already incoming. 0 when nothing is needed, null
 * without a sales rate.
 */
export function restockQuantity(input: { available: number; incoming: number; rate: number | null; leadTimeDays: number; coverDays: number }): number | null {
  if (input.rate === null) return null;
  const need = input.rate * (input.leadTimeDays + input.coverDays) - Math.max(0, input.available) - Math.max(0, input.incoming);
  return Math.max(0, Math.ceil(need));
}

/**
 * Inventory turnover over a period: the cost of the units sold ÷ the average cost value of the
 * stock held. Null when either is unknown or the stock was worth nothing.
 */
export function inventoryTurnover(costOfUnitsSold: number | null, averageCostValue: number | null): number | null {
  if (costOfUnitsSold === null || averageCostValue === null || averageCostValue <= 0) return null;
  return costOfUnitsSold / averageCostValue;
}

/** Sell-through: units sold ÷ (units sold + units on hand now). Null with neither. */
export function sellThrough(unitsSold: number, onHand: number): number | null {
  const base = Math.max(0, unitsSold) + Math.max(0, onHand);
  return base > 0 ? Math.max(0, unitsSold) / base : null;
}

/**
 * The fast-moving variants: the best sellers that together reach FAST_MOVING_SHARE of the units
 * sold (sorted by units, most first). Returns their ids.
 */
export function fastMovers(sales: ReadonlyArray<{ id: string; units: number }>): string[] {
  const sold = sales.filter((s) => s.units > 0).sort((a, b) => b.units - a.units);
  const total = sold.reduce((n, s) => n + s.units, 0);
  const out: string[] = [];
  let running = 0;
  for (const s of sold) {
    if (running >= total * FAST_MOVING_SHARE) break;
    out.push(s.id);
    running += s.units;
  }
  return out;
}

/** Whether a day's sales are an unusual sell-off against the usual daily rate. */
export function isFastMovement(unitsToday: number, rate: number | null): boolean {
  if (rate === null) return false;
  return unitsToday >= FAST_MOVEMENT_MIN_UNITS && unitsToday >= rate * FAST_MOVEMENT_FACTOR;
}

// ---------------------------------------------------------------------------
// Stock changes made in bizinsights
// ---------------------------------------------------------------------------

/**
 * What a person can ask for, and how each reaches Shopify:
 *  - increase / decrease / correction: inventoryAdjustQuantities on `available` (a delta);
 *  - set: inventorySetQuantities on `available` (a new quantity);
 *  - stocktake: inventorySetQuantities on `on_hand` (the units counted);
 *  - damaged: inventoryMoveQuantities from `available` to `damaged` (still on hand, can't be sold).
 */
export const ADJUSTMENT_KINDS = ["increase", "decrease", "set", "correction", "damaged", "stocktake"] as const;
export type AdjustmentKind = (typeof ADJUSTMENT_KINDS)[number];

/**
 * `quantityName`: the state the change ends in (what is read back afterwards); `checks`: the state
 * whose current value the person saw, sent as changeFromQuantity so Shopify refuses the change if
 * the stock moved in the meantime.
 */
export const ADJUSTMENT_INFO: Record<AdjustmentKind, { label: string; description: string; quantityName: QuantityName; checks: QuantityName; mode: "delta" | "signed" | "absolute" }> = {
  increase: { label: "Increase", description: "Add units to what's available, for example stock received.", quantityName: "available", checks: "available", mode: "delta" },
  decrease: { label: "Decrease", description: "Take units off what's available, for example lost or given away.", quantityName: "available", checks: "available", mode: "delta" },
  set: { label: "Set quantity", description: "Replace what's available with a new number.", quantityName: "available", checks: "available", mode: "absolute" },
  correction: { label: "Correction", description: "Fix a counting mistake, up or down.", quantityName: "available", checks: "available", mode: "signed" },
  damaged: { label: "Mark damaged", description: "Move units from available to damaged: still on hand, no longer for sale.", quantityName: "damaged", checks: "available", mode: "delta" },
  stocktake: { label: "Stocktake", description: "Enter the units you counted at the location: Shopify sets what's on hand to it.", quantityName: "on_hand", checks: "on_hand", mode: "absolute" },
};

/** Shopify's reason codes a person can pick for each kind, the first being the default. */
export const ADJUSTMENT_REASONS: Record<AdjustmentKind, readonly string[]> = {
  increase: ["received", "restock", "correction", "other"],
  decrease: ["correction", "shrinkage", "promotion", "other"],
  set: ["correction", "cycle_count_available", "other"],
  correction: ["correction"],
  damaged: ["damaged"],
  stocktake: ["cycle_count_available"],
};

export const ADJUSTMENT_REASON_LABEL: Record<string, string> = {
  received: "Stock received",
  restock: "Restocked (returned to stock)",
  correction: "Correction",
  other: "Other",
  shrinkage: "Shrinkage (lost or stolen)",
  promotion: "Promotion or donation",
  cycle_count_available: "Stock count",
  damaged: "Damaged",
};

export const MAX_ADJUST_QUANTITY = 1_000_000;

export const adjustmentSchema = z
  .object({
    /** Made by the client once per confirmation dialog: the same key repeated changes stock once. */
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/, "Invalid idempotency key"),
    variantId: z.string().regex(/^\d{1,20}$/),
    locationId: z.string().regex(/^\d{1,20}$/),
    kind: z.enum(ADJUSTMENT_KINDS),
    /** The units: added or taken off (increase, decrease, damaged), signed (correction), the new quantity (set, stocktake). */
    quantity: z.number().int().min(-MAX_ADJUST_QUANTITY).max(MAX_ADJUST_QUANTITY),
    /** The quantity the person saw for the state being changed: Shopify refuses the change if it moved since. */
    expected: z.number().int().nullable(),
    reason: z.string().max(40),
    note: z.string().trim().max(500).optional(),
    referenceId: z.string().trim().max(100).optional(),
  })
  .superRefine((v, ctx) => {
    const mode = ADJUSTMENT_INFO[v.kind].mode;
    if (mode === "delta" && v.quantity <= 0) ctx.addIssue({ code: "custom", path: ["quantity"], message: "Enter a number of units above 0." });
    if (mode === "signed" && v.quantity === 0) ctx.addIssue({ code: "custom", path: ["quantity"], message: "Enter a correction other than 0." });
    if (mode === "absolute" && v.quantity < 0) ctx.addIssue({ code: "custom", path: ["quantity"], message: "The quantity can't be below 0." });
    if (!ADJUSTMENT_REASONS[v.kind].includes(v.reason)) ctx.addIssue({ code: "custom", path: ["reason"], message: "Pick one of the reasons offered." });
  });
export type AdjustmentInput = z.infer<typeof adjustmentSchema>;

/** What an adjustment changes, as Shopify is asked: a delta, or the quantity to set. */
export function adjustmentChange(input: Pick<AdjustmentInput, "kind" | "quantity">): { delta: number } | { set: number } {
  switch (input.kind) {
    case "increase":
    case "damaged":
      return { delta: input.quantity };
    case "decrease":
      return { delta: -input.quantity };
    case "correction":
      return { delta: input.quantity };
    case "set":
    case "stocktake":
      return { set: input.quantity };
  }
}

/**
 * Where an adjustment leaves the state it checks (`ADJUSTMENT_INFO.checks`), from `before`:
 * what the confirmation dialog shows as "from → to".
 */
export function adjustedQuantity(input: Pick<AdjustmentInput, "kind" | "quantity">, before: number): number {
  if (input.kind === "damaged") return before - input.quantity;
  const c = adjustmentChange(input);
  return "set" in c ? c.set : before + c.delta;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const inventorySettingsSchema = z.object({
  lowStockThreshold: z.number().int().min(0).max(100_000),
  emailAlerts: z.boolean(),
  dashboardAlerts: z.boolean(),
  whatsappAlerts: z.boolean(),
  /** An approved template's name; null to leave WhatsApp alerts without one. */
  whatsappTemplate: z.string().max(512).nullable(),
  /** Numbers to send WhatsApp alerts to, in international format. Absent: keep the stored ones. */
  whatsappTo: z.array(z.string().regex(/^\+[1-9]\d{6,14}$/, "Use the international format, e.g. +61400000000")).max(5).optional(),
  reconcileHours: z.number().int().min(1).max(24),
  leadTimeDays: z.number().int().min(0).max(365),
  coverDays: z.number().int().min(1).max(365),
});
export type InventorySettingsInput = z.infer<typeof inventorySettingsSchema>;

/** A threshold for one variant or one product; null takes it back to the one above. */
export const thresholdSchema = z.object({
  target: z.enum(["variant", "product"]),
  id: z.string().regex(/^\d{1,20}$/),
  threshold: z.number().int().min(0).max(100_000).nullable(),
});

// ---------------------------------------------------------------------------
// The stock list
// ---------------------------------------------------------------------------

export const STOCK_STATUSES = ["in_stock", "low", "out", "untracked"] as const satisfies readonly StockStatus[];
export const STOCK_SORTS = ["product", "sku", "available", "on_hand", "committed", "incoming", "value", "updated"] as const;
export type StockSort = (typeof STOCK_SORTS)[number];

/** The stock list's filters, as the API reads them from the query string (and the UI writes them). */
export const stockQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  location: z.string().regex(/^\d{1,20}$/).optional(),
  status: z.enum(STOCK_STATUSES).optional(),
  vendor: z.string().max(255).optional(),
  type: z.string().max(255).optional(),
  collection: z.string().regex(/^\d{1,20}$/).optional(),
  priceMin: z.coerce.number().min(0).optional(),
  priceMax: z.coerce.number().min(0).optional(),
  sort: z.enum(STOCK_SORTS).default("product"),
  dir: z.enum(["asc", "desc"]).default("asc"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(10).max(200).default(50),
});
export type StockQuery = z.infer<typeof stockQuerySchema>;

// ---------------------------------------------------------------------------
// What the overview's figures mean
// ---------------------------------------------------------------------------

export const INVENTORY_KPIS = [
  "products",
  "variants",
  "available",
  "onHand",
  "committed",
  "incoming",
  "lowStock",
  "outOfStock",
  "costValue",
  "retailValue",
  "unitsToday",
  "unitsMonth",
  "fastMoving",
  "slowMoving",
  "turnover",
  "daysOfStock",
] as const;
export type InventoryKpi = (typeof INVENTORY_KPIS)[number];

export const KPI_INFO: Record<InventoryKpi, { label: string; definition: string }> = {
  products: { label: "Total products", definition: "Products in your Shopify catalog that aren't archived." },
  variants: { label: "Total variants", definition: "Variants of those products: each size, colour or other option has its own stock." },
  available: { label: "Available stock", definition: "Units that can be sold now, at every location, for items whose stock Shopify tracks." },
  onHand: { label: "On-hand stock", definition: "Units physically at your locations: available, committed and unavailable (damaged, reserved, safety stock, quality control)." },
  committed: { label: "Committed stock", definition: "Units in orders that haven't been fulfilled yet." },
  incoming: { label: "Incoming stock", definition: "Units on their way to your locations, from transfers and purchase orders." },
  lowStock: { label: "Low-stock variants", definition: "Tracked variants with between 1 unit and their low-stock threshold available, counting every location." },
  outOfStock: { label: "Out-of-stock variants", definition: "Tracked variants with no units available at any location." },
  costValue: {
    label: "Inventory cost value",
    definition: "On-hand units × cost per item, for the variants whose cost is recorded in Shopify. Incomplete when some have none: their units aren't counted, and selling prices never stand in for costs.",
  },
  retailValue: { label: "Potential retail value", definition: "On-hand units × selling price. What the stock would bring in if all of it sold at today's prices: not sales, and not profit." },
  unitsToday: { label: "Units sold today", definition: "Items in today's orders (store time) less items returned, as Shopify's sales count them." },
  unitsMonth: { label: "Units sold this month", definition: "Items in this month's orders so far, less items returned, as Shopify's sales count them." },
  fastMoving: { label: "Fast-moving variants", definition: "The best sellers of the last 30 days that together make up 80% of the units sold." },
  slowMoving: { label: "Slow-moving variants", definition: "Tracked variants with stock available that sold nothing in the last 30 days." },
  turnover: {
    label: "Inventory turnover",
    definition: "The cost of the units sold in the period ÷ the average cost value of the stock held over it, from the daily stock records. Shown only when both are known for the whole period.",
  },
  daysOfStock: { label: "Days of stock left", definition: "Available units ÷ units sold per day over the last 30 days. Needs at least 14 days of imported orders." },
};
