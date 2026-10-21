import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Store, Tx } from "@app/db";
const mocks = vi.hoisted(() => ({ performance: vi.fn(), graphql: vi.fn() }));
vi.mock("../src/reports/products.js", () => ({ productPerformance: mocks.performance }));
vi.mock("../src/tokens.js", () => ({ getAccessToken: async () => "test-token" }));
vi.mock("../src/shopify.js", () => ({ shopifyGraphqlWithCost: mocks.graphql }));
vi.mock("../src/env.js", () => ({ env: () => ({ SHOPIFY_API_VERSION: "2026-10" }) }));
import { productCheck } from "../src/reports/productCheck.js";
const store = { id: "s", workspaceId: "w", shopDomain: "test.myshopify.com", timezone: "Asia/Kolkata", currency: "INR", grantedScopes: ["read_reports"] } as Store;
const deps = { coord: {} as Parameters<typeof productCheck>[2]["coord"], fetchImpl: vi.fn() };
const check = () => productCheck({} as Tx, store, deps, { from: "2026-03-08", to: "2026-03-09" }, new Date("2026-03-10T10:00:00Z"));
const answer = (rows: unknown[], columns = ["product_id", "net_items_sold", "net_sales"]) => ({ data: { shopifyqlQuery: { parseErrors: [], tableData: { columns: columns.map(name => ({name})), rows } } } });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.performance.mockResolvedValue({ complete: true, total: 1, historyFrom: "1970-01-01", items: [{ productId: "123", units: 4, revenue: 36.67 }] });
});
describe("read-only product reconciliation against Shopify reports", () => {
  it("compares shop-currency units and net sales on identical dates", async () => {
    mocks.graphql.mockResolvedValue(answer([["gid://shopify/Product/123", "4", "36.67"]]));
    expect(await check()).toMatchObject({ status: "match", compared: 1, rankingMatches: true, timezone: "Asia/Kolkata", currency: "INR" });
    expect(mocks.graphql.mock.calls[0]![0].variables.query).toContain("SINCE 2026-03-08 UNTIL 2026-03-09");
  });
  it("reports financial differences rather than forcing agreement", async () => {
    mocks.graphql.mockResolvedValue(answer([{ product_id: "123", net_items_sold: 4, net_sales: 40 }]));
    expect(await check()).toMatchObject({ status: "difference", differences: [{ productId: "123", shopify: { units: 4, revenue: 40 } }] });
  });
  it("does not certify incomplete history", async () => {
    mocks.performance.mockResolvedValue({ complete: false, total: 0, items: [] });
    mocks.graphql.mockResolvedValue(answer([["123", 4, 40]]));
    expect(await check()).toMatchObject({ status: "not_verifiable" });
  });
  it("does not turn missing columns or a refused query into zero sales", async () => {
    mocks.graphql.mockResolvedValue(answer([["123", 4]], ["product_id", "net_items_sold"]));
    expect(await check()).toMatchObject({ status: "not_verifiable", reason: "Shopify omitted required product report columns" });
    mocks.graphql.mockResolvedValue({ data: { shopifyqlQuery: { parseErrors: ["unsupported metric"] } } });
    expect(await check()).toMatchObject({ status: "not_verifiable", reason: ["unsupported metric"] });
  });
});
