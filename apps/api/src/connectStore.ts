import { crossTenant, systemDb, type Store, type Tx } from "@app/db";
import { audit, customersFromChange, encryptTokenFields, endBillingForStore, logger, purgeStoreData, seedInitialSync, syncBillingFromShopify, type TokenResponse } from "@app/core";
import { randomToken } from "@app/shared";
import { HttpError, type Deps } from "./context.js";

/** Where the first-sync progress page lives. */
export const syncPage = (storeId: string) => `/onboarding?step=sync&store=${storeId}`;

export const storeTaken = () =>
  new HttpError(409, "This store is already connected to another bizinsights account. Ask its owner to invite you.", "store_taken");

/**
 * True when the workspace was made for a store installed from Shopify and nobody has claimed it
 * yet (see `createShopWorkspace`). Only such a workspace can be claimed or left for another one:
 * a workspace that merely has no members (an edge case) is never up for grabs.
 */
export async function unclaimed(workspaceId: string, tx: Tx = systemDb): Promise<boolean> {
  const ws = await tx.workspace.findUnique({ where: { id: workspaceId }, select: { awaitingClaim: true } });
  return !!ws?.awaitingClaim && (await tx.membership.count({ where: { workspaceId } })) === 0;
}

/** Hold the workspace row until the transaction ends: claims and moves of its store take turns. */
export const lockWorkspace = (tx: Tx, workspaceId: string) => tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`;

/**
 * True when `shop` is live (not uninstalled) in some workspace other than `workspaceId` that an
 * account has claimed. A store installed from Shopify that nobody has claimed yet doesn't count:
 * connecting it goes through Shopify's own approval for that store, which proves as much as a
 * claim would, so it moves to the workspace it is being connected to. Looks across workspaces, from
 * any request's scope (the `shopify_install` reason, @app/db crossTenant.ts).
 */
export async function storeTakenElsewhere(shop: string, workspaceId: string): Promise<boolean> {
  return crossTenant("shopify_install", async () => {
    const existing = await systemDb.store.findUnique({ where: { shopDomain: shop } });
    return !!existing && existing.workspaceId !== workspaceId && existing.status !== "uninstalled" && !(await unclaimed(existing.workspaceId));
  });
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
    const w = await tx.workspace.create({ data: { name: workspaceNameFor(shop), awaitingClaim: true } });
    await tx.subscription.create({ data: { workspaceId: w.id, plan: "free" } });
    return w;
  });
}

/**
 * Remove a workspace made for a store once it holds neither a store nor a member. Best effort:
 * an empty workspace nobody can see is harmless, a failure here must not undo what succeeded.
 */
export async function dropEmptyShopWorkspace(workspaceId: string) {
  try {
    await systemDb.$transaction(async (tx) => {
      await lockWorkspace(tx, workspaceId);
      const ws = await tx.workspace.findUnique({ where: { id: workspaceId }, select: { awaitingClaim: true } });
      if (!ws?.awaitingClaim) return;
      const [members, stores] = [await tx.membership.count({ where: { workspaceId } }), await tx.store.count({ where: { workspaceId } })];
      if (members === 0 && stores === 0) await tx.workspace.delete({ where: { id: workspaceId } });
    });
  } catch (err) {
    logger.warn({ err, workspaceId }, "empty shop workspace not removed");
  }
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
 * `workspaceId`. Across workspaces, from any request's scope (the `shopify_install` reason): a store
 * moving in leaves rows, a sync and maybe an empty workspace behind in the one it comes from.
 */
export async function attachStore(deps: Pick<Deps, "queues" | "fetchImpl">, input: AttachInput): Promise<Store> {
  return crossTenant("shopify_install", () => attach(deps, input));
}

async function attach(deps: Pick<Deps, "queues" | "fetchImpl">, input: AttachInput): Promise<Store> {
  const { workspaceId, shop, token } = input;
  const existing = await systemDb.store.findUnique({ where: { shopDomain: shop } });
  // Moving a store from another workspace: one it was uninstalled from, or one nobody claimed.
  const moving = !!existing && existing.workspaceId !== workspaceId;
  let store: Store;
  try {
    if (existing && moving) {
      store = await systemDb.$transaction(async (tx) => {
        // A claim of the workspace it leaves takes the same lock, so the two can't interleave.
        await lockWorkspace(tx, existing.workspaceId);
        const now = await tx.store.findUniqueOrThrow({ where: { id: existing.id } });
        if (now.workspaceId !== existing.workspaceId) throw storeTaken();
        if (now.status !== "uninstalled" && !(await unclaimed(now.workspaceId, tx))) throw storeTaken();
        return tx.store.update({
          where: { id: existing.id },
          data: { workspaceId, shopifyAppKey: input.appKey, status: "syncing", installedAt: new Date(), uninstalledAt: null, disconnectedAt: null, lastSyncedAt: null, pixelInstalled: false },
        });
      });
      // Its old rows carry the old workspace_id (and RLS hides them from the new one), so start
      // from a clean slate: its synced data, and what the merchant
      // entered for it (costs and business events, which a Disconnect keeps). Customer data
      // requests still to be answered follow the store, and so does the alert asking to answer
      // them. The old workspace's other alerts about the store go.
      await purgeStoreData(existing.id, deps.fetchImpl);
      await systemDb.$transaction([
        systemDb.storeExpense.deleteMany({ where: { storeId: existing.id } }),
        systemDb.expenseCategory.deleteMany({ where: { storeId: existing.id } }),
        systemDb.storeExpenseSettings.deleteMany({ where: { storeId: existing.id } }),
        systemDb.businessEvent.deleteMany({ where: { storeId: existing.id } }),
      ]);
      await systemDb.syncJob.deleteMany({ where: { storeId: existing.id } });
      await systemDb.dataRequest.updateMany({ where: { storeId: existing.id }, data: { workspaceId } });
      await systemDb.alert.updateMany({ where: { storeId: existing.id, code: "privacy_request", resolvedAt: null }, data: { workspaceId } });
      await systemDb.alert.deleteMany({ where: { storeId: existing.id, workspaceId: { not: workspaceId } } });
      await dropEmptyShopWorkspace(existing.workspaceId);
    } else if (existing) {
      store = await systemDb.store.update({
        where: { id: existing.id },
        data: { shopifyAppKey: input.appKey, status: "syncing", installedAt: new Date(), uninstalledAt: null, disconnectedAt: null },
      });
    } else {
      store = await systemDb.store.create({
        data: { workspaceId, shopDomain: shop, shopifyAppKey: input.appKey, status: "syncing", installedAt: new Date(), pixelIngestKey: randomToken(18) },
      });
    }
  } catch (err) {
    // Lost a race with a concurrent connect of the same shop (unique shop_domain).
    if ((err as { code?: string }).code === "P2002") throw storeTaken();
    throw err;
  }
  // From when orders carry their customer, should the token bring read_customers anew (its orders,
  // a moved store's purged, are read with them by the import seeded below).
  const before = existing && !moving ? existing.grantedScopes : [];
  await systemDb.store.update({
    where: { id: store.id },
    data: { ...encryptTokenFields(store.id, token), ...customersFromChange(before, token.scopes, new Date()), pixelIngestKey: store.pixelIngestKey ?? randomToken(18) },
  });
  // Shopify cancels an app's charges when it is uninstalled, so a store back after an uninstall
  // (a store only moves workspace after one, or after a disconnect, below) brings no plan with
  // it: Free until approved again. A store disconnected in bizinsights kept the app installed in
  // Shopify, and any charge on its bill with it; one authorized again while we took it to be
  // installed may or may not have been uninstalled meanwhile: for both, Shopify says which of its
  // charges still stand. (Disconnect refuses a store that carries one, so a store disconnected
  // here and now moving brings none along to end.)
  const uninstalledInShopify = existing?.status === "uninstalled" && !existing.disconnectedAt;
  if (existing && (moving || uninstalledInShopify)) {
    await endBillingForStore(existing.id, moving ? "store_moved" : "uninstalled");
  } else if (existing) {
    await syncBillingFromShopify(store, token.accessToken, deps.fetchImpl).catch((err) =>
      logger.warn({ err, storeId: store.id }, "billing not re-checked with Shopify; the next app_subscriptions/update or app/uninstalled settles it"),
    );
  }
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
