import { z } from "zod";

/** A display name that is safe unquoted in a From header: no line breaks, angle brackets, quotes or address punctuation. */
const HEADER_NAME_RE = /^[^\r\n<>"@,;:\\]*$/;

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
  /**
   * Which release is running, shown by GET /version: the commit and build time of the package
   * (apps/aws/scripts/build.mjs, put in the environment by infra/cdk), the environment's name, and
   * the Lambda version answering (set by Lambda itself). Empty locally.
   */
  APP_COMMIT: z.string().optional().default(""),
  APP_BUILT_AT: z.string().optional().default(""),
  APP_ENVIRONMENT: z.string().optional().default(""),
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
  /** "1": passwordless sign-in with a code the app emails (the sign-in page then offers it). */
  AUTH_EMAIL_OTP: z.string().optional().default(""),
  /**
   * "1": a password sign-in also asks for a 6-digit code emailed by the app (apps/api/src/emailCode.ts),
   * for accounts without an authenticator app. Anything else: the password alone signs in.
   */
  AUTH_LOGIN_EMAIL_CODE: z.string().optional().default(""),
  /**
   * Addresses (comma-separated) whose password alone signs in even with AUTH_LOGIN_EMAIL_CODE on:
   * the account given to an app store's reviewers (Meta App Review), who can't read its inbox.
   * Empty: none.
   */
  AUTH_LOGIN_CODE_EXEMPT: z.string().optional().default(""),
  /**
   * How many sign-up and sign-in codes one address may be emailed an hour and a day (each code also
   * waits 60 seconds for the next). Empty: 6 and 20.
   */
  AUTH_CODE_LIMIT_HOURLY: z.string().optional().default(""),
  AUTH_CODE_LIMIT_DAILY: z.string().optional().default(""),
  /**
   * Google sign-in on the app's own OAuth client (apps/api/src/localAuth.ts). Its redirect URI is
   * APP_URL + /auth/callback. Empty: no "Continue with Google".
   */
  GOOGLE_SIGNIN_CLIENT_ID: z.string().optional().default(""),
  /** That client's secret (a secret: the server's env/app.env). */
  GOOGLE_SIGNIN_CLIENT_SECRET: z.string().optional().default(""),
  /**
   * Development and tests only: a stand-in for Google at this address (apps/web/e2e/fake-google.mjs).
   * Whoever runs it decides who "signed in", so production refuses to start with it set.
   */
  GOOGLE_SIGNIN_ENDPOINT: z.string().optional().default(""),
  SHOPIFY_API_KEY: z.string().default(""),
  SHOPIFY_API_SECRET: z.string().default(""),
  SHOPIFY_SCOPES: z.string().default("read_orders,read_all_orders,read_products"),
  SHOPIFY_OPTIONAL_SCOPES: z.string().default(""),
  /**
   * Optional scopes only some of our apps declare, on top of SHOPIFY_OPTIONAL_SCOPES (which every
   * app declares): `appKey:scope,scope;appKey:scope`, each mirroring that app's toml (scopes.ts
   * `appOptionalScopes`). Not JSON, so packages/core/test/appConfig.test.ts can read it from
   * apps/aws/src/settings.ts. Empty: no app declares more than the common list.
   */
  SHOPIFY_APP_OPTIONAL_SCOPES: z.string().optional().default(""),
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
   * connect) and typed-in stores. "default" is the main app; "appstore" is the App Store app in our
   * Partner organization (docs/shopify-setup.md, "The App Store app"). An unknown key, or an app
   * whose allowlist doesn't cover any store, falls back to the main app.
   */
  SHOPIFY_INSTALL_APP: z.string().optional().default("default"),
  /**
   * Stores whose workspace is shown as an App Store install although they are connected through
   * another of our apps, comma separated (apps.ts `appStoreWorkspace`): the App Store reviewer's
   * test store, a development store the unapproved App Store app can't read.
   */
  SHOPIFY_APP_STORE_PREVIEW_SHOPS: z.string().optional().default(""),
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
  META_API_VERSION: z.string().default("v26.0"),
  /** Facebook Login for Business configuration id (public). Empty: classic `scope=ads_read`. */
  META_CONFIG_ID: z.string().optional().default(""),
  /**
   * "1" once Meta has granted the app Advanced Access to ads_read (App Review, which needs Business
   * Verification). Until then Facebook lets only people with a role on the app (administrators,
   * developers, testers) grant it; anyone else gets Facebook's own "Feature Unavailable" page, which
   * never comes back to bizinsights. Off, the API reports Meta as `restricted` (Settings shows no note).
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
  /**
   * "1" once Google has verified the OAuth app's use of the sensitive adwords scope (Google Auth
   * Platform → Verification Center). Until then Google shows "Google hasn't verified this app" before
   * its consent screen and caps new users at 100; the API reports Google Ads as `restricted` (Settings shows no note).
   */
  GOOGLE_ADS_OAUTH_VERIFIED: z.string().optional().default(""),
  GOOGLE_ADS_API_VERSION: z.string().default("v25"),
  /**
   * Google Ads API operations bizinsights' Cloud project may make a day, across every merchant. Unset
   * (or empty): Explorer access's 2,880 (GOOGLE_ADS_DAILY_OPERATIONS in adConnections/budget.ts). Set
   * it once Google grants a higher access level; the syncs' budget follows it.
   */
  GOOGLE_ADS_DAILY_OPERATIONS: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().positive().optional()),
  /**
   * "1": the Google Ads card offers "Try demo", a simulated Google Ads account whose figures bizinsights
   * generates itself (packages/shared/src/adsDemo.ts, docs/ads-demo.md). It needs none of the Google
   * settings above, reads nothing from Google and never stands in for a real account: a demo
   * connection is marked as one everywhere it is shown. Off, the button isn't offered and the demo
   * endpoints answer 503 `demo_disabled`; demo connections already made keep working.
   */
  GOOGLE_ADS_DEMO_ENABLED: z.string().optional().default(""),
  /**
   * WhatsApp Automation on Evolution API (docs/whatsapp.md): bizinsights' own Evolution API service.
   * Its internal base URL (in AWS the ECS service's private DNS name, reachable only from the
   * functions; locally the docker-compose service), its global API key (a secret, used only to
   * create instances and list them), and the name of that server (shard) new connections go to.
   * Without the URL or the key, connecting WhatsApp is off and the page says so.
   */
  EVOLUTION_API_URL: z.string().optional().default(""),
  EVOLUTION_API_KEY: z.string().optional().default(""),
  EVOLUTION_SHARD: z.string().default("a"),
  /** Where Evolution API posts its webhooks: bizinsights' public API (empty: API_URL). Locally, an address the container can reach. */
  EVOLUTION_WEBHOOK_URL: z.string().optional().default(""),
  /** Each call to Evolution API gives up after this long (ms). */
  EVOLUTION_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(15_000),
  /**
   * The Cloud API way to connect (Meta's Embedded Signup, then Evolution API's WHATSAPP-BUSINESS
   * integration sends through it): the Meta app's id and secret (the ad accounts' Meta app when
   * these are empty), the Facebook Login for Business configuration id of its WhatsApp Embedded
   * Signup variation, and the verify token of Meta's webhook. Without them the page offers only the
   * linked phone, and says why.
   */
  WHATSAPP_APP_ID: z.string().optional().default(""),
  WHATSAPP_APP_SECRET: z.string().optional().default(""),
  WHATSAPP_CONFIG_ID: z.string().optional().default(""),
  WHATSAPP_API_VERSION: z.string().default("v26.0"),
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().optional().default(""),
  /**
   * Workspace ids (comma-separated) that may also connect WhatsApp with a token of bizinsights' own
   * Meta app instead of Meta's window: bizinsights' own team, e.g. to record Meta's App Review with
   * the app's test number. Empty: no one.
   */
  WHATSAPP_TOKEN_CONNECT_WORKSPACES: z.string().optional().default(""),
  EMAIL_FROM: z.string().default("bizinsights <no-reply@localhost>"),
  /**
   * The senders of the codes (OTP_*: sign-up, sign-in, verification and password-reset codes), of
   * shared links (LINK_*: dashboard invitations) and of Staff Management (STAFF_*: employee portal
   * invitations), core/mail/senders.ts. An empty address sends from EMAIL_FROM. Names go into the
   * From header as they are, so they may not hold the characters that would need quoting there.
   */
  OTP_FROM_EMAIL: z.union([z.literal(""), z.string().email()]).default(""),
  OTP_FROM_NAME: z.string().regex(HEADER_NAME_RE).max(64).default(""),
  LINK_FROM_EMAIL: z.union([z.literal(""), z.string().email()]).default(""),
  LINK_FROM_NAME: z.string().regex(HEADER_NAME_RE).max(64).default(""),
  STAFF_FROM_EMAIL: z.union([z.literal(""), z.string().email()]).default(""),
  STAFF_FROM_NAME: z.string().regex(HEADER_NAME_RE).max(64).default(""),
  /** Where the app's emails send people with questions ("contact support@..."). Empty: no such line. */
  SUPPORT_EMAIL: z.union([z.literal(""), z.string().email()]).default(""),
  /** Local development only: deliver every email to this Mailpit instead of the mail provider. */
  MAILPIT_URL: z.string().optional().default(""),
  /**
   * Who sends the app's own email (invitations, alerts): "resend". Empty: Resend when its key is
   * set, else nothing is sent and each email is a line in the log (core/mail).
   */
  EMAIL_PROVIDER: z.enum(["", "resend"]).optional().default(""),
  /** Resend API key (the server's env/app.env). Sending-only access is enough. */
  RESEND_API_KEY: z.string().optional().default(""),
  /** Signing secret (whsec_...) of the Resend webhook endpoint POST /api/webhooks/email/resend. */
  RESEND_WEBHOOK_SECRET: z.string().optional().default(""),
  ALERT_SLACK_WEBHOOK_URL: z.string().optional().default(""),
  /**
   * Zapier (docs/zapier.md): bizinsights is the OAuth provider of its app on Zapier's Developer
   * Platform. The client id and secret are values the owner makes up and enters on both sides (the
   * secret in Secrets Manager, put-secrets.mjs --set ZAPIER_CLIENT_SECRET, and in the Zapier app's
   * environment as CLIENT_SECRET); the redirect URI is the one Zapier's app shows (Authentication →
   * OAuth v2), matched exactly. Until all three are set, every Zapier endpoint answers 503
   * `not_configured` and Settings → Integrations says Zapier isn't set up yet. The invite URL (the
   * Zapier app's invite link, or its public page once Zapier lists it) is what Connect opens.
   * ZAPIER_CLIENT_SECRET_PREVIOUS: the secret before a rotation, accepted too until every version of
   * the Zapier app has the new one (docs/RUNBOOK.md); empty otherwise.
   */
  ZAPIER_CLIENT_ID: z.string().optional().default(""),
  ZAPIER_CLIENT_SECRET: z.string().optional().default(""),
  ZAPIER_CLIENT_SECRET_PREVIOUS: z.string().optional().default(""),
  ZAPIER_REDIRECT_URI: z.union([z.literal(""), z.string().url()]).default(""),
  ZAPIER_INVITE_URL: z.union([z.literal(""), z.string().url()]).default(""),
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
const OPTIONAL_SECRET_VARS = ["GOOGLE_SIGNIN_CLIENT_SECRET", "ZAPIER_CLIENT_SECRET", "ZAPIER_CLIENT_SECRET_PREVIOUS"] as const;

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
 * quietly turns a safeguard off. A stand-in for Google signs in whoever its operator says; a
 * Mailpit relay reroutes every email, sign-in codes included; a local APP_URL breaks OAuth
 * callbacks and the Origin check.
 */
export function developmentSettings(e: Pick<Env, "APP_URL" | "API_URL" | "GOOGLE_SIGNIN_ENDPOINT" | "MAILPIT_URL">): string[] {
  const found: string[] = [];
  if (e.GOOGLE_SIGNIN_ENDPOINT) found.push("GOOGLE_SIGNIN_ENDPOINT (a stand-in for Google)");
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
        throw new Error(`${exposed.join(", ")} still set to a placeholder or test value. Generate new ones (the server's env/app.env, docs/ikorex-migration) before running in production.`);
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
