import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eventName, evolutionClient, EvolutionError, isNotConnected, jidNumber, resetEnvCache, verifyEvolutionJwt } from "../src/index.js";
import { EVOLUTION_ENV, EVOLUTION_KEY, evolutionFake, evolutionJwt, QR_PNG } from "../../../test-support/evolutionFake.js";

/**
 * The Evolution API client and the webhooks' authentication, without a database: every path,
 * header and answer the client reads, against a stand-in that answers as Evolution API 2.3.7 does.
 */

const BASE_ENV = { SESSION_SECRET: "0123456789abcdef", TOKEN_ENCRYPTION_KEYS: "1:" + "a".repeat(44), OTP_PEPPER: "pepper-value", ...EVOLUTION_ENV, EVOLUTION_TIMEOUT_MS: "1000" };

beforeEach(() => {
  for (const [k, v] of Object.entries(BASE_ENV)) vi.stubEnv(k, v);
  resetEnvCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("the webhook's JWT", () => {
  const key = "per-connection-webhook-key-0123456789";
  it("accepts Evolution's HS256 token made from the connection's key", () => {
    expect(verifyEvolutionJwt(evolutionJwt(key), key)).toBe(true);
  });

  it("refuses another key, another algorithm, other claims, an expired or future token, and anything malformed", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(verifyEvolutionJwt(evolutionJwt("another-key"), key)).toBe(false);
    expect(verifyEvolutionJwt(evolutionJwt(key, { alg: "none" }), key)).toBe(false);
    expect(verifyEvolutionJwt(evolutionJwt(key, { app: "someone-else" }), key)).toBe(false);
    expect(verifyEvolutionJwt(evolutionJwt(key, { iat: now - 1200, exp: now - 600 }), key)).toBe(false);
    expect(verifyEvolutionJwt(evolutionJwt(key, { iat: now + 600, exp: now + 1200 }), key)).toBe(false);
    expect(verifyEvolutionJwt(evolutionJwt(key, { iat: now, exp: now + 86_400 }), key)).toBe(false);
    for (const bad of ["", "a.b", "a.b.c", `${evolutionJwt(key)}x`]) expect(verifyEvolutionJwt(bad, key), bad).toBe(false);
    // A signature for one body can't be reused with another payload.
    const [h, , s] = evolutionJwt(key).split(".");
    const forged = Buffer.from(JSON.stringify({ iat: now, exp: now + 600, app: "evolution", action: "webhook", extra: 1 })).toString("base64url");
    expect(verifyEvolutionJwt(`${h}.${forged}.${s}`, key)).toBe(false);
  });

  it("reads Evolution's event names in either form", () => {
    expect(eventName("connection.update")).toBe("CONNECTION_UPDATE");
    expect(eventName("MESSAGES_UPSERT")).toBe("MESSAGES_UPSERT");
    expect(eventName("qrcode-updated")).toBe("QRCODE_UPDATED");
  });
});

describe("the Evolution API client", () => {
  it("creates with the global key, then uses the instance's own key; the QR code comes from the provider", async () => {
    const f = evolutionFake();
    const c = evolutionClient("a", f.fetch);
    const created = await c.createInstance({ instanceName: "bi_000000000000000000000001", token: "instance-token", integration: "WHATSAPP-BAILEYS" });
    expect(created.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    await c.setWebhook("bi_000000000000000000000001", "instance-token", { url: "https://example.test/api/webhooks/whatsapp/evolution/bi_000000000000000000000001", jwtKey: "k" });
    const r = await c.connect("bi_000000000000000000000001", "instance-token");
    expect(r).toEqual({ state: "connecting", qr: { base64: QR_PNG, pairingCode: null, count: 1 } });
    expect(f.calls.map((x) => [x.method, x.path, x.apikey === EVOLUTION_KEY ? "global" : x.apikey])).toEqual([
      ["POST", "/instance/create", "global"],
      ["POST", "/webhook/set/bi_000000000000000000000001", "instance-token"],
      ["GET", "/instance/connect/bi_000000000000000000000001", "instance-token"],
    ]);
    expect(f.instances.get("bi_000000000000000000000001")!.webhook).toMatchObject({ jwtKey: "k", events: expect.arrayContaining(["CONNECTION_UPDATE", "MESSAGES_UPDATE", "MESSAGES_UPSERT", "QRCODE_UPDATED"]) });
    // A pairing code for a number.
    const r2 = await c.connect("bi_000000000000000000000001", "instance-token", "61412345678");
    expect(r2.qr?.pairingCode).toBe("WZYEH1YY");
    f.open("bi_000000000000000000000001");
    expect(await c.connectionState("bi_000000000000000000000001", "instance-token")).toBe("open");
    expect(await c.connect("bi_000000000000000000000001", "instance-token")).toEqual({ state: "open", qr: null });
  });

  it("only ever passes on a PNG data URL as the QR code", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ pairingCode: null, code: "x", base64: "javascript:alert(1)", count: 1 }), { status: 200 });
    const r = await evolutionClient("a", fetchImpl).connect("bi_x", "t");
    expect(r.qr).toBeNull();
  });

  it("sends text and reads the message's id; a number not on WhatsApp and a closed connection are told apart", async () => {
    const f = evolutionFake();
    const c = evolutionClient("a", f.fetch);
    await c.createInstance({ instanceName: "bi_1", token: "t", integration: "WHATSAPP-BAILEYS" });
    await expect(c.sendText("bi_1", "t", { number: "61412345678", text: "Hi" })).rejects.toSatisfy((e: unknown) => isNotConnected(e));
    f.open("bi_1");
    const sent = await c.sendText("bi_1", "t", { number: "61412345678", text: "Hi" });
    expect(sent).toMatchObject({ id: expect.stringMatching(/^3EB0/), status: "PENDING" });
    f.notOnWhatsapp.add("61400000000");
    await expect(c.sendText("bi_1", "t", { number: "61400000000", text: "Hi" })).rejects.toMatchObject({ kind: "bad_request", notOnWhatsapp: true });
  });

  it("never retries a send that timed out (it may have gone out), but retries reads", async () => {
    const f = evolutionFake();
    const c = evolutionClient("a", f.fetch);
    await c.createInstance({ instanceName: "bi_1", token: "t", integration: "WHATSAPP-BAILEYS" });
    f.open("bi_1");
    f.sendFails = "timeout";
    const before = f.calls.length;
    await expect(c.sendText("bi_1", "t", { number: "61412345678", text: "Hi" })).rejects.toMatchObject({ kind: "timeout", uncertain: true });
    expect(f.calls.length - before).toBe(1);
    f.sendFails = null;
    f.down = "unreachable";
    const n = f.calls.length;
    await expect(c.connectionState("bi_1", "t")).rejects.toMatchObject({ kind: "unreachable" });
    expect(f.calls.length - n).toBe(3);
  });

  it("reads Evolution's error envelope, and a wrong key is unauthorized, a missing instance not found", async () => {
    const f = evolutionFake();
    const c = evolutionClient("a", f.fetch);
    await c.createInstance({ instanceName: "bi_1", token: "t", integration: "WHATSAPP-BAILEYS" });
    await expect(c.connectionState("bi_1", "wrong")).rejects.toMatchObject({ kind: "unauthorized", status: 401 });
    await expect(c.connectionState("bi_2", "t")).rejects.toMatchObject({ kind: "not_found" });
    // Deleting an instance that is already gone is fine; logging out one that isn't connected too.
    await c.logout("bi_1", "t");
    await c.deleteInstance("bi_1", "t");
    await c.deleteInstance("bi_1", "t");
  });

  it("turns Evolution's Cloud API answer with Meta's error (a 201 without a message) into a refusal", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ message: "(#131030) Recipient phone number not in allowed list", type: "OAuthException", code: 131030, error_data: { details: "Recipient not allowed" } }), { status: 201 });
    await expect(evolutionClient("a", fetchImpl).sendText("bi_1", "t", { number: "1", text: "x" })).rejects.toSatisfy((e: unknown) => e instanceof EvolutionError && e.kind === "bad_request" && /not in allowed list/.test(e.detail));
  });

  it("refuses to run without its settings, and knows only its own shard", () => {
    expect(() => evolutionClient("b", fetch)).toThrow(EvolutionError);
    vi.stubEnv("EVOLUTION_API_KEY", "");
    resetEnvCache();
    expect(() => evolutionClient("a", fetch)).toThrow(/isn't set up/);
  });

  it("reads a WhatsApp JID's number, and nothing from groups, broadcasts or LIDs", () => {
    expect(jidNumber("61412345678@s.whatsapp.net")).toBe("61412345678");
    expect(jidNumber("61412345678:12@s.whatsapp.net")).toBe("61412345678");
    expect(jidNumber("120363000000000000@g.us")).toBeNull();
    expect(jidNumber("status@broadcast")).toBeNull();
    expect(jidNumber("123456789012345@lid")).toBeNull();
  });
});
