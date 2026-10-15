import { systemDb, type Store } from "@app/db";
import { audit, encryptTokenFields, purgeStoreData, type TokenResponse } from "@app/core";
import { randomToken } from "@app/shared";
import { HttpError, type Deps } from "./context.js";
import { seedInitialSync } from "./sync.js";

/** Where the first-sync progress page lives. */
export const syncPage = (storeId: string) => `/onboarding?step=sync&store=${storeId}`;

export const storeTaken = () =>
  new HttpError(409, "This store is already connected to another bizinsights account. Ask its owner to invite you.", "store_taken");

/** True when `shop` is live (not uninstalled) in some workspace other than `workspaceId`. */
export async function storeTakenElsewhere(shop: string, workspaceId: string): Promise<boolean> {
  const existing = await systemDb.store.findUnique({ where: { shopDomain: shop } });
  return !!existing && existing.workspaceId !== workspaceId && existing.status !== "uninstalled";
}

export interface AttachInput {
  workspaceId: string;
  shop: string;
  token: TokenResponse;
  /** The Shopify app the tokens were issued to. */
  appKey: string;
  actorUserId: string;
  ip: string;
  /** Recorded in the audit entry when the connection didn't come from the in-app connect flow. */
  via?: string;
}

/**
 * Attach a shop to a workspace with fresh tokens (reviving its uninstalled row, or re-connecting
 * it in the same workspace), audit it and seed the initial sync. Throws 409 `store_taken` when
 * the shop is live in another workspace. Callers have already checked who may connect to
 * `workspaceId`.
 */
export async function attachStore(deps: Pick<Deps, "queues" | "fetchImpl">, input: AttachInput): Promise<Store> {
  const { workspaceId, shop, token } = input;
  const existing = await systemDb.store.findUnique({ where: { shopDomain: shop } });
  if (existing && existing.workspaceId !== workspaceId && existing.status !== "uninstalled") throw storeTaken();

  // Reviving a store that was uninstalled from another workspace: its old rows carry the old
  // workspace_id (and RLS hides them from the new one), so start from a clean slate.
  const moving = !!existing && existing.workspaceId !== workspaceId;
  if (moving) {
    await purgeStoreData(existing.id, deps.fetchImpl);
    await systemDb.syncJob.deleteMany({ where: { storeId: existing.id } });
  }
  let store: Store;
  try {
    store = existing
      ? await systemDb.store.update({
          where: { id: existing.id },
          data: {
            workspaceId,
            shopifyAppKey: input.appKey,
            status: "syncing",
            installedAt: new Date(),
            uninstalledAt: null,
            ...(moving ? { lastSyncedAt: null, pixelInstalled: false } : {}),
          },
        })
      : await systemDb.store.create({
          data: { workspaceId, shopDomain: shop, shopifyAppKey: input.appKey, status: "syncing", installedAt: new Date(), pixelIngestKey: randomToken(18) },
        });
  } catch (err) {
    // Lost a race with a concurrent connect of the same shop (unique shop_domain).
    if ((err as { code?: string }).code === "P2002") throw storeTaken();
    throw err;
  }
  await systemDb.store.update({
    where: { id: store.id },
    data: { ...encryptTokenFields(store.id, token), pixelIngestKey: store.pixelIngestKey ?? randomToken(18) },
  });
  await audit({
    workspaceId,
    actorUserId: input.actorUserId,
    action: "store.connected",
    targetType: "store",
    targetId: store.id,
    metadata: { shop, scopes: token.scopes, ...(input.via ? { via: input.via } : {}) },
    ip: input.ip,
  });
  await seedOrFlag(deps, { ...store, grantedScopes: token.scopes });
  return store;
}

/**
 * Seed the initial import. If that fails half-way (queue or database blip), mark the store
 * "error" so the next connect attempt or "Refresh data" re-runs it instead of the store
 * sitting in "syncing" with nothing queued.
 */
async function seedOrFlag(deps: Pick<Deps, "queues">, store: Pick<Store, "id" | "workspaceId" | "grantedScopes">) {
  try {
    await seedInitialSync(deps, store);
  } catch (err) {
    await systemDb.store.update({ where: { id: store.id }, data: { status: "error" } }).catch(() => {});
    throw err;
  }
}
