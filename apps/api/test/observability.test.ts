import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@app/core";
import { tenantDb, withDb } from "@app/db";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => teardown(ctx));
beforeEach(async () => clean(ctx));

/** Log lines written while `fn` runs, parsed. The suite runs with LOG_LEVEL=silent otherwise. */
async function logsOf(fn: () => Promise<unknown>) {
  const prev = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "info";
  const lines: Array<Record<string, unknown>> = [];
  const take = (s: unknown) => lines.push(JSON.parse(String(s)) as Record<string, unknown>);
  const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")].map((s) => s.mockImplementation(take));
  try {
    await fn();
  } finally {
    spies.forEach((s) => s.mockRestore());
    process.env.LOG_LEVEL = prev;
  }
  return lines;
}

describe("request id", () => {
  it("is on every response: success, error and not found", async () => {
    for (const url of ["/healthz", "/me", "/no-such-route"]) {
      const r = await ctx.app.inject({ method: "GET", url });
      expect(r.headers["x-request-id"], url).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("is a fresh id for every request", async () => {
    const a = await ctx.app.inject({ method: "GET", url: "/healthz" });
    const b = await ctx.app.inject({ method: "GET", url: "/healthz" });
    expect(a.headers["x-request-id"]).not.toBe(b.headers["x-request-id"]);
  });

  it("is on every log line written for the request, with who made it", async () => {
    const u = await signIn(ctx, "u1", "u1@example.com");
    const ws = await createWorkspace(ctx, u.headers);
    const store = await createStore(ws, "obs.myshopify.com", ["read_orders"]);
    let id = "";
    const lines = await logsOf(async () => {
      const r = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${store.id}/sync`, headers: u.headers });
      expect(r.statusCode).toBe(200);
      id = r.headers["x-request-id"]!;
    });
    const access = lines.find((l) => l.msg === "request");
    expect(access).toMatchObject({
      requestId: id,
      method: "GET",
      // The pattern, never the concrete path: paths can carry tokens.
      route: "/workspaces/:ws/stores/:storeId/sync",
      status: 200,
      userId: u.user.id,
      workspaceId: ws,
    });
    expect(typeof access!.ms).toBe("number");
    expect(lines.every((l) => l.requestId === id)).toBe(true);
  });

  it("doesn't log health probes that succeed", async () => {
    const lines = await logsOf(() => ctx.app.inject({ method: "GET", url: "/healthz" }));
    expect(lines).toEqual([]);
  });
});

describe("version", () => {
  const vars = ["APP_COMMIT", "APP_BUILT_AT", "APP_ENVIRONMENT", "AWS_LAMBDA_FUNCTION_VERSION"] as const;
  afterEach(() => {
    for (const k of vars) delete process.env[k];
    resetEnvCache();
  });

  it("says which commit, build and Lambda version answer, without a session", async () => {
    Object.assign(process.env, { APP_COMMIT: "12e50d69fcba7ef6188cea9ca1ea157e7306bb75", APP_BUILT_AT: "2026-10-17T09:00:00.000Z", APP_ENVIRONMENT: "production", AWS_LAMBDA_FUNCTION_VERSION: "59" });
    resetEnvCache();
    const r = await ctx.app.inject({ method: "GET", url: "/version" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ app: "bizinsights", environment: "production", commit: "12e50d69fcba7ef6188cea9ca1ea157e7306bb75", builtAt: "2026-10-17T09:00:00.000Z", release: "59" });
    expect(r.headers["cache-control"]).toBe("no-store");
  });

  it("answers locally too, with nothing to show", async () => {
    resetEnvCache();
    const r = await ctx.app.inject({ method: "GET", url: "/version" });
    expect(r.json()).toEqual({ app: "bizinsights", environment: "test", commit: null, builtAt: null, release: null });
  });
});

describe("readiness", () => {
  afterEach(() => {
    delete ctx.deps.dbHealthy;
  });

  it("checks both database roles and the coordinator", async () => {
    const r = await ctx.app.inject({ method: "GET", url: "/readyz" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, checks: { db: true, coord: true, tenantDb: true } });
  });

  it("says not ready, and logs why, when the database doesn't answer", async () => {
    ctx.deps.dbHealthy = async () => false;
    let status = 0;
    const lines = await logsOf(async () => {
      const r = await ctx.app.inject({ method: "GET", url: "/readyz" });
      status = r.statusCode;
      expect(r.json()).toEqual({ ok: false, checks: { db: false, coord: true, tenantDb: true } });
    });
    expect(status).toBe(503);
    expect(lines.find((l) => l.msg === "not ready")).toMatchObject({ level: "error", db: "database health check failed" });
  });

  it("says not ready when the tenant connection's role isn't bound by row-level security", async () => {
    // The owner's login (a superuser here, rds_superuser on AWS) where app_rls belongs.
    const owner = process.env.DATABASE_URL!;
    const r = await withDb({ system: owner, tenant: owner }, () => ctx.app.inject({ method: "GET", url: "/readyz" }));
    expect(r.statusCode).toBe(503);
    expect(r.json().checks).toEqual({ db: true, coord: true, tenantDb: false });
  });

  it("in production, fails tenant queries rather than run them on the owner's login when APP_DATABASE_URL is missing", async () => {
    const was = process.env.NODE_ENV;
    await withDb({ system: process.env.DATABASE_URL! }, async () => {
      process.env.NODE_ENV = "production";
      try {
        await expect(tenantDb.$queryRaw`SELECT 1`).rejects.toThrow(/APP_DATABASE_URL is not set/);
      } finally {
        process.env.NODE_ENV = was;
      }
      // Development and tests may share one login.
      await expect(tenantDb.$queryRaw`SELECT 1`).resolves.toBeDefined();
    });
  });

  it("says not ready when the coordinator fails", async () => {
    const ping = ctx.deps.coord.ping;
    ctx.deps.coord.ping = async () => {
      throw new Error("coordinator table unavailable");
    };
    try {
      const r = await ctx.app.inject({ method: "GET", url: "/readyz" });
      expect(r.statusCode).toBe(503);
      expect(r.json().checks).toEqual({ db: true, coord: false, tenantDb: true });
    } finally {
      ctx.deps.coord.ping = ping;
    }
  });
});
