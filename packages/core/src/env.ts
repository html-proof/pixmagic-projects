import { z } from "zod";

/**
 * Plain-string configuration from `process.env`: on AWS the functions' environment plus the
 * secrets and runtime parameter loaded at cold start (apps/aws/src/secrets.ts), locally the
 * local server's settings (apps/aws/src/local.ts). Services (queues, coordinator, mail) are NOT
 * read here; they are passed explicitly from the entry points.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:8787"),
  /** Public base URL for the API (the Shopify web pixel posts here). */
  API_URL: z.string().url().default("http://localhost:8787/api"),
  SESSION_SECRET: z.string().min(16),
  TOKEN_ENCRYPTION_KEYS: z.string(),
  OTP_PEPPER: z.string().min(8),
  /**
   * Key of the stored customer hashes (orders' customer_key, WhatsApp contacts' phone hash, which
   * is how a STOP opt-out is found again). Empty means OTP_PEPPER, which keyed them before this
   * setting existed, so existing hashes keep matching. Set it to the current OTP_PEPPER value
   * before rotating OTP_PEPPER, and the rotation no longer touches them (docs/RUNBOOK.md).
   */
  CUSTOMER_HASH_KEY: z.string().optional().default(""),
  /**
   * Sign-in: an Amazon Cognito user pool (docs/cognito-setup.md, infra/aws/cognito.yaml). Empty pool
   * or client id: every sign-in answers "unavailable". The region defaults to the pool id's prefix.
   */
  COGNITO_REGION: z.string().optional().default(""),
  COGNITO_USER_POOL_ID: z.string().optional().default(""),
  COGNITO_CLIENT_ID: z.string().optional().default(""),
  /** The confidential app client's secret (a secret). */
  COGNITO_CLIENT_SECRET: z.string().optional().default(""),
  /** The user pool's OAuth domain, https://... (managed login). Needed for Google. */
  COGNITO_DOMAIN: z.string().optional().default(""),
  /** Which "Continue with ..." buttons work: Cognito provider names, comma separated (Google). */
  COGNITO_IDENTITY_PROVIDERS: z.string().optional().default(""),
  /** "1": passwordless sign-in with a code Cognito emails (needs the Essentials plan and SES email). */
  COGNITO_EMAIL_OTP: z.string().optional().default(""),
  /** "1" when the app client has refresh-token rotation on. */
  COGNITO_REFRESH_ROTATION: z.string().optional().default(""),
  /** Credentials for the user pool's admin calls (on AWS: the function's own role, set at cold start). */
  COGNITO_ADMIN_ACCESS_KEY_ID: z.string().optional().default(""),
  COGNITO_ADMIN_SECRET_ACCESS_KEY: z.string().optional().default(""),
  /** With temporary credentials (an AWS role, e.g. the Lambda function's on AWS hosting). */
  COGNITO_ADMIN_SESSION_TOKEN: z.string().optional().default(""),
  /**
   * Local development only: a Cognito emulator (cognito-local) at this address. Its tokens are
   * signed with a key published on GitHub, so production refuses to start with it set.
   */
  COGNITO_ENDPOINT: z.string().optional().default(""),
  /**
   * The Firebase project's public web API key, during the move to Cognito only: someone signing in
   * with a password Cognito doesn't know yet has it checked against Firebase once, and their
   * Cognito user is created with it (apps/api/src/legacyFirebase.ts). Empty: no migration.
   */
  LEGACY_FIREBASE_API_KEY: z.string().optional().default(""),
  SHOPIFY_API_KEY: z.string().default(""),
  SHOPIFY_API_SECRET: z.string().default(""),
  SHOPIFY_SCOPES: z.string().default("read_orders,read_products"),
  SHOPIFY_OPTIONAL_SCOPES: z.string().default(""),
  SHOPIFY_API_VERSION: z.string().default("2026-10"),
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
   * Key of the app a store without one of its own is sent to: Shopify's store picker (one-click
   * connect) and typed-in stores. "default" is the main app; "public" is the App Store app in our
   * Partner organization (docs/shopify-setup.md, "The App Store app"). An unknown key, or an app
   * whose allowlist doesn't cover any store, falls back to the main app.
   */
  SHOPIFY_INSTALL_APP: z.string().optional().default("default"),
  /**
   * "1" when paid plans are on sale (packages/core/src/billing.ts): merchants can start one, and
   * each plan's store limit applies. Turn it on together with `BILLING_ENABLED` in
   * apps/web/src/lib/features.ts, which shows Settings → Billing. Off, no charge can be started
   * and nobody is limited; a charge already in force can still be cancelled.
   */
  BILLING_ENABLED: z.string().optional().default(""),
  /**
   * Ad platforms ("Continue with Meta" / "Continue with Google" on Settings → Ad accounts). Empty
   * means not set up: the buttons say so instead of sending people to an error page. The app ids
   * are public; the secrets are in Secrets Manager.
   */
  META_APP_ID: z.string().optional().default(""),
  META_APP_SECRET: z.string().optional().default(""),
  META_API_VERSION: z.string().default("v25.0"),
  /** Facebook Login for Business configuration id (public). Empty: classic `scope=ads_read`. */
  META_CONFIG_ID: z.string().optional().default(""),
  /**
   * "1" once Meta has granted the app Advanced Access to ads_read (App Review, which needs Business
   * Verification). Until then Facebook lets only people with a role on the app (administrators,
   * developers, testers) grant it; anyone else gets Facebook's own "Feature Unavailable" page, which
   * never comes back to bizinsights. Off, Settings says so before sending people to Facebook.
   */
  META_ADS_ADVANCED_ACCESS: z.string().optional().default(""),
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
  EMAIL_FROM: z.string().default("bizinsights <no-reply@localhost>"),
  /**
   * Email integrations (docs/email.md). "Connect Gmail / Google Workspace" needs a Google OAuth
   * client whose consent screen lists gmail.send; "Connect Outlook / Microsoft 365" an Entra app
   * registration with delegated Mail.Send. Redirect URIs: <APP_URL>/api/email/oauth/google/callback
   * and <APP_URL>/api/email/oauth/microsoft/callback. Empty: the button says it isn't set up yet.
   */
  EMAIL_GOOGLE_CLIENT_ID: z.string().optional().default(""),
  EMAIL_GOOGLE_CLIENT_SECRET: z.string().optional().default(""),
  EMAIL_MICROSOFT_CLIENT_ID: z.string().optional().default(""),
  EMAIL_MICROSOFT_CLIENT_SECRET: z.string().optional().default(""),
  /** "common" (work, school and personal accounts), "organizations" (work and school only) or one directory's id. */
  EMAIL_MICROSOFT_AUTHORITY: z
    .string()
    .regex(/^(common|organizations|consumers|[0-9a-f-]{36}|[a-z0-9.-]+\.[a-z]{2,})$/i)
    .default("common"),
  /**
   * Key-encryption keys for stored email credentials, in TOKEN_ENCRYPTION_KEYS' format. Empty: the
   * TOKEN_ENCRYPTION_KEYS keyring is used. Each secret has its own random data key, wrapped by
   * these keys, so a rotation re-wraps data keys only.
   */
  EMAIL_CREDENTIAL_KEYS: z.string().optional().default(""),
  /** Messages a day per workspace unless the workspace sets a lower one; and the most any workspace may set. */
  EMAIL_DEFAULT_DAILY_LIMIT: z.coerce.number().int().min(1).default(500),
  EMAIL_MAX_DAILY_LIMIT: z.coerce.number().int().min(1).default(10_000),
  /** Messages a minute per workspace, across all its accounts (protects shared sending capacity). */
  EMAIL_WORKSPACE_PER_MINUTE: z.coerce.number().int().min(1).default(60),
  /** DNS-over-HTTPS resolver for domain checks and SMTP host checks (JSON API). */
  EMAIL_DOH_URL: z.string().url().default("https://cloudflare-dns.com/dns-query"),
  /** Local development only: deliver every email to this Mailpit instead of Amazon SES. */
  MAILPIT_URL: z.string().optional().default(""),
  /**
   * Who sends the app's own email (invitations, alerts): "resend" or "ses". Empty: Resend when its
   * key is set, else SES where it is configured (core/mail). Changing it needs no code change.
   */
  EMAIL_PROVIDER: z.enum(["", "resend", "ses"]).optional().default(""),
  /** Resend API key (Secrets Manager, APP_SECRET_ARN). Sending-only access is enough. */
  RESEND_API_KEY: z.string().optional().default(""),
  /** Signing secret (whsec_...) of the Resend webhook endpoint POST /api/webhooks/email/resend. */
  RESEND_WEBHOOK_SECRET: z.string().optional().default(""),
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
  // The local Cognito emulator's app client (infra/cognito-local/seed).
  "insights-local-client-secret",
  "REPLACE_WITH",
  "test-session-secret",
  "e2e-session-secret",
  "test-pepper",
  "e2e-pepper",
  // base64("01234567890123456789012345678901"), the test/e2e TOKEN_ENCRYPTION_KEYS key.
  "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=",
];
const SECRET_VARS = ["SESSION_SECRET", "OTP_PEPPER", "TOKEN_ENCRYPTION_KEYS"] as const;
/** Secrets that may be left empty (then another one is used), but never set to a public value. */
const OPTIONAL_SECRET_VARS = ["EMAIL_CREDENTIAL_KEYS", "COGNITO_CLIENT_SECRET", "COGNITO_ADMIN_SECRET_ACCESS_KEY"] as const;

/** Names (never values) of production secrets still set to a publicly known value. */
export function publicSecrets(e: Pick<Env, (typeof SECRET_VARS)[number]> & Partial<Pick<Env, "CUSTOMER_HASH_KEY" | (typeof OPTIONAL_SECRET_VARS)[number]>>): string[] {
  const known = (v: string) => PUBLIC_SECRET_MARKERS.some((m) => v.toLowerCase().includes(m.toLowerCase()));
  // CUSTOMER_HASH_KEY falls back to OTP_PEPPER, which is reported under its own name.
  const hashKey = e.CUSTOMER_HASH_KEY && e.CUSTOMER_HASH_KEY !== e.OTP_PEPPER && known(e.CUSTOMER_HASH_KEY) ? ["CUSTOMER_HASH_KEY"] : [];
  const optional = OPTIONAL_SECRET_VARS.filter((name) => !!e[name] && known(e[name]!));
  return [...SECRET_VARS.filter((name) => known(e[name])), ...hashKey, ...optional];
}

const isLocalUrl = (url: string) => {
  try {
    return /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/.test(new URL(url).hostname);
  } catch {
    return false;
  }
};

/**
 * Names (and why) of development-only settings present in a production configuration: each one
 * quietly turns a safeguard off. A Cognito emulator signs tokens with a published key; a Mailpit
 * relay reroutes every email, sign-in codes included; a local APP_URL breaks OAuth callbacks and
 * the Origin check, and is what the emulator bypass keys on.
 */
export function developmentSettings(e: Pick<Env, "APP_URL" | "API_URL" | "COGNITO_ENDPOINT" | "MAILPIT_URL">): string[] {
  const found: string[] = [];
  if (e.COGNITO_ENDPOINT) found.push("COGNITO_ENDPOINT (a local Cognito emulator)");
  if (e.MAILPIT_URL) found.push("MAILPIT_URL (a local mail relay)");
  if (isLocalUrl(e.APP_URL)) found.push("APP_URL (a local address)");
  if (isLocalUrl(e.API_URL)) found.push("API_URL (a local address)");
  return found;
}

/** An on/off setting: "1", "true", "yes" or "on". */
export const switchedOn = (v: string) => /^(1|true|yes|on)$/i.test(v.trim());

let cached: Env | undefined;
export function env(): Env {
  if (!cached) {
    const parsed = schema.parse(process.env);
    // Unset means what keyed the hashes before the setting existed (see CUSTOMER_HASH_KEY).
    if (!parsed.CUSTOMER_HASH_KEY) parsed.CUSTOMER_HASH_KEY = parsed.OTP_PEPPER;
    if (parsed.NODE_ENV === "production") {
      // Fail closed: a deployment must not run on secrets published in this repository...
      const exposed = publicSecrets(parsed);
      if (exposed.length) {
        throw new Error(`${exposed.join(", ")} still set to a placeholder or test value. Generate new ones (infra/cdk/scripts/put-secrets.mjs) before running in production.`);
      }
      // ...nor with a development setting that turns a safeguard off.
      const dev = developmentSettings(parsed);
      if (dev.length) throw new Error(`Development settings in a production configuration: ${dev.join(", ")}. Remove them from the environment's settings and secrets.`);
    }
    cached = parsed;
  }
  return cached;
}

/** For tests. */
export function resetEnvCache() {
  cached = undefined;
}
