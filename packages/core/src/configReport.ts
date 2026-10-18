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
import { adsConfigured, adsRestricted } from "./adConnections/config.js";
import { appSecretVar } from "./apps.js";
import { emailOAuthConfigured } from "./email/oauth.js";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { waPlatformConfig } from "./whatsapp/graph.js";

/** A provider's public id (one of the app's settings) and its secret (Secrets Manager). */
export interface ProviderCredentials {
  /** Who it is, in words: "Meta Ads", "Shopify app appstore". */
  provider: string;
  /** The setting that holds the public id, and the one that holds the secret. */
  idSetting: string;
  secretSetting: string;
  idSet: boolean;
  secretSet: boolean;
}

export interface ConfigReport {
  /** Each ad platform: set up (Connect works), and restricted (its sign-in lets only some people through yet). */
  ads: { configured: Record<AdProvider, boolean>; restricted: Record<AdProvider, boolean> };
  /** "Connect WhatsApp Business" (Embedded Signup; manual connections need none of this) and the webhook verify token. */
  whatsapp: { embeddedSignup: boolean; webhookVerifyToken: boolean };
  /** The email integrations ("Connect Gmail", "Connect Outlook"), and Resend for the app's own email. */
  email: Record<OAuthProvider, boolean> & { resend: boolean };
  /** Sign-in: the Cognito pool and app client, "Continue with Google", and codes by email. */
  auth: { cognito: boolean; google: boolean; emailOtp: boolean };
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
 * Every provider that has a public id and a secret, and whether each is set. Read from the raw
 * environment (on AWS: the functions' settings and the secrets loaded at cold start), so it can run
 * before `env()` has been, and the same way the code that uses them decides: an empty value is unset.
 */
export function providerCredentials(vars: Vars = process.env): ProviderCredentials[] {
  const pair = (provider: string, idSetting: string, secretSetting: string): ProviderCredentials => ({
    provider,
    idSetting,
    secretSetting,
    idSet: !!vars[idSetting],
    secretSet: !!vars[secretSetting],
  });
  // WhatsApp on the Meta Ads app borrows that app's secret (whatsapp/graph.ts); on an app of its own,
  // only its own secret signs what it sends. Without WHATSAPP_APP_ID it is on the Meta Ads app.
  const waOwnApp = !!vars.WHATSAPP_APP_ID && vars.WHATSAPP_APP_ID !== vars.META_APP_ID;
  const whatsapp = pair("WhatsApp", "WHATSAPP_APP_ID", "WHATSAPP_APP_SECRET");
  whatsapp.secretSet ||= !waOwnApp && !!vars.META_APP_SECRET;
  return [
    pair("Shopify", "SHOPIFY_API_KEY", "SHOPIFY_API_SECRET"),
    ...extraShopifyApps(vars.SHOPIFY_EXTRA_APPS).map((a) => ({
      provider: `Shopify app ${a.key}`,
      idSetting: "SHOPIFY_EXTRA_APPS",
      secretSetting: appSecretVar(a.key),
      idSet: !!a.clientId,
      secretSet: !!vars[appSecretVar(a.key)],
    })),
    pair("Meta Ads", "META_APP_ID", "META_APP_SECRET"),
    pair("Google Ads and Google AdSense", "GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET"),
    whatsapp,
    pair("Gmail (email sending)", "EMAIL_GOOGLE_CLIENT_ID", "EMAIL_GOOGLE_CLIENT_SECRET"),
    pair("Outlook (email sending)", "EMAIL_MICROSOFT_CLIENT_ID", "EMAIL_MICROSOFT_CLIENT_SECRET"),
  ];
}

const isHalf = (c: ProviderCredentials) => c.idSet && !c.secretSet;

/** The providers whose public id is set and whose secret is missing. */
export const halfConfigured = (vars: Vars = process.env): ProviderCredentials[] => providerCredentials(vars).filter(isHalf);

/** The whole report. Reads the configuration (`env()`), so it runs once the secrets are loaded. */
export function configReport(): ConfigReport {
  const e = env();
  const credentials = providerCredentials();
  return {
    ads: { configured: adsConfigured(), restricted: adsRestricted() },
    whatsapp: { embeddedSignup: waPlatformConfig() !== null, webhookVerifyToken: !!e.WHATSAPP_WEBHOOK_VERIFY_TOKEN },
    email: { ...emailOAuthConfigured(), resend: !!e.RESEND_API_KEY },
    auth: {
      cognito: !!e.COGNITO_USER_POOL_ID && !!e.COGNITO_CLIENT_ID,
      // As the sign-in pages are told (apps/api routes/auth.ts enabledProviders): needs the pool's domain too.
      google: !!e.COGNITO_DOMAIN && e.COGNITO_IDENTITY_PROVIDERS.split(",").some((p) => p.trim() === "Google"),
      emailOtp: e.COGNITO_EMAIL_OTP === "1",
    },
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
