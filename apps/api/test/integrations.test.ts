import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { encryptTokenFields, type FetchLike } from "@app/core";
import { systemDb } from "@app/db";
import { sha256Hex } from "@app/shared";
import { clean, cookiesFrom, createStore, createWorkspace, ORIGIN, setup, signIn, teardown, type TestCtx } from "./helpers.js";
import { dohResponse, fakeSmtp, isDoh } from "../../../test-support/emailFakes.js";

/**
 * GET /workspaces/:ws/stores/:storeId/integrations (routes/integrations.ts, core's
 * integrations/status.ts): every connection of a store on one scale of six statuses. Each
 * provider's own states on that scale (Shopify, the three ad platforms with a waiting sign-in and
 * the Google Ads demo, WhatsApp, SMS, email), what each caller is offered to do (by their
 * permissions; a shared link and an API key only look), tenancy, and that nothing secret is in
 * the answer. Real Postgres; nothing calls a provider.
 */

let ctx: TestCtx;
/** Every outbound call the app made: the answer is read from the database alone. */
const outbound: string[] = [];

/** Every setting a test may switch on, off again. */
const OFF = {
  META_APP_ID: "",
  META_APP_SECRET: "",
  GOOGLE_ADS_CLIENT_ID: "",
  GOOGLE_ADS_CLIENT_SECRET: "",
  GOOGLE_ADS_ENABLED: "",
  GOOGLE_ADS_DEMO_ENABLED: "",
  WHATSAPP_APP_ID: "",
  WHATSAPP_APP_SECRET: "",
  WHATSAPP_CONFIG_ID: "",
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: "",
  SMS_MODE: "off",
};
const ADS = { META_APP_ID: "meta_app", META_APP_SECRET: "meta_secret", GOOGLE_ADS_CLIENT_ID: "g_client", GOOGLE_ADS_CLIENT_SECRET: "g_secret", GOOGLE_ADS_ENABLED: "1" };
const WHATSAPP = { META_APP_ID: "meta_app", META_APP_SECRET: "meta_secret", WHATSAPP_CONFIG_ID: "wa_config", WHATSAPP_WEBHOOK_VERIFY_TOKEN: "wa_verify" };

beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => {
  ctx.setEnv(OFF);
  await teardown(ctx);
});
beforeEach(async () => {
  await clean(ctx);
  ctx.setEnv(OFF);
  outbound.length = 0;
  ctx.deps.smtpConnect = undefined;
  ctx.setFetch((async (input: Parameters<FetchLike>[0]) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    // Connecting a mailbox over SMTP looks its server up first (the test's own setup, not the answer).
    if (isDoh(url)) return dohResponse(url, { "smtp.shopmail.com|A": ["93.184.216.34"] });
    outbound.push(url.toString());
    return new Response(JSON.stringify({ error: "unavailable in this test" }), { status: 503, headers: { "content-type": "application/json" } });
  }) as FetchLike);
});

/** A business: its owner, its workspace and a Shopify store holding a token, synced an hour ago. */
async function business(uid = "owner", email = "owner@shop.test") {
  const owner = await signIn(ctx, uid, email);
  const ws = await createWorkspace(ctx, owner.headers);
  const created = await createStore(ws, `${uid}.myshopify.com`, ["read_orders", "read_products"], { name: "Green Leaf", lastSyncedAt: new Date(Date.now() - 3600_000) });
  const store = await systemDb.store.update({
    where: { id: created.id },
    data: encryptTokenFields(created.id, { accessToken: "shpat_SHOPIFY_SECRET", scopes: created.grantedScopes, accessTokenExpiresAt: null, refreshToken: null, refreshTokenExpiresAt: null }),
  });
  return { owner, ws, store };
}
type Business = Awaited<ReturnType<typeof business>>;

interface Account {
  id: string;
  name: string | null;
  status: string;
  lastSyncedAt: string | null;
  lastAttemptAt: string | null;
  code: string | null;
  demo: boolean;
}
interface Module {
  id: string;
  title: string;
  status: string;
  code: string | null;
  demo: boolean;
  accounts: Account[];
  lastSyncedAt: string | null;
  capabilities: string[];
  actions: string[];
  href: string;
}

const url = (b: Business, storeId = b.store.id) => `/workspaces/${b.ws}/stores/${storeId}/integrations`;
const get = (b: Business, headers: Record<string, string> = b.owner.headers, storeId?: string) => ctx.app.inject({ method: "GET", url: url(b, storeId), headers });

/** The answer, each module by its id, and the body as sent. */
async function status(b: Business, headers?: Record<string, string>) {
  const res = await get(b, headers);
  expect(res.statusCode, res.body).toBe(200);
  const modules = res.json().modules as Module[];
  return { ids: modules.map((m) => m.id), of: (id: string) => modules.find((m) => m.id === id)!, body: res.body, modules };
}

/** A member of the workspace with exactly these Team & Access permissions. */
async function member(b: Business, uid: string, permissions: string[]) {
  const m = await signIn(ctx, uid, `${uid}@agency.test`);
  await systemDb.membership.create({ data: { workspaceId: b.ws, userId: m.user.id, role: "custom", permissions } });
  return m.headers;
}

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

/** An ad connection on the store, holding (made-up) tokens unless it is the demo. */
const adConnection = (b: Business, provider: string, accountId: string, over: Record<string, unknown> = {}) =>
  systemDb.adConnection.create({
    data: {
      workspaceId: b.ws,
      storeId: b.store.id,
      provider,
      accountId,
      accountName: `Account ${accountId}`,
      currency: "USD",
      accessTokenEnc: `ACCESS-SECRET-${accountId}`,
      refreshTokenEnc: `REFRESH-SECRET-${accountId}`,
      tokenKeyVersion: 1,
      createdAt: minutesAgo(3 * 24 * 60),
      lastSyncedAt: minutesAgo(60),
      lastSyncAttemptAt: minutesAgo(60),
      ...over,
    },
  });

describe("every module, in one answer", () => {
  it("lists every provider in order, with its page and the figures it brings, and calls no provider", async () => {
    const b = await business();
    const s = await status(b);
    expect(s.ids).toEqual(["shopify", "meta_ads", "google_ads", "adsense", "whatsapp", "sms", "email"]);
    for (const m of s.modules) {
      expect(m.capabilities.length, m.id).toBeGreaterThan(0);
      expect(m.href, m.id).toMatch(/^\//);
    }
    expect(s.of("shopify")).toMatchObject({ title: "Shopify", href: "/settings/stores", status: "connected", code: null });
    expect(s.of("meta_ads")).toMatchObject({ title: "Meta Ads", href: "/settings/ads" });
    expect(s.of("meta_ads").capabilities).toEqual(expect.arrayContaining(["spend", "reach", "purchases", "purchaseValue"]));
    expect(s.of("google_ads").capabilities).toEqual(expect.arrayContaining(["spend", "clicks", "conversions", "roas"]));
    expect(s.of("adsense").capabilities).toEqual(expect.arrayContaining(["earnings", "pageViews"]));
    expect(s.of("whatsapp")).toMatchObject({ href: "/dashboard/whatsapp-automation", capabilities: ["sent", "delivered", "read", "failed"] });
    expect(s.of("sms").href).toBe("/messaging");
    expect(s.of("email").href).toBe("/settings/email");
    expect(outbound).toEqual([]);
  });

  it("says a provider this server doesn't offer is disconnected and not set up, with nothing to press", async () => {
    const b = await business();
    const s = await status(b);
    for (const id of ["meta_ads", "google_ads", "adsense", "whatsapp", "sms"]) {
      expect(s.of(id), id).toMatchObject({ status: "disconnected", code: "not_configured", accounts: [], actions: [] });
    }
    // Email needs nothing of the server's: a mailbox can always be connected.
    expect(s.of("email")).toMatchObject({ status: "disconnected", code: null, accounts: [], actions: ["connect"] });
    // Google Ads offering only its demo: not "not set up", and still no sign-in to press.
    ctx.setEnv({ GOOGLE_ADS_DEMO_ENABLED: "1" });
    expect((await status(b)).of("google_ads")).toMatchObject({ status: "disconnected", code: null, actions: [] });
  });
});

describe("Shopify", () => {
  it("connected, importing, waiting for its first import, lost access (reconnect), and Shopify's own refusals (not fixed by reconnecting)", async () => {
    const b = await business();
    const shopify = async () => (await status(b)).of("shopify");
    const startedAt = minutesAgo(5);
    await systemDb.syncJob.create({ data: { workspaceId: b.ws, storeId: b.store.id, kind: "orders", status: "succeeded", startedAt, finishedAt: new Date() } });
    expect(await shopify()).toMatchObject({
      status: "connected",
      accounts: [{ id: b.store.id, name: "Green Leaf", status: "connected", lastAttemptAt: startedAt.toISOString(), code: null, demo: false }],
      actions: ["refresh", "disconnect"],
    });
    expect((await shopify()).lastSyncedAt).toBe(b.store.lastSyncedAt!.toISOString());

    await systemDb.store.update({ where: { id: b.store.id }, data: { status: "syncing" } });
    expect(await shopify()).toMatchObject({ status: "syncing", actions: ["disconnect"] });
    await systemDb.store.update({ where: { id: b.store.id }, data: { status: "pending" } });
    expect((await shopify()).status).toBe("pending");

    await systemDb.store.update({ where: { id: b.store.id }, data: { status: "error" } });
    await systemDb.syncJob.create({ data: { workspaceId: b.ws, storeId: b.store.id, kind: "orders", status: "failed", error: "Shopify rejected our access to owner.myshopify.com (403); merchant must reconnect" } });
    expect(await shopify()).toMatchObject({ status: "reauthorization_required", code: "access", actions: ["reconnect", "refresh", "disconnect"] });

    await systemDb.syncJob.create({ data: { workspaceId: b.ws, storeId: b.store.id, kind: "orders", status: "failed", error: "Shopify 402: Unavailable Shop", createdAt: new Date(Date.now() + 1000) } });
    expect(await shopify()).toMatchObject({ status: "error", code: "shop_unavailable", actions: ["refresh", "disconnect"] });
  });
});

describe("Meta Ads, Google Ads and AdSense", () => {
  it("shows the worst of the accounts on the dashboard, each account's own state and code, and the demo as the demo", async () => {
    ctx.setEnv({ ...ADS, GOOGLE_ADS_DEMO_ENABLED: "1" });
    const b = await business();
    const working = await adConnection(b, "meta", "act_1", { lastSyncedAt: minutesAgo(30) });
    const expired = await adConnection(b, "meta", "act_2", { status: "reconnect", errorCode: "auth_expired" });
    // Hidden from the dashboard: it can't make the card worse, nor say when the dashboard's numbers last came in.
    await adConnection(b, "meta", "act_3", { status: "error", errorCode: "provider_error", enabled: false, lastSyncedAt: minutesAgo(5) });
    const demo = await adConnection(b, "google", "123-456-7890", { isDemo: true, demoSeed: 42, accessTokenEnc: "", refreshTokenEnc: null });
    const notReady = await adConnection(b, "adsense", "pub-77", { status: "unavailable", errorCode: "account_not_ready", accountStatus: "setup_unfinished" });

    let s = await status(b);
    expect(s.of("meta_ads")).toMatchObject({ status: "reauthorization_required", code: "auth_expired", demo: false, actions: ["connect", "reconnect", "refresh", "disconnect"] });
    expect(s.of("meta_ads").accounts).toEqual([
      { id: working.id, name: "Account act_1", status: "connected", lastSyncedAt: working.lastSyncedAt!.toISOString(), lastAttemptAt: working.lastSyncAttemptAt!.toISOString(), code: null, demo: false },
      expect.objectContaining({ id: expired.id, status: "reauthorization_required", code: "auth_expired" }),
      expect.objectContaining({ status: "error", code: "provider_error" }),
    ]);
    expect(s.of("meta_ads").lastSyncedAt).toBe(working.lastSyncedAt!.toISOString());
    expect(s.of("google_ads")).toMatchObject({ status: "connected", code: null, demo: true, accounts: [expect.objectContaining({ id: demo.id, status: "connected", demo: true })], actions: ["connect", "refresh", "disconnect"] });
    expect(s.of("adsense")).toMatchObject({ status: "pending", code: "account_not_ready", accounts: [expect.objectContaining({ id: notReady.id, status: "pending", code: "account_not_ready" })] });

    // The expired one connected again and syncing; AdSense's account ready and a sync asked for.
    await systemDb.adConnection.update({ where: { id: expired.id }, data: { status: "active", errorCode: null } });
    await systemDb.adConnection.update({ where: { id: notReady.id }, data: { status: "active", errorCode: null, accountStatus: "active", syncRequestedAt: new Date() } });
    s = await status(b);
    expect(s.of("meta_ads")).toMatchObject({ status: "connected", code: null, actions: ["connect", "refresh", "disconnect"] });
    expect(s.of("adsense")).toMatchObject({ status: "syncing", accounts: [expect.objectContaining({ status: "syncing", code: null })] });

    // A first sync that never landed, 30 minutes on: failed. The platform disabling an account: an error, said by its status.
    await systemDb.adConnection.update({ where: { id: notReady.id }, data: { syncRequestedAt: null, lastSyncedAt: null } });
    await systemDb.adConnection.update({ where: { id: working.id }, data: { accountStatus: "disabled" } });
    s = await status(b);
    expect(s.of("adsense").status).toBe("error");
    expect(s.of("meta_ads")).toMatchObject({ status: "error", code: "disabled" });
    expect(outbound).toEqual([]);
  });

  it("counts a sign-in waiting for its ad accounts as connected, as its card does, with the reason nothing is read yet", async () => {
    ctx.setEnv(ADS);
    const b = await business();
    const login = await systemDb.adLogin.create({
      data: { workspaceId: b.ws, storeId: b.store.id, provider: "meta", accessTokenEnc: "LOGIN-SECRET", tokenKeyVersion: 1, loginName: "Pat Doe", reason: "no_ads_account", checkedAt: minutesAgo(20) },
    });
    const meta = (await status(b)).of("meta_ads");
    expect(meta).toMatchObject({
      status: "connected",
      code: null,
      accounts: [{ id: login.id, name: "Pat Doe", status: "connected", lastSyncedAt: null, lastAttemptAt: login.checkedAt.toISOString(), code: "no_ads_account", demo: false }],
      // "Check for ad accounts" and Disconnect act on the sign-in.
      actions: ["connect", "refresh", "disconnect"],
    });
  });

  it("offers no sign-in on a platform this server can't connect any more: the accounts connected before can only be disconnected", async () => {
    const b = await business();
    await adConnection(b, "meta", "act_1", { status: "reconnect", errorCode: "auth_expired" });
    expect((await status(b)).of("meta_ads")).toMatchObject({ status: "reauthorization_required", code: "auth_expired", actions: ["disconnect"] });
  });
});

describe("WhatsApp", () => {
  const waRow = (b: Business, over: Record<string, unknown> = {}) =>
    systemDb.wappConnection.create({
      data: {
        workspaceId: b.ws,
        storeId: b.store.id,
        provider: "cloud_api",
        shard: "meta",
        status: "connected",
        instanceTokenEnc: "WA-ACCESS-TOKEN-SECRET",
        phoneEnc: "+61400111222",
        phoneMasked: "+61 ••• ••• 222",
        profileName: "Green Leaf",
        wabaId: "waba-1",
        phoneNumberId: "pn-1",
        connectedAt: minutesAgo(60),
        lastCheckedAt: minutesAgo(10),
        ...over,
      },
    });

  it("connected, needing a new sign-in, and a phone once linked with a QR code (retired), each with what may be done", async () => {
    ctx.setEnv(WHATSAPP);
    const b = await business();
    expect((await status(b)).of("whatsapp")).toMatchObject({ status: "disconnected", code: null, accounts: [], actions: ["connect"] });

    const row = await waRow(b);
    expect((await status(b)).of("whatsapp")).toMatchObject({
      status: "connected",
      accounts: [{ id: row.id, name: "Green Leaf", status: "connected", lastSyncedAt: null, lastAttemptAt: row.lastCheckedAt!.toISOString(), code: null, demo: false }],
      actions: ["refresh", "disconnect"],
    });
    await systemDb.wappConnection.update({ where: { id: row.id }, data: { status: "logged_out", statusReason: "token_expired", profileName: null } });
    expect((await status(b)).of("whatsapp")).toMatchObject({
      status: "reauthorization_required",
      code: "token_expired",
      accounts: [expect.objectContaining({ name: "+61 ••• ••• 222", code: "token_expired" })],
      actions: ["reconnect", "refresh", "disconnect"],
    });

    await systemDb.wappConnection.delete({ where: { id: row.id } });
    await waRow(b, { provider: "qr", shard: "a", instanceName: "bi_qr_instance", phoneNumberId: null });
    expect((await status(b)).of("whatsapp")).toMatchObject({ status: "disconnected", code: "qr_linking_retired", accounts: [], actions: ["connect"] });
  });
});

describe("SMS", () => {
  it("not offered, not connected, connected with its setup left, sending, and a failed check at AWS", async () => {
    const b = await business();
    expect((await status(b)).of("sms")).toMatchObject({ status: "disconnected", code: "not_configured", actions: [] });

    ctx.setEnv({ SMS_MODE: "sandbox" });
    expect((await status(b)).of("sms")).toMatchObject({ status: "disconnected", code: null, actions: ["connect"] });

    const setupRow = await systemDb.smsSetup.create({ data: { workspaceId: b.ws, storeId: b.store.id, connection: "connected", connectionCheckedAt: minutesAgo(3) } });
    expect((await status(b)).of("sms")).toMatchObject({ status: "pending", code: "no_sender", accounts: [], actions: ["refresh", "disconnect"] });

    // A verified number, as AWS labels it (the whole number): shown masked.
    await systemDb.smsSenderConfiguration.create({
      data: {
        workspaceId: b.ws,
        storeId: b.store.id,
        senderType: "phone_number",
        originationIdentity: "arn:aws:sms-voice:ap-southeast-2:111122223333:phone-number/phone-abc",
        identityLabel: "+61400999888",
        identityCheck: "verified",
        awsRegion: "ap-southeast-2",
        countries: ["AU"],
        sendingEnabled: true,
        monthlyBudgetUsd: 25,
        transactionalBasis: "checkout_notice",
      },
    });
    const sms = (await status(b)).of("sms");
    expect(sms).toMatchObject({ status: "connected", code: null, actions: ["refresh", "disconnect"] });
    expect(sms.accounts).toEqual([{ id: b.store.id, name: expect.stringMatching(/^\+61 •+ 888$/), status: "connected", lastSyncedAt: null, lastAttemptAt: setupRow.connectionCheckedAt!.toISOString(), code: null, demo: false }]);

    await systemDb.smsSetup.update({ where: { id: setupRow.id }, data: { connection: "failed", connectionError: "aws_unreachable" } });
    expect((await status(b)).of("sms")).toMatchObject({ status: "error", code: "connection_failed", actions: ["reconnect"] });
  });
});

describe("email", () => {
  it("a mailbox that sends, one that needs signing in again, and one switched off", async () => {
    const b = await business();
    const smtp = fakeSmtp();
    ctx.deps.smtpConnect = smtp.connect;
    const res = await ctx.app.inject({
      method: "POST",
      url: `/workspaces/${b.ws}/email/smtp/connections`,
      headers: b.owner.headers,
      payload: { emailAddress: "billing@shopmail.com", displayName: "Billing", host: "smtp.shopmail.com", port: 587, encryption: "starttls", username: "billing@shopmail.com", password: "right-password" },
    });
    expect(res.statusCode, res.body).toBe(200);
    const account = await systemDb.emailAccount.findFirstOrThrow({ where: { workspaceId: b.ws } });
    // Not verified as a sender yet: a step left.
    await systemDb.emailSenderIdentity.updateMany({ where: { workspaceId: b.ws }, data: { authorizationStatus: "pending" } });
    expect((await status(b)).of("email")).toMatchObject({ status: "pending", code: "no_verified_sender" });

    await systemDb.emailSenderIdentity.updateMany({ where: { workspaceId: b.ws }, data: { authorizationStatus: "verified", verifiedAt: new Date(), isDefault: true } });
    let email = (await status(b)).of("email");
    expect(email).toMatchObject({ status: "connected", code: null, actions: ["connect", "refresh", "disconnect"] });
    expect(email.accounts).toEqual([{ id: account.id, name: "billing@shopmail.com", status: "connected", lastSyncedAt: null, lastAttemptAt: account.lastVerifiedAt?.toISOString() ?? null, code: null, demo: false }]);

    await systemDb.emailAccount.update({ where: { id: account.id }, data: { status: "reauthorization_required", statusReason: "auth_failed" } });
    email = (await status(b)).of("email");
    expect(email).toMatchObject({ status: "reauthorization_required", code: "auth_failed", actions: ["connect", "reconnect", "refresh", "disconnect"] });

    await systemDb.emailAccount.update({ where: { id: account.id }, data: { status: "disabled", statusReason: null } });
    expect((await status(b)).of("email")).toMatchObject({ status: "disconnected", accounts: [expect.objectContaining({ status: "disconnected", code: "disabled" })] });
  });
});

describe("who sees what, and who may do what", () => {
  /** Everything connected that can be, so every action that exists is on offer to someone. */
  async function connectedBusiness() {
    ctx.setEnv({ ...ADS, ...WHATSAPP, SMS_MODE: "sandbox" });
    const b = await business();
    await adConnection(b, "meta", "act_1");
    await adConnection(b, "google", "1234567890");
    await adConnection(b, "adsense", "pub-77");
    await systemDb.wappConnection.create({ data: { workspaceId: b.ws, storeId: b.store.id, provider: "cloud_api", shard: "meta", status: "connected", instanceTokenEnc: "WA-SECRET", phoneMasked: "+61 ••• ••• 222", profileName: "Green Leaf" } });
    await systemDb.smsSetup.create({ data: { workspaceId: b.ws, storeId: b.store.id, connection: "connected" } });
    return b;
  }
  const actionsOf = (s: Awaited<ReturnType<typeof status>>) => Object.fromEntries(s.modules.map((m) => [m.id, m.actions]));
  const statusesOf = (s: Awaited<ReturnType<typeof status>>) => Object.fromEntries(s.modules.map((m) => [m.id, m.status]));

  it("the owner may do everything on offer; someone who may only view connection status sees the same statuses and may do nothing", async () => {
    const b = await connectedBusiness();
    const owner = await status(b);
    expect(actionsOf(owner)).toEqual({
      shopify: ["refresh", "disconnect"],
      meta_ads: ["connect", "refresh", "disconnect"],
      google_ads: ["connect", "refresh", "disconnect"],
      adsense: ["connect", "refresh", "disconnect"],
      whatsapp: ["refresh", "disconnect"],
      sms: ["refresh", "disconnect"],
      email: ["connect"],
    });
    const viewer = await status(b, await member(b, "viewer", ["integrations.status"]));
    expect(statusesOf(viewer)).toEqual(statusesOf(owner));
    expect(viewer.modules.every((m) => m.actions.length === 0)).toBe(true);
  });

  it("Manage integrations offers the ad platforms, WhatsApp and email, never the store itself or SMS (owners and admins)", async () => {
    const b = await connectedBusiness();
    const s = await status(b, await member(b, "manager", ["integrations.status", "integrations.manage"]));
    expect(actionsOf(s)).toEqual({
      shopify: [],
      meta_ads: ["connect", "refresh", "disconnect"],
      google_ads: ["connect", "refresh", "disconnect"],
      adsense: ["connect", "refresh", "disconnect"],
      // "Check now" on WhatsApp belongs to its page (View campaigns).
      whatsapp: ["disconnect"],
      sms: [],
      email: ["connect"],
    });
  });

  it("refuses a member without View integration connection status", async () => {
    const b = await connectedBusiness();
    const res = await get(b, await member(b, "marketer", ["marketing.ads", "marketing.campaigns"]));
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("forbidden");
  });

  it("a shared dashboard link, even an admin's, and a workspace API key only look", async () => {
    const b = await connectedBusiness();
    const owner = await status(b);
    const invited = await ctx.app.inject({ method: "POST", url: `/workspaces/${b.ws}/team/invitations`, headers: b.owner.headers, payload: { email: "partner@agency.test", role: "admin", permissions: [] } });
    expect(invited.statusCode, invited.body).toBe(200);
    const mail = [...ctx.mailer.sent].reverse().find((m) => m.to === "partner@agency.test")!;
    const token = /#token=([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;
    const opened = await ctx.app.inject({ method: "POST", url: "/invitations/open", headers: ORIGIN, payload: { token } });
    expect(opened.statusCode, opened.body).toBe(200);
    const link = await status(b, { cookie: cookiesFrom(opened), "x-bi-context": "shared" });
    expect(statusesOf(link)).toEqual(statusesOf(owner));
    expect(link.modules.every((m) => m.actions.length === 0)).toBe(true);

    const secret = `sk_${randomBytes(24).toString("hex")}`;
    await systemDb.apiKey.create({ data: { workspaceId: b.ws, name: "test", prefix: secret.slice(0, 8), keyHash: sha256Hex(secret), createdById: b.owner.user.id } });
    const key = await status(b, { authorization: `Bearer ${secret}` });
    expect(statusesOf(key)).toEqual(statusesOf(owner));
    expect(key.modules.every((m) => m.actions.length === 0)).toBe(true);
  });

  it("another business's store is not found, whoever asks, and so is a disconnected or made-up one", async () => {
    const a = await connectedBusiness();
    const other = await business("other", "owner@other.test");
    // The other business's owner asking for A's store, and A's owner naming B's store under A's workspace.
    expect((await get(a, other.owner.headers)).statusCode).toBe(404);
    expect((await get(a, a.owner.headers, other.store.id)).statusCode).toBe(404);
    expect((await get(a, a.owner.headers, "c0000000000000000000000")).statusCode).toBe(404);
    await systemDb.store.update({ where: { id: a.store.id }, data: { status: "uninstalled" } });
    expect((await get(a)).statusCode).toBe(404);
    expect(outbound).toEqual([]);
  });
});

describe("nothing secret in the answer", () => {
  it("no token, no full phone number, no password: only the names each page shows", async () => {
    ctx.setEnv({ ...ADS, ...WHATSAPP, SMS_MODE: "sandbox" });
    const b = await business();
    await adConnection(b, "google", "1234567890");
    await systemDb.adLogin.create({ data: { workspaceId: b.ws, storeId: b.store.id, provider: "meta", accessTokenEnc: "LOGIN-SECRET", tokenKeyVersion: 1, loginName: "Pat Doe", reason: "unanswered" } });
    await systemDb.wappConnection.create({
      data: { workspaceId: b.ws, storeId: b.store.id, provider: "cloud_api", shard: "meta", status: "connected", instanceTokenEnc: "WA-ACCESS-TOKEN-SECRET", webhookKeyEnc: "WA-WEBHOOK-SECRET", phoneEnc: "+61400111222", phoneMasked: "+61 ••• ••• 222" },
    });
    await systemDb.smsSetup.create({ data: { workspaceId: b.ws, storeId: b.store.id, connection: "connected" } });
    await systemDb.smsSenderConfiguration.create({
      data: { workspaceId: b.ws, storeId: b.store.id, senderType: "phone_number", originationIdentity: "+61400999888", identityCheck: "unchecked", awsRegion: "ap-southeast-2" },
    });
    ctx.deps.smtpConnect = fakeSmtp().connect;
    const smtp = await ctx.app.inject({
      method: "POST",
      url: `/workspaces/${b.ws}/email/smtp/connections`,
      headers: b.owner.headers,
      payload: { emailAddress: "billing@shopmail.com", host: "smtp.shopmail.com", port: 587, encryption: "starttls", username: "billing@shopmail.com", password: "right-password" },
    });
    expect(smtp.statusCode, smtp.body).toBe(200);

    const s = await status(b);
    const store = await systemDb.store.findUniqueOrThrow({ where: { id: b.store.id } });
    const credential = await systemDb.emailSmtpCredential.findFirstOrThrow({ where: { workspaceId: b.ws } });
    for (const secret of ["shpat_SHOPIFY_SECRET", store.accessTokenEnc!, "ACCESS-SECRET", "REFRESH-SECRET", "LOGIN-SECRET", "WA-ACCESS-TOKEN-SECRET", "WA-WEBHOOK-SECRET", "61400111222", "61400999888", "right-password", credential.secretEnc]) {
      expect(s.body, secret).not.toContain(secret);
    }
    expect(s.body).not.toMatch(/token|secret|password/i);
    // What is shown instead: the masked numbers, the sign-in's and the mailbox's names.
    expect(s.of("whatsapp").accounts[0]!.name).toBe("+61 ••• ••• 222");
    expect(s.of("sms").accounts[0]!.name).toMatch(/^\+61 •+ 888$/);
    expect(s.of("meta_ads").accounts[0]!.name).toBe("Pat Doe");
    expect(s.of("email").accounts[0]!.name).toBe("billing@shopmail.com");
  });
});
