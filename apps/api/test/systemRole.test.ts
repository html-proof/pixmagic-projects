import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CROSS_TENANT_REASONS, crossTenant, forTenant, onUnscopedSystemQuery, rowScope, systemDb, withDb, withoutTenant } from "@app/db";
import { queryAs } from "@app/db/testing";
import { buildApp } from "../src/app.js";
import { pathScope } from "../src/rowScope.js";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * The system role (docs/system-database-role.md). systemDb's login, app_system, isn't the tables'
 * owner, so row-level security keeps one workspace out of another's rows on the system paths too:
 * an ad connection's credentials, a store's reports and automation rules included. Only the paths
 * that name a reason (@app/db crossTenant.ts) read across workspaces.
 *
 * Everything that checks the role runs on its login (asSystem), whichever login the rest of the
 * suite gives systemDb; seeding and counting what is really stored use the suite's own.
 */

const SYSTEM_URL = process.env.APP_SYSTEM_DATABASE_URL!;
const asSystem = <T>(fn: () => Promise<T>) => withDb({ system: SYSTEM_URL, tenant: process.env.APP_DATABASE_URL }, fn);

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));
beforeEach(async () => clean(ctx));

async function twoAccounts() {
  const a = await signIn(ctx, "ua", "a@x.com");
  const b = await signIn(ctx, "ub", "b@x.com");
  const wsA = await createWorkspace(ctx, a.headers, "A");
  const wsB = await createWorkspace(ctx, b.headers, "B");
  const storeA = await createStore(wsA, "a.myshopify.com", ["read_orders", "read_products"]);
  const storeB = await createStore(wsB, "b.myshopify.com", ["read_orders", "read_products"]);
  // An ad account each: its credentials are what one business must never reach of another's.
  for (const [ws, store] of [[wsA, storeA], [wsB, storeB]] as const) {
    await systemDb.adConnection.create({ data: { workspaceId: ws, storeId: store.id, provider: "meta", accountId: `act_${ws}`, accessTokenEnc: "sealed", tokenKeyVersion: 1 } });
  }
  return { a, b, wsA, wsB, storeA, storeB };
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

describe("the system role", () => {
  it("is not the owner, a superuser or exempt from row-level security, and can't change a table", async () => {
    const [role] = await systemDb.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean }>>`
      SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = 'app_system'`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false });
    const owned = await systemDb.$queryRaw<Array<{ tablename: string }>>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tableowner = 'app_system'`;
    expect(owned).toEqual([]);
    const [rights] = await systemDb.$queryRaw<Array<{ create: boolean; owner: boolean; truncate: boolean; migrations: boolean }>>`
      SELECT has_schema_privilege('app_system', 'public', 'CREATE') AS create,
             pg_has_role('app_system', (SELECT tableowner FROM pg_tables WHERE tablename = 'stores'), 'MEMBER') AS owner,
             has_table_privilege('app_system', 'public.stores', 'TRUNCATE') AS truncate,
             has_table_privilege('app_system', 'public._prisma_migrations', 'SELECT') AS migrations`;
    expect(rights).toEqual({ create: false, owner: false, truncate: false, migrations: false });
    await asSystem(async () => {
      await expect(systemDb.$executeRawUnsafe(`ALTER TABLE stores DISABLE ROW LEVEL SECURITY`)).rejects.toThrow(/owner/);
      await expect(systemDb.$executeRawUnsafe(`DROP TABLE ad_connections`)).rejects.toThrow(/owner/);
    });
  });

  it("shows a workspace only its own rows in every table, and none of anyone's without a scope", async () => {
    const { wsA, wsB } = await twoAccounts();
    const tables = await workspaceTables();
    expect(tables.length).toBeGreaterThan(100);
    const leaks: string[] = [];
    await asSystem(async () => {
      for (const name of tables) {
        const table = `public."${name}"`;
        for (const [own, other] of [[wsA, wsB], [wsB, wsA]] as const) {
          const [seen] = await forTenant(own, () =>
            systemDb.$queryRawUnsafe<Array<{ others: number }>>(`SELECT COUNT(*) FILTER (WHERE workspace_id IS DISTINCT FROM $1)::int AS others FROM ${table}`, own),
          );
          if (seen!.others !== 0) leaks.push(`${name}: workspace ${own === wsA ? "A" : "B"} sees ${seen!.others} row(s) of others`);
          // Naming the other workspace explicitly doesn't help either.
          const [named] = await forTenant(own, () => systemDb.$queryRawUnsafe<Array<{ n: number }>>(`SELECT COUNT(*)::int AS n FROM ${table} WHERE workspace_id = $1`, other));
          if (named!.n !== 0) leaks.push(`${name}: a query naming the other workspace returns ${named!.n} row(s)`);
        }
        const [none] = await withoutTenant(() => systemDb.$queryRawUnsafe<Array<{ n: number }>>(`SELECT COUNT(*)::int AS n FROM ${table}`));
        if (none!.n !== 0) leaks.push(`${name}: ${none!.n} row(s) visible without a workspace`);
      }
    });
    expect(leaks).toEqual([]);
  });

  it("keeps another workspace's ad accounts, stores and members out of reach, for reads and for writes", async () => {
    const { wsA, wsB, storeA, storeB } = await twoAccounts();
    await asSystem(() =>
      forTenant(wsA, async () => {
        expect((await systemDb.adConnection.findMany()).map((c) => c.workspaceId)).toEqual([wsA]);
        expect(await systemDb.adConnection.findFirst({ where: { workspaceId: wsB } })).toBeNull();
        expect(await systemDb.store.findUnique({ where: { id: storeB.id } })).toBeNull();
        expect((await systemDb.membership.findMany()).every((m) => m.workspaceId === wsA)).toBe(true);
        expect((await systemDb.workspace.findMany()).map((w) => w.id)).toEqual([wsA]);
        // Writes: another workspace's rows can't be changed, nor rows made for it.
        expect((await systemDb.adConnection.updateMany({ where: { workspaceId: wsB }, data: { accessTokenEnc: "stolen" } })).count).toBe(0);
        expect((await systemDb.store.deleteMany({ where: { id: storeB.id } })).count).toBe(0);
        await expect(systemDb.adConnection.create({ data: { workspaceId: wsB, storeId: storeB.id, provider: "google", accountId: "planted", accessTokenEnc: "x", tokenKeyVersion: 1 } })).rejects.toThrow(/row-level security/);
        // Its own rows are there to work with.
        expect((await systemDb.store.findUniqueOrThrow({ where: { id: storeA.id } })).workspaceId).toBe(wsA);
      }),
    );
    // Nothing of B's changed (counted on the suite's own login).
    expect((await systemDb.adConnection.findFirstOrThrow({ where: { workspaceId: wsB } })).accessTokenEnc).toBe("sealed");
    expect(await systemDb.adConnection.count({ where: { accountId: "planted" } })).toBe(0);
    expect(await systemDb.store.count({ where: { id: storeB.id } })).toBe(1);
  });

  it("reads across workspaces only inside crossTenant, and the people and sign-in tables in every scope", async () => {
    const { wsA, wsB } = await twoAccounts();
    await asSystem(async () => {
      const all = await crossTenant("sweep", () => systemDb.adConnection.findMany({ orderBy: { workspaceId: "asc" } }));
      expect(all.map((c) => c.workspaceId).sort()).toEqual([wsA, wsB].sort());
      const users = await systemDb.user.count();
      for (const scoped of [() => withoutTenant(() => systemDb.user.count()), () => forTenant(wsA, () => systemDb.user.count())]) {
        expect(await scoped()).toBe(users);
      }
      expect(await withoutTenant(() => systemDb.authIdentity.count())).toBeGreaterThanOrEqual(2);
    });
  });

  it("has a policy on every workspace table that opens it only inside crossTenant, and opens only the listed tables in every scope", async () => {
    const policies = await systemDb.$queryRaw<Array<{ table: string; policy: string; qual: string; check: string }>>`
      SELECT tablename AS table, policyname AS policy, qual, with_check AS check
      FROM pg_policies WHERE schemaname = 'public' AND roles = '{app_system}' ORDER BY tablename, policyname`;
    const all = policies.filter((p) => p.policy === "system_all");
    expect(all.map((p) => p.table).sort()).toEqual([...(await workspaceTables()), "workspaces"].sort());
    for (const p of all) {
      expect(p.qual).toBe("(current_setting('app.scope'::text, true) = 'all'::text)");
      expect(p.check).toBe(p.qual);
    }
    const any = policies.filter((p) => p.policy === "system_any").map((p) => p.table);
    expect(any.sort()).toEqual(["auth_events", "auth_identities", "email_otps", "pixel_events_seen", "user_sessions", "users"]);
    expect(policies.filter((p) => p.policy !== "system_all" && p.policy !== "system_any")).toEqual([]);
  });

  it("gives a plain login on the role, outside @app/db's scopes, no workspace's rows", async () => {
    await twoAccounts();
    const rows = await queryAs<{ stores: number; connections: number; users: number }>(
      SYSTEM_URL,
      `SELECT (SELECT COUNT(*) FROM stores)::int AS stores, (SELECT COUNT(*) FROM ad_connections)::int AS connections, (SELECT COUNT(*) FROM users)::int AS users`,
    );
    expect(rows).toEqual([{ stores: 0, connections: 0, users: 2 }]);
  });

  it("keeps each scope's rows apart on shared connections, in turn and at once", async () => {
    const { wsA, wsB } = await twoAccounts();
    const own = (ws: string) => forTenant(ws, async () => (await systemDb.adConnection.findMany()).map((c) => c.workspaceId));
    await asSystem(async () => {
      // In turn: each checkout brings the pooled connection to the scope asking for it.
      for (let i = 0; i < 3; i++) {
        expect(await own(wsA)).toEqual([wsA]);
        expect(await own(wsB)).toEqual([wsB]);
      }
      // At once: more queries than the pool has connections, so they wait for each other's.
      const results = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? own(wsB) : own(wsA))));
      results.forEach((r, i) => expect(r).toEqual([i % 2 ? wsB : wsA]));
      // Prisma batches findUnique calls made together: each scope's go in a batch of their own.
      const conns = await crossTenant("sweep", () => systemDb.adConnection.findMany());
      const other = (ws: string) => (ws === wsA ? wsB : wsA);
      const lookups = await Promise.all(
        conns.flatMap((c) => [
          forTenant(c.workspaceId, () => systemDb.adConnection.findUnique({ where: { id: c.id } })),
          forTenant(other(c.workspaceId), () => systemDb.adConnection.findUnique({ where: { id: c.id } })),
        ]),
      );
      expect(lookups.map((f) => f?.id ?? null)).toEqual(conns.flatMap((c) => [c.id, null]));
      // A transaction keeps the scope it began in.
      expect(await forTenant(wsA, () => systemDb.$transaction(async (tx) => (await tx.adConnection.findMany()).map((c) => c.workspaceId)))).toEqual([wsA]);
    });
  });
});

describe("the API's row scopes", () => {
  it("gives every route a scope: its workspace, a listed reason, or none", () => {
    const unlisted = ctx.routes.filter((r) => pathScope(r.path.replace(/:ws\b/, "ws_1")) === null).map((r) => `${r.method} ${r.path}`);
    expect(unlisted).toEqual([]);
    const workspaceRoutes = ctx.routes.filter((r) => r.path.includes(":ws"));
    expect(workspaceRoutes.length).toBeGreaterThan(250);
    for (const r of workspaceRoutes) expect(pathScope(r.path.replace(/:ws\b/, "ws_1"))).toEqual({ workspaceId: "ws_1" });
    // The staff portal's own list is across workspaces; a path that merely starts like a workspace's isn't one.
    expect(pathScope("/employee/workspaces")).toEqual({ reason: "invitations" });
    expect(pathScope("/workspaces")).toEqual({ reason: "sign_in" });
    expect(pathScope("/healthz")).toBe("none");
  });

  it("names only reasons on the reviewed list", () => {
    for (const r of ctx.routes) {
      const scope = pathScope(r.path.replace(/:ws\b/, "ws_1"));
      if (scope && scope !== "none" && "reason" in scope) expect(Object.keys(CROSS_TENANT_REASONS)).toContain(scope.reason);
    }
  });

  it("serves a workspace's routes with systemDb seeing that workspace only", async () => {
    const { a, wsA, wsB } = await twoAccounts();
    const app = buildApp(ctx.deps);
    // A route that forgets its where-clause: only the workspace in the path comes back.
    app.get("/workspaces/:ws/__forgot-the-filter", async (c) => c.json({ scope: rowScope(), connections: (await systemDb.adConnection.findMany()).map((x) => x.workspaceId) }));
    const res = await asSystem(() => app.request(`/workspaces/${wsA}/__forgot-the-filter`, { headers: a.headers }));
    expect(await res.json()).toEqual({ scope: { kind: "tenant", workspaceId: wsA }, connections: [wsA] });
    // The scope follows the path, not the caller: it only narrows. Whether A may use B's routes at
    // all is each route's own check (the 404s of crossAccount.test.ts); this probe has none.
    const other = await asSystem(() => app.request(`/workspaces/${wsB}/__forgot-the-filter`, { headers: a.headers }));
    expect((await other.json()).connections).toEqual([wsB]);
  });

  it("logs a system query that runs in no scope", async () => {
    const seen: string[] = [];
    onUnscopedSystemQuery(() => seen.push("unscoped"));
    try {
      await systemDb.store.count();
      expect(seen.length).toBeGreaterThan(0);
      seen.length = 0;
      await forTenant("ws_1", () => systemDb.store.count());
      await crossTenant("sweep", () => systemDb.store.count());
      await withoutTenant(() => systemDb.user.count());
      expect(seen).toEqual([]);
    } finally {
      onUnscopedSystemQuery(undefined);
    }
  });
});
