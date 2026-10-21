import { describe, expect, it } from "vitest";
import {
  adjustedQuantity,
  adjustmentChange,
  adjustmentSchema,
  dailyRate,
  daysOfStock,
  depletionDay,
  effectiveThreshold,
  fastMovers,
  inventorySettingsSchema,
  inventoryTurnover,
  isFastMovement,
  KPI_INFO,
  INVENTORY_KPIS,
  quantitiesFrom,
  restockQuantity,
  sellThrough,
  stockQuerySchema,
  stockStatus,
} from "../src/inventory";
import { ACCESS_PERMISSIONS, allows, linkSessionAccess, ROLE_TEMPLATES } from "../src/access";

describe("stock status", () => {
  it("is out at 0 or below, low from 1 to the threshold, in stock above it, and untracked whatever it holds", () => {
    expect(stockStatus(0, 10)).toBe("out");
    expect(stockStatus(-3, 10)).toBe("out"); // oversold (Shopify keeps selling)
    expect(stockStatus(1, 10)).toBe("low");
    expect(stockStatus(10, 10)).toBe("low");
    expect(stockStatus(11, 10)).toBe("in_stock");
    expect(stockStatus(0, 0)).toBe("out");
    expect(stockStatus(1, 0)).toBe("in_stock"); // a threshold of 0: only out of stock counts
    expect(stockStatus(500, 10, false)).toBe("untracked");
  });

  it("a variant's threshold beats its product's, which beats the store's", () => {
    expect(effectiveThreshold(3, 7, 10)).toBe(3);
    expect(effectiveThreshold(null, 7, 10)).toBe(7);
    expect(effectiveThreshold(undefined, null, 10)).toBe(10);
    expect(effectiveThreshold(0, 7, 10)).toBe(0);
  });

  it("reads Shopify's quantities list, every state on its own", () => {
    expect(quantitiesFrom([{ name: "available", quantity: 5 }, { name: "on_hand", quantity: 9 }, { name: "damaged", quantity: 2 }, { name: "unknown_state", quantity: 99 }])).toEqual({
      available: 5,
      onHand: 9,
      committed: 0,
      incoming: 0,
      reserved: 0,
      damaged: 2,
      safetyStock: 0,
      qualityControl: 0,
    });
  });
});

describe("forecasts only from enough sales history", () => {
  it("gives no rate with fewer than 14 days of orders", () => {
    expect(dailyRate(30, 13)).toBeNull();
    expect(dailyRate(30, 30)).toBe(1);
  });

  it("days of stock and the run-out day follow from the rate; nothing sold says nothing", () => {
    expect(daysOfStock(15, 1.5)).toBe(10);
    expect(daysOfStock(15, 0)).toBeNull();
    expect(daysOfStock(15, null)).toBeNull();
    expect(depletionDay("2026-10-19", 15, 1.5)).toBe("2026-10-29");
    expect(depletionDay("2026-10-19", 15, null)).toBeNull();
  });

  it("restock covers the lead time and the cover days, less what's available and incoming", () => {
    expect(restockQuantity({ available: 10, incoming: 5, rate: 2, leadTimeDays: 14, coverDays: 30 })).toBe(73);
    expect(restockQuantity({ available: 500, incoming: 0, rate: 2, leadTimeDays: 14, coverDays: 30 })).toBe(0);
    expect(restockQuantity({ available: 10, incoming: 0, rate: null, leadTimeDays: 14, coverDays: 30 })).toBeNull();
  });

  it("turnover and sell-through, null where they can't be said", () => {
    expect(inventoryTurnover(1200, 400)).toBe(3);
    expect(inventoryTurnover(1200, 0)).toBeNull();
    expect(inventoryTurnover(null, 400)).toBeNull();
    expect(sellThrough(25, 75)).toBe(0.25);
    expect(sellThrough(0, 0)).toBeNull();
  });

  it("fast movers are the best sellers making up 80% of the units", () => {
    expect(fastMovers([{ id: "a", units: 50 }, { id: "b", units: 30 }, { id: "c", units: 15 }, { id: "d", units: 5 }, { id: "e", units: 0 }])).toEqual(["a", "b"]);
    expect(fastMovers([])).toEqual([]);
  });

  it("an unusual sell-off needs both a floor and a multiple of the usual rate", () => {
    expect(isFastMovement(6, 1)).toBe(true);
    expect(isFastMovement(4, 0.5)).toBe(false); // under 5 units
    expect(isFastMovement(10, 5)).toBe(false); // only twice the usual
    expect(isFastMovement(10, null)).toBe(false); // no history
  });
});

describe("stock changes", () => {
  const base = { idempotencyKey: "0123456789abcdef0123", variantId: "11", locationId: "100", expected: 50 };
  it("each kind changes its state as Shopify will", () => {
    expect(adjustmentChange({ kind: "increase", quantity: 5 })).toEqual({ delta: 5 });
    expect(adjustmentChange({ kind: "decrease", quantity: 5 })).toEqual({ delta: -5 });
    expect(adjustmentChange({ kind: "correction", quantity: -2 })).toEqual({ delta: -2 });
    expect(adjustmentChange({ kind: "set", quantity: 40 })).toEqual({ set: 40 });
    expect(adjustedQuantity({ kind: "decrease", quantity: 5 }, 50)).toBe(45);
    expect(adjustedQuantity({ kind: "set", quantity: 40 }, 50)).toBe(40);
    // Damaged: available goes down by the units moved (they stay on hand).
    expect(adjustedQuantity({ kind: "damaged", quantity: 2 }, 50)).toBe(48);
  });

  it("refuses quantities and reasons that don't fit the kind", () => {
    expect(adjustmentSchema.safeParse({ ...base, kind: "increase", quantity: 5, reason: "received" }).success).toBe(true);
    expect(adjustmentSchema.safeParse({ ...base, kind: "increase", quantity: 0, reason: "received" }).success).toBe(false);
    expect(adjustmentSchema.safeParse({ ...base, kind: "increase", quantity: -1, reason: "received" }).success).toBe(false);
    expect(adjustmentSchema.safeParse({ ...base, kind: "correction", quantity: 0, reason: "correction" }).success).toBe(false);
    expect(adjustmentSchema.safeParse({ ...base, kind: "correction", quantity: -3, reason: "correction" }).success).toBe(true);
    expect(adjustmentSchema.safeParse({ ...base, kind: "set", quantity: -1, reason: "correction" }).success).toBe(false);
    expect(adjustmentSchema.safeParse({ ...base, kind: "stocktake", quantity: 0, reason: "cycle_count_available" }).success).toBe(true);
    expect(adjustmentSchema.safeParse({ ...base, kind: "damaged", quantity: 1, reason: "received" }).success).toBe(false);
    expect(adjustmentSchema.safeParse({ ...base, idempotencyKey: "short", kind: "increase", quantity: 1, reason: "received" }).success).toBe(false);
  });

  it("settings and the stock list's query are bounded", () => {
    expect(inventorySettingsSchema.safeParse({ lowStockThreshold: 5, emailAlerts: true, dashboardAlerts: true, whatsappAlerts: false, whatsappTemplate: null, reconcileHours: 0, leadTimeDays: 7, coverDays: 30 }).success).toBe(false);
    expect(inventorySettingsSchema.safeParse({ lowStockThreshold: 5, emailAlerts: true, dashboardAlerts: true, whatsappAlerts: true, whatsappTemplate: "t", whatsappTo: ["0400 000 000"], reconcileHours: 6, leadTimeDays: 7, coverDays: 30 }).success).toBe(false);
    expect(stockQuerySchema.safeParse({ pageSize: "500" }).success).toBe(false);
    expect(stockQuerySchema.parse({})).toMatchObject({ sort: "product", dir: "asc", page: 1, pageSize: 50 });
  });

  it("every overview figure has a label and a definition", () => {
    for (const k of INVENTORY_KPIS) {
      expect(KPI_INFO[k].label.length, k).toBeGreaterThan(3);
      expect(KPI_INFO[k].definition.length, k).toBeGreaterThan(20);
    }
  });
});

describe("Inventory in Team & Access", () => {
  const keys = ACCESS_PERMISSIONS.filter((p) => p.module === "inventory").map((p) => p.key);
  it("has its own permissions, the ones that change or take data out marked sensitive", () => {
    expect(keys).toEqual(["inventory.view", "inventory.products", "inventory.costs", "inventory.history", "inventory.export", "inventory.adjust", "inventory.alerts", "inventory.settings"]);
    for (const p of ACCESS_PERMISSIONS.filter((x) => x.module === "inventory" && x.kind !== "view")) expect(p.sensitive, p.key).toBe(true);
    expect(ACCESS_PERMISSIONS.find((p) => p.key === "inventory.costs")!.sensitive).toBe(true);
  });

  it("templates give viewers stock and product information, never costs or changes", () => {
    expect(ROLE_TEMPLATES.viewer).toEqual(expect.arrayContaining(["inventory.view", "inventory.products"]));
    for (const role of ["viewer", "analyst", "manager"] as const) {
      for (const k of ["inventory.costs", "inventory.export", "inventory.adjust", "inventory.alerts", "inventory.settings"]) expect(ROLE_TEMPLATES[role], `${role} ${k}`).not.toContain(k);
    }
  });

  it("a shared link never changes stock, even an owner's", () => {
    const link = linkSessionAccess({ role: "owner", permissions: [] });
    expect(allows(link, "inventory.view")).toBe(true);
    expect(allows(link, "inventory.export")).toBe(true);
    expect(allows(link, "inventory.adjust")).toBe(false);
    expect(allows(link, "inventory.settings")).toBe(false);
  });
});
