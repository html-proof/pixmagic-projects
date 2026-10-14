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
  // ---- Sign-in (per IP unless named otherwise). Cognito throttles and locks out on top. ----
  /** POST /auth/login, per IP and per address (a password guesser spreads over neither). */
  loginIp: { max: 30, windowSec: 300 },
  loginEmail: { max: 10, windowSec: 900 },
  /** POST /auth/signup: each one emails a code. */
  signupIp: { max: 10, windowSec: 3600 },
  /** Codes Cognito emails on request (sign-up, password reset, sign-in), per address and per IP. */
  codeEmail: { max: 3, windowSec: 900 },
  codeIp: { max: 10, windowSec: 3600 },
  /** Guesses at emailed codes (sign-up confirmation, password reset, sign-in), per IP. */
  codeVerifyIp: { max: 20, windowSec: 900 },
  /** "Continue with Google / Apple" started and finished, per IP. */
  oauthIp: { max: 30, windowSec: 300 },
  /** Password, email and account changes, per user. */
  accountChange: { max: 10, windowSec: 3600 },

  // ---- Signed-in actions ----
  /** Customer contact details, fetched live from Shopify (per workspace and user). */
  contacts: { max: 20, windowSec: 60 },
  /** Invitations, per workspace: each one sends an email from our domain. */
  invitations: { max: 20, windowSec: 3600 },
  /**
   * Invitations (workspace and employee) sent by one person a day, across every workspace they
   * run: anyone can make several workspaces, so the per-workspace cap alone doesn't stop a spammer.
   */
  invitationsPerUser: { max: 60, windowSec: 86_400 },
  /** New workspaces, per user. */
  workspaceCreate: { max: 10, windowSec: 3600 },
  /** New API keys, per workspace. */
  apiKeyCreate: { max: 10, windowSec: 3600 },
  /** Starting a store connection, per user ("already connected elsewhere" must not become a lookup service). */
  shopifyInstall: { max: 20, windowSec: 600 },
  /** "Refresh data", per store (keeps Shopify's rate limit for real work). */
  resync: { max: 1, windowSec: 300 },
  /** Optional-scope refresh/revoke, per store: one Shopify call each. */
  scopes: { max: 3, windowSec: 10 },
  /** Ad accounts "Sync now", per store and user: each queues a sync per connected account. */
  adsSync: { max: 6, windowSec: 600 },
  /** Meta Ads report, per store and user: each one is a few Meta calls (a cached answer doesn't count). */
  adsReport: { max: 30, windowSec: 600 },
  /** WhatsApp: connecting a number (Meta calls each), per store. */
  waConnect: { max: 10, windowSec: 600 },
  /** WhatsApp: "Refresh" (number and templates from Meta), per store. */
  waRefresh: { max: 6, windowSec: 600 },
  /** WhatsApp: templates submitted for Meta's review, per store. */
  waTemplateCreate: { max: 30, windowSec: 3600 },
  /** WhatsApp: test messages to the merchant's own phone, per store. */
  waTest: { max: 10, windowSec: 600 },
  /** WhatsApp: campaign audience estimates (the builder asks as filters change), per store. */
  waEstimate: { max: 120, windowSec: 600 },
  /** WhatsApp: "Send reminder" on an abandoned cart, per store. */
  waRemind: { max: 30, windowSec: 600 },

  // ---- Staff Management ----
  /** Employee invitation page loads, per IP (a token is 256 bits; this only slows scanning). */
  joinLookupIp: { max: 60, windowSec: 600 },
  /** Account activations from an invitation, per IP and per invitation. */
  joinAcceptIp: { max: 10, windowSec: 900 },
  joinAcceptToken: { max: 5, windowSec: 3600 },
  /** Clock in/out and breaks, per employee: a person needs a handful an hour, never dozens a minute. */
  clockActions: { max: 20, windowSec: 60 },
  /** Correction requests, per employee. */
  correctionRequests: { max: 20, windowSec: 3600 },
  /** Report and payslip downloads, per user. */
  staffExports: { max: 30, windowSec: 600 },
  /**
   * Staff analytics, trends and on-screen reports, per user. Each one loads every shift in a range
   * of up to a few years; the dashboard refreshes twice a minute, so this leaves room for several
   * open tabs while stopping a script from hammering the shared database.
   */
  staffAnalytics: { max: 180, windowSec: 600 },
  /** "Sign out everywhere", per user. */
  revokeSessions: { max: 5, windowSec: 3600 },

  // ---- Email integrations (per workspace unless named otherwise) ----
  /** Connecting accounts: OAuth sign-ins started and SMTP connections saved. */
  emailConnect: { max: 20, windowSec: 3600 },
  /** "Test connection": a token refresh or an SMTP sign-in each. */
  emailTest: { max: 20, windowSec: 600 },
  /** Test emails to oneself. */
  emailTestSend: { max: 10, windowSec: 600 },
  /** "Check DNS now", per domain. */
  emailDomainCheck: { max: 6, windowSec: 300 },
  /** Sender verification codes sent, and guesses at them, per sender. */
  emailSenderCode: { max: 5, windowSec: 3600 },
  emailSenderConfirm: { max: 10, windowSec: 900 },
  /** Template previews and automation dry runs, per user. */
  emailPreview: { max: 120, windowSec: 600 },
  /** Manual retries of failed messages. */
  emailRetry: { max: 60, windowSec: 600 },
  /** POST /v1/events, per key and per IP. */
  emailIngestKey: { max: 600, windowSec: 60 },
  emailIngestIp: { max: 1200, windowSec: 60 },
  /** Unsubscribe page loads and clicks, per IP. */
  emailUnsubscribeIp: { max: 60, windowSec: 600 },

  // ---- Public ingest ----
  /** Web pixel, per IP (a storefront sends a batch per page or so). */
  pixelIp: { max: 600, windowSec: 60 },
  /** Customers' order tracking pages, per IP. */
  trackIp: { max: 120, windowSec: 60 },
  /** Review form loads and submissions, per IP, and submissions per order. */
  reviewIp: { max: 60, windowSec: 600 },
  reviewSubmitPerOrder: { max: 10, windowSec: 3600 },
  /** Tracked links in WhatsApp messages, per IP. */
  clickIp: { max: 300, windowSec: 60 },
  /** Meta's webhook verification handshake (GET), per IP. */
  waVerifyIp: { max: 30, windowSec: 60 },
  /**
   * WhatsApp webhook deliveries not signed by Insights' own app, per IP: each one costs a database
   * read to find the connection whose secret might sign it. Same ceiling as the global API limit,
   * which webhooks are exempt from.
   */
  waUnsignedIp: { max: 300, windowSec: 60 },
} as const satisfies Record<string, Limit>;

/** Fixed-window limiter. Throws 429 once more than `max` hits occur within `windowSec`. */
export async function limit(coord: Coord, key: string, policy: Limit, message = "Too many attempts. Please wait and try again.", code = "rate_limited") {
  const n = await coord.hit(key, policy.windowSec);
  // Fixed windows: the wait is at most one window, so that is what Retry-After promises.
  if (n > policy.max) throw new HttpError(429, message, code, policy.windowSec);
}
