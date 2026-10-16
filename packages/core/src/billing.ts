/**
 * Paid plans, charged through Shopify's Billing API (App Store requirement 1.2.1). A workspace's
 * row in `subscriptions` holds the plan in force, the Shopify charge paying for it
 * (`shopifyChargeId`), a plan change awaiting the merchant's approval (`pendingChargeId`), and the
 * store whose Shopify bill carries both (`billingStoreId`).
 *
 * The plan changes only on Shopify's word: an approved charge (app_subscriptions/update, or a
 * status read back from Shopify) or a cancellation Shopify confirmed. The HTTP routes are in
 * apps/api/src/routes/workspaces.ts; the webhook in apps/worker/src/handlers.ts.
 */
import { systemDb, type Store } from "@app/db";
import { env, switchedOn } from "./env.js";
import { logger } from "./logger.js";
import { audit } from "./notify.js";
import { APP_SUBSCRIPTION_STATUSES } from "./normalize.js";
import { shopifyGraphql, type FetchLike } from "./shopify.js";

export type PlanId = "free" | "growth" | "scale";

export interface Plan {
  id: PlanId;
  name: string;
  priceUsd: number;
  /** Live (not uninstalled) stores one workspace may have; null for no limit. */
  maxStores: number | null;
  features: string[];
}

/**
 * Shown on the billing page, which is a page Shopify's reviewer sees — so these strings are
 * part of what the app advertises, and every one of them has to be something the app actually
 * does. The store limit is the one difference between plans, and the API enforces it
 * (`storeLimitReached`); everything else is the same on every plan. "30 days of history", "Email
 * alerts", "API access", "Priority support" and "Audit log export" were listed before with nothing
 * behind them (every plan had full history, every alert and the same API), so they were taken
 * out. "Funnel insights" needs `write_pixels` and `read_customer_events`, which are protected
 * customer data and deliberately undeclared (shopify-app/shopify.app.toml). Add a feature here
 * only alongside the code that gives it to that plan and not to the others.
 */
export const PLANS: readonly Plan[] = [
  { id: "free", name: "Free", priceUsd: 0, maxStores: 1, features: ["1 store", "Every report and alert"] },
  { id: "growth", name: "Growth", priceUsd: 29, maxStores: 3, features: ["Up to 3 stores in one workspace", "Everything in Free"] },
  { id: "scale", name: "Scale", priceUsd: 99, maxStores: null, features: ["Unlimited stores in one workspace", "Everything in Free"] },
];

/** The plan with this id; an id no longer offered counts as Free. */
export const planById = (id: string): Plan => PLANS.find((p) => p.id === id) ?? PLANS[0]!;

/**
 * Whether paid plans are on sale (the BILLING_ENABLED setting). Off, no charge can be started and
 * plan limits don't apply: everyone has Free, with nothing to upgrade to.
 */
export const billingEnabled = () => switchedOn(env().BILLING_ENABLED);

/**
 * Whether proration credits the merchant for the unused days of a charge cancelled by a downgrade
 * to Free. Their plan ends at once, so they shouldn't pay for the rest of the cycle; it matches
 * what Shopify does for a paid plan replaced by another (APPLY_IMMEDIATELY, normalize.ts).
 */
export const PRORATE_ON_CANCEL = true;

/**
 * The plan in force when `workspaceId` has no room for `shop`, or null when it has. A store the
 * workspace already has (an uninstalled one coming back, a reconnect) always fits: only a store
 * new to the workspace counts against the plan's limit. Never limits anyone while billing is off.
 */
export async function storeLimitReached(workspaceId: string, shop: string | null): Promise<Plan | null> {
  if (!billingEnabled()) return null;
  if (shop && (await systemDb.store.count({ where: { workspaceId, shopDomain: shop } }))) return null;
  const sub = await systemDb.subscription.findUnique({ where: { workspaceId }, select: { plan: true } });
  const plan = planById(sub?.plan ?? "free");
  if (plan.maxStores === null) return null;
  const live = await systemDb.store.count({ where: { workspaceId, status: { not: "uninstalled" } } });
  return live >= plan.maxStores ? plan : null;
}

/** Shopify charge statuses after which the merchant is no longer paying for that charge. */
const ENDED_CHARGE = new Set(["cancelled", "declined", "expired"]);

/**
 * Apply a Shopify charge status to the workspace's subscription. Two charges can be in play: the
 * one in force (`shopifyChargeId`) and a plan change awaiting approval (`pendingChargeId`).
 * Activating the pending one makes it the plan; a pending one that ends just goes away; the one in
 * force ending drops the workspace to free. Statuses for any other charge (one replaced by a later
 * change, delivered late) are ignored, so retries and out-of-order delivery cannot resurrect it.
 *
 * Every write is conditional on the charge still being where it was read (`updateMany` with the
 * charge id in the filter): Shopify sends "new charge active" and "old charge cancelled" together,
 * and two consumers handling them at once each read the row before the other wrote, so an
 * unconditional write let the cancellation drop a just-upgraded workspace to free.
 */
export async function applySubscriptionUpdate(workspaceId: string, chargeId: string | undefined, status: string) {
  if (!chargeId) return;
  const row = await systemDb.subscription.findUnique({ where: { workspaceId } });
  if (!row) return;
  if (chargeId === row.pendingChargeId) {
    const stillPending = { workspaceId, pendingChargeId: chargeId };
    if (status === "active") {
      const { count } = await systemDb.subscription.updateMany({
        where: stillPending,
        data: { plan: row.pendingPlan ?? row.plan, status: "active", shopifyChargeId: chargeId, pendingPlan: null, pendingChargeId: null },
      });
      if (count) await audit({ workspaceId, action: "billing.plan_changed", metadata: { plan: row.pendingPlan, from: row.plan } });
    } else if (ENDED_CHARGE.has(status)) {
      const { count } = await systemDb.subscription.updateMany({ where: stillPending, data: { pendingPlan: null, pendingChargeId: null } });
      if (count) await audit({ workspaceId, action: "billing.plan_change_ended", metadata: { plan: row.pendingPlan, status } });
    }
    return;
  }
  if (chargeId === row.shopifyChargeId) {
    const stillCurrent = { workspaceId, shopifyChargeId: chargeId };
    if (ENDED_CHARGE.has(status)) {
      const { count } = await systemDb.subscription.updateMany({ where: stillCurrent, data: { plan: "free", status: "active", shopifyChargeId: null } });
      if (count) await audit({ workspaceId, action: "billing.subscription_ended", metadata: { plan: row.plan, status } });
    } else {
      await systemDb.subscription.updateMany({ where: stillCurrent, data: { status } });
    }
    return;
  }
  logger.info({ workspaceId, chargeId, status }, "ignoring a status for a charge that is neither current nor pending");
}

/**
 * The app was uninstalled from `storeId` (or the store left the workspace after that), and Shopify
 * cancels every charge of an app it uninstalls: whatever the store's bill carried is over. Each
 * workspace billed there goes back to Free, and a change still awaiting approval goes too, so a
 * reinstall starts from Free and asks for approval again (requirement 1.2.2).
 */
export async function endBillingForStore(storeId: string, reason: "uninstalled" | "store_moved") {
  const rows = await systemDb.subscription.findMany({ where: { billingStoreId: storeId } });
  for (const row of rows) {
    // Conditional on the charges read, like applySubscriptionUpdate: a charge started since stays.
    const { count } = await systemDb.subscription.updateMany({
      where: { workspaceId: row.workspaceId, billingStoreId: storeId, shopifyChargeId: row.shopifyChargeId, pendingChargeId: row.pendingChargeId },
      data: { plan: "free", status: "active", shopifyChargeId: null, pendingPlan: null, pendingChargeId: null, billingStoreId: null },
    });
    if (!count || (!row.shopifyChargeId && !row.pendingChargeId)) continue;
    await audit({
      workspaceId: row.workspaceId,
      action: row.shopifyChargeId ? "billing.subscription_ended" : "billing.plan_change_ended",
      targetType: "store",
      targetId: storeId,
      metadata: { plan: row.shopifyChargeId ? row.plan : row.pendingPlan, reason },
    });
  }
}

/**
 * Read back from Shopify where the charges billed to `store` stand, and apply that: for when its
 * webhooks may not have told us (the app reinstalled, an uninstall processed late). A charge
 * Shopify doesn't show this installation was made for an earlier one, which uninstalling
 * cancelled. Throws when Shopify can't be asked; nothing changes then.
 */
export async function syncBillingFromShopify(store: Pick<Store, "id" | "shopDomain">, accessToken: string, fetchImpl?: FetchLike) {
  const rows = await systemDb.subscription.findMany({ where: { billingStoreId: store.id } });
  for (const row of rows) {
    // The pending charge first: one approved meanwhile becomes the plan before the old one ends.
    const ids = [row.pendingChargeId, row.shopifyChargeId].filter((id): id is string => !!id);
    if (!ids.length) continue;
    const data = await shopifyGraphql<{ nodes: Array<{ id?: string; status?: string } | null> }>({
      shop: store.shopDomain,
      accessToken,
      apiVersion: env().SHOPIFY_API_VERSION,
      query: APP_SUBSCRIPTION_STATUSES,
      variables: { ids },
      fetchImpl,
    });
    for (const [i, id] of ids.entries()) {
      const node = data.nodes[i];
      await applySubscriptionUpdate(row.workspaceId, id, node?.status ? node.status.toLowerCase() : "cancelled");
    }
  }
}
