/**
 * What this deployment has set up, for the deploy's smoke test (the cron action "config",
 * apps/aws/src/index.ts) and the logs. Each integration needs a public id, which is in the app's
 * settings (apps/aws/src/settings.ts), and a secret, which is in Secrets Manager: with the id and
 * without the secret, nothing fails and nothing is logged, the card just says "Coming soon" and
 * existing connections stop syncing. This says which provider is in that state. Booleans and
 * setting names only: never a value, secret or not.
 */
import type { AdProvider } from "@app/shared";
import type { OAuthProvider } from "@app/shared/email";
import { adsConfigured, adsRestricted, nangoProviders } from "./adConnections/config.js";
import { appSecretVar } from "./apps.js";
import { emailOAuthConfigured } from "./email/oauth.js";
import { env, switchedOn } from "./env.js";
import { logger } from "./logger.js";
import { waPlatform } from "./whatsapp/common.js";

/** A provider's public id (one of the app's settings) and its secret (Secrets Manager). */
export interface ProviderCredentials {
  /** Who it is, in words: "Meta Ads", "Shopify app appstore". */
  provider: string;
  /** The setting that holds the public id, and the one that holds the secret. */
  idSetting: string;
  secretSetting: string;
  idSet: boolean;
  secretSet: boolean;
  /** What doesn't work with the id and without the secret, in words that follow "so": the deploy's warning says it. */
  effect: string;
}

export interface ConfigReport {
  /** Each ad platform: set up (Connect works), and restricted (its sign-in lets only some people through yet). */
  /** `configured`: the platform's own app is set up here; `nango`: it is also connected through Nango (docs/nango.md). */
  ads: { configured: Record<AdProvider, boolean>; restricted: Record<AdProvider, boolean>; nango: Record<AdProvider, boolean> };
  /**
   * "Connect WhatsApp" (Meta's Embedded Signup, the token kept at Nango), the settings it still lacks
   * (names, empty once it is on), and the webhook verify token.
   */
  whatsapp: { embeddedSignup: boolean; embeddedSignupNeeds: string[]; webhookVerifyToken: boolean };
  /** The email integrations ("Connect Gmail", "Connect Outlook"), and Resend for the app's own email. */
  email: Record<OAuthProvider, boolean> & { resend: boolean };
  /** Sign-in: the Cognito pool and app client, "Continue with Google", Cognito's passwordless codes, and the app's emailed code after the password. */
  auth: { cognito: boolean; google: boolean; emailOtp: boolean; loginCode: boolean };
  /** Customer Messaging: the platform's mode (off | sandbox | live), the marketing switch, and whether the delivery events' configuration set and a shared sender are set. */
  sms: { mode: string; marketing: boolean; configurationSet: boolean; sharedSender: boolean };
  credentials: ProviderCredentials[];
  /** The providers in `credentials` whose public id is set and whose secret is missing. */
  halfConfigured: string[];
}

type Vars = Record<string, string | undefined>;

/** Extra Shopify apps' keys and client ids. A malformed list is apps.ts's to report: none here. */
function extraShopifyApps(raw: string | undefined): Array<{ key: string; clientId: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw?.trim() || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((a: unknown) => {
    const { key, clientId } = (a ?? {}) as { key?: unknown; clientId?: unknown };
    return typeof key === "string" && /^[a-z0-9_]{1,32}$/.test(key) && typeof clientId === "string" ? [{ key, clientId }] : [];
  });
}

/**
 * Whether WhatsApp's app secret is there: its own, or the Meta Ads app's when WhatsApp runs on that app (no
 * WHATSAPP_APP_ID, or the same id). On an app of its own, only its own secret signs what it sends.
 * The same rule as whatsapp/common.ts.
 */
const waSecretSet = (vars: Vars) =>
  !!vars.WHATSAPP_APP_SECRET || ((!vars.WHATSAPP_APP_ID || vars.WHATSAPP_APP_ID === vars.META_APP_ID) && !!vars.META_APP_SECRET);

/**
 * Every provider that has a public id and a secret, and whether each is set. Read from the raw
 * environment (on AWS: the functions' settings and the secrets loaded at cold start), so it can run
 * before `env()` has been, and the same way the code that uses them decides: an empty value is unset.
 */
export function providerCredentials(vars: Vars = process.env): ProviderCredentials[] {
  const pair = (provider: string, idSetting: string, secretSetting: string, effect: string): ProviderCredentials => ({
    provider,
    idSetting,
    secretSetting,
    idSet: !!vars[idSetting],
    secretSet: !!vars[secretSetting],
    effect,
  });
  // WhatsApp's secret is used by Embedded Signup ("Connect WhatsApp") and the webhooks of the numbers
  // it connects. So its id here is WHATSAPP_CONFIG_ID, the setting that turns Embedded Signup on: an
  // app id picked (WHATSAPP_APP_ID) before its configuration exists is no reason to warn on every deploy.
  const whatsapp: ProviderCredentials = {
    ...pair(
      "WhatsApp (Embedded Signup)",
      "WHATSAPP_CONFIG_ID",
      "WHATSAPP_APP_SECRET",
      "Connect WhatsApp (Embedded Signup) can't be turned on, and replies and delivery reports from connected numbers can't be checked",
    ),
    secretSet: waSecretSet(vars),
  };
  return [
    pair("Shopify", "SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "stores can't install the Shopify app or refresh their access"),
    ...extraShopifyApps(vars.SHOPIFY_EXTRA_APPS).map((a) => ({
      provider: `Shopify app ${a.key}`,
      idSetting: "SHOPIFY_EXTRA_APPS",
      secretSetting: appSecretVar(a.key),
      idSet: !!a.clientId,
      secretSet: !!vars[appSecretVar(a.key)],
      effect: `stores can't install the Shopify app ${a.key} or refresh their access`,
    })),
    pair("Meta Ads", "META_APP_ID", "META_APP_SECRET", 'Meta Ads says "Coming soon" and its connections stop syncing'),
    pair(
      "Google Ads and Google AdSense",
      "GOOGLE_ADS_CLIENT_ID",
      "GOOGLE_ADS_CLIENT_SECRET",
      'Google Ads and AdSense say "Coming soon" and their connections stop syncing',
    ),
    // Every ad platform is connected through Nango (docs/nango.md) with bizinsights' own Meta app or
    // Google client: either app's id set without Nango's key leaves none of them to connect.
    {
      provider: "Ad platforms through Nango",
      idSetting: vars.META_APP_ID ? "META_APP_ID" : "GOOGLE_ADS_CLIENT_ID",
      secretSetting: "NANGO_SECRET_KEY",
      idSet: !!vars.META_APP_ID || !!vars.GOOGLE_ADS_CLIENT_ID,
      secretSet: !!vars.NANGO_SECRET_KEY,
      effect: "no ad platform can be connected (each card says it isn't set up yet), while connections made before Nango keep syncing",
    },
    whatsapp,
    pair("Gmail (email sending)", "EMAIL_GOOGLE_CLIENT_ID", "EMAIL_GOOGLE_CLIENT_SECRET", "Connect Gmail says it isn't set up"),
    pair("Outlook (email sending)", "EMAIL_MICROSOFT_CLIENT_ID", "EMAIL_MICROSOFT_CLIENT_SECRET", "Connect Outlook says it isn't set up"),
  ];
}

/**
 * What "Connect WhatsApp" still lacks, by setting name: Meta's app (its own, or the Meta Ads app's),
 * the Embedded Signup configuration, that app's secret, the webhook verify token, and Nango's key
 * (Nango keeps each store's token). Empty when it is on (whatsapp/common.ts waPlatformMissing asks
 * for the same).
 */
export function embeddedSignupNeeds(vars: Vars = process.env): string[] {
  return [
    !vars.WHATSAPP_APP_ID && !vars.META_APP_ID ? "WHATSAPP_APP_ID" : null,
    !vars.WHATSAPP_CONFIG_ID ? "WHATSAPP_CONFIG_ID" : null,
    !waSecretSet(vars) ? "WHATSAPP_APP_SECRET" : null,
    !vars.WHATSAPP_WEBHOOK_VERIFY_TOKEN ? "WHATSAPP_WEBHOOK_VERIFY_TOKEN" : null,
    !vars.NANGO_SECRET_KEY ? "NANGO_SECRET_KEY" : null,
  ].filter((n): n is string => n !== null);
}

const isHalf = (c: ProviderCredentials) => c.idSet && !c.secretSet;

/** The providers whose public id is set and whose secret is missing. */
export const halfConfigured = (vars: Vars = process.env): ProviderCredentials[] => providerCredentials(vars).filter(isHalf);

/** The whole report. Reads the configuration (`env()`), so it runs once the secrets are loaded. */
export function configReport(): ConfigReport {
  const e = env();
  const credentials = providerCredentials();
  return {
    ads: { configured: adsConfigured(), restricted: adsRestricted(), nango: nangoProviders() },
    whatsapp: {
      embeddedSignup: waPlatform() !== null,
      embeddedSignupNeeds: embeddedSignupNeeds(),
      webhookVerifyToken: !!e.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
    },
    email: { ...emailOAuthConfigured(), resend: !!e.RESEND_API_KEY },
    auth: {
      cognito: !!e.COGNITO_USER_POOL_ID && !!e.COGNITO_CLIENT_ID,
      // As the sign-in pages are told (apps/api routes/auth.ts enabledProviders): needs the pool's domain too.
      google: !!e.COGNITO_DOMAIN && e.COGNITO_IDENTITY_PROVIDERS.split(",").some((p) => p.trim() === "Google"),
      emailOtp: e.COGNITO_EMAIL_OTP === "1",
      loginCode: e.AUTH_LOGIN_EMAIL_CODE === "1",
    },
    sms: { mode: e.SMS_MODE, marketing: switchedOn(e.SMS_MARKETING_ENABLED), configurationSet: !!e.SMS_CONFIGURATION_SET.trim(), sharedSender: !!e.SMS_SHARED_SENDER.trim() },
    credentials,
    halfConfigured: credentials.filter(isHalf).map((c) => c.provider),
  };
}

let warned = false;
/**
 * One warning per half-configured provider, once per instance: apps/aws calls this at each cold
 * start, so the logs say it where a merchant would otherwise only see "Coming soon".
 */
export function warnHalfConfigured(vars: Vars = process.env): void {
  if (warned) return;
  warned = true;
  for (const c of halfConfigured(vars)) {
    logger.warn({ provider: c.provider, idSetting: c.idSetting, secretSetting: c.secretSetting }, "public id set but secret missing");
  }
}

/** For tests. */
export function resetConfigWarning() {
  warned = false;
}
