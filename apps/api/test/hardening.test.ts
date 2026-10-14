import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb, withTenant } from "@app/db";
import { signShopifyQuery, signWebhookBody } from "@app/shared";
import { buildApp } from "../src/app.js";
import { requireHttps } from "../src/https.js";
import { pixelEventInWindow } from "../src/routes/pixel.js";
import { LIMITS } from "../src/rateLimit.js";
import { clean, createStore, createWorkspace, ORIGIN, setup, signIn, teardown, type InjectResponse, type TestCtx } from "./helpers.js";

/**
 * Security audit 2026-10-14 (docs/security/SECURITY_AUDIT.md): the production-security test
 * scenarios, and a regression test for each control this audit added or tightened.
 */

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));
beforeEach(async () => {
  await clean(ctx);
  ctx.mailer.sent.length = 0;
});

type Headers = Record<string, string>;
const call = (method: string, url: string, headers: Headers = {}, payload?: unknown) => ctx.app.inject({ method, url, headers, payload });
const ok = (r: InjectResponse, status = 200) => {
  if (r.statusCode !== status) throw new Error(`expected ${status}, got ${r.statusCode}: ${r.body}`);
  return r.json();
};

/** A workspace with its owner, plus a second user given `role` (and a staff role) in it. */
async function team(role: "admin" | "analyst" | "viewer", staffRole: "hr_manager" | "payroll_manager" | "supervisor" | null = null) {
  const owner = await signIn(ctx, "owner", "owner@x.com");
  const ws = await createWorkspace(ctx, owner.headers);
  const member = await signIn(ctx, "member", "member@x.com");
  await systemDb.membership.create({ data: { workspaceId: ws, userId: member.user.id, role, staffRole } });
  return { owner, ws, member };
}

const employee = { jobTitle: "Barista", employmentType: "full_time", joinedOn: "2026-10-01", standardWeeklyMinutes: 2400, workingDays: [1, 2, 3, 4, 5] };
const hire = async (h: Headers, ws: string, fullName: string, email: string, extra: Record<string, unknown> = {}) =>
  ok(await call("POST", `/workspaces/${ws}/staff/employees`, h, { ...employee, fullName, email, ...extra }), 201).employee as { id: string };

// ---------------------------------------------------------------------------------------------
// The brief's test scenarios
// ---------------------------------------------------------------------------------------------

describe("authentication and authorization (scenarios 1, 3, 4, 15)", () => {
  it("refuses protected routes without a session, with a forged one, and admin routes to a regular member", async () => {
    const { ws, member } = await team("analyst");
    for (const url of ["/me", `/workspaces/${ws}/stores`, `/workspaces/${ws}/audit-logs`, `/workspaces/${ws}/staff/employees`]) {
      expect((await call("GET", url)).statusCode, url).toBe(401);
      expect((await call("GET", url, { cookie: "__session=forged.not.a.jwt" })).statusCode, url).toBe(401);
    }
    // A regular member (analyst) asking for owner/admin endpoints.
    expect((await call("GET", `/workspaces/${ws}/audit-logs`, member.headers)).statusCode).toBe(403);
    expect((await call("GET", `/workspaces/${ws}/api-keys`, member.headers)).statusCode).toBe(403);
    expect((await call("POST", `/workspaces/${ws}/invitations`, member.headers, { email: "x@x.com", role: "admin" })).statusCode).toBe(403);
    expect((await call("GET", `/workspaces/${ws}/staff/employees`, member.headers)).statusCode).toBe(403);
  });
});

describe("tenant isolation (scenarios 2, 16)", () => {
  it("a merchant can't read or change another merchant's workspace by changing the id", async () => {
    const a = await signIn(ctx, "a", "a@x.com");
    const b = await signIn(ctx, "b", "b@x.com");
    const wsA = await createWorkspace(ctx, a.headers, "A");
    const wsB = await createWorkspace(ctx, b.headers, "B");
    const storeB = await createStore(wsB, "b-shop.myshopify.com", ["read_orders"]);
    await hire(b.headers, wsB, "Bea", "bea@x.com");
    // A's session, B's ids: always "not found", never a hint the ids exist.
    expect((await call("GET", `/workspaces/${wsB}/stores`, a.headers)).statusCode).toBe(404);
    expect((await call("GET", `/workspaces/${wsB}/stores/${storeB.id}/overview`, a.headers)).statusCode).toBe(404);
    expect((await call("GET", `/workspaces/${wsB}/staff/employees`, a.headers)).statusCode).toBe(404);
    expect((await call("DELETE", `/workspaces/${wsB}/stores/${storeB.id}`, a.headers)).statusCode).toBe(404);
    // A's workspace in the URL, B's store in the path: not found either.
    expect((await call("GET", `/workspaces/${wsA}/stores/${storeB.id}/overview`, a.headers)).statusCode).toBe(404);
  });
});

describe("injection and unsafe content (scenarios 6, 7)", () => {
  it("SQL-looking input is data: it matches nothing and reaches no other tenant", async () => {
    const a = await signIn(ctx, "a", "a@x.com");
    const b = await signIn(ctx, "b", "b@x.com");
    const wsA = await createWorkspace(ctx, a.headers, "A");
    const wsB = await createWorkspace(ctx, b.headers, "B");
    await hire(b.headers, wsB, "Bea", "bea@x.com");
    for (const q of ["' OR '1'='1", "x'; DROP TABLE employees; --", "%' OR 1=1 --"]) {
      const r = ok(await call("GET", `/workspaces/${wsA}/staff/employees?q=${encodeURIComponent(q)}`, a.headers));
      expect(r.items).toEqual([]);
    }
    expect(await systemDb.employee.count()).toBe(1);
  });

  it("HTML and script are stored as text and only ever served as JSON that nothing may render", async () => {
    const { ws, owner } = await team("viewer");
    const xss = `<script>alert(1)</script><img src=x onerror=alert(2)>`;
    const e = await hire(owner.headers, ws, xss, "x@x.com");
    const r = await call("GET", `/workspaces/${ws}/staff/employees/${e.id}`, owner.headers);
    expect(r.json().employee.fullName).toBe(xss);
    expect(r.headers["content-type"]).toMatch(/^application\/json/);
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["content-security-policy"]).toContain("default-src 'none'");
  });
});

describe("webhooks (scenarios 8, 9)", () => {
  const send = (topic: string, shop: string, payload: unknown, id: string, secret = "test_secret") => {
    const raw = JSON.stringify(payload);
    return call("POST", "/webhooks/shopify", { "content-type": "application/json", "x-shopify-hmac-sha256": signWebhookBody(raw, secret), "x-shopify-topic": topic, "x-shopify-shop-domain": shop, "x-shopify-webhook-id": id }, raw);
  };

  it("rejects a bad signature and processes a duplicate delivery once", async () => {
    expect((await send("orders/create", "s.myshopify.com", { id: 1 }, "w1", "not-our-secret")).statusCode).toBe(401);
    expect((await send("orders/create", "s.myshopify.com", { id: 1 }, "w2")).statusCode).toBe(200);
    // Retry of the same delivery once a consumer picked it up: acknowledged, not queued again.
    await systemDb.webhookEvent.updateMany({ where: { webhookId: "w2" }, data: { status: "succeeded" } });
    const again = await send("orders/create", "s.myshopify.com", { id: 1 }, "w2");
    expect(again.statusCode).toBe(200);
    expect(again.json().duplicate).toBe(true);
    expect(ctx.deps.queues.sent.webhooks).toHaveLength(1);
  });

  it("refuses a destructive topic whose signed body doesn't name the shop", async () => {
    // A signed orders/create body can't be replayed as shop/redact or app/uninstalled for a victim.
    for (const [i, topic] of ["app/uninstalled", "shop/redact", "customers/redact", "customers/data_request"].entries()) {
      expect((await send(topic, "victim.myshopify.com", { id: 1, name: "#1001" }, `d${i}`)).statusCode, topic).toBe(401);
    }
    expect(ctx.deps.queues.sent.webhooks).toHaveLength(0);
  });

  it("refuses a webhook signed by a client's custom app for any store but that client's", async () => {
    const res = await send("orders/create", "someone-else.myshopify.com", { id: 1 }, "c1", "client_secret");
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("wrong_app");
    expect((await send("orders/create", "client-shop.myshopify.com", { id: 1 }, "c2", "client_secret")).statusCode).toBe(200);
  });
});

describe("downloads and storage (scenarios 10, 11, 19)", () => {
  it("a download link works only for the person it was made for, and never without a session", async () => {
    const { ws, owner, member } = await team("admin");
    await hire(owner.headers, ws, "Jane", "jane@x.com");
    const { url } = ok(await call("POST", `/workspaces/${ws}/staff/exports`, owner.headers, { kind: "report", format: "csv", report: { type: "attendance", groupBy: "employee" } }));
    const path = String(url).replace(/^\/api/, "");
    expect((await call("GET", path)).statusCode).toBe(401);
    expect((await call("GET", path, member.headers)).statusCode).toBe(404); // another member of the same workspace
    const mine = await call("GET", path, owner.headers);
    expect(mine.statusCode).toBe(200);
    expect(mine.headers["cache-control"]).toBe("no-store");
    expect((await call("GET", path, owner.headers)).statusCode).toBe(404); // single use
  });

  it("refuses oversized and malformed bodies (there are no file uploads)", async () => {
    const { owner, ws } = await team("viewer");
    const big = JSON.stringify({ name: "x".repeat(1024 * 1024 + 10) });
    expect((await call("PATCH", `/workspaces/${ws}`, { ...owner.headers, "content-type": "application/json" }, big)).statusCode).toBe(413);
    expect((await call("PATCH", `/workspaces/${ws}`, { ...owner.headers, "content-type": "application/json" }, "{not json")).statusCode).toBe(400);
  });
});

describe("rate limits (scenario 12)", () => {
  it("answers 429 with Retry-After", async () => {
    const { owner, ws } = await team("viewer");
    const invite = (i: number) => call("POST", `/workspaces/${ws}/invitations`, owner.headers, { email: `p${i}@x.com`, role: "viewer" });
    for (let i = 0; i < LIMITS.invitations.max; i++) ok(await invite(i));
    const limited = await invite(999);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe(String(LIMITS.invitations.windowSec));
    const global = await buildApp({ ...ctx.deps, globalLimit: async () => false }).request("/me");
    expect(global.status).toBe(429);
    expect(global.headers.get("retry-after")).toBe("60");
  });
});

describe("CORS and CSRF (scenario 13)", () => {
  it("never lets another origin read the API or write with the visitor's cookie", async () => {
    const { owner, ws } = await team("viewer");
    const evil = { ...owner.headers, origin: "https://evil.example" };
    const pre = await call("OPTIONS", "/me", { origin: "https://evil.example", "access-control-request-method": "GET" });
    expect(pre.headers["access-control-allow-origin"]).toBeUndefined();
    const read = await call("GET", "/me", evil);
    expect(read.headers["access-control-allow-origin"]).toBeUndefined();
    const write = await call("PATCH", `/workspaces/${ws}`, evil, { name: "pwned" });
    expect(write.statusCode).toBe(403);
    expect(write.json().error).toBe("csrf");
  });
});

describe("errors and debug output (scenario 14)", () => {
  it("an unexpected failure answers a generic 500 without the internals", async () => {
    const broken = buildApp({ ...ctx.deps, coord: { ...ctx.deps.coord, hit: async () => { throw new Error("internal detail: password=hunter2 at db.internal:5432"); } } });
    const res = await broken.request("/auth/session", { method: "POST", headers: { ...ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ idToken: "idt|u|u@x.com|1" }) });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toMatch(/hunter2|db\.internal|stack|Error:/);
    expect(JSON.parse(text)).toEqual({ error: "internal", message: "Something went wrong" });
  });
});

describe("OAuth state (scenario 17)", () => {
  it("a Shopify or ad-platform callback with a state this browser didn't start is refused", async () => {
    const { owner } = await team("viewer");
    const ads = await call("GET", "/ads/google/callback?state=forged-state&code=abc", owner.headers);
    expect(ads.statusCode).toBe(302);
    expect(ads.headers.location).toContain("error=state_mismatch");
    expect(await systemDb.adConnection.count()).toBe(0);
  });
});

describe("security headers and HTTPS (scenario 18)", () => {
  it("API responses carry HSTS over https", async () => {
    const app = buildApp(ctx.deps);
    const https = await app.request("https://insights.example/healthz");
    expect(https.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
    expect(https.headers.get("x-frame-options")).toBe("DENY");
    expect((await app.request("http://localhost/healthz")).headers.get("strict-transport-security")).toBeNull();
  });

  it("plain http is redirected (GET) or refused (anything else), except on local hosts", async () => {
    const get = requireHttps(new Request("http://insights.example/dashboard?x=1"));
    expect(get?.status).toBe(301);
    expect(get?.headers.get("location")).toBe("https://insights.example/dashboard?x=1");
    const post = requireHttps(new Request("http://insights.example/api/auth/session", { method: "POST", body: "{}" }));
    expect(post?.status).toBe(403);
    expect(requireHttps(new Request("https://insights.example/api/me"))).toBeNull();
    expect(requireHttps(new Request("http://localhost:8787/api/me", { method: "POST", body: "{}" }))).toBeNull();
    expect(requireHttps(new Request("http://127.0.0.1:8787/"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Controls added by this audit
// ---------------------------------------------------------------------------------------------

describe("the public pixel", () => {
  it("in production takes only events a real storefront could be sending now", () => {
    const now = Date.parse("2026-10-14T12:00:00Z");
    const ago = (h: number) => new Date(now - h * 3600_000).toISOString();
    expect(pixelEventInWindow(ago(1), now, true)).toBe(true);
    expect(pixelEventInWindow(ago(47), now, true)).toBe(true);
    expect(pixelEventInWindow(ago(49), now, true)).toBe(false); // history written with the public key
    expect(pixelEventInWindow(ago(24 * 365), now, true)).toBe(false);
    expect(pixelEventInWindow(ago(-2), now, true)).toBe(false); // the future
    expect(pixelEventInWindow(ago(24 * 30), now, false)).toBe(true); // the local demo backfills weeks
  });

  it("refuses over-long page paths", async () => {
    const { ws } = await team("viewer");
    await createStore(ws, "p.myshopify.com", ["read_orders"]);
    const ev = (path: string) => JSON.stringify({ events: [{ id: `e${path.length}`, name: "page_viewed", clientId: "c1", timestamp: new Date().toISOString(), path }] });
    expect((await call("POST", "/pixel/pk_p.myshopify.com", {}, ev("/products/a"))).statusCode).toBe(200);
    expect((await call("POST", "/pixel/pk_p.myshopify.com", {}, ev(`/${"a".repeat(600)}`))).statusCode).toBe(400);
  });
});

describe("members and API keys", () => {
  it("removing or demoting an admin retires the API keys they made", async () => {
    const { owner, ws, member } = await team("admin");
    const { secret } = ok(await call("POST", `/workspaces/${ws}/api-keys`, member.headers, { name: "laptop" }));
    const bearer = { authorization: `Bearer ${secret}` };
    expect((await call("GET", `/workspaces/${ws}/stores`, bearer)).statusCode).toBe(200);
    const { members } = ok(await call("GET", `/workspaces/${ws}/members`, owner.headers));
    const memberId = members.find((m: { userId: string }) => m.userId === member.user.id).id;
    ok(await call("PATCH", `/workspaces/${ws}/members/${memberId}`, owner.headers, { role: "analyst" }));
    expect((await call("GET", `/workspaces/${ws}/stores`, bearer)).statusCode).toBe(404);
    // Keys show who made them.
    const keys = ok(await call("GET", `/workspaces/${ws}/api-keys`, owner.headers)).keys;
    expect(keys[0]).toMatchObject({ createdBy: "member@x.com" });
    expect(keys[0].revokedAt).not.toBeNull();

    // Same on removal.
    await systemDb.membership.update({ where: { workspaceId_userId: { workspaceId: ws, userId: member.user.id } }, data: { role: "admin" } });
    const second = ok(await call("POST", `/workspaces/${ws}/api-keys`, member.headers, { name: "ci" })).secret;
    ok(await call("DELETE", `/workspaces/${ws}/members/${memberId}`, owner.headers));
    expect((await call("GET", `/workspaces/${ws}/stores`, { authorization: `Bearer ${second}` })).statusCode).toBe(404);
  });

  it("an invitation can be cancelled by a member manager, and its link stops working", async () => {
    const { owner, ws, member } = await team("analyst");
    ok(await call("POST", `/workspaces/${ws}/invitations`, owner.headers, { email: "new@x.com", role: "viewer" }));
    const token = /token=([A-Za-z0-9_-]+)/.exec(ctx.mailer.sent.at(-1)!.text)![1]!;
    const { invitations } = ok(await call("GET", `/workspaces/${ws}/members`, owner.headers));
    const id = invitations[0].id as string;
    expect((await call("DELETE", `/workspaces/${ws}/invitations/${id}`, member.headers)).statusCode).toBe(403);
    ok(await call("DELETE", `/workspaces/${ws}/invitations/${id}`, owner.headers));
    const invited = await signIn(ctx, "new", "new@x.com");
    expect((await call("POST", "/invitations/accept", invited.headers, { token })).statusCode).toBe(400);
  });
});

describe("Staff Management access", () => {
  it("a supervisor sees only their own team, whatever manager filter they pass", async () => {
    const { owner, ws, member } = await team("analyst", "supervisor");
    await hire(owner.headers, ws, "Mine", "mine@x.com", { managerUserId: member.user.id });
    await hire(owner.headers, ws, "Theirs", "theirs@x.com", { managerUserId: owner.user.id });
    const base = `/workspaces/${ws}/staff/employees`;
    expect(ok(await call("GET", base, member.headers)).items.map((e: { fullName: string }) => e.fullName)).toEqual(["Mine"]);
    expect(ok(await call("GET", `${base}?managerUserId=${owner.user.id}`, member.headers)).items).toEqual([]);
    const live = ok(await call("GET", `/workspaces/${ws}/staff/attendance/live?managerUserId=${owner.user.id}`, member.headers));
    expect(JSON.stringify(live)).not.toContain("Theirs");
  });

  it("an HR manager edits people but not what they're paid", async () => {
    const { owner, ws, member } = await team("analyst", "hr_manager");
    const e = await hire(owner.headers, ws, "Jane", "jane@x.com");
    const url = `/workspaces/${ws}/staff/employees/${e.id}`;
    ok(await call("PATCH", url, member.headers, { jobTitle: "Shift lead" }));
    const r = await call("PATCH", url, member.headers, { currency: "JPY" });
    expect(r.statusCode).toBe(403);
    // Creating with the organization's defaults is fine; with another currency it isn't.
    await hire(member.headers, ws, "Sam", "sam@x.com");
    expect((await call("POST", `/workspaces/${ws}/staff/employees`, member.headers, { ...employee, fullName: "Kim", email: "kim@x.com", currency: "JPY" })).statusCode).toBe(403);
  });

  it("nobody but the owner sets their own pay or approves their own hours", async () => {
    const { owner, ws, member } = await team("analyst", "payroll_manager");
    const self = await hire(owner.headers, ws, "Pat (payroll)", "member@x.com");
    await systemDb.employee.update({ where: { id: self.id }, data: { userId: member.user.id } });
    const other = await hire(owner.headers, ws, "Jane", "jane@x.com");
    const rate = { hourlyRate: "99", effectiveFrom: "2026-10-02" };
    const own = await call("POST", `/workspaces/${ws}/staff/employees/${self.id}/pay-rates`, member.headers, rate);
    expect(own.statusCode).toBe(403);
    expect(own.json().error).toBe("own_record");
    expect((await call("POST", `/workspaces/${ws}/staff/employees/${other.id}/pay-rates`, member.headers, rate)).statusCode).toBeLessThan(300);

    const shift = await systemDb.attendanceSession.create({
      data: { workspaceId: ws, employeeId: self.id, clockInAt: new Date("2026-10-06T09:00:00Z"), clockOutAt: new Date("2026-10-06T17:00:00Z"), clockInSource: "web", clockOutSource: "web", timezone: "UTC" },
    });
    const approve = (h: Headers) => call("POST", `/workspaces/${ws}/staff/timesheets/approve`, h, { sessionIds: [shift.id] });
    expect((await approve(member.headers)).statusCode).toBe(403);
    expect(ok(await approve(owner.headers)).approved).toBe(1);
  });

  it("correcting an employee's email withdraws the invitation sent to the old address", async () => {
    const { owner, ws } = await team("viewer");
    const e = await hire(owner.headers, ws, "Jane", "jane@typo.com");
    const inv = ok(await call("POST", `/workspaces/${ws}/staff/employees/${e.id}/invitations`, owner.headers, { delivery: "link" }));
    const token = new URL(inv.url, "http://x").searchParams.get("token")!;
    expect(ok(await call("GET", `/staff/invitations/lookup?token=${encodeURIComponent(token)}`)).ok).toBe(true);
    ok(await call("PATCH", `/workspaces/${ws}/staff/employees/${e.id}`, owner.headers, { email: "jane@right.com" }));
    const after = ok(await call("GET", `/staff/invitations/lookup?token=${encodeURIComponent(token)}`));
    expect(after).toMatchObject({ ok: false, problem: "revoked" });
  });
});

describe("Shopify OAuth callback", () => {
  it("re-checks that the person may still connect stores when Shopify sends them back", async () => {
    const { ws, member } = await team("admin");
    const started = ok(await call("POST", `/workspaces/${ws}/shopify/install`, member.headers, { shop: "new-shop.myshopify.com" }));
    const state = new URL(started.url).searchParams.get("state")!;
    // Demoted while on Shopify's screen.
    await systemDb.membership.update({ where: { workspaceId_userId: { workspaceId: ws, userId: member.user.id } }, data: { role: "viewer" } });
    const params = { code: "c", shop: "new-shop.myshopify.com", state, timestamp: String(Math.floor(Date.now() / 1000)) };
    const q = new URLSearchParams({ ...params, hmac: signShopifyQuery(params, "test_secret") });
    const res = await call("GET", `/shopify/callback?${q}`, { ...member.headers, cookie: `${member.cookie}; shopify_oauth_state=${state}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("error=not_allowed");
    expect(await systemDb.store.count({ where: { workspaceId: ws } })).toBe(0);
  });
});

describe("database guarantees", () => {
  it("the audit trail can't be edited by anyone, nor deleted by tenant requests", async () => {
    const { owner, ws } = await team("viewer");
    ok(await call("PATCH", `/workspaces/${ws}`, owner.headers, { name: "Renamed" }));
    const entry = await systemDb.auditLog.findFirstOrThrow({ where: { workspaceId: ws, action: "workspace.renamed" } });
    await expect(systemDb.auditLog.update({ where: { id: entry.id }, data: { action: "nothing.happened" } })).rejects.toThrow();
    await expect(withTenant(ws, (tx) => tx.auditLog.deleteMany({ where: { workspaceId: ws } }))).rejects.toThrow(/permission denied/i);
    await expect(withTenant(ws, (tx) => tx.user.updateMany({ data: { displayName: "x" } }))).rejects.toThrow(/permission denied/i);
    expect(await systemDb.auditLog.count({ where: { id: entry.id, action: "workspace.renamed" } })).toBe(1);
  });

  it("a paid shift's breaks and a finalized payroll's items can't be deleted", async () => {
    const { owner, ws } = await team("viewer");
    const e = await hire(owner.headers, ws, "Jane", "jane@x.com");
    const locked = new Date();
    const s = await systemDb.attendanceSession.create({
      data: { workspaceId: ws, employeeId: e.id, clockInAt: new Date("2026-10-06T09:00:00Z"), clockOutAt: new Date("2026-10-06T17:00:00Z"), clockInSource: "web", timezone: "UTC", approvalStatus: "approved", lockedAt: locked },
    });
    await systemDb.$executeRaw`UPDATE attendance_sessions SET locked_at = NULL WHERE id = ${s.id}`; // add the break while unlocked
    await systemDb.breakSession.create({ data: { workspaceId: ws, sessionId: s.id, employeeId: e.id, startAt: new Date("2026-10-06T12:00:00Z"), endAt: new Date("2026-10-06T12:30:00Z"), kind: "meal", paid: false } });
    await systemDb.attendanceSession.update({ where: { id: s.id }, data: { lockedAt: locked } });
    await expect(systemDb.breakSession.deleteMany({ where: { sessionId: s.id } })).rejects.toThrow(/finalized payroll/);
    // Unlocking and moving the shift in one statement is refused too.
    await expect(systemDb.$executeRaw`UPDATE attendance_sessions SET locked_at = NULL, clock_out_at = clock_out_at + interval '5 hours' WHERE id = ${s.id}`).rejects.toThrow(/finalized payroll/);

    const p = await systemDb.payrollPeriod.create({ data: { workspaceId: ws, startDate: "2026-10-05", endDate: "2026-10-11", payCycle: "weekly", timezone: "UTC", lockedAt: locked } });
    await systemDb.$executeRaw`UPDATE payroll_periods SET locked_at = NULL WHERE id = ${p.id}`;
    await systemDb.payrollItem.create({ data: { workspaceId: ws, periodId: p.id, employeeId: e.id, currency: "USD" } });
    await systemDb.payrollPeriod.update({ where: { id: p.id }, data: { lockedAt: locked } });
    await expect(systemDb.payrollItem.deleteMany({ where: { periodId: p.id } })).rejects.toThrow(/finalized pay period/);
  });
});
