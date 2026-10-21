import { Prisma, systemDb, type Store } from "@app/db";
import {
  checkOrders,
  finishCheck,
  graphqlOrderSchema,
  initialState,
  logger,
  normalizeGraphqlOrder,
  noteUnlisted,
  ordersQuery,
  PAGE_SIZE,
  parseShopifyList,
  raiseAlert,
  removeOrders,
  resolveAlerts,
  setAside,
  ShopifyGraphqlError,
  startReconciliation,
  touched,
  unlistedOrders,
  upsertOrder,
  withinReach,
  verifyQueue,
  windowSearch,
  type CheckState,
  type CheckWindow,
  type Lookup,
  type Repair,
  type VerifyJob,
} from "@app/core";
import { expandScopes } from "@app/shared";
import { AccessRevokedError, shopifyReader, UnrecoverableError, type WorkerDeps } from "./handlers.js";

/**
 * The check against Shopify (packages/core/src/reconcile.ts, docs/kpis.md "Checked against
 * Shopify"): walk every order Shopify changed since the window began, compare each with what is
 * stored, write Shopify's copy of any that differs, look up the stored orders Shopify didn't list,
 * then recompute the window and keep the results.
 *
 * The walk is the orders query the import uses (whole orders with their sales records, newest
 * first by creation, so an order changed mid-walk keeps its place), a page at a time. An
 * invocation stops after WORK_MS and the job sends itself on with its progress in the run's row,
 * so a big store's check spans several jobs and a failure retries only the rest.
 */

/** How long one invocation walks before handing over to the next message (the function allows 15 minutes). */
const WORK_MS = 8 * 60_000;
/** Held by the invocation working on a run: longer than an invocation can live (15 minutes). */
const LEASE_MS = 16 * 60_000;
/** Ids per lookup of the orders Shopify didn't list (`nodes`: one point each). */
const LOOKUP_BATCH = 50;
/** While an import of the store runs, the check waits this long between looks... */
const IMPORT_WAIT_S = 600;
/** ...this many times, then gives up (the next day's check runs anyway). */
const MAX_IMPORT_WAITS = 6;

const NODES_QUERY = /* GraphQL */ `
  query OrdersStillThere($ids: [ID!]!) {
    nodes(ids: $ids) { ... on Order { id test } }
  }`;

interface Page {
  orders: { pageInfo: { hasNextPage: boolean; endCursor?: string | null }; nodes: unknown[] };
}

export async function runVerify(job: VerifyJob, deps: WorkerDeps, now = () => Date.now()) {
  // One invocation per run at a time: SQS can deliver a message twice, and two walks of one run
  // would add Shopify's totals up twice. A copy that finds the run taken leaves it to the other.
  const lease = `verify:${job.reconciliationId}`;
  if (!(await deps.coord.acquire(lease, LEASE_MS))) return { skipped: true };
  try {
    return await verifyRun(job, deps, now);
  } finally {
    await deps.coord.release(lease).catch(() => {});
  }
}

async function verifyRun(job: VerifyJob, deps: WorkerDeps, now: () => number) {
  const rec = await systemDb.reconciliation.findUnique({ where: { id: job.reconciliationId } });
  if (!rec || rec.status !== "running") return { skipped: true };
  const store = await systemDb.store.findUnique({ where: { id: job.storeId } });
  if (!store || store.status === "uninstalled" || !store.accessTokenEnc) {
    await closeFailed(rec.id, "store not connected");
    return { skipped: true };
  }
  // A full import still running (the store reads "syncing" until it ends) would read as orders
  // missing: wait for it rather than report them. Short re-pulls overlapping the check are harmless.
  if (store.status === "syncing" && rec.trigger !== "import") {
    const waits = job.importWaits ?? 0;
    if (waits >= MAX_IMPORT_WAITS) {
      await closeFailed(rec.id, "an import kept running");
      return { skipped: true };
    }
    await verifyQueue(deps.queues).send({ ...job, importWaits: waits + 1 }, { delaySeconds: IMPORT_WAIT_S });
    return { waiting: true };
  }

  const w: CheckWindow = { from: rec.fromDay, to: rec.toDay, timezone: rec.timezone };
  const state: CheckState = (rec.state as CheckState | null) ?? (await initialState(store, w));
  const shopify = shopifyReader(deps, store);
  const includeCustomer = expandScopes(store.grantedScopes).has("read_customers");
  const began = now();
  const repair = !job.dryRun;
  let pageSize: number = PAGE_SIZE.orders;
  let done = false;

  while (now() - began < WORK_MS) {
    let page: Page;
    try {
      page = await shopify.gql<Page>(ordersQuery(includeCustomer), { first: pageSize, cursor: state.cursor, query: windowSearch(w) });
    } catch (err) {
      if (err instanceof ShopifyGraphqlError && err.costExceeded && pageSize > 1) {
        pageSize = Math.max(1, Math.floor(pageSize / 2));
        continue;
      }
      throw err;
    }
    const orders = [];
    for (const node of parseShopifyList(graphqlOrderSchema, page.orders.nodes, "GraphQL order", { storeId: store.id })) {
      const full = await shopify.completeOrder(node);
      // An order that couldn't be made whole is left for the next check: storing half of it would be worse.
      if (full) orders.push(normalizeGraphqlOrder(full));
    }
    const repairs = await checkOrders(store, w, state, orders, rec.startedAt);
    if (repair) await applyRepairs(store, state, repairs);
    const info = page.orders.pageInfo;
    if (!info.hasNextPage || !info.endCursor) {
      done = true;
      break;
    }
    state.cursor = info.endCursor;
  }

  if (!done) {
    await systemDb.reconciliation.update({ where: { id: rec.id }, data: { state: state as unknown as Prisma.InputJsonValue } });
    await verifyQueue(deps.queues).send(job, { delaySeconds: Math.min(60, Math.ceil(shopify.pendingMs() / 1000)) });
    return { continued: true };
  }

  // Stored orders of the window that Shopify didn't list: deleted, test, or out of its reach. One
  // Shopify doesn't share any more (created over 60 days ago) can't be told from a deleted one, so
  // it is never looked up, let alone removed: it is "not listed", and its stored share of the window
  // is set aside so the rest can still be compared to the cent.
  let unaccounted = 0;
  if (state.seen) {
    const all = await unlistedOrders(store, w, state.seen);
    const checkedAt = new Date(now());
    await setAside(store, w, state, all.filter((x) => !withinReach(x.createdAt, store.grantedScopes, checkedAt)));
    const unlisted = all.filter((x) => withinReach(x.createdAt, store.grantedScopes, checkedAt));
    for (let i = 0; i < unlisted.length; i += LOOKUP_BATCH) {
      const batch = unlisted.slice(i, i + LOOKUP_BATCH);
      const d = await shopify.gql<{ nodes: Array<{ id?: string; test?: boolean | null } | null> }>(NODES_QUERY, {
        ids: batch.map((o) => `gid://shopify/Order/${o.id}`),
      });
      const remove: string[] = [];
      batch.forEach((o, k) => {
        const n = d.nodes[k];
        const found: Lookup = !n || !n.id ? "gone" : n.test ? "test" : "present";
        noteUnlisted(state, o, found);
        if (found === "present") unaccounted++;
        else remove.push(o.id);
      });
      if (repair && remove.length) {
        touched(state, await removeOrders(store, remove));
        state.removed += remove.length;
      }
    }
  }

  // Orders set aside don't make it incomplete; one Shopify still has but didn't list does.
  const complete = state.seen !== null && unaccounted === 0;
  const { status } = await finishCheck(store, rec, w, state, complete);
  await alertOn(store, status, state, deps);
  return { ok: true, status };
}

async function applyRepairs(store: Store, state: CheckState, repairs: Repair[]) {
  const remove = repairs.filter((r) => r.action === "remove").map((r) => r.order.shopifyId);
  if (remove.length) {
    touched(state, await removeOrders(store, remove));
    state.removed += remove.length;
  }
  for (const r of repairs) {
    if (r.action !== "write") continue;
    touched(state, await upsertOrder(store, r.order));
    state.repaired++;
  }
}

async function closeFailed(id: string, error: string) {
  await systemDb.reconciliation.update({ where: { id }, data: { status: "failed", error, finishedAt: new Date(), state: Prisma.DbNull } });
}

/**
 * A difference nothing explains is worth a person's look: an alert, resolved by the next check that
 * matches. Repairs are not: the check fixed them, and the record says what it found.
 */
async function alertOn(store: Store, status: string, state: CheckState, deps: WorkerDeps) {
  if (status === "differences") {
    await raiseAlert(
      {
        workspaceId: store.workspaceId,
        storeId: store.id,
        severity: "warning",
        code: "reconciliation_mismatch",
        message: `Checked against Shopify: figures still differ for ${store.shopDomain} (${Object.keys(state.findings).join(", ") || "no order found to explain it"})`,
      },
      deps.mailer,
      deps.fetchImpl,
    );
  } else if (status === "verified" || status === "repaired") {
    await resolveAlerts(store.id, ["reconciliation_mismatch"]);
  }
}

/**
 * Operators' `verify` action (docs/RUNBOOK.md): check every connected store, or the one named, over
 * the last `days` finished days (7 by default; at most Shopify's 60 without read_all_orders).
 * `dryRun` records what differs and repairs nothing.
 */
export async function startChecks(deps: Pick<WorkerDeps, "queues">, opts: { shop?: string; days?: number; dryRun?: boolean } = {}) {
  const stores = await systemDb.store.findMany({ where: { status: "active", ...(opts.shop ? { shopDomain: opts.shop.toLowerCase() } : {}) } });
  const started = [];
  for (const s of stores) {
    const r = await startReconciliation(deps, s, "manual", { days: opts.days, dryRun: opts.dryRun });
    started.push({ shop: s.shopDomain, reconciliationId: r?.id ?? null, started: r?.started ?? false });
  }
  logger.info({ stores: stores.length, started }, "checks against shopify started");
  return { started };
}

/** A final failure of a check job: close its run, so the dashboard doesn't wait on it. */
export async function failVerify(job: VerifyJob, err: Error) {
  // Access lost is the store's sync problem, shown there; the run just says it couldn't finish.
  const reason = err instanceof AccessRevokedError ? "Shopify refused our access" : err instanceof UnrecoverableError ? err.message : "the check failed";
  await systemDb.reconciliation
    .updateMany({ where: { id: job.reconciliationId, status: "running" }, data: { status: "failed", error: reason.slice(0, 300), finishedAt: new Date(), state: Prisma.DbNull } })
    .catch((e: unknown) => logger.error({ err: e, reconciliationId: job.reconciliationId }, "could not close a failed check"));
}
