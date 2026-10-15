import { afterEach, describe, expect, it, vi } from "vitest";
import { hmacSha256Hex } from "@app/shared";
import { customerKey, developmentSettings, env, logger, phoneHash, publicSecrets, redactForLog, resetEnvCache } from "../src/index.js";

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

    Object.assign(process.env, strong, PROD_URLS, { NODE_ENV: "production" });
    resetEnvCache();
    expect(env().NODE_ENV).toBe("production");
  });

  const PROD_URLS = { APP_URL: "https://insights.example.com", API_URL: "https://insights.example.com/api" };

  it("refuses development settings in production, and only there", () => {
    const dev = { COGNITO_ENDPOINT: "http://127.0.0.1:9229", MAILPIT_URL: "http://localhost:8025", APP_URL: "http://localhost:8787", API_URL: "http://127.0.0.1:8787/api" };
    expect(developmentSettings({ ...PROD_URLS, COGNITO_ENDPOINT: "", MAILPIT_URL: "" })).toEqual([]);
    expect(developmentSettings(dev).map((s) => s.split(" ")[0])).toEqual(["COGNITO_ENDPOINT", "MAILPIT_URL", "APP_URL", "API_URL"]);

    for (const [name, value] of Object.entries(dev)) {
      process.env = { ...saved, ...strong, ...PROD_URLS, NODE_ENV: "production", [name]: value };
      resetEnvCache();
      expect(() => env(), name).toThrow(new RegExp(`Development settings in a production configuration: ${name}`));
    }
    // Development (wrangler dev, e2e, demos) keeps all of them.
    process.env = { ...saved, ...strong, ...dev, NODE_ENV: "development" };
    resetEnvCache();
    expect(env().MAILPIT_URL).toBe("http://localhost:8025");
  });
});

describe("customer hash key", () => {
  const SECRETS = { SESSION_SECRET: "q8v2Zk1mR7wT4yN0pL5sD9fH3jC6xB1e", TOKEN_ENCRYPTION_KEYS: "1:3q2+7wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" };
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    resetEnvCache();
  });

  it("is OTP_PEPPER unless set, so the hashes stored before it existed keep matching", () => {
    process.env = { ...saved, ...SECRETS, OTP_PEPPER: "pepper-one-123", CUSTOMER_HASH_KEY: "" };
    resetEnvCache();
    expect(env().CUSTOMER_HASH_KEY).toBe("pepper-one-123");
    const before = customerKey({ id: "st_1" }, "42");

    // Rotating the OTP pepper with the old value kept as the hash key changes no stored hash.
    process.env = { ...saved, ...SECRETS, OTP_PEPPER: "pepper-two-456", CUSTOMER_HASH_KEY: "pepper-one-123" };
    resetEnvCache();
    expect(customerKey({ id: "st_1" }, "42")).toBe(before);
    expect(phoneHash("st_1", "61400000000")).toBe(hmacSha256Hex("pepper-one-123", "wa:st_1:61400000000"));
  });

  it("counts as a production secret when set to a published value", () => {
    const strong = { SESSION_SECRET: "q8v2Zk1mR7wT4yN0pL5sD9fH3jC6xB1e", OTP_PEPPER: "Yt6uI9oP2aS5dF8gH1jK4lZ7xC0vB3nM", TOKEN_ENCRYPTION_KEYS: "1:3q2+7wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" };
    expect(publicSecrets({ ...strong, CUSTOMER_HASH_KEY: "test-pepper-123" })).toEqual(["CUSTOMER_HASH_KEY"]);
    // Defaulted from OTP_PEPPER: reported once, under OTP_PEPPER's name.
    expect(publicSecrets({ ...strong, OTP_PEPPER: "test-pepper-123", CUSTOMER_HASH_KEY: "test-pepper-123" })).toEqual(["OTP_PEPPER"]);
  });
});
