import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { eventName, evolutionClient, EvolutionError, evolutionStatus, jidNumber, resetEnvCache, verifyEvolutionJwt } from "../src/index.js";
import { EVOLUTION_ENV, EVOLUTION_KEY, evolutionFake, evolutionJwt } from "../../../test-support/evolutionFake.js";

/**
 * What is left of Evolution API until release 2 removes it (docs/whatsapp.md, "Removing Evolution"):
 * the client the QR cleanup uses and the webhooks' authentication, without a database, against a
 * stand-in that answers as Evolution API 2.3.7 does.
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
    // JSON that isn't an object (null, a number) is refused, not a crash.
    for (const part of ["null", "1"]) {
      const b = Buffer.from(part).toString("base64url");
      expect(verifyEvolutionJwt(`${b}.${b}.${createHmac("sha256", key).update(`${b}.${b}`).digest("base64url")}`, key)).toBe(false);
    }
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

describe("the Evolution API client (kept only to retire QR linking)", () => {
  /** An instance as Evolution holds it (nothing creates one any more). */
  const seed = (f: ReturnType<typeof evolutionFake>, name: string, state: "open" | "close" = "open") =>
    f.instances.set(name, { name, id: `id-${name}`, token: `token-${name}`, integration: "WHATSAPP-BAILEYS", state, qrCount: 0, webhook: null, ownerJid: null, profileName: null, number: null });

  it("logs an instance out, deletes it and lists them, all with the global key", async () => {
    const f = evolutionFake();
    seed(f, "bi_000000000000000000000001");
    const c = evolutionClient("a", f.fetch);
    expect((await c.fetchInstances()).map((i) => [i.name, i.connectionStatus])).toEqual([["bi_000000000000000000000001", "open"]]);
    await c.logout("bi_000000000000000000000001", EVOLUTION_KEY);
    expect(f.instances.get("bi_000000000000000000000001")!.state).toBe("close");
    await c.deleteInstance("bi_000000000000000000000001", EVOLUTION_KEY);
    expect(f.instances.size).toBe(0);
    expect(f.calls.map((x) => [x.method, x.path, x.apikey === EVOLUTION_KEY ? "global" : x.apikey])).toEqual([
      ["GET", "/instance/fetchInstances", "global"],
      ["DELETE", "/instance/logout/bi_000000000000000000000001", "global"],
      ["DELETE", "/instance/delete/bi_000000000000000000000001", "global"],
    ]);
  });

  it("reads Evolution's error envelope, and a wrong key is unauthorized; gone already, or not connected, is fine", async () => {
    const f = evolutionFake();
    seed(f, "bi_1", "close");
    const c = evolutionClient("a", f.fetch);
    await expect(c.deleteInstance("bi_1", "wrong")).rejects.toMatchObject({ kind: "unauthorized", status: 401 });
    await c.logout("bi_1", EVOLUTION_KEY);
    await c.deleteInstance("bi_1", EVOLUTION_KEY);
    await c.deleteInstance("bi_1", EVOLUTION_KEY);
  });

  it("retries a read that met no answer, and says what happened", async () => {
    const f = evolutionFake();
    f.down = "unreachable";
    const c = evolutionClient("a", f.fetch);
    await expect(c.fetchInstances()).rejects.toMatchObject({ kind: "unreachable" });
    expect(f.calls).toHaveLength(3);
    f.down = "timeout";
    await expect(c.deleteInstance("bi_1", EVOLUTION_KEY)).rejects.toSatisfy((e: unknown) => e instanceof EvolutionError && e.kind === "timeout");
  });

  it("says whether the service answers, and its version, without ever throwing", async () => {
    const seen: string[] = [];
    const up = async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(`${String(input)} ${new Headers(init?.headers).get("apikey") === EVOLUTION_KEY}`);
      return new Response(JSON.stringify({ status: 200, message: "Welcome to the Evolution API, it is working!", version: "2.3.7", clientName: "insights_a" }), { status: 200 });
    };
    expect(await evolutionStatus("a", up)).toEqual({ reachable: true, version: "2.3.7" });
    expect(seen).toEqual(["http://evolution.test:8080/ true"]);
    expect(await evolutionStatus("a", async () => Promise.reject(new TypeError("fetch failed")))).toEqual({ reachable: false, version: null });
    expect(await evolutionStatus("b", up)).toEqual({ reachable: false, version: null });
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
