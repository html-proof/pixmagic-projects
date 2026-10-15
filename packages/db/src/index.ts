import { AsyncLocalStorage } from "node:async_hooks";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "./generated/client.js";

export * from "./generated/client.js";

/**
 * Database access.
 *
 * Two roles, same as before:
 *  - systemDb: owner connection. Bypasses RLS. Use ONLY for auth bootstrap,
 *    webhook intake, worker jobs, migrations. Every call site scopes by
 *    store/workspace explicitly.
 *  - tenantDb: non-owner role `app_rls`. RLS policies apply, so a query that
 *    forgets a workspace filter still cannot read another tenant's rows.
 *
 * On Workers a database connection must not outlive the request (or queue
 * batch) that opened it, so connections are opened per invocation by `withDb()`
 * (connection strings come from the Hyperdrive bindings) and found through
 * AsyncLocalStorage. The Prisma clients themselves are NOT per invocation: see
 * `sharedClient()`. `systemDb` / `tenantDb` are those clients, so application
 * code keeps using them as plain module imports.
 * In Node (tests, scripts) with no scope, process-wide connections are used.
 */
export interface DbUrls {
  system: string;
  tenant?: string;
}

type Role = "system" | "tenant";
type AdapterFactory = Prisma.PrismaClientOptionsWithAdapter["adapter"];
type Adapter = Awaited<ReturnType<AdapterFactory["connect"]>>;

interface Scope {
  urls: DbUrls;
  /** This invocation's connection pools, opened on first use. */
  system?: Promise<Adapter>;
  tenant?: Promise<Adapter>;
  /** This invocation's Prisma request queues (see scopedQueues). */
  queues?: Partial<Record<Role, Queue>>;
}

/** Prisma's per-client request queue (its internal DataLoader). */
interface Queue {
  options: unknown;
  request(request: unknown): Promise<unknown>;
}

const als = new AsyncLocalStorage<Scope>();
let nodeScope: Scope | undefined;

const isWorkers = typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";

/**
 * How long a transaction may run before Prisma expires it, for every client and every
 * `$transaction` (interactive and batch).
 *
 * Prisma's default is 5s, which is wrong for this deployment. Postgres is not local to the
 * Worker: it is reached over a Cloudflare Tunnel, so every statement pays real network latency
 * (35-961ms observed on the hotspot). The dashboard overview crossed 5s and the whole request
 * 500'd with "A query cannot be executed on an expired transaction" - it had already spent
 * 5608ms - and the worker's order writes fail the same way ("7247 ms passed since the start of
 * the transaction"), spending a queue attempt each time on work that would have committed.
 *
 * This raises the ceiling; it does not make anything faster, and it does not make an outage
 * slower to notice: the timer never interrupts a statement in flight, and a dead tunnel fails the
 * statement itself in about a second.
 */
const TX_TIMEOUT_MS = 20_000;
/**
 * How long to wait for a pooled connection plus BEGIN. Prisma's 2s default tripped on the worker
 * ("Unable to start a transaction in the given time") while Hyperdrive was re-establishing its
 * connections through the tunnel.
 */
const TX_MAX_WAIT_MS = 5_000;

function scope(): Scope {
  const s = als.getStore();
  if (s) return s;
  if (isWorkers) throw new Error("Database used outside withDb(): wrap the handler so connections stay request-scoped");
  nodeScope ??= {
    urls: { system: process.env.DATABASE_URL ?? "", tenant: process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL },
  };
  return nodeScope;
}

/** The current scope's connection pool for `role`, opened on first use. */
function connection(role: Role): Promise<Adapter> {
  const s = scope();
  const url = role === "system" ? s.urls.system : (s.urls.tenant ?? s.urls.system);
  // Workers allow 6 concurrent outbound connections per invocation; two pools x 3 stays under it.
  return (s[role] ??= new PrismaPg({ connectionString: url, max: 3 }).connect());
}

async function closeScope(s: Scope) {
  const open = [s.system, s.tenant];
  // A query issued after this (nothing awaits it today) opens a fresh pool instead of failing on an ended one.
  s.system = s.tenant = undefined;
  await Promise.allSettled(open.map((pool) => pool?.then((a) => a.dispose())));
}

/**
 * The driver adapter a shared client is built on: it holds no connection of its own and runs each
 * statement, and each transaction, on the current scope's pool for its role. A transaction stays
 * on the pooled connection that began it (Prisma keeps the object startTransaction returned).
 */
function scopedAdapter(role: Role): AdapterFactory {
  const adapter: Adapter = {
    provider: "postgres",
    adapterName: "@prisma/adapter-pg",
    queryRaw: async (query) => (await connection(role)).queryRaw(query),
    executeRaw: async (query) => (await connection(role)).executeRaw(query),
    executeScript: async (script) => (await connection(role)).executeScript(script),
    startTransaction: async (isolationLevel) => (await connection(role)).startTransaction(isolationLevel),
    // What PrismaPg reports without options: the default schema, and joins done in SQL.
    getConnectionInfo: () => ({ schemaName: undefined, supportsRelationJoins: true }),
    // Pools belong to scopes, and withDb()/disconnectDb() close them.
    dispose: async () => {},
  };
  return { provider: adapter.provider, adapterName: adapter.adapterName, connect: async () => adapter };
}

const shared: Partial<Record<Role, PrismaClient>> = {};

/**
 * One Prisma client per role for the whole isolate (or Node process), never one per request.
 *
 * Building a client is expensive in CPU, not I/O: the constructor decodes the schema's
 * parameterization tables (~15 ms measured) and connecting builds the WASM query compiler, which
 * parses the whole schema again (~11 ms), and each client starts with an empty query plan cache.
 * Made fresh for every request - twice, one per role - that was ~50 ms of CPU before the first
 * statement was sent, five times the Workers Free plan's 10 ms limit, and every request died with
 * "Worker exceeded CPU time limit" (Cloudflare error 1102, a 503), /readyz included.
 *
 * Shared clients pay that once. They stay connected for good: their adapter (scopedAdapter) has
 * no connection to close, and the request's own pools are closed by withDb().
 */
function sharedClient(role: Role): PrismaClient {
  if (shared[role]) return shared[role];
  const client = new PrismaClient({
    adapter: scopedAdapter(role),
    transactionOptions: { maxWait: TX_MAX_WAIT_MS, timeout: TX_TIMEOUT_MS },
  });
  scopedQueues(role, client);
  return (shared[role] = client);
}

/**
 * Prisma queues every findUnique, and every query of a transaction, in one queue per client (its
 * DataLoader), sent on a timer that the first queued call sets. On a client shared by concurrent
 * requests, one request's query could wait in that queue and then be sent from another request's
 * timer: on that request's connections, in that request's I/O context, which Workers tears down
 * when it finishes, leaving the query hanging. So every scope gets its own queue, built with the
 * shared one's options (same batching, same handlers), and the shared client's queue only hands
 * each call to the current scope's.
 *
 * This reaches into Prisma's internals (`_requestHandler.dataloader`), so it checks their shape and
 * fails every query if an upgrade changed it; the "queries from concurrent scopes" test (in
 * apps/api/test/outage.test.ts) fails without it.
 */
function scopedQueues(role: Role, client: PrismaClient) {
  const handler = (client as unknown as { _requestHandler?: { dataloader?: Queue } })._requestHandler;
  const own = handler?.dataloader;
  if (!handler || !own || typeof own.request !== "function" || !own.options) {
    throw new Error("Prisma's request queue is not where @app/db expects it (scopedQueues): check it before upgrading Prisma");
  }
  const NewQueue = own.constructor as new (options: unknown) => Queue;
  handler.dataloader = {
    options: own.options,
    request(request) {
      const queues = (scope().queues ??= {});
      return (queues[role] ??= new NewQueue(own.options)).request(request);
    },
  };
}

export const systemDb: PrismaClient = new Proxy({} as PrismaClient, {
  get(_t, prop) {
    const c = sharedClient("system");
    const v = Reflect.get(c, prop, c) as unknown;
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(c) : v;
  },
});
export const tenantDb: PrismaClient = new Proxy({} as PrismaClient, {
  get(_t, prop) {
    const c = sharedClient("tenant");
    const v = Reflect.get(c, prop, c) as unknown;
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(c) : v;
  },
});

/**
 * Build both clients and their query compilers now. The Worker calls this at module top level,
 * where CPU counts against the startup budget instead of the first request's 10 ms; connecting
 * opens nothing (scopedAdapter connects lazily), so it does no I/O. Never throws: a failure here
 * just leaves the work to the first query, as without it.
 */
export function warmDb(): void {
  for (const role of ["system", "tenant"] as const) {
    try {
      void sharedClient(role).$connect().catch(() => {});
    } catch {
      /* the first query builds it */
    }
  }
}

/**
 * Run `fn` with request-scoped database connections (opened lazily, on first use)
 * and close them afterwards.
 */
export async function withDb<T>(urls: DbUrls, fn: () => Promise<T>): Promise<T> {
  const s: Scope = { urls };
  try {
    // Awaited inside the scope: a Prisma query is a lazy thenable that starts only when awaited,
    // and it finds its scope's connections from wherever it starts.
    return await als.run(s, async () => await fn());
  } finally {
    await closeScope(s);
  }
}

/** Close the Node process-wide connections and the shared clients (tests, scripts). */
export async function disconnectDb() {
  const s = nodeScope;
  nodeScope = undefined;
  if (s) await closeScope(s);
  await Promise.allSettled([shared.system?.$disconnect(), shared.tenant?.$disconnect()]);
}

/**
 * Whether the database answers right now: `SELECT 1`, bounded by `timeoutMs`.
 *
 * This is how the queue consumer tells "the tunnel to Postgres is down" from a job's own failure.
 * Matching driver errors cannot do that here: through Hyperdrive an unreachable origin arrives as
 * an ordinary Postgres error response, a dropped socket as a plain Error with no code, and a
 * stalled link as nothing at all - hence the timeout. Never throws.
 */
export async function dbReachable(timeoutMs = 3_000): Promise<boolean> {
  return (await probeDb(() => systemDb.$queryRaw`SELECT 1`, timeoutMs)).ok;
}

export type ProbeResult = { ok: true } | { ok: false; error: unknown };

/**
 * Run a trivial query (`SELECT 1` on the client you pick) bounded by `timeoutMs`, and say why it
 * failed when it did, for health checks that log the reason. Never throws.
 */
export async function probeDb(query: () => Promise<unknown>, timeoutMs = 3_000): Promise<ProbeResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const probe = (async (): Promise<ProbeResult> => {
    await query();
    return { ok: true };
  })().catch((error: unknown): ProbeResult => ({ ok: false, error }));
  const timedOut = new Promise<ProbeResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: new Error(`no answer within ${timeoutMs} ms`) }), timeoutMs);
  });
  try {
    return await Promise.race([probe, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

export type Tx = Prisma.TransactionClient;

/**
 * Run `fn` inside a transaction with `app.workspace_id` set, so RLS policies
 * restrict every statement to that workspace. Application code must ALSO pass
 * workspaceId in its where-clauses (defense in depth).
 *
 * The transaction itself is not optional: RLS reads `app.workspace_id`, set by `set_config(...,
 * true)` whose third argument scopes it to the transaction, so the queries must share it. That is
 * why the dashboard overview's many sequential round trips all count against one transaction's
 * timeout (TX_TIMEOUT_MS); reducing them is the real fix for its latency.
 */
export async function withTenant<T>(workspaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!workspaceId) throw new Error("withTenant requires a workspaceId");
  return tenantDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    return fn(tx);
  });
}

export function toNumber(d: Prisma.Decimal | number | null | undefined): number {
  if (d === null || d === undefined) return 0;
  return typeof d === "number" ? d : d.toNumber();
}
