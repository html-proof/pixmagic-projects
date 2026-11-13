import { Prisma, type Store, type Tx } from "@app/db";
import type { DateRange } from "@app/shared";
import { importedData } from "./catalog.js";
import { num, r2, SALE_UNITS, SALE_VALUE, type Scope } from "./common.js";
import { productSalesCoverage } from "./products.js";

/** Collections listed at most, the best-selling first; `total` says how many there are. */
export const COLLECTION_LIMIT = 500;

/**
 * A collection's product sales in the dates, on Top products' own terms (docs/product-performance.md):
 * net sales before tax, after discounts and returns; returns, cancellations and edits on the day
 * they were made; units as SALE_UNITS counts them; orders, the distinct orders with an item of it.
 */
export interface CollectionFigures {
  netSales: number;
  grossSales: number;
  discounts: number;
  /** What refunds, cancellations and edits of the dates took back (negative when an edit added). */
  returns: number;
  units: number;
  orders: number;
  /** Products with an order in the dates. */
  productsSold: number;
  /** Of the store's product net sales (`totals.netSales`, each sale once); null when those aren't above 0. */
  share: number | null;
}

export interface CollectionSalesRow extends CollectionFigures {
  /** Shopify's numeric collection id. */
  collectionId: string;
  title: string;
}

type Raw = {
  collection_id: string | null;
  title: string | null;
  unknown: boolean;
  total: boolean;
  units: bigint;
  net_sales: string;
  gross_sales: string;
  discounts: string;
  returns: string;
  orders: number;
  products_sold: number;
};

/**
 * Sales by collection: each Shopify collection's product sales in `range`, from Shopify's sales
 * records (order_sales). Nothing is grouped until the dates' product sales are all in and tied to
 * their products (`complete`, the check Top products makes).
 *
 * A product's collections are products.collections, as the last catalog read found them (the
 * nightly read, "Refresh data", a new product's own read; `membershipAsOf`): sales are grouped by
 * the collections their products are in now, not when they sold, as Shopify's reports group them.
 * A product in several collections counts in each, so the collections add up to more than the
 * product sales (`totals`, each sale once) and their shares to more than 100%. Sales of products in
 * no collection are `none`; those of products whose collections aren't known (not read yet, or no
 * longer in the catalog) `unknown`: never put in a collection, nor said to be in none.
 */
export async function collectionSales(tx: Tx, scope: Scope, store: Store, range: DateRange) {
  const { ws, storeId } = scope;
  const data = await importedData(tx, scope, store);
  const coverage = await productSalesCoverage(tx, scope, store, range, data.historyFrom);
  const read = await tx.syncJob.findFirst({
    where: { workspaceId: ws, storeId, kind: "products", status: "succeeded", finishedAt: { not: null } },
    orderBy: { finishedAt: "desc" },
    select: { finishedAt: true },
  });
  const about = { ...coverage, historyFrom: data.historyFrom, lastSyncedAt: store.lastSyncedAt, membershipAsOf: read?.finishedAt ?? null };
  if (!coverage.complete) return { ...about, total: 0, items: [] as CollectionSalesRow[], none: null, unknown: null, totals: null };

  const current = Prisma.sql`s.local_day BETWEEN ${range.from} AND ${range.to}`;
  const aggregates = Prisma.sql`
    COALESCE(SUM(x.units), 0)::bigint AS units,
    COALESCE(SUM(x.value), 0)::text AS net_sales,
    COALESCE(SUM(x.value + x.discount) FILTER (WHERE x.action_type = 'order'), 0)::text AS gross_sales,
    COALESCE(SUM(x.discount) FILTER (WHERE x.action_type = 'order'), 0)::text AS discounts,
    (-COALESCE(SUM(x.value) FILTER (WHERE x.action_type <> 'order'), 0))::text AS returns,
    COUNT(DISTINCT x.order_id) FILTER (WHERE x.action_type = 'order')::int AS orders,
    COUNT(DISTINCT x.product_id) FILTER (WHERE x.action_type = 'order')::int AS products_sold`;
  // One pass over the dates' product sales: grouped by collection (a sale once per collection of
  // its product), then all of them once (the totals the shares are of).
  const rows = await tx.$queryRaw<Raw[]>`
    WITH sold AS MATERIALIZED (
      -- The bounded line-item lookup Top products makes (products.ts).
      SELECT s.order_id, s.action_type, li.product_shopify_id AS product_id,
        ${SALE_UNITS} AS units, ${SALE_VALUE} AS value, s.discount
      FROM order_sales s
      JOIN LATERAL (
        SELECT li.product_shopify_id FROM order_line_items li
        WHERE li.workspace_id = ${ws} AND li.store_id = ${storeId}
          AND li.shopify_id = s.line_item_shopify_id AND li.order_id = s.order_id LIMIT 1
      ) li ON TRUE
      WHERE s.workspace_id = ${ws} AND s.store_id = ${storeId} AND s.line_type = 'product'
        AND ${current}
    ),
    -- The collections each product sold is in now: a row per collection, a single row without one
    -- for a product in none, and no row for a product whose collections aren't known.
    membership AS (
      SELECT p.shopify_id AS product_id, c.id AS collection_id, c.title
      FROM products p
      LEFT JOIN LATERAL (
        SELECT e->>'id' AS id, MAX(e->>'title') AS title
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.collections) = 'array' THEN p.collections ELSE '[]'::jsonb END) e
        WHERE e->>'id' IS NOT NULL
        GROUP BY e->>'id'
      ) c ON TRUE
      WHERE p.workspace_id = ${ws} AND p.store_id = ${storeId} AND jsonb_typeof(p.collections) = 'array'
        AND p.shopify_id IN (SELECT product_id FROM sold)
    )
    SELECT m.collection_id, MAX(m.title) AS title, m.product_id IS NULL AS unknown, FALSE AS total, ${aggregates}
    FROM sold x LEFT JOIN membership m ON m.product_id = x.product_id
    GROUP BY m.collection_id, m.product_id IS NULL
    UNION ALL
    SELECT NULL, NULL, FALSE, TRUE, ${aggregates}
    FROM sold x`;

  const all = rows.find((r) => r.total);
  const productSales = all ? r2(num(all.net_sales)) : 0;
  const figures = (r: Raw): CollectionFigures => {
    const netSales = r2(num(r.net_sales));
    const units = num(r.units);
    const orders = num(r.orders);
    return {
      netSales,
      grossSales: r2(num(r.gross_sales)),
      discounts: r2(num(r.discounts)),
      returns: r2(num(r.returns)),
      units,
      orders,
      productsSold: num(r.products_sold),
      share: productSales > 0 ? netSales / productSales : null,
    };
  };
  const groups = rows.filter((r) => !r.total);
  const items: CollectionSalesRow[] = groups
    .filter((r) => r.collection_id !== null)
    .map((r) => ({ collectionId: r.collection_id!, title: r.title ?? "", ...figures(r) }))
    .sort((a, b) => b.netSales - a.netSales || a.title.localeCompare(b.title) || a.collectionId.localeCompare(b.collectionId));
  const none = groups.find((r) => r.collection_id === null && !r.unknown);
  const unknown = groups.find((r) => r.collection_id === null && r.unknown);
  let totals: Omit<CollectionFigures, "share"> | null = null;
  if (all) {
    const { share: _share, ...rest } = figures(all);
    totals = rest;
  }
  return { ...about, total: items.length, items: items.slice(0, COLLECTION_LIMIT), none: none ? figures(none) : null, unknown: unknown ? figures(unknown) : null, totals };
}
