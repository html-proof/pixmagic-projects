/** The webhooks queue: each Shopify topic applied to the store's data (orders, products, refunds, app and GDPR topics). */
import { systemDb, type Store } from "@app/db";
import { applySubscriptionUpdate, audit, customerKey, deleteProduct, endBillingForStore, env, getAccessToken, gidToId, INSTALLATION_QUERY, logger, MAX_ATTEMPTS, shopifyGraphql, ShopifyHttpError, StoreDisconnectedError, withAccessToken, normalizeRestOrder, normalizeRestProduct, normalizeRestProductVariants, parseShopify, pruneVariants, purgeStoreData, raiseAlert, recordDataRequest, resolveAlerts, customersDataRequestSchema, customersRedactSchema, restOrderSchema, restProductDeleteSchema, restOrderDeleteSchema, removeOrders, restProductSchema, restRefundWebhookSchema, scopesUpdateSchema, subscriptionUpdateSchema, syncBillingFromShopify, upsertOrder, upsertProduct, upsertVariant, seedScopeFollowUp, type WebhookJobData, redactWhatsappCustomer, whatsappOnShopifyEvent, emailOnShopifyEvent, purgeEmailStoreData, redactEmailCustomer, onInventoryItemWebhook, onLevelDisconnect, onLevelWebhook, onLocationWebhook } from "@app/core";
import { enqueueAggregate, UnrecoverableError, type WorkerDeps } from "./common.js";
import { readSalesAfterWebhook, SHOP_UNAVAILABLE, shopifyReader } from "./shopifyRead.js";

/** Topics about the app installation itself (not store data). */
const APP_SCOPED_TOPICS = new Set(["app/uninstalled", "app/scopes_update", "shop/redact", "app_subscriptions/update"]);

/** How long app/scopes_update holds back the import work it queues (see that case below). */
const SCOPE_FOLLOW_UP_DELAY_S = 60;

/** REST product payloads list at most this many variants; a shorter list is complete. */
const REST_PRODUCT_VARIANT_LIMIT = 100;

/** How long a deleted product's id is remembered (covers webhook retries and late deliveries). */
const TOMBSTONE_TTL_S = 7 * 86400;
const tombstoneKey = (storeId: string, productId: string) => `tomb:product:${storeId}:${productId}`;

/** True when products/delete ran for this product recently (the marker is kept in place). */
async function deletedRecently(deps: WorkerDeps, storeId: string, productId: string): Promise<boolean> {
  const key = tombstoneKey(storeId, productId);
  // Coord has no plain read: take and put back (only this product's own webhooks touch the key).
  const mark = await deps.coord.take(key);
  if (mark === null) return false;
  await deps.coord.put(key, mark, TOMBSTONE_TTL_S);
  return true;
}

/** A GDPR request whose payload doesn't fit its schema: the fields that didn't are in the warning logged with it. */
const unreadableGdprRequest = (topic: string) => new UnrecoverableError(`Shopify's ${topic} payload couldn't be read, so the request was not carried out`);

/**
 * shop/redact: erase the store. Its synced data, its WhatsApp and email records, its import jobs,
 * alerts and privacy requests go, and so does the store row itself: a later install starts from
 * nothing (a new workspace and a new claim) instead of being joined to the account that had it
 * before. A workspace made for the store that nobody ever claimed goes with it.
 *
 * The erase records itself (gdpr.shop_redacted, naming the shop) in its own transaction: in the
 * workspace's log when the workspace stays, and with no workspace when it went too, so the record
 * outlives it (written for the erased workspace, it failed its foreign key and nothing was kept).
 */
async function eraseStore(store: Store, deps: WorkerDeps): Promise<{ workspaceErased: boolean }> {
  await purgeStoreData(store.id, deps.fetchImpl);
  await purgeEmailStoreData(store.id);
  // One transaction: a retry after a failure finds the store still there and does it all again.
  return systemDb.$transaction(async (tx) => {
    // A claim of the workspace takes the same lock (apps/api/src/routes/shopify.ts).
    await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${store.workspaceId} FOR UPDATE`;
    await tx.syncJob.deleteMany({ where: { storeId: store.id } });
    await tx.alert.deleteMany({ where: { storeId: store.id } });
    await tx.dataRequest.deleteMany({ where: { storeId: store.id } });
    await tx.webhookEvent.updateMany({ where: { storeId: store.id }, data: { storeId: null } });
    await tx.store.delete({ where: { id: store.id } });
    const ws = await tx.workspace.findUnique({ where: { id: store.workspaceId }, select: { awaitingClaim: true } });
    const members = await tx.membership.count({ where: { workspaceId: store.workspaceId } });
    const stores = await tx.store.count({ where: { workspaceId: store.workspaceId } });
    const workspaceErased = !!ws?.awaitingClaim && members === 0 && stores === 0;
    if (workspaceErased) await tx.workspace.delete({ where: { id: store.workspaceId } });
    await tx.auditLog.create({
      data: {
        workspaceId: workspaceErased ? null : store.workspaceId,
        action: "gdpr.shop_redacted",
        targetType: "store",
        targetId: store.id,
        metadata: { shop: store.shopDomain, ...(workspaceErased ? { erasedWorkspaceId: store.workspaceId } : {}) },
      },
    });
    return { workspaceErased };
  });
}

/**
 * What Shopify says of the installation the store's token was granted to:
 *  - "works": it accepts the token, so that installation is in place;
 *  - "revoked": it refuses it (401/403: Shopify revokes an app's tokens when it is uninstalled), or
 *    the store holds none;
 *  - "shop_unavailable": the shop itself is closed, frozen, locked or gone (402/404/423), which
 *    says nothing about the app.
 * Anything else (the network, Shopify's 5xx and 429, an answer that can't be read) is thrown, so
 * the delivery is retried rather than decided on a guess.
 */
type InstallationState = "works" | "revoked" | "shop_unavailable";
async function installationState(deps: WorkerDeps, store: Store): Promise<InstallationState> {
  try {
    // withAccessToken: a token that needs refreshing, or a non-expiring one Shopify won't take any
    // more, is renewed first, so only a refusal of the installation itself reads as one.
    await withAccessToken(store, deps.coord, deps.fetchImpl, (accessToken) =>
      shopifyGraphql({ shop: store.shopDomain, accessToken, apiVersion: env().SHOPIFY_API_VERSION, query: INSTALLATION_QUERY, fetchImpl: deps.fetchImpl, maxRetries: 1 }),
    );
    return "works";
  } catch (err) {
    if (err instanceof StoreDisconnectedError) return "revoked";
    if (err instanceof ShopifyHttpError && (err.status === 401 || err.status === 403)) return "revoked";
    if (err instanceof ShopifyHttpError && SHOP_UNAVAILABLE.has(err.status)) return "shop_unavailable";
    throw err;
  }
}

/**
 * installationState for a delivery, or "unknown" on its last attempt when Shopify can't be asked
 * (an outage, an answer that can't be read): nothing would deliver it again, so the caller decides
 * on the rest of the evidence rather than let it drop.
 */
async function installationStateFor(deps: WorkerDeps, store: Store, attempt: number, logIds: Record<string, unknown>): Promise<InstallationState | "unknown"> {
  try {
    return await installationState(deps, store);
  } catch (err) {
    if (attempt < MAX_ATTEMPTS) throw err;
    logger.warn({ err, ...logIds }, "Shopify couldn't say whether the store is still installed; deciding without it");
    return "unknown";
  }
}

export async function processWebhook(data: WebhookJobData, deps: WorkerDeps) {
  const ev = await systemDb.webhookEvent.findUnique({ where: { id: data.eventId } });
  if (!ev || ev.status === "succeeded") {
    // Intake can queue a second copy of a delivery, each with its own blob (see
    // apps/api/src/routes/webhooks.ts). The copy that loses the race still owns one to clean up.
    if (data.payloadKey) await deps.payloads.delete(data.payloadKey).catch(() => {});
    return { skipped: true }; // idempotent
  }
  await systemDb.webhookEvent.update({ where: { id: ev.id }, data: { status: "running", attempts: { increment: 1 } } });

  const store = await systemDb.store.findUnique({ where: { shopDomain: data.shop } });
  let p: unknown = data.payload;
  if (data.payloadKey) {
    const raw = await deps.payloads.get(data.payloadKey);
    if (raw === null) throw new UnrecoverableError(`Webhook payload ${data.payloadKey} is missing`);
    p = JSON.parse(raw);
  }

  // A shop may have installed more than one of our apps: uninstall/scopes/redact events from an
  // app the store isn't connected through say nothing about this connection.
  const otherApp = !!store && !!data.app && data.app !== store.shopifyAppKey && APP_SCOPED_TOPICS.has(data.topic);
  if (!store) {
    // Unknown shop (e.g. GDPR webhook after full deletion). Nothing to do.
    logger.info({ topic: data.topic, shop: data.shop }, "webhook for unknown shop");
  } else if (otherApp) {
    logger.info({ topic: data.topic, shop: data.shop, app: data.app, storeApp: store.shopifyAppKey }, "webhook from another of our apps; ignored");
  } else {
    const logIds = { storeId: store.id, eventId: ev.id };
    switch (data.topic) {
      case "orders/create":
      case "orders/updated":
      case "orders/paid":
      case "orders/cancelled":
      case "orders/fulfilled":
      case "orders/partially_fulfilled":
      case "orders/edited": {
        if (store.status === "uninstalled") break;
        // orders/edited sends {order_edit: {...}}: refetching would need the order; reconcile job covers it.
        if (data.topic === "orders/edited") break;
        // A payload that doesn't fit is logged and skipped, not retried: a retry gets the same payload.
        const order = parseShopify(restOrderSchema, p, data.topic, logIds);
        if (!order) break;
        const o = normalizeRestOrder(order);
        const days = await upsertOrder(store, o);
        // The payload has no sales: read them when its money state is new (placed, refunded,
        // cancelled, edited), not on every paid/fulfilled/tagged delivery.
        for (const d of await readSalesAfterWebhook(deps, store, o.shopifyId, o.salesKey, days)) days.add(d);
        await enqueueAggregate(deps, store.id, days);
        break;
      }
      case "orders/delete": {
        // Shopify's reports stop counting a deleted order (only test, imported, draft and manually
        // paid orders can be deleted, once archived or cancelled): so do we.
        const gone = parseShopify(restOrderDeleteSchema, p, data.topic, logIds);
        if (!gone) break;
        const days = await removeOrders(store, [String(gone.id)]);
        if (days.size) logger.info({ ...logIds, order: String(gone.id) }, "order deleted in Shopify; removed");
        await enqueueAggregate(deps, store.id, days);
        break;
      }
      case "refunds/create": {
        if (store.status === "uninstalled") break;
        const refund = parseShopify(restRefundWebhookSchema, p, data.topic, logIds);
        if (!refund) break;
        // The refund's return is one of the order's sales: read them again. An order not stored
        // (a test order, or not synced yet) is left to its orders/updated delivery and the reconcile.
        const days = await readSalesAfterWebhook(deps, store, String(refund.order_id), undefined, new Set(), true);
        await enqueueAggregate(deps, store.id, days);
        break;
      }
      case "products/create":
      case "products/update": {
        if (store.status === "uninstalled") break;
        const payload = parseShopify(restProductSchema, p, data.topic, logIds);
        if (!payload) break;
        const product = normalizeRestProduct(payload);
        // Product ids are never reused, so anything arriving after products/delete (a late or
        // retried update) is stale and must not bring the product and its stock back.
        if (await deletedRecently(deps, store.id, product.shopifyId)) break;
        // A stale product payload carries stale variants too (it could resurrect a deleted one): skip it.
        if (!(await upsertProduct(store, product))) break;
        // Each variant also has its own updated_at guard; stock levels come with them, cost doesn't.
        const variants = normalizeRestProductVariants(payload);
        for (const v of variants) await upsertVariant(store, v);
        // Which variants still exist: `variant_gids` lists all of them (variants[] stops at 100);
        // without it, only a variants[] list shorter than that limit is known to be complete.
        const keep = payload.variant_gids
          ? payload.variant_gids.map((g) => gidToId(g.admin_graphql_api_id)).filter((id): id is string => !!id)
          : variants.length > 0 && variants.length < REST_PRODUCT_VARIANT_LIMIT
            ? variants.map((v) => v.shopifyId)
            : [];
        if (keep.length) await pruneVariants(store, product.shopifyId, keep, product.updatedAt);
        break;
      }
      case "products/delete": {
        const gone = parseShopify(restProductDeleteSchema, p, data.topic, logIds);
        if (!gone) break;
        await deleteProduct(store, String(gone.id));
        await deps.coord.put(tombstoneKey(store.id, String(gone.id)), "1", TOMBSTONE_TTL_S);
        break;
      }
      // ---- Inventory (shop-specific subscriptions, core/inventory/sync.ts ensureInventoryWebhooks)
      case "inventory_levels/update":
      case "inventory_levels/connect": {
        if (store.status === "uninstalled") break;
        await onLevelWebhook(store, shopifyReader(deps, store).gql, p, logIds);
        break;
      }
      case "inventory_levels/disconnect": {
        if (store.status === "uninstalled") break;
        await onLevelDisconnect(store, p, logIds);
        break;
      }
      case "inventory_items/update": {
        if (store.status === "uninstalled") break;
        await onInventoryItemWebhook(store, p, logIds);
        break;
      }
      case "locations/create":
      case "locations/update":
      case "locations/delete":
      case "locations/activate":
      case "locations/deactivate": {
        if (store.status === "uninstalled") break;
        await onLocationWebhook(store, shopifyReader(deps, store).gql, data.topic, p, logIds);
        break;
      }
      case "app/uninstalled": {
        // Shopify retries a failed delivery for up to 48 hours, and the merchant may well have
        // reinstalled in the meantime (that is the usual fix for an accidental uninstall; App
        // Review's test does it within seconds). Applying a delivery about an earlier installation
        // would wipe live tokens and disconnect a working store, with nothing to put it back.
        // Shopify revokes an app's tokens when it is uninstalled, so the token the row holds tells:
        // one Shopify still accepts belongs to a later installation, whatever `installedAt` says (a
        // reinstall into a working store nobody claimed only swaps the token, finishInstall's
        // shortcut, and leaves `installedAt` as it was). A delivery older than `installedAt` is set
        // aside unless Shopify refuses the token: a frozen or locked shop proves nothing, and a row
        // with no token yet is a reinstall being written. Kept "installed" while Shopify refused its
        // token, a store outlived its shop (App Review's stores of 2026-10-18 kept their data).
        // `installedAt` is nullable: an unknown install time shows nothing stale.
        const triggeredAt = data.triggeredAt ? new Date(data.triggeredAt) : null;
        const stale = !!triggeredAt && !!store.installedAt && store.installedAt > triggeredAt;
        const state = store.accessTokenEnc ? await installationStateFor(deps, store, ev.attempts + 1, { topic: data.topic, shop: data.shop, storeId: store.id }) : null;
        const setAside = stale ? state !== "revoked" : state === "works";
        let count = 0;
        if (!setAside) {
          // Scoped to the installation looked at: a reinstall landing meanwhile is left alone.
          ({ count } = await systemDb.store.updateMany({
            where: {
              id: store.id,
              ...(stale ? { installedAt: store.installedAt } : triggeredAt ? { OR: [{ installedAt: null }, { installedAt: { lte: triggeredAt } }] } : {}),
            },
            data: { status: "uninstalled", uninstalledAt: new Date(), accessTokenEnc: null, refreshTokenEnc: null, accessTokenExpiresAt: null, refreshTokenExpiresAt: null },
          }));
        }
        const logFields = { topic: data.topic, shop: data.shop, storeId: store.id, triggeredAt: data.triggeredAt, installedAt: store.installedAt?.toISOString(), stale, state };
        if (count === 0) {
          logger.info(logFields, "app/uninstalled is about an earlier installation; ignored");
          // The uninstall still cancelled every charge made before it, and the reinstall may have
          // been handled before Shopify's word on them (or this delivery) arrived: ask Shopify which
          // still stand, when it takes the token. A failure is retried with the delivery.
          if (state === "works" && (await systemDb.subscription.count({ where: { billingStoreId: store.id } }))) {
            await syncBillingFromShopify(store, await getAccessToken(store, deps.coord, deps.fetchImpl), deps.fetchImpl);
          }
          break;
        }
        logger.info(logFields, "app/uninstalled applied");
        await audit({ workspaceId: store.workspaceId, action: "store.uninstalled", targetType: "store", targetId: store.id });
        // Shopify cancels an app's charges when it is uninstalled, and its app_subscriptions/update
        // saying so may never reach an app that is gone: the plan ends here.
        await endBillingForStore(store.id, "uninstalled");
        break;
      }
      case "app/scopes_update": {
        // Without a readable `current`, every scope would count as revoked: skipped instead.
        const update = parseShopify(scopesUpdateSchema, p, data.topic, logIds);
        if (!update) break;
        const raw = Array.isArray(update.current) ? update.current : update.current.split(",");
        const current = raw.map((s) => s.trim()).filter(Boolean);
        const newlyGranted = current.filter((s) => !store.grantedScopes.includes(s));
        const revoked = store.grantedScopes.filter((s) => !current.includes(s));
        // Granting a scope doesn't backfill the data it guards. Queue what the new scopes make
        // possible — and, for read_customers, necessary (see scopeFollowUpKinds). This fires
        // however the grant happened: our own request flow, or a merchant acting in their admin
        // where we never saw it, which is the case nothing else would cover.
        // Queued *before* the scopes are saved: "newly granted" is worked out against the saved
        // scopes, so saving first meant a retry after a failed queue send found nothing new and the
        // backfill was lost for good. This way a retry can at worst queue it twice (idempotent).
        // Held back a minute, because the jobs read the saved scopes when they run (an orders
        // import that ran before the save would skip the customer hash read_customers allows).
        await seedScopeFollowUp(deps, store, newlyGranted, { delaySeconds: SCOPE_FOLLOW_UP_DELAY_S });
        await systemDb.store.update({ where: { id: store.id }, data: { grantedScopes: current } });
        await audit({ workspaceId: store.workspaceId, action: "store.scopes_updated", targetId: store.id, metadata: { current, granted: newlyGranted, revoked } });
        break;
      }
      case "app_subscriptions/update": {
        const update = parseShopify(subscriptionUpdateSchema, p, data.topic, logIds);
        if (!update) break;
        const sub = update.app_subscription;
        await applySubscriptionUpdate(store.workspaceId, sub.admin_graphql_api_id, (sub.status ?? "unknown").toLowerCase());
        break;
      }
      // ---- Mandatory GDPR compliance topics ----
      // Never skipped: one that can't be read fails at once (UnrecoverableError: a retry would read
      // the same payload), so the delivery is recorded as failed and the store's webhook alert is
      // raised, instead of a request that wasn't carried out being marked as done.
      case "customers/data_request": {
        const request = parseShopify(customersDataRequestSchema, p, data.topic, logIds);
        if (!request) throw unreadableGdprRequest(data.topic);
        // Shopify asks the app to give the store owner what it holds about the customer. The
        // request is recorded (hashes only) and the owner downloads the export, compiled from the
        // live records, from Settings → Privacy requests (packages/core/src/privacy.ts).
        const customerId = request.customer?.id != null ? String(request.customer.id) : null;
        const { request: recorded, created } = await recordDataRequest(store, {
          requestId: String(request.data_request?.id ?? ev.webhookId),
          customerId,
          email: request.customer?.email,
          phone: request.customer?.phone,
          ordersRequested: (request.orders_requested ?? []).map(String),
        });
        if (created) {
          await audit({
            workspaceId: store.workspaceId,
            action: "gdpr.customer_data_request",
            targetType: "data_request",
            targetId: recorded.id,
            metadata: { customerId, ordersRequested: recorded.ordersRequested.length },
          });
        }
        // Until the owner has downloaded it. A retry after a failed alert raises it then (an open
        // alert isn't repeated, so a redelivery doesn't email twice).
        if (recorded.downloadedAt) break;
        await raiseAlert(
          {
            workspaceId: store.workspaceId,
            storeId: store.id,
            severity: "warning",
            code: "privacy_request",
            message:
              `A customer of ${store.shopDomain} asked, through Shopify, for the data bizinsights holds about them. ` +
              `Download it from Settings, Privacy requests, and send it to them: Shopify gives 30 days to answer.`,
          },
          deps.mailer,
          deps.fetchImpl,
        );
        break;
      }
      case "customers/redact": {
        // It must name the customer or their orders (customersRedactSchema): who else to redact?
        const redact = parseShopify(customersRedactSchema, p, data.topic, logIds);
        if (!redact) throw unreadableGdprRequest(data.topic);
        if (redact.customer?.id) {
          await systemDb.order.updateMany({ where: { storeId: store.id, customerKey: customerKey(store, String(redact.customer.id)) }, data: { customerKey: null } });
        }
        const whatsappRecords = await redactWhatsappCustomer(store, redact);
        // Email automations: the customer's events and the messages sent to them from this store.
        const emailRecords = await redactEmailCustomer(store, redact.customer?.email);
        // A data request for the same customer names them too (by hashes): it goes as well.
        if (redact.customer?.id != null) await systemDb.dataRequest.deleteMany({ where: { storeId: store.id, customerId: String(redact.customer.id) } });
        await audit({ workspaceId: store.workspaceId, action: "gdpr.customer_redacted", metadata: { whatsappRecords, emailRecords } });
        break;
      }
      case "shop/redact": {
        // Sent 48 hours after an uninstall, and when a shop closes: App Review closes its test
        // stores, and their requests came within the hour with no app/uninstalled before them. A
        // store installed again since is in use under its new installation's grant, and erasing it
        // would wipe a working store. Its status doesn't show that: a closed shop, or an uninstall
        // that never reached us or was set aside, leaves it looking installed too. The evidence is
        // an install after Shopify made this request (which is then about an earlier one), or a
        // token Shopify still accepts.
        const requestedAt = data.triggeredAt ? new Date(data.triggeredAt) : null;
        const installedSince = !!requestedAt && !!store.installedAt && store.installedAt > requestedAt;
        // Undecided on the last attempt ("unknown"), Shopify's request stands and is carried out.
        const state = store.status !== "uninstalled" && !installedSince ? await installationStateFor(deps, store, ev.attempts + 1, { topic: data.topic, shop: data.shop, storeId: store.id }) : null;
        if (store.status !== "uninstalled" && (installedSince || state === "works")) {
          const reason = installedSince ? "installed_after_request" : "installation_works";
          logger.info({ topic: data.topic, shop: data.shop, storeId: store.id, status: store.status, reason }, "shop/redact for a store installed again since; nothing erased");
          await audit({ workspaceId: store.workspaceId, action: "gdpr.shop_redact_skipped", targetType: "store", targetId: store.id, metadata: { reason } });
          break;
        }
        // A shop closed with the app still installed sends no app/uninstalled, but Shopify cancels
        // the app's charges with it: the plan billed on the store ends here as on an uninstall (a
        // no-op for a store whose uninstall already ended it). Before the erase, which unlinks it.
        await endBillingForStore(store.id, "uninstalled");
        const { workspaceErased } = await eraseStore(store, deps);
        logger.info({ topic: data.topic, shop: data.shop, storeId: store.id, status: store.status, state, workspaceErased }, "shop/redact erased the store");
        break;
      }
      default:
        // checkouts/* and fulfillments/* are only for WhatsApp (below).
        if (!data.topic.startsWith("checkouts/") && !data.topic.startsWith("fulfillment")) logger.info({ topic: data.topic }, "unhandled webhook topic");
    }
    // WhatsApp order updates, delivery updates and cart reminders (a no-op unless the store turned them on).
    // After the analytics write, and idempotent, so a retry of this delivery repeats nothing.
    await whatsappOnShopifyEvent(store, data.topic, p, deps);
    // Email automations listening to orders and checkouts (a no-op unless one is enabled). Idempotent too.
    await emailOnShopifyEvent(store, data.topic, p, deps);
  }
  await systemDb.webhookEvent.update({ where: { id: ev.id }, data: { status: "succeeded", processedAt: new Date(), error: null } });
  if (data.payloadKey) await deps.payloads.delete(data.payloadKey).catch(() => {});
  const storeId = store?.id ?? ev.storeId;
  if (storeId) await resolveAlerts(storeId, ["webhook_failed"]);
  return { ok: true };
}
