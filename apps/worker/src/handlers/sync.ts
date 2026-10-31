/** The sync queue's store jobs: the first import (and later ones), products and customers, and the pixel's registration. */
import { runBulkOrders } from "../bulkOrders.js";
import { systemDb } from "@app/db";
import { env, logger, normalizeGraphqlOrder, normalizeGraphqlProduct, normalizeGraphqlVariant, ordersQuery, PAGE_SIZE, parseShopifyList, productCollectionsOverflow, PRODUCTS_QUERY, resolveAlerts, graphqlOrderSchema, graphqlProductSchema, graphqlVariantSchema, SHOP_QUERY, upsertOrder, VARIANTS_QUERY, WEB_PIXEL_CREATE, WEB_PIXEL_QUERY, WEB_PIXEL_UPDATE, bulkUpsertProducts, bulkUpsertVariants, settleReturningCustomers, startReconciliation, backfillDays, finishHistoryWindow, historyWindowSearch, OLDEST_ORDER_QUERY, recordHistoryExport, startHistoryWindow, startOrderHistory, type SyncJobData } from "@app/core";
import { expandScopes } from "@app/shared";
import { enqueueAggregate, type WorkerDeps } from "./common.js";
import { completeOrder, fetchPage, gql, MAX_PACE_DELAY_S, readProductCollections, type Pace, type Page } from "./shopifyRead.js";
import { runInventoryStep } from "./inventory.js";

/** Shopify only exposes the last 60 days of orders without read_all_orders. */
export const BACKFILL_DAYS = 60;

/** Orders a backfill aggregates page-by-page before switching to a single pass at the end. */
export const AGG_EAGER_ORDERS = 500;

/**
 * Orders search filter for a sync message. The initial backfill (no sinceDays) pulls
 * all history when the store granted read_all_orders, else the last BACKFILL_DAYS by
 * creation date; reconcile/refresh (short sinceDays) re-pull recently *updated* orders.
 */
export function ordersSearch(data: Pick<SyncJobData, "sinceDays">, grantedScopes: string[], now = Date.now()): string | null {
  if (!data.sinceDays && expandScopes(grantedScopes).has("read_all_orders")) return null;
  const since = new Date(now - (data.sinceDays ?? BACKFILL_DAYS) * 86400_000).toISOString();
  const field = data.sinceDays && data.sinceDays < BACKFILL_DAYS ? "updated_at" : "created_at";
  return `${field}:>='${since}'`;
}

/**
 * From when an orders job that ran to the end has every order in (stores.orders_history_from):
 * the epoch for a first backfill with read_all_orders (the whole history), else the start of the
 * creation-date window `ordersSearch` asked for, which Shopify cuts at BACKFILL_DAYS without
 * read_all_orders. Null for a reconcile or refresh: it re-pulls recently *updated* orders, which
 * covers no window of creation dates. Called when the job finishes, so the window it reports
 * starts a little after the one searched, never before.
 */
export function importedFrom(data: Pick<SyncJobData, "sinceDays">, grantedScopes: string[], now = Date.now()): Date | null {
  const allOrders = expandScopes(grantedScopes).has("read_all_orders");
  if (!data.sinceDays && allOrders) return new Date(0);
  if (data.sinceDays && data.sinceDays < BACKFILL_DAYS) return null;
  const days = allOrders ? (data.sinceDays ?? BACKFILL_DAYS) : Math.min(data.sinceDays ?? BACKFILL_DAYS, BACKFILL_DAYS);
  return new Date(now - days * 86400_000);
}

type PixelUserError = { code: string; message: string };

/** The ingest URL in a web pixel's settings: Shopify returns them as a JSON string (or, defensively, an object). */
export function pixelIngestUrl(settings: unknown): string | null {
  try {
    const s = typeof settings === "string" ? (JSON.parse(settings) as unknown) : settings;
    const url = s && typeof s === "object" ? (s as { ingestUrl?: unknown }).ingestUrl : null;
    return typeof url === "string" ? url : null;
  } catch {
    return null;
  }
}

/**
 * One sync step. Paginated kinds (products, variants, orders) process a single page
 * per queue message and re-enqueue themselves with the next cursor, so a large
 * store never runs into the per-invocation time limit and a failure retries
 * only the page that failed.
 */
export async function runSync(data: SyncJobData, deps: WorkerDeps) {
  const store = await systemDb.store.findUnique({ where: { id: data.storeId } });
  if (!store || store.status === "uninstalled") return { skipped: true };
  const job = await systemDb.syncJob.findUnique({ where: { id: data.syncJobId } });
  if (!job || job.status === "succeeded") return { skipped: true }; // redelivery
  // An inventory pass also starts each location's levels without a cursor, and a full history each
  // year (`history`): only the job's first message starts it.
  if (!data.cursor && !data.history && !(data.kind === "inventory" && data.inventory && data.inventory.phase !== "locations")) {
    const now = new Date();
    await systemDb.syncJob.update({ where: { id: job.id }, data: { status: "running", startedAt: now, lastActivityAt: now, attempts: { increment: 1 } } });
  }
  const pace: Pace = { pendingMs: 0 };
  // Whatever delay is still owed after this page's last Shopify call rides on the next message
  // rather than being slept here. Capped so a nonsense restoreRate reading cannot park a chain.
  //
  // `pageSize` climbs back toward the default on every successful page. Halving on
  // MAX_COST_EXCEEDED used to be permanent - the reduced size rides in the message, so one
  // transient rejection pinned the whole rest of the chain at half speed (or a quarter, if it
  // happened twice), doubling the number of pages and therefore the number of paced waits.
  const next = (cursor: string, progress: number, defaultSize?: number) =>
    deps.queues.sync.send(
      { ...data, cursor, progress, ...(data.pageSize && defaultSize ? { pageSize: Math.min(defaultSize, data.pageSize * 2) } : {}) },
      { delaySeconds: Math.min(MAX_PACE_DELAY_S, Math.ceil(pace.pendingMs / 1000)) },
    );
  const halved = { ok: true, continued: true } as const;

  switch (data.kind) {
    case "shop": {
      const d = await gql<{ shop: { name: string; currencyCode: string; ianaTimezone: string; createdAt?: string | null } }>(deps, store, pace, SHOP_QUERY);
      // When Shopify created the store: where the dashboard's dates begin. Kept as it was when
      // Shopify's answer has none that reads as a time.
      const created = d.shop.createdAt ? new Date(d.shop.createdAt) : null;
      await systemDb.store.update({
        where: { id: store.id },
        data: {
          name: d.shop.name,
          currency: d.shop.currencyCode,
          timezone: d.shop.ianaTimezone,
          ...(created && !Number.isNaN(created.getTime()) ? { shopCreatedAt: created } : {}),
        },
      });
      // Fan out the jobs that were waiting on the time zone. Only day-bucketed kinds wait here
      // (see NEEDS_TIMEZONE in packages/core/src/seedSync.ts); the catalog was enqueued at seed time and
      // is already running, so re-sending it would duplicate the work.
      //
      // Exactly the jobs seeded with this one. Every queued orders row of the store also took in
      // rows a dead chain or another connect had left behind, and started each as a competing
      // backfill. `startedAt: null` keeps a redelivered shop job from re-sending one that has
      // been picked up since; a row the watchdog gave up on before it ever started still goes.
      const pending = await systemDb.syncJob.findMany({
        where: {
          storeId: store.id,
          startedAt: null,
          ...(data.waitingJobIds
            ? { id: { in: data.waitingJobIds } }
            : // Sent before the ids were carried: the orders rows seeded in the same breath as this job.
              { kind: "orders", createdAt: { gte: job.createdAt, lt: new Date(job.createdAt.getTime() + 60_000) } }),
        },
      });
      for (const j of pending) {
        await deps.queues.sync.send({ storeId: store.id, kind: j.kind as SyncJobData["kind"], syncJobId: j.id });
      }
      break;
    }
    case "products": {
      const d = await fetchPage<{ products: Page<unknown> }>(deps, store, pace, data, PRODUCTS_QUERY, PAGE_SIZE.products);
      if (!d) return halved;
      const nodes = parseShopifyList(graphqlProductSchema, d.products.nodes, "GraphQL product", { storeId: store.id });
      const products = nodes.map(normalizeGraphqlProduct);
      // A product in more collections than its page holds has the rest read before it is stored.
      for (const [i, node] of nodes.entries()) {
        const after = productCollectionsOverflow(node);
        if (after) products[i]!.collections = await readProductCollections(deps, store, pace, node.id, after, products[i]!.collections);
      }
      await bulkUpsertProducts(store, products);
      const n = (data.progress ?? 0) + d.products.nodes.length;
      await systemDb.syncJob.update({ where: { id: data.syncJobId }, data: { progress: n, lastActivityAt: new Date() } });
      if (d.products.pageInfo.hasNextPage && d.products.pageInfo.endCursor) {
        await next(d.products.pageInfo.endCursor, n, PAGE_SIZE.products);
        return { ok: true, continued: true };
      }
      break;
    }
    case "variants": {
      const d = await fetchPage<{ productVariants: Page<unknown> }>(deps, store, pace, data, VARIANTS_QUERY, PAGE_SIZE.variants);
      if (!d) return halved;
      const variants = parseShopifyList(graphqlVariantSchema, d.productVariants.nodes, "GraphQL variant", { storeId: store.id });
      await bulkUpsertVariants(store, variants.map(normalizeGraphqlVariant));
      const n = (data.progress ?? 0) + d.productVariants.nodes.length;
      await systemDb.syncJob.update({ where: { id: data.syncJobId }, data: { progress: n, lastActivityAt: new Date() } });
      if (d.productVariants.pageInfo.hasNextPage && d.productVariants.pageInfo.endCursor) {
        await next(d.productVariants.pageInfo.endCursor, n, PAGE_SIZE.variants);
        return { ok: true, continued: true };
      }
      break;
    }
    case "orders": {
      // Shared by both paths: everything is in, so settle the returning-customer guesses,
      // aggregate every day once, and only then call the store fully synced.
      const finishBackfill = async () => {
        if (!data.sinceDays) {
          // enqueueAggregate chunks at 31 days, so a 60-day window is two messages rather than
          // the ~1,400 a per-page backfill would have sent. A full history added each year's days
          // up as the year came in: only the days whose returning customers changed are left.
          const changed = await settleReturningCustomers(store.id);
          await enqueueAggregate(deps, store.id, data.history ? changed : await backfillDays(store.id));
        }
        // Where the imported history now starts, for the dashboard's "No earlier data": the
        // earliest window any import has covered (orders are never deleted short of a purge).
        const from = importedFrom(data, store.grantedScopes);
        if (from) {
          await systemDb.store.updateMany({
            where: { id: store.id, OR: [{ ordersHistoryFrom: null }, { ordersHistoryFrom: { gt: from } }] },
            data: { ordersHistoryFrom: from },
          });
          // And every order of the window carries its customer, for an import queued once the store
          // held read_customers (stores.customers_from, the grant's moment until an import moves it
          // back; null: no grant recorded, or given up since): customers are known from its start.
          // One queued before the grant read orders without their customer, at least at first.
          if (expandScopes(store.grantedScopes).has("read_customers")) {
            await systemDb.store.updateMany({
              where: { id: store.id, customersFrom: { lte: job.createdAt, gt: from } },
              data: { customersFrom: from },
            });
          }
        }
        // Only a full backfill (or a refresh of a store that already had one) means "fully
        // synced". A 3-day reconcile finishing on a store whose backfill failed must not hide
        // that failure: lastSyncedAt stays null, so "Refresh data" re-runs the full import.
        if (!data.sinceDays || store.lastSyncedAt) {
          await systemDb.store.update({ where: { id: store.id }, data: { status: "active", lastSyncedAt: new Date() } });
        }
        // A first import is checked against Shopify once it is in (its whole window), after its
        // day totals have had a few minutes to be added up. The import is done whatever the check finds.
        if (!data.sinceDays) {
          const fresh = await systemDb.store.findUnique({ where: { id: store.id } });
          if (fresh) {
            await startReconciliation(deps, fresh, "import", { days: BACKFILL_DAYS, delaySeconds: 300 }).catch((err: unknown) =>
              logger.warn({ err, storeId: store.id }, "couldn't start the check of the import against Shopify"),
            );
          }
        }
      };

      // A full import with read_all_orders reads the store's whole history one calendar year at a
      // time, newest first (orderHistory in core): the first message plans the years (or resumes
      // an import that stopped), each year is read as below, then the next one is sent.
      const wholeHistory = !data.sinceDays && expandScopes(store.grantedScopes).has("read_all_orders");
      let year = null;
      if (wholeHistory) {
        let windowId = data.history?.windowId;
        if (!windowId) {
          const first = await startOrderHistory(store, job.id, async () => {
            const o = await gql<{ orders: { nodes: Array<{ createdAt: string }> } }>(deps, store, pace, OLDEST_ORDER_QUERY);
            const at = o.orders.nodes[0]?.createdAt;
            return at ? new Date(at) : null;
          });
          if (!first) {
            // No orders at all: the whole (empty) history is in.
            await finishBackfill();
            break;
          }
          windowId = first.id;
          // The year rides on every message from here (pages, bulk steps, a fall back to paged).
          data = { ...data, history: { windowId } };
        }
        year = await systemDb.orderHistoryWindow.findUnique({ where: { id: windowId } });
        // Planned over since this message was sent (a purge, a newer import): that import reads the
        // years now. This job is over, said so here rather than left running for the stale-job sweep,
        // which would take the store's import for dead while the newer one runs.
        if (!year || year.planJobId !== job.id) {
          await systemDb.syncJob.update({ where: { id: job.id }, data: { status: "failed", finishedAt: new Date(), error: "Replaced by a newer import of the order history" } });
          return { skipped: true };
        }
        // A redelivery of a year already in: the chain went on without it.
        if (year.status === "done") return { skipped: true };
        // A year's first message (whichever path it takes) starts it; its pages and bulk steps carry on.
        if (year.status !== "running") await startHistoryWindow(year.id, job.id);
      }
      const search = year ? historyWindowSearch(year) : ordersSearch(data, store.grantedScopes);
      // The window just read is in: the whole backfill, or one year of the history, after which the
      // next year goes out as a message of its own (`false`: nothing more in this message).
      const finished = async (): Promise<boolean> => {
        if (!year) {
          await finishBackfill();
          return true;
        }
        const { days, next: nextYear } = await finishHistoryWindow(store, year);
        await enqueueAggregate(deps, store.id, new Set(days));
        logger.info({ storeId: store.id, year: year.year, days: days.length, next: nextYear?.year ?? null }, "order history year imported");
        if (!nextYear) {
          await finishBackfill();
          return true;
        }
        const progress = (await systemDb.syncJob.findUnique({ where: { id: job.id }, select: { progress: true } }))?.progress ?? data.progress;
        await deps.queues.sync.send({ storeId: store.id, kind: "orders", syncJobId: job.id, history: { windowId: nextYear.id }, progress });
        return false;
      };

      // A first backfill goes through Shopify's Bulk Operations API, which is exempt from the
      // query-cost budget that caps the paged walk at ~7 orders per 8.6s. Short `sinceDays`
      // jobs (reconcile/refresh) stay paged: a handful of pages, where submitting an export and
      // polling for it would be slower. `pagedOnly` is set once bulk has failed for this job (for
      // a history year: for that year).
      if (!data.sinceDays && !data.pagedOnly) {
        const reading = year;
        const r = await runBulkOrders(data, store, deps, {
          gql: (query, variables) => gql(deps, store, pace, query, variables),
          ordersSearch: () => search,
          ...(reading ? { historyYear: { ownsExport: (id: string) => reading.bulkOperationId === id, exportStarted: (id: string) => recordHistoryExport(reading.id, id) } } : {}),
        });
        if (!r.done || !(await finished())) return { ok: true, continued: true };
        break;
      }

      const includeCustomer = expandScopes(store.grantedScopes).has("read_customers");
      const d = await fetchPage<{ orders: Page<unknown> }>(deps, store, pace, data, ordersQuery(includeCustomer), PAGE_SIZE.orders, { query: search });
      if (!d) return halved;
      let n = data.progress ?? 0;
      const days = new Set<string>();
      for (const node of parseShopifyList(graphqlOrderSchema, d.orders.nodes, "GraphQL order", { storeId: store.id })) {
        const full = await completeOrder(deps, store, pace, node);
        if (!full) continue;
        for (const day of await upsertOrder(store, normalizeGraphqlOrder(full))) days.add(day);
        n++;
      }
      await systemDb.syncJob.update({ where: { id: data.syncJobId }, data: { progress: n, lastActivityAt: new Date() } });
      // A backfill aggregates its first pages eagerly and the rest once at the end. Each
      // recompute is a full rescan of the affected days, and orders arrive a few at a time, so
      // aggregating every page made a busy day's totals get rebuilt once per page touching it -
      // hundreds of times over an import, all but the last of them thrown away. The eager
      // window is what the merchant actually looks at: newest-first means those first pages are
      // the recent days the 7- and 30-day presets read, so the dashboard still lights up at
      // once. Short `sinceDays` jobs (reconcile/refresh) keep aggregating per page - a handful
      // of pages, where latency matters more than the duplicated work.
      if (!data.sinceDays && n > AGG_EAGER_ORDERS) {
        logger.debug({ storeId: store.id, orders: n }, "backfill past the eager window; aggregating at the end");
      } else {
        await enqueueAggregate(deps, store.id, days);
      }
      if (d.orders.pageInfo.hasNextPage && d.orders.pageInfo.endCursor) {
        await next(d.orders.pageInfo.endCursor, n, PAGE_SIZE.orders);
        return { ok: true, continued: true };
      }
      if (!(await finished())) return { ok: true, continued: true };
      break;
    }
    case "inventory": {
      if ((await runInventoryStep(data, store, deps, pace)) === "continued") return { ok: true, continued: true };
      break;
    }
    case "install_pixel": {
      const ingestUrl = `${env().API_URL}/pixel/${store.pixelIngestKey}`;
      const settings = JSON.stringify({ ingestUrl });
      const d = await gql<{ webPixelCreate: { userErrors: PixelUserError[]; webPixel: { id: string } | null } }>(deps, store, pace, WEB_PIXEL_CREATE, { settings });
      const errs = d.webPixelCreate.userErrors.filter((e) => e.code !== "TAKEN");
      if (errs.length) throw new Error(`webPixelCreate: ${errs.map((e) => e.message).join("; ")}`);
      // TAKEN: the store already has our pixel, posting wherever it was told when it was made. After
      // a move to a new address (a new deployment, or a custom domain) that is the old host, which
      // would keep receiving the storefront's events for good: point it here instead.
      if (d.webPixelCreate.userErrors.length) {
        const { webPixel } = await gql<{ webPixel: { id: string; settings: unknown } | null }>(deps, store, pace, WEB_PIXEL_QUERY);
        if (webPixel && pixelIngestUrl(webPixel.settings) !== ingestUrl) {
          const u = await gql<{ webPixelUpdate: { userErrors: PixelUserError[] } }>(deps, store, pace, WEB_PIXEL_UPDATE, { id: webPixel.id, settings });
          if (u.webPixelUpdate.userErrors.length) throw new Error(`webPixelUpdate: ${u.webPixelUpdate.userErrors.map((e) => e.message).join("; ")}`);
          logger.info({ storeId: store.id }, "pointed the store's web pixel at this address");
        }
      }
      await systemDb.store.update({ where: { id: store.id }, data: { pixelInstalled: true } });
      // From now on the pixel counts visits, for the dashboard's "No earlier data". A pixel put in
      // place again (a move, a reinstall) keeps the first time: the visits since then are kept.
      await systemDb.store.updateMany({ where: { id: store.id, pixelInstalledAt: null }, data: { pixelInstalledAt: new Date() } });
      break;
    }
  }
  await systemDb.syncJob.update({ where: { id: data.syncJobId }, data: { status: "succeeded", finishedAt: new Date(), error: null } });
  // This kind syncs again, so its failure alert is over (and the next failure gets announced).
  // Except a short orders refresh on a store whose full import never completed: that import is
  // still the open problem, and the store stays in `error` for it (see finishBackfill).
  if (!(data.kind === "orders" && data.sinceDays && !store.lastSyncedAt)) {
    await resolveAlerts(store.id, [`sync_${data.kind}_failed`, `sync_${data.kind}_stalled`, `sync_${data.kind}_not_approved`]);
  }
  return { ok: true };
}
