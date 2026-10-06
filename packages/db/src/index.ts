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
 * batch) that opened it, so clients are created per invocation by `withDb()`
 * (connection strings come from the Hyperdrive bindings) and found through
 * AsyncLocalStorage. `systemDb` / `tenantDb` are proxies to the current scope's
 * clients, so application code keeps using them as plain module imports.
 * In Node (tests, scripts) with no scope, a process-wide client is used.
 */
export interface DbUrls {
  system: string;
  tenant?: string;
}

interface Scope {
  urls: DbUrls;
  system?: PrismaClient;
  tenant?: PrismaClient;
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

// Workers allow 6 concurrent outbound connections per invocation; two clients x 3 stays under it.
function newClient(connectionString: string) {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString, max: 3 }),
    transactionOptions: { maxWait: TX_MAX_WAIT_MS, timeout: TX_TIMEOUT_MS },
  });
}

function scope(): Scope {
  const s = als.getStore();
  if (s) return s;
  if (isWorkers) throw new Error("Database used outside withDb(): wrap the handler so connections stay request-scoped");
  nodeScope ??= {
    urls: { system: process.env.DATABASE_URL ?? "", tenant: process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL },
  };
  return nodeScope;
}

function client(kind: "system" | "tenant"): PrismaClient {
  const s = scope();
  if (kind === "system") return (s.system ??= newClient(s.urls.system));
  return (s.tenant ??= newClient(s.urls.tenant ?? s.urls.system));
}

function proxy(kind: "system" | "tenant"): PrismaClient {
  return new Proxy({} as PrismaClient, {
    get(_t, prop) {
      const c = client(kind);
      const v = Reflect.get(c, prop, c) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(c) : v;
    },
  });
}

export const systemDb: PrismaClient = proxy("system");
export const tenantDb: PrismaClient = proxy("tenant");

/**
 * Run `fn` with request-scoped database clients (created lazily, on first use)
 * and close them afterwards.
 */
export async function withDb<T>(urls: DbUrls, fn: () => Promise<T>): Promise<T> {
  const s: Scope = { urls };
  try {
    return await als.run(s, fn);
  } finally {
    await Promise.allSettled([s.system?.$disconnect(), s.tenant?.$disconnect()]);
  }
}

/** Close the Node process-wide clients (tests, scripts). */
export async function disconnectDb() {
  const s = nodeScope;
  nodeScope = undefined;
  await Promise.allSettled([s?.system?.$disconnect(), s?.tenant?.$disconnect()]);
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  const probe = (async () => {
    await systemDb.$queryRaw`SELECT 1`;
    return true;
  })().catch(() => false);
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
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
