import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb, tenantDb, withTenant } from "@app/db";
import { buildApp } from "../src/app.js";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * Cross-account checks (security audit 2026-10-23, "read-side IDOR"): two accounts, each the owner
 * of its own workspace, and every route under /workspaces/:ws called by one with the other's ids.
 * The routes come from the app's own route table, so a route added later is covered the day it lands.
 * security.test.ts keeps the hand-written write cases; this file is the sweep.
 */

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));
beforeEach(async () => clean(ctx));

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/** Every method and path served under a workspace (middleware is registered as "ALL"). */
function workspaceRoutes(): Array<{ method: string; path: string }> {
  const seen = new Set<string>();
  const out: Array<{ method: string; path: string }> = [];
  for (const { method, path } of buildApp(ctx.deps).routes) {
    if (!METHODS.has(method) || !path.startsWith("/workspaces/:ws")) continue;
    if (seen.has(`${method} ${path}`)) continue;
    seen.add(`${method} ${path}`);
    out.push({ method, path });
  }
  return out;
}

/** Parameters whose shape is checked before access is: a value that passes, so the request gets that far. */
const PARAM_VALUES: Record<string, string> = { provider: "google", version: "1", productId: "1" };
const MADE_UP_ID = "c0crossaccount0000000000";

/** The path with its parameters filled in: the given ids, a value of the right shape, a constrained one's first choice, else a made-up id. */
function fill(path: string, ids: Record<string, string>): string {
  return path.replace(/:(\w+)(?:\{([^}]*)\})?/g, (_m, name: string, choices?: string) => ids[name] ?? PARAM_VALUES[name] ?? choices?.split("|")[0] ?? MADE_UP_ID);
}

/**
 * A valid query or body for the routes that check their input before they check the workspace or
 * the store: an empty one stops at 400 and would never reach the check this file is about. A new
 * route of that kind fails the sweep with its 400 until it gets an entry here.
 */
const VALID: Record<string, { query?: string; payload?: unknown }> = {
  "GET /workspaces/:ws/staff/reports": { query: "type=attendance&groupBy=employee" },
  "POST /workspaces/:ws/staff/exports": { payload: { kind: "payslip", itemId: MADE_UP_ID } },
  "PUT /workspaces/:ws/stores/:storeId/sales-calculation": {
    payload: { components: { netSales: true, additionalFees: false, duties: false, shipping: false, taxes: false }, label: null, applyToDashboard: false, presets: [] },
  },
  "PATCH /workspaces/:ws/stores/:storeId/ads/connections/:id": { payload: { enabled: false } },
  "GET /workspaces/:ws/stores/:storeId/export": { query: "section=sales" },
  "GET /workspaces/:ws/stores/:storeId/export/table": { query: "section=sales" },
  "POST /workspaces/:ws/stores/:storeId/inventory/adjustments": {
    payload: { idempotencyKey: "cross-account-check-01", variantId: "1", locationId: "1", kind: "increase", quantity: 1, expected: null, reason: "received" },
  },
  "PUT /workspaces/:ws/stores/:storeId/inventory/settings": { payload: { reconcileHours: 6, leadTimeDays: 7, coverDays: 30 } },
  "PUT /workspaces/:ws/stores/:storeId/inventory/settings/alerts": {
    payload: { lowStockThreshold: 5, emailAlerts: false, dashboardAlerts: true, whatsappAlerts: false, whatsappTemplate: null },
  },
  "PUT /workspaces/:ws/stores/:storeId/inventory/thresholds": { payload: { target: "variant", id: "1", threshold: 3 } },
};

/** Calls every route in `routes` as `as`, with `ids` filled in; returns the ones that answered anything but 404. */
async function notRefused(routes: Array<{ method: string; path: string }>, as: Record<string, string>, ids: Record<string, string>): Promise<string[]> {
  const answered: string[] = [];
  for (const { method, path } of routes) {
    const valid = VALID[`${method} ${path}`];
    const url = fill(path, ids) + (valid?.query ? `?${valid.query}` : "");
    const payload = method === "GET" ? undefined : (valid?.payload ?? {});
    const res = await ctx.app.inject({ method, url, headers: as, payload });
    if (res.statusCode !== 404) answered.push(`${method} ${path} -> ${res.statusCode} ${res.body.slice(0, 120)}`);
  }
  return answered;
}

/** Rows each workspace-scoped table holds for one workspace. */
async function rowsOf(workspaceId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const name of await workspaceTables()) {
    const [r] = await systemDb.$queryRawUnsafe<Array<{ n: number }>>(`SELECT COUNT(*)::int AS n FROM public."${name}" WHERE workspace_id = $1`, workspaceId);
    out[name] = r!.n;
  }
  return out;
}

async function workspaceTables(): Promise<string[]> {
  const rows = await systemDb.$queryRaw<Array<{ name: string }>>`
    SELECT c.relname AS name FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    WHERE c.relkind = 'r' AND EXISTS (
      SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'workspace_id' AND NOT a.attisdropped)
    ORDER BY c.relname`;
  return rows.map((r) => r.name);
}

async function twoAccounts() {
  const a = await signIn(ctx, "ua", "a@x.com");
  const b = await signIn(ctx, "ub", "b@x.com");
  const wsA = await createWorkspace(ctx, a.headers, "A");
  const wsB = await createWorkspace(ctx, b.headers, "B");
  const storeA = await createStore(wsA, "a.myshopify.com", ["read_orders", "read_products"]);
  const storeB = await createStore(wsB, "b.myshopify.com", ["read_orders", "read_products"]);
  return { a, b, wsA, wsB, storeA, storeB };
}

describe("cross-account access through the API", () => {
  it("covers the workspace routes (a guard against the route table coming back empty)", () => {
    const routes = workspaceRoutes();
    expect(routes.length).toBeGreaterThan(100);
    expect(routes.some((r) => r.path.includes(":storeId"))).toBe(true);
  });

  it("refuses every workspace route for a signed-in owner of another workspace, and changes nothing", async () => {
    const { a, wsB, storeB } = await twoAccounts();
    const before = await rowsOf(wsB);
    // Not a member: the workspace doesn't exist as far as they can tell.
    expect(await notRefused(workspaceRoutes(), a.headers, { ws: wsB, storeId: storeB.id })).toEqual([]);
    expect(await rowsOf(wsB)).toEqual(before);
    expect((await systemDb.store.findUniqueOrThrow({ where: { id: storeB.id } })).status).toBe("active");
    expect((await systemDb.workspace.findUniqueOrThrow({ where: { id: wsB } })).name).toBe("B");
  });

  it("refuses another workspace's store through one's own workspace, on every store route", async () => {
    const { a, wsA, wsB, storeB } = await twoAccounts();
    const before = await rowsOf(wsB);
    const storeRoutes = workspaceRoutes().filter((r) => r.path.includes(":storeId"));
    expect(await notRefused(storeRoutes, a.headers, { ws: wsA, storeId: storeB.id })).toEqual([]);
    expect(await rowsOf(wsB)).toEqual(before);
  });

  it("still answers the owner's own store (the 404s above are about the other account, not a broken setup)", async () => {
    const { a, wsA, storeA } = await twoAccounts();
    const own = await ctx.app.inject({ method: "GET", url: `/workspaces/${wsA}/stores/${storeA.id}/sync`, headers: a.headers });
    expect(own.statusCode).toBe(200);
    const list = await ctx.app.inject({ method: "GET", url: `/workspaces/${wsA}/stores`, headers: a.headers });
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).not.toContain("b.myshopify.com");
  });
});

describe("cross-account access in the database (the tenant role)", () => {
  it("shows a workspace only its own rows in every table it can read, and nothing without one", async () => {
    const { wsA, wsB } = await twoAccounts();
    const readable = await systemDb.$queryRaw<Array<{ name: string }>>`
      SELECT c.relname AS name FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      WHERE c.relkind = 'r' AND has_table_privilege('app_rls', c.oid, 'SELECT') AND EXISTS (
        SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'workspace_id' AND NOT a.attisdropped)
      ORDER BY c.relname`;
    expect(readable.length).toBeGreaterThan(10);

    const leaks: string[] = [];
    for (const { name } of readable) {
      const table = `public."${name}"`;
      for (const [own, other] of [[wsA, wsB], [wsB, wsA]] as const) {
        const [seen] = await withTenant(own, (tx) =>
          tx.$queryRawUnsafe<Array<{ mine: number; others: number }>>(
            `SELECT COUNT(*) FILTER (WHERE workspace_id = $1)::int AS mine, COUNT(*) FILTER (WHERE workspace_id IS DISTINCT FROM $1)::int AS others FROM ${table}`,
            own,
          ),
        );
        const [stored] = await systemDb.$queryRawUnsafe<Array<{ n: number }>>(`SELECT COUNT(*)::int AS n FROM ${table} WHERE workspace_id = $1`, own);
        if (seen!.others !== 0) leaks.push(`${name}: workspace ${own === wsA ? "A" : "B"} sees ${seen!.others} row(s) of others`);
        if (seen!.mine !== stored!.n) leaks.push(`${name}: workspace ${own === wsA ? "A" : "B"} sees ${seen!.mine} of its ${stored!.n} row(s)`);
        // Naming the other workspace explicitly doesn't help either.
        const [named] = await withTenant(own, (tx) => tx.$queryRawUnsafe<Array<{ n: number }>>(`SELECT COUNT(*)::int AS n FROM ${table} WHERE workspace_id = $1`, other));
        if (named!.n !== 0) leaks.push(`${name}: a query naming the other workspace returns ${named!.n} row(s)`);
      }
      // No workspace set (a query outside withTenant): no rows at all.
      const [bare] = await tenantDb.$queryRawUnsafe<Array<{ n: number }>>(`SELECT COUNT(*)::int AS n FROM ${table}`);
      if (bare!.n !== 0) leaks.push(`${name}: ${bare!.n} row(s) visible with no workspace set`);
    }
    expect(leaks).toEqual([]);

    // The check above saw real rows on both sides: the sign-ups made memberships, subscriptions and stores.
    for (const ws of [wsA, wsB]) {
      const own = await withTenant(ws, (tx) => tx.membership.count());
      expect(own).toBe(1);
      expect(await withTenant(ws, (tx) => tx.store.count())).toBe(1);
    }
  });

  it("keeps the other workspace out of the workspaces and users tables", async () => {
    const { a, b, wsA, wsB } = await twoAccounts();
    const workspaces = await withTenant(wsA, (tx) => tx.workspace.findMany({ select: { id: true } }));
    expect(workspaces.map((w) => w.id)).toEqual([wsA]);
    const users = await withTenant(wsA, (tx) => tx.user.findMany({ select: { id: true } }));
    expect(users.map((u) => u.id)).toEqual([a.user.id]);
    expect((await withTenant(wsB, (tx) => tx.user.findMany({ select: { id: true } }))).map((u) => u.id)).toEqual([b.user.id]);
  });

  it("has every policy filter by the workspace in context, for reads and for writes", async () => {
    const policies = await systemDb.$queryRaw<Array<{ table: string; policy: string; cmd: string; qual: string | null; check: string | null }>>`
      SELECT tablename AS table, policyname AS policy, cmd, qual, with_check AS check
      FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname`;
    expect(policies.length).toBeGreaterThan(10);
    const names = (s: string | null) => !!s && s.includes("current_setting('app.workspace_id'");
    // USING decides what's visible; WITH CHECK (or USING, when it's absent) decides what may be written.
    const loose = policies.filter((p) => (p.cmd !== "INSERT" && !names(p.qual)) || (p.check !== null && !names(p.check))).map((p) => `${p.table}.${p.policy}`);
    expect(loose).toEqual([]);
  });
});
