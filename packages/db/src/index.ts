import { AsyncLocalStorage } from "node:async_hooks";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import type { CrossTenantReason } from "./crossTenant.js";
import { Prisma, PrismaClient } from "./generated/client.js";

export * from "./crossTenant.js";
export * from "./generated/client.js";

/**
 * Database access.
 *
 * Two clients:
 *  - systemDb: the system paths (auth bootstrap, webhook intake, worker jobs, sweeps). Its rows
 *    are scoped where each request, job or sweep starts (forTenant / crossTenant / withoutTenant,
 *    below), and every call site still scopes by store/workspace explicitly. Its login is the
 *    non-owner role `app_system` (docs/system-database-role.md), on which those scopes are row-level
 *    security; on the owner's login (production until the switch) they change nothing.
 *  - tenantDb: non-owner role `app_rls`. RLS policies apply, so a query that
 *    forgets a workspace filter still cannot read another tenant's rows.
 *
 * Connections come from DATABASE_URL (owner) and APP_DATABASE_URL (app_rls) and are
 * process-wide: the Lambda functions, the local server, scripts. `withDb()` runs code
 * on its own connections instead (other URLs, closed afterwards), found through
 * AsyncLocalStorage; tests use it to point one call at a database that is down. The
 * Prisma clients themselves are shared either way: see `sharedClient()`.
 * `systemDb` / `tenantDb` are those clients, so application code keeps using them as
 * plain module imports.
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
  /** This invocation's Prisma request queues, one per role and row scope (see scopedQueues). */
  queues?: Record<string, Queue>;
}

/** Prisma's per-client request queue (its internal DataLoader). */
interface Queue {
  options: unknown;
  request(request: unknown): Promise<unknown>;
}

const als = new AsyncLocalStorage<Scope>();
let nodeScope: Scope | undefined;

/**
 * How long a transaction may run before Prisma expires it, for every client and every
 * `$transaction` (interactive and batch).
 *
 * Prisma's default is 5s, which proved too tight: when Postgres was reached over a slow link
 * (35-961ms a statement), the dashboard overview crossed 5s and the whole request 500'd with
 * "A query cannot be executed on an expired transaction" - it had already spent 5608ms - and
 * the worker's order writes failed the same way ("7247 ms passed since the start of the
 * transaction"), spending a queue attempt each time on work that would have committed.
 *
 * This raises the ceiling; it does not make anything faster, and it does not make an outage
 * slower to notice: the timer never interrupts a statement in flight, and an unreachable
 * database fails the statement itself in about a second.
 */
const TX_TIMEOUT_MS = 20_000;
/**
 * How long to wait for a pooled connection plus BEGIN. Prisma's 2s default tripped on the worker
 * ("Unable to start a transaction in the given time") while connections were being re-established.
 */
const TX_MAX_WAIT_MS = 5_000;

function scope(): Scope {
  const s = als.getStore();
  if (s) return s;
  nodeScope ??= {
    urls: { system: process.env.DATABASE_URL ?? "", tenant: process.env.APP_DATABASE_URL },
  };
  return nodeScope;
}

/**
 * The tenant role's connection string. Development and tests may run both roles on one login;
 * production never does: there, tenant queries on the owner's login would run without row-level
 * security and nothing would say so, so a missing APP_DATABASE_URL (APP_RLS_PASSWORD not in the
 * environment's secret) fails every tenant query instead.
 */
function tenantUrl(urls: DbUrls): string {
  if (urls.tenant) return urls.tenant;
  if (process.env.NODE_ENV === "production") {
    throw new Error("APP_DATABASE_URL is not set: tenant queries would run on the owner's login, outside row-level security. Set APP_RLS_PASSWORD (infra/cdk/scripts/put-secrets.mjs).");
  }
  return urls.system;
}

/** The current scope's connection pool for `role`, opened on first use. */
function connection(role: Role): Promise<Adapter> {
  const s = scope();
  const url = role === "system" ? s.urls.system : tenantUrl(s.urls);
  // A function instance serves one request at a time: three connections per role cover a
  // request's parallel queries without crowding RDS's connection limit across many instances.
  return (s[role] ??=
    role === "system"
      ? new PrismaPg(new SystemPool({ connectionString: url, max: 3 }), { disposeExternalPool: true }).connect()
      : new PrismaPg({ connectionString: url, max: 3 }).connect());
}

/**
 * Whose rows `systemDb` sees (docs/system-database-role.md).
 *
 * The system role is not the tables' owner, so row-level security applies to it as it does to
 * app_rls: `forTenant` shows one workspace's rows, `crossTenant` every workspace's (for a reason on
 * the reviewed list, crossTenant.ts), `withoutTenant` none, only the tables that belong to no
 * workspace (people, sign-in). Each is set once where a request, a job or a sweep starts, and every
 * `systemDb` call under it, however deep, inherits it.
 *
 * Unlike `withTenant` it is not a transaction: an ad sync waits seconds on Meta and must not hold one
 * open. The two settings the policies read (app.scope, app.workspace_id) stay on each pooled
 * connection instead, re-sent only when it was last checked out for another scope (SystemPool). A
 * transaction keeps the scope it began in.
 */
export interface RowScope {
  kind: "tenant" | "all" | "none";
  /** The workspace of a `tenant` scope; empty otherwise. */
  workspaceId: string;
  reason?: CrossTenantReason;
}

const rows = new AsyncLocalStorage<RowScope>();

/** Run `fn` with `systemDb` seeing one workspace's rows (and the tables that belong to none). */
export async function forTenant<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  if (!workspaceId) throw new Error("forTenant requires a workspaceId");
  // Awaited inside the scope, like withDb: a Prisma query starts only when awaited.
  return rows.run({ kind: "tenant", workspaceId }, async () => await fn());
}

/** Run `fn` with `systemDb` seeing every workspace's rows, for a reason on the reviewed list. */
export async function crossTenant<T>(reason: CrossTenantReason, fn: () => Promise<T>): Promise<T> {
  return rows.run({ kind: "all", workspaceId: "", reason }, async () => await fn());
}

/** Run `fn` with `systemDb` seeing no workspace's rows: only people, sign-in and intake tables. */
export async function withoutTenant<T>(fn: () => Promise<T>): Promise<T> {
  return rows.run({ kind: "none", workspaceId: "" }, async () => await fn());
}

/** The row scope `systemDb` is in here, if any. */
export function rowScope(): RowScope | undefined {
  return rows.getStore();
}

let unscopedListener: (() => void) | undefined;

/**
 * Called for each system query that runs in no row scope. Until every entry point names one
 * (docs/system-database-role.md, step 3) such a query still sees every workspace, as on the owner's
 * login; core logs where it came from.
 */
export function onUnscopedSystemQuery(listener: (() => void) | undefined) {
  unscopedListener = listener;
}

interface RowSettings {
  key: string;
  scope: RowScope["kind"];
  workspaceId: string;
}

const UNSCOPED: RowSettings = { key: "all:", scope: "all", workspaceId: "" };

function rowSettings(): RowSettings {
  const r = rows.getStore();
  if (!r) {
    unscopedListener?.();
    return UNSCOPED;
  }
  return { key: `${r.kind}:${r.workspaceId}`, scope: r.kind, workspaceId: r.workspaceId };
}

const APPLIED = Symbol("rowSettings");
type ScopedClient = pg.PoolClient & { [APPLIED]?: string };
type ConnectCallback = (err: Error | undefined, client: pg.PoolClient | undefined, done: (release?: boolean | Error) => void) => void;

/**
 * The system role's pool: each connection it hands out carries the current row scope. The scope
 * is read when connect() is called, not when the connection arrives: pg-pool hands a released
 * connection to the next caller from inside the releasing caller's code, in that caller's async
 * context. PrismaPg's statements come through here too (pool.query checks out with connect()).
 */
class SystemPool extends pg.Pool {
  override connect(): Promise<pg.PoolClient>;
  override connect(callback: ConnectCallback): void;
  override connect(callback?: ConnectCallback): Promise<pg.PoolClient> | void {
    const want = rowSettings();
    const ready = super.connect().then((client) => applyRowSettings(client as ScopedClient, want));
    if (!callback) return ready;
    ready.then(
      (client) => callback(undefined, client, client.release),
      (err: Error) => callback(err, undefined, () => {}),
    );
  }
}

async function applyRowSettings(client: ScopedClient, want: RowSettings): Promise<pg.PoolClient> {
  if (client[APPLIED] === want.key) return client;
  try {
    // Session-level (false): checked out, a connection is never inside a transaction.
    await client.query("SELECT set_config('app.scope', $1, false), set_config('app.workspace_id', $2, false)", [want.scope, want.workspaceId]);
  } catch (err) {
    client.release(err as Error);
    throw err;
  }
  client[APPLIED] = want.key;
  return client;
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
    startTransaction: async (isolationLevel) => oneAtATime(await (await connection(role)).startTransaction(isolationLevel)),
    // What PrismaPg reports without options: the default schema, and joins done in SQL.
    getConnectionInfo: () => ({ schemaName: undefined, supportsRelationJoins: true }),
    // Pools belong to scopes, and withDb()/disconnectDb() close them.
    dispose: async () => {},
  };
  return { provider: adapter.provider, adapterName: adapter.adapterName, connect: async () => adapter };
}

type Transaction = Awaited<ReturnType<Adapter["startTransaction"]>>;

/**
 * A transaction's statements, sent one at a time. Prisma batches the findUniques that code issues
 * in parallel inside a transaction (Promise.all over `tx`) and sent the batch at once, all on the
 * transaction's one connection: pg queued them, with a DeprecationWarning, and pg@9 refuses them.
 * They ran in order on that connection either way, so waiting here costs nothing. Savepoints go
 * through executeRaw, so they wait their turn too; a statement that fails doesn't hold up the rest.
 */
function oneAtATime(tx: Transaction): Transaction {
  let last: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(run: () => Promise<T>): Promise<T> => {
    const next = last.then(run);
    last = next.catch(() => {});
    return next;
  };
  const queryRaw = tx.queryRaw.bind(tx);
  const executeRaw = tx.executeRaw.bind(tx);
  tx.queryRaw = (query) => inTurn(() => queryRaw(query));
  tx.executeRaw = (query) => inTurn(() => executeRaw(query));
  return tx;
}

const shared: Partial<Record<Role, PrismaClient>> = {};

/**
 * One Prisma client per role for the whole process, never one per request.
 *
 * Building a client is expensive in CPU, not I/O: the constructor decodes the schema's
 * parameterization tables (~15 ms measured) and connecting builds the WASM query compiler, which
 * parses the whole schema again (~11 ms), and each client starts with an empty query plan cache.
 * Made fresh for every request - twice, one per role - that was ~50 ms of CPU before the first
 * statement was sent.
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
 * scopes, one scope's query could wait in that queue and then be sent from another scope's timer:
 * on that scope's connections, which it closes when it finishes, leaving the query hanging. So
 * every scope gets its own queue, built with the
 * shared one's options (same batching, same handlers), and the shared client's queue only hands
 * each call to the current scope's. The same goes for row scopes (forTenant and the others): a
 * batch runs in the row scope of the call that started it, so each row scope has a queue too.
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
      const r = rows.getStore();
      const key = r ? `${role}|${r.kind}:${r.workspaceId}` : role;
      return (queues[key] ??= new NewQueue(own.options)).request(request);
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
 * This is how the queue consumer tells "the database is down" from a job's own failure. Matching
 * driver errors cannot do that reliably: a dropped socket arrives as a plain Error with no code,
 * and a stalled link as nothing at all - hence the timeout. Never throws.
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
