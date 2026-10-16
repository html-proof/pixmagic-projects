import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySubscriptionUpdate, encryptTokenFields, type FetchLike } from "@app/core";
import { systemDb } from "@app/db";
import { signShopifyQuery } from "@app/shared";
import { clean, createStore, createWorkspace, setup, signIn, teardown, testBrowser, type TestCtx } from "./helpers.js";

/**
 * Paid plans through Shopify's Billing API, App Store requirements 1.2.1-1.2.3: charges only
 * through Shopify, approved by the merchant (again after a reinstall), and upgrades and downgrades
 * from inside the app. Shopify is faked below; packages/core/src/billing.ts has the rules.
 */

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => {
  ctx.setEnv({ BILLING_ENABLED: "" });
  await teardown(ctx);
});
beforeEach(async () => {
  await clean(ctx);
  ctx.setEnv({ BILLING_ENABLED: "1" });
  shopify = fakeShopify();
  ctx.setFetch(shopify.fetchImpl);
});

const gql = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });

/** Shopify, as far as billing goes: the charges it holds (id → status) and every Admin API call made. */
function fakeShopify() {
  const calls: Array<{ shop: string; op: string; query: string; variables: Record<string, unknown> }> = [];
  const charges = new Map<string, string>();
  const state = { partnerDevelopment: false, cancelErrors: [] as string[], next: 1 };
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/admin/oauth/access_token") {
      return new Response(JSON.stringify({ access_token: "shpat_reinstalled", scope: "read_orders,read_products" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    const op = /(?:query|mutation)\s+(\w+)/.exec(body.query)![1]!;
    calls.push({ shop: url.hostname, op, query: body.query, variables: body.variables });
    switch (op) {
      case "ShopPartnerDevelopment":
        return gql({ shop: { plan: { partnerDevelopment: state.partnerDevelopment } } });
      case "AppSubscriptionCreate": {
        const id = `gid://shopify/AppSubscription/${state.next++}`;
        charges.set(id, "PENDING");
        return gql({ appSubscriptionCreate: { confirmationUrl: "https://admin.shopify.com/charges/confirm", userErrors: [], appSubscription: { id, status: "PENDING" } } });
      }
      case "AppSubscriptionCancel": {
        const id = String(body.variables.id);
        const refused = state.cancelErrors.length ? state.cancelErrors : charges.get(id) === "ACTIVE" ? [] : ["The subscription can't be cancelled"];
        if (refused.length) return gql({ appSubscriptionCancel: { userErrors: refused.map((message) => ({ field: ["id"], message })), appSubscription: null } });
        charges.set(id, "CANCELLED");
        return gql({ appSubscriptionCancel: { userErrors: [], appSubscription: { id, status: "CANCELLED" } } });
      }
      case "AppSubscriptionStatuses":
        return gql({ nodes: (body.variables.ids as string[]).map((id) => (charges.has(id) ? { id, status: charges.get(id) } : null)) });
    }
    throw new Error(`unexpected Shopify call ${op}`);
  };
  return { calls, charges, state, fetchImpl, ops: () => calls.map((c) => c.op) };
}
let shopify: ReturnType<typeof fakeShopify>;

/** A store with a working token. */
async function connectedStore(workspaceId: string, shop: string, extra: Record<string, unknown> = {}) {
  const store = await createStore(workspaceId, shop, ["read_orders", "read_products"], { shopifyAppKey: "default", installedAt: new Date(Date.now() - 3600_000), ...extra });
  await systemDb.store.update({
    where: { id: store.id },
    data: encryptTokenFields(store.id, { accessToken: "shpat_x", scopes: ["read_orders", "read_products"], accessTokenExpiresAt: null, refreshToken: null, refreshTokenExpiresAt: null }),
  });
  return store;
}

/** An owner with a workspace and one connected store. */
async function owner(shop = "paying.myshopify.com") {
  const u = await signIn(ctx, "owner", "owner@x.com");
  const ws = await createWorkspace(ctx, u.headers);
  const store = await connectedStore(ws, shop);
  return { ...u, ws, store };
}

/** The workspace on `plan`, paid by an active charge on `storeId`'s bill. */
async function paying(ws: string, storeId: string, plan: "growth" | "scale" = "growth", chargeId = "gid://shopify/AppSubscription/100") {
  shopify.charges.set(chargeId, "ACTIVE");
  await systemDb.subscription.update({ where: { workspaceId: ws }, data: { plan, status: "active", shopifyChargeId: chargeId, billingStoreId: storeId } });
  return chargeId;
}

const now = () => String(Math.floor(Date.now() / 1000));
const signed = (path: string, params: Record<string, string>) => `${path}?${new URLSearchParams({ ...params, hmac: signShopifyQuery(params, "test_secret") })}`;

/** Opened from the Shopify admin after an install (or reinstall), through Shopify's authorize to the callback. */
async function installFromShopify(browser: ReturnType<typeof testBrowser>, shop: string) {
  const launch = await browser.get(signed("/shopify/launch", { shop, host: "aG9zdA", timestamp: now() }));
  const authorize = new URL(String(launch.headers.location));
  expect(authorize.pathname).toBe("/admin/oauth/authorize");
  return browser.get(signed("/shopify/callback", { code: "authcode", shop, state: authorize.searchParams.get("state")!, timestamp: now() }));
}

const sub = (ws: string) => systemDb.subscription.findUniqueOrThrow({ where: { workspaceId: ws } });
const post = (url: string, headers: Record<string, string>, payload: unknown = {}) => ctx.app.inject({ method: "POST", url, headers, payload });

/** Shopify approving a charge: it becomes active, and replaces (cancels) the one in force. */
async function approve(ws: string, chargeId: string) {
  const replaced = (await sub(ws)).shopifyChargeId;
  shopify.charges.set(chargeId, "ACTIVE");
  await applySubscriptionUpdate(ws, chargeId, "active");
  if (replaced) {
    shopify.charges.set(replaced, "CANCELLED");
    await applySubscriptionUpdate(ws, replaced, "cancelled");
  }
}

describe("while paid plans are switched off (BILLING_ENABLED unset)", () => {
  beforeEach(() => ctx.setEnv({ BILLING_ENABLED: "" }));

  it("no charge can be started, whoever calls the API", async () => {
    const { ws, store, headers } = await owner();
    const res = await post(`/workspaces/${ws}/billing/subscribe`, headers, { plan: "growth", storeId: store.id });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("billing_disabled");
    expect(shopify.calls).toEqual([]);
    expect(await sub(ws)).toMatchObject({ plan: "free", pendingChargeId: null });
  });

  it("nobody is held to a plan's store limit", async () => {
    const { ws, headers } = await owner();
    const res = await post(`/workspaces/${ws}/shopify/install`, headers, { shop: "second.myshopify.com" });
    expect(res.statusCode).toBe(200);
  });

  it("a charge already in force can still be cancelled", async () => {
    const { ws, store, headers } = await owner();
    await paying(ws, store.id);
    const res = await post(`/workspaces/${ws}/billing/cancel`, headers);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ plan: "free" });
    expect(shopify.ops()).toEqual(["AppSubscriptionCancel"]);
  });
});

describe("starting a paid plan", () => {
  it("asks Shopify for a charge that replaces the one in force at once, and keeps the plan until it is approved", async () => {
    const { ws, store, headers } = await owner();
    const res = await post(`/workspaces/${ws}/billing/subscribe`, headers, { plan: "growth", storeId: store.id });
    expect(res.statusCode).toBe(200);
    expect(res.json().confirmationUrl).toMatch(/^https:\/\/admin\.shopify\.com\//);

    expect(shopify.ops()).toEqual(["ShopPartnerDevelopment", "AppSubscriptionCreate"]);
    const create = shopify.calls[1]!;
    expect(create.shop).toBe("paying.myshopify.com");
    // Requirement 1.2.3 without two charges running: an approved change replaces the old one now.
    expect(create.query).toContain("replacementBehavior: APPLY_IMMEDIATELY");
    expect(create.variables).toMatchObject({ name: "bizinsights Growth", amount: 29, currency: "USD", test: true, returnUrl: "http://localhost:3001/settings/billing?confirmed=1" });

    // Sent to Shopify is not approved: an abandoned or declined approval must not read as Growth.
    const billing = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/billing`, headers });
    expect(billing.json().subscription).toEqual({
      plan: "free",
      status: "active",
      pendingPlan: "growth",
      billedStore: { id: store.id, shopDomain: "paying.myshopify.com", name: null },
    });
    expect(await sub(ws)).toMatchObject({ pendingChargeId: "gid://shopify/AppSubscription/1", shopifyChargeId: null, billingStoreId: store.id });
  });

  it("upgrades and downgrades between paid plans, each change replacing the charge on the same store's bill", async () => {
    const { ws, store, headers } = await owner();
    // A second store, open in the app when the merchant upgrades.
    const other = await connectedStore(ws, "other.myshopify.com");

    await post(`/workspaces/${ws}/billing/subscribe`, headers, { plan: "growth", storeId: store.id });
    await approve(ws, "gid://shopify/AppSubscription/1");
    expect(await sub(ws)).toMatchObject({ plan: "growth", shopifyChargeId: "gid://shopify/AppSubscription/1", billingStoreId: store.id });

    // Charged on the other store's bill, Scale would run alongside Growth: it goes on the same one.
    const up = await post(`/workspaces/${ws}/billing/subscribe`, headers, { plan: "scale", storeId: other.id });
    expect(up.statusCode).toBe(200);
    expect(shopify.calls.filter((c) => c.op === "AppSubscriptionCreate").map((c) => c.shop)).toEqual(["paying.myshopify.com", "paying.myshopify.com"]);
    expect(await sub(ws)).toMatchObject({ plan: "growth", pendingPlan: "scale", billingStoreId: store.id });
    await approve(ws, "gid://shopify/AppSubscription/2");
    expect(await sub(ws)).toMatchObject({ plan: "scale", shopifyChargeId: "gid://shopify/AppSubscription/2", pendingChargeId: null });
    expect(shopify.charges.get("gid://shopify/AppSubscription/1")).toBe("CANCELLED");

    const down = await post(`/workspaces/${ws}/billing/subscribe`, headers, { plan: "growth", storeId: store.id });
    expect(down.statusCode).toBe(200);
    await approve(ws, "gid://shopify/AppSubscription/3");
    expect(await sub(ws)).toMatchObject({ plan: "growth", shopifyChargeId: "gid://shopify/AppSubscription/3" });
    expect([...shopify.charges.values()].filter((s) => s === "ACTIVE")).toHaveLength(1);
  });

  it("refuses the plan already in force", async () => {
    const { ws, store, headers } = await owner();
    await paying(ws, store.id, "growth");
    const res = await post(`/workspaces/${ws}/billing/subscribe`, headers, { plan: "growth", storeId: store.id });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("already_on_plan");
    expect(shopify.calls).toEqual([]);
  });

  it("leaves the plan to the workspace's owners", async () => {
    const { ws, store } = await owner();
    const admin = await signIn(ctx, "admin", "admin@x.com");
    await systemDb.membership.create({ data: { workspaceId: ws, userId: admin.user.id, role: "admin" } });
    await paying(ws, store.id);
    expect((await post(`/workspaces/${ws}/billing/subscribe`, admin.headers, { plan: "scale", storeId: store.id })).statusCode).toBe(403);
    expect((await post(`/workspaces/${ws}/billing/cancel`, admin.headers)).statusCode).toBe(403);
    expect(shopify.calls).toEqual([]);
    expect(await sub(ws)).toMatchObject({ plan: "growth" });
  });
});

describe("switching to Free", () => {
  it("cancels the charge in force in Shopify, crediting the unused days, and the plan ends at once", async () => {
    const { ws, store, headers } = await owner();
    const charge = await paying(ws, store.id, "scale");
    const res = await post(`/workspaces/${ws}/billing/cancel`, headers);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ plan: "free" });
    expect(shopify.calls).toMatchObject([{ op: "AppSubscriptionCancel", shop: "paying.myshopify.com", variables: { id: charge, prorate: true } }]);
    expect(shopify.charges.get(charge)).toBe("CANCELLED");
    expect(await sub(ws)).toMatchObject({ plan: "free", status: "active", shopifyChargeId: null });
    expect(await systemDb.auditLog.findFirstOrThrow({ where: { action: "billing.cancelled" } })).toMatchObject({ workspaceId: ws, metadata: { plan: "scale", prorate: true } });

    // Shopify's own word on it, when it lands, changes nothing more.
    await applySubscriptionUpdate(ws, charge, "cancelled");
    expect(await sub(ws)).toMatchObject({ plan: "free" });
    expect(await systemDb.auditLog.count({ where: { action: "billing.subscription_ended" } })).toBe(0);
  });

  it("has nothing to cancel on Free", async () => {
    const { ws, headers } = await owner();
    const res = await post(`/workspaces/${ws}/billing/cancel`, headers);
    expect(res.json()).toEqual({ plan: "free" });
    expect(shopify.calls).toEqual([]);
  });

  it("keeps a change still awaiting approval: approving it gives that plan", async () => {
    const { ws, store, headers } = await owner();
    await paying(ws, store.id, "growth");
    await systemDb.subscription.update({ where: { workspaceId: ws }, data: { pendingPlan: "scale", pendingChargeId: "gid://shopify/AppSubscription/200" } });
    await post(`/workspaces/${ws}/billing/cancel`, headers);
    expect(await sub(ws)).toMatchObject({ plan: "free", pendingPlan: "scale" });
    await applySubscriptionUpdate(ws, "gid://shopify/AppSubscription/200", "active");
    expect(await sub(ws)).toMatchObject({ plan: "scale" });
  });

  it("reads back a charge Shopify already ended (an uninstall not processed yet) instead of failing", async () => {
    const { ws, store, headers } = await owner();
    const charge = await paying(ws, store.id);
    shopify.charges.set(charge, "CANCELLED");
    const res = await post(`/workspaces/${ws}/billing/cancel`, headers);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ plan: "free" });
    expect(shopify.ops()).toEqual(["AppSubscriptionCancel", "AppSubscriptionStatuses"]);
  });

  it("drops to Free without asking Shopify when the store that paid is no longer connected", async () => {
    const { ws, store, headers } = await owner();
    await paying(ws, store.id);
    await systemDb.store.update({ where: { id: store.id }, data: { status: "uninstalled", accessTokenEnc: null } });
    const res = await post(`/workspaces/${ws}/billing/cancel`, headers);
    expect(res.json()).toEqual({ plan: "free" });
    expect(shopify.calls).toEqual([]);
  });

  it("reports Shopify refusing it, and the plan stays as it is", async () => {
    const { ws, store, headers } = await owner();
    await paying(ws, store.id);
    shopify.state.cancelErrors = ["Shopify is having a bad day"];
    const res = await post(`/workspaces/${ws}/billing/cancel`, headers);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "billing_error", message: "Shopify is having a bad day" });
    expect(await sub(ws)).toMatchObject({ plan: "growth" });
  });
});

describe("uninstalling and reinstalling", () => {
  /** The owner's browser and workspace (and a second one, so a launch doesn't pick it on its own). */
  async function ownerBrowser() {
    const browser = testBrowser(ctx);
    await browser.signIn("owner", "owner@x.com");
    const ws = (await browser.post("/workspaces", { name: "Acme" })).json().workspace.id as string;
    await browser.post("/workspaces", { name: "Second" });
    return { browser, ws };
  }

  it("a store back after an uninstall starts on Free, and its plan has to be approved again", async () => {
    const { browser, ws } = await ownerBrowser();
    const store = await connectedStore(ws, "back.myshopify.com", { status: "uninstalled", accessTokenEnc: null, uninstalledAt: new Date() });
    await paying(ws, store.id, "growth");
    await systemDb.subscription.update({ where: { workspaceId: ws }, data: { pendingPlan: "scale", pendingChargeId: "gid://shopify/AppSubscription/101" } });

    const cb = await installFromShopify(browser, "back.myshopify.com");
    expect(cb.headers.location).toBe(`http://localhost:3001/onboarding?step=sync&store=${store.id}`);
    // Shopify cancelled the charges with the uninstall; nothing needed asking.
    expect(await sub(ws)).toMatchObject({ plan: "free", shopifyChargeId: null, pendingPlan: null, pendingChargeId: null, billingStoreId: null });
    expect(shopify.calls).toEqual([]);

    const again = await browser.post(`/workspaces/${ws}/billing/subscribe`, { plan: "growth", storeId: store.id });
    expect(again.statusCode).toBe(200);
    expect(again.json().confirmationUrl).toBeTruthy();
  });

  it("asks Shopify which charges stand when a store we took to be installed is authorized again", async () => {
    const { browser, ws } = await ownerBrowser();
    // Shopify refused the token (the uninstall webhook hasn't been processed): authorized again.
    const store = await connectedStore(ws, "relaunch.myshopify.com", { status: "error" });
    await systemDb.syncJob.create({ data: { workspaceId: ws, storeId: store.id, kind: "orders", status: "failed", error: "Shopify auth error 401" } });
    const charge = await paying(ws, store.id, "growth");
    shopify.charges.delete(charge); // made for the installation that is gone

    await installFromShopify(browser, "relaunch.myshopify.com");
    expect(shopify.ops()).toEqual(["AppSubscriptionStatuses"]);
    expect(await sub(ws)).toMatchObject({ plan: "free", shopifyChargeId: null });
  });

  it("keeps the plan when Shopify says its charge still stands", async () => {
    const { browser, ws } = await ownerBrowser();
    const store = await connectedStore(ws, "relaunch.myshopify.com", { status: "error" });
    await systemDb.syncJob.create({ data: { workspaceId: ws, storeId: store.id, kind: "orders", status: "failed", error: "Shopify auth error 401" } });
    const charge = await paying(ws, store.id, "scale");
    await installFromShopify(browser, "relaunch.myshopify.com");
    expect(await sub(ws)).toMatchObject({ plan: "scale", shopifyChargeId: charge });
  });

  it("a store installed by someone else leaves its old workspace's plan behind", async () => {
    const { ws, store } = await owner("moving.myshopify.com");
    await paying(ws, store.id, "growth");
    await systemDb.store.update({ where: { id: store.id }, data: { status: "uninstalled", accessTokenEnc: null, uninstalledAt: new Date() } });

    const cb = await installFromShopify(testBrowser(ctx), "moving.myshopify.com");
    expect(cb.headers.location).toBe("http://localhost:3001/claim");
    const moved = await systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(moved.workspaceId).not.toBe(ws);
    expect(await sub(ws)).toMatchObject({ plan: "free", shopifyChargeId: null, billingStoreId: null });
    expect(await sub(moved.workspaceId)).toMatchObject({ plan: "free", shopifyChargeId: null });
    expect(await systemDb.auditLog.findFirstOrThrow({ where: { action: "billing.subscription_ended" } })).toMatchObject({ workspaceId: ws, metadata: { reason: "store_moved" } });
  });
});

describe("store limits (each plan's, once paid plans are on sale)", () => {
  const install = (ws: string, headers: Record<string, string>, shop: string) => post(`/workspaces/${ws}/shopify/install`, headers, { shop });

  it("Free holds one store: another is refused before Shopify is involved, the one it has always reconnects", async () => {
    const { ws, headers } = await owner("first.myshopify.com");
    const res = await install(ws, headers, "second.myshopify.com");
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "store_limit", message: "The Free plan includes 1 store. Choose a bigger plan in Settings → Billing to connect another." });
    // The one-click connect lets the merchant pick the store on Shopify: refused up front too.
    const oneClick = await post(`/workspaces/${ws}/shopify/start`, headers);
    expect(oneClick.statusCode).toBe(403);
    expect(oneClick.json().error).toBe("store_limit");

    expect((await install(ws, headers, "first.myshopify.com")).statusCode).toBe(200);
  });

  it("an uninstalled store doesn't count", async () => {
    const { ws, store, headers } = await owner("first.myshopify.com");
    await systemDb.store.update({ where: { id: store.id }, data: { status: "uninstalled" } });
    expect((await install(ws, headers, "second.myshopify.com")).statusCode).toBe(200);
  });

  it("Growth holds three, Scale any number", async () => {
    const { ws, store, headers } = await owner("first.myshopify.com");
    await paying(ws, store.id, "growth");
    await connectedStore(ws, "second.myshopify.com");
    expect((await install(ws, headers, "third.myshopify.com")).statusCode).toBe(200);
    await connectedStore(ws, "third.myshopify.com");
    const full = await install(ws, headers, "fourth.myshopify.com");
    expect(full.statusCode).toBe(403);
    expect(full.json().message).toMatch(/^The Growth plan includes 3 stores\./);

    await systemDb.subscription.update({ where: { workspaceId: ws }, data: { plan: "scale" } });
    expect((await install(ws, headers, "fourth.myshopify.com")).statusCode).toBe(200);
  });

  it("an install from Shopify for someone whose one workspace is full lands in a workspace of the store's own", async () => {
    const browser = testBrowser(ctx);
    await browser.signIn("solo", "solo@x.com");
    const ws = (await browser.post("/workspaces", { name: "Solo" })).json().workspace.id as string;
    await connectedStore(ws, "first.myshopify.com");

    const cb = await installFromShopify(browser, "second.myshopify.com");
    // Installed on Shopify by now, so it still opens the app (requirement 2.3.3): to be claimed apart.
    expect(cb.headers.location).toBe("http://localhost:3001/claim");
    const second = await systemDb.store.findUniqueOrThrow({ where: { shopDomain: "second.myshopify.com" } });
    expect(second.workspaceId).not.toBe(ws);
    expect(await systemDb.store.count({ where: { workspaceId: ws } })).toBe(1);
  });
});
