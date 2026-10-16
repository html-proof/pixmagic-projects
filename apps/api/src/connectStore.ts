import { systemDb, type Store } from "@app/db";
import { audit, encryptTokenFields, purgeStoreData, type TokenResponse } from "@app/core";
import { randomToken } from "@app/shared";
import { HttpError, type Deps } from "./context.js";
import { seedInitialSync } from "./sync.js";

/** Where the first-sync progress page lives. */
export const syncPage = (storeId: string) => `/onboarding?step=sync&store=${storeId}`;

export const storeTaken = () =>
  new HttpError(409, "This store is already connected to another bizinsights account. Ask its owner to invite you.", "store_taken");

/** True when nobody has a bizinsights login for the workspace yet (see `createShopWorkspace`). */
export async function unclaimed(workspaceId: string): Promise<boolean> {
  return (await systemDb.membership.count({ where: { workspaceId } })) === 0;
}

/**
 * True when `shop` is live (not uninstalled) in some workspace other than `workspaceId` that an
 * account has claimed. A store installed from Shopify that nobody has claimed yet doesn't count:
 * connecting it goes through Shopify's own approval for that store, which proves as much as a
 * claim would, so it moves to the workspace it is being connected to.
 */
export async function storeTakenElsewhere(shop: string, workspaceId: string): Promise<boolean> {
  const existing = await systemDb.store.findUnique({ where: { shopDomain: shop } });
  return !!existing && existing.workspaceId !== workspaceId && existing.status !== "uninstalled" && !(await unclaimed(existing.workspaceId));
}

/** "Demo-Shop.myshopify.com" → "Demo Shop": the name a workspace made for a store starts with. */
export function workspaceNameFor(shop: string): string {
  const handle = shop.replace(/\.myshopify\.com$/i, "");
  const words = handle.split("-").filter(Boolean);
  return words.length ? words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ").slice(0, 80) : "My store";
}

/**
 * The workspace a store installed from Shopify lands in when no account is known yet (installing
 * from the App Store authorizes the app before anyone signs in, App Store requirement 2.3.2). It
 * has no members until someone claims it (`POST /shopify/claim`), so nobody can see it meanwhile.
 */
export async function createShopWorkspace(shop: string) {
  return systemDb.$transaction(async (tx) => {
    const w = await tx.workspace.create({ data: { name: workspaceNameFor(shop) } });
    await tx.subscription.create({ data: { workspaceId: w.id, plan: "free" } });
    return w;
  });
}

/** Remove a workspace made for a store once it holds neither a store nor a member. */
export async function dropEmptyShopWorkspace(workspaceId: string) {
  const [members, stores] = await Promise.all([
    systemDb.membership.count({ where: { workspaceId } }),
    systemDb.store.count({ where: { workspaceId } }),
  ]);
  if (members === 0 && stores === 0) await systemDb.workspace.deleteMany({ where: { id: workspaceId } });
}

export interface AttachInput {
  workspaceId: string;
  shop: string;
  token: TokenResponse;
  /** The Shopify app the tokens were issued to. */
  appKey: string;
  /** Null when Shopify installed the app before anyone signed in to us. */
  actorUserId: string | null;
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
  if (existing && existing.workspaceId !== workspaceId && existing.status !== "uninstalled" && !(await unclaimed(existing.workspaceId))) {
    throw storeTaken();
  }

  // Reviving a store that was uninstalled from another workspace (or moving one nobody claimed):
  // its old rows carry the old workspace_id (and RLS hides them from the new one), so start from
  // a clean slate.
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
  if (moving) await dropEmptyShopWorkspace(existing.workspaceId);
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
