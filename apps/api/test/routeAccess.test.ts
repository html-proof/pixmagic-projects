import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { encryptTokenFields, type FetchLike } from "@app/core";
import { systemDb } from "@app/db";
import { sha256Hex } from "@app/shared";
import { clean, cookiesFrom, createStore, createWorkspace, ORIGIN, setup, signIn, teardown, type InjectResponse, type TestCtx } from "./helpers.js";

/**
 * Every route the API serves, called by everyone who must be refused: deny by default, checked
 * route by route rather than for the routes someone remembered to test. A route added later is
 * covered the day it is added, and one that belongs to no list below fails this file until it is
 * placed in one, so nothing becomes reachable by accident.
 *
 * - Nobody signed in: 401 from every route behind a sign-in.
 * - A member of the workspace who was given nothing: refused everywhere except the few routes every
 *   member uses (their own access, their own notification settings, the store picker), and those
 *   show none of the business's data.
 * - The owner of another business: 404 for everything of this one (ids can't be probed).
 * - The workspace's own owner naming another business's store: never that store's data.
 * - A shared link (view-only), even an admin's with every view permission, and a workspace API key
 *   (read-only): refused by every route that changes something.
 *
 * What each permission shows once granted is team.test.ts's job; this file is about who gets in at all.
 */

let ctx: TestCtx;

/** Routes that answer without a session, by design: each has a check of its own (a signature, a signed token, an ingest key) or says nothing private. */
const PUBLIC = new Set([
  "GET /healthz",
  "GET /version",
  "GET /readyz",
  // Signing in, signing up, recovering an account.
  "GET /auth/config",
  "GET /auth/pending-link",
  "DELETE /auth/pending-link",
  "POST /auth/login",
  "POST /auth/login/mfa",
  "GET /auth/login/code",
  "POST /auth/login/code",
  "POST /auth/login/code/resend",
  "DELETE /auth/login/code",
  "POST /auth/signup",
  "POST /auth/signup/confirm",
  "POST /auth/signup/resend",
  "POST /auth/password/forgot",
  "POST /auth/password/reset",
  "POST /auth/otp/start",
  "POST /auth/otp/verify",
  "GET /auth/oauth/:provider/start",
  "POST /auth/oauth/callback",
  // "Am I signed in?": the session's own user, or nobody.
  "GET /auth/whoami",
  "GET /auth/session",
  // Signing out: without a session there is nothing to end.
  "POST /auth/logout",
  // OAuth returns, checked against the state they started with (bizinsights' own ad sign-in: core's adConnections/signIn.ts).
  "GET /ads/:provider/callback",
  "GET /shopify/callback",
  "GET /shopify/launch",
  "GET /shopify/claim",
  // Signed webhooks and machine endpoints (CSRF-exempt in app.ts).
  "POST /webhooks/shopify",
  "POST /webhooks/email/resend",
  "POST /webhooks/meta/deauthorize",
  "POST /webhooks/meta/data-deletion",
  "GET /webhooks/whatsapp",
  "POST /webhooks/whatsapp",
  // Evolution API's webhook: a JWT made from that connection's own key (core whatsapp/webhook.ts).
  "POST /webhooks/whatsapp/evolution/:instance",
  "POST /pixel/:key",
  "OPTIONS /pixel/:key",
  // Links customers and invitees follow, each carrying its own signed or random token.
  "GET /meta/data-deletion/:code",
  "GET /staff/invitations/lookup",
  "POST /staff/invitations/accept",
  "POST /invitations/preview",
  "POST /invitations/open",
  // A connect link's page (routes/adLinks.ts): the link's own 256-bit token, in the body.
  "POST /ads/links/open",
  "POST /ads/links/start",
  "POST /ads/links/choose",
  "POST /ads/links/cancel",
  // Zapier's server exchanging a code or a refresh token: authenticated by bizinsights' client secret (zapierOAuth.ts).
  "POST /oauth/token",
]);

/**
 * Zapier's API (routes/zapier.ts): only a bearer zat_ token of a Zapier connection gets in, never a
 * session cookie, a shared link or a workspace API key; its store is the connection's own.
 */
const ZAPIER_BEARER = new Set([
  "GET /zapier/me",
  "POST /zapier/hooks",
  "DELETE /zapier/hooks/:id",
  "GET /zapier/samples/:event",
  "GET /zapier/search/ad-performance",
  "GET /zapier/search/adsense-earnings",
  "GET /zapier/whatsapp/templates",
  "POST /zapier/whatsapp/messages",
]);

/** A shared link may still use this account route: who am I (that workspace only, read-only). */
const SHARED_ACCOUNT_ROUTES = new Set(["GET /me"]);

/**
 * Routes that say whether a sign-in method is configured before asking who is signed in: what
 * GET /auth/config tells anyone. Every other route asks who is calling before reading anything.
 */
const CONFIG_FIRST = new Set(["POST /auth/oauth/:provider/link"]);

/** The query a route needs before its permission is the question (the section of a download). */
const QUERY: Record<string, string> = {
  "GET /workspaces/:ws/stores/:storeId/export": "?section=sales",
  "GET /workspaces/:ws/stores/:storeId/export/table": "?section=sales",
};

/** A valid body for the every-member routes that change the member's own settings. */
const BODY: Record<string, unknown> = {
  "PUT /workspaces/:ws/notifications": { syncFailures: false, weeklyDigest: true, productNews: false },
};

/**
 * Workspace routes every member may call whatever they were granted: their own access (which the
 * app needs to know what to show), their own notification settings, the store picker, and the
 * dashboard's answer, which then holds only the modules they were granted (none here). Each is
 * checked below to show nothing of the business.
 */
const EVERY_MEMBER = new Set([
  "GET /workspaces/:ws/access",
  "GET /workspaces/:ws/stores",
  "GET /workspaces/:ws/stores/:storeId/overview",
  "GET /workspaces/:ws/notifications",
  "PUT /workspaces/:ws/notifications",
  "GET /workspaces/:ws/alerts",
  "GET /workspaces/:ws/staff/access",
]);

/** Requests that change nothing although they aren't GETs: estimates, previews and dry runs of what a page would send. */
const READ_ONLY_POSTS = new Set([
  "POST /workspaces/:ws/stores/:storeId/whatsapp/campaigns/estimate",
  // Asks for a one-time download link (a download, as GET /export is; a shared link keeps its export permissions).
  "POST /workspaces/:ws/staff/exports",
]);

/**
 * Changes a shared link's session may make, being the person's own and nothing of the business's:
 * their notification settings, and asking for the store's stock to be read again from Shopify, or
 * WhatsApp's connection state from the provider (which changes nothing there or in what anyone sees
 * but its freshness).
 */
const LINK_MAY_WRITE = new Set(["PUT /workspaces/:ws/notifications", "POST /workspaces/:ws/stores/:storeId/inventory/sync", "POST /workspaces/:ws/stores/:storeId/whatsapp/connection/check"]);

const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;
const isWorkspaceRoute = (path: string) => path.includes("/:ws");
const MARKER = "zz-secret-of-the-other-business";
const OWN_MARKER = "zz-private-product-of-acme";

interface World {
  ws: string;
  storeId: string;
  owner: { headers: Record<string, string> };
  nobody: { headers: Record<string, string> };
  stranger: { headers: Record<string, string> };
  otherStoreId: string;
  link: Record<string, string>;
  apiKey: Record<string, string>;
}
let w: World;
/** Every outbound call the app tried, with its URL: the other business's store must never be among them. */
const outbound: string[] = [];

/** A route's path for a request: this workspace and store, and made-up ids for the rest. */
function urlFor(r: { method: string; path: string }, ws: string, storeId: string): string {
  const fake = `c${randomBytes(12).toString("hex")}`;
  return r.path
    .replace(/:(\w+)\{([^}]+)\}/g, (_, _name: string, alts: string) => alts.split("|")[0]!)
    .replace(/:(\w+)/g, (_, name: string) => {
      if (name === "ws") return ws;
      if (name === "storeId") return storeId;
      if (name === "provider") return "meta";
      return fake;
    })
    .concat(QUERY[key(r)] ?? "");
}

/** Call a route as `headers` say, from our own web app's origin, with an empty JSON body for anything but a GET. */
async function send(r: { method: string; path: string }, headers: Record<string, string>, storeId = w.storeId): Promise<InjectResponse> {
  const payload = r.method === "GET" || r.method === "HEAD" ? undefined : (BODY[key(r)] ?? {});
  return ctx.app.inject({ method: r.method, url: urlFor(r, w.ws, storeId), headers: { ...ORIGIN, ...headers }, ...(payload === undefined ? {} : { payload }) });
}

beforeAll(async () => {
  ctx = await setup();
  await clean(ctx);
  ctx.setFetch((async (input: Parameters<FetchLike>[0]) => {
    outbound.push(String(input instanceof Request ? input.url : input));
    return new Response(JSON.stringify({ errors: "unavailable in this test" }), { status: 503, headers: { "content-type": "application/json" } });
  }) as FetchLike);

  // The business under test: an owner, a store with a product, and a member who was given nothing.
  const owner = await signIn(ctx, "owner-acme", "owner@acme.test");
  const ws = await createWorkspace(ctx, owner.headers, "Acme");
  const store = await createStore(ws, "acme.myshopify.com", ["read_orders", "read_products", "read_customers", "read_inventory"]);
  await systemDb.store.update({
    where: { id: store.id },
    data: encryptTokenFields(store.id, { accessToken: "shpat_acme", scopes: store.grantedScopes, accessTokenExpiresAt: null, refreshToken: null, refreshTokenExpiresAt: null }),
  });
  await systemDb.product.create({ data: { workspaceId: ws, storeId: store.id, shopifyId: "1", title: OWN_MARKER, status: "active", vendor: OWN_MARKER, shopifyUpdatedAt: new Date() } });
  const nobody = await signIn(ctx, "nobody", "nobody@agency.test");
  await systemDb.membership.create({ data: { workspaceId: ws, userId: nobody.user.id, role: "custom", permissions: [] } });

  // Another business, with its own owner and store.
  const stranger = await signIn(ctx, "owner-other", "owner@other.test");
  const otherWs = await createWorkspace(ctx, stranger.headers, "Other");
  const other = await createStore(otherWs, `${MARKER}.myshopify.com`, ["read_orders", "read_products", "read_customers", "read_inventory"], { name: MARKER });
  await systemDb.store.update({
    where: { id: other.id },
    data: encryptTokenFields(other.id, { accessToken: "shpat_other", scopes: other.grantedScopes, accessTokenExpiresAt: null, refreshToken: null, refreshTokenExpiresAt: null }),
  });
  await systemDb.product.create({ data: { workspaceId: otherWs, storeId: other.id, shopifyId: "1", title: MARKER, status: "active", vendor: MARKER, shopifyUpdatedAt: new Date() } });

  // An admin's shared link: every view and export permission, nothing that changes anything.
  const invited = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/team/invitations`, headers: owner.headers, payload: { email: "partner@agency.test", role: "admin", permissions: [] } });
  expect(invited.statusCode, invited.body).toBe(200);
  const mail = [...ctx.mailer.sent].reverse().find((m) => m.to === "partner@agency.test")!;
  const token = /#token=([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;
  const opened = await ctx.app.inject({ method: "POST", url: "/invitations/open", headers: ORIGIN, payload: { token } });
  expect(opened.statusCode, opened.body).toBe(200);

  // A workspace API key (read-only).
  const secret = `sk_${randomBytes(24).toString("hex")}`;
  await systemDb.apiKey.create({ data: { workspaceId: ws, name: "test", prefix: secret.slice(0, 8), keyHash: sha256Hex(secret), createdById: owner.user.id } });

  w = {
    ws,
    storeId: store.id,
    owner,
    nobody,
    stranger,
    otherStoreId: other.id,
    link: { cookie: cookiesFrom(opened), "x-bi-context": "shared" },
    apiKey: { authorization: `Bearer ${secret}` },
  };
}, 120_000);
afterAll(async () => teardown(ctx));

describe("every route of the API, deny by default", () => {
  it("knows every route: each is public by design, an account's own, or a workspace's", () => {
    const unknown = ctx.routes.filter((r) => !PUBLIC.has(key(r)) && !ZAPIER_BEARER.has(key(r)) && !isWorkspaceRoute(r.path) && !r.path.startsWith("/auth/") && !r.path.startsWith("/me"));
    // The account routes outside /auth and /me, listed so a new one is a decision, not a default.
    // GET /oauth/zapier/authorize: what Zapier's consent page shows the signed-in person (their workspaces).
    const accountElsewhere = ["POST /workspaces", "GET /employee/workspaces", "POST /invitations/accept", "POST /staff/invitations/accept-existing", "POST /shopify/claim", "GET /staff/exports/:token", "GET /oauth/zapier/authorize"];
    expect(unknown.map(key).filter((k) => !accountElsewhere.includes(k))).toEqual([]);
    // Every list names only routes that exist (a renamed route must be moved, not forgotten).
    const all = new Set(ctx.routes.map(key));
    for (const list of [PUBLIC, ZAPIER_BEARER, SHARED_ACCOUNT_ROUTES, CONFIG_FIRST, EVERY_MEMBER, READ_ONLY_POSTS, LINK_MAY_WRITE, new Set(Object.keys(QUERY)), new Set(Object.keys(BODY))]) expect([...list].filter((k) => !all.has(k))).toEqual([]);
    // Enough routes that the list above can't be an empty app.
    expect(ctx.routes.filter((r) => isWorkspaceRoute(r.path)).length).toBeGreaterThan(250);
  });

  it("places the ad sign-in: starting it is a workspace's (integrations.manage), its return is public by design, and nothing of Nango is left", () => {
    const all = new Set(ctx.routes.map(key));
    const start = "POST /workspaces/:ws/stores/:storeId/ads/:provider/connect";
    expect(all.has(start)).toBe(true);
    expect(isWorkspaceRoute(start)).toBe(true);
    expect(PUBLIC.has(start)).toBe(false);
    expect(all.has("GET /ads/:provider/callback")).toBe(true);
    expect(PUBLIC.has("GET /ads/:provider/callback")).toBe(true);
    // Nango's sign-in routes, its webhooks and its old callback address went with it.
    expect([...all].filter((k) => /nango/i.test(k))).toEqual([]);
  });

  it("places the integrations status: a store's read for View integration connection status, in no list above (every rule below holds for it), never public", () => {
    const status = "GET /workspaces/:ws/stores/:storeId/integrations";
    expect(new Set(ctx.routes.map(key)).has(status)).toBe(true);
    expect(isWorkspaceRoute(status)).toBe(true);
    for (const list of [PUBLIC, SHARED_ACCOUNT_ROUTES, CONFIG_FIRST, EVERY_MEMBER, READ_ONLY_POSTS, LINK_MAY_WRITE]) expect(list.has(status)).toBe(false);
  });

  it("places the Advertising area's downloads: the Google Ads analytics page's sections are a store's read for Export approved reports, in no list above (every rule below holds for it), never public", () => {
    // The live reports' downloads are no route of their own (format=csv on GET …/ads/meta/report and …/ads/google/report).
    const download = "GET /workspaces/:ws/stores/:storeId/ads/google/analytics/export";
    expect(new Set(ctx.routes.map(key)).has(download)).toBe(true);
    expect(isWorkspaceRoute(download)).toBe(true);
    for (const list of [PUBLIC, SHARED_ACCOUNT_ROUTES, CONFIG_FIRST, EVERY_MEMBER, READ_ONLY_POSTS, LINK_MAY_WRITE, new Set(Object.keys(QUERY))]) expect(list.has(download)).toBe(false);
  });

  it("places Shopify's abandoned checkouts: a store's read for View checkout abandonment, in no list above (every rule below holds for it), never public", () => {
    const checkouts = "GET /workspaces/:ws/stores/:storeId/abandoned-checkouts";
    expect(new Set(ctx.routes.map(key)).has(checkouts)).toBe(true);
    expect(isWorkspaceRoute(checkouts)).toBe(true);
    for (const list of [PUBLIC, SHARED_ACCOUNT_ROUTES, CONFIG_FIRST, EVERY_MEMBER, READ_ONLY_POSTS, LINK_MAY_WRITE]) expect(list.has(checkouts)).toBe(false);
  });

  it("places sales by collection: a store's read for View product performance, in no list above (every rule below holds for it), never public", () => {
    const collections = "GET /workspaces/:ws/stores/:storeId/analytics/collections/sales";
    expect(new Set(ctx.routes.map(key)).has(collections)).toBe(true);
    expect(isWorkspaceRoute(collections)).toBe(true);
    for (const list of [PUBLIC, SHARED_ACCOUNT_ROUTES, CONFIG_FIRST, EVERY_MEMBER, READ_ONLY_POSTS, LINK_MAY_WRITE]) expect(list.has(collections)).toBe(false);
  });

  it("places the order list: a store's read for View order list, in no list above (every rule below holds for it), never public", () => {
    const orders = "GET /workspaces/:ws/stores/:storeId/orders";
    expect(new Set(ctx.routes.map(key)).has(orders)).toBe(true);
    expect(isWorkspaceRoute(orders)).toBe(true);
    for (const list of [PUBLIC, SHARED_ACCOUNT_ROUTES, CONFIG_FIRST, EVERY_MEMBER, READ_ONLY_POSTS, LINK_MAY_WRITE, new Set(Object.keys(QUERY))]) expect(list.has(orders)).toBe(false);
  });

  it("places customer lifetime figures and cohorts: a store's read for View returning vs new customers, in no list above (every rule below holds for it), never public", () => {
    const customers = "GET /workspaces/:ws/stores/:storeId/analytics/customers";
    expect(new Set(ctx.routes.map(key)).has(customers)).toBe(true);
    expect(isWorkspaceRoute(customers)).toBe(true);
    for (const list of [PUBLIC, SHARED_ACCOUNT_ROUTES, CONFIG_FIRST, EVERY_MEMBER, READ_ONLY_POSTS, LINK_MAY_WRITE]) expect(list.has(customers)).toBe(false);
  });

  it("places deleting a workspace: its owners' alone (workspace:delete, a session of their own), in no list above (every rule below holds for it), never public", () => {
    // workspaceDeletion.test.ts: an admin, a member given everything and an API key are refused too.
    const all = new Set(ctx.routes.map(key));
    for (const route of ["GET /workspaces/:ws/deletion", "POST /workspaces/:ws/delete/code", "DELETE /workspaces/:ws"]) {
      expect(all.has(route), route).toBe(true);
      expect(isWorkspaceRoute(route), route).toBe(true);
      for (const list of [PUBLIC, SHARED_ACCOUNT_ROUTES, CONFIG_FIRST, EVERY_MEMBER, READ_ONLY_POSTS, LINK_MAY_WRITE]) expect(list.has(route), route).toBe(false);
    }
    // What an account's deletion takes with it: the account's own, behind a sign-in like the rest of /auth/account.
    expect(all.has("GET /auth/account/deletion")).toBe(true);
    for (const list of [PUBLIC, SHARED_ACCOUNT_ROUTES, CONFIG_FIRST]) expect(list.has("GET /auth/account/deletion")).toBe(false);
  });

  it("nobody signed in: 401 from every route behind a sign-in", async () => {
    const wrong: string[] = [];
    for (const r of ctx.routes.filter((r) => !PUBLIC.has(key(r)) && !CONFIG_FIRST.has(key(r)))) {
      const res = await send(r, {});
      if (res.statusCode !== 401) wrong.push(`${key(r)} → ${res.statusCode} ${res.body.slice(0, 120)}`);
    }
    expect(wrong).toEqual([]);
  }, 120_000);

  it("a member given nothing: refused everywhere but their own settings, which show nothing of the business", async () => {
    const wrong: string[] = [];
    for (const r of ctx.routes.filter((r) => isWorkspaceRoute(r.path))) {
      const res = await send(r, w.nobody.headers);
      if (EVERY_MEMBER.has(key(r))) {
        if (res.statusCode !== 200) wrong.push(`${key(r)} (every member's) → ${res.statusCode} ${res.body.slice(0, 120)}`);
        if (res.body.includes(OWN_MARKER)) wrong.push(`${key(r)} shows the store's products`);
        continue;
      }
      if (![403, 404].includes(res.statusCode)) wrong.push(`${key(r)} → ${res.statusCode} ${res.body.slice(0, 160)}`);
    }
    expect(wrong).toEqual([]);
  }, 120_000);

  it("what every member's routes give someone with nothing: no data, no figures, no counts", async () => {
    const get = async (url: string) => {
      const res = await ctx.app.inject({ method: "GET", url, headers: w.nobody.headers });
      expect(res.statusCode, res.body).toBe(200);
      return res.json();
    };
    const ov = await get(`/workspaces/${w.ws}/stores/${w.storeId}/overview`);
    expect(ov.modules).toEqual({});
    expect(ov.capabilities).toEqual([]);
    expect(ov.data ?? {}).not.toHaveProperty("orders");
    expect(ov.data ?? {}).not.toHaveProperty("products");
    const { stores } = await get(`/workspaces/${w.ws}/stores`);
    expect(stores.map((s: { id: string }) => s.id)).toEqual([w.storeId]);
    // How much the store holds is the business's (the dashboard's answer leaves it out the same way).
    expect(stores[0]).not.toHaveProperty("imported");
    expect((await get(`/workspaces/${w.ws}/access`)).permissions).toEqual([]);
    expect((await get(`/workspaces/${w.ws}/alerts`)).alerts).toEqual([]);
  });

  it("the owner of another business: 404 for everything of this one", async () => {
    const wrong: string[] = [];
    for (const r of ctx.routes.filter((r) => isWorkspaceRoute(r.path))) {
      const res = await send(r, w.stranger.headers);
      if (res.statusCode !== 404) wrong.push(`${key(r)} → ${res.statusCode} ${res.body.slice(0, 160)}`);
    }
    expect(wrong).toEqual([]);
  }, 120_000);

  it("an owner naming another business's store in their own workspace's routes: nothing of that store, never a call to it", async () => {
    const wrong: string[] = [];
    outbound.length = 0;
    for (const r of ctx.routes.filter((r) => r.path.includes(":ws") && r.path.includes(":storeId"))) {
      const res = await send(r, w.owner.headers, w.otherStoreId);
      if (res.statusCode < 300) wrong.push(`${key(r)} → ${res.statusCode} ${res.body.slice(0, 160)}`);
      if (res.body.includes(MARKER)) wrong.push(`${key(r)} shows the other business's store`);
    }
    expect(wrong).toEqual([]);
    expect(outbound.filter((u) => u.includes(MARKER))).toEqual([]);
  }, 120_000);

  it("a shared link, even an admin's: every route that changes something refuses it", async () => {
    const wrong: string[] = [];
    const writes = ctx.routes.filter((r) => r.method !== "GET" && !READ_ONLY_POSTS.has(key(r)) && !LINK_MAY_WRITE.has(key(r)));
    for (const r of writes.filter((r) => isWorkspaceRoute(r.path) || !PUBLIC.has(key(r)))) {
      if (SHARED_ACCOUNT_ROUTES.has(key(r))) continue;
      const res = await send(r, w.link);
      if (![401, 403, 404].includes(res.statusCode)) wrong.push(`${key(r)} → ${res.statusCode} ${res.body.slice(0, 160)}`);
    }
    expect(wrong).toEqual([]);
  }, 120_000);

  it("a shared link never reaches the account behind it", async () => {
    const wrong: string[] = [];
    for (const r of ctx.routes.filter((r) => !PUBLIC.has(key(r)) && !isWorkspaceRoute(r.path) && !SHARED_ACCOUNT_ROUTES.has(key(r)))) {
      const res = await send(r, w.link);
      if (![401, 403, 404].includes(res.statusCode)) wrong.push(`${key(r)} → ${res.statusCode} ${res.body.slice(0, 160)}`);
    }
    expect(wrong).toEqual([]);
  }, 120_000);

  it("Zapier's API: no session, shared link or workspace API key gets in, only a Zapier connection's own token", async () => {
    const wrong: string[] = [];
    for (const r of ctx.routes.filter((r) => ZAPIER_BEARER.has(key(r)))) {
      for (const [who, headers] of [["owner", w.owner.headers], ["shared link", w.link], ["API key", w.apiKey], ["made-up token", { authorization: `Bearer zat_${randomBytes(32).toString("base64url")}` }]] as const) {
        const res = await send(r, headers);
        if (res.statusCode !== 401) wrong.push(`${key(r)} as ${who} → ${res.statusCode} ${res.body.slice(0, 120)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("a workspace API key (read-only): every route that changes something refuses it", async () => {
    const wrong: string[] = [];
    for (const r of ctx.routes.filter((r) => isWorkspaceRoute(r.path) && r.method !== "GET" && !READ_ONLY_POSTS.has(key(r)))) {
      const res = await send(r, w.apiKey);
      if (![401, 403, 404].includes(res.statusCode)) wrong.push(`${key(r)} → ${res.statusCode} ${res.body.slice(0, 160)}`);
    }
    expect(wrong).toEqual([]);
  }, 120_000);
});
