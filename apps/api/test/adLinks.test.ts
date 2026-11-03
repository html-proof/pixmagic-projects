import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb } from "@app/db";
import { adAccessToken, type FetchLike } from "@app/core";
import { clean, createStore, createWorkspace, ORIGIN, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * Connect links (routes/adLinks.ts, core's adConnections/links.ts): someone who manages a store's
 * integrations makes a link, and whoever runs the store's Meta ads connects them through it, with no
 * bizinsights login, and only once.
 */

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));

const KEYS = { META_APP_ID: "meta_app", META_APP_SECRET: "meta_secret", META_ADS_ADVANCED_ACCESS: "", META_CONFIG_ID: "" };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Meta as the callback sees it: a long-lived token, ads_read granted, who signed in, and `accounts` ad accounts. */
const metaPlatform =
  (accounts: number): FetchLike =>
  async (input) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/oauth/access_token")) {
      return u.searchParams.get("grant_type") === "fb_exchange_token" ? json({ access_token: "AGENCY_LONG_SECRET", expires_in: 5_184_000 }) : json({ access_token: "AGENCY_SHORT", expires_in: 3600 });
    }
    if (u.pathname.endsWith("/me/permissions")) return json({ data: [{ permission: "ads_read", status: "granted" }] });
    if (u.pathname.endsWith("/me/adaccounts")) {
      return json({ data: [{ id: "act_1", name: "Agency ads", currency: "USD", timezone_name: "UTC" }, { id: "act_2", name: "Second", currency: "USD", timezone_name: "UTC" }].slice(0, accounts) });
    }
    if (u.pathname.endsWith("/me")) return json({ id: "9876" });
    return json({ error: { message: `unexpected ${u.pathname}` } }, 400);
  };

let headers: Record<string, string>;
let ownerId: string;
let ws: string;
let storeId: string;

beforeEach(async () => {
  await clean(ctx);
  ctx.setEnv(KEYS);
  const u = await signIn(ctx, "link-owner", "owner@shop.test");
  headers = u.headers;
  ownerId = u.user.id;
  ws = await createWorkspace(ctx, headers, "Shop Co");
  storeId = (await createStore(ws, "link-shop.myshopify.com", ["read_orders"], { name: "Link Shop" })).id;
});

const linkPath = () => `/workspaces/${ws}/stores/${storeId}/ads/meta/link`;

/** Make the store's link; its token. */
async function makeLink(): Promise<string> {
  const res = await ctx.app.inject({ method: "POST", url: linkPath(), headers });
  expect(res.statusCode).toBe(200);
  const url = new URL(res.json().link.url);
  expect(url.pathname).toBe("/connect/meta");
  return url.searchParams.get("t")!;
}

/** What the link's page sends, with no bizinsights session: from our own origin, the token in the body. */
const publicPost = (path: string, payload: Record<string, unknown>, extra: Record<string, string> = ORIGIN) => ctx.app.inject({ method: "POST", url: path, headers: extra, payload });

/** "Continue with Meta Ads" on the link's page, and Facebook sending the browser back. */
async function linkFlow(token: string, query: Record<string, string> = { code: "CODE" }) {
  const start = await publicPost("/ads/links/start", { token });
  expect(start.statusCode).toBe(200);
  const state = new URL(start.json().url).searchParams.get("state")!;
  // Only the sign-in's own cookie: the person holds no bizinsights session.
  expect(String(start.headers["set-cookie"])).toContain(`ads_oauth_state=${state}`);
  const cb = await ctx.app.inject({ method: "GET", url: `/ads/meta/callback?${new URLSearchParams({ state, ...query })}`, headers: { cookie: `ads_oauth_state=${state}` } });
  expect(cb.statusCode).toBe(302);
  return new URL(cb.headers.location as string);
}

describe("connect links", () => {
  it("one link per store, for those who manage its integrations: shown again, replaced, turned off", async () => {
    expect((await ctx.app.inject({ method: "GET", url: linkPath(), headers })).json()).toEqual({ link: null });
    const first = await makeLink();
    const shown = await ctx.app.inject({ method: "GET", url: linkPath(), headers });
    expect(shown.json().link).toMatchObject({ createdBy: { you: true } });
    expect(new URL(shown.json().link.url).searchParams.get("t")).toBe(first);
    expect(Date.parse(shown.json().link.expiresAt) - Date.now()).toBeGreaterThan(6.9 * 86_400_000);

    // A new link ends the one before.
    const second = await makeLink();
    expect(second).not.toBe(first);
    expect((await publicPost("/ads/links/open", { token: first })).json().error).toBe("link_invalid");
    expect((await publicPost("/ads/links/open", { token: second })).json()).toMatchObject({ provider: "meta", workspace: "Shop Co", store: "Link Shop", state: "open", configured: true, choice: null });

    expect((await ctx.app.inject({ method: "DELETE", url: linkPath(), headers })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: linkPath(), headers })).json()).toEqual({ link: null });
    const gone = await publicPost("/ads/links/open", { token: second });
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error).toBe("link_invalid");
    expect(await systemDb.auditLog.count({ where: { action: { in: ["ads.link_created", "ads.link_revoked"] } } })).toBe(3);
  });

  it("connects the one ad account of whoever opens it, with no session, and is used up", async () => {
    ctx.setFetch(metaPlatform(1));
    const token = await makeLink();
    const back = await linkFlow(token);
    expect(back.pathname).toBe("/connect/meta");
    expect(back.searchParams.get("t")).toBe(token);
    expect(back.searchParams.get("done")).toBe("1");

    const [row] = await systemDb.adConnection.findMany({ where: { storeId } });
    expect(row).toMatchObject({ provider: "meta", accountId: "act_1", accountName: "Agency ads", status: "active", source: "direct", externalUserId: "9876" });
    // The grant is the outside person's: no member is its connector.
    expect(row!.connectedByUserId).toBeNull();
    expect(await adAccessToken(row!)).toBe("AGENCY_LONG_SECRET");
    // The audit log names who sent the link.
    const audit = await systemDb.auditLog.findFirstOrThrow({ where: { action: "ads.connected" } });
    expect(audit.actorUserId).toBe(ownerId);
    expect(audit.metadata).toMatchObject({ provider: "meta", accounts: 1, via: "link" });

    // Used: the page says so, the settings no longer offer it, and it can't start another sign-in.
    expect((await publicPost("/ads/links/open", { token })).json()).toMatchObject({ state: "used", accounts: 1 });
    expect((await ctx.app.inject({ method: "GET", url: linkPath(), headers })).json()).toEqual({ link: null });
    const again = await publicPost("/ads/links/start", { token });
    expect(again.statusCode).toBe(410);
    expect(again.json().error).toBe("link_used");
  });

  it("several accounts: the person ticks them on the link's page", async () => {
    ctx.setFetch(metaPlatform(2));
    const token = await makeLink();
    const back = await linkFlow(token);
    const pick = back.searchParams.get("choose")!;
    expect(pick).toBeTruthy();
    expect(await systemDb.adConnection.count()).toBe(0);

    const opened = await publicPost("/ads/links/open", { token, pick });
    expect(opened.body).not.toContain("AGENCY_LONG_SECRET");
    expect(opened.json().choice).toMatchObject({ provider: "meta", accounts: [{ accountId: "act_1", connected: false }, { accountId: "act_2", connected: false }] });
    // A choice belongs to its link: nobody else's page shows it.
    expect((await publicPost("/ads/links/open", { token: "x".repeat(43), pick })).statusCode).toBe(404);

    expect((await publicPost("/ads/links/choose", { token, pick, accountIds: ["act_9"] })).json().error).toBe("invalid_accounts");
    const chose = await publicPost("/ads/links/choose", { token, pick, accountIds: ["act_2"] });
    expect(chose.json()).toEqual({ connected: 1 });
    expect((await systemDb.adConnection.findMany({ where: { storeId } })).map((r) => [r.accountId, r.connectedByUserId])).toEqual([["act_2", null]]);
    expect((await publicPost("/ads/links/open", { token })).json()).toMatchObject({ state: "used", accounts: 1 });
  });

  it("cancelling the choice connects nothing, and the link still works", async () => {
    ctx.setFetch(metaPlatform(2));
    const token = await makeLink();
    const pick = (await linkFlow(token)).searchParams.get("choose")!;
    expect((await publicPost("/ads/links/cancel", { token, pick })).json()).toEqual({ ok: true });
    expect((await publicPost("/ads/links/open", { token, pick })).json()).toMatchObject({ state: "open", choice: null });
    expect(await systemDb.adConnection.count()).toBe(0);
    expect((await publicPost("/ads/links/choose", { token, pick, accountIds: ["act_1"] })).json().error).toBe("pending_expired");
  });

  it("Not now on Facebook's screen: back to the link's page, which still works", async () => {
    const token = await makeLink();
    const back = await linkFlow(token, { error: "access_denied", error_reason: "user_denied" });
    expect(back.pathname).toBe("/connect/meta");
    expect(back.searchParams.get("error")).toBe("denied");
    expect((await publicPost("/ads/links/open", { token })).json().state).toBe("open");
  });

  it("stops working once its maker may no longer connect ad accounts to the store", async () => {
    ctx.setFetch(metaPlatform(1));
    const token = await makeLink();
    const start = await publicPost("/ads/links/start", { token });
    const state = new URL(start.json().url).searchParams.get("state")!;
    await systemDb.membership.updateMany({ where: { workspaceId: ws, userId: ownerId }, data: { revokedAt: new Date() } });

    expect((await publicPost("/ads/links/open", { token })).json().state).toBe("ended");
    expect((await publicPost("/ads/links/start", { token })).json().error).toBe("link_ended");
    // A sign-in started before is refused on its way back.
    const cb = await ctx.app.inject({ method: "GET", url: `/ads/meta/callback?${new URLSearchParams({ state, code: "CODE" })}`, headers: { cookie: `ads_oauth_state=${state}` } });
    expect(new URL(cb.headers.location as string).searchParams.get("error")).toBe("link_ended");
    expect(await systemDb.adConnection.count()).toBe(0);
  });

  it("starts a sign-in only from bizinsights' own pages, and only with a real link", async () => {
    const token = await makeLink();
    const crossSite = await publicPost("/ads/links/start", { token }, { origin: "https://evil.example" });
    expect(crossSite.statusCode).toBe(403);
    expect((await publicPost("/ads/links/start", { token: "not-a-token" })).json().error).toBe("link_invalid");
    expect((await publicPost("/ads/links/open", { token: "" })).statusCode).toBe(400);
  });

  it("a connection made through a link never serves the maker's other stores", async () => {
    ctx.setFetch(metaPlatform(1));
    const token = await makeLink();
    await linkFlow(token);
    const other = await createStore(ws, "other-shop.myshopify.com", ["read_orders"]);
    const reuse = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${other.id}/ads/meta/reuse`, headers });
    expect(reuse.statusCode).toBe(404);
    expect(reuse.json().error).toBe("reuse_unavailable");
  });

  it("only people who manage integrations make or see a link", async () => {
    const member = await signIn(ctx, "link-viewer", "viewer@shop.test");
    await systemDb.membership.create({ data: { workspaceId: ws, userId: member.user.id, role: "custom", permissions: ["integrations.status"] } });
    expect((await ctx.app.inject({ method: "GET", url: linkPath(), headers: member.headers })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "POST", url: linkPath(), headers: member.headers })).statusCode).toBe(403);
  });
});
