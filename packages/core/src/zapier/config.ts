/**
 * Whether Zapier is set up here, and the client check of its OAuth requests. Booleans and setting
 * names only leave this module: never the secret.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "../env.js";

export interface ZapierConfig {
  /** All three OAuth settings are set: the consent page and the token endpoint work. */
  configured: boolean;
  clientId: string;
  redirectUri: string;
  /** What Settings → Integrations' Connect opens (the Zapier app's invite link). */
  inviteUrl: string | null;
  /** Which settings are set (names to booleans), for the owners' setup checklist. */
  settings: { ZAPIER_CLIENT_ID: boolean; ZAPIER_CLIENT_SECRET: boolean; ZAPIER_REDIRECT_URI: boolean; ZAPIER_INVITE_URL: boolean };
}

/** Zapier's OAuth return is https (https://zapier.com/dashboard/auth/oauth/return/App…CLIAPI/): anything else is refused as a setting. */
const httpsUrl = (raw: string) => {
  try {
    return new URL(raw).protocol === "https:";
  } catch {
    return false;
  }
};

export function zapierConfig(): ZapierConfig {
  const e = env();
  const settings = {
    ZAPIER_CLIENT_ID: !!e.ZAPIER_CLIENT_ID.trim(),
    ZAPIER_CLIENT_SECRET: !!e.ZAPIER_CLIENT_SECRET,
    ZAPIER_REDIRECT_URI: httpsUrl(e.ZAPIER_REDIRECT_URI),
    ZAPIER_INVITE_URL: httpsUrl(e.ZAPIER_INVITE_URL),
  };
  return {
    configured: settings.ZAPIER_CLIENT_ID && settings.ZAPIER_CLIENT_SECRET && settings.ZAPIER_REDIRECT_URI,
    clientId: e.ZAPIER_CLIENT_ID.trim(),
    redirectUri: e.ZAPIER_REDIRECT_URI,
    inviteUrl: settings.ZAPIER_INVITE_URL ? e.ZAPIER_INVITE_URL : null,
    settings,
  };
}

/** Equal in constant time: both sides are hashed first, so neither the length nor a prefix shows in the timing. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/** Whether a request names bizinsights' Zapier client and its secret. */
export function zapierClientValid(clientId: string, secret: string): boolean {
  const c = zapierConfig();
  if (!c.configured) return false;
  // Both compared, whatever the first says, so a wrong id answers as fast as a wrong secret.
  const idOk = constantTimeEqual(clientId, c.clientId);
  const secretOk = constantTimeEqual(secret, env().ZAPIER_CLIENT_SECRET);
  return idOk && secretOk;
}
