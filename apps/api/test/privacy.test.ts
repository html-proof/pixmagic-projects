import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb } from "@app/db";
import { customerKey, phoneHash, recordDataRequest, waEncrypt } from "@app/core";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";
import { LEGACY_GRANTS } from "@app/shared";

/**
 * Settings → Privacy requests: Shopify's customers/data_request, answered by giving the store
 * owner what bizinsights holds about the customer. The export is a customer's personal data, so
 * it is for owners and admins of the store's own workspace only.
 */

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));
beforeEach(async () => clean(ctx));

const SHOP = "privacy-shop.myshopify.com";

async function scenario() {
  const owner = await signIn(ctx, "owner", "owner@x.com");
  const ws = await createWorkspace(ctx, owner.headers, "Privacy Co");
  const store = await createStore(ws, SHOP, ["read_orders"]);
  const base = { workspaceId: ws, storeId: store.id, currency: "USD", localDay: "2026-10-01", shopifyCreatedAt: new Date("2026-10-01T10:00:00Z"), shopifyUpdatedAt: new Date(), subtotal: 40, totalDiscounts: 0, totalTax: 4, totalShipping: 5, totalPrice: 49 };
  // The customer's order (linked by the keyed hash), and someone else's.
  await systemDb.order.create({ data: { ...base, shopifyId: "1001", name: "#1001", customerKey: customerKey(store, "7") } });
  await systemDb.order.create({ data: { ...base, shopifyId: "1002", name: "#1002", customerKey: customerKey(store, "8") } });
  await systemDb.whatsappContact.create({
    data: {
      workspaceId: ws,
      storeId: store.id,
      phoneHash: phoneHash(store.id, "61412345678"),
      phoneEnc: waEncrypt(store.id, "phone", "61412345678"),
      phoneMasked: "+61 4•• ••• 678",
      firstNameEnc: waEncrypt(store.id, "name", "Pat"),
      customerKey: customerKey(store, "7"),
      marketingStatus: "opted_in",
    },
  });
  const { request } = await recordDataRequest(store, { requestId: "9999", customerId: "7", phone: "+61 412 345 678", email: "pat@example.com", ordersRequested: [] });
  await systemDb.alert.create({ data: { workspaceId: ws, storeId: store.id, severity: "warning", code: "privacy_request", message: "m" } });
  return { owner, ws, store, request };
}

describe("privacy requests", () => {
  it("lists a store's data requests for its owner", async () => {
    const { owner, ws, request } = await scenario();
    const res = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/privacy-requests`, headers: owner.headers });
    expect(res.statusCode).toBe(200);
    const [item] = res.json().items;
    expect(item).toMatchObject({ id: request.id, customerId: "7", store: { shopDomain: SHOP }, downloadedAt: null });
    expect(new Date(item.answerBy).getTime() - new Date(item.receivedAt).getTime()).toBe(30 * 86_400_000);
  });

  it("exports what bizinsights holds about that customer, and nobody else's", async () => {
    const { owner, ws, store, request } = await scenario();
    const res = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/privacy-requests/${request.id}/export`, headers: owner.headers });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain('filename="customer-data-7.json"');
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();
    expect(body.orders.map((o: { name: string }) => o.name)).toEqual(["#1001"]);
    expect(body.orders[0]).toMatchObject({ total: "49", currency: "USD" });
    expect(body.whatsapp.contacts).toEqual([expect.objectContaining({ phone: "61412345678", firstName: "Pat", marketing: "opted_in" })]);
    expect(body.request).toMatchObject({ shopifyRequestId: "9999", customerId: "7" });

    const after = await systemDb.dataRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(after.downloadedAt).not.toBeNull();
    expect(await systemDb.auditLog.count({ where: { action: "gdpr.data_request_downloaded", targetId: request.id } })).toBe(1);
    // Nothing else is waiting, so the alert that announced it is closed.
    expect(await systemDb.alert.count({ where: { storeId: store.id, code: "privacy_request", resolvedAt: null } })).toBe(0);
  });

  it("is only for owners and admins", async () => {
    const { ws, request } = await scenario();
    const analyst = await signIn(ctx, "analyst", "analyst@x.com");
    await systemDb.membership.create({ data: { workspaceId: ws, userId: analyst.user.id, role: "analyst", permissions: [...LEGACY_GRANTS.analyst] } });
    for (const url of [`/workspaces/${ws}/privacy-requests`, `/workspaces/${ws}/privacy-requests/${request.id}/export`]) {
      const res = await ctx.app.inject({ method: "GET", url, headers: analyst.headers });
      expect(res.statusCode, url).toBe(403);
    }
    expect((await systemDb.dataRequest.findUniqueOrThrow({ where: { id: request.id } })).downloadedAt).toBeNull();
  });

  it("never shows one merchant's requests or customers to another", async () => {
    const { request } = await scenario();
    const rival = await signIn(ctx, "rival", "rival@x.com");
    const rivalWs = await createWorkspace(ctx, rival.headers, "Rival");
    // Their own workspace path: the request id is someone else's.
    const viaOwn = await ctx.app.inject({ method: "GET", url: `/workspaces/${rivalWs}/privacy-requests/${request.id}/export`, headers: rival.headers });
    expect(viaOwn.statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "GET", url: `/workspaces/${rivalWs}/privacy-requests`, headers: rival.headers })).json().items).toEqual([]);
    // The other workspace's path: not a member.
    const viaTheirs = await ctx.app.inject({ method: "GET", url: `/workspaces/${request.workspaceId}/privacy-requests/${request.id}/export`, headers: rival.headers });
    expect(viaTheirs.statusCode).toBe(404);
    expect((await systemDb.dataRequest.findUniqueOrThrow({ where: { id: request.id } })).downloadedAt).toBeNull();
  });
});
