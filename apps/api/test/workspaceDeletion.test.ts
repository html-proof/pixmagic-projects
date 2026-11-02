import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AAD, encryptAdTokens, encryptTokenFields, getAccessToken, seal, sealedKeyVersion, waEncrypt, type FetchLike } from "@app/core";
import { systemDb } from "@app/db";
import { queryAs } from "@app/db/testing";
import { sha256Hex } from "@app/shared";
import { EVOLUTION_ENV, evolutionFake, type EvolutionFake } from "../../../test-support/evolutionFake.js";
import { clean, createStore, createWorkspace, deletionCode, ORIGIN, setup, signIn, teardown, workspaceDeletionCode, type TestCtx } from "./helpers.js";

/**
 * Deleting a workspace (DELETE /workspaces/:ws, core workspaceDeletion.ts), and an account deleting
 * the workspaces it is the only owner of (POST /auth/account/delete): every row of the workspace
 * goes, read straight from Postgres on the owner's login (no row-level security in the way), the
 * access it was given elsewhere is taken back, and another business is left exactly as it was.
 */

let ctx: TestCtx;
let evo: EvolutionFake;
/** What was taken back at the providers: Meta ad tokens, Google email refresh tokens. */
let revoked: { meta: string[]; google: string[]; other: string[] };

beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));
beforeEach(async () => {
  await clean(ctx);
  evo = evolutionFake();
  revoked = { meta: [], google: [], other: [] };
  ctx.setEnv({ ...EVOLUTION_ENV, EMAIL_GOOGLE_CLIENT_ID: "g-email", EMAIL_GOOGLE_CLIENT_SECRET: "g-secret" });
  ctx.setFetch((async (input: Parameters<FetchLike>[0], init?: RequestInit) => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    if (u.host === new URL(EVOLUTION_ENV.EVOLUTION_API_URL).host) return evo.fetch(input as string, init);
    if (u.hostname === "graph.facebook.com" && u.pathname.endsWith("/me/permissions/ads_read") && init?.method === "DELETE") {
      revoked.meta.push(new Headers(init.headers).get("authorization")!.replace(/^Bearer /, ""));
      return json({ success: true });
    }
    if (u.hostname === "oauth2.googleapis.com" && u.pathname === "/revoke") {
      revoked.google.push(new URLSearchParams(String(init?.body ?? "")).get("token") ?? u.searchParams.get("token") ?? "");
      return json({});
    }
    revoked.other.push(`${init?.method ?? "GET"} ${u.host}${u.pathname}`);
    return json({ error: "unavailable in this test" }, 503);
  }) as FetchLike);
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const call = (method: string, url: string, headers: Record<string, string>, payload?: unknown) => ctx.app.inject({ method, url, headers: { ...ORIGIN, ...headers }, ...(payload === undefined ? {} : { payload }) });
const del = (ws: string, headers: Record<string, string>, code: string, confirm = "DELETE") => call("DELETE", `/workspaces/${ws}`, headers, { confirm, code });
/** A six-digit code that isn't `code`. */
const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

const ID = /^[A-Za-z0-9_-]+$/;
const owner = () => process.env.OWNER_DATABASE_URL!;

/** Every table with a workspace_id column, and every table with a store_id but no workspace_id. */
async function tables() {
  const rows = await queryAs<{ table_name: string; column_name: string }>(
    owner(),
    "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name IN ('workspace_id', 'store_id')",
  );
  const byTable = new Map<string, Set<string>>();
  for (const r of rows) byTable.set(r.table_name, (byTable.get(r.table_name) ?? new Set()).add(r.column_name));
  return {
    workspace: [...byTable].filter(([, c]) => c.has("workspace_id")).map(([t]) => t).sort(),
    storeOnly: [...byTable].filter(([, c]) => !c.has("workspace_id")).map(([t]) => t).sort(),
  };
}

/** How many rows each table holds for the workspace (and, for tables without a workspace_id, its stores), on the owner's login. */
async function rowsOf(ws: string, storeIds: string[]): Promise<Record<string, number>> {
  for (const id of [ws, ...storeIds]) expect(id).toMatch(ID);
  const { workspace, storeOnly } = await tables();
  const stores = storeIds.length ? storeIds.map((s) => `'${s}'`).join(", ") : "''";
  const parts = [
    ...workspace.map((t) => `SELECT '${t}' AS t, count(*)::int AS n FROM "${t}" WHERE workspace_id = '${ws}'`),
    ...storeOnly.map((t) => `SELECT '${t}' AS t, count(*)::int AS n FROM "${t}" WHERE store_id IN (${stores})`),
    `SELECT 'workspaces' AS t, count(*)::int AS n FROM workspaces WHERE id = '${ws}'`,
  ];
  const counts = await queryAs<{ t: string; n: number }>(owner(), parts.join(" UNION ALL "));
  return Object.fromEntries(counts.filter((c) => c.n > 0).map((c) => [c.t, c.n]));
}

/**
 * A business with something in every corner deleting it must reach: two stores (one connected,
 * one disconnected), a member and an invitation, synced data, what the merchant entered, a Meta ad
 * account, a WhatsApp number at Evolution API, a Google email account, Zapier, API keys, alerts,
 * an import job, Shopify's deliveries, a department, notification settings and audit records.
 */
async function business(tag: string) {
  const o = await signIn(ctx, `owner-${tag}`, `owner@${tag}.test`);
  const ws = await createWorkspace(ctx, o.headers, `Shop ${tag}`);
  const store = await createStore(ws, `${tag}.myshopify.com`, ["read_orders", "read_products"], { name: `Shop ${tag}` });
  await systemDb.store.update({
    where: { id: store.id },
    data: encryptTokenFields(store.id, { accessToken: `shpat_${tag}`, scopes: store.grantedScopes, accessTokenExpiresAt: null, refreshToken: null, refreshTokenExpiresAt: null }),
  });
  const old = await createStore(ws, `${tag}-old.myshopify.com`, ["read_orders"], { status: "uninstalled", uninstalledAt: new Date() });
  const member = await signIn(ctx, `member-${tag}`, `member@${tag}.test`);
  await systemDb.membership.create({ data: { workspaceId: ws, userId: member.user.id, role: "admin" } });
  await systemDb.invitation.create({ data: { workspaceId: ws, email: `invitee@${tag}.test`, role: "viewer", tokenHash: sha256Hex(`invitation-${tag}`), expiresAt: new Date(Date.now() + 86_400_000), invitedById: o.user.id } });
  await systemDb.notificationPreference.create({ data: { workspaceId: ws, userId: member.user.id } });

  const day = "2026-10-30";
  for (const s of [store, old]) {
    await systemDb.order.create({
      data: { workspaceId: ws, storeId: s.id, shopifyId: `${tag}-1`, name: "#1", currency: "USD", localDay: day, shopifyCreatedAt: new Date(`${day}T10:00:00Z`), shopifyUpdatedAt: new Date(`${day}T10:00:00Z`), subtotal: 10, totalDiscounts: 0, totalTax: 0, totalShipping: 0, totalPrice: 10 },
    });
    await systemDb.product.create({ data: { workspaceId: ws, storeId: s.id, shopifyId: "1", title: `Product ${tag}`, status: "active", vendor: tag, shopifyUpdatedAt: new Date() } });
    await systemDb.dailyStoreMetrics.create({ data: { workspaceId: ws, storeId: s.id, day, grossSales: 10, orders: 1 } });
    // What the merchant entered, which a Disconnect keeps.
    await systemDb.storeExpense.create({ data: { workspaceId: ws, storeId: s.id, name: "Rent", category: "rent", amount: 100, cadence: "monthly", startsOn: "2026-10-01" } });
    await systemDb.businessEvent.create({ data: { workspaceId: ws, storeId: s.id, kind: "other", title: "Sale", startsOn: day, endsOn: day } });
    await systemDb.syncJob.create({ data: { workspaceId: ws, storeId: s.id, kind: "orders" } });
    await systemDb.webhookEvent.create({ data: { webhookId: `wh-${tag}-${s.id}`, shopDomain: s.shopDomain, topic: "orders/create", storeId: s.id, workspaceId: ws } });
  }
  await systemDb.alert.create({ data: { workspaceId: ws, storeId: store.id, severity: "warning", code: "sync_failed", message: "x" } });

  // A Meta ad account powered by the owner's own Meta login (the person is Meta's 5550-tag).
  const metaPerson = `5550-${tag}`;
  await systemDb.adConnection.create({
    data: {
      workspaceId: ws, storeId: store.id, provider: "meta", accountId: `act_${tag}`, accountName: "Ads", currency: "USD", timezone: "UTC", connectedByUserId: o.user.id, externalUserId: metaPerson,
      ...encryptAdTokens(store.id, "meta", { accessToken: `META_${tag}`, refreshToken: null, expiresAt: new Date(Date.now() + 30 * 86_400_000) }),
    },
  });
  // A WhatsApp number linked through an Evolution API instance.
  await systemDb.wappConnection.create({ data: { workspaceId: ws, storeId: store.id, provider: "qr", shard: "a", status: "connected", instanceName: `bi-${tag}`, instanceTokenEnc: waEncrypt(store.id, "instance_token", `evo-${tag}`) } });
  // A Gmail account bizinsights sends from.
  const account = await systemDb.emailAccount.create({ data: { workspaceId: ws, provider: "google", connectionMethod: "oauth_google", emailAddress: `shop@${tag}.test`, status: "connected", connectedByUserId: o.user.id } });
  const refresh = seal(`GMAIL_${tag}`, AAD.oauthRefresh(account.id));
  await systemDb.emailOAuthCredential.create({ data: { workspaceId: ws, emailAccountId: account.id, refreshTokenEnc: refresh, encryptionKeyVersion: sealedKeyVersion(refresh) } });
  await systemDb.department.create({ data: { workspaceId: ws, name: "Warehouse" } });
  // Zapier, and the workspace's own API key and email-event key.
  const grant = await systemDb.zapierGrant.create({ data: { workspaceId: ws, storeId: store.id, userId: o.user.id, clientId: "zapier" } });
  await systemDb.zapierToken.create({ data: { workspaceId: ws, grantId: grant.id, kind: "access", tokenHash: sha256Hex(`zat-${tag}`), expiresAt: new Date(Date.now() + 3_600_000) } });
  await systemDb.zapierHook.create({ data: { workspaceId: ws, storeId: store.id, grantId: grant.id, event: "new_alert", targetUrl: `https://hooks.zapier.com/${tag}` } });
  const apiKey = `sk_live_${tag}_0123456789abcdef`;
  await systemDb.apiKey.create({ data: { workspaceId: ws, name: "BI", prefix: apiKey.slice(0, 14), keyHash: sha256Hex(apiKey), createdById: o.user.id } });
  await systemDb.emailIngestKey.create({ data: { workspaceId: ws, name: "Events", prefix: "eik_", keyHash: sha256Hex(`eik-${tag}`), createdByUserId: o.user.id } });

  return { owner: o, member, ws, store, old, storeIds: [store.id, old.id], apiKey, metaPerson };
}

describe("deleting a workspace", () => {
  it("erases every row of the workspace and its stores, takes back what it was given, and records it with no workspace", async () => {
    const a = await business("acme");
    const b = await business("other");
    const before = await rowsOf(a.ws, a.storeIds);
    // The seed reaches the corners this test is about.
    for (const t of ["stores", "orders", "products", "store_expenses", "business_events", "ad_connections", "wapp_connections", "email_accounts", "email_oauth_credentials", "zapier_grants", "zapier_tokens", "zapier_hooks", "api_keys", "email_ingest_keys", "memberships", "invitations", "notification_preferences", "sync_jobs", "webhook_events", "alerts", "subscriptions", "departments", "audit_logs"]) {
      expect(before[t], t).toBeGreaterThan(0);
    }
    const otherBefore = await rowsOf(b.ws, b.storeIds);

    const code = await workspaceDeletionCode(ctx, a.owner.headers, a.ws, "owner@acme.test");
    const mail = ctx.mailer.sent.at(-1)!;
    expect(mail).toMatchObject({ to: "owner@acme.test", from: "BizInsights Support <support@bizinsights.io>" });
    expect(mail.text).toContain('permanently delete the workspace "Shop acme"');
    const res = await del(a.ws, a.owner.headers, code);
    expect(res.statusCode, res.body).toBe(200);

    // Nothing of it is left but Shopify's deliveries, kept by their webhook id and no longer linked to a store.
    expect(await rowsOf(a.ws, a.storeIds)).toEqual({ webhook_events: 2 });
    expect(await systemDb.webhookEvent.count({ where: { storeId: { in: a.storeIds } } })).toBe(0);
    // The record outlives it: no workspace, who asked, which shops.
    const record = await systemDb.auditLog.findFirstOrThrow({ where: { action: "workspace.deleted" } });
    expect(record).toMatchObject({ workspaceId: null, actorUserId: a.owner.user.id, targetType: "workspace", targetId: a.ws });
    expect(record.metadata).toMatchObject({ via: "workspace", shops: ["acme.myshopify.com", "acme-old.myshopify.com"], members: 2, emailAccounts: 1 });

    // What it was given elsewhere: the WhatsApp instance, the Meta grant, the Gmail grant.
    expect(evo.calls.map((c) => `${c.method} ${c.path}`)).toContain("DELETE /instance/delete/bi-acme");
    expect(evo.calls.some((c) => c.path.endsWith("/bi-other"))).toBe(false);
    expect(revoked.meta).toEqual(["META_acme"]);
    expect(revoked.google).toEqual(["GMAIL_acme"]);

    // The people stay; their way in is gone.
    expect(await systemDb.user.count({ where: { id: { in: [a.owner.user.id, a.member.user.id] } } })).toBe(2);
    expect((await call("GET", "/me", a.owner.headers)).json().workspaces.map((w: { id: string }) => w.id)).toEqual([]);
    expect((await call("GET", `/workspaces/${a.ws}/stores`, a.member.headers)).statusCode).toBe(404);
    expect((await call("GET", `/workspaces/${a.ws}/stores`, { authorization: `Bearer ${a.apiKey}` })).statusCode).toBe(404);

    // The other business is exactly as it was, and still works.
    expect(await rowsOf(b.ws, b.storeIds)).toEqual(otherBefore);
    expect(await getAccessToken(await systemDb.store.findUniqueOrThrow({ where: { id: b.store.id } }), ctx.deps.coord)).toBe("shpat_other");
    expect((await call("GET", `/workspaces/${b.ws}/stores`, b.owner.headers)).json().stores.map((s: { id: string }) => s.id)).toContain(b.store.id);
    expect((await call("GET", `/workspaces/${b.ws}/stores`, { authorization: `Bearer ${b.apiKey}` })).statusCode).toBe(200);
    expect(revoked.other).toEqual([]);
  });

  it("shows its owner what goes before anything is sent", async () => {
    const a = await business("preview");
    const res = await call("GET", `/workspaces/${a.ws}/deletion`, a.owner.headers);
    expect(res.json()).toEqual({
      workspace: {
        id: a.ws,
        name: "Shop preview",
        stores: [
          { shopDomain: "preview.myshopify.com", name: "Shop preview" },
          { shopDomain: "preview-old.myshopify.com", name: null },
        ],
        members: 2,
        paidPlan: null,
      },
    });
  });

  it("takes the code emailed for this workspace, typed DELETE, and nothing else", async () => {
    const a = await business("codes");
    const second = await createWorkspace(ctx, a.owner.headers, "Second");
    expect((await del(a.ws, a.owner.headers, "123456")).json().error).toBe("code_required");

    // The account's own deletion code, or the code for another workspace, deletes nothing here.
    const accountCode = await deletionCode(ctx, a.owner.headers, "owner@codes.test");
    expect((await del(a.ws, a.owner.headers, accountCode)).json().error).toBe("code_required");
    const otherCode = await workspaceDeletionCode(ctx, a.owner.headers, second, "owner@codes.test");
    expect((await del(a.ws, a.owner.headers, otherCode)).json().error).toBe("code_required");

    const code = await workspaceDeletionCode(ctx, a.owner.headers, a.ws, "owner@codes.test");
    // Another one only after the minute.
    expect((await call("POST", `/workspaces/${a.ws}/delete/code`, a.owner.headers)).json().error).toBe("resend_cooldown");
    expect((await del(a.ws, a.owner.headers, code, "delete")).statusCode).toBe(400);
    expect((await del(a.ws, a.owner.headers, wrong(code))).json().error).toBe("invalid_code");
    // Another person's session can't use it: theirs is a code of their own.
    expect((await del(a.ws, a.member.headers, code)).statusCode).toBe(403);
    // The fifth wrong guess ends it.
    for (let i = 2; i < 5; i++) expect((await del(a.ws, a.owner.headers, wrong(code))).json().error).toBe("invalid_code");
    expect((await del(a.ws, a.owner.headers, wrong(code))).json().error).toBe("too_many_attempts");
    expect((await del(a.ws, a.owner.headers, code)).json().error).toBe("code_required");
    expect(await systemDb.workspace.count({ where: { id: { in: [a.ws, second] } } })).toBe(2);
  });

  it("is for its owners only: never an admin, a member given everything, an API key or another business", async () => {
    const a = await business("roles");
    const stranger = await signIn(ctx, "stranger", "stranger@else.test");
    await createWorkspace(ctx, stranger.headers, "Elsewhere");
    const custom = await signIn(ctx, "custom", "custom@roles.test");
    await systemDb.membership.create({ data: { workspaceId: a.ws, userId: custom.user.id, role: "custom", permissions: ["settings.manage", "team.manage", "billing.manage"] } });
    const sent = ctx.mailer.sent.length;
    for (const [who, headers, status] of [
      ["an admin", a.member.headers, 403],
      ["a custom role", custom.headers, 403],
      ["an API key", { authorization: `Bearer ${a.apiKey}` }, 403],
      ["another business's owner", stranger.headers, 404],
    ] as const) {
      expect((await call("GET", `/workspaces/${a.ws}/deletion`, headers)).statusCode, who).toBe(status);
      expect((await call("POST", `/workspaces/${a.ws}/delete/code`, headers)).statusCode, who).toBe(status);
      expect((await del(a.ws, headers, "123456")).statusCode, who).toBe(status);
    }
    expect(ctx.mailer.sent.length).toBe(sent);
    expect(await systemDb.workspace.count({ where: { id: a.ws } })).toBe(1);

    // Any of its owners may, with a code to their own address: everyone loses it.
    await systemDb.membership.updateMany({ where: { workspaceId: a.ws, userId: a.member.user.id }, data: { role: "owner" } });
    const code = await workspaceDeletionCode(ctx, a.member.headers, a.ws, "member@roles.test");
    expect((await del(a.ws, a.member.headers, code)).statusCode).toBe(200);
    expect(await systemDb.workspace.count({ where: { id: a.ws } })).toBe(0);
    expect((await call("GET", `/workspaces/${a.ws}/stores`, a.owner.headers)).statusCode).toBe(404);
  });

  it("waits while Shopify bills a paid plan for it, without spending the code", async () => {
    const a = await business("paid");
    await systemDb.subscription.update({ where: { workspaceId: a.ws }, data: { plan: "growth", shopifyChargeId: "gid://shopify/AppSubscription/1", billingStoreId: a.store.id } });
    const sent = ctx.mailer.sent.length;
    const refused = await call("POST", `/workspaces/${a.ws}/delete/code`, a.owner.headers);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: "paid_plan", message: expect.stringContaining("Switch it to Free") });
    expect(ctx.mailer.sent.length).toBe(sent);
    expect((await call("GET", `/workspaces/${a.ws}/deletion`, a.owner.headers)).json().workspace.paidPlan).toBe("growth");

    // A plan started after the code was sent: refused, and the code still stands once it's Free again.
    await systemDb.subscription.update({ where: { workspaceId: a.ws }, data: { plan: "free", shopifyChargeId: null } });
    const code = await workspaceDeletionCode(ctx, a.owner.headers, a.ws, "owner@paid.test");
    await systemDb.subscription.update({ where: { workspaceId: a.ws }, data: { plan: "growth", shopifyChargeId: "gid://shopify/AppSubscription/2" } });
    expect((await del(a.ws, a.owner.headers, code)).json().error).toBe("paid_plan");
    await systemDb.subscription.update({ where: { workspaceId: a.ws }, data: { plan: "free", shopifyChargeId: null } });
    expect((await del(a.ws, a.owner.headers, code)).statusCode).toBe(200);
    expect(await systemDb.workspace.count({ where: { id: a.ws } })).toBe(0);
  });
});

describe("deleting the account of a workspace's only owner", () => {
  it("lists the workspaces that go with it, and deletes them only once they are confirmed", async () => {
    const a = await business("solo");
    const b = await business("neighbour");
    const otherBefore = await rowsOf(b.ws, b.storeIds);
    // A workspace with another owner stays.
    const shared = await createWorkspace(ctx, b.owner.headers, "Shared");
    await systemDb.membership.create({ data: { workspaceId: shared, userId: a.owner.user.id, role: "owner" } });

    const preview = await call("GET", "/auth/account/deletion", a.owner.headers);
    expect(preview.json()).toEqual({ workspaces: [{ id: a.ws, name: "Shop solo", stores: ["Shop solo", "solo-old.myshopify.com"], members: 2, paidPlan: null }] });
    // The code is sent to a sole owner now: the dialog has shown what goes.
    const code = await deletionCode(ctx, a.owner.headers, "owner@solo.test");
    const post = (payload: Record<string, unknown>) => call("POST", "/auth/account/delete", a.owner.headers, payload);
    const unconfirmed = await post({ confirm: "DELETE", code });
    expect(unconfirmed.statusCode).toBe(409);
    expect(unconfirmed.json()).toMatchObject({ error: "sole_owner", workspaces: ["Shop solo"], owned: [{ id: a.ws, name: "Shop solo" }] });
    // Naming another workspace doesn't count, and deletes nothing.
    expect((await post({ confirm: "DELETE", code, workspaces: [b.ws] })).json().error).toBe("sole_owner");
    expect(await systemDb.workspace.count({ where: { id: { in: [a.ws, b.ws] } } })).toBe(2);

    const res = await post({ confirm: "DELETE", code, workspaces: [a.ws] });
    expect(res.statusCode, res.body).toBe(200);
    expect(await systemDb.user.findUnique({ where: { id: a.owner.user.id } })).toBeNull();
    expect(await rowsOf(a.ws, a.storeIds)).toEqual({ webhook_events: 2 });
    expect(await systemDb.auditLog.findFirstOrThrow({ where: { action: "workspace.deleted", targetId: a.ws } })).toMatchObject({ workspaceId: null, metadata: expect.objectContaining({ via: "account" }) });
    expect(revoked.meta).toEqual(["META_solo"]);
    // The shared workspace keeps running without them, and the other business is untouched.
    expect((await systemDb.membership.findMany({ where: { workspaceId: shared } })).map((m) => m.userId)).toEqual([b.owner.user.id]);
    expect(await rowsOf(b.ws, b.storeIds)).toEqual(otherBefore);
    expect(await systemDb.authEvent.findFirst({ where: { type: "account_deleted" } })).toMatchObject({ userId: null, metadata: expect.objectContaining({ workspaces: 1 }) });
  });

  it("sends no code while a workspace that would go with it is on a paid plan", async () => {
    const a = await business("solopaid");
    await systemDb.subscription.update({ where: { workspaceId: a.ws }, data: { plan: "scale", shopifyChargeId: "gid://shopify/AppSubscription/3" } });
    expect((await call("GET", "/auth/account/deletion", a.owner.headers)).json().workspaces[0].paidPlan).toBe("scale");
    const sent = ctx.mailer.sent.length;
    const res = await call("POST", "/auth/account/delete/code", a.owner.headers);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("paid_plan");
    expect(ctx.mailer.sent.length).toBe(sent);
  });
});
