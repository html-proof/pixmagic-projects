import { afterEach, describe, expect, it, vi } from "vitest";
import { env, logger, publicSecrets, redactForLog, resetEnvCache } from "../src/index.js";

describe("log redaction", () => {
  it("drops credential fields at any depth, whatever their case", () => {
    const out = redactForLog({
      headers: { Authorization: "Bearer abc", Cookie: "__session=x", "X-Shopify-Access-Token": "shpat_123", "x-shopify-hmac-sha256": "h" },
      body: { password: "hunter2", client_secret: "s", nested: { refreshToken: "r", oobCode: "o", privateKey: "k" } },
      storeId: "st_1",
    }) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(out.headers).toEqual({ Authorization: "[redacted]", Cookie: "[redacted]", "X-Shopify-Access-Token": "[redacted]", "x-shopify-hmac-sha256": "[redacted]" });
    expect(out.body.password).toBe("[redacted]");
    expect(out.body.client_secret).toBe("[redacted]");
    expect(out.body.nested).toEqual({ refreshToken: "[redacted]", oobCode: "[redacted]", privateKey: "[redacted]" });
    expect(out.storeId).toBe("st_1");
  });

  it("scrubs tokens and email addresses out of free text and errors", () => {
    const err = new Error("Shopify said no to shpat_0123abcd for owner@shop.example (Bearer eyJhbGciOi.x.y), key sk_live_AbC-12");
    const out = redactForLog({ err, note: "mail to jane.doe@example.com failed" }) as { err: { message: string; stack: string }; note: string };
    for (const s of [out.err.message, out.err.stack]) {
      expect(s).not.toMatch(/shpat_0123abcd|owner@shop\.example|eyJhbGciOi|sk_live_AbC/);
      expect(s).toContain("o***@shop.example");
    }
    expect(out.note).toBe("mail to j***@example.com failed");
  });

  it("applies to what the logger actually writes, message included", () => {
    const prev = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "info";
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      logger.info({ accessToken: "shpat_secret", shop: "a.myshopify.com" }, "sent code to someone@example.com");
      const line = JSON.parse(spy.mock.calls[0]![0] as string);
      expect(line).toMatchObject({ level: "info", accessToken: "[redacted]", shop: "a.myshopify.com", msg: "sent code to s***@example.com" });
    } finally {
      spy.mockRestore();
      process.env.LOG_LEVEL = prev;
    }
  });
});

describe("production secrets", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    resetEnvCache();
  });

  const strong = {
    SESSION_SECRET: "q8v2Zk1mR7wT4yN0pL5sD9fH3jC6xB1e",
    OTP_PEPPER: "Yt6uI9oP2aS5dF8gH1jK4lZ7xC0vB3nM",
    TOKEN_ENCRYPTION_KEYS: "1:3q2+7wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  };

  it("names (never shows) secrets still set to a value published in this repo", () => {
    expect(publicSecrets(strong)).toEqual([]);
    expect(publicSecrets({ ...strong, SESSION_SECRET: "change-me-32-bytes-minimum-random-string" })).toEqual(["SESSION_SECRET"]);
    expect(publicSecrets({ ...strong, OTP_PEPPER: "e2e-pepper-123" })).toEqual(["OTP_PEPPER"]);
    // The test key, even as the second (decrypt-only) entry of a keyring.
    expect(publicSecrets({ ...strong, TOKEN_ENCRYPTION_KEYS: "2:3q2+7wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=,1:MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=" })).toEqual([
      "TOKEN_ENCRYPTION_KEYS",
    ]);
  });

  it("refuses to start in production with one, and only in production", () => {
    Object.assign(process.env, strong, { OTP_PEPPER: "change-me-otp-pepper" });
    process.env.NODE_ENV = "production";
    resetEnvCache();
    expect(() => env()).toThrow(/OTP_PEPPER still set to a placeholder/);
    expect(() => env()).not.toThrow(/change-me-otp-pepper/);

    process.env.NODE_ENV = "development";
    resetEnvCache();
    expect(env().OTP_PEPPER).toBe("change-me-otp-pepper");

    Object.assign(process.env, strong, { NODE_ENV: "production" });
    resetEnvCache();
    expect(env().NODE_ENV).toBe("production");
  });
});
