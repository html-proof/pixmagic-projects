import { describe, expect, it } from "vitest";
import { PRODUCT_SORTS, rankProducts, type ProductMetrics } from "../src/reports/products.js";

function product(key: string, units: number, revenue = units * 10): ProductMetrics {
  return { key, productId: key, title: key, imageUrl: null, sku: null, units, revenue,
    grossUnits: units, returnedUnits: 0, grossSales: revenue, discounts: 0, returns: 0, orders: units, activeDays: 3, recentUnits: units, lastSold: null };
}
describe("product ranking over the entire aggregated population", () => {
  it("ranks net units first, revenue second and stable IDs third, including returns-only products", () => {
    const rows = [product("z", 10, 20), product("b", 10, 30), product("a", 10, 30), product("return", -2, -40), product("highRevenue", 2, 900)];
    expect(rankProducts(rows).items.map(p => p.key)).toEqual(["a", "b", "z", "highRevenue", "return"]);
  });
  it("ranks before applying the top 100 cap and pagination", () => {
    const rows = Array.from({ length: 150 }, (_, i) => product(String(i), i));
    const result = rankProducts(rows, { limit: 25, page: 4 });
    expect(result.total).toBe(100);
    expect(result.items[0]).toMatchObject({ key: "74", rank: 76 });
    expect(result.items.at(-1)).toMatchObject({ key: "50", rank: 100 });
  });
  it("sorts each mode across the full population", () => {
    const rows = [product("new", 10, 10), { ...product("returns", 2, 200), returnedUnits: 20 }, product("most", 20, 100)];
    expect(rankProducts(rows, { sortBy: "units" }).items[0]!.key).toBe("most");
    expect(rankProducts(rows, { sortBy: "revenue" }).items[0]!.key).toBe("returns");
    expect(rankProducts(rows, { sortBy: "returned" }).items[0]!.key).toBe("returns");
    expect(rankProducts(rows, { sortBy: "lowest" }).items[0]!.key).toBe("returns");
    expect(rankProducts(rows, { sortBy: "units", direction: "asc" }).items.map(p => p.key)).toEqual(["returns", "new", "most"]);
  });
  it("ranks on the dates' own figures only: nothing of the period before", () => {
    expect(PRODUCT_SORTS).toEqual(["units", "revenue", "returned", "lowest"]);
    const ranked = rankProducts([product("only", 6)]).items[0]!;
    for (const k of ["growth", "trend", "trendScore", "previousUnits", "previousRevenue"]) expect(ranked).not.toHaveProperty(k);
  });
});
