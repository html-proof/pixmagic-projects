import { afterEach, describe, expect, it, vi } from "vitest";
import { halfConfigured, logger, resetConfigWarning, resetEnvCache } from "@app/core";
import { handler } from "../src/index.js";
import { APP_SETTINGS } from "../src/settings.js";

/**
 * The cron action the deploy's smoke test invokes ({"action":"config"}): what this deployment has
 * set up, with each provider whose public id is in the shipped settings but whose secret is missing.
 */

const SECRETS = {
  SESSION_SECRET: "session-secret-for-this-test",
  TOKEN_ENCRYPTION_KEYS: "1:" + Buffer.alloc(32, 7).toString("base64"),
  OTP_PEPPER: "pepper-for-this-test",
  META_APP_SECRET: "0123456789abcdef0123456789abcdef",
};
const KEYS = [...Object.keys(APP_SETTINGS), ...Object.keys(SECRETS)];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetEnvCache();
  resetConfigWarning();
  vi.restoreAllMocks();
});

describe("the shipped settings", () => {
  it("name, with no secrets at all, every provider whose secret Secrets Manager must hold", () => {
    expect(halfConfigured({ ...APP_SETTINGS }).map((c) => `${c.provider}: ${c.secretSetting}`)).toEqual([
      "Shopify: SHOPIFY_API_SECRET",
      "Shopify app pixmagic: SHOPIFY_APP_SECRET_PIXMAGIC",
      "Shopify app public: SHOPIFY_APP_SECRET_PUBLIC",
      "Shopify app appstore: SHOPIFY_APP_SECRET_APPSTORE",
      "Meta Ads: META_APP_SECRET",
      "Google Ads and Google AdSense: GOOGLE_ADS_CLIENT_SECRET",
      // WhatsApp runs on the Meta Ads app, so that app's secret is WhatsApp's too.
      "WhatsApp (Embedded Signup): META_APP_SECRET",
    ]);
  });

  it("turn WhatsApp's Embedded Signup on, on the Meta Ads app, with that app's secret", () => {
    // WHATSAPP_APP_ID empty: WhatsApp runs on the Meta Ads app, whose secret signs its calls and
    // webhooks. WHATSAPP_CONFIG_ID set: Embedded Signup is on, so its secret missing is a warning.
    expect(APP_SETTINGS.WHATSAPP_APP_ID).toBe("");
    expect(APP_SETTINGS.WHATSAPP_CONFIG_ID).toMatch(/^\d+$/);
    expect(halfConfigured({ ...APP_SETTINGS, ...SECRETS }).map((c) => c.provider)).not.toContain("WhatsApp (Embedded Signup)");
  });
});

describe('the cron action {"action":"config"}', () => {
  it("answers what is set up, by setting name, without a value", async () => {
    Object.assign(process.env, APP_SETTINGS, SECRETS);
    resetEnvCache();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const report = (await handler({ action: "config" }, {})) as { ads: unknown; whatsapp: unknown; halfConfigured: string[] };

    expect(report.ads).toEqual({ configured: { meta: true, google: false, adsense: false }, restricted: { meta: true, google: false, adsense: false } });
    expect(report.halfConfigured).toEqual(["Shopify", "Shopify app pixmagic", "Shopify app public", "Shopify app appstore", "Google Ads and Google AdSense"]);
    // WhatsApp is on the Meta Ads app, so META_APP_SECRET serves it: no WHATSAPP_APP_SECRET needed. Evolution API's address
    // and key come from the CDK app and Secrets Manager (not set in this test).
    expect(report.whatsapp).toEqual({
      evolution: false,
      evolutionNeeds: ["EVOLUTION_API_URL", "EVOLUTION_API_KEY"],
      embeddedSignup: false,
      embeddedSignupNeeds: ["EVOLUTION_API_URL", "EVOLUTION_API_KEY", "WHATSAPP_WEBHOOK_VERIFY_TOKEN"],
      webhookVerifyToken: false,
    });
    const text = JSON.stringify(report);
    for (const value of [...Object.values(SECRETS), APP_SETTINGS.META_APP_ID, APP_SETTINGS.GOOGLE_ADS_CLIENT_ID, APP_SETTINGS.SHOPIFY_API_KEY]) expect(text).not.toContain(value);
    // The cold start already said it in the logs, once per provider.
    expect(warn.mock.calls.filter(([, msg]) => msg === "public id set but secret missing").map(([obj]) => (obj as { provider: string }).provider)).toEqual(report.halfConfigured);
  });
});
