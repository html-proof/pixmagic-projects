import type { Store, Tx } from "@app/db";
import { addDays, resolvePreset, type DateRange } from "@app/shared";
import { env } from "../env.js";
import { shopifyGraphqlWithCost } from "../shopify.js";
import { SHOPIFYQL_QUERY, type ReportFetchDeps } from "../shopifyReports.js";
import { getAccessToken } from "../tokens.js";
import { productPerformance } from "./products.js";

/** Read-only operator check, with Shopify's product report on the same store-local dates. */
export async function productCheck(tx: Tx, store: Store, deps: ReportFetchDeps, range?: DateRange, now = new Date()) {
  const yesterday = resolvePreset("yesterday", now, store.timezone).range.to;
  const window = range ?? { from: addDays(yesterday, -6), to: yesterday };
  // Validate operator-supplied dates with the same rules as the authenticated endpoint.
  const dates = resolvePreset("custom", now, store.timezone, window).range;
  const ours = await productPerformance(tx, { ws: store.workspaceId, storeId: store.id }, store, dates);
  const metadata = { shop: store.shopDomain, range: dates, timezone: store.timezone, currency: store.currency,
    complete: ours.complete, products: ours.total, historyFrom: ours.historyFrom, historyRecorded: store.ordersHistoryFrom != null,
    pendingOrders: ours.pendingOrders, unmatchedSales: ours.unmatchedSales, unknownIdentitySales: ours.unknownIdentitySales, lastSyncedAt: ours.lastSyncedAt };
  if (!store.grantedScopes.includes("read_reports")) return { ...metadata, status: "not_verifiable", reason: "read_reports not granted" };
  const query = `FROM sales SHOW net_items_sold, net_sales GROUP BY product_id SINCE ${dates.from} UNTIL ${dates.to} ORDER BY net_items_sold DESC, net_sales DESC, product_id ASC LIMIT 1000`;
  const accessToken = await getAccessToken(store, deps.coord, deps.fetchImpl);
  const { data } = await shopifyGraphqlWithCost<{ shopifyqlQuery: { parseErrors?: string[]; tableData?: { columns: Array<{ name: string }>; rows: unknown[] } } | null }>({
    shop: store.shopDomain, accessToken, apiVersion: env().SHOPIFY_API_VERSION, query: SHOPIFYQL_QUERY, variables: { query }, fetchImpl: deps.fetchImpl,
  });
  const answer = data.shopifyqlQuery;
  if (!answer?.tableData || answer.parseErrors?.length) return { ...metadata, status: "not_verifiable", reason: answer?.parseErrors ?? "Shopify withheld product report" };
  const report = answer.tableData;
  if (!["product_id", "net_items_sold", "net_sales"].every(name => report.columns.some(c => c.name === name)))
    return { ...metadata, status: "not_verifiable", reason: "Shopify omitted required product report columns" };
  const cell = (row: unknown, name: string): unknown => Array.isArray(row) ? row[report.columns.findIndex(c => c.name === name)] : row && typeof row === "object" ? (row as Record<string, unknown>)[name] : undefined;
  if (report.rows.some(r => cell(r, "product_id") != null && ["net_items_sold", "net_sales"].some(name => cell(r, name) == null || cell(r, name) === "")))
    return { ...metadata, status: "not_verifiable", reason: "Shopify returned missing product metrics" };
  const known = report.rows.filter(r => cell(r, "product_id") != null).map(r => ({ productId: String(cell(r, "product_id")).split("/").at(-1)!, units: Number(cell(r, "net_items_sold")), revenue: Number(cell(r, "net_sales")) }));
  if (known.some(r => !Number.isFinite(r.units) || !Number.isFinite(r.revenue)))
    return { ...metadata, status: "not_verifiable", reason: "Shopify returned nonnumeric product metrics" };
  const expected = known.slice(0, 100);
  const lookup = new Map(known.map(r => [r.productId, r]));
  const differences = ours.items.filter(p => p.productId !== null).flatMap(p => {
    const shopify = lookup.get(p.productId!);
    return shopify && shopify.units === p.units && Math.abs(shopify.revenue - p.revenue) < .005 ? [] : [{ productId: p.productId, ours: { units: p.units, revenue: p.revenue }, shopify: shopify ?? null }];
  });
  const missing = expected.filter(p => !ours.items.some(o => o.productId === p.productId));
  const historical = ours.items.filter(p => p.productId === null).length;
  const rankingMatches = ours.items.every((p, i) => {
    const other = expected[i];
    return !!other && (p.productId === other.productId || p.units === other.units && Math.abs(p.revenue - other.revenue) < .005);
  });
  return { ...metadata, status: !ours.complete || historical ? "not_verifiable" : differences.length || missing.length || !rankingMatches ? "difference" : "match", compared: ours.items.length - historical, rankingMatches, historicalItemsWithoutId: historical, differences, missing, query,
    note: "Shop currency, all channels, event-date sales after discounts and reversals; gift cards and unattributed order adjustments can differ from product ledger definitions." };
}
