import type { Coord } from "@app/core";
import { HttpError } from "./context.js";

export interface Limit {
  /** Hits allowed per window; the next one is refused. */
  max: number;
  windowSec: number;
}

/**
 * Every per-key limit in one place, so they can be reviewed and tuned together. The coarse
 * per-IP limit on all API traffic is the Workers Rate Limiting binding (GLOBAL_LIMITER in
 * apps/cloudflare/wrangler.jsonc); these sit underneath it for the endpoints worth abusing.
 */
export const LIMITS = {
  // ---- Sign-in (per IP unless named otherwise) ----
  /** POST /auth/session: exchanging a Firebase ID token for a session cookie. */
  session: { max: 30, windowSec: 300 },
  /** POST /auth/otp/request, per IP and per address: each one sends an email. */
  otpRequestIp: { max: 10, windowSec: 3600 },
  otpRequestEmail: { max: 3, windowSec: 900 },
  /** POST /auth/otp/verify, per IP. */
  otpVerifyIp: { max: 20, windowSec: 900 },
  /**
   * Guesses at the codes sent to one address in a day, from any number of IPs. Each code allows
   * OTP_MAX_ATTEMPTS, but a new code can be requested every few minutes, so without this a
   * distributed guesser got ~1,400 tries a day at a 1-in-a-million code. Counted from the codes'
   * own attempt counters, so nobody can use up a victim's budget without codes being emailed to them.
   */
  otpGuessesPerEmail: { max: 30, windowSec: 86_400 },
  /** POST /auth/email-link/verify. */
  emailLinkVerifyIp: { max: 20, windowSec: 900 },
  /** "Continue with Shopify": POST /auth/shopify/start and /finish. */
  shopifyStartIp: { max: 20, windowSec: 3600 },
  shopifyFinishIp: { max: 30, windowSec: 900 },

  // ---- Signed-in actions ----
  /** Customer contact details, fetched live from Shopify (per workspace and user). */
  contacts: { max: 20, windowSec: 60 },
  /** Invitations, per workspace: each one sends an email from our domain. */
  invitations: { max: 20, windowSec: 3600 },
  /** New workspaces, per user. */
  workspaceCreate: { max: 10, windowSec: 3600 },
  /** New API keys, per workspace. */
  apiKeyCreate: { max: 10, windowSec: 3600 },
  /** "Refresh data", per store (keeps Shopify's rate limit for real work). */
  resync: { max: 1, windowSec: 300 },
  /** Optional-scope refresh/revoke, per store: one Shopify call each. */
  scopes: { max: 3, windowSec: 10 },

  // ---- Public ingest ----
  /** Web pixel, per IP (a storefront sends a batch per page or so). */
  pixelIp: { max: 600, windowSec: 60 },
} as const satisfies Record<string, Limit>;

/** Fixed-window limiter. Throws 429 once more than `max` hits occur within `windowSec`. */
export async function limit(coord: Coord, key: string, policy: Limit, message = "Too many attempts. Please wait and try again.", code = "rate_limited") {
  const n = await coord.hit(key, policy.windowSec);
  if (n > policy.max) throw new HttpError(429, message, code);
}
