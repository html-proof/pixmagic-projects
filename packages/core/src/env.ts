import { z } from "zod";

/**
 * Plain-string configuration. On Cloudflare, Worker vars and secrets are
 * exposed on `process.env` (nodejs_compat + compatibility_date >= 2025-04-01).
 * Bindings (Hyperdrive, Queues, Durable Objects, Email) are NOT read here; they
 * are passed explicitly from the Worker entry point.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:8787"),
  /** Public base URL for the API (the Shopify web pixel posts here). */
  API_URL: z.string().url().default("http://localhost:8787/api"),
  SESSION_SECRET: z.string().min(16),
  TOKEN_ENCRYPTION_KEYS: z.string(),
  OTP_PEPPER: z.string().min(8),
  FIREBASE_PROJECT_ID: z.string().default("demo-insights"),
  FIREBASE_SERVICE_ACCOUNT_B64: z.string().optional().default(""),
  FIREBASE_AUTH_EMULATOR_HOST: z.string().optional().default(""),
  /** Firebase web API key (public, same as NEXT_PUBLIC_FIREBASE_API_KEY): redeems email sign-in links. */
  FIREBASE_WEB_API_KEY: z.string().optional().default(""),
  SHOPIFY_API_KEY: z.string().default(""),
  SHOPIFY_API_SECRET: z.string().default(""),
  SHOPIFY_SCOPES: z.string().default("read_orders,read_products"),
  SHOPIFY_OPTIONAL_SCOPES: z.string().default(""),
  SHOPIFY_API_VERSION: z.string().default("2025-10"),
  /** Extra Shopify apps as JSON (see apps.ts); each one's secret is in SHOPIFY_APP_SECRET_<KEY>. */
  SHOPIFY_EXTRA_APPS: z.string().optional().default(""),
  /**
   * Stores the main app may be installed on, comma separated. Empty (the default) means any
   * store, which is only true once the app is approved for public distribution: until then
   * Shopify refuses it on stores outside our developer organization. Listing the stores we
   * can serve lets us send every other merchant to their own app instead of to a Shopify
   * page that cannot work (see docs/shopify-setup.md).
   */
  SHOPIFY_DEFAULT_APP_SHOPS: z.string().optional().default(""),
  /**
   * Ad platforms ("Continue with Meta" / "Continue with Google" on Settings → Ad accounts). Empty
   * means not set up: the buttons say so instead of sending people to an error page. The app ids
   * are public; the secrets are Worker secrets.
   */
  META_APP_ID: z.string().optional().default(""),
  META_APP_SECRET: z.string().optional().default(""),
  META_API_VERSION: z.string().default("v25.0"),
  /** Facebook Login for Business configuration id (public). Empty: classic `scope=ads_read`. */
  META_CONFIG_ID: z.string().optional().default(""),
  GOOGLE_ADS_CLIENT_ID: z.string().optional().default(""),
  GOOGLE_ADS_CLIENT_SECRET: z.string().optional().default(""),
  /**
   * "1" once the Google Cloud project behind GOOGLE_ADS_CLIENT_ID has Google Ads API access for real
   * (production) accounts, Explorer level or above, and the `adwords` scope is on its consent screen.
   * Google retired developer tokens on 2026-09-09: API access now follows the Cloud project, so there
   * is no token to set, only this switch. Off, the Google Ads card says "Coming soon".
   */
  GOOGLE_ADS_ENABLED: z.string().optional().default(""),
  GOOGLE_ADS_API_VERSION: z.string().default("v25"),
  /**
   * WhatsApp Business Platform (Cloud API). Embedded Signup ("Connect WhatsApp Business") needs
   * the Meta app's id and secret (the ad accounts' Meta app is used when these are empty) and the
   * Facebook Login for Business configuration id of its WhatsApp Embedded Signup variation. The
   * verify token is what the Meta app's webhook settings were given. Manual connections (the
   * merchant's own app and system-user token) work without any of these.
   */
  WHATSAPP_APP_ID: z.string().optional().default(""),
  WHATSAPP_APP_SECRET: z.string().optional().default(""),
  WHATSAPP_CONFIG_ID: z.string().optional().default(""),
  WHATSAPP_API_VERSION: z.string().default("v25.0"),
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().optional().default(""),
  EMAIL_FROM: z.string().default("Insights <no-reply@localhost>"),
  ALERT_SLACK_WEBHOOK_URL: z.string().optional().default(""),
});

export type Env = z.infer<typeof schema>;

/**
 * Secret values that are public: the placeholders in .env.example / .dev.vars.example and the
 * fixed values the test and e2e setups commit. Anyone can read them in this repository, so a
 * production deployment carrying one has no secret at all (a known TOKEN_ENCRYPTION_KEYS entry
 * decrypts every stored Shopify token).
 */
const PUBLIC_SECRET_MARKERS = [
  "change-me",
  "REPLACE_WITH",
  "test-session-secret",
  "e2e-session-secret",
  "test-pepper",
  "e2e-pepper",
  // base64("01234567890123456789012345678901"), the test/e2e TOKEN_ENCRYPTION_KEYS key.
  "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=",
];
const SECRET_VARS = ["SESSION_SECRET", "OTP_PEPPER", "TOKEN_ENCRYPTION_KEYS"] as const;

/** Names (never values) of production secrets still set to a publicly known value. */
export function publicSecrets(e: Pick<Env, (typeof SECRET_VARS)[number]>): string[] {
  return SECRET_VARS.filter((name) => PUBLIC_SECRET_MARKERS.some((m) => e[name].toLowerCase().includes(m.toLowerCase())));
}

let cached: Env | undefined;
export function env(): Env {
  if (!cached) {
    const parsed = schema.parse(process.env);
    // Fail closed: a deployment must not run on secrets published in this repository.
    const exposed = parsed.NODE_ENV === "production" ? publicSecrets(parsed) : [];
    if (exposed.length) {
      throw new Error(`${exposed.join(", ")} still set to a placeholder or test value. Generate new ones (see docs/deployment-cloudflare.md) before running in production.`);
    }
    cached = parsed;
  }
  return cached;
}

/** For tests. */
export function resetEnvCache() {
  cached = undefined;
}
