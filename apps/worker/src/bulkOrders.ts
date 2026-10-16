import { systemDb, type Store } from "@app/db";
import { expandScopes } from "@app/shared";
import {
  BULK_OPERATION_CANCEL,
  BULK_OPERATION_NODE,
  BULK_OPERATION_RUN_QUERY,
  bulkOrdersQuery,
  CURRENT_BULK_OPERATION,
  graphqlOrderSchema,
  logger,
  normalizeGraphqlOrder,
  parseShopifyList,
  writeOrderBatch,
  type BulkOperationStatus,
  type GraphqlOrder,
  type NormalizedOrder,
  type SyncJobData,
} from "@app/core";
import type { WorkerDeps } from "./handlers.js";

/**
 * The first order backfill, through Shopify's Bulk Operations API.
 *
 * The paged walk in handlers.ts is bounded by Shopify's query-cost budget, not by our code: an
 * Order node costs 123 points, Shopify rejects any query over 1000, and the bucket refills at
 * ~100/s - so about 7 orders every 8.6s, or roughly an hour and a half for 5,000 orders,
 * however well it is written. Bulk operations are exempt from that budget entirely: Shopify
 * runs the query server-side and hands back one JSONL file, turning the same import into
 * minutes.
 *
 * Three queue phases, never a sleep, so a slow export never occupies one of the four
 * `insights-sync` slots:
 *
 *   start   adopt or submit the operation
 *   poll    re-enqueue with `delaySeconds` until Shopify says COMPLETED
 *   ingest  read the JSONL a chunk at a time, each chunk its own message
 *
 * The export can't carry refund line items (see `bulkOrdersQuery`), so the ingest completes the
 * orders that have refunds with the paged path's own detail query, one call per such order.
 *
 * Every failure falls back to the paged path instead of failing the job. The merchant should
 * see a slow import, never a broken one, and the paged path is already correct and tested.
 */

/** Bytes of JSONL read per ingest invocation. */
const CHUNK_BYTES = 2 * 1024 * 1024;
/** Ceiling when one order's children do not fit in a chunk. */
const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
/** Orders per database transaction while ingesting. */
const WRITE_BATCH = 400;
/**
 * Orders with refunds one ingest invocation completes, one ORDER_REFUNDS_QUERY each. A chunk
 * dense with them stops early, so the calls stay far inside the function's 15 minutes.
 */
export const MAX_REFUND_LOOKUPS = 200;
/** Give up polling after this many attempts (about an hour at the backoff below). */
const MAX_POLLS = 150;
/** A RUNNING operation older than this is assumed dead and cancelled. */
const STALE_OPERATION_MS = 2 * 60 * 60 * 1000;
/** How long `start` holds the store's export lock unless something releases it first. */
const LOCK_TTL_MS = 10 * 60_000;
/** While another job holds the lock, `start` re-sends itself this far apart... */
const LOCK_WAIT_S = 60;
/** ...this many times: past LOCK_TTL_MS, so a lock still held then is not the one it first found. */
const MAX_LOCK_WAITS = 12;

/**
 * 1s, 2s, 4s, 8s, 16s, then every 30s. A small store's export finishes in about a second, and
 * the old 5s floor meant every import — however tiny — waited at least that long before anyone
 * looked. The tail is unchanged, so MAX_POLLS still covers a bit over an hour of exporting.
 */
const pollDelayS = (polls: number) => Math.min(30, 2 ** Math.min(polls, 5));

/** `done` means the backfill is complete and the caller should run its finish sequence. */
export type BulkResult = { done: boolean };

export interface BulkApi {
  gql: <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;
  /** The backfill window, from the same `ordersSearch` the paged path uses. */
  ordersSearch: () => string | null;
  /**
   * The paged path's `completeOrder`: fills in what the export left out (refund line items)
   * with the per-order detail queries. Null when what they returned doesn't fit (logged).
   */
  completeOrder: (order: GraphqlOrder) => Promise<GraphqlOrder | null>;
}

const lockKey = (storeId: string) => `bulk:orders:${storeId}`;

/**
 * One JSONL line: an order, or a child naming its parent in `__parentId`. Only what reassembly
 * needs is read from it; the rest is checked once the order is whole (graphqlOrderSchema).
 */
type Line = Record<string, unknown>;

/** A line that isn't a JSON object reads as an empty one: an order without an id, which the order schema skips (logged). */
const asLine = (v: unknown): Line => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Line) : {});

/**
 * Rebuild the order node `ordersQuery` would have returned from a run of JSONL lines.
 *
 * Shopify emits one line per object: a parent order with no `__parentId`, then its line items,
 * each naming the order as its parent. Plain list fields (`fulfillments`, `refunds`) are inlined
 * on the parent instead; the refunds come without their line items, which the ingest fills in.
 *
 * Children are matched by `__parentId`, never by position, so the only ordering this relies on
 * is Shopify's guarantee that a child follows its parent.
 *
 * The result goes to the unchanged `normalizeGraphqlOrder`: one normalizer for both paths, so
 * money parsing, gid handling and time zones cannot drift apart between them.
 */
export function reassembleOrders(lines: Line[]): Line[] {
  const orders: Line[] = [];
  const lineItemsOf = new Map<string, unknown[]>();

  for (const line of lines) {
    if (!line.__parentId) {
      const lineItems: unknown[] = [];
      orders.push({ ...line, lineItems: { nodes: lineItems } });
      lineItemsOf.set(String(line.id), lineItems);
      continue;
    }
    const parentId = String(line.__parentId);
    const siblings = lineItemsOf.get(parentId);
    if (siblings) {
      siblings.push(line);
      continue;
    }
    // Chunks are cut at parent boundaries precisely so this cannot happen. Dropping a line item
    // silently would understate that order's sales, so it is worth a log line if it ever does.
    logger.warn({ parentId }, "bulk JSONL child with no parent in this chunk; skipped");
  }
  return orders;
}

/** JSONL text to parsed lines, dropping a trailing partial line unless this is the end. */
function parseLines(text: string, atEnd: boolean): { lines: Line[]; raw: string[] } {
  const parts = text.split("\n");
  if (!atEnd) parts.pop(); // the range request may have cut mid-line
  const raw = parts.filter((l) => l.trim().length > 0);
  return { lines: raw.map((l) => asLine(JSON.parse(l))), raw };
}

/**
 * Cut a chunk so it ends just before its last parent.
 *
 * A chunk always starts at a parent (the previous one guaranteed it), so this keeps every
 * order whole within a single invocation and means no state has to be carried between them.
 * That matters here: there is nowhere good to park a half-assembled order between invocations.
 */
function cutAtLastParent(lines: Line[], raw: string[]): { lines: Line[]; raw: string[] } | null {
  for (let i = lines.length - 1; i > 0; i--) {
    if (!lines[i]!.__parentId) return { lines: lines.slice(0, i), raw: raw.slice(0, i) };
  }
  return null;
}

/**
 * Cut a batch just before the order that would take it past MAX_REFUND_LOOKUPS orders with
 * refunds; null when it is within that already. Like `cutAtLastParent` it cuts only at a parent.
 */
function capRefundLookups(lines: Line[], raw: string[]): { lines: Line[]; raw: string[] } | null {
  let refunded = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.__parentId || !Array.isArray(line.refunds) || line.refunds.length === 0) continue;
    if (++refunded > MAX_REFUND_LOOKUPS) return { lines: lines.slice(0, i), raw: raw.slice(0, i) };
  }
  return null;
}

const byteLength = (s: string) => new TextEncoder().encode(s).length;

function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

async function bulkStatus(api: BulkApi, id: string): Promise<BulkOperationStatus | null> {
  const d = await api.gql<{ node: BulkOperationStatus | null }>(BULK_OPERATION_NODE, { id });
  return d.node ?? null;
}

/**
 * Hand this job back to the paged walk. Deliberately NOT a failure: the data is still
 * reachable, only more slowly. `pagedOnly` stops the paged path bouncing back into bulk.
 * `holdsLock` is false only for a job that never got the export lock: it must not free another's.
 */
async function fallbackToPaged(data: SyncJobData, deps: WorkerDeps, reason: string, holdsLock = true): Promise<BulkResult> {
  logger.warn(
    { storeId: data.storeId, syncJobId: data.syncJobId, bulkId: data.bulk?.id, reason },
    "bulk order backfill unavailable; falling back to the paged path",
  );
  if (holdsLock) await deps.coord.release(lockKey(data.storeId));
  await deps.queues.sync.send({ storeId: data.storeId, kind: "orders", syncJobId: data.syncJobId, pagedOnly: true });
  return { done: false };
}

const nextBulk = (data: SyncJobData, deps: WorkerDeps, bulk: NonNullable<SyncJobData["bulk"]>, delaySeconds?: number) =>
  deps.queues.sync.send({ ...data, bulk }, delaySeconds ? { delaySeconds } : undefined);

export async function runBulkOrders(data: SyncJobData, store: Store, deps: WorkerDeps, api: BulkApi): Promise<BulkResult> {
  const phase = data.bulk?.phase ?? "start";
  if (phase === "start") return startBulk(data, store, deps, api);
  if (phase === "poll") return pollBulk(data, deps, api);
  return ingestBulk(data, store, deps, api);
}

async function startBulk(data: SyncJobData, store: Store, deps: WorkerDeps, api: BulkApi): Promise<BulkResult> {
  // Shopify allows one export per shop per app, and a store can be connected twice in quick
  // succession, so take the lock before looking at what is running.
  if (!(await deps.coord.acquire(lockKey(store.id), LOCK_TTL_MS))) {
    // Someone else's export: wait for it rather than bow out. Returning here used to end this
    // job's chain with its row left "running", for the watchdog to fail - and flip the store to
    // error - half an hour later, however well the other import went. Once the lock is free this
    // job adopts or reads the same export (the adopt branches below) and finishes its own row.
    // Not a throw: the six queue attempts are spent in under three minutes, far inside the TTL.
    const waits = data.bulk?.lockWaits ?? 0;
    if (waits >= MAX_LOCK_WAITS) return fallbackToPaged(data, deps, `export lock still held after ${waits} waits`, false);
    logger.info({ storeId: store.id, syncJobId: data.syncJobId, waits }, "another bulk backfill holds this store's export lock; waiting for it");
    await deps.queues.sync.send({ ...data, bulk: { phase: "start", lockWaits: waits + 1 } }, { delaySeconds: LOCK_WAIT_S });
    return { done: false };
  }
  try {
    return await adoptOrSubmit(data, store, deps, api);
  } catch (err) {
    // The retry is this same job, and with the lock still held it would take itself for a
    // competing backfill. Freed, it re-acquires and adopts the export this attempt may already
    // have submitted. Best-effort: the Coordinator does not need Postgres, so this works through a
    // database outage, but a failed release must not hide the error that matters.
    await deps.coord.release(lockKey(store.id)).catch(() => {});
    throw err;
  }
}

async function adoptOrSubmit(data: SyncJobData, store: Store, deps: WorkerDeps, api: BulkApi): Promise<BulkResult> {
  const current = (await api.gql<{ currentBulkOperation: BulkOperationStatus | null }>(CURRENT_BULK_OPERATION)).currentBulkOperation;
  const age = current?.createdAt ? Date.now() - Date.parse(current.createdAt) : Number.POSITIVE_INFINITY;
  if (current && (current.status === "RUNNING" || current.status === "CREATED")) {
    if (age < STALE_OPERATION_MS) {
      // It is scoped to app + shop, so it is ours - almost always an earlier attempt of this
      // same job. Adopt it; starting a second one would be refused anyway.
      logger.info({ storeId: store.id, bulkId: current.id }, "adopting the bulk operation already running for this shop");
      await nextBulk(data, deps, { phase: "poll", id: current.id, polls: 0 }, pollDelayS(0));
      return { done: false };
    }
    await api.gql(BULK_OPERATION_CANCEL, { id: current.id }).catch(() => undefined);
  } else if (current?.status === "COMPLETED" && current.url && age < STALE_OPERATION_MS) {
    // A redelivered `start` after the export already finished: skip straight to reading it.
    logger.info({ storeId: store.id, bulkId: current.id }, "a completed bulk export is already waiting; ingesting it");
    await nextBulk(data, deps, { phase: "ingest", id: current.id, byteOffset: 0 });
    return { done: false };
  }

  const includeCustomer = expandScopes(store.grantedScopes).has("read_customers");
  const run = await api.gql<{
    bulkOperationRunQuery: {
      bulkOperation: { id: string; status: string } | null;
      userErrors: Array<{ field?: string[]; message: string; code?: string }>;
    };
  }>(BULK_OPERATION_RUN_QUERY, { query: bulkOrdersQuery(includeCustomer, api.ordersSearch()) });

  const { bulkOperation, userErrors } = run.bulkOperationRunQuery;
  if (!bulkOperation || userErrors?.length) {
    const why = (userErrors ?? []).map((e) => e.message).join("; ") || "no operation returned";
    return fallbackToPaged(data, deps, `bulkOperationRunQuery rejected: ${why}`);
  }
  const now = new Date();
  await systemDb.syncJob.update({
    where: { id: data.syncJobId },
    data: { status: "running", startedAt: now, lastActivityAt: now, attempts: { increment: 1 } },
  });
  logger.info({ storeId: store.id, bulkId: bulkOperation.id }, "bulk order backfill started");
  await nextBulk(data, deps, { phase: "poll", id: bulkOperation.id, polls: 0 }, pollDelayS(0));
  return { done: false };
}

async function pollBulk(data: SyncJobData, deps: WorkerDeps, api: BulkApi): Promise<BulkResult> {
  const id = data.bulk?.id;
  if (!id) return fallbackToPaged(data, deps, "poll without a bulk operation id");
  const polls = data.bulk?.polls ?? 0;
  const op = await bulkStatus(api, id);
  if (!op) return fallbackToPaged(data, deps, "bulk operation disappeared");

  switch (op.status) {
    case "CREATED":
    case "RUNNING":
      if (polls >= MAX_POLLS) return fallbackToPaged(data, deps, `still running after ${polls} polls`);
      await nextBulk(data, deps, { phase: "poll", id, polls: polls + 1 }, pollDelayS(polls));
      return { done: false };
    case "COMPLETED":
      // A store with no orders in the window still has to reach "fully synced", so finish here
      // rather than queueing an ingest of a file that does not exist.
      if (!op.url || Number(op.objectCount ?? 0) === 0) {
        logger.info({ storeId: data.storeId, bulkId: id }, "bulk order backfill returned no orders");
        await deps.coord.release(lockKey(data.storeId));
        return { done: true };
      }
      await nextBulk(data, deps, { phase: "ingest", id, byteOffset: 0 });
      return { done: false };
    default:
      // FAILED / CANCELED / EXPIRED. `partialDataUrl` is deliberately ignored: the paged path
      // re-walks the same window anyway, and its upserts are idempotent, so a partial file
      // would buy nothing but a second code path to get wrong.
      return fallbackToPaged(data, deps, `bulk operation ${op.status}${op.errorCode ? ` (${op.errorCode})` : ""}`);
  }
}

async function ingestBulk(data: SyncJobData, store: Store, deps: WorkerDeps, api: BulkApi): Promise<BulkResult> {
  const id = data.bulk?.id;
  if (!id) return fallbackToPaged(data, deps, "ingest without a bulk operation id");
  // Re-resolved every chunk rather than carried in the message: the result link is a
  // short-lived signed URL, and re-reading it makes expiry a non-event instead of a failure.
  const op = await bulkStatus(api, id);
  const url = op?.url ?? op?.partialDataUrl;
  if (!url) return fallbackToPaged(data, deps, "bulk result url is gone");
  // The only URL we fetch that a response handed us (Shopify's signed result link): HTTPS only.
  if (!isHttpsUrl(url)) return fallbackToPaged(data, deps, "bulk result url is not https");

  const byteOffset = data.bulk?.byteOffset ?? 0;
  let chunk = CHUNK_BYTES;
  let applied: { lines: Line[]; raw: string[]; atEnd: boolean } | null = null;

  while (chunk <= MAX_CHUNK_BYTES) {
    const res = await deps.fetchImpl(url, { headers: { Range: `bytes=${byteOffset}-${byteOffset + chunk - 1}` } });
    if (res.status !== 206 && res.status !== 200) return fallbackToPaged(data, deps, `bulk result fetch returned ${res.status}`);
    const body = new Uint8Array(await res.arrayBuffer());
    // A 200 means the server ignored Range and sent the whole file, which is still correct -
    // this chunk is simply the rest of it, once what earlier chunks read is skipped.
    const text = new TextDecoder().decode(res.status === 200 ? body.subarray(byteOffset) : body);
    const range = res.headers.get("content-range");
    const total = range ? Number(range.split("/")[1]) : NaN;
    const atEnd = res.status === 200 || !Number.isFinite(total) || byteOffset + body.length >= total;

    const { lines, raw } = parseLines(text, atEnd);
    if (atEnd) {
      applied = { lines, raw, atEnd: true };
      break;
    }
    const cut = cutAtLastParent(lines, raw);
    if (cut) {
      applied = { ...cut, atEnd: false };
      break;
    }
    // One order's children filled the entire chunk: widen rather than split the order.
    chunk *= 2;
  }
  if (!applied) return fallbackToPaged(data, deps, `one order exceeds ${MAX_CHUNK_BYTES} bytes of JSONL`);
  const capped = capRefundLookups(applied.lines, applied.raw);
  if (capped) applied = { ...capped, atEnd: false };

  const orders: NormalizedOrder[] = [];
  for (const node of parseShopifyList(graphqlOrderSchema, reassembleOrders(applied.lines), "bulk order", { storeId: store.id, bulkId: id })) {
    // Refunds arrive without their line items (see bulkOrdersQuery); an order without refunds
    // comes back as it was, without a call.
    const full = await api.completeOrder(node);
    if (full) orders.push(normalizeGraphqlOrder(full));
  }
  const days = new Set<string>();
  for (let i = 0; i < orders.length; i += WRITE_BATCH) {
    for (const d of await writeOrderBatch(store, orders.slice(i, i + WRITE_BATCH))) days.add(d);
  }

  // Progress rides in the message, so a redelivery of this chunk re-derives the same number
  // rather than counting its orders twice - the invariant the paged path already relies on.
  const progress = (data.progress ?? 0) + orders.length;
  await systemDb.syncJob.update({ where: { id: data.syncJobId }, data: { progress, lastActivityAt: new Date() } });

  if (applied.atEnd) {
    logger.info({ storeId: store.id, bulkId: id, orders: progress }, "bulk order backfill ingested");
    await deps.coord.release(lockKey(store.id));
    return { done: true };
  }
  // Aggregate what has landed so the dashboard fills while the rest streams in; the final pass
  // at the end of the backfill recomputes every day once anyway.
  await enqueueDays(deps, store.id, days);
  const bytes = applied.raw.reduce((a, l) => a + byteLength(l) + 1, 0);
  await deps.queues.sync.send({ ...data, progress, bulk: { phase: "ingest", id, byteOffset: byteOffset + bytes } });
  return { done: false };
}

/** Same 31-day chunking as handlers.ts `enqueueAggregate`, kept local to avoid an import cycle. */
async function enqueueDays(deps: WorkerDeps, storeId: string, days: Set<string>) {
  const list = [...days].sort();
  for (let i = 0; i < list.length; i += 31) {
    await deps.queues.aggregate.send({ storeId, days: list.slice(i, i + 31) });
  }
}
