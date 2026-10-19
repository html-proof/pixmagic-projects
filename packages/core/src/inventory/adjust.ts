/**
 * Changing stock in Shopify from bizinsights. The rules:
 *
 *  - Shopify is the record. Nothing is written to the stored stock until Shopify has confirmed the
 *    change (an inventoryAdjustmentGroup and no userErrors), and then only what Shopify answers
 *    when the level is read back.
 *  - Once only. The client's idempotency key is the adjustment row's key and Shopify's
 *    @idempotent(key:), so a retried request (a double click, a network failure, a timeout) can't
 *    change stock twice: a settled key answers with its outcome, an unconfirmed one is sent again
 *    with the same key, which Shopify applies at most once.
 *  - Against what the person saw. The quantity they saw goes as changeFromQuantity: if the stock
 *    moved in the meantime (a sale, another person, another app) Shopify refuses, and they see the
 *    new number. Changes to one item at one location also take a lock, so two of ours never race.
 *  - A record either way: the row is written "pending" first and settled once (a trigger refuses any
 *    other edit), with the reason, note, reference and who asked; the workspace audit log too.
 */
import { Prisma, systemDb, type InventoryAdjustment, type Store } from "@app/db";
import { ADJUSTMENT_INFO, QUANTITY_FIELD, adjustmentChange, type AdjustmentInput } from "@app/shared";
import type { Coord } from "../coord.js";
import { AppError } from "../errors.js";
import { logger } from "../logger.js";
import { audit } from "../notify.js";
import { ShopifyGraphqlError, ShopifyHttpError } from "../shopify.js";
import { StoreDisconnectedError } from "../tokens.js";
import { hasCapabilityScopes } from "./access.js";
import { evaluateStockAlerts } from "./alerts.js";
import { applyLevels, hasFinishedPass, levelFromItem, removeLevel } from "./levels.js";
import { adjustmentUri, INVENTORY_ADJUST_MUTATION, INVENTORY_MOVE_MUTATION, INVENTORY_SET_MUTATION, ITEM_LEVEL_QUERY, itemGid, LEVEL_NAMES, locationGid } from "./queries.js";
import { graphqlItemLevelSchema, parseShopify } from "../shopifyPayloads.js";
import type { InventoryGql } from "./shopify.js";

export class InventoryError extends AppError {
  constructor(status: 400 | 403 | 404 | 409 | 422 | 502, code: string, message: string, detail?: unknown) {
    super(message, status, code, detail);
    this.name = "InventoryError";
  }
}

export interface AdjustDeps {
  coord: Coord;
  gql: InventoryGql;
}

const LOCK_MS = 60_000;

type UserError = { field?: string[] | null; message: string; code?: string | null };
type MutationAnswer = { inventoryAdjustmentGroup: { id: string } | null; userErrors: UserError[] };

/** What a person is told about an adjustment (GET and POST .../inventory/adjustments). */
export function adjustmentView(a: InventoryAdjustment) {
  return {
    id: a.id,
    status: a.status,
    kind: a.kind,
    quantityName: a.quantityName,
    reason: a.reason,
    note: a.note,
    referenceId: a.referenceId,
    delta: a.delta,
    quantity: a.quantity,
    expectedBefore: a.expectedBefore,
    resultQuantity: a.resultQuantity,
    errorCode: a.errorCode,
    variantId: a.variantShopifyId,
    productId: a.productShopifyId,
    productTitle: a.productTitle,
    variantTitle: a.variantTitle,
    sku: a.sku,
    locationId: a.locationShopifyId,
    locationName: a.locationName,
    actorUserId: a.actorUserId,
    createdAt: a.createdAt,
    completedAt: a.completedAt,
  };
}
export type AdjustmentView = ReturnType<typeof adjustmentView>;

/** Shopify's userErrors in our words (its own message goes to the logs only). */
function refusal(errors: UserError[]): { code: string; status: 409 | 422; message: string } {
  const codes = errors.map((e) => (e.code ?? "").toUpperCase());
  const has = (...parts: string[]) => codes.some((c) => parts.some((p) => c.includes(p)));
  if (has("STALE", "COMPARE_QUANTITY", "CHANGE_FROM")) {
    return { code: "stock_changed", status: 409, message: "The stock changed in Shopify since you looked. Check the new number and try again." };
  }
  if (has("IDEMPOTENCY_CONCURRENT")) return { code: "in_progress", status: 409, message: "This change is still being made. Wait a moment, then check the stock." };
  if (has("NOT_STOCKED", "ITEM_NOT_STOCKED", "LOCATION_NOT_FOUND", "INVALID_LOCATION")) {
    return { code: "not_stocked", status: 409, message: "Shopify doesn't stock this item at that location. Add it to the location in Shopify first." };
  }
  if (has("NON_MUTABLE", "NOT_TRACKED", "UNTRACKED")) return { code: "untracked", status: 409, message: "Shopify doesn't track this item's stock. Turn on tracking for it in Shopify first." };
  if (has("QUANTITY", "NEGATIVE", "TOO_HIGH", "TOO_LOW")) return { code: "invalid_quantity", status: 422, message: "Shopify doesn't accept that quantity for this item." };
  return { code: "shopify_refused", status: 422, message: "Shopify refused the change. Nothing was changed." };
}

/** The mutation and variables that make `input` in Shopify. */
function mutationFor(input: AdjustmentInput, row: { id: string; inventoryItemId: string; locationShopifyId: string }, expected: number | null) {
  const item = itemGid(row.inventoryItemId);
  const location = locationGid(row.locationShopifyId);
  const uri = adjustmentUri(row.id);
  const change = adjustmentChange(input);
  if (input.kind === "damaged") {
    return {
      query: INVENTORY_MOVE_MUTATION,
      field: "inventoryMoveQuantities",
      input: {
        reason: input.reason,
        referenceDocumentUri: uri,
        changes: [
          {
            inventoryItemId: item,
            quantity: input.quantity,
            from: { locationId: location, name: "available", changeFromQuantity: expected, ledgerDocumentUri: null },
            to: { locationId: location, name: "damaged", changeFromQuantity: null, ledgerDocumentUri: uri },
          },
        ],
      },
    };
  }
  if ("set" in change) {
    return {
      query: INVENTORY_SET_MUTATION,
      field: "inventorySetQuantities",
      input: {
        name: ADJUSTMENT_INFO[input.kind].checks,
        reason: input.reason,
        referenceDocumentUri: uri,
        quantities: [{ inventoryItemId: item, locationId: location, quantity: change.set, changeFromQuantity: expected }],
      },
    };
  }
  return {
    query: INVENTORY_ADJUST_MUTATION,
    field: "inventoryAdjustQuantities",
    input: {
      name: "available",
      reason: input.reason,
      referenceDocumentUri: uri,
      changes: [{ inventoryItemId: item, locationId: location, delta: change.delta, changeFromQuantity: expected }],
    },
  };
}

/** True for a failure after which Shopify may or may not have made the change. */
function unconfirmed(err: unknown): boolean {
  if (err instanceof ShopifyHttpError) return err.retryable;
  if (err instanceof ShopifyGraphqlError) return err.codes.includes("THROTTLED") || err.codes.includes("INTERNAL_SERVER_ERROR");
  return !(err instanceof AppError) && !(err instanceof StoreDisconnectedError);
}

/** Read one level back from Shopify and store it; returns it (null: not stocked there any more). */
async function readBack(deps: AdjustDeps, store: Store, inventoryItemId: string, locationId: string, source: "adjustment" | "sync", adjustmentId?: string) {
  const d = await deps.gql<{ inventoryItem: unknown }>(ITEM_LEVEL_QUERY, { item: itemGid(inventoryItemId), location: locationGid(locationId), names: LEVEL_NAMES });
  const node = d.inventoryItem ? parseShopify(graphqlItemLevelSchema, d.inventoryItem, "GraphQL inventory level", { storeId: store.id }) : null;
  const totals = await hasFinishedPass(store.id);
  const read = node ? levelFromItem(locationId, node) : null;
  if (!read) {
    await removeLevel(store, inventoryItemId, locationId, { updateTotals: totals });
    return null;
  }
  await applyLevels(store, [read], source, { adjustmentId, updateTotals: totals });
  return read;
}

/** Make the change `input` asks for, as `actorUserId`. Throws InventoryError with what to tell them. */
export async function adjustStock(deps: AdjustDeps, store: Store, actor: { userId: string | null; ip?: string }, input: AdjustmentInput): Promise<AdjustmentView> {
  if (!hasCapabilityScopes(store.grantedScopes, "stock_adjustments")) {
    throw new InventoryError(409, "scope_missing", "Changing stock needs your permission in Shopify first. An owner or admin can give it in Inventory → Stock settings.");
  }
  const variant = await systemDb.productVariant.findUnique({ where: { storeId_shopifyId: { storeId: store.id, shopifyId: input.variantId } } });
  if (!variant) throw new InventoryError(404, "not_found", "That product variant wasn't found. It may have been deleted in Shopify.");
  if (variant.inventoryQuantity === null) throw new InventoryError(409, "untracked", "Shopify doesn't track this item's stock. Turn on tracking for it in Shopify first.");
  if (!variant.inventoryItemId) throw new InventoryError(409, "not_synced", "This item's stock details are still being imported from Shopify. Try again in a few minutes.");
  const location = await systemDb.inventoryLocation.findUnique({ where: { storeId_shopifyId: { storeId: store.id, shopifyId: input.locationId } } });
  if (!location || location.deletedAt) throw new InventoryError(404, "not_found", "That location wasn't found. It may have been removed in Shopify.");
  if (!location.isActive) throw new InventoryError(409, "location_inactive", "That location is deactivated in Shopify, so its stock can't change.");
  const product = await systemDb.product.findUnique({ where: { storeId_shopifyId: { storeId: store.id, shopifyId: variant.productShopifyId } }, select: { title: true } });

  const same = (a: InventoryAdjustment) =>
    a.inventoryItemId === variant.inventoryItemId && a.locationShopifyId === location.shopifyId && a.kind === input.kind && (a.delta ?? a.quantity) === (input.kind === "set" || input.kind === "stocktake" ? input.quantity : signedDelta(input));
  let row = await systemDb.inventoryAdjustment.findUnique({ where: { storeId_idempotencyKey: { storeId: store.id, idempotencyKey: input.idempotencyKey } } });
  if (row && !same(row)) throw new InventoryError(409, "key_reused", "This request doesn't match the change it was first sent for. Start the change again.");
  if (row && (row.status === "confirmed" || row.status === "failed")) return adjustmentView(row);

  const lock = `inventory-adjust:${store.id}:${variant.inventoryItemId}:${location.shopifyId}`;
  if (!(await deps.coord.acquire(lock, LOCK_MS))) throw new InventoryError(409, "in_progress", "Another change to this item's stock at this location is being made. Wait a moment and try again.");
  try {
    // The value checked: what the person saw, else the stored copy of Shopify's.
    const checks = ADJUSTMENT_INFO[input.kind].checks;
    const level = await systemDb.inventoryLevel.findUnique({
      where: { storeId_inventoryItemId_locationShopifyId: { storeId: store.id, inventoryItemId: variant.inventoryItemId, locationShopifyId: location.shopifyId } },
    });
    const expected = input.expected ?? (level ? level[QUANTITY_FIELD[checks]] : null);
    if (!row) {
      const change = adjustmentChange(input);
      try {
        row = await systemDb.inventoryAdjustment.create({
          data: {
            workspaceId: store.workspaceId,
            storeId: store.id,
            idempotencyKey: input.idempotencyKey,
            actorUserId: actor.userId,
            inventoryItemId: variant.inventoryItemId,
            locationShopifyId: location.shopifyId,
            variantShopifyId: variant.shopifyId,
            productShopifyId: variant.productShopifyId,
            productTitle: product?.title ?? null,
            variantTitle: variant.title,
            sku: variant.sku,
            locationName: location.name,
            kind: input.kind,
            quantityName: ADJUSTMENT_INFO[input.kind].quantityName,
            reason: input.reason,
            note: input.note || null,
            referenceId: input.referenceId || null,
            delta: "delta" in change ? change.delta : null,
            quantity: "set" in change ? change.set : null,
            expectedBefore: expected,
            status: "pending",
          },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw new InventoryError(409, "in_progress", "This change is already being made. Wait a moment, then check the stock.");
        }
        throw err;
      }
    }

    const m = mutationFor(input, row, row.expectedBefore);
    let answer: MutationAnswer | null = null;
    let lastErr: unknown = null;
    // A failure Shopify may have acted on is sent again once with the same key: applied at most once.
    for (let attempt = 0; attempt < 2 && !answer; attempt++) {
      try {
        const d = await deps.gql<Record<string, MutationAnswer>>(m.query, { input: m.input, key: input.idempotencyKey });
        answer = d[m.field] ?? null;
        if (!answer) throw new Error(`Shopify answered ${m.field} with nothing`);
      } catch (err) {
        lastErr = err;
        answer = null;
        if (!unconfirmed(err)) break;
      }
    }
    if (!answer) {
      const id = row.id;
      if (lastErr instanceof StoreDisconnectedError || (lastErr instanceof ShopifyHttpError && (lastErr.status === 401 || lastErr.status === 403))) {
        await settle(id, { status: "failed", errorCode: "store_disconnected" });
        throw new InventoryError(409, "store_disconnected", "Shopify no longer accepts bizinsights' access to this store. Reconnect it in Settings → Stores.");
      }
      if (lastErr instanceof ShopifyGraphqlError && lastErr.codes.includes("ACCESS_DENIED")) {
        await settle(id, { status: "failed", errorCode: "scope_missing" });
        throw new InventoryError(409, "scope_missing", "Shopify didn't let bizinsights change stock. An owner or admin can give the permission in Inventory → Stock settings.");
      }
      logger.warn({ err: lastErr, storeId: store.id, adjustmentId: id }, "stock change not confirmed by Shopify");
      await settle(id, { status: "unknown", errorCode: "unconfirmed" });
      throw new InventoryError(502, "unconfirmed", "Shopify didn't confirm the change, so nothing is shown as changed. Try again: the same change is never made twice.", { adjustmentId: id });
    }
    if (answer.userErrors.length || !answer.inventoryAdjustmentGroup) {
      const r = refusal(answer.userErrors);
      logger.info({ storeId: store.id, adjustmentId: row.id, codes: answer.userErrors.map((e) => e.code), messages: answer.userErrors.map((e) => e.message) }, "Shopify refused a stock change");
      if (r.code === "in_progress") {
        await settle(row.id, { status: "unknown", errorCode: r.code });
        throw new InventoryError(r.status, r.code, r.message, { adjustmentId: row.id });
      }
      await settle(row.id, { status: "failed", errorCode: r.code });
      // What the stock is now, so they can decide again with the right number.
      const now = r.code === "stock_changed" ? await readBack(deps, store, row.inventoryItemId, row.locationShopifyId, "sync").catch(() => null) : null;
      throw new InventoryError(r.status, r.code, r.message, { adjustmentId: row.id, current: now ? now.quantities[QUANTITY_FIELD[checks]] : undefined });
    }

    // Confirmed. Read the level back (best effort: a webhook brings it otherwise) and settle.
    let after: Awaited<ReturnType<typeof readBack>> | undefined;
    try {
      const d = await deps.gql<{ inventoryItem: unknown }>(ITEM_LEVEL_QUERY, { item: itemGid(row.inventoryItemId), location: locationGid(row.locationShopifyId), names: LEVEL_NAMES });
      const node = d.inventoryItem ? parseShopify(graphqlItemLevelSchema, d.inventoryItem, "GraphQL inventory level", { storeId: store.id }) : null;
      after = node ? levelFromItem(row.locationShopifyId, node) : null;
    } catch (err) {
      logger.warn({ err, storeId: store.id, adjustmentId: row.id }, "couldn't read the stock back after a confirmed change; the webhook brings it");
    }
    const settled = await settle(row.id, {
      status: "confirmed",
      shopifyGroupId: answer.inventoryAdjustmentGroup.id,
      resultQuantity: after ? after.quantities[QUANTITY_FIELD[ADJUSTMENT_INFO[input.kind].quantityName]] : null,
    });
    if (after) await applyLevels(store, [after], "adjustment", { adjustmentId: row.id, updateTotals: await hasFinishedPass(store.id) });
    await evaluateStockAlerts(store, { variants: [variant.shopifyId] }).catch((err: unknown) => logger.warn({ err, storeId: store.id }, "stock alerts not updated after a change"));
    await audit({
      workspaceId: store.workspaceId,
      actorUserId: actor.userId,
      action: "inventory.adjusted",
      targetType: "inventory_adjustment",
      targetId: row.id,
      ip: actor.ip,
      metadata: { storeId: store.id, kind: input.kind, reason: input.reason, variantId: variant.shopifyId, locationId: location.shopifyId, delta: row.delta, quantity: row.quantity },
    });
    return adjustmentView(settled);
  } finally {
    await deps.coord.release(lock).catch(() => {});
  }
}

function signedDelta(input: AdjustmentInput): number {
  const c = adjustmentChange(input);
  return "delta" in c ? c.delta : c.set;
}

/** Record an adjustment's outcome (the only update the database lets through). */
async function settle(id: string, data: { status: "confirmed" | "failed" | "unknown"; errorCode?: string; shopifyGroupId?: string; resultQuantity?: number | null }) {
  return systemDb.inventoryAdjustment.update({
    where: { id },
    data: { ...data, completedAt: data.status === "unknown" ? null : new Date() },
  });
}
