import { describe, expect, it } from "vitest";
import { rankProducts, type ProductMetrics } from "../src/reports/products.js";

function product(key: string, units: number, revenue = units * 10, previousUnits = 0): ProductMetrics {
  return { key, productId: key, title: key, imageUrl: null, sku: null, units, revenue, previousUnits, previousRevenue: previousUnits * 10,
    grossUnits: units, returnedUnits: 0, grossSales: revenue, discounts: 0, returns: 0, orders: units, activeDays: 3, recentUnits: units, lastSold: null };
}
describe("product ranking over the entire aggregated population", () => {
  it("ranks net units first, revenue second and stable IDs third, including returns-only products", () => {
    const rows = [product("z", 10, 20), product("b", 10, 30), product("a", 10, 30), product("return", -2, -40), product("highRevenue", 2, 900)];
    expect(rankProducts(rows, 7, true).items.map(p => p.key)).toEqual(["a", "b", "z", "highRevenue", "return"]);
  });
  it("ranks before applying the top 100 cap and pagination", () => {
    const rows = Array.from({ length: 150 }, (_, i) => product(String(i), i));
    const result = rankProducts(rows, 7, true, { limit: 25, page: 4 });
    expect(result.total).toBe(100);
    expect(result.items[0]).toMatchObject({ key: "74", rank: 76 });
    expect(result.items.at(-1)).toMatchObject({ key: "50", rank: 100 });
  });
  it("uses a finite New state and never invents growth without baseline history", () => {
    expect(rankProducts([product("new", 6)], 7, true).items[0]).toMatchObject({ growth: null, trend: "New" });
    expect(rankProducts([product("old", 6, 60, 3)], 7, false).items[0]).toMatchObject({ growth: null, trend: "No baseline", trendScore: null });
  });
  it("calculates growth from net units and normalizes trending with a minimum sales threshold", () => {
    const result = rankProducts([product("one", 1), product("established", 40, 400, 20)], 7, true, { sortBy: "trending" });
    expect(result.items[0]).toMatchObject({ key: "established", growth: 100, trend: "Rising" });
    expect(result.items[0]!.trendScore).toBeGreaterThan(0);
    expect(result.items[0]!.trendScore).toBeLessThanOrEqual(100);
    expect(result.items[1]!.trendScore).toBe(0);
  });
  it("sorts each mode across the full population and keeps unavailable growth last", () => {
    const rows = [product("new", 10, 10), { ...product("returns", 2, 200, 1), returnedUnits: 20 }, product("growth", 20, 100, 2)];
    expect(rankProducts(rows, 7, true, { sortBy: "revenue" }).items[0]!.key).toBe("returns");
    expect(rankProducts(rows, 7, true, { sortBy: "returned" }).items[0]!.key).toBe("returns");
    expect(rankProducts(rows, 7, true, { sortBy: "growth" }).items[0]!.key).toBe("growth");
    expect(rankProducts(rows, 7, true, { sortBy: "lowest" }).items[0]!.key).toBe("returns");
  });
});
