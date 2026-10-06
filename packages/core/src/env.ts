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
  EMAIL_FROM: z.string().default("Insights <no-reply@localhost>"),
  ALERT_SLACK_WEBHOOK_URL: z.string().optional().default(""),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;
export function env(): Env {
  cached ??= schema.parse(process.env);
  return cached;
}

/** For tests. */
export function resetEnvCache() {
  cached = undefined;
}
