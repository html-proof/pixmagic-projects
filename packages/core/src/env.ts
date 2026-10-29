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
  AWS_LAMBDA_FUNCTION_VERSION: z.string().optional().default(""),
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
   * The secret API key of bizinsights' old Nango environment, a secret (Secrets Manager), kept only
   * while the connections made through Nango (2026-10-22 to 2026-10-28) are moved off it
   * (adConnections/leaveNango.ts; docs/ads-setup.md, "Leaving Nango"). Nothing connects through Nango
   * any more; once the move logs `left: 0` the secret is deleted and this setting goes.
   */
  NANGO_SECRET_KEY: z.string().optional().default(""),
  /** Nango's API. */
  NANGO_API_URL: z.string().default("https://api.nango.dev"),
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
   * WhatsApp's one way to connect, Meta's WhatsApp Business Platform (Embedded Signup; bizinsights
   * then calls Meta's Graph API with the business's token): the Meta app's id and secret (the ad
   * accounts' Meta app when these are empty), the Facebook Login for Business configuration id of
   * its WhatsApp Embedded Signup variation, and the verify token of Meta's webhook. Without them the
   * page offers nothing to connect, and says why.
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
  /**
   * Customer Messaging: SMS through AWS End User Messaging (docs/sms.md).
   *  - off: nothing is sent to AWS. The pages work; rules and campaigns record dry runs.
   *  - sandbox: test texts only, to numbers a merchant verified with AWS (AWS's own sandbox
   *    allows no others); rules and campaigns still record dry runs.
   *  - live: rules and campaigns text customers, after every consent, budget and sender check.
   */
  SMS_MODE: z.enum(["off", "sandbox", "live"]).default("off"),
  /** Marketing texts (campaigns, abandoned checkouts, win-back, VIP): a switch of their own, off until the platform owner turns it on. */
  SMS_MARKETING_ENABLED: z.string().optional().default(""),
  /** The AWS region SMS calls go to unless a store's sender names another (Indian local routes: ap-south-1). Empty: AWS_REGION. */
  SMS_DEFAULT_REGION: z.string().optional().default(""),
  /** The configuration set whose event destination reports delivery (infra/cdk): one name, or JSON per region. */
  SMS_CONFIGURATION_SET: z.string().optional().default(""),
  /** A platform-owned origination identity stores may share (its AWS tags must say bizinsights:shared=true). Empty: none. */
  SMS_SHARED_SENDER: z.string().optional().default(""),
  /** Where merchants' sender-name requests go (the platform owner, who sets them up and registers them with AWS). Empty: they are recorded and logged only. */
  SMS_SENDER_REQUESTS_TO: z.string().optional().default(""),
  /** bizinsights' own ceiling on what all stores together may spend on texts in a month (US$), below AWS's account spending limit. */
  SMS_ACCOUNT_MONTHLY_LIMIT_USD: z.coerce.number().min(0).default(20),
  /** The most AWS may charge for one part of a text (MaxPrice is this times the parts); a dearer route refuses the text. */
  SMS_MAX_PRICE_PER_PART_USD: z.coerce.number().min(0.001).max(5).default(0.25),
  /** Price per part by country (US$), copied from AWS's price list, for estimates before AWS has billed any text there: {"AU":0.05}. */
  SMS_PRICE_TABLE: z.string().optional().default("{}"),
  /** Parts per second one sender may send (the origination identity's MPS at AWS). */
  SMS_PARTS_PER_SECOND: z.coerce.number().int().min(1).max(1000).default(1),
  /** Most recipients one campaign may have. */
  SMS_CAMPAIGN_MAX_RECIPIENTS: z.coerce.number().int().min(1).max(1_000_000).default(2000),
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
  /**
   * Zapier (docs/zapier.md): bizinsights is the OAuth provider of its app on Zapier's Developer
   * Platform. The client id and secret are values the owner makes up and enters on both sides (the
   * secret in Secrets Manager, put-secrets.mjs --set ZAPIER_CLIENT_SECRET, and in the Zapier app's
   * environment as CLIENT_SECRET); the redirect URI is the one Zapier's app shows (Authentication →
   * OAuth v2), matched exactly. Until all three are set, every Zapier endpoint answers 503
   * `not_configured` and Settings → Integrations says Zapier isn't set up yet. The invite URL (the
   * Zapier app's invite link, or its public page once Zapier lists it) is what Connect opens.
   */
  ZAPIER_CLIENT_ID: z.string().optional().default(""),
  ZAPIER_CLIENT_SECRET: z.string().optional().default(""),
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
const OPTIONAL_SECRET_VARS = ["EMAIL_CREDENTIAL_KEYS", "COGNITO_CLIENT_SECRET", "COGNITO_ADMIN_SECRET_ACCESS_KEY", "ZAPIER_CLIENT_SECRET"] as const;

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
