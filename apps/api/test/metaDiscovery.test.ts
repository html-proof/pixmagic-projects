import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adAccessToken, encryptAdTokens, type FetchLike } from "@app/core";
import { systemDb, type Store } from "@app/db";
import { localDay } from "@app/shared";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * Meta, found through the store's Shopify connection (GET .../meta/discovery, routes/integrations.ts;
 * core's integrations/metaDiscovery.ts; @app/shared/metaDiscovery): the six states worked out from
 * bizinsights' own Meta sign-ins and from the store's Shopify orders, Shopify's Meta never counted as
 * bizinsights' authorization, what each caller sees and is offered, and connecting a store with the
 * Meta sign-in the person already gave bizinsights for another store (POST .../ads/meta/reuse) without
 * Meta's screen. Real Postgres; Meta is a fake.
 */

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => {
  ctx.setEnv(NO_KEYS);
  await teardown(ctx);
});

const KEYS = { META_APP_ID: "meta_app", META_APP_SECRET: "meta_secret", META_CONFIG_ID: "" };
const NO_KEYS = { META_APP_ID: "", META_APP_SECRET: "", META_CONFIG_ID: "" };
const DAY = 86_400_000;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Meta's listing of the sign-in's ad accounts (and every Meta call made, for the "nothing called" checks). */
let metaCalls: string[] = [];
let accounts: Array<{ id: string; name: string; currency: string; timezone_name: string }> = [];
let refuse = false;
const meta: FetchLike = async (input) => {
  const u = new URL(String(input));
  metaCalls.push(u.pathname);
  if (refuse) return json({ error: { message: "Error validating access token: Session has expired", type: "OAuthException", code: 190 } }, 400);
  if (u.pathname.endsWith("/me/adaccounts")) return json({ data: accounts });
  return json({ error: { message: `unexpected ${u.pathname}` } }, 400);
};

let owner: Awaited<ReturnType<typeof signIn>>;
let ws: string;
let storeA: Store;
let storeB: Store;

beforeEach(async () => {
  await clean(ctx);
  ctx.setEnv(KEYS);
  metaCalls = [];
  refuse = false;
  accounts = [{ id: "act_1", name: "Shop ads", currency: "USD", timezone_name: "UTC" }];
  ctx.setFetch(meta);
  owner = await signIn(ctx, "meta-owner", "owner@meta.test");
  ws = await createWorkspace(ctx, owner.headers);
  storeA = await createStore(ws, "first-shop.myshopify.com", ["read_orders"], { name: "First Shop", currency: "USD", lastSyncedAt: new Date(Date.now() - 3600_000) });
  storeB = await createStore(ws, "second-shop.myshopify.com", ["read_orders"], { name: "Second Shop", currency: "USD", lastSyncedAt: new Date(Date.now() - 3600_000) });
});

const discovery = (store: Store, headers: Record<string, string> = owner.headers) => ctx.app.inject({ method: "GET", url: `/workspaces/${store.workspaceId}/stores/${store.id}/meta/discovery`, headers });
const reuse = (store: Store, headers: Record<string, string> = owner.headers) => ctx.app.inject({ method: "POST", url: `/workspaces/${store.workspaceId}/stores/${store.id}/ads/meta/reuse`, headers });

async function answer(store: Store, headers?: Record<string, string>) {
  const res = await discovery(store, headers);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

let orderN = 0;
/** An order as the pipeline stores it, its visit from `source` (`medium`), `daysAgo` days ago. */
async function order(store: Store, source: string | null, medium: string | null, daysAgo = 2) {
  const at = new Date(Date.now() - daysAgo * DAY);
  orderN++;
  await systemDb.order.create({
    data: {
      workspaceId: store.workspaceId,
      storeId: store.id,
      shopifyId: `o${orderN}`,
      name: `#${orderN}`,
      currency: "USD",
      localDay: localDay(at, "UTC"),
      shopifyCreatedAt: at,
      shopifyProcessedAt: at,
      shopifyUpdatedAt: at,
      subtotal: 50,
      totalDiscounts: 0,
      totalTax: 0,
      totalShipping: 0,
      totalPrice: 50,
      trafficSource: source,
      trafficMedium: medium,
    },
  });
}

/** A member of the workspace with exactly these Team & Access permissions. */
async function member(uid: string, permissions: string[]) {
  const m = await signIn(ctx, uid, `${uid}@agency.test`);
  await systemDb.membership.create({ data: { workspaceId: ws, userId: m.user.id, role: "custom", permissions } });
  return m;
}

/** A Meta ad connection on `store`, sealed as a real one is, given by `userId`. */
function metaConnection(store: Store, userId: string | null, over: Record<string, unknown> = {}, token = "META_TOKEN_SECRET", expiresAt: Date | null = new Date(Date.now() + 40 * DAY)) {
  return systemDb.adConnection.create({
    data: {
      workspaceId: store.workspaceId,
      storeId: store.id,
      provider: "meta",
      accountId: "act_9",
      accountName: "Older ads",
      currency: "USD",
      connectedByUserId: userId,
      externalUserId: "fb-person-1",
      grantedScopes: ["ads_read", "public_profile"],
      lastSyncedAt: new Date(Date.now() - 3600_000),
      ...encryptAdTokens(store.id, "meta", { accessToken: token, refreshToken: null, expiresAt }),
      ...over,
    },
  });
}

describe("where a store's Meta stands", () => {
  it("is not connected with nothing of bizinsights' and no Meta order in Shopify, and offers Meta's sign-in", async () => {
    await order(storeB, "google", "paid");
    const d = await answer(storeB);
    expect(d).toMatchObject({ state: "NOT_CONNECTED", marker: null, authorizedForOurApp: false, shopifySharesMetaAccess: false, action: "connect", configured: true, reuse: null });
    expect(d.shopify).toMatchObject({ ordersRead: true, days: 90, orders: 0, paidOrders: 0 });
    expect(metaCalls).toEqual([]);
  });

  it("can't tell anything before the store's first import has finished", async () => {
    await systemDb.store.update({ where: { id: storeB.id }, data: { lastSyncedAt: null } });
    const d = await answer(storeB);
    expect(d.state).toBe("NOT_CONNECTED");
    expect(d.shopify.ordersRead).toBe(false);
  });

  it("marks Meta seen in Shopify's orders as not authorized for bizinsights, and still asks for Meta's sign-in", async () => {
    await order(storeB, "facebook", "paid");
    await order(storeB, "facebook", "unpaid", 10);
    await order(storeB, "instagram", "unpaid", 30);
    // Older than 90 days, and another platform's: not counted.
    await order(storeB, "facebook", "paid", 120);
    await order(storeB, "google", "paid");
    // Another store's.
    await order(storeA, "facebook", "paid");
    const d = await answer(storeB);
    expect(d).toMatchObject({
      state: "CONNECTED_IN_SHOPIFY",
      marker: "CONNECTED_IN_SHOPIFY_BUT_NOT_AUTHORIZED_FOR_OUR_APP",
      authorizedForOurApp: false,
      shopifySharesMetaAccess: false,
      action: "connect",
    });
    expect(d.shopify).toMatchObject({ ordersRead: true, orders: 3, facebook: 2, instagram: 1, paidOrders: 1 });
    expect(Date.parse(d.shopify.lastOrderAt)).toBeGreaterThan(Date.now() - 3 * DAY);
    expect(d.assets).toEqual({ adAccounts: [], campaigns: 0, waitingLogin: null });
    // Nothing was asked of Meta (nor of Shopify): the answer is the stored orders'.
    expect(metaCalls).toEqual([]);
  });

  it("offers no button where Meta's sign-in isn't set up", async () => {
    ctx.setEnv(NO_KEYS);
    await order(storeB, "instagram", "paid");
    const d = await answer(storeB);
    expect(d).toMatchObject({ state: "CONNECTED_IN_SHOPIFY", configured: false, action: null });
  });

  it("is authorized by bizinsights' own Meta sign-in, and lists the Meta assets without a token", async () => {
    await order(storeB, "facebook", "paid");
    await metaConnection(storeB, owner.user.id);
    const res = await discovery(storeB);
    const d = res.json();
    expect(d).toMatchObject({ state: "AUTHORIZED_FOR_OUR_APP", marker: null, authorizedForOurApp: true, action: null, reuse: null });
    expect(d.assets.adAccounts).toEqual([expect.objectContaining({ accountId: "act_9", name: "Older ads", currency: "USD", state: "AUTHORIZED_FOR_OUR_APP", enabled: true })]);
    expect(res.body).not.toContain("META_TOKEN_SECRET");
    expect(res.body).not.toContain("accessTokenEnc");
  });

  it("is authorized by a Meta sign-in that waits for its first ad account", async () => {
    await systemDb.adLogin.create({ data: { workspaceId: ws, storeId: storeB.id, provider: "meta", loginName: "Sam Seller", reason: "no_ads_account", connectedByUserId: owner.user.id } });
    const d = await answer(storeB);
    expect(d).toMatchObject({ state: "AUTHORIZED_FOR_OUR_APP", action: null });
    expect(d.assets.waitingLogin).toEqual({ name: "Sam Seller" });
  });

  it("tells an expired sign-in from one Meta refused, and from a permission taken back", async () => {
    const conn = await metaConnection(storeB, owner.user.id, { status: "reconnect", errorCode: "auth_expired" }, "T", new Date(Date.now() - DAY));
    expect((await answer(storeB)).state).toBe("TOKEN_EXPIRED");
    await systemDb.adConnection.update({ where: { id: conn.id }, data: { accessTokenExpiresAt: new Date(Date.now() + 10 * DAY) } });
    expect(await answer(storeB)).toMatchObject({ state: "REAUTH_REQUIRED", action: "reconnect" });
    await systemDb.adConnection.update({ where: { id: conn.id }, data: { status: "reconnect", errorCode: "scope_missing" } });
    expect((await answer(storeB)).state).toBe("PERMISSION_MISSING");
    await systemDb.adConnection.update({ where: { id: conn.id }, data: { status: "permission", errorCode: "no_access" } });
    expect((await answer(storeB)).state).toBe("PERMISSION_MISSING");
  });
});

describe("what each caller sees and is offered", () => {
  beforeEach(async () => {
    await order(storeB, "facebook", "paid");
    await order(storeB, "instagram", "unpaid");
  });

  it("gives the state without the order counts to someone who may only see integration status", async () => {
    const m = await member("status-only", ["integrations.status"]);
    const d = await answer(storeB, m.headers);
    expect(d).toMatchObject({ state: "CONNECTED_IN_SHOPIFY", action: null });
    expect(d.shopify).toMatchObject({ orders: null, facebook: null, instagram: null, paidOrders: null, lastOrderAt: null });
  });

  it("gives the order counts with traffic sources, the ad-link ones only with attribution too", async () => {
    const traffic = await member("traffic", ["integrations.status", "analytics.traffic"]);
    expect((await answer(storeB, traffic.headers)).shopify).toMatchObject({ orders: 2, paidOrders: null });
    const both = await member("attribution", ["integrations.status", "analytics.traffic", "marketing.attribution"]);
    expect((await answer(storeB, both.headers)).shopify).toMatchObject({ orders: 2, paidOrders: 1 });
  });

  it("refuses a member without integration status, and another business's owner", async () => {
    const m = await member("nothing", ["analytics.traffic"]);
    expect((await discovery(storeB, m.headers)).statusCode).toBe(403);
    const other = await signIn(ctx, "other-owner", "other@shop.test");
    await createWorkspace(ctx, other.headers);
    expect((await discovery(storeB, other.headers)).statusCode).toBe(404);
  });
});

describe("using the person's own Meta sign-in for another of their stores", () => {
  it("offers it, connects the one ad account without Meta's screen, and the store is then authorized", async () => {
    await order(storeB, "facebook", "paid");
    await metaConnection(storeA, owner.user.id);
    const before = await answer(storeB);
    expect(before).toMatchObject({ state: "CONNECTED_IN_SHOPIFY", action: "reuse", reuse: { storeName: "First Shop" } });

    const res = await reuse(storeB);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ connected: 1 });
    const row = await systemDb.adConnection.findFirstOrThrow({ where: { storeId: storeB.id, provider: "meta" } });
    expect(row).toMatchObject({ accountId: "act_1", accountName: "Shop ads", connectedByUserId: owner.user.id, externalUserId: "fb-person-1", status: "active" });
    // The same grant, sealed for this store (never the other store's ciphertext).
    expect(await adAccessToken(row)).toBe("META_TOKEN_SECRET");
    expect(row.accessTokenEnc).not.toBe((await systemDb.adConnection.findFirstOrThrow({ where: { storeId: storeA.id } })).accessTokenEnc);
    // Meta was asked for the accounts only: no sign-in, no token exchange.
    expect(metaCalls.every((p) => p.endsWith("/me/adaccounts"))).toBe(true);
    expect(await answer(storeB)).toMatchObject({ state: "AUTHORIZED_FOR_OUR_APP", action: null, reuse: null });
  });

  it("lets the person choose when the sign-in reaches several ad accounts", async () => {
    accounts = [
      { id: "act_1", name: "Shop ads", currency: "USD", timezone_name: "UTC" },
      { id: "act_2", name: "EU ads", currency: "EUR", timezone_name: "Europe/Paris" },
    ];
    await metaConnection(storeA, owner.user.id);
    const res = await reuse(storeB);
    expect(res.statusCode, res.body).toBe(200);
    const pick = res.json().choose as string;
    expect(pick).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    const pending = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeB.id}/ads/pending/${pick}`, headers: owner.headers });
    expect(pending.json().accounts.map((a: { accountId: string }) => a.accountId)).toEqual(["act_1", "act_2"]);
    expect(await systemDb.adConnection.count({ where: { storeId: storeB.id } })).toBe(0);
    // Cancelling the choice leaves the other store's grant alone.
    const cancel = await ctx.app.inject({ method: "DELETE", url: `/workspaces/${ws}/stores/${storeB.id}/ads/pending/${pick}`, headers: owner.headers });
    expect(cancel.statusCode).toBe(200);
    expect(metaCalls.some((p) => p.includes("/permissions"))).toBe(false);
  });

  it("never offers someone else's sign-in, nor one that ends within a day, nor one waiting for a reconnect", async () => {
    const admin = await member("admin-two", ["integrations.status", "integrations.manage"]);
    await metaConnection(storeA, owner.user.id);
    expect((await answer(storeB, admin.headers)).action).toBe("connect");
    expect((await reuse(storeB, admin.headers)).json()).toMatchObject({ error: "reuse_unavailable" });

    await systemDb.adConnection.updateMany({ where: { storeId: storeA.id }, data: { accessTokenExpiresAt: new Date(Date.now() + 3600_000) } });
    expect((await answer(storeB)).reuse).toBeNull();
    await systemDb.adConnection.updateMany({ where: { storeId: storeA.id }, data: { accessTokenExpiresAt: new Date(Date.now() + 40 * DAY), status: "reconnect", errorCode: "auth_expired" } });
    expect((await answer(storeB)).reuse).toBeNull();
    expect((await reuse(storeB)).statusCode).toBe(404);
  });

  it("names a store in another workspace only as another of their stores", async () => {
    const otherWs = await createWorkspace(ctx, owner.headers, "Second business");
    const elsewhere = await createStore(otherWs, "elsewhere.myshopify.com", ["read_orders"], { name: "Elsewhere", lastSyncedAt: new Date() });
    await metaConnection(elsewhere, owner.user.id);
    expect(await answer(storeB)).toMatchObject({ action: "reuse", reuse: { storeName: null } });
  });

  it("says so when Meta no longer accepts the sign-in, and connects nothing", async () => {
    await metaConnection(storeA, owner.user.id);
    refuse = true;
    const res = await reuse(storeB);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("reuse_ended");
    expect(await systemDb.adConnection.count({ where: { storeId: storeB.id } })).toBe(0);
  });

  it("is refused to a member who may not manage integrations", async () => {
    const m = await member("viewer", ["integrations.status"]);
    await metaConnection(storeA, owner.user.id);
    expect((await reuse(storeB, m.headers)).statusCode).toBe(403);
  });
});
