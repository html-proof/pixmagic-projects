import { systemDb, type Store, type User } from "@app/db";
import { audit, encryptTokenFields, purgeStoreData, type ShopifyAssociatedUser, type TokenResponse } from "@app/core";
import { can, randomToken } from "@app/shared";
import { HttpError, type Deps } from "./context.js";
import { liveSyncJobs, seedInitialSync } from "./sync.js";

/**
 * An import silent for this long is treated as dead by a reconnect: the same threshold at which
 * the worker's watchdog fails it (STALE_RUNNING_MS in apps/worker/src/handlers.ts).
 */
const STALLED_AFTER_MS = 30 * 60 * 1000;

/** Where the first-sync progress page lives (also used after a reconnect that needs a re-sync). */
export const syncPage = (storeId: string) => `/onboarding?step=sync&store=${storeId}`;

export const storeTaken = () =>
  new HttpError(409, "This store is already connected to another Insights account. Ask its owner to invite you.", "store_taken");

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
export async function attachStore(deps: Pick<Deps, "queues">, input: AttachInput): Promise<Store> {
  const { workspaceId, shop, token } = input;
  const existing = await systemDb.store.findUnique({ where: { shopDomain: shop } });
  if (existing && existing.workspaceId !== workspaceId && existing.status !== "uninstalled") throw storeTaken();

  // Reviving a store that was uninstalled from another workspace: its old rows carry the old
  // workspace_id (and RLS hides them from the new one), so start from a clean slate.
  const moving = !!existing && existing.workspaceId !== workspaceId;
  if (moving) {
    await purgeStoreData(existing.id);
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

/** "demo-shop.myshopify.com" → "Demo Shop". */
export function workspaceNameForShop(shop: string): string {
  const handle = shop.replace(/\.myshopify\.com$/, "");
  const name = handle
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
  return (name || shop).slice(0, 80);
}

/** Same as POST /workspaces: workspace + owner membership + free plan + audit entry. */
async function createWorkspaceFor(userId: string, name: string, ip: string): Promise<string> {
  const ws = await systemDb.$transaction(async (tx) => {
    const w = await tx.workspace.create({ data: { name } });
    await tx.membership.create({ data: { workspaceId: w.id, userId, role: "owner" } });
    await tx.subscription.create({ data: { workspaceId: w.id, plan: "free" } });
    return w;
  });
  await audit({ workspaceId: ws.id, actorUserId: userId, action: "workspace.created", ip });
  return ws.id;
}

/**
 * The workspace a signup connects into: the user's oldest workspace that they own and nobody
 * else belongs to, else a new one. Store data never lands in a shared workspace without the
 * user choosing it (that's what the in-app "Connect a store" flow is for): the account may have
 * been set up by someone else before its email was proven.
 */
async function signupWorkspace(user: User, shop: string, ip: string): Promise<string> {
  const owned = await systemDb.membership.findMany({
    where: { userId: user.id, role: "owner" },
    orderBy: { workspace: { createdAt: "asc" } },
    select: { workspaceId: true, workspace: { select: { _count: { select: { memberships: true } } } } },
  });
  const solo = owned.find((m) => m.workspace._count.memberships === 1);
  return solo?.workspaceId ?? createWorkspaceFor(user.id, workspaceNameForShop(shop), ip);
}

/**
 * The workspace an uninstalled store belongs back in when its own merchant reinstalls: the one it
 * was already in, provided the person reinstalling may still manage stores there.
 *
 * Without this, a reinstall through "Continue with Shopify" loses the store's history. `connectStore`
 * deliberately treats an uninstalled row as unconnected (so a shop freed by its previous owner can be
 * claimed), which also hides it from `signupWorkspace` — and `signupWorkspace` only ever returns a
 * workspace the user *owns alone*. So a merchant whose workspace has a second member, or who is an
 * admin rather than the owner, gets a brand-new workspace; `attachStore` then sees the store moving
 * between workspaces and purges its orders and metrics (only the last `BACKFILL_DAYS` can be
 * re-imported, since the app has no `read_all_orders`), stranding the other members in the old one.
 */
async function reinstallWorkspace(user: User, found: Store | null): Promise<string | null> {
  if (!found) return null;
  const m = await systemDb.membership.findUnique({
    where: { workspaceId_userId: { workspaceId: found.workspaceId, userId: user.id } },
  });
  return m && can(m.role, "stores:manage") ? found.workspaceId : null;
}

export interface SignupConnection {
  user: User;
  shop: string;
  token: TokenResponse;
  appKey: string;
  shopifyUser: ShopifyAssociatedUser;
  ip: string;
}

export interface ConnectResult {
  /** Where the web app should go next. */
  next: string;
  workspaceId: string;
  storeId: string;
}

/**
 * Finish "Continue with Shopify" for a signed-in user who has proven their email:
 * - shop already live in a workspace the user belongs to → refresh its tokens (managers only)
 *   and send them to the dashboard (or the sync page if it needs a fresh import);
 * - shop live in someone else's workspace → 409 `store_taken`;
 * - shop uninstalled from a workspace the user may still manage stores in → reinstall it there,
 *   keeping its history (`reinstallWorkspace`);
 * - otherwise connect it to the user's oldest managed workspace, creating one if needed.
 */
export async function connectStore(deps: Pick<Deps, "queues">, input: SignupConnection): Promise<ConnectResult> {
  const { user, shop, token, appKey, shopifyUser, ip } = input;
  const found = await systemDb.store.findUnique({ where: { shopDomain: shop } });
  const existing = found && found.status !== "uninstalled" ? found : null;
  const m = existing
    ? await systemDb.membership.findUnique({ where: { workspaceId_userId: { workspaceId: existing.workspaceId, userId: user.id } } })
    : null;
  if (existing && !m) throw storeTaken();

  if (!user.displayName) {
    const name = [shopifyUser.firstName, shopifyUser.lastName].filter(Boolean).join(" ").trim().slice(0, 80);
    if (name) await systemDb.user.update({ where: { id: user.id }, data: { displayName: name } });
  }

  if (existing && m) {
    const result = { workspaceId: existing.workspaceId, storeId: existing.id };
    // Members who can't manage stores just get signed in; the store's tokens stay as they are.
    if (!can(m.role, "stores:manage")) return { next: "/dashboard", ...result };

    // Re-import when the last attempt failed, the tokens were lost, or the import died (store left
    // "syncing" with nothing working on it - judged by activity, since a dead chain leaves its row
    // queued or running for good).
    const stalled = existing.status === "syncing" && (await systemDb.syncJob.count({ where: liveSyncJobs(existing.id, STALLED_AFTER_MS) })) === 0;
    const resync = existing.status === "error" || !existing.accessTokenEnc || stalled;
    await systemDb.store.update({
      where: { id: existing.id },
      // Fresh tokens are only refreshable with the app that issued them.
      data: { ...encryptTokenFields(existing.id, token), shopifyAppKey: appKey, ...(resync ? { status: "syncing" as const } : {}) },
    });
    await audit({
      workspaceId: existing.workspaceId,
      actorUserId: user.id,
      action: "store.reauthorized",
      targetType: "store",
      targetId: existing.id,
      metadata: { shop, scopes: token.scopes, via: "shopify_signup", resync },
      ip,
    });
    if (!resync) return { next: "/dashboard", ...result };
    await seedOrFlag(deps, { ...existing, grantedScopes: token.scopes });
    return { next: syncPage(existing.id), ...result };
  }

  // A reinstall goes back into the store's own workspace; only a genuinely new connection picks one.
  const workspaceId = (await reinstallWorkspace(user, found)) ?? (await signupWorkspace(user, shop, ip));
  const store = await attachStore(deps, { workspaceId, shop, token, appKey, actorUserId: user.id, ip, via: "shopify_signup" });
  return { next: syncPage(store.id), workspaceId, storeId: store.id };
}
