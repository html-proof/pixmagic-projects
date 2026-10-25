import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb } from "@app/db";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";
import { LEGACY_GRANTS } from "@app/shared";

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));
beforeEach(async () => clean(ctx));

const LEAK = "connect ECONNREFUSED 10.0.3.7:5432 (prisma P1001)";
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);

async function seed() {
  const owner = await signIn(ctx, "owner", "owner@acme.test");
  const ws = await createWorkspace(ctx, owner.headers);
  const store = await createStore(ws, "acme.myshopify.com", ["read_orders"], { name: "Acme Store" });
  const gone = await createStore(ws, "gone.myshopify.com", ["read_orders"], { status: "uninstalled" });
  const alert = (data: { storeId?: string; severity: string; code: string; message: string; createdAt: Date; resolvedAt?: Date }) =>
    systemDb.alert.create({ data: { workspaceId: ws, storeId: null, ...data } });
  await alert({ storeId: store.id, severity: "critical", code: "sync_orders_failed", message: `We couldn't sync orders for acme.myshopify.com: ${LEAK}`, createdAt: ago(5) });
  await alert({ storeId: store.id, severity: "warning", code: "webhook_failed", message: `Processing orders/create failed: ${LEAK}`, createdAt: ago(60) });
  await alert({ severity: "warning", code: "email_account_reauth:acc1", message: "The email account shop@acme.test must be reconnected before it can send again (Settings → Email → Accounts).", createdAt: ago(30) });
  await alert({ severity: "warning", code: "staff_open_shifts", message: "2 shifts have been open longer than expected.", createdAt: ago(90) });
  await alert({ storeId: store.id, severity: "warning", code: "whatsapp_logged_out", message: `WhatsApp logged out the linked phone (${LEAK})`, createdAt: ago(10) });
  await alert({ storeId: store.id, severity: "warning", code: "privacy_request", message: "A customer of acme.myshopify.com asked for their data.", createdAt: ago(120) });
  // Not listed: an old note, a resolved problem, and a problem of a store that has been uninstalled.
  await alert({ storeId: store.id, severity: "info", code: "inventory_stock", message: "Old note", createdAt: ago(8 * 24 * 60) });
  await alert({ storeId: store.id, severity: "critical", code: "sync_products_failed", message: LEAK, createdAt: ago(2), resolvedAt: ago(1) });
  await alert({ storeId: gone.id, severity: "critical", code: "sync_shop_failed", message: LEAK, createdAt: ago(3) });
  return { owner, ws, store };
}

describe("GET /workspaces/:ws/alerts", () => {
  it("words each open alert for the merchant, newest first, without the stored message", async () => {
    const { owner, ws, store } = await seed();
    const res = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/alerts`, headers: owner.headers });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("ECONNREFUSED");
    expect(res.body).not.toContain("orders/create");

    const { alerts } = res.json();
    const acme = { id: store.id, name: "Acme Store" };
    expect(alerts).toEqual([
      { id: expect.any(String), severity: "critical", area: "shopify", title: "Couldn't sync your orders", body: expect.stringContaining("Settings → Shopify"), store: acme, createdAt: expect.any(String) },
      { id: expect.any(String), severity: "warning", area: "whatsapp", title: "Link WhatsApp again", body: expect.stringContaining("link it again"), store: acme, createdAt: expect.any(String) },
      { id: expect.any(String), severity: "warning", area: "email", title: "An email account needs reconnecting", body: expect.stringContaining("shop@acme.test"), store: null, createdAt: expect.any(String) },
      { id: expect.any(String), severity: "warning", area: "shopify", title: "An update from Shopify couldn't be processed", body: expect.any(String), store: acme, createdAt: expect.any(String) },
      { id: expect.any(String), severity: "warning", area: "staff", title: "Shifts left open", body: "2 shifts have been open longer than expected.", store: null, createdAt: expect.any(String) },
      { id: expect.any(String), severity: "warning", area: "privacy", title: "A customer asked for their data", body: expect.stringContaining("Settings → Privacy requests"), store: acme, createdAt: expect.any(String) },
    ]);
    for (const a of alerts) {
      expect(a).not.toHaveProperty("message");
      expect(a).not.toHaveProperty("code");
    }
  });

  it("lists privacy requests only to members who see Settings → Privacy requests", async () => {
    const { ws } = await seed();
    const analyst = await signIn(ctx, "analyst", "analyst@acme.test");
    await systemDb.membership.create({ data: { workspaceId: ws, userId: analyst.user.id, role: "analyst", permissions: [...LEGACY_GRANTS.analyst] } });
    const res = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/alerts`, headers: analyst.headers });
    expect(res.statusCode).toBe(200);
    expect((res.json().alerts as Array<{ area: string }>).map((a) => a.area)).not.toContain("privacy");
  });

  it("lists staff alerts only to members who see timesheets", async () => {
    const { ws } = await seed();
    const viewer = await signIn(ctx, "viewer", "viewer@acme.test");
    await systemDb.membership.create({ data: { workspaceId: ws, userId: viewer.user.id, role: "viewer", permissions: [...LEGACY_GRANTS.viewer] } });
    const areas = async () => {
      const res = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/alerts`, headers: viewer.headers });
      expect(res.statusCode).toBe(200);
      return (res.json().alerts as Array<{ area: string }>).map((a) => a.area);
    };
    expect(await areas()).not.toContain("staff");

    await systemDb.membership.update({ where: { workspaceId_userId: { workspaceId: ws, userId: viewer.user.id } }, data: { staffRole: "supervisor" } });
    expect(await areas()).toContain("staff");
  });

  it("lists an ad account's alerts to members who manage integrations (Settings → Advertising), not only to owners and admins", async () => {
    const { ws, store } = await seed();
    await systemDb.alert.create({ data: { workspaceId: ws, storeId: store.id, severity: "warning", code: "ads_reconnect:conn1", message: 'Meta ad account "Shop ads": access has ended.', createdAt: ago(1) } });
    const marketer = await signIn(ctx, "marketer", "marketer@acme.test");
    await systemDb.membership.create({ data: { workspaceId: ws, userId: marketer.user.id, role: "analyst", permissions: ["dashboard:read", "marketing.ads", "integrations.status", "integrations.manage"] } });
    const areas = async () => {
      const res = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/alerts`, headers: marketer.headers });
      expect(res.statusCode).toBe(200);
      return (res.json().alerts as Array<{ area: string }>).map((a) => a.area);
    };
    expect(await areas()).toContain("ads");
    // Seeing the numbers isn't fixing the connection.
    await systemDb.membership.update({ where: { workspaceId_userId: { workspaceId: ws, userId: marketer.user.id } }, data: { permissions: ["dashboard:read", "marketing.ads", "integrations.status"] } });
    expect(await areas()).not.toContain("ads");
  });

  it("is only for the workspace's members", async () => {
    const { ws } = await seed();
    const stranger = await signIn(ctx, "stranger", "stranger@else.test");
    const res = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/alerts`, headers: stranger.headers });
    expect(res.statusCode).toBe(404);
  });
});
