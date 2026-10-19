import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { systemDb } from "@app/db";
import { encryptAdTokens, logger } from "@app/core";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * Meta's server-to-server callbacks for bizinsights' ads app: someone removed bizinsights in their
 * Facebook settings (deauthorize), or asked Facebook for their data to be deleted. Each carries a
 * signed_request, signed here for real with the app secret, the way Meta does
 * (https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback).
 */

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));

const KEYS = { META_APP_ID: "meta_app", META_APP_SECRET: "meta_secret", GOOGLE_ADS_CLIENT_ID: "g_client", GOOGLE_ADS_CLIENT_SECRET: "g_secret", GOOGLE_ADS_ENABLED: "1" };
const PERSON = "5550001";

function signedRequest(payload: Record<string, unknown>, secret = KEYS.META_APP_SECRET): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${createHmac("sha256", secret).update(body).digest("base64url")}.${body}`;
}
const fromMeta = (userId = PERSON, over: Record<string, unknown> = {}) => signedRequest({ algorithm: "HMAC-SHA256", issued_at: Math.floor(Date.now() / 1000) - 5, user_id: userId, ...over });

/** POST a form the way Meta's servers do: no cookie, no browser. */
const callback = (path: "deauthorize" | "data-deletion", signed: string | null, headers: Record<string, string> = {}) =>
  ctx.app.inject({
    method: "POST",
    url: `/webhooks/meta/${path}`,
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    payload: signed === null ? "" : new URLSearchParams({ signed_request: signed }).toString(),
  });

let ws: string;
let storeId: string;
let headers: Record<string, string>;

beforeEach(async () => {
  await clean(ctx);
  ctx.setEnv(KEYS);
  const u = await signIn(ctx, "meta-cb-owner", "owner@x.com");
  headers = u.headers;
  ws = await createWorkspace(ctx, headers);
  storeId = (await createStore(ws, "meta-cb.myshopify.com", ["read_orders"], { currency: "USD" })).id;
});

async function connection(provider: "meta" | "google", accountId: string, over: Record<string, unknown> = {}) {
  const tokens = encryptAdTokens(storeId, provider, { accessToken: `T_${accountId}`, refreshToken: provider === "meta" ? null : "R", expiresAt: new Date(Date.now() + 30 * 86_400_000) });
  const conn = await systemDb.adConnection.create({ data: { workspaceId: ws, storeId, provider, accountId, accountName: accountId, currency: "USD", timezone: "UTC", externalUserId: PERSON, ...tokens, ...over } });
  await systemDb.adCampaignDaily.create({ data: { workspaceId: ws, storeId, connectionId: conn.id, provider, accountId, campaignId: "c1", campaignName: "Spring", day: "2026-10-01", spend: 5 } });
  return conn;
}

describe("Meta's deauthorize callback", () => {
  it("the person's Meta ad connections wait for a reconnect at once, hidden ones too, their tokens gone and their days kept", async () => {
    const shown = await connection("meta", "act_1");
    const hidden = await connection("meta", "act_2", { enabled: false });
    const someoneElse = await connection("meta", "act_3", { externalUserId: "999" });
    const google = await connection("google", "111");
    const res = await callback("deauthorize", fromMeta());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    for (const id of [shown.id, hidden.id]) {
      expect(await systemDb.adConnection.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "reconnect", errorCode: "auth_expired", accessTokenEnc: "", refreshTokenEnc: null, accessTokenExpiresAt: null, externalUserId: PERSON });
      expect(await systemDb.adCampaignDaily.count({ where: { connectionId: id } })).toBe(1);
    }
    for (const id of [someoneElse.id, google.id]) expect(await systemDb.adConnection.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "active", errorCode: null });
    const audit = await systemDb.auditLog.findFirstOrThrow({ where: { action: "ads.access_removed" } });
    expect(audit).toMatchObject({ workspaceId: ws, targetId: storeId, metadata: expect.objectContaining({ provider: "meta", accounts: 2, via: "meta_deauthorize" }) });
    // Settings says so, in its own words.
    const list = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/ads`, headers });
    expect(list.json().connections.find((c: { id: string }) => c.id === shown.id)).toMatchObject({ status: "reconnect", errorCode: "auth_expired", message: expect.stringContaining("Press Reconnect") });
    // Meta sending it again changes nothing more.
    expect((await callback("deauthorize", fromMeta())).statusCode).toBe(200);
    expect(await systemDb.auditLog.count({ where: { action: "ads.access_removed" } })).toBe(1);
  });

  it("refuses a request Meta didn't sign with this app's secret, an old one, or none, and changes nothing", async () => {
    const conn = await connection("meta", "act_1");
    const refused = [
      fromMeta(PERSON, {}).replace(/^./, (ch) => (ch === "A" ? "B" : "A")),
      signedRequest({ algorithm: "HMAC-SHA256", issued_at: Math.floor(Date.now() / 1000), user_id: PERSON }, "someone_elses_secret"),
      fromMeta(PERSON, { issued_at: Math.floor(Date.now() / 1000) - 3 * 86_400 }),
      fromMeta(PERSON, { algorithm: "none" }),
      "not-a-signed-request",
    ];
    for (const signed of [...refused, null]) {
      const res = await callback("deauthorize", signed);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "invalid_signature" });
    }
    expect(await systemDb.adConnection.findUniqueOrThrow({ where: { id: conn.id } })).toMatchObject({ status: "active" });
    // Without the app secret on this server there is nothing to check it with.
    ctx.setEnv({ ...KEYS, META_APP_SECRET: "" });
    expect((await callback("deauthorize", fromMeta())).json()).toEqual({ error: "not_configured" });
  });

  it("is a machine endpoint: no CSRF check (Meta's servers send no browser origin), and the signed request is never logged", async () => {
    await connection("meta", "act_1");
    const logged: unknown[] = [];
    for (const level of ["info", "warn", "error"] as const) vi.spyOn(logger, level).mockImplementation((...a: unknown[]) => void logged.push(a));
    try {
      const signed = fromMeta();
      // A stray session cookie and another site's origin don't matter here: the signature does.
      const owner = await signIn(ctx, "meta-cb-other", "other@x.com");
      expect((await callback("deauthorize", signed, { cookie: owner.cookie, origin: "https://elsewhere.example" })).statusCode).toBe(200);
      expect((await callback("data-deletion", signed, { cookie: owner.cookie, origin: "https://elsewhere.example" })).statusCode).toBe(200);
      await callback("deauthorize", `${signed}x`);
      expect(JSON.stringify(logged)).not.toContain(signed.split(".")[1]!);
      expect(JSON.stringify(logged)).not.toContain(PERSON);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("Meta's data deletion callback", () => {
  it("deletes the person's Meta ad connections and every figure fetched for them, and answers where to see the request's status", async () => {
    const a = await connection("meta", "act_1");
    const b = await connection("meta", "act_2", { status: "reconnect", errorCode: "auth_expired" });
    const kept = await connection("meta", "act_3", { externalUserId: "999" });
    const res = await callback("data-deletion", fromMeta());
    expect(res.statusCode).toBe(200);
    const { url, confirmation_code: code } = res.json() as { url: string; confirmation_code: string };
    // Alphanumeric, as Meta asks, and the page that shows it.
    expect(code).toMatch(/^[a-f0-9]{20}$/);
    expect(url).toBe(`http://localhost:3001/data-deletion?code=${code}`);
    expect(await systemDb.adConnection.count({ where: { id: { in: [a.id, b.id] } } })).toBe(0);
    expect(await systemDb.adCampaignDaily.count({ where: { connectionId: { in: [a.id, b.id] } } })).toBe(0);
    expect(await systemDb.adConnection.count({ where: { id: kept.id } })).toBe(1);
    expect(await systemDb.adCampaignDaily.count({ where: { connectionId: kept.id } })).toBe(1);
    expect(await systemDb.auditLog.findFirstOrThrow({ where: { action: "ads.disconnected" } })).toMatchObject({ metadata: expect.objectContaining({ provider: "meta", accounts: 2, via: "meta_data_deletion" }) });
    // The record keeps the code, not the person.
    const record = await systemDb.authEvent.findFirstOrThrow({ where: { type: "meta_data_deletion" } });
    expect(record.userId).toBeNull();
    expect(JSON.stringify(record.metadata)).not.toContain(PERSON);

    // The status page asks by code.
    const status = await ctx.app.inject({ method: "GET", url: `/meta/data-deletion/${code}` });
    expect(status.json()).toEqual({ status: "done", at: record.createdAt.toISOString() });
    for (const other of ["0123456789abcdef0123", "not-a-code", "' OR 1=1"]) {
      expect((await ctx.app.inject({ method: "GET", url: `/meta/data-deletion/${encodeURIComponent(other)}` })).json()).toEqual({ status: "unknown" });
    }
  });

  it("someone bizinsights holds nothing about still gets a code, and the request reads as done", async () => {
    const res = await callback("data-deletion", fromMeta("31337"));
    const code = res.json().confirmation_code as string;
    expect((await ctx.app.inject({ method: "GET", url: `/meta/data-deletion/${code}` })).json()).toMatchObject({ status: "done" });
    // A forged one is refused like any other.
    expect((await callback("data-deletion", signedRequest({ algorithm: "HMAC-SHA256", issued_at: Math.floor(Date.now() / 1000), user_id: "31337" }, "nope"))).statusCode).toBe(401);
  });

  it("the status page is limited per address", async () => {
    for (let i = 0; i < 60; i++) expect((await ctx.app.inject({ method: "GET", url: "/meta/data-deletion/0123456789abcdef0123" })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: "/meta/data-deletion/0123456789abcdef0123" })).statusCode).toBe(429);
  });
});
