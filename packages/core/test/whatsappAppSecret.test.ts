import { afterEach, describe, expect, it } from "vitest";
import { resetEnvCache, waPlatformConfig, waPlatformSecret } from "../src/index.js";

/**
 * WhatsApp and Meta Ads can run on one Meta app or on two. WhatsApp only borrows the Meta Ads app's
 * secret when it is the same app: another app's secret would sign nothing WhatsApp sends.
 */

/** The env schema's required fields: the whole of it is parsed. */
const BASE_ENV = { SESSION_SECRET: "0123456789abcdef", TOKEN_ENCRYPTION_KEYS: "1:" + "a".repeat(44), OTP_PEPPER: "pepper-value" };
const KEYS = ["META_APP_ID", "META_APP_SECRET", "WHATSAPP_APP_ID", "WHATSAPP_APP_SECRET", "WHATSAPP_CONFIG_ID", ...(Object.keys(BASE_ENV) as Array<keyof typeof BASE_ENV>)] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

function setEnv(values: Partial<Record<(typeof KEYS)[number], string>>) {
  values = { ...BASE_ENV, ...values };
  for (const k of KEYS) {
    if (values[k] === undefined) delete process.env[k];
    else process.env[k] = values[k];
  }
  resetEnvCache();
}

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetEnvCache();
});

describe("WhatsApp's app secret", () => {
  it("uses the Meta Ads app's secret when WhatsApp runs on the same app", () => {
    setEnv({ META_APP_ID: "111", META_APP_SECRET: "ads_secret", WHATSAPP_CONFIG_ID: "cfg" });
    expect(waPlatformSecret()).toBe("ads_secret");
    expect(waPlatformConfig()).toMatchObject({ appId: "111", appSecret: "ads_secret" });
    setEnv({ META_APP_ID: "111", META_APP_SECRET: "ads_secret", WHATSAPP_APP_ID: "111", WHATSAPP_CONFIG_ID: "cfg" });
    expect(waPlatformSecret()).toBe("ads_secret");
  });

  it("never borrows it for a different WhatsApp app: WhatsApp stays switched off until its own secret is set", () => {
    setEnv({ META_APP_ID: "222", META_APP_SECRET: "ads_secret", WHATSAPP_APP_ID: "111", WHATSAPP_CONFIG_ID: "cfg" });
    expect(waPlatformSecret()).toBe("");
    expect(waPlatformConfig()).toBeNull();
    setEnv({ META_APP_ID: "222", META_APP_SECRET: "ads_secret", WHATSAPP_APP_ID: "111", WHATSAPP_APP_SECRET: "wa_secret", WHATSAPP_CONFIG_ID: "cfg" });
    expect(waPlatformSecret()).toBe("wa_secret");
    expect(waPlatformConfig()).toMatchObject({ appId: "111", appSecret: "wa_secret" });
  });
});
