import { afterEach, describe, expect, it, vi } from "vitest";
import { configReport, halfConfigured, logger, providerCredentials, resetConfigWarning, resetEnvCache, warnHalfConfigured } from "../src/index.js";

/**
 * The deploy's configuration check (the cron action "config"): which provider has its public id set
 * and its secret missing, and what is set up, without ever carrying a value.
 */

/** The env schema's required fields: the whole of it is parsed. */
const BASE_ENV = { SESSION_SECRET: "0123456789abcdef", TOKEN_ENCRYPTION_KEYS: "1:" + "a".repeat(44), OTP_PEPPER: "pepper-value" };
const KEYS = [
  ...Object.keys(BASE_ENV),
  "SHOPIFY_API_KEY",
  "SHOPIFY_API_SECRET",
  "SHOPIFY_EXTRA_APPS",
  "SHOPIFY_APP_SECRET_PIXMAGIC",
  "SHOPIFY_APP_SECRET_APPSTORE",
  "META_APP_ID",
  "META_APP_SECRET",
  "META_ADS_ADVANCED_ACCESS",
  "GOOGLE_ADS_CLIENT_ID",
  "GOOGLE_ADS_CLIENT_SECRET",
  "GOOGLE_ADS_ENABLED",
  "GOOGLE_ADS_OAUTH_VERIFIED",
  "WHATSAPP_APP_ID",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_CONFIG_ID",
  "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
  "EMAIL_GOOGLE_CLIENT_ID",
  "EMAIL_GOOGLE_CLIENT_SECRET",
  "EMAIL_MICROSOFT_CLIENT_ID",
  "EMAIL_MICROSOFT_CLIENT_SECRET",
  "RESEND_API_KEY",
  "COGNITO_USER_POOL_ID",
  "COGNITO_CLIENT_ID",
  "COGNITO_CLIENT_SECRET",
  "COGNITO_DOMAIN",
  "COGNITO_IDENTITY_PROVIDERS",
  "COGNITO_EMAIL_OTP",
];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

/** Exactly these settings (and the required ones), nothing left over from another test. */
function setEnv(values: Record<string, string>) {
  const all: Record<string, string> = { ...BASE_ENV, ...values };
  for (const k of KEYS) {
    if (all[k] === undefined) delete process.env[k];
    else process.env[k] = all[k];
  }
  resetEnvCache();
}

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetEnvCache();
  resetConfigWarning();
  vi.restoreAllMocks();
});

const EXTRA_APPS = JSON.stringify([
  { key: "pixmagic", clientId: "bb0ea9e4ad8939a6a1513e4dbf8cbbf1", shops: ["pixmagic.myshopify.com"] },
  { key: "appstore", clientId: "cf5c717dba9317707e0cd5f5d3408fd0", shops: [] },
]);

/** Every public id and every secret, each a value that can be searched for in the report. */
const EVERYTHING = {
  SHOPIFY_API_KEY: "public-shopify-key-1111",
  SHOPIFY_API_SECRET: "secret-shopify-2222",
  SHOPIFY_EXTRA_APPS: EXTRA_APPS,
  SHOPIFY_APP_SECRET_PIXMAGIC: "secret-pixmagic-3333",
  SHOPIFY_APP_SECRET_APPSTORE: "secret-appstore-4444",
  META_APP_ID: "971575545351940",
  META_APP_SECRET: "secret-meta-5555",
  GOOGLE_ADS_CLIENT_ID: "public-google-6666.apps.googleusercontent.com",
  GOOGLE_ADS_CLIENT_SECRET: "GOCSPX-secret-google-7777",
  GOOGLE_ADS_ENABLED: "1",
  WHATSAPP_APP_ID: "1799660384680551",
  WHATSAPP_APP_SECRET: "secret-whatsapp-8888",
  WHATSAPP_CONFIG_ID: "public-wa-config-9999",
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: "secret-verify-token-0000",
  EMAIL_GOOGLE_CLIENT_ID: "public-gmail-1212.apps.googleusercontent.com",
  EMAIL_GOOGLE_CLIENT_SECRET: "GOCSPX-secret-gmail-3434",
  EMAIL_MICROSOFT_CLIENT_ID: "0f0f0f0f-1111-2222-3333-444444444444",
  EMAIL_MICROSOFT_CLIENT_SECRET: "secret-outlook-5656~abc",
  RESEND_API_KEY: "re_secret_resend_7878",
  COGNITO_USER_POOL_ID: "ap-southeast-2_public9090",
  COGNITO_CLIENT_ID: "public-cognito-client-1313",
  COGNITO_CLIENT_SECRET: "secret-cognito-2424",
  COGNITO_DOMAIN: "https://auth.example.test",
  COGNITO_IDENTITY_PROVIDERS: "Google",
};

const half = (vars: Record<string, string>) => halfConfigured(vars).map((c) => c.provider);

describe("which provider has its public id but not its secret", () => {
  it("names each provider whose id is set and whose secret is missing, and no other", () => {
    const vars = { META_APP_ID: "971575545351940", GOOGLE_ADS_CLIENT_ID: "x.apps.googleusercontent.com", GOOGLE_ADS_CLIENT_SECRET: "GOCSPX-y", EMAIL_MICROSOFT_CLIENT_SECRET: "a secret without its id" };
    expect(half(vars)).toEqual(["Meta Ads"]);
    const meta = providerCredentials(vars).find((c) => c.provider === "Meta Ads")!;
    expect(meta).toEqual({
      provider: "Meta Ads",
      idSetting: "META_APP_ID",
      secretSetting: "META_APP_SECRET",
      idSet: true,
      secretSet: false,
      effect: 'Meta Ads says "Coming soon" and its connections stop syncing',
    });
    // A secret without its id is not half of anything: the provider just isn't used.
    expect(providerCredentials(vars).find((c) => c.provider.startsWith("Outlook"))).toMatchObject({ idSet: false, secretSet: true });
  });

  it("finds nothing when every id has its secret, or nothing is set at all", () => {
    expect(half(EVERYTHING)).toEqual([]);
    expect(half({})).toEqual([]);
  });

  it("reports every pair the app's providers need", () => {
    const pairs = providerCredentials({ SHOPIFY_EXTRA_APPS: EXTRA_APPS }).map((c) => `${c.idSetting}/${c.secretSetting}`);
    expect(pairs).toEqual([
      "SHOPIFY_API_KEY/SHOPIFY_API_SECRET",
      "SHOPIFY_EXTRA_APPS/SHOPIFY_APP_SECRET_PIXMAGIC",
      "SHOPIFY_EXTRA_APPS/SHOPIFY_APP_SECRET_APPSTORE",
      "META_APP_ID/META_APP_SECRET",
      "GOOGLE_ADS_CLIENT_ID/GOOGLE_ADS_CLIENT_SECRET",
      "WHATSAPP_CONFIG_ID/WHATSAPP_APP_SECRET",
      "EMAIL_GOOGLE_CLIENT_ID/EMAIL_GOOGLE_CLIENT_SECRET",
      "EMAIL_MICROSOFT_CLIENT_ID/EMAIL_MICROSOFT_CLIENT_SECRET",
    ]);
  });

  it("checks each extra Shopify app's own secret", () => {
    const vars = { SHOPIFY_API_KEY: "k", SHOPIFY_API_SECRET: "s", SHOPIFY_EXTRA_APPS: EXTRA_APPS, SHOPIFY_APP_SECRET_PIXMAGIC: "s2" };
    expect(half(vars)).toEqual(["Shopify app appstore"]);
  });

  it("skips an extra-apps list it can't read instead of failing", () => {
    for (const raw of ["not json", "{}", '[{"key":"Bad Key","clientId":"x"},{"key":"ok"},null]']) {
      expect(providerCredentials({ SHOPIFY_EXTRA_APPS: raw }).filter((c) => c.provider.startsWith("Shopify app"))).toEqual([]);
    }
  });

  it("lets WhatsApp borrow the Meta Ads app's secret only when it runs on that app", () => {
    const signup = { WHATSAPP_CONFIG_ID: "public-wa-config-9999", META_APP_ID: "971575545351940", META_APP_SECRET: "m" };
    // Its own app: only its own secret signs what it sends.
    expect(half({ ...signup, WHATSAPP_APP_ID: "1799660384680551" })).toEqual(["WhatsApp (Embedded Signup)"]);
    expect(half({ ...signup, WHATSAPP_APP_ID: "1799660384680551", WHATSAPP_APP_SECRET: "w" })).toEqual([]);
    // The same app as Meta Ads, or no id of its own: META_APP_SECRET is its secret.
    expect(half({ ...signup, WHATSAPP_APP_ID: "971575545351940" })).toEqual([]);
    expect(half(signup)).toEqual([]);
    expect(half({ ...signup, META_APP_SECRET: "" })).toEqual(["Meta Ads", "WhatsApp (Embedded Signup)"]);
  });

  it("asks for WhatsApp's secret only once Embedded Signup is wanted (its configuration id is set)", () => {
    // What production ships today: WhatsApp's app picked, no Embedded Signup configuration yet.
    // Manual connections bring their own app's secret, so nothing is missing for them.
    expect(half({ WHATSAPP_APP_ID: "1799660384680551" })).toEqual([]);
    expect(half({ WHATSAPP_APP_ID: "1799660384680551", WHATSAPP_CONFIG_ID: "public-wa-config-9999" })).toEqual(["WhatsApp (Embedded Signup)"]);
    const wa = providerCredentials({ WHATSAPP_CONFIG_ID: "c" }).find((c) => c.secretSetting === "WHATSAPP_APP_SECRET")!;
    expect(wa.effect).toBe("Connect WhatsApp Business (Embedded Signup) can't be turned on; manual WhatsApp connections still work");
  });

  it('says what each missing secret stops, in words that follow "so"', () => {
    const all = providerCredentials({ SHOPIFY_EXTRA_APPS: EXTRA_APPS });
    for (const c of all) {
      // The warning ends the sentence itself, and names settings only where it says which is missing.
      expect(c.effect, c.provider).toMatch(/^[A-Za-z"]/);
      expect(c.effect, c.provider).not.toMatch(/\.$|\n|[A-Z]+_[A-Z]+/);
    }
    expect(all.find((c) => c.provider === "Shopify app pixmagic")!.effect).toBe("stores can't install the Shopify app pixmagic or refresh their access");
  });
});

describe("the configuration report", () => {
  it("says what is set up, as booleans", () => {
    setEnv({ ...EVERYTHING, META_ADS_ADVANCED_ACCESS: "", GOOGLE_ADS_OAUTH_VERIFIED: "1", COGNITO_EMAIL_OTP: "" });
    const r = configReport();
    expect(r.ads).toEqual({ configured: { meta: true, google: true, adsense: true }, restricted: { meta: true, google: false, adsense: false } });
    expect(r.whatsapp).toEqual({ embeddedSignup: true, embeddedSignupNeeds: [], webhookVerifyToken: true });
    expect(r.email).toEqual({ google: true, microsoft: true, resend: true });
    expect(r.auth).toEqual({ cognito: true, google: true, emailOtp: false, loginCode: false });
    expect(r.halfConfigured).toEqual([]);
  });

  it("never carries a value, secret or public", () => {
    setEnv(EVERYTHING);
    const text = JSON.stringify(configReport());
    for (const [name, value] of Object.entries(EVERYTHING)) {
      if (name === "SHOPIFY_EXTRA_APPS" || name === "GOOGLE_ADS_ENABLED" || name === "COGNITO_IDENTITY_PROVIDERS") continue;
      expect(text, name).not.toContain(value);
    }
    for (const id of ["bb0ea9e4ad8939a6a1513e4dbf8cbbf1", "cf5c717dba9317707e0cd5f5d3408fd0"]) expect(text).not.toContain(id);
  });

  it("lists the half-configured providers, and the ad platforms they leave off", () => {
    setEnv({ META_APP_ID: "971575545351940", GOOGLE_ADS_CLIENT_ID: "x.apps.googleusercontent.com", GOOGLE_ADS_ENABLED: "1" });
    const r = configReport();
    expect(r.halfConfigured).toEqual(["Meta Ads", "Google Ads and Google AdSense"]);
    expect(r.ads.configured).toEqual({ meta: false, google: false, adsense: false });
    expect(r.ads.restricted).toEqual({ meta: false, google: false, adsense: false });
  });

  it("names what Embedded Signup still lacks, exactly when it is off", () => {
    const cases: Array<[Record<string, string>, string[]]> = [
      [{}, ["WHATSAPP_APP_ID", "WHATSAPP_CONFIG_ID", "WHATSAPP_APP_SECRET"]],
      // Production today: the app is picked, its configuration and secret aren't there.
      [{ WHATSAPP_APP_ID: "1799660384680551" }, ["WHATSAPP_CONFIG_ID", "WHATSAPP_APP_SECRET"]],
      [{ WHATSAPP_APP_ID: "1799660384680551", WHATSAPP_APP_SECRET: "w" }, ["WHATSAPP_CONFIG_ID"]],
      [{ WHATSAPP_APP_ID: "1799660384680551", WHATSAPP_CONFIG_ID: "c", META_APP_ID: "971575545351940", META_APP_SECRET: "m" }, ["WHATSAPP_APP_SECRET"]],
      [{ META_APP_ID: "971575545351940", META_APP_SECRET: "m", WHATSAPP_CONFIG_ID: "c" }, []],
      [{ WHATSAPP_APP_ID: "1799660384680551", WHATSAPP_APP_SECRET: "w", WHATSAPP_CONFIG_ID: "c" }, []],
    ];
    for (const [vars, needs] of cases) {
      setEnv(vars);
      const r = configReport();
      expect(r.whatsapp.embeddedSignupNeeds, JSON.stringify(vars)).toEqual(needs);
      expect(r.whatsapp.embeddedSignup, JSON.stringify(vars)).toBe(needs.length === 0);
    }
  });

  it("counts Google sign-in only with the pool's domain and Google among its providers", () => {
    setEnv({ COGNITO_IDENTITY_PROVIDERS: "Google" });
    expect(configReport().auth.google).toBe(false);
    setEnv({ COGNITO_DOMAIN: "https://auth.example.test", COGNITO_IDENTITY_PROVIDERS: " Google ,Facebook" });
    expect(configReport().auth.google).toBe(true);
    setEnv({ COGNITO_DOMAIN: "https://auth.example.test", COGNITO_IDENTITY_PROVIDERS: "" });
    expect(configReport().auth).toEqual({ cognito: false, google: false, emailOtp: false, loginCode: false });
  });
});

describe("the warning at cold start", () => {
  it("logs each half-configured provider once per instance, by setting name only", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const vars = { META_APP_ID: "971575545351940", WHATSAPP_APP_ID: "1799660384680551", WHATSAPP_CONFIG_ID: "public-wa-config-9999" };
    warnHalfConfigured(vars);
    warnHalfConfigured(vars);
    expect(warn.mock.calls).toEqual([
      [{ provider: "Meta Ads", idSetting: "META_APP_ID", secretSetting: "META_APP_SECRET" }, "public id set but secret missing"],
      [{ provider: "WhatsApp (Embedded Signup)", idSetting: "WHATSAPP_CONFIG_ID", secretSetting: "WHATSAPP_APP_SECRET" }, "public id set but secret missing"],
    ]);
  });

  it("says nothing when every provider in use has its secret", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    warnHalfConfigured(EVERYTHING);
    expect(warn).not.toHaveBeenCalled();
  });
});
