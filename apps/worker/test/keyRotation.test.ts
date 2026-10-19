import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { disconnectDb, systemDb } from "@app/db";
import { resetDb } from "@app/db/testing";
import { adAccessToken, encryptAdTokens, encryptTokenFields, getAccessToken, memoryCoord, reencryptAllTokens, resetEnvCache, waDecrypt, waEncrypt, type FetchLike } from "@app/core";
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

  it("a Google token refreshed between adding the key and re-encrypting is sealed whole with the new key, so removing the old one strands nothing", async () => {
    const ws = await systemDb.workspace.create({ data: { name: "W" } });
    const store = await systemDb.store.create({
      data: { workspaceId: ws.id, shopDomain: "g.myshopify.com", grantedScopes: ["read_orders"], status: "active", timezone: "UTC", pixelIngestKey: "pk-g" },
    });
    // One sign-in, two accounts: the same ciphertexts, under the old key, the access token run out.
    const enc = encryptAdTokens(store.id, "google", { accessToken: "OLD_ACCESS", refreshToken: "REFRESH", expiresAt: new Date(Date.now() - 60_000) });
    const base = { workspaceId: ws.id, storeId: store.id, provider: "google", currency: "USD", timezone: "UTC", externalUserId: "1", ...enc };
    const a = await systemDb.adConnection.create({ data: { ...base, accountId: "111" } });
    const b = await systemDb.adConnection.create({ data: { ...base, accountId: "222" } });
    // A row an older version refreshed: it says v2 for the access token, its refresh token still on v1.
    const legacyStore = await systemDb.store.create({
      data: { workspaceId: ws.id, shopDomain: "l.myshopify.com", grantedScopes: ["read_orders"], status: "active", timezone: "UTC", pixelIngestKey: "pk-l" },
    });
    const legacy = await systemDb.adConnection.create({
      data: { ...base, storeId: legacyStore.id, accountId: "333", ...encryptAdTokens(legacyStore.id, "adsense", { accessToken: "L_ACCESS", refreshToken: "L_REFRESH", expiresAt: new Date(Date.now() + 3600_000) }), provider: "adsense" },
    });

    const refreshes: string[] = [];
    const google = (async (_input: unknown, init?: RequestInit) => {
      refreshes.push(new URLSearchParams(String(init?.body)).get("refresh_token")!);
      return new Response(JSON.stringify({ access_token: "NEW_ACCESS", expires_in: 3599 }), { status: 200, headers: { "content-type": "application/json" } });
    }) as FetchLike;
    process.env.GOOGLE_ADS_CLIENT_ID = "c";
    process.env.GOOGLE_ADS_CLIENT_SECRET = "cs";
    useKeys(`${NEW},${OLD}`);
    await systemDb.adConnection.update({ where: { id: legacy.id }, data: { accessTokenEnc: encryptAdTokens(legacyStore.id, "adsense", { accessToken: "L_ACCESS", refreshToken: null, expiresAt: null }).accessTokenEnc, tokenKeyVersion: 2 } });

    // The sweep refreshes before anyone re-encrypts: both accounts' tokens, both of them, are on v2 now.
    expect(await adAccessToken(a, google)).toBe("NEW_ACCESS");
    for (const id of [a.id, b.id]) {
      const r = await systemDb.adConnection.findUniqueOrThrow({ where: { id } });
      expect([r.accessTokenEnc.slice(0, 3), r.refreshTokenEnc!.slice(0, 3), r.tokenKeyVersion]).toEqual(["v2.", "v2.", 2]);
    }
    // Re-encrypting finds the older version's row by its refresh token, whatever its version says; then nothing.
    expect(await reencryptAllTokens()).toBe(1);
    expect(await reencryptAllTokens()).toBe(0);

    useKeys(NEW);
    await systemDb.adConnection.updateMany({ data: { accessTokenExpiresAt: new Date(Date.now() - 60_000) } });
    for (const id of [b.id, legacy.id]) expect(await adAccessToken(await systemDb.adConnection.findUniqueOrThrow({ where: { id } }), google)).toBe("NEW_ACCESS");
    expect(refreshes).toEqual(["REFRESH", "REFRESH", "L_REFRESH"]);
  });

  it("a refresh token stranded on a key removed earlier sends its accounts to reconnect; one unreadable row doesn't stop the other parts", async () => {
    const V3 = "3:" + Buffer.alloc(32, 3).toString("base64");
    const ws = await systemDb.workspace.create({ data: { name: "W" } });
    const store = await systemDb.store.create({
      data: { workspaceId: ws.id, shopDomain: "s.myshopify.com", grantedScopes: ["read_orders"], status: "active", timezone: "UTC", pixelIngestKey: "pk-s" },
    });
    // Under v1, a Google sign-in with two accounts.
    const enc = encryptAdTokens(store.id, "google", { accessToken: "G_ACCESS", refreshToken: "G_REFRESH", expiresAt: new Date(Date.now() + 3600_000) });
    const base = { workspaceId: ws.id, storeId: store.id, provider: "google", currency: "USD", timezone: "UTC", externalUserId: "1", ...enc };
    const a = await systemDb.adConnection.create({ data: { ...base, accountId: "111" } });
    const b = await systemDb.adConnection.create({ data: { ...base, accountId: "222" } });
    // v2 added: an older version's refresh re-sealed only the access token, and its re-encryption went
    // by token_key_version, so v1 was removed with the refresh token still on it.
    useKeys(`${NEW},${OLD}`);
    const access = encryptAdTokens(store.id, "google", { accessToken: "G_ACCESS", refreshToken: null, expiresAt: null }).accessTokenEnc;
    await systemDb.adConnection.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { accessTokenEnc: access, tokenKeyVersion: 2 } });
    const meta = await systemDb.adConnection.create({
      data: { workspaceId: ws.id, storeId: store.id, provider: "meta", accountId: "act_1", currency: "USD", timezone: "UTC", ...encryptAdTokens(store.id, "meta", { accessToken: "EAA_ad", refreshToken: null, expiresAt: null }) },
    });
    const contact = await systemDb.whatsappContact.create({ data: { workspaceId: ws.id, storeId: store.id, phoneHash: "h", phoneEnc: waEncrypt(store.id, "phone", "919000000001"), phoneMasked: "001" } });
    // And a store token that no key opens (damaged), which fails its part.
    const broken = await systemDb.store.create({
      data: { workspaceId: ws.id, shopDomain: "x.myshopify.com", grantedScopes: ["read_orders"], status: "active", timezone: "UTC", pixelIngestKey: "pk-x", accessTokenEnc: encryptAdTokens(store.id, "meta", { accessToken: "x", refreshToken: null, expiresAt: null }).accessTokenEnc, tokenKeyVersion: 2 },
    });

    // Now v3 is added, and v1 is long gone.
    useKeys(`${V3},${NEW}`);
    await expect(reencryptAllTokens()).rejects.toThrow(/re-encrypted 4 rows, but store tokens failed/);
    // The stranded sign-in: nobody can read it again, so its accounts wait for a reconnect (the alert says so).
    for (const id of [a.id, b.id]) {
      expect(await systemDb.adConnection.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "reconnect", errorCode: "auth_expired", accessTokenEnc: "", refreshTokenEnc: null });
    }
    // The parts after the failing one ran all the same.
    useKeys(V3);
    expect(await adAccessToken(await systemDb.adConnection.findUniqueOrThrow({ where: { id: meta.id } }))).toBe("EAA_ad");
    expect(waDecrypt(store.id, "phone", (await systemDb.whatsappContact.findUniqueOrThrow({ where: { id: contact.id } })).phoneEnc)).toBe("919000000001");
    // Once the damaged row is dealt with, nothing is left.
    await systemDb.store.delete({ where: { id: broken.id } });
    useKeys(`${V3},${NEW}`);
    expect(await reencryptAllTokens()).toBe(0);
  });
});
