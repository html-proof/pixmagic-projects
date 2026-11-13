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
  "EVOLUTION_API_URL",
  "EVOLUTION_API_KEY",
  "RESEND_API_KEY",
  "GOOGLE_SIGNIN_CLIENT_ID",
  "GOOGLE_SIGNIN_CLIENT_SECRET",
  "AUTH_EMAIL_OTP",
  "ZAPIER_CLIENT_ID",
  "ZAPIER_CLIENT_SECRET",
  "ZAPIER_REDIRECT_URI",
  "ZAPIER_INVITE_URL",
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
  EVOLUTION_API_URL: "http://evolution-a.internal-test:8080",
  EVOLUTION_API_KEY: "secret-evolution-4545454545",
  RESEND_API_KEY: "re_secret_resend_7878",
  GOOGLE_SIGNIN_CLIENT_ID: "public-google-signin-1313.apps.googleusercontent.com",
  GOOGLE_SIGNIN_CLIENT_SECRET: "secret-google-signin-2424",
  ZAPIER_CLIENT_ID: "public-zapier-client-6767",
  ZAPIER_CLIENT_SECRET: "secret-zapier-client-8989",
  ZAPIER_REDIRECT_URI: "https://zapier.com/dashboard/auth/oauth/return/App4242CLIAPI/",
};

const half = (vars: Record<string, string>) => halfConfigured(vars).map((c) => c.provider);

describe("which provider has its public id but not its secret", () => {
  it("names each provider whose id is set and whose secret is missing, and no other", () => {
    const vars = { META_APP_ID: "971575545351940", GOOGLE_ADS_CLIENT_ID: "x.apps.googleusercontent.com", GOOGLE_ADS_CLIENT_SECRET: "GOCSPX-y", ZAPIER_CLIENT_SECRET: "a secret without its id" };
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
    expect(providerCredentials(vars).find((c) => c.provider === "Zapier")).toMatchObject({ idSet: false, secretSet: true });
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
      // No WHATSAPP_APP_ID: WhatsApp runs on the Meta Ads app, with its secret.
      "WHATSAPP_CONFIG_ID/META_APP_SECRET",
      "ZAPIER_CLIENT_ID/ZAPIER_CLIENT_SECRET",
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
    const wa = providerCredentials({ WHATSAPP_CONFIG_ID: "c" }).find((c) => c.provider === "WhatsApp (Embedded Signup)")!;
    // On the Meta Ads app (no id of its own) the secret to set is that app's.
    expect(wa.secretSetting).toBe("META_APP_SECRET");
    expect(providerCredentials({ WHATSAPP_APP_ID: "1799660384680551", WHATSAPP_CONFIG_ID: "c" }).find((c) => c.provider === "WhatsApp (Embedded Signup)")!.secretSetting).toBe("WHATSAPP_APP_SECRET");
    expect(wa.effect).toBe("connecting WhatsApp through Meta's Cloud API (Embedded Signup) can't be offered, and Meta's webhooks for Cloud API numbers can't be checked");
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
    setEnv({ ...EVERYTHING, META_ADS_ADVANCED_ACCESS: "", GOOGLE_ADS_OAUTH_VERIFIED: "1", AUTH_EMAIL_OTP: "" });
    const r = configReport();
    expect(r.ads).toEqual({ configured: { meta: true, google: true, adsense: true }, restricted: { meta: true, google: false, adsense: false } });
    expect(r.whatsapp).toEqual({ evolution: true, evolutionNeeds: [], embeddedSignup: true, embeddedSignupNeeds: [], webhookVerifyToken: true });
    expect(r.email).toEqual({ resend: true });
    expect(r.auth).toEqual({ google: true, emailOtp: false, loginCode: false, loginCodeExempt: 0 });
    expect(r.zapier).toEqual({ configured: true, inviteUrl: false });
    expect(r.halfConfigured).toEqual([]);
  });

  it("never carries a value, secret or public", () => {
    setEnv(EVERYTHING);
    const text = JSON.stringify(configReport());
    for (const [name, value] of Object.entries(EVERYTHING)) {
      if (name === "SHOPIFY_EXTRA_APPS" || name === "GOOGLE_ADS_ENABLED") continue;
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

  it("names what linking a phone still lacks: Evolution API's address and key", () => {
    for (const [vars, needs] of [
      [{}, ["EVOLUTION_API_URL", "EVOLUTION_API_KEY"]],
      [{ EVOLUTION_API_URL: "u" }, ["EVOLUTION_API_KEY"]],
      [{ EVOLUTION_API_URL: "u", EVOLUTION_API_KEY: "k" }, []],
    ] as Array<[Record<string, string>, string[]]>) {
      setEnv(vars);
      const r = configReport();
      expect(r.whatsapp.evolutionNeeds, JSON.stringify(vars)).toEqual(needs);
      expect(r.whatsapp.evolution).toBe(needs.length === 0);
    }
  });

  it("names what the Cloud API way still lacks, exactly when it is off", () => {
    const ready = { WHATSAPP_WEBHOOK_VERIFY_TOKEN: "v", EVOLUTION_API_URL: "u", EVOLUTION_API_KEY: "k" };
    const cases: Array<[Record<string, string>, string[]]> = [
      [{}, ["EVOLUTION_API_URL", "EVOLUTION_API_KEY", "WHATSAPP_APP_ID", "WHATSAPP_CONFIG_ID", "WHATSAPP_APP_SECRET", "WHATSAPP_WEBHOOK_VERIFY_TOKEN"]],
      // Production today: the app is picked, its configuration and secret aren't there.
      [{ WHATSAPP_APP_ID: "1799660384680551", ...ready }, ["WHATSAPP_CONFIG_ID", "WHATSAPP_APP_SECRET"]],
      [{ WHATSAPP_APP_ID: "1799660384680551", WHATSAPP_APP_SECRET: "w", ...ready }, ["WHATSAPP_CONFIG_ID"]],
      [{ WHATSAPP_APP_ID: "1799660384680551", WHATSAPP_CONFIG_ID: "c", META_APP_ID: "971575545351940", META_APP_SECRET: "m", ...ready }, ["WHATSAPP_APP_SECRET"]],
      [{ META_APP_ID: "971575545351940", META_APP_SECRET: "m", WHATSAPP_CONFIG_ID: "c", ...ready }, []],
      [{ WHATSAPP_APP_ID: "1799660384680551", WHATSAPP_APP_SECRET: "w", WHATSAPP_CONFIG_ID: "c", ...ready }, []],
      [{ WHATSAPP_APP_ID: "1799660384680551", WHATSAPP_APP_SECRET: "w", WHATSAPP_CONFIG_ID: "c", WHATSAPP_WEBHOOK_VERIFY_TOKEN: "v" }, ["EVOLUTION_API_URL", "EVOLUTION_API_KEY"]],
    ];
    for (const [vars, needs] of cases) {
      setEnv(vars);
      const r = configReport();
      expect(r.whatsapp.embeddedSignupNeeds, JSON.stringify(vars)).toEqual(needs);
      expect(r.whatsapp.embeddedSignup, JSON.stringify(vars)).toBe(needs.length === 0);
    }
  });

  it("counts Google sign-in only with the app's own client and its secret", () => {
    setEnv({ GOOGLE_SIGNIN_CLIENT_ID: "public-google-signin-1313.apps.googleusercontent.com" });
    expect(configReport().auth.google).toBe(false);
    setEnv({ GOOGLE_SIGNIN_CLIENT_ID: "public-google-signin-1313.apps.googleusercontent.com", GOOGLE_SIGNIN_CLIENT_SECRET: "secret-google-signin-2424" });
    expect(configReport().auth.google).toBe(true);
    setEnv({});
    expect(configReport().auth).toEqual({ google: false, emailOtp: false, loginCode: false, loginCodeExempt: 0 });
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
