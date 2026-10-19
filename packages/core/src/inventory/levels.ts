/**
 * Stock levels and locations as read from Shopify, written so that the stored copy is always some
 * moment of Shopify's own state: a read older than the stored one (webhooks arrive late and out of
 * order) is never written over it, and every change seen between two reads is recorded as a
 * movement, with where it was seen (`source`).
 */
import { Prisma, systemDb, type Store } from "@app/db";
import { QUANTITY_FIELD, QUANTITY_NAMES, quantitiesFrom, type Quantities, type QuantityName } from "@app/shared";
import { gidToId } from "../normalize.js";
import type { GraphqlItemLevel, GraphqlLocation, GraphqlLocationLevel } from "../shopifyPayloads.js";

type Tx = Prisma.TransactionClient;
type StoreRef = Pick<Store, "id" | "workspaceId">;

/** How a change was seen (inventory_movements.source). */
export type MovementSource = "webhook" | "sync" | "reconcile" | "adjustment";

/** One item's level at one location, as Shopify answered. */
export interface LevelRead {
  inventoryItemId: string;
  locationId: string;
  quantities: Quantities;
  updatedAt: Date;
}

/** A quantity state stored differently from what Shopify answered. */
export interface LevelDifference {
  inventoryItemId: string;
  locationId: string;
  name: QuantityName;
  ours: number;
  shopify: number;
}

export interface ApplyResult {
  /** Levels written (new or newer than the stored one). */
  written: number;
  /** Reads older than what is stored, left out. */
  stale: number;
  /** States that changed on a level already stored. */
  differences: LevelDifference[];
  /** Items whose stock changed or appeared. */
  changedItems: string[];
}

/** A page of LOCATION_LEVELS_QUERY as LevelReads. */
export function levelsFromLocationPage(locationId: string, nodes: readonly GraphqlLocationLevel[]): LevelRead[] {
  return nodes.flatMap((n) => {
    const item = gidToId(n.item.id);
    return item ? [{ inventoryItemId: item, locationId, quantities: quantitiesFrom(n.quantities), updatedAt: new Date(n.updatedAt) }] : [];
  });
}

/** ITEM_LEVEL_QUERY's answer as a LevelRead; null when the item isn't stocked at the location. */
export function levelFromItem(locationId: string, node: GraphqlItemLevel): LevelRead | null {
  const item = gidToId(node.id);
  if (!item || !node.inventoryLevel) return null;
  return { inventoryItemId: item, locationId, quantities: quantitiesFrom(node.inventoryLevel.quantities), updatedAt: new Date(node.inventoryLevel.updatedAt) };
}

interface StoredLevel extends Quantities {
  inventoryItemId: string;
  locationId: string;
  shopifyUpdatedAt: Date;
}

const key = (item: string, location: string) => `${item}|${location}`;

/**
 * Write `reads` (any number, one store) and record what changed. In one transaction, with the
 * stored rows locked, so two writers of the same level (a page of a full pass and a webhook's
 * re-read) can't both record the same change or write an older state last. `updateTotals` also
 * sets each variant's total (`product_variants.inventory_quantity`, what the dashboard's stock card
 * reads) from its levels: only once every location's levels are stored (a finished pass).
 */
export async function applyLevels(
  store: StoreRef,
  reads: readonly LevelRead[],
  source: MovementSource,
  opts: { adjustmentId?: string; updateTotals?: boolean; now?: Date } = {},
): Promise<ApplyResult> {
  const result: ApplyResult = { written: 0, stale: 0, differences: [], changedItems: [] };
  // The newest read of each level, if one page or batch holds the same level twice.
  const latest = new Map<string, LevelRead>();
  for (const r of reads) {
    const k = key(r.inventoryItemId, r.locationId);
    const prev = latest.get(k);
    if (!prev || prev.updatedAt <= r.updatedAt) latest.set(k, r);
  }
  const rows = [...latest.values()];
  if (!rows.length) return result;
  const now = opts.now ?? new Date();

  await systemDb.$transaction(async (tx) => {
    const stored = await tx.$queryRaw<
      Array<{ inventory_item_id: string; location_shopify_id: string; available: number; on_hand: number; committed: number; incoming: number; reserved: number; damaged: number; safety_stock: number; quality_control: number; shopify_updated_at: Date }>
    >`
      SELECT l.inventory_item_id, l.location_shopify_id, l.available, l.on_hand, l.committed, l.incoming, l.reserved, l.damaged,
             l.safety_stock, l.quality_control, l.shopify_updated_at
      FROM inventory_levels l
      JOIN unnest(${rows.map((r) => r.inventoryItemId)}::text[], ${rows.map((r) => r.locationId)}::text[]) AS k(item, loc)
        ON l.inventory_item_id = k.item AND l.location_shopify_id = k.loc
      WHERE l.store_id = ${store.id}
      FOR UPDATE OF l`;
    const before = new Map<string, StoredLevel>(
      stored.map((s) => [
        key(s.inventory_item_id, s.location_shopify_id),
        {
          inventoryItemId: s.inventory_item_id,
          locationId: s.location_shopify_id,
          available: s.available,
          onHand: s.on_hand,
          committed: s.committed,
          incoming: s.incoming,
          reserved: s.reserved,
          damaged: s.damaged,
          safetyStock: s.safety_stock,
          qualityControl: s.quality_control,
          shopifyUpdatedAt: s.shopify_updated_at,
        },
      ]),
    );

    const fresh: LevelRead[] = [];
    const changed = new Set<string>();
    const moves: Array<{ read: LevelRead; name: QuantityName; before: number; after: number }> = [];
    for (const r of rows) {
      const old = before.get(key(r.inventoryItemId, r.locationId));
      if (old && old.shopifyUpdatedAt > r.updatedAt) {
        result.stale++;
        continue;
      }
      fresh.push(r);
      if (!old) {
        changed.add(r.inventoryItemId);
        continue;
      }
      for (const name of QUANTITY_NAMES) {
        const f = QUANTITY_FIELD[name];
        if (old[f] !== r.quantities[f]) {
          moves.push({ read: r, name, before: old[f], after: r.quantities[f] });
          result.differences.push({ inventoryItemId: r.inventoryItemId, locationId: r.locationId, name, ours: old[f], shopify: r.quantities[f] });
          changed.add(r.inventoryItemId);
        }
      }
    }
    if (fresh.length) await writeLevels(tx, store, fresh, now);
    result.written = fresh.length;
    if (moves.length) await recordMovements(tx, store, moves, source, opts.adjustmentId ?? null, now);
    result.changedItems = [...changed];
    if (opts.updateTotals && result.changedItems.length) await updateVariantTotals(tx, store.id, result.changedItems);
  });
  return result;
}

/** One statement for a batch, guarded so a newer stored level is never overwritten. */
async function writeLevels(tx: Tx, store: StoreRef, rows: readonly LevelRead[], now: Date) {
  const col = (f: keyof Quantities) => rows.map((r) => r.quantities[f]);
  await tx.$executeRaw`
    INSERT INTO inventory_levels (id, workspace_id, store_id, inventory_item_id, location_shopify_id, available, on_hand, committed, incoming,
                                  reserved, damaged, safety_stock, quality_control, shopify_updated_at, synced_at)
    SELECT gen_random_uuid()::text, ${store.workspaceId}, ${store.id}, s.item, s.loc, s.available, s.on_hand, s.committed, s.incoming,
           s.reserved, s.damaged, s.safety_stock, s.quality_control, (s.updated_at)::timestamptz AT TIME ZONE 'UTC', (${now.toISOString()})::timestamptz AT TIME ZONE 'UTC'
    FROM unnest(
      ${rows.map((r) => r.inventoryItemId)}::text[], ${rows.map((r) => r.locationId)}::text[],
      ${col("available")}::int[], ${col("onHand")}::int[], ${col("committed")}::int[], ${col("incoming")}::int[],
      ${col("reserved")}::int[], ${col("damaged")}::int[], ${col("safetyStock")}::int[], ${col("qualityControl")}::int[],
      ${rows.map((r) => r.updatedAt.toISOString())}::text[]
    ) AS s(item, loc, available, on_hand, committed, incoming, reserved, damaged, safety_stock, quality_control, updated_at)
    ON CONFLICT (store_id, inventory_item_id, location_shopify_id) DO UPDATE SET
      available = EXCLUDED.available, on_hand = EXCLUDED.on_hand, committed = EXCLUDED.committed, incoming = EXCLUDED.incoming,
      reserved = EXCLUDED.reserved, damaged = EXCLUDED.damaged, safety_stock = EXCLUDED.safety_stock,
      quality_control = EXCLUDED.quality_control, shopify_updated_at = EXCLUDED.shopify_updated_at, synced_at = EXCLUDED.synced_at
    WHERE inventory_levels.shopify_updated_at <= EXCLUDED.shopify_updated_at`;
}

/** The movements, with the product, variant and location names of the moment copied in. */
async function recordMovements(
  tx: Tx,
  store: StoreRef,
  moves: ReadonlyArray<{ read: LevelRead; name: QuantityName; before: number; after: number }>,
  source: MovementSource,
  adjustmentId: string | null,
  now: Date,
) {
  const items = [...new Set(moves.map((m) => m.read.inventoryItemId))];
  const locations = [...new Set(moves.map((m) => m.read.locationId))];
  const variants = await tx.$queryRaw<Array<{ inventory_item_id: string; shopify_id: string; product_shopify_id: string; title: string; sku: string | null; product_title: string | null }>>`
    SELECT v.inventory_item_id, v.shopify_id, v.product_shopify_id, v.title, v.sku, p.title AS product_title
    FROM product_variants v
    LEFT JOIN products p ON p.store_id = v.store_id AND p.shopify_id = v.product_shopify_id
    WHERE v.store_id = ${store.id} AND v.inventory_item_id = ANY(${items}::text[])`;
  const byItem = new Map(variants.map((v) => [v.inventory_item_id, v]));
  const locs = await tx.inventoryLocation.findMany({ where: { storeId: store.id, shopifyId: { in: locations } }, select: { shopifyId: true, name: true } });
  const locName = new Map(locs.map((l) => [l.shopifyId, l.name]));
  await tx.inventoryMovement.createMany({
    data: moves.map((m) => {
      const v = byItem.get(m.read.inventoryItemId);
      return {
        workspaceId: store.workspaceId,
        storeId: store.id,
        inventoryItemId: m.read.inventoryItemId,
        locationShopifyId: m.read.locationId,
        variantShopifyId: v?.shopify_id ?? null,
        productShopifyId: v?.product_shopify_id ?? null,
        productTitle: v?.product_title ?? null,
        variantTitle: v?.title ?? null,
        sku: v?.sku ?? null,
        locationName: locName.get(m.read.locationId) ?? null,
        quantityName: m.name,
        before: m.before,
        after: m.after,
        delta: m.after - m.before,
        source,
        adjustmentId,
        shopifyUpdatedAt: m.read.updatedAt,
        observedAt: now,
      };
    }),
  });
}

/**
 * Each tracked variant's total available units (Shopify's ProductVariant.inventoryQuantity: the sum
 * over its locations) from the stored levels, for `items` or every item of the store.
 */
export async function updateVariantTotals(tx: Tx | typeof systemDb, storeId: string, items?: readonly string[]) {
  if (items && !items.length) return;
  const which = items ? Prisma.sql`AND v.inventory_item_id = ANY(${[...items]}::text[])` : Prisma.sql`AND v.inventory_item_id IS NOT NULL`;
  await tx.$executeRaw`
    UPDATE product_variants v
    SET inventory_quantity = COALESCE((SELECT SUM(l.available) FROM inventory_levels l WHERE l.store_id = v.store_id AND l.inventory_item_id = v.inventory_item_id), 0)::int
    WHERE v.store_id = ${storeId} AND v.inventory_quantity IS NOT NULL ${which}`;
}

/**
 * The end of a location's levels in a full pass: levels there that the pass didn't see (read
 * before it started, and not by a webhook since) are no longer stocked there. Returns their items.
 */
export async function removeLevelsNotSeen(store: StoreRef, locationId: string, since: Date): Promise<string[]> {
  const where = { storeId: store.id, locationShopifyId: locationId, syncedAt: { lt: since } };
  const gone = await systemDb.inventoryLevel.findMany({ where, select: { inventoryItemId: true } });
  if (!gone.length) return [];
  await systemDb.inventoryLevel.deleteMany({ where });
  return gone.map((g) => g.inventoryItemId);
}

/** inventory_levels/disconnect, or a re-read that found the item no longer stocked at the location. */
export async function removeLevel(store: StoreRef, inventoryItemId: string, locationId: string, opts: { updateTotals?: boolean } = {}): Promise<boolean> {
  const { count } = await systemDb.inventoryLevel.deleteMany({ where: { storeId: store.id, inventoryItemId, locationShopifyId: locationId } });
  if (count && opts.updateTotals) await updateVariantTotals(systemDb, store.id, [inventoryItemId]);
  return count > 0;
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

function locationData(node: GraphqlLocation, now: Date) {
  const a = node.address;
  const address = a
    ? { address1: a.address1 ?? null, address2: a.address2 ?? null, city: a.city ?? null, province: a.province ?? null, zip: a.zip ?? null, country: a.country ?? null, countryCode: a.countryCode ?? null }
    : null;
  const formatted = a?.formatted?.filter(Boolean).join(", ") || null;
  return {
    name: node.name ?? "Unnamed location",
    isActive: node.isActive ?? true,
    isFulfillmentService: node.isFulfillmentService ?? false,
    fulfillsOnlineOrders: node.fulfillsOnlineOrders ?? null,
    address: address && Object.values(address).some((v) => v !== null) ? (address as Prisma.InputJsonValue) : Prisma.DbNull,
    formattedAddress: formatted,
    syncedAt: now,
    deletedAt: null,
  };
}

/** Store Shopify's locations (a page of INVENTORY_LOCATIONS_QUERY, or one location). Returns their ids. */
export async function upsertLocations(store: StoreRef, nodes: readonly GraphqlLocation[], now = new Date()): Promise<string[]> {
  const ids: string[] = [];
  for (const node of nodes) {
    const shopifyId = gidToId(node.id);
    if (!shopifyId) continue;
    const data = locationData(node, now);
    await systemDb.inventoryLocation.upsert({
      where: { storeId_shopifyId: { storeId: store.id, shopifyId } },
      create: { ...data, workspaceId: store.workspaceId, storeId: store.id, shopifyId },
      update: data,
    });
    ids.push(shopifyId);
  }
  return ids;
}

/**
 * The end of a pass's location listing: a location Shopify no longer lists is gone (kept with
 * `deletedAt`, so history still names it), and so is its stock.
 */
export async function markLocationsGone(store: StoreRef, since: Date): Promise<string[]> {
  const gone = await systemDb.inventoryLocation.findMany({ where: { storeId: store.id, deletedAt: null, syncedAt: { lt: since } }, select: { shopifyId: true } });
  for (const g of gone) await removeLocation(store, g.shopifyId);
  return gone.map((g) => g.shopifyId);
}

/** locations/delete (or a pass not finding it): the location is kept as deleted, its levels go. */
export async function removeLocation(store: StoreRef, locationId: string) {
  const items = await systemDb.inventoryLevel.findMany({ where: { storeId: store.id, locationShopifyId: locationId }, select: { inventoryItemId: true } });
  await systemDb.$transaction([
    systemDb.inventoryLevel.deleteMany({ where: { storeId: store.id, locationShopifyId: locationId } }),
    systemDb.inventoryLocation.updateMany({ where: { storeId: store.id, shopifyId: locationId, deletedAt: null }, data: { deletedAt: new Date(), isActive: false } }),
  ]);
  if (items.length && (await hasFinishedPass(store.id))) await updateVariantTotals(systemDb, store.id, items.map((i) => i.inventoryItemId));
}

/** Whether a full pass has stored every location's levels at least once (totals can then be worked out from them). */
export async function hasFinishedPass(storeId: string): Promise<boolean> {
  return (await systemDb.inventorySyncRun.count({ where: { storeId, status: "succeeded" } })) > 0;
}
