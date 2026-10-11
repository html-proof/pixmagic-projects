import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { disconnectDb, systemDb } from "@app/db";
import { resetDb } from "@app/db/testing";
import { adAccessToken, encryptAdTokens, encryptTokenFields, getAccessToken, memoryCoord, reencryptAllTokens, resetEnvCache, waDecrypt, waEncrypt } from "@app/core";
import { testEnv } from "../../../test-support/env.js";

/**
 * Rotating TOKEN_ENCRYPTION_KEYS (docs/RUNBOOK.md): after reencryptAllTokens, every value
 * encrypted under the keyring must still open with the new key alone.
 */

const OLD = "1:" + Buffer.alloc(32, 1).toString("base64");
const NEW = "2:" + Buffer.alloc(32, 2).toString("base64");
const useKeys = (spec: string) => {
  process.env.TOKEN_ENCRYPTION_KEYS = spec;
  resetEnvCache();
};

afterAll(async () => disconnectDb());
beforeEach(async () => {
  await resetDb();
  useKeys(OLD);
});
afterEach(() => useKeys(testEnv.TOKEN_ENCRYPTION_KEYS));

describe("rotating the token encryption key", () => {
  it("re-encrypts store, ad and WhatsApp data so the old key can be removed", async () => {
    const ws = await systemDb.workspace.create({ data: { name: "W" } });
    const store = await systemDb.store.create({
      data: { workspaceId: ws.id, shopDomain: "k.myshopify.com", grantedScopes: ["read_orders"], status: "active", timezone: "UTC", pixelIngestKey: "pk-k" },
    });
    await systemDb.store.update({
      where: { id: store.id },
      data: encryptTokenFields(store.id, { accessToken: "shpat_k", scopes: ["read_orders"], accessTokenExpiresAt: null, refreshToken: null, refreshTokenExpiresAt: null }),
    });
    const ad = await systemDb.adConnection.create({
      data: { workspaceId: ws.id, storeId: store.id, provider: "meta", accountId: "act_1", currency: "USD", timezone: "UTC", ...encryptAdTokens(store.id, "meta", { accessToken: "EAA_ad", refreshToken: null, expiresAt: null }) },
    });
    const sid = store.id;
    const conn = await systemDb.whatsappConnection.create({
      data: {
        workspaceId: ws.id, storeId: sid, mode: "manual", wabaId: "1", phoneNumberId: "2", tokenKeyVersion: 1,
        accessTokenEnc: waEncrypt(sid, "access", "EAA_wa"), appSecretEnc: waEncrypt(sid, "app_secret", "app-secret"),
        verifyTokenEnc: waEncrypt(sid, "verify", "verify-token"), pinEnc: waEncrypt(sid, "pin", "123456"),
      },
    });
    const contact = await systemDb.whatsappContact.create({
      data: { workspaceId: ws.id, storeId: sid, phoneHash: "h", phoneEnc: waEncrypt(sid, "phone", "919000000001"), phoneMasked: "001", firstNameEnc: waEncrypt(sid, "name", "Asha") },
    });
    const message = await systemDb.whatsappMessage.create({
      data: { workspaceId: ws.id, storeId: sid, kind: "test", dedupeKey: "d", scheduledFor: new Date(), paramsEnc: waEncrypt(sid, "params", '{"a":1}'), clickUrlEnc: waEncrypt(sid, "click", "https://shop.test/x") },
    });
    const tracking = await systemDb.orderTracking.create({
      data: {
        workspaceId: ws.id, storeId: sid, shopifyOrderId: "1", orderName: "#1", tokenHash: "th", tokenEnc: waEncrypt(sid, "track", "track-token"),
        reviewTokenHash: "rh", reviewTokenEnc: waEncrypt(sid, "review", "review-token"), currency: "USD", totalPrice: 10, items: [], orderCreatedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const checkout = await systemDb.abandonedCheckout.create({
      data: {
        workspaceId: ws.id, storeId: sid, checkoutToken: "c", currency: "USD", totalPrice: 10, items: [], checkoutCreatedAt: new Date(), lastActivityAt: new Date(),
        customerNameEnc: waEncrypt(sid, "name", "Ravi"), recoveryUrlEnc: waEncrypt(sid, "recovery", "https://shop.test/recover"),
      },
    });

    // Retention sweeps measure from updatedAt (e.g. clearing a failed message's details after 7
    // days), so re-encrypting must not make old rows look recently touched.
    const longAgo = new Date("2026-01-01T00:00:00Z");
    await systemDb.whatsappMessage.updateMany({ where: { id: message.id }, data: { updatedAt: longAgo } });
    await systemDb.abandonedCheckout.updateMany({ where: { id: checkout.id }, data: { updatedAt: longAgo } });

    useKeys(`${NEW},${OLD}`);
    // 1 store + 1 ad connection + 5 WhatsApp rows.
    expect(await reencryptAllTokens()).toBe(7);
    expect(await reencryptAllTokens()).toBe(0);

    useKeys(NEW);
    expect(await getAccessToken(store, memoryCoord())).toBe("shpat_k");
    expect(await adAccessToken(await systemDb.adConnection.findUniqueOrThrow({ where: { id: ad.id } }))).toBe("EAA_ad");
    const c = await systemDb.whatsappConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect([waDecrypt(sid, "access", c.accessTokenEnc), waDecrypt(sid, "app_secret", c.appSecretEnc!), waDecrypt(sid, "verify", c.verifyTokenEnc!), waDecrypt(sid, "pin", c.pinEnc!)]).toEqual([
      "EAA_wa", "app-secret", "verify-token", "123456",
    ]);
    expect(c.tokenKeyVersion).toBe(2);
    const k = await systemDb.whatsappContact.findUniqueOrThrow({ where: { id: contact.id } });
    expect([waDecrypt(sid, "phone", k.phoneEnc), waDecrypt(sid, "name", k.firstNameEnc!)]).toEqual(["919000000001", "Asha"]);
    const m = await systemDb.whatsappMessage.findUniqueOrThrow({ where: { id: message.id } });
    expect([waDecrypt(sid, "params", m.paramsEnc!), waDecrypt(sid, "click", m.clickUrlEnc!)]).toEqual(['{"a":1}', "https://shop.test/x"]);
    expect(m.updatedAt).toEqual(longAgo);
    const t = await systemDb.orderTracking.findUniqueOrThrow({ where: { id: tracking.id } });
    expect([waDecrypt(sid, "track", t.tokenEnc), waDecrypt(sid, "review", t.reviewTokenEnc)]).toEqual(["track-token", "review-token"]);
    const a = await systemDb.abandonedCheckout.findUniqueOrThrow({ where: { id: checkout.id } });
    expect([waDecrypt(sid, "name", a.customerNameEnc!), waDecrypt(sid, "recovery", a.recoveryUrlEnc!)]).toEqual(["Ravi", "https://shop.test/recover"]);
    expect(a.updatedAt).toEqual(longAgo);
  });
});
