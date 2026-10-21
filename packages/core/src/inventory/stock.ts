/**
 * The stock of each variant, as SQL the reports, the snapshots and the alerts share, so they can
 * never disagree about what is low or out of stock (the rule itself: `stockStatus` in
 * @app/shared/inventory, which STATUS mirrors; packages/core/test checks they agree).
 *
 * Two sources, never mixed in one answer:
 *  - "levels": the store granted the stock-level scopes and a full pass has stored every
 *    location's levels: every quantity state, per location, summed per variant;
 *  - "variants": only Shopify's own total per variant is known (ProductVariant.inventoryQuantity,
 *    read with the catalog): available units only, no location and no other state.
 *
 * Archived products are left out, as from the catalog figures. Untracked variants are kept, with
 * their status "untracked", and left out of every stock total (they're counted on their own).
 */
import { Prisma, systemDb, type Store } from "@app/db";
import { localDay, VELOCITY_DAYS, addDays, historyStart, daysBetweenInclusive } from "@app/shared";
import { ITEM_SALES, SALE_UNITS, SALE_VALUE } from "../reports/common.js";
import { hasCapabilityScopes } from "./access.js";
import { hasFinishedPass } from "./levels.js";
import { inventorySettings } from "./settings.js";

export type StockSource = "levels" | "variants";

export interface StockScope {
  ws: string;
  storeId: string;
  /** The store's low-stock threshold (variants and products may have their own). */
  threshold: number;
  source: StockSource;
  /** Only the stock at this location (levels only). */
  location?: string | null;
}

/** Where the stock figures of a store come from now. */
export async function stockSource(store: Pick<Store, "id" | "grantedScopes">): Promise<StockSource> {
  return hasCapabilityScopes(store.grantedScopes, "stock_levels") && (await hasFinishedPass(store.id)) ? "levels" : "variants";
}

export async function stockScope(store: Pick<Store, "id" | "workspaceId" | "grantedScopes">, location?: string | null): Promise<StockScope> {
  const [settings, source] = await Promise.all([inventorySettings(store.id), stockSource(store)]);
  return { ws: store.workspaceId, storeId: store.id, threshold: settings.lowStockThreshold, source, location: source === "levels" ? (location ?? null) : null };
}

/**
 * `vs`: one row per variant of a non-archived product. Quantities are null where the source
 * doesn't know them (every state but available from "variants"; a variant whose inventory item
 * isn't known yet). `levels` counts the locations it is stocked at (null from "variants").
 */
export function variantStockCte(s: StockScope): Prisma.Sql {
  const product = Prisma.sql`
    v.shopify_id AS variant_id, v.product_shopify_id AS product_id, p.title AS product_title, p.status AS product_status,
    p.vendor, p.product_type, p.category, p.collections, p.image_url, p.handle, p.tags,
    v.title AS variant_title, v.sku, v.barcode, v.options, v.price, v.compare_at_price, v.unit_cost, v.position,
    (v.inventory_quantity IS NOT NULL) AS tracked, v.inventory_policy, v.inventory_item_id,
    COALESCE(v.low_stock_threshold, p.low_stock_threshold, ${s.threshold})::int AS threshold,
    v.shopify_updated_at AS variant_updated_at`;
  const from = Prisma.sql`
    FROM product_variants v
    JOIN products p ON p.workspace_id = ${s.ws} AND p.store_id = v.store_id AND p.shopify_id = v.product_shopify_id
    WHERE v.workspace_id = ${s.ws} AND v.store_id = ${s.storeId} AND (p.status IS NULL OR LOWER(p.status) <> 'archived')`;
  if (s.source === "variants") {
    return Prisma.sql`vs AS (
      SELECT ${product}, v.inventory_quantity AS available, NULL::int AS on_hand, NULL::int AS committed, NULL::int AS incoming,
             NULL::int AS reserved, NULL::int AS damaged, NULL::int AS safety_stock, NULL::int AS quality_control,
             NULL::int AS levels, NULL::timestamp AS stock_synced_at, v.shopify_updated_at AS stock_updated_at
      ${from})`;
  }
  const atLocation = s.location ? Prisma.sql`AND l.location_shopify_id = ${s.location}` : Prisma.empty;
  // A variant whose inventory item is known but has no level (at this location) holds none there.
  const q = (col: string) => Prisma.sql`CASE WHEN v.inventory_item_id IS NULL THEN NULL ELSE COALESCE(lv.${Prisma.raw(col)}, 0) END`;
  return Prisma.sql`vs AS (
    SELECT ${product},
           CASE WHEN v.inventory_item_id IS NULL THEN v.inventory_quantity ELSE COALESCE(lv.available, 0) END AS available,
           ${q("on_hand")} AS on_hand, ${q("committed")} AS committed, ${q("incoming")} AS incoming, ${q("reserved")} AS reserved,
           ${q("damaged")} AS damaged, ${q("safety_stock")} AS safety_stock, ${q("quality_control")} AS quality_control,
           COALESCE(lv.levels, 0) AS levels, lv.synced_at AS stock_synced_at, lv.updated_at AS stock_updated_at
    FROM product_variants v
    JOIN products p ON p.workspace_id = ${s.ws} AND p.store_id = v.store_id AND p.shopify_id = v.product_shopify_id
    LEFT JOIN LATERAL (
      SELECT SUM(l.available)::int AS available, SUM(l.on_hand)::int AS on_hand, SUM(l.committed)::int AS committed,
             SUM(l.incoming)::int AS incoming, SUM(l.reserved)::int AS reserved, SUM(l.damaged)::int AS damaged,
             SUM(l.safety_stock)::int AS safety_stock, SUM(l.quality_control)::int AS quality_control,
             COUNT(*)::int AS levels, MAX(l.synced_at) AS synced_at, MAX(l.shopify_updated_at) AS updated_at
      FROM inventory_levels l
      JOIN inventory_locations loc ON loc.store_id = l.store_id AND loc.shopify_id = l.location_shopify_id AND loc.deleted_at IS NULL
      WHERE l.store_id = v.store_id AND l.workspace_id = ${s.ws} AND l.inventory_item_id = v.inventory_item_id ${atLocation}
    ) lv ON true
    WHERE v.workspace_id = ${s.ws} AND v.store_id = ${s.storeId} AND (p.status IS NULL OR LOWER(p.status) <> 'archived')
      ${s.location ? Prisma.sql`AND COALESCE(lv.levels, 0) > 0` : Prisma.empty})`;
}

/** A `vs` row's status, as `stockStatus` (@app/shared/inventory) decides it. */
export const STATUS = Prisma.sql`(CASE WHEN NOT tracked OR available IS NULL THEN 'untracked' WHEN available <= 0 THEN 'out' WHEN available <= threshold THEN 'low' ELSE 'in_stock' END)`;

/**
 * `sold`: items sold per variant (`units`) and their net sales before tax (`revenue`, text) from
 * the sales that happened `from`..`to` (store-local days), read from Shopify's sales records
 * (order_sales) exactly as the dashboard's top products read them (`SALE_UNITS`): an order's
 * items count, a return's come off, a cancelled order's reversal takes its items back out, an
 * order never read yet counts as placed. Test orders are never stored.
 */
export function soldCte(scope: Pick<StockScope, "ws" | "storeId">, from: string, to: string, name = "sold"): Prisma.Sql {
  return Prisma.sql`${Prisma.raw(name)} AS (
    SELECT li.variant_shopify_id AS variant_id, SUM(${SALE_UNITS})::int AS units, SUM(${SALE_VALUE})::text AS revenue
    FROM order_sales s
    JOIN order_line_items li ON li.store_id = s.store_id AND li.shopify_id = s.line_item_shopify_id
    WHERE s.workspace_id = ${scope.ws} AND s.store_id = ${scope.storeId} AND li.workspace_id = ${scope.ws}
      AND ${ITEM_SALES} AND s.local_day BETWEEN ${from} AND ${to} AND li.variant_shopify_id IS NOT NULL
    GROUP BY li.variant_shopify_id)`;
}

/**
 * How many of the last VELOCITY_DAYS days (today included) the store's imported orders cover,
 * for the sales rates: fewer than MIN_HISTORY_DAYS and no rate is given.
 */
export async function salesDays(store: Pick<Store, "id" | "workspaceId" | "ordersHistoryFrom" | "timezone">, today: string): Promise<{ from: string; days: number; historyFrom: string | null }> {
  const from = addDays(today, -(VELOCITY_DAYS - 1));
  const [oldest] = await systemDb.$queryRaw<Array<{ day: string | null }>>`
    SELECT MIN(local_day) AS day FROM orders WHERE workspace_id = ${store.workspaceId} AND store_id = ${store.id}`;
  const start = historyStart(store.ordersHistoryFrom, store.timezone, oldest?.day ?? null);
  if (!start) return { from, days: 0, historyFrom: null };
  const covered = start > from ? start : from;
  return { from: covered, days: covered > today ? 0 : daysBetweenInclusive(covered, today), historyFrom: start };
}

// ---------------------------------------------------------------------------
// Daily snapshots
// ---------------------------------------------------------------------------

/**
 * Record the store's stock as of now under today's date (store time), storewide and per
 * location; written again through the day, so the last write is the day's close. From the levels
 * only: a store without them has no history to chart.
 */
export async function takeSnapshot(store: Pick<Store, "id" | "workspaceId" | "grantedScopes" | "timezone">, now = new Date()): Promise<boolean> {
  const scope = await stockScope(store);
  if (scope.source !== "levels") return false;
  const day = localDay(now, store.timezone);
  const totals = (where: Prisma.Sql) => Prisma.sql`
    SELECT COUNT(*) FILTER (WHERE tracked)::int AS tracked_variants,
           COUNT(*) FILTER (WHERE NOT tracked)::int AS untracked_variants,
           COALESCE(SUM(available) FILTER (WHERE tracked), 0)::int AS available,
           COALESCE(SUM(on_hand) FILTER (WHERE tracked), 0)::int AS on_hand,
           COALESCE(SUM(committed) FILTER (WHERE tracked), 0)::int AS committed,
           COALESCE(SUM(incoming) FILTER (WHERE tracked), 0)::int AS incoming,
           COUNT(*) FILTER (WHERE ${STATUS} = 'low')::int AS low_stock,
           COUNT(*) FILTER (WHERE ${STATUS} = 'out')::int AS out_of_stock,
           SUM(GREATEST(on_hand, 0) * unit_cost) FILTER (WHERE tracked AND on_hand > 0)::text AS cost_value,
           COUNT(*) FILTER (WHERE tracked AND on_hand > 0 AND unit_cost IS NOT NULL)::int AS variants_with_cost,
           COUNT(*) FILTER (WHERE tracked AND on_hand > 0)::int AS variants_in_stock,
           COALESCE(SUM(GREATEST(on_hand, 0) * price) FILTER (WHERE tracked), 0)::text AS retail_value
    FROM vs ${where}`;
  type Row = { tracked_variants: number; untracked_variants: number; available: number; on_hand: number; committed: number; incoming: number; low_stock: number; out_of_stock: number; cost_value: string | null; variants_with_cost: number; variants_in_stock: number; retail_value: string };
  const write = async (locationKey: string, r: Row | undefined) => {
    if (!r) return;
    const data = {
      trackedVariants: r.tracked_variants,
      untrackedVariants: r.untracked_variants,
      available: r.available,
      onHand: r.on_hand,
      committed: r.committed,
      incoming: r.incoming,
      lowStock: r.low_stock,
      outOfStock: r.out_of_stock,
      costValue: r.variants_with_cost ? r.cost_value : null,
      variantsWithCost: r.variants_with_cost,
      variantsInStock: r.variants_in_stock,
      retailValue: r.retail_value,
      takenAt: now,
    };
    await systemDb.inventorySnapshot.upsert({
      where: { storeId_day_locationKey: { storeId: store.id, day, locationKey } },
      create: { workspaceId: store.workspaceId, storeId: store.id, day, locationKey, ...data },
      update: data,
    });
  };
  const [all] = await systemDb.$queryRaw<Row[]>`WITH ${variantStockCte(scope)} ${totals(Prisma.empty)}`;
  await write("all", all);
  const locations = await systemDb.inventoryLocation.findMany({ where: { storeId: store.id, deletedAt: null }, select: { shopifyId: true } });
  for (const loc of locations) {
    const [r] = await systemDb.$queryRaw<Row[]>`WITH ${variantStockCte({ ...scope, location: loc.shopifyId })} ${totals(Prisma.empty)}`;
    await write(loc.shopifyId, r);
  }
  return true;
}
