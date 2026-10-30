import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encryptTokenFields, type FetchLike } from "@app/core";
import { systemDb } from "@app/db";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";
import { LEGACY_GRANTS } from "@app/shared";

/**
 * The dynamic optional-scope flow (apps/api/src/routes/scopes.ts): requesting a scope, learning
 * what was granted, and giving one back.
 *
 * The thing these tests are really guarding is that the flow stays DORMANT in the configuration
 * the app ships with. `SHOPIFY_OPTIONAL_SCOPES` is empty until Shopify approves the app for
 * protected customer data, and until then every entry point has to refuse rather than build a
 * URL Shopify would reject — a merchant sent to a Shopify error page reads it as our bug.
 */

const SHOP = "demo-shop.myshopify.com";

/** A connected store with a usable access token, so `scopes/refresh` can reach Shopify. */
async function connectedStore(ws: string, scopes: string[]) {
  const store = await createStore(ws, SHOP, scopes);
  await systemDb.store.update({
    where: { id: store.id },
    data: encryptTokenFields(store.id, {
      accessToken: "shpat_test",
      scopes,
      accessTokenExpiresAt: null,
      refreshToken: null,
      refreshTokenExpiresAt: null,
    }),
  });
  return store;
}

const gql = (data: unknown) =>
  new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });

/** Shopify answering the currentAppInstallation query with `scopes`. */
const grantedScopesResponse = (scopes: string[]) => async () =>
  gql({ currentAppInstallation: { accessScopes: scopes.map((handle) => ({ handle })) } });

/**
 * Shopify answering both calls a revoke makes: the mutation, then the reconcile that re-reads
 * what is left. `after` is what the installation has once the revoke has happened.
 */
function revokeResponses(opts: { revoked?: string[]; userErrors?: Array<{ message: string }>; after?: string[] }) {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (_input, init) => {
    const query = String(init?.body ?? "");
    if (query.includes("appRevokeAccessScopes")) {
      calls.push("revoke");
      return gql({
        appRevokeAccessScopes: {
          revoked: (opts.revoked ?? []).map((handle) => ({ handle })),
          userErrors: opts.userErrors ?? [],
        },
      });
    }
    calls.push("granted");
    return gql({ currentAppInstallation: { accessScopes: (opts.after ?? []).map((handle) => ({ handle })) } });
  };
  return { fetchImpl, calls };
}

describe("optional scope requests", () => {
  let ctx: TestCtx;
  let headers: Record<string, string>;
  let ws: string;

  beforeAll(async () => {
    ctx = await setup();
  });
  afterAll(async () => teardown(ctx));

  beforeEach(async () => {
    await clean(ctx);
    ({ headers } = await signIn(ctx, "u1", "owner@example.com"));
    ws = await createWorkspace(ctx, headers);
  });

  afterEach(() => ctx.setEnv({ SHOPIFY_OPTIONAL_SCOPES: "", SHOPIFY_APP_OPTIONAL_SCOPES: "", SHOPIFY_APP_STORE_PREVIEW_SHOPS: "" }));

  describe("while the app declares no optional scopes (the shipped configuration)", () => {
    it("refuses the request instead of handing the merchant a dead Shopify link", async () => {
      const store = await connectedStore(ws, ["read_orders", "read_products"]);
      const res = await ctx.app.inject({
        method: "POST",
        url: `/workspaces/${ws}/stores/${store.id}/scopes/request`,
        headers,
        payload: { module: "customers" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("scope_unavailable");
    });

    it("tells the dashboard that no locked module can be unlocked", async () => {
      const store = await connectedStore(ws, ["read_orders", "read_products"]);
      const res = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${store.id}/overview?preset=30d`, headers });
      expect(res.statusCode).toBe(200);
      const locked = res.json().capabilities.filter((c: { enabled: boolean }) => !c.enabled);
      expect(locked.length).toBeGreaterThan(0);
      // Nothing requestable and nothing reconnectable: the UI offers no action at all, because
      // the store already has every scope the app declares.
      for (const c of locked) {
        expect(c.requestableScopes).toEqual([]);
        expect(c.reconnectableScopes).toEqual([]);
      }
    });

    it("still tells a store missing a required scope to reconnect", async () => {
      // read_products IS asked for at install, so a store without it has a stale grant and
      // reconnecting fixes it. Blaming Shopify approval here would strand the merchant.
      const store = await connectedStore(ws, ["read_orders"]);
      const res = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${store.id}/overview?preset=30d`, headers });
      const caps = res.json().capabilities as Array<{ id: string; reconnectableScopes: string[]; requestableScopes: string[] }>;
      const inventory = caps.find((c) => c.id === "inventory")!;
      expect(inventory.reconnectableScopes).toEqual(["read_products"]);
      expect(inventory.requestableScopes).toEqual([]);
      // The funnel's scopes are declared nowhere, so it stays actionless.
      expect(caps.find((c) => c.id === "funnel")!.reconnectableScopes).toEqual([]);
    });
  });

  describe("once the app declares them (after Shopify approval)", () => {
    beforeEach(() => ctx.setEnv({ SHOPIFY_OPTIONAL_SCOPES: "read_customers,write_pixels,read_customer_events" }));

    it("sends the merchant to Shopify's request URL for the module's missing scopes", async () => {
      const store = await connectedStore(ws, ["read_orders", "read_products"]);
      const res = await ctx.app.inject({
        method: "POST",
        url: `/workspaces/${ws}/stores/${store.id}/scopes/request`,
        headers,
        payload: { module: "customers" },
      });
      expect(res.statusCode).toBe(200);
      const url = new URL(res.json().url);
      expect(url.origin + url.pathname).toBe("https://admin.shopify.com/store/demo-shop/oauth/install");
      expect(url.searchParams.get("client_id")).toBe("test_key");
      // read_orders is already granted, so only the scope actually missing is asked for.
      expect(url.searchParams.get("optional_scopes")).toBe("read_customers");
      expect(await systemDb.auditLog.count({ where: { action: "store.scopes_requested" } })).toBe(1);
    });

    it("asks through the app the store is connected through, not the main app", async () => {
      // A store on a custom-distribution app must be sent to that app's client id, or Shopify
      // refuses — the same failure mode as installs (docs/shopify-setup.md 3d).
      const store = await connectedStore(ws, ["read_orders"]);
      await systemDb.store.update({ where: { id: store.id }, data: { shopifyAppKey: "client" } });
      const res = await ctx.app.inject({
        method: "POST",
        url: `/workspaces/${ws}/stores/${store.id}/scopes/request`,
        headers,
        payload: { scopes: ["read_customers"] },
      });
      expect(new URL(res.json().url).searchParams.get("client_id")).toBe("client_key");
    });

    it("answers alreadyGranted rather than prompting for a scope the store has", async () => {
      const store = await connectedStore(ws, ["read_orders", "read_customers"]);
      const res = await ctx.app.inject({
        method: "POST",
        url: `/workspaces/${ws}/stores/${store.id}/scopes/request`,
        headers,
        payload: { module: "customers" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ url: null, alreadyGranted: true });
    });

    it("still refuses a scope that is not declared optional", async () => {
      ctx.setEnv({ SHOPIFY_OPTIONAL_SCOPES: "read_customers" });
      const store = await connectedStore(ws, ["read_orders", "read_products"]);
      const res = await ctx.app.inject({
        method: "POST",
        url: `/workspaces/${ws}/stores/${store.id}/scopes/request`,
        headers,
        // The funnel needs write_pixels + read_customer_events, neither of them declared here.
        payload: { module: "funnel" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("scope_unavailable");
    });

    it("marks a module offerable only when every missing scope can be requested", async () => {
      ctx.setEnv({ SHOPIFY_OPTIONAL_SCOPES: "read_customers" });
      const store = await connectedStore(ws, ["read_orders", "read_products"]);
      const res = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${store.id}/overview?preset=30d`, headers });
      const caps = res.json().capabilities as Array<{ id: string; missingScopes: string[]; requestableScopes: string[] }>;
      const customers = caps.find((c) => c.id === "customers")!;
      expect(customers.requestableScopes).toEqual(customers.missingScopes);
      const funnel = caps.find((c) => c.id === "funnel")!;
      expect(funnel.requestableScopes).toEqual([]);
      expect(funnel.missingScopes).toEqual(["write_pixels", "read_customer_events"]);
    });

    it("refuses a viewer: granting scopes is managing the store", async () => {
      const store = await connectedStore(ws, ["read_orders"]);
      const viewer = await signIn(ctx, "u2", "viewer@example.com");
      await systemDb.membership.create({ data: { workspaceId: ws, userId: viewer.user.id, role: "viewer", permissions: [...LEGACY_GRANTS.viewer] } });
      const res = await ctx.app.inject({
        method: "POST",
        url: `/workspaces/${ws}/stores/${store.id}/scopes/request`,
        headers: viewer.headers,
        payload: { module: "customers" },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  /**
   * read_reports (Shopify's reports: its sessions and visitors, gross profit, the sales check) is
   * declared only by some apps' tomls (SHOPIFY_APP_OPTIONAL_SCOPES), never by an App Store app
   * while Shopify reviews it. Shipped empty, so this turns it on for the main app.
   */
  describe("an app that declares read_reports", () => {
    beforeEach(() => ctx.setEnv({ SHOPIFY_APP_OPTIONAL_SCOPES: "default:read_reports" }));

    const caps = async (storeId: string) => {
      const res = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/overview?preset=30d`, headers });
      expect(res.statusCode).toBe(200);
      return res.json().capabilities as Array<{ id: string; missingScopes: string[]; requestableScopes: string[] }>;
    };
    const ask = (storeId: string, module: string) =>
      ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${storeId}/scopes/request`, headers, payload: { module } });

    it("offers Shopify's reports to a store on that app", async () => {
      const store = await connectedStore(ws, ["read_orders", "read_products"]);
      const c = await caps(store.id);
      expect(c.find((x) => x.id === "profit")!.requestableScopes).toEqual(["read_reports"]);
      expect(c.find((x) => x.id === "shopify_sessions")!.requestableScopes).toEqual(["read_reports"]);
    });

    it("sends the merchant to that app's grant screen for read_reports", async () => {
      const store = await connectedStore(ws, ["read_orders", "read_products"]);
      const res = await ask(store.id, "profit");
      expect(res.statusCode).toBe(200);
      const url = new URL(res.json().url);
      expect(url.searchParams.get("client_id")).toBe("test_key");
      expect(url.searchParams.get("optional_scopes")).toBe("read_reports");
    });

    it("offers nothing to a store on an App Store app, which doesn't declare it", async () => {
      const store = await connectedStore(ws, ["read_orders", "read_products"]);
      await systemDb.store.update({ where: { id: store.id }, data: { shopifyAppKey: "appstore" } });
      expect((await caps(store.id)).find((x) => x.id === "profit")!.requestableScopes).toEqual([]);
      const res = await ask(store.id, "profit");
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("scope_unavailable");
    });

    it("offers nothing to the App Store reviewer's test store, though it is on the main app", async () => {
      ctx.setEnv({ SHOPIFY_APP_STORE_PREVIEW_SHOPS: SHOP });
      const store = await connectedStore(ws, ["read_orders", "read_products"]);
      expect((await caps(store.id)).find((x) => x.id === "shopify_sessions")!.requestableScopes).toEqual([]);
      const res = await ask(store.id, "shopify_sessions");
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("scope_unavailable");
    });

    it("lists read_reports as removable once granted, and gives it back", async () => {
      const store = await connectedStore(ws, ["read_orders", "read_products", "read_reports"]);
      const list = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores`, headers });
      expect(list.json().stores.find((x: { id: string }) => x.id === store.id).revocableScopes).toEqual(["read_reports"]);

      ctx.setFetch(revokeResponses({ revoked: ["read_reports"], after: ["read_orders", "read_products"] }).fetchImpl);
      const res = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${store.id}/scopes/revoke`, headers, payload: { module: "profit" } });
      expect(res.statusCode).toBe(200);
      expect(res.json().revoked).toEqual(["read_reports"]);
      // The module is one consent away again.
      const profit = (res.json().capabilities as Array<{ id: string; requestableScopes: string[] }>).find((x) => x.id === "profit")!;
      expect(profit.requestableScopes).toEqual(["read_reports"]);
    });

    it("lists nothing removable for a store whose app doesn't declare it", async () => {
      const store = await connectedStore(ws, ["read_orders", "read_products", "read_reports"]);
      await systemDb.store.update({ where: { id: store.id }, data: { shopifyAppKey: "appstore" } });
      const list = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores`, headers });
      expect(list.json().stores.find((x: { id: string }) => x.id === store.id).revocableScopes).toEqual([]);
    });
  });

  describe("learning what was granted", () => {
    it("reconciles from Shopify and queues the backfill the new scope needs", async () => {
      const store = await connectedStore(ws, ["read_orders", "read_products"]);
      ctx.setFetch(grantedScopesResponse(["read_orders", "read_products", "read_customers", "write_pixels"]));

      const res = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${store.id}/scopes/refresh`, headers });
      expect(res.statusCode).toBe(200);
      expect(res.json().granted).toEqual(["read_customers", "write_pixels"]);

      const after = await systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
      expect(after.grantedScopes).toContain("read_customers");

      // read_customers changes what the orders query asks for, so already-imported orders carry
      // no customer hash: the re-import has to be a FULL one, and the pixel has to be created.
      const kinds = ctx.deps.queues.sent.sync.map((j) => j.kind);
      expect(kinds).toContain("orders");
      expect(kinds).toContain("install_pixel");
      expect(ctx.deps.queues.sent.sync.find((j) => j.kind === "orders")?.sinceDays).toBeUndefined();
    });

    it("queues nothing when the merchant granted nothing new", async () => {
      const store = await connectedStore(ws, ["read_orders", "read_products"]);
      ctx.setFetch(grantedScopesResponse(["read_orders", "read_products"]));
      const res = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${store.id}/scopes/refresh`, headers });
      expect(res.statusCode).toBe(200);
      expect(res.json().granted).toEqual([]);
      expect(ctx.deps.queues.sent.sync).toEqual([]);
    });

    it("records a scope the merchant revoked", async () => {
      const store = await connectedStore(ws, ["read_orders", "read_products", "read_customers"]);
      ctx.setFetch(grantedScopesResponse(["read_orders", "read_products"]));
      await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${store.id}/scopes/refresh`, headers });
      const after = await systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
      expect(after.grantedScopes).toEqual(["read_orders", "read_products"]);
      expect(ctx.deps.queues.sent.sync).toEqual([]);
    });

    it("reports a Shopify failure instead of wiping the stored scopes", async () => {
      const store = await connectedStore(ws, ["read_orders", "read_customers"]);
      // 403, not 500: a 5xx is retried with backoff (~15s), which this case isn't about.
      ctx.setFetch(async () => new Response("denied", { status: 403 }));
      const res = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${store.id}/scopes/refresh`, headers });
      expect(res.statusCode).toBe(502);
      const after = await systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
      expect(after.grantedScopes).toEqual(["read_orders", "read_customers"]);
    });

    it("rate limits the refresh, which a merchant can trigger by reloading", async () => {
      const store = await connectedStore(ws, ["read_orders"]);
      ctx.setFetch(grantedScopesResponse(["read_orders"]));
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${store.id}/scopes/refresh`, headers });
        codes.push(res.statusCode);
      }
      expect(codes.filter((c) => c === 200).length).toBe(3);
      expect(codes.filter((c) => c === 429).length).toBe(2);
    });

    it("404s for a store in another workspace", async () => {
      const other = await signIn(ctx, "u3", "other@example.com");
      const otherWs = await createWorkspace(ctx, other.headers, "Other");
      const store = await connectedStore(otherWs, ["read_orders"]);
      const res = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${store.id}/scopes/refresh`, headers });
      expect(res.statusCode).toBe(404);
    });
  });

  /**
   * Giving a scope back (`appRevokeAccessScopes`). Shopify's advice is to hold only the scopes a
   * feature currently needs, so that a token which leaks can do less — but Shopify will only take
   * back scopes the app declared as optional, so the interesting cases here are the refusals.
   */
  describe("giving an optional scope back", () => {
    const revokeUrl = (storeId: string) => `/workspaces/${ws}/stores/${storeId}/scopes/revoke`;
    const unreachable: FetchLike = async () => {
      throw new Error("should not reach Shopify");
    };

    it("refuses while the app declares no optional scopes (the shipped configuration)", async () => {
      // Nothing is optional, so nothing is ours to give back: refuse here rather than let Shopify
      // reject a mutation naming scopes from the install grant.
      const store = await connectedStore(ws, ["read_orders", "read_products", "read_customers"]);
      ctx.setFetch(unreachable);
      const res = await ctx.app.inject({ method: "POST", url: revokeUrl(store.id), headers, payload: { module: "customers" } });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("scope_unavailable");
      const after = await systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
      expect(after.grantedScopes).toContain("read_customers");
    });

    describe("once the app declares them", () => {
      beforeEach(() => ctx.setEnv({ SHOPIFY_OPTIONAL_SCOPES: "read_customers,write_pixels,read_customer_events" }));

      it("revokes it, reconciles the stored scopes and relocks the module", async () => {
        const store = await connectedStore(ws, ["read_orders", "read_products", "read_customers"]);
        const shopify = revokeResponses({ revoked: ["read_customers"], after: ["read_orders", "read_products"] });
        ctx.setFetch(shopify.fetchImpl);

        const res = await ctx.app.inject({ method: "POST", url: revokeUrl(store.id), headers, payload: { module: "customers" } });
        expect(res.statusCode).toBe(200);
        expect(res.json().revoked).toEqual(["read_customers"]);
        // The module needs read_orders too, but that one is part of the install grant: only the
        // optional scope is named in the mutation, and the stored scopes come from the reconcile.
        expect(shopify.calls).toEqual(["revoke", "granted"]);

        const after = await systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
        expect(after.grantedScopes).toEqual(["read_orders", "read_products"]);

        // The merchant can ask for it again: the module is locked, not dead.
        const caps = res.json().capabilities as Array<{ id: string; enabled: boolean; requestableScopes: string[] }>;
        const customers = caps.find((c) => c.id === "customers")!;
        expect(customers.enabled).toBe(false);
        expect(customers.requestableScopes).toEqual(["read_customers"]);

        expect(await systemDb.auditLog.count({ where: { action: "store.scopes_revoked" } })).toBe(1);
        const updated = await systemDb.auditLog.findFirstOrThrow({ where: { action: "store.scopes_updated" } });
        expect(updated.metadata).toMatchObject({ revoked: ["read_customers"], via: "revoke" });
      });

      it("refuses a required scope: that one can only go by uninstalling", async () => {
        const store = await connectedStore(ws, ["read_orders", "read_products"]);
        ctx.setFetch(unreachable);
        const res = await ctx.app.inject({ method: "POST", url: revokeUrl(store.id), headers, payload: { scopes: ["read_orders"] } });
        expect(res.statusCode).toBe(409);
        expect(res.json().error).toBe("scope_unavailable");
      });

      it("answers alreadyRevoked rather than calling Shopify about a scope the store doesn't have", async () => {
        const store = await connectedStore(ws, ["read_orders", "read_products"]);
        ctx.setFetch(unreachable);
        const res = await ctx.app.inject({ method: "POST", url: revokeUrl(store.id), headers, payload: { scopes: ["read_customers"] } });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ revoked: [], alreadyRevoked: true });
      });

      it("surfaces Shopify saying no, and leaves the stored scopes alone", async () => {
        // userErrors, not a GraphQL error: a refusal arrives inside a 200 and would otherwise
        // read as success.
        const store = await connectedStore(ws, ["read_orders", "read_customers"]);
        const shopify = revokeResponses({ userErrors: [{ message: "Cannot revoke a required scope" }] });
        ctx.setFetch(shopify.fetchImpl);
        const res = await ctx.app.inject({ method: "POST", url: revokeUrl(store.id), headers, payload: { scopes: ["read_customers"] } });
        expect(res.statusCode).toBe(409);
        expect(res.json().error).toBe("scope_not_revocable");
        expect(res.json().message).toContain("Cannot revoke");
        // Nothing changed at Shopify, so nothing is re-read or recorded here.
        expect(shopify.calls).toEqual(["revoke"]);
        const after = await systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
        expect(after.grantedScopes).toEqual(["read_orders", "read_customers"]);
        expect(await systemDb.auditLog.count({ where: { action: "store.scopes_revoked" } })).toBe(0);
      });

      it("keeps the revoke when only the reconcile after it fails", async () => {
        // The scope is already gone at Shopify, so reporting failure would have the caller retry
        // something that is done. The stored scopes must still drop it, or the dashboard keeps
        // offering a module whose scope the token no longer has.
        const store = await connectedStore(ws, ["read_orders", "read_products", "read_customers"]);
        ctx.setFetch(async (_input, init) => {
          if (String(init?.body ?? "").includes("appRevokeAccessScopes")) {
            return gql({ appRevokeAccessScopes: { revoked: [{ handle: "read_customers" }], userErrors: [] } });
          }
          return new Response("nope", { status: 403 });
        });

        const res = await ctx.app.inject({ method: "POST", url: revokeUrl(store.id), headers, payload: { scopes: ["read_customers"] } });
        expect(res.statusCode).toBe(200);
        expect(res.json().revoked).toEqual(["read_customers"]);
        expect(res.json().scopes).toEqual(["read_orders", "read_products"]);
        const after = await systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
        expect(after.grantedScopes).toEqual(["read_orders", "read_products"]);
        expect(await systemDb.auditLog.count({ where: { action: "store.scopes_revoked" } })).toBe(1);
      });

      it("reports a Shopify failure instead of recording a revoke that didn't happen", async () => {
        const store = await connectedStore(ws, ["read_orders", "read_customers"]);
        ctx.setFetch(async () => new Response("denied", { status: 403 }));
        const res = await ctx.app.inject({ method: "POST", url: revokeUrl(store.id), headers, payload: { scopes: ["read_customers"] } });
        expect(res.statusCode).toBe(502);
        const after = await systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
        expect(after.grantedScopes).toEqual(["read_orders", "read_customers"]);
        expect(await systemDb.auditLog.count({ where: { action: "store.scopes_revoked" } })).toBe(0);
      });

      it("refuses a viewer: giving permissions up is managing the store", async () => {
        const store = await connectedStore(ws, ["read_orders", "read_customers"]);
        const viewer = await signIn(ctx, "u2", "viewer@example.com");
        await systemDb.membership.create({ data: { workspaceId: ws, userId: viewer.user.id, role: "viewer", permissions: [...LEGACY_GRANTS.viewer] } });
        const res = await ctx.app.inject({
          method: "POST",
          url: revokeUrl(store.id),
          headers: viewer.headers,
          payload: { scopes: ["read_customers"] },
        });
        expect(res.statusCode).toBe(403);
      });

      it("rate limits the revoke, on the same budget as the refresh", async () => {
        // Both spend Shopify calls for one store, so they share one bucket: four revokes and a
        // refresh must not get five calls through.
        const store = await connectedStore(ws, ["read_orders", "read_customers"]);
        ctx.setFetch(revokeResponses({ revoked: ["read_customers"], after: ["read_orders", "read_customers"] }).fetchImpl);
        const codes: number[] = [];
        for (let i = 0; i < 4; i++) {
          const res = await ctx.app.inject({ method: "POST", url: revokeUrl(store.id), headers, payload: { scopes: ["read_customers"] } });
          codes.push(res.statusCode);
        }
        const refresh = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${store.id}/scopes/refresh`, headers });
        codes.push(refresh.statusCode);
        expect(codes.filter((c) => c === 429).length).toBe(2);
      });

      it("404s for a store in another workspace", async () => {
        const other = await signIn(ctx, "u3", "other@example.com");
        const otherWs = await createWorkspace(ctx, other.headers, "Other");
        const store = await connectedStore(otherWs, ["read_orders", "read_customers"]);
        const res = await ctx.app.inject({ method: "POST", url: revokeUrl(store.id), headers, payload: { scopes: ["read_customers"] } });
        expect(res.statusCode).toBe(404);
      });
    });

    /**
     * Settings - Stores renders a Remove control per revocable scope, and takes the list from the
     * API rather than deciding for itself: the browser cannot see `SHOPIFY_OPTIONAL_SCOPES`, and a
     * control the endpoint would refuse is worse than no control.
     */
    describe("what the stores list tells the UI", () => {
      it("offers nothing to remove in the shipped configuration", async () => {
        const store = await connectedStore(ws, ["read_orders", "read_products", "read_customers"]);
        const res = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores`, headers });
        expect(res.statusCode).toBe(200);
        const listed = res.json().stores.find((x: { id: string }) => x.id === store.id);
        expect(listed.grantedScopes).toContain("read_customers");
        expect(listed.revocableScopes).toEqual([]);
      });

      it("marks only the granted scopes the app declared optional", async () => {
        ctx.setEnv({ SHOPIFY_OPTIONAL_SCOPES: "read_customers,write_pixels" });
        const store = await connectedStore(ws, ["read_orders", "read_products", "read_customers"]);
        const res = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores`, headers });
        const listed = res.json().stores.find((x: { id: string }) => x.id === store.id);
        // read_orders/read_products are required, write_pixels was never granted.
        expect(listed.revocableScopes).toEqual(["read_customers"]);
      });

      it("offers exactly what the revoke endpoint accepts", async () => {
        // The guarantee the UI leans on: anything listed here is revocable, nothing else is.
        ctx.setEnv({ SHOPIFY_OPTIONAL_SCOPES: "read_customers" });
        const store = await connectedStore(ws, ["read_orders", "read_customers"]);
        const list = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores`, headers });
        const listed = list.json().stores.find((x: { id: string }) => x.id === store.id);

        ctx.setFetch(revokeResponses({ revoked: listed.revocableScopes, after: ["read_orders"] }).fetchImpl);
        const ok = await ctx.app.inject({ method: "POST", url: revokeUrl(store.id), headers, payload: { scopes: listed.revocableScopes } });
        expect(ok.statusCode).toBe(200);

        // And a scope the list withheld is refused, so the UI showing no control was right.
        const refused = await ctx.app.inject({ method: "POST", url: revokeUrl(store.id), headers, payload: { scopes: ["read_orders"] } });
        expect(refused.statusCode).toBe(409);
      });
    });
  });
});
